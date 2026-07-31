import { test } from "node:test";
import assert from "node:assert/strict";
import { signLicence, sanitizeField, buildPayloadV2, parseLicence, verifyLicence } from "../src/sign.js";
import { TEST_PUBLIC_KEY, TEST_PRIVATE_KEY, MACHINE_A } from "./fixtures.mjs";

test("sign → verify round-trip preserves all fields", async () => {
  const payload = buildPayloadV2({
    type: "full", name: "Jo Tester", email: "jo@example.com",
    order: "ls-1042", expiry: 0, machine: MACHINE_A,
  });
  const key = await signLicence(TEST_PRIVATE_KEY, payload);
  const parsed = await verifyLicence(TEST_PUBLIC_KEY, key);
  assert.ok(parsed);
  assert.deepEqual(parsed.fields, {
    type: "full", name: "Jo Tester", email: "jo@example.com",
    order: "ls-1042", expiry: 0, machine: MACHINE_A,
  });
});

test("signing is deterministic", async () => {
  const payload = buildPayloadV2({ type: "beta", name: "A", email: "a@b.c", order: "beta-1", expiry: 20261101, machine: "*" });
  assert.equal(await signLicence(TEST_PRIVATE_KEY, payload), await signLicence(TEST_PRIVATE_KEY, payload));
});

test("sanitizeField strips pipes and newlines", () => {
  assert.equal(sanitizeField("  Jo|Test\r\ner  "), "JoTester");
  assert.equal(sanitizeField(null), "");
});

test("buildPayloadV2 validation", () => {
  assert.throws(() => buildPayloadV2({ type: "site", name: "A", email: "", order: "o" }));
  assert.throws(() => buildPayloadV2({ type: "full", name: "A", email: "", order: "" }));
  assert.throws(() => buildPayloadV2({ type: "full", name: "A", email: "", order: "o", expiry: "banana" }));
  assert.throws(() => buildPayloadV2({ type: "full", name: "A", email: "", order: "o", machine: "XYZ" }));
  assert.throws(() => buildPayloadV2({ type: "beta", name: "A", email: "", order: "o", expiry: 20261101, machine: "" }));
  // Pipe injection cannot add fields.
  const p = buildPayloadV2({ type: "full", name: "Evil|beta|x", email: "e@x|.com", order: "o|1" });
  assert.equal(p.split("|").length, 7);
});

test("parseLicence rejects bad grammar", async () => {
  const good = await signLicence(TEST_PRIVATE_KEY, buildPayloadV2({ type: "full", name: "A", email: "", order: "o", machine: "*" }));
  assert.ok(parseLicence(good));
  assert.equal(parseLicence(""), null);
  assert.equal(parseLicence("no-dot"), null);
  assert.equal(parseLicence("!!!.abc"), null);
  // v1-shaped payload.
  const v1 = await signLicence(TEST_PRIVATE_KEY, "Jo|jo@x.com|order-1");
  assert.equal(parseLicence(v1), null);
  // Wrong version.
  const v3 = await signLicence(TEST_PRIVATE_KEY, "3|full|A||o|0|*");
  assert.equal(parseLicence(v3), null);
});

test("verifyLicence rejects tampered keys and wrong key", async () => {
  const key = await signLicence(TEST_PRIVATE_KEY, buildPayloadV2({ type: "full", name: "A", email: "", order: "o", machine: "*" }));
  assert.ok(await verifyLicence(TEST_PUBLIC_KEY, key));
  const tampered = "X" + key.slice(1);
  assert.equal(await verifyLicence(TEST_PUBLIC_KEY, tampered), null);
  const [b64] = key.split(".");
  assert.equal(await verifyLicence(TEST_PUBLIC_KEY, b64 + ".1183f30f"), null);
});
