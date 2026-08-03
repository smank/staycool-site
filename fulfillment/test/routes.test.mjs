import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { signLicence, buildPayloadV2, verifyLicence } from "../src/sign.js";
import {
  TEST_PUBLIC_KEY, TEST_PRIVATE_KEY, mockEnv, lsSign, orderCreatedEvent,
  MACHINE_A, MACHINE_B, MACHINE_C, MACHINE_D,
} from "./fixtures.mjs";

const BASE = "https://fulfillment.test";
// Beta expiry is capped server-side, so tests mint inside that window.
const d = new Date(Date.now() + 30 * 86400000);
const SOON = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

let env;
let sentEmails;

beforeEach(() => {
  env = mockEnv();
  sentEmails = [];
  // Stub Resend; anything else hitting the network in tests is a bug.
  mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      sentEmails.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });
});

function post(path, body, headers = {}) {
  return worker.fetch(
    new Request(BASE + path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    }),
    env
  );
}

async function mintUnbound(order = "ls-1042") {
  return signLicence(
    TEST_PRIVATE_KEY,
    buildPayloadV2({ product: "cartridge", type: "full", name: "Jo Tester", email: "jo@example.com", order, expiry: 0, machine: "" })
  );
}

// ---------------------------------------------------------------- routing

test("unknown paths 404, GET 405, OPTIONS preflight carries CORS", async () => {
  assert.equal((await post("/nope", {})).status, 404);
  assert.equal((await post("/", {})).status, 404);
  const get = await worker.fetch(new Request(BASE + "/activate"), env);
  assert.equal(get.status, 405);
  const opt = await worker.fetch(new Request(BASE + "/activate", { method: "OPTIONS" }), env);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("Access-Control-Allow-Origin"), "https://staycoolandstaycool.com");
});

// ---------------------------------------------------------------- webhook

test("webhook happy path mints unbound key and emails it", async () => {
  const raw = orderCreatedEvent();
  const res = await post("/webhook", raw, { "X-Signature": await lsSign(raw) });
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 1);
  const emailText = sentEmails[0].text;
  const key = emailText.match(/^\S+\.\S+$/m)[0];
  const parsed = await verifyLicence(TEST_PUBLIC_KEY, key);
  assert.ok(parsed);
  assert.equal(parsed.fields.type, "full");
  assert.equal(parsed.fields.machine, "");
  assert.equal(parsed.fields.order, "ls-1042");
  assert.match(emailText, /3 machines/);
});

test("webhook rejects bad signature, ignores non-order and unpaid events", async () => {
  const raw = orderCreatedEvent();
  assert.equal((await post("/webhook", raw, { "X-Signature": "00" })).status, 401);
  assert.equal((await post("/webhook", raw, {})).status, 401);

  const unpaid = orderCreatedEvent({ status: "pending" });
  const r2 = await post("/webhook", unpaid, { "X-Signature": await lsSign(unpaid) });
  assert.equal(r2.status, 200);
  assert.equal(sentEmails.length, 0);
});

test("webhook ignores orders for unknown products", async () => {
  const raw = orderCreatedEvent({ productName: "Some Future Thing" });
  const res = await post("/webhook", raw, { "X-Signature": await lsSign(raw) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /unknown product/);
  assert.equal(sentEmails.length, 0);
});

test("webhook retry with same order does not re-email", async () => {
  const raw = orderCreatedEvent();
  await post("/webhook", raw, { "X-Signature": await lsSign(raw) });
  await post("/webhook", raw, { "X-Signature": await lsSign(raw) });
  assert.equal(sentEmails.length, 1);
});

// ---------------------------------------------------------------- activate

test("activate happy path binds machine and is idempotent", async () => {
  const key = await mintUnbound();
  const r1 = await post("/activate", { key, machine: MACHINE_A });
  assert.equal(r1.status, 200);
  const { licence, seatsUsed } = await r1.json();
  assert.equal(seatsUsed, 1);
  const parsed = await verifyLicence(TEST_PUBLIC_KEY, licence);
  assert.equal(parsed.fields.machine, MACHINE_A);
  assert.equal(parsed.fields.order, "ls-1042");

  // Same machine again: same licence, seat count unchanged.
  const r2 = await post("/activate", { key, machine: MACHINE_A });
  assert.equal(r2.status, 200);
  const again = await r2.json();
  assert.equal(again.licence, licence);
  assert.equal(again.seatsUsed, 1);
});

test("activate enforces the 3-seat limit", async () => {
  const key = await mintUnbound();
  for (const m of [MACHINE_A, MACHINE_B, MACHINE_C])
    assert.equal((await post("/activate", { key, machine: m })).status, 200);
  const r = await post("/activate", { key, machine: MACHINE_D });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "seat_limit");
});

test("activate rejects garbage, invalid keys, bound keys, beta keys", async () => {
  assert.equal((await post("/activate", "not json")).status, 400);
  assert.equal((await post("/activate", { key: "garbage", machine: MACHINE_A })).status, 400);
  assert.equal((await post("/activate", { key: await mintUnbound(), machine: "BAD" })).status, 400);

  const bound = await signLicence(TEST_PRIVATE_KEY,
    buildPayloadV2({ product: "cartridge", type: "full", name: "A", email: "", order: "o", machine: MACHINE_A }));
  const r1 = await post("/activate", { key: bound, machine: MACHINE_B });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "not_activatable");

  const wild = await signLicence(TEST_PRIVATE_KEY,
    buildPayloadV2({ product: "cartridge", type: "beta", name: "A", email: "", order: "b", expiry: 20991231, machine: "*" }));
  const r2 = await post("/activate", { key: wild, machine: MACHINE_B });
  assert.equal(r2.status, 400);   // wildcard keys need no activation
});

test("beta keys activate, but only on one machine", async () => {
  const key = await signLicence(TEST_PRIVATE_KEY, buildPayloadV2({
    product: "cartridge", type: "beta", name: "Jo", email: "jo@example.com",
    order: "beta-jo", expiry: 20991231, machine: "" }));

  const r1 = await post("/activate", { key, machine: MACHINE_A });
  assert.equal(r1.status, 200);
  const { licence } = await r1.json();
  const parsed = await verifyLicence(TEST_PUBLIC_KEY, licence);
  assert.equal(parsed.fields.type, "beta");
  assert.equal(parsed.fields.machine, MACHINE_A);

  // Same machine again is idempotent; a second machine is refused.
  assert.equal((await post("/activate", { key, machine: MACHINE_A })).status, 200);
  const r3 = await post("/activate", { key, machine: MACHINE_B });
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).error, "seat_limit");

  // Deactivating frees the single seat.
  assert.equal((await post("/deactivate", { licence })).status, 200);
  assert.equal((await post("/activate", { key, machine: MACHINE_B })).status, 200);
});

// ---------------------------------------------------------------- deactivate

test("deactivate releases the seat and is idempotent", async () => {
  const key = await mintUnbound();
  const { licence } = await (await post("/activate", { key, machine: MACHINE_A })).json();
  await post("/activate", { key, machine: MACHINE_B });

  const r1 = await post("/deactivate", { licence });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).seatsUsed, 1);

  const r2 = await post("/deactivate", { licence }); // again: still 200
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).seatsUsed, 1);

  // Freed seat can be reused.
  assert.equal((await post("/activate", { key, machine: MACHINE_C })).status, 200);
  assert.equal((await post("/activate", { key, machine: MACHINE_D })).status, 200);
  assert.equal((await post("/activate", { key: await mintUnbound(), machine: MACHINE_A })).status, 409);
});

test("deactivate rejects wildcard/beta and invalid licences", async () => {
  const beta = await signLicence(TEST_PRIVATE_KEY,
    buildPayloadV2({ product: "cartridge", type: "beta", name: "A", email: "", order: "b", expiry: 20991231, machine: "*" }));
  const r = await post("/deactivate", { licence: beta });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "not_seat_managed");
  assert.equal((await post("/deactivate", { licence: "garbage" })).status, 400);
});

// ---------------------------------------------------------------- privacy

test("LEDGER never persists name, email, or licence keys", async () => {
  const raw = orderCreatedEvent();
  await post("/webhook", raw, { "X-Signature": await lsSign(raw) });
  const emailedKey = sentEmails[0].text.match(/^\S+\.\S+$/m)[0];
  const { licence } = await (await post("/activate", { key: emailedKey, machine: MACHINE_A })).json();

  const stored = [...env.LEDGER.store.values()].join(" ");
  assert.ok(env.LEDGER.store.size >= 2); // order record + seat record exist
  assert.doesNotMatch(stored, /Jo Tester/);
  assert.doesNotMatch(stored, /jo@example\.com/);
  assert.ok(!stored.includes(emailedKey), "unbound key must not persist");
  assert.ok(!stored.includes(licence), "bound licence must not persist");
  const [payloadB64] = emailedKey.split(".");
  assert.ok(!stored.includes(payloadB64), "payload must not persist in any form");
});

// ---------------------------------------------------------------- mint-beta

test("mint-beta requires the admin token", async () => {
  const body = { name: "Jo", email: "jo@x.com", order: "beta-jo", expiry: SOON };
  assert.equal((await post("/mint-beta", body)).status, 401);
  assert.equal((await post("/mint-beta", body, { Authorization: "Bearer wrong" })).status, 401);
});

test("mint-beta mints an unbound beta key and stores no PII", async () => {
  const r = await post("/mint-beta",
    { name: "Jo Tester", email: "jo@example.com", order: "beta-jo", expiry: SOON },
    { Authorization: "Bearer test-admin-token" });
  assert.equal(r.status, 200);
  const { licence, order, expiry } = await r.json();
  assert.equal(order, "beta-jo");
  assert.equal(expiry, SOON);
  const parsed = await verifyLicence(TEST_PUBLIC_KEY, licence);
  assert.ok(parsed);
  assert.equal(parsed.fields.type, "beta");
  assert.equal(parsed.fields.machine, "");   // unbound: binds on activation
  assert.equal(parsed.fields.expiry, +SOON);
  assert.equal(sentEmails.length, 0); // no send unless asked

  const stored = [...env.LEDGER.store.values()].join(" ");
  assert.doesNotMatch(stored, /Jo Tester/);
  assert.ok(!stored.includes(licence));
});

test("mint-beta rejects expiry beyond the cap and in the past", async () => {
  const auth = { Authorization: "Bearer test-admin-token" };
  const far = await post("/mint-beta",
    { name: "A", email: "a@b.c", order: "o", expiry: "20991231" }, auth);
  assert.equal(far.status, 400);
  assert.match((await far.json()).message, /at most 180 days/);

  const past = await post("/mint-beta",
    { name: "A", email: "a@b.c", order: "o", expiry: "20200101" }, auth);
  assert.equal(past.status, 400);
});

test("mint-beta email carries the download link when given", async () => {
  const r = await post("/mint-beta",
    { name: "Jo", email: "jo@example.com", order: "beta-dl", expiry: SOON,
      send: true, download: "https://staycoolandstaycool.com/beta/Cartridge.zip" },
    { Authorization: "Bearer test-admin-token" });
  assert.equal(r.status, 200);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].text, /staycoolandstaycool\.com\/beta\/Cartridge\.zip/);
  assert.match(sentEmails[0].text, /Licence key:/);
});

test("mint-beta rejects a non-https download link", async () => {
  const r = await post("/mint-beta",
    { name: "Jo", email: "jo@example.com", order: "beta-dl2", expiry: SOON,
      download: "javascript:alert(1)" },
    { Authorization: "Bearer test-admin-token" });
  assert.equal(r.status, 400);
});

test("mint-beta rejects missing/perpetual expiry and unknown product; send=true emails", async () => {
  const auth = { Authorization: "Bearer test-admin-token" };
  assert.equal((await post("/mint-beta", { name: "A", email: "a@b.c", order: "o" }, auth)).status, 400);
  assert.equal((await post("/mint-beta", { name: "A", email: "a@b.c", order: "o", expiry: "0" }, auth)).status, 400);
  assert.equal((await post("/mint-beta", { name: "A", email: "a@b.c", order: "o", expiry: SOON, product: "nope" }, auth)).status, 400);

  const r = await post("/mint-beta",
    { name: "Jo", email: "jo@example.com", order: "beta-jo2", expiry: SOON, send: true }, auth);
  assert.equal(r.status, 200);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /beta licence key/);
  const nice = `${SOON.slice(0, 4)}-${SOON.slice(4, 6)}-${SOON.slice(6, 8)}`;
  assert.ok(sentEmails[0].text.includes(nice), "email states the expiry date");
});

// ---------------------------------------------------------------- key recovery

function lsOrder(overrides = {}) {
  return {
    attributes: {
      order_number: 1042, status: "paid",
      user_name: "Jo Tester", user_email: "jo@example.com",
      first_order_item: { product_name: "Cartridge" },
      ...overrides,
    },
  };
}

function stubLs(orders) {
  mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("api.lemonsqueezy.com/v1/orders"))
      return new Response(JSON.stringify({ data: orders }), { status: 200 });
    if (String(url).includes("api.resend.com")) {
      sentEmails.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });
}

test("recovery emails the byte-identical key to the address ON THE ORDER", async () => {
  env.LS_API_KEY = "test-ls-key";

  const raw = orderCreatedEvent();
  const a = JSON.parse(raw).data.attributes;
  const sig = await lsSign(raw, env.LS_WEBHOOK_SECRET);
  assert.equal((await post("/webhook", raw, { "X-Signature": sig })).status, 200);
  const originalKey = sentEmails[0].text.match(/[A-Za-z0-9+/]+=*\.[0-9a-f]+/)[0];
  sentEmails.length = 0;

  stubLs([lsOrder({ order_number: a.order_number, user_email: a.user_email,
                    user_name: a.user_name, first_order_item: a.first_order_item })]);
  const res = await post("/recover-key", { order: "#" + a.order_number, email: a.user_email });

  assert.equal(res.status, 200);
  const bodyOut = await res.json();
  // The response must NOT carry the key.
  assert.ok(!JSON.stringify(bodyOut).includes(originalKey), "key must never be returned to the caller");
  // It goes to the order's address, byte-identical.
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to[0], a.user_email);
  assert.ok(sentEmails[0].text.includes(originalKey));
  assert.ok(await verifyLicence(TEST_PUBLIC_KEY, originalKey));
});

test("a guessed order number for someone else's email leaks nothing and mails nobody", async () => {
  env.LS_API_KEY = "test-ls-key";
  // Attacker knows the victim's email, walks order numbers. The real order is
  // 1042; they try 1041. Response must be indistinguishable from a hit.
  stubLs([lsOrder()]);
  const hit = await post("/recover-key", { order: "1042", email: "jo@example.com" });
  sentEmails.length = 0;
  stubLs([lsOrder()]);
  const miss = await post("/recover-key", { order: "1041", email: "jo@example.com" });

  assert.equal(hit.status, miss.status);
  assert.deepEqual(await hit.json(), await miss.json());
  assert.equal(sentEmails.length, 0, "a miss must send no email");
});

test("recovery never sends to an address other than the order's", async () => {
  env.LS_API_KEY = "test-ls-key";
  stubLs([lsOrder()]);   // order 1042 belongs to jo@example.com
  const res = await post("/recover-key", { order: "1042", email: "attacker@evil.test" });
  assert.equal(res.status, 200);                 // uniform
  assert.equal(sentEmails.length, 0);            // and nothing sent
});

test("refunded orders and unknown products recover nothing", async () => {
  env.LS_API_KEY = "test-ls-key";
  for (const o of [lsOrder({ status: "refunded" }),
                   lsOrder({ first_order_item: { product_name: "Mystery Box" } })]) {
    sentEmails.length = 0;
    stubLs([o]);
    const res = await post("/recover-key", { order: "1042", email: "jo@example.com" });
    assert.equal(res.status, 200);
    assert.equal(sentEmails.length, 0);
  }
});

test("rate limits cap per-email attempts, then per-IP", async () => {
  env.LS_API_KEY = "test-ls-key";
  stubLs([]);
  // 3 per address per hour.
  for (let i = 0; i < 3; i++)
    assert.equal((await post("/recover-key", { order: "1", email: "a@example.com" })).status, 200);
  assert.equal((await post("/recover-key", { order: "1", email: "a@example.com" })).status, 429);

  // Rotating the address still hits the IP ceiling (10/hour).
  let sawLimit = false;
  for (let i = 0; i < 12 && !sawLimit; i++)
    sawLimit = (await post("/recover-key", { order: "1", email: `b${i}@example.com` })).status === 429;
  assert.ok(sawLimit, "per-IP limit must engage when addresses rotate");
});

test("recover-key without LS_API_KEY is a clean 503, and preflight carries CORS", async () => {
  const res = await post("/recover-key", { order: "1042", email: "jo@example.com" });
  assert.equal(res.status, 503);
  const opt = await worker.fetch(new Request(BASE + "/recover-key", { method: "OPTIONS" }), env);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("Access-Control-Allow-Origin"), "https://staycoolandstaycool.com");
});

test("licence emails carry an HTML part so the key survives copy-paste", async () => {
  // Plain text gets hard-wrapped by mail clients at ~76 columns, and a wrapped
  // paste was rejected outright. CSS soft-wrapping in HTML renders across
  // lines but copies as one unbroken string.
  const raw = orderCreatedEvent();
  const sig = await lsSign(raw, env.LS_WEBHOOK_SECRET);
  assert.equal((await post("/webhook", raw, { "X-Signature": sig })).status, 200);

  assert.equal(sentEmails.length, 1);
  const mail = sentEmails[0];
  assert.ok(mail.html, "must send an html part, not text alone");

  const key = mail.text.match(/[A-Za-z0-9+/]+=*\.[0-9a-f]+/)[0];
  // The key must appear intact and unbroken inside the HTML.
  assert.ok(mail.html.includes(key), "html must contain the key verbatim");
  // And be laid out so the browser wraps it visually rather than literally.
  assert.match(mail.html, /word-break:\s*break-all/);
});

