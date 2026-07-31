import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { signLicence, buildPayloadV2, verifyLicence } from "../src/sign.js";
import {
  TEST_PUBLIC_KEY, TEST_PRIVATE_KEY, mockEnv, lsSign, orderCreatedEvent,
  MACHINE_A, MACHINE_B, MACHINE_C, MACHINE_D,
} from "./fixtures.mjs";

const BASE = "https://fulfillment.test";

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
    buildPayloadV2({ type: "full", name: "Jo Tester", email: "jo@example.com", order, expiry: 0, machine: "" })
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
    buildPayloadV2({ type: "full", name: "A", email: "", order: "o", machine: MACHINE_A }));
  const r1 = await post("/activate", { key: bound, machine: MACHINE_B });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "not_activatable");

  const beta = await signLicence(TEST_PRIVATE_KEY,
    buildPayloadV2({ type: "beta", name: "A", email: "", order: "b", expiry: 20991231, machine: "*" }));
  const r2 = await post("/activate", { key: beta, machine: MACHINE_B });
  assert.equal(r2.status, 400);
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
    buildPayloadV2({ type: "beta", name: "A", email: "", order: "b", expiry: 20991231, machine: "*" }));
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
