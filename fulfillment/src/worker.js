// Lemon Squeezy fulfillment + activation Worker for Cartridge.
//
// Routes:
//   POST /webhook     LS order_created → mint UNBOUND retail key, email via Resend
//   POST /activate    { key, machine } → bind key to machine (3 seats/order, KV)
//   POST /deactivate  { licence }      → release that machine's seat
//   POST /revoke-key  vendor-only: kill a key ({ key } or { order }) — enforced
//                     at /activate; already-activated installs verify offline
//                     and keep working until the key's own expiry
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
import { licenceEmail, betaEmail, buildUpdateEmail, send, licencesFrom } from "./email.js";

const SEAT_LIMIT = 3;         // retail: three machines per order
const SEAT_LIMIT_BETA = 1;    // beta: one machine, so a leaked key unlocks one seat
// Beta keys are wildcard-machine, so a leaked one works anywhere until it
// expires. Capping the window server-side means a leaked BETA_ADMIN_TOKEN
// can only mint short-lived keys, not effectively-perpetual ones.
const BETA_MAX_DAYS = 180;
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

    if (request.method === "OPTIONS" && (pathname === "/activate" || pathname === "/deactivate" || pathname === "/recover-key"))
      return withCors(new Response(null, { status: 204 }));

    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    switch (pathname) {
      case "/webhook":    return handleWebhook(request, env);
      case "/activate":   return withCors(await handleActivate(request, env));
      case "/deactivate": return withCors(await handleDeactivate(request, env));
      case "/mint-beta":  return handleMintBeta(request, env);
      case "/revoke-key": return handleRevokeKey(request, env);
      case "/recover-key": return withCors(await handleRecoverKey(request, env));
      case "/seats":      return handleSeats(request, env);
      case "/notify-build": return handleNotifyBuild(request, env);
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

  await send(env, { to: email, from: licencesFrom(product.display),
                    ...licenceEmail({ name, display: product.display, licence }) });
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

// Keys are hashed for the revocation set exactly as minted — no whitespace.
// Pasted keys arrive wrapped/padded (mail clients), so strip before hashing
// or the same key would hash differently at mint and at activate.
async function canonicalKeyHash(key) {
  return sha256Hex(String(key ?? "").replace(/\s+/g, ""));
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
  if (f.machine !== "")
    return json(400, { error: "not_activatable", message: "This key doesn't need online activation." });

  // Revocation is enforced here — the one chokepoint every unbound key must
  // pass. (Already-activated installs verify offline and can't be reached;
  // they run until the key's own expiry.)
  if (env.LEDGER && await env.LEDGER.get(`revoked:${f.product}:${await canonicalKeyHash(body.key)}`))
    return json(403, {
      error: "revoked",
      message: "This licence key has been revoked or replaced by a newer one. "
             + "Use the key from your most recent licence email, or contact "
             + "support@staycoolandstaycool.com.",
    });

  const limit = f.type === "beta" ? SEAT_LIMIT_BETA : SEAT_LIMIT;
  const seatsKey = `seats:${f.product}:${f.order}`;
  const seats = (await env.LEDGER.get(seatsKey, "json")) ?? { machines: [] };

  const bound = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ product: f.product, type: f.type, name: f.name, email: f.email,
                     order: f.order, expiry: f.expiry, machine })
  );

  if (seats.machines.some((m) => m.m === machine))
    return json(200, { licence: bound, seatsUsed: seats.machines.length }); // idempotent re-activate

  if (seats.machines.length >= limit)
    return json(409, {
      error: "seat_limit",
      message: limit === 1
        ? "This licence is already active on a machine. Deactivate it there first, or email support@staycoolandstaycool.com."
        : `All ${limit} machines for this licence are activated. Deactivate one first, or email support@staycoolandstaycool.com.`,
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
// ---------------------------------------------------------------- key recovery
//
// Lemon Squeezy cannot record externally-minted keys (its licence-key system
// only shows keys IT generates, and orders are read-only via API), so the
// buyer's LS account can never hold our key. Delivery is secured the other
// way round: signing is deterministic, so the key is a pure function of the
// order and can be RE-DERIVED on demand instead of stored.
//
// SECURITY: the key is NEVER returned to the caller. It is emailed to the
// address on the order. That is the whole design. Order numbers are small
// sequential integers, so an attacker who knows a customer's email address --
// and musicians publish theirs -- could otherwise walk order numbers until
// one hit and walk away with a working licence. Emailing the owner means a
// successful guess delivers the key to its rightful owner's inbox and gives
// the attacker nothing.
//
// Consequently the response is identical whether or not the order exists: no
// existence oracle, nothing to enumerate. Rate limits below cap inbox
// spamming, which is the only remaining abuse.
const RECOVER_IP_LIMIT = 10;      // per IP per hour
const RECOVER_EMAIL_LIMIT = 3;    // per address per hour
const RECOVER_WINDOW_S = 3600;

// Fixed-window counter in KV. Coarse and occasionally lenient at a window
// edge, which is fine: this throttles nuisance, it is not the security
// boundary -- emailing the owner is.
async function bumpLimit(env, key, limit) {
  if (!env.LEDGER) return true;
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / RECOVER_WINDOW_S)}`;
  const n = Number((await env.LEDGER.get(k)) ?? 0) + 1;
  await env.LEDGER.put(k, String(n), { expirationTtl: RECOVER_WINDOW_S * 2 });
  return n <= limit;
}

async function handleRecoverKey(request, env) {
  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const orderNo = String(body.order ?? "").replace(/[^0-9]/g, "");
  const email = String(body.email ?? "").trim();
  if (!orderNo || !email.includes("@"))
    return json(400, { error: "bad_request", message: "Enter your order number and the email you bought with." });

  // The one honest response. Never varies on whether the order was found.
  const accepted = () => json(200, { ok: true,
    message: "If that order matches, your key is on its way to the email address on the order. Check your spam folder too." });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await bumpLimit(env, `ip:${ip}`, RECOVER_IP_LIMIT)) ||
      !(await bumpLimit(env, `em:${email.toLowerCase()}`, RECOVER_EMAIL_LIMIT)))
    return json(429, { error: "rate_limited",
      message: "Too many attempts. Wait an hour, or email support@staycoolandstaycool.com." });

  if (!env.LS_API_KEY) {
    // Cannot verify the order, so cannot send anything. Say so plainly: this
    // is a vendor misconfiguration, not a hint about the caller's order.
    return json(503, { error: "not_configured",
      message: "Key recovery isn't available right now. Email support@staycoolandstaycool.com." });
  }

  let orders;
  try {
    const r = await fetch(
      "https://api.lemonsqueezy.com/v1/orders?filter[user_email]=" + encodeURIComponent(email) + "&page[size]=100",
      { headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${env.LS_API_KEY}` } });
    if (!r.ok) throw new Error("ls " + r.status);
    orders = (await r.json())?.data ?? [];
  } catch {
    return json(502, { error: "upstream",
      message: "Couldn't reach the store right now. Try again in a minute, or email support@staycoolandstaycool.com." });
  }

  const match = orders.find((o) => String(o?.attributes?.order_number) === orderNo);
  if (!match) return accepted();

  const a = match.attributes;
  if (a.user_email?.trim().toLowerCase() !== email.toLowerCase()) return accepted();
  if (a.status && a.status !== "paid") return accepted();

  const product = productForOrder(a);
  if (!product) return accepted();

  // EXACTLY the webhook's payload, field for field, so determinism yields the
  // identical key the buyer was originally sent.
  const name = (a.user_name || "Music maker").trim();
  const to = (a.user_email || "").trim();
  const key = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ product: product.slug, type: "full", name, email: to,
                     order: "ls-" + String(a.order_number), expiry: 0, machine: "" })
  );

  // Sent to the order's address, never to whatever the form said.
  await send(env, { to, from: licencesFrom(product.display),
                    ...licenceEmail({ name, display: product.display, licence: key }) });
  return accepted();
}

// Read-only view of seat state, so the vendor can answer "did they actually
// install it?". Seats were only ever written; nothing could read them back,
// which made a beta impossible to follow without asking each tester.
// Admin-token gated: it exposes machine hashes and activation times.
async function handleSeats(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.BETA_ADMIN_TOKEN || !token || !timingSafeEqualStr(token, env.BETA_ADMIN_TOKEN))
    return json(401, { error: "unauthorized" });

  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const slug = String(body.product ?? "cartridge");
  const orders = Array.isArray(body.orders) ? body.orders.map(String) : [];
  if (!orders.length)
    return json(400, { error: "bad_request", message: "orders must be a non-empty array." });

  const out = [];
  for (const order of orders.slice(0, 200)) {
    const seats = (await env.LEDGER?.get(`seats:${slug}:${order}`, "json")) ?? null;
    out.push({
      order,
      activated: !!seats && seats.machines.length > 0,
      machines: (seats?.machines ?? []).map((m) => ({ machine: m.m, at: m.at })),
    });
  }
  return json(200, { seats: out });
}

// Tell existing testers a new build is out. Sends no licence key: theirs is
// still valid, and re-issuing one would imply the old one had stopped working.
async function handleNotifyBuild(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.BETA_ADMIN_TOKEN || !token || !timingSafeEqualStr(token, env.BETA_ADMIN_TOKEN))
    return json(401, { error: "unauthorized" });

  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const slug = String(body.product ?? "cartridge");
  const product = PRODUCTS.find((p) => p.slug === slug);
  if (!product) return json(400, { error: "bad_request", message: `Unknown product "${slug}".` });

  const version = String(body.version ?? "").trim();
  if (!version) return json(400, { error: "bad_request", message: "version is required." });

  const downloads = Array.isArray(body.downloads)
    ? body.downloads
        .filter((d) => d && typeof d.url === "string")
        .map((d) => ({ label: String(d.label ?? "").slice(0, 40), url: String(d.url) }))
    : [];
  if (!downloads.length)
    return json(400, { error: "bad_request", message: "at least one download is required." });
  if (downloads.some((d) => !/^https:\/\/[^\s]+$/.test(d.url)))
    return json(400, { error: "bad_request", message: "download urls must be https." });

  const name = String(body.name ?? "there").trim();
  const email = String(body.email ?? "").trim();
  if (!email.includes("@"))
    return json(400, { error: "bad_request", message: "a valid email is required." });

  await send(env, {
    to: email,
    from: licencesFrom(product.display),
    ...buildUpdateEmail({ name, display: product.display, version,
                          downloads, notes: String(body.notes ?? "") }),
  });
  return json(200, { ok: true });
}

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
  if (!/^[0-9]{8}$/.test(expiry))
    return json(400, { error: "bad_request", message: "expiry must be YYYYMMDD — beta keys always expire." });

  const now = new Date();
  const today = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const max = new Date(now.getTime() + BETA_MAX_DAYS * 86400000);
  const maxYmd = max.getUTCFullYear() * 10000 + (max.getUTCMonth() + 1) * 100 + max.getUTCDate();
  if (+expiry < today)
    return json(400, { error: "bad_request", message: "expiry is in the past." });
  if (+expiry > maxYmd)
    return json(400, { error: "bad_request",
      message: `expiry may be at most ${BETA_MAX_DAYS} days out (${maxYmd}).` });

  let payload;
  try {
    payload = buildPayloadV2({
      product: product.slug, type: "beta",
      name: body.name, email: body.email, order: body.order,
      // Unbound by default: the tester activates once and the key binds to
      // that machine. wildcard:true issues an any-machine key for the rare
      // offline case, and gives up the anti-sharing property.
      expiry, machine: body.wildcard === true ? "*" : "",
    });
  } catch (e) {
    return json(400, { error: "bad_request", message: String(e.message ?? e) });
  }

  const licence = await signLicence(env.LICENSE_PRIVATE_KEY, payload);
  const order = payload.split("|")[5];

  if (env.LEDGER) {
    const licHash = await sha256Hex(licence);
    await env.LEDGER.put(
      `beta:${product.slug}:${order}:${expiry}`,
      JSON.stringify({ licHash, at: new Date().toISOString() })
    );

    // Re-issuing replaces: every OTHER key ever minted for this order is
    // revoked, so a tester holds exactly one working key. A deterministic
    // resend (same tester, same expiry → byte-identical key) matches its own
    // hash, revokes nothing, and un-revokes itself — resending is always safe.
    const keysKey = `keys:${product.slug}:${order}`;
    const idx = (await env.LEDGER.get(keysKey, "json")) ?? { hashes: [] };
    for (const old of idx.hashes.filter((x) => x.h !== licHash))
      await env.LEDGER.put(`revoked:${product.slug}:${old.h}`,
                           JSON.stringify({ at: new Date().toISOString(), reason: "reissued" }));
    await env.LEDGER.delete(`revoked:${product.slug}:${licHash}`);
    idx.hashes = [...idx.hashes.filter((x) => x.h !== licHash),
                  { h: licHash, at: new Date().toISOString(), expiry }];
    await env.LEDGER.put(keysKey, JSON.stringify(idx));
  }

  // Optional download URL: a beta key is useless without a build to use it
  // on, so the email carries both when one is supplied.
  const download = String(body.download ?? "").trim();
  // Accept either a single download or one per platform. Each url is checked,
  // because these go straight into an email we send on the vendor's behalf.
  const downloads = Array.isArray(body.downloads)
    ? body.downloads
        .filter((d) => d && typeof d.url === "string")
        .map((d) => ({ label: String(d.label ?? "").slice(0, 40), url: String(d.url) }))
    : [];
  const badUrl = (u) => !/^https:\/\/[^\s]+$/.test(u);
  if (download && badUrl(download))
    return json(400, { error: "bad_request", message: "download must be an https URL." });
  if (downloads.some((d) => badUrl(d.url)))
    return json(400, { error: "bad_request", message: "download urls must be https." });

  if (body.send === true) {
    const email = String(body.email ?? "").trim();
    if (!email) return json(400, { error: "bad_request", message: "send:true needs an email." });
    await send(env, { to: email, from: licencesFrom(product.display),
                      ...betaEmail({ name: String(body.name ?? "tester").trim(), display: product.display, licence: licence, expiry: expiry, download: download, downloads }) });
  }

  return json(200, { licence, order, expiry, product: product.slug });
}


// Vendor-only: revoke keys so they can never activate again. Body is either
// { key } — revoke that exact key (works for beta and retail alike) — or
// { order, product?, keep_latest? } — revoke every key ever minted for the
// order (keep_latest:true spares the newest). Revocation bites at /activate;
// an already-activated install verifies offline and runs out its own expiry.
async function handleRevokeKey(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.BETA_ADMIN_TOKEN || !token || !timingSafeEqualStr(token, env.BETA_ADMIN_TOKEN))
    return json(401, { error: "unauthorized" });
  if (!env.LEDGER)
    return json(500, { error: "no_ledger", message: "LEDGER binding is required for revocation." });

  const body = await readJson(request);
  if (!body) return json(400, { error: "bad_request", message: "Body must be JSON." });

  const at = new Date().toISOString();

  if (body.key) {
    // Verify before revoking: garbage should error, not pollute the set, and
    // parsing tells us the product so the KV key is namespaced correctly.
    const parsed = await verifyLicence(env.LICENSE_PUBLIC_KEY, String(body.key));
    if (!parsed)
      return json(400, { error: "invalid_key", message: "That licence key wasn't recognised." });
    await env.LEDGER.put(`revoked:${parsed.fields.product}:${await canonicalKeyHash(body.key)}`,
                         JSON.stringify({ at, reason: "revoked" }));
    return json(200, { revoked: 1, order: parsed.fields.order });
  }

  if (body.order) {
    const slug = String(body.product ?? "cartridge");
    const order = String(body.order);
    const idx = (await env.LEDGER.get(`keys:${slug}:${order}`, "json")) ?? { hashes: [] };
    if (idx.hashes.length === 0)
      return json(404, { error: "unknown_order",
        message: "No keys recorded for that order (keys minted before revocation "
               + "support are not indexed — revoke those by { key } instead)." });

    const keep = body.keep_latest === true ? idx.hashes[idx.hashes.length - 1].h : null;
    let revoked = 0;
    for (const rec of idx.hashes) {
      if (rec.h === keep) continue;
      await env.LEDGER.put(`revoked:${slug}:${rec.h}`, JSON.stringify({ at, reason: "revoked" }));
      revoked++;
    }
    return json(200, { revoked, kept: keep ? 1 : 0 });
  }

  return json(400, { error: "bad_request", message: "Provide { key } or { order }." });
}

// ---------------------------------------------------------------- email

