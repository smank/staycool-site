// Lemon Squeezy fulfillment + activation Worker for Cartridge.
//
// Routes:
//   POST /webhook     LS order_created → mint UNBOUND retail key, email via Resend
//   POST /activate    { key, machine } → bind key to machine (3 seats/order, KV)
//   POST /deactivate  { licence }      → release that machine's seat
//
// Required secrets (wrangler secret put ...):
//   LS_WEBHOOK_SECRET     Lemon Squeezy webhook signing secret
//   LICENSE_PRIVATE_KEY   juce::RSAKey private key ("exp,mod" hex) — ROTATED, never logged
//   RESEND_API_KEY        Resend API key for sending the licence email
//   BETA_ADMIN_TOKEN      bearer token for the vendor-only POST /mint-beta
// Required vars (wrangler.toml):
//   LICENSE_PUBLIC_KEY    matching public key (used to verify inbound keys)
// Required binding: LEDGER (KV) — dedup + seat state. Data-minimised: holds
// only order ids, a SHA-256 of each issued licence, machine hashes, and
// timestamps. Buyer name/email/keys pass through requests but never persist.
//
// Seat bookkeeping uses a plain KV read-modify-write. Two simultaneous
// activations can race (KV is last-write-wins); at one-buyer scale that's
// acceptable. If it ever matters, move seat state to a Durable Object per order.

import { signLicence, buildPayloadV2, verifyLicence } from "./sign.js";

const SEAT_LIMIT = 3;
const CORS_ORIGIN = "https://staycoolandstaycool.com"; // future web activation page

// Product catalog: LS product names (matched case-insensitively against
// first_order_item.product_name) → licence slug + email display name.
// One signing key serves every product; the slug in the payload is what keeps
// one product's key from unlocking another. Add a row per new product.
const PRODUCTS = [
  { slug: "cartridge", match: /cartridge/i, display: "Cartridge" },
];

function productForOrder(attributes) {
  const name = attributes?.first_order_item?.product_name ?? "";
  return PRODUCTS.find((p) => p.match.test(name)) ?? null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS" && (pathname === "/activate" || pathname === "/deactivate"))
      return withCors(new Response(null, { status: 204 }));

    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    switch (pathname) {
      case "/webhook":    return handleWebhook(request, env);
      case "/activate":   return withCors(await handleActivate(request, env));
      case "/deactivate": return withCors(await handleDeactivate(request, env));
      case "/mint-beta":  return handleMintBeta(request, env);
      default:            return new Response("Not found", { status: 404 });
    }
  },
};

function withCors(res) {
  res.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------- LS webhook

async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyLsSignature(raw, request.headers.get("X-Signature") || "", env.LS_WEBHOOK_SECRET)))
    return new Response("Bad signature", { status: 401 });

  const event = JSON.parse(raw);
  if (event?.meta?.event_name !== "order_created")
    return new Response("ignored", { status: 200 });

  const a = event.data.attributes;
  if (a.status && a.status !== "paid")
    return new Response("not paid", { status: 200 });

  const product = productForOrder(a);
  if (!product) return new Response("ignored (unknown product)", { status: 200 });

  const name = (a.user_name || "Music maker").trim();
  const email = (a.user_email || "").trim();
  const order = "ls-" + String(a.order_number || event.data.id);
  if (!email) return new Response("no email", { status: 200 });

  // Unbound retail key: the buyer exchanges it once, online, for a licence
  // bound to their machine (SEAT_LIMIT machines per order).
  const licence = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ product: product.slug, type: "full", name, email, order, expiry: 0, machine: "" })
  );

  // LS retries webhooks on non-200; deterministic signing means a retry mints
  // the identical key, so skip the duplicate email if we already sent this one.
  // Data minimisation: only a HASH of the licence is stored — no name, email,
  // or key ever persists here. Lost keys are re-sent from the LS dashboard
  // (webhook resend re-mints the identical key).
  const ledgerKey = `order:${product.slug}:${order}`;
  const licHash = await sha256Hex(licence);
  if (env.LEDGER) {
    const prior = await env.LEDGER.get(ledgerKey, "json");
    if (prior?.licHash === licHash) return new Response("ok (duplicate)", { status: 200 });
    await env.LEDGER.put(ledgerKey, JSON.stringify({ licHash, at: new Date().toISOString() }));
  }

  await sendLicenceEmail(env, email, name, licence, product.display);
  return new Response("ok", { status: 200 });
}

async function verifyLsSignature(raw, sigHex, secret) {
  if (!secret || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = bytesToHexStr(new Uint8Array(mac));
  if (expected.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

function bytesToHexStr(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return bytesToHexStr(new Uint8Array(digest));
}

// ---------------------------------------------------------------- activation

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleActivate(request, env) {
  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const machine = String(body.machine ?? "");
  if (!/^[0-9a-f]{16,64}$/.test(machine))
    return json(400, { error: "bad_request", message: "Invalid machine code." });

  const parsed = await verifyLicence(env.LICENSE_PUBLIC_KEY, String(body.key ?? ""));
  if (!parsed)
    return json(400, { error: "invalid_key", message: "That licence key wasn't recognised." });

  const f = parsed.fields;
  if (f.type !== "full" || f.machine !== "")
    return json(400, { error: "not_activatable", message: "This key doesn't need online activation." });

  const seatsKey = `seats:${f.product}:${f.order}`;
  const seats = (await env.LEDGER.get(seatsKey, "json")) ?? { machines: [] };

  const bound = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ product: f.product, type: f.type, name: f.name, email: f.email,
                     order: f.order, expiry: f.expiry, machine })
  );

  if (seats.machines.some((m) => m.m === machine))
    return json(200, { licence: bound, seatsUsed: seats.machines.length }); // idempotent re-activate

  if (seats.machines.length >= SEAT_LIMIT)
    return json(409, {
      error: "seat_limit",
      message: `All ${SEAT_LIMIT} machines for this licence are activated. Deactivate one first, or email support@staycoolandstaycool.com.`,
    });

  seats.machines.push({ m: machine, at: new Date().toISOString() });
  await env.LEDGER.put(seatsKey, JSON.stringify(seats));
  return json(200, { licence: bound, seatsUsed: seats.machines.length });
}

async function handleDeactivate(request, env) {
  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const parsed = await verifyLicence(env.LICENSE_PUBLIC_KEY, String(body.licence ?? ""));
  if (!parsed)
    return json(400, { error: "invalid_key", message: "That licence wasn't recognised." });

  const f = parsed.fields;
  if (!/^[0-9a-f]{16,64}$/.test(f.machine))
    return json(400, { error: "not_seat_managed", message: "This licence has no machine seat to release." });

  const seatsKey = `seats:${f.product}:${f.order}`;
  const seats = (await env.LEDGER.get(seatsKey, "json")) ?? { machines: [] };
  const remaining = seats.machines.filter((m) => m.m !== f.machine);
  if (remaining.length !== seats.machines.length)
    await env.LEDGER.put(seatsKey, JSON.stringify({ machines: remaining }));
  return json(200, { ok: true, seatsUsed: remaining.length }); // idempotent
}

// ---------------------------------------------------------------- beta minting

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Vendor-only: mint a beta key (wildcard machine + hard expiry) without the
// private key ever leaving the Worker. Auth: Bearer BETA_ADMIN_TOKEN secret.
// Body: { name, email, order, expiry, product?, send? } — expiry YYYYMMDD
// required (betas always expire). send:true emails the key via Resend.
async function handleMintBeta(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.BETA_ADMIN_TOKEN || !token || !timingSafeEqualStr(token, env.BETA_ADMIN_TOKEN))
    return json(401, { error: "unauthorized" });

  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const slug = String(body.product ?? "cartridge");
  const product = PRODUCTS.find((p) => p.slug === slug);
  if (!product) return json(400, { error: "bad_request", message: `Unknown product "${slug}".` });

  const expiry = String(body.expiry ?? "");
  if (!/^[0-9]{8}$/.test(expiry) || +expiry < 20000101 || +expiry > 21001231)
    return json(400, { error: "bad_request", message: "expiry must be YYYYMMDD — beta keys always expire." });

  let payload;
  try {
    payload = buildPayloadV2({
      product: product.slug, type: "beta",
      name: body.name, email: body.email, order: body.order,
      expiry, machine: "*",
    });
  } catch (e) {
    return json(400, { error: "bad_request", message: String(e.message ?? e) });
  }

  const licence = await signLicence(env.LICENSE_PRIVATE_KEY, payload);
  const order = payload.split("|")[5];

  if (env.LEDGER)
    await env.LEDGER.put(
      `beta:${product.slug}:${order}:${expiry}`,
      JSON.stringify({ licHash: await sha256Hex(licence), at: new Date().toISOString() })
    );

  if (body.send === true) {
    const email = String(body.email ?? "").trim();
    if (!email) return json(400, { error: "bad_request", message: "send:true needs an email." });
    await sendBetaEmail(env, email, String(body.name ?? "tester").trim(), licence, product.display, expiry);
  }

  return json(200, { licence, order, expiry, product: product.slug });
}

async function sendBetaEmail(env, to, name, licence, display, expiry) {
  const nice = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
  const text =
    `Hi ${name},\n\n` +
    `Here's your ${display} beta licence key:\n\n${licence}\n\n` +
    `To activate: open ${display}, click the DEMO badge in the top bar, paste ` +
    `the key in, and hit Activate. Beta keys work on any of your machines and ` +
    `validate offline — no server involved.\n\n` +
    `This beta key expires on ${nice}; the plugin returns to demo mode after ` +
    `that. You'll get a fresh key (or a release build) before then.\n\n` +
    `Thanks for testing!\n\n— Stay Cool and Stay Cool`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${display} <licences@staycoolandstaycool.com>`,
      to: [to], subject: `Your ${display} beta licence key`, text,
    }),
  });
  if (!res.ok) throw new Error("email send failed: " + (await res.text()));
}

// ---------------------------------------------------------------- email

async function sendLicenceEmail(env, to, name, licence, display) {
  const text =
    `Hi ${name},\n\n` +
    `Thanks for buying ${display}. Here's your licence key:\n\n${licence}\n\n` +
    `To activate: open ${display}, click the DEMO badge in the top bar, paste the ` +
    `key in, and hit Activate. A one-time online activation binds it to that ` +
    `machine — you can activate up to 3 machines, and free one up any time from ` +
    `the licence badge. After activation ${display} runs fully offline.\n\n` +
    `Keep this email; it's your proof of licence.\n\n— Stay Cool and Stay Cool`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${display} <licences@staycoolandstaycool.com>`,
      to: [to], subject: `Your ${display} licence key`, text,
    }),
  });
  if (!res.ok) throw new Error("email send failed: " + (await res.text()));
}
