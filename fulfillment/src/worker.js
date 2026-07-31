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
// Required vars (wrangler.toml):
//   LICENSE_PUBLIC_KEY    matching public key (used to verify inbound keys)
// Required binding: LEDGER (KV) — issued licences + activation seat lists.
//
// Seat bookkeeping uses a plain KV read-modify-write. Two simultaneous
// activations can race (KV is last-write-wins); at one-buyer scale that's
// acceptable. If it ever matters, move seat state to a Durable Object per order.

import { signLicence, buildPayloadV2, verifyLicence } from "./sign.js";

const SEAT_LIMIT = 3;
const CORS_ORIGIN = "https://staycoolandstaycool.com"; // future web activation page

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

  const name = (a.user_name || "Cartridge user").trim();
  const email = (a.user_email || "").trim();
  const order = "ls-" + String(a.order_number || event.data.id);
  if (!email) return new Response("no email", { status: 200 });

  // Unbound retail key: the buyer exchanges it once, online, for a licence
  // bound to their machine (SEAT_LIMIT machines per order).
  const licence = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ type: "full", name, email, order, expiry: 0, machine: "" })
  );

  // LS retries webhooks on non-200; deterministic signing means a retry mints
  // the identical key, so skip the duplicate email if we already sent this one.
  const ledgerKey = `order:${order}`;
  if (env.LEDGER) {
    const prior = await env.LEDGER.get(ledgerKey, "json");
    if (prior?.licence === licence) return new Response("ok (duplicate)", { status: 200 });
    await env.LEDGER.put(ledgerKey, JSON.stringify({ name, email, order, licence, at: new Date().toISOString() }));
  }

  await sendLicenceEmail(env, email, name, licence);
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

  const seatsKey = `seats:${f.order}`;
  const seats = (await env.LEDGER.get(seatsKey, "json")) ?? { machines: [] };

  const bound = await signLicence(
    env.LICENSE_PRIVATE_KEY,
    buildPayloadV2({ type: f.type, name: f.name, email: f.email, order: f.order, expiry: f.expiry, machine })
  );

  if (seats.machines.some((m) => m.m === machine))
    return json(200, { licence: bound, seatsUsed: seats.machines.length }); // idempotent re-activate

  if (seats.machines.length >= SEAT_LIMIT)
    return json(409, {
      error: "seat_limit",
      message: `All ${SEAT_LIMIT} machines for this licence are activated. Deactivate one first, or email stuart.mank@gmail.com.`,
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

  const seatsKey = `seats:${f.order}`;
  const seats = (await env.LEDGER.get(seatsKey, "json")) ?? { machines: [] };
  const remaining = seats.machines.filter((m) => m.m !== f.machine);
  if (remaining.length !== seats.machines.length)
    await env.LEDGER.put(seatsKey, JSON.stringify({ machines: remaining }));
  return json(200, { ok: true, seatsUsed: remaining.length }); // idempotent
}

// ---------------------------------------------------------------- email

async function sendLicenceEmail(env, to, name, licence) {
  const text =
    `Hi ${name},\n\n` +
    `Thanks for buying Cartridge. Here's your licence key:\n\n${licence}\n\n` +
    `To activate: open Cartridge, click the DEMO badge in the top bar, paste the ` +
    `key in, and hit Activate. A one-time online activation binds it to that ` +
    `machine — you can activate up to 3 machines, and free one up any time from ` +
    `the licence badge. After activation Cartridge runs fully offline.\n\n` +
    `Keep this email; it's your proof of licence.\n\n— Stay Cool and Stay Cool`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Cartridge <licences@staycoolandstaycool.com>",
      to: [to], subject: "Your Cartridge licence key", text,
    }),
  });
  if (!res.ok) throw new Error("email send failed: " + (await res.text()));
}
