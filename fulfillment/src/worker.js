// Lemon Squeezy fulfillment Worker for Cartridge.
// On a paid order, LS calls this webhook. We verify it's genuinely from LS,
// sign an offline Cartridge licence for the buyer, and email it to them.
//
// Required secrets (wrangler secret put ...):
//   LS_WEBHOOK_SECRET     Lemon Squeezy webhook signing secret
//   LICENSE_PRIVATE_KEY   the ROTATED juce::RSAKey private key ("exp,mod" hex)
//   RESEND_API_KEY        Resend API key for sending the licence email
// Optional binding: LEDGER (KV) — records issued licences for audit / re-send.

import { signLicence } from "./sign.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!(await verifyLsSignature(raw, request.headers.get("X-Signature") || "", env.LS_WEBHOOK_SECRET)))
      return new Response("Bad signature", { status: 401 });

    const event = JSON.parse(raw);
    if (event?.meta?.event_name !== "order_created")
      return new Response("ignored", { status: 200 });

    const a = event.data.attributes;
    if (a.status && a.status !== "paid")
      return new Response("not paid", { status: 200 });

    const name  = (a.user_name || "Cartridge user").trim();
    const email = (a.user_email || "").trim();
    const order = String(a.order_number || event.data.id);
    if (!email) return new Response("no email", { status: 200 });

    const licence = await signLicence(env.LICENSE_PRIVATE_KEY, `${name}|${email}|ls-${order}`);

    if (env.LEDGER)
      await env.LEDGER.put(`order:${order}`,
        JSON.stringify({ name, email, order, licence, at: new Date().toISOString() }));

    await sendLicenceEmail(env, email, name, licence);
    return new Response("ok", { status: 200 });
  },
};

async function verifyLsSignature(raw, sigHex, secret) {
  if (!secret || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

async function sendLicenceEmail(env, to, name, licence) {
  const text =
    `Hi ${name},\n\n` +
    `Thanks for buying Cartridge. Here's your licence key:\n\n${licence}\n\n` +
    `To activate: open Cartridge, click the DEMO badge in the top bar, and paste ` +
    `this in. It validates offline — no server, no phone-home, yours forever.\n\n` +
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
