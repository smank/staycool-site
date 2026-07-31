// Dev-only RSA keypair for tests. NOT the production key — the production
// private key never enters this repo. Matches the pair committed in
// cartridge/tests/TestLicense.cpp so cross-repo fixtures agree.
export const TEST_PUBLIC_KEY =
  "5,53c43f3b6cfb2c6806c0a1d5b7dae1082dbb4f05660d9c35b0b3927e44c7c093689eb202f3f2d4a523fb86988a0d9284904f40db00d97a784c97956aa1c4d9d01d6be43fd6e983f86a0a5f58f685ee60fa447f47e13a5dbffb6468759f997f71960beb98465e50c6689a39d47f9dad9b3bce1bd3fff5689f732c4329e46ad8d9";

export const TEST_PRIVATE_KEY =
  "430365c923fc23866bcd4e44931580d357c90c0451a47cf7c08fa86503d30075ed4bc19bf65bdd50e9960546d4d7a86a0d0c33e2671461f9d6dfaabbb49d7b0bf9b951f27ca7a61ebfaa76e190885bc8dc42f1846410c3bd178cabe481eee738d1c3ec6111a73dff545c9c4a82cb0088756244ca99744b10cc84c442be07eccd,53c43f3b6cfb2c6806c0a1d5b7dae1082dbb4f05660d9c35b0b3927e44c7c093689eb202f3f2d4a523fb86988a0d9284904f40db00d97a784c97956aa1c4d9d01d6be43fd6e983f86a0a5f58f685ee60fa447f47e13a5dbffb6468759f997f71960beb98465e50c6689a39d47f9dad9b3bce1bd3fff5689f732c4329e46ad8d9";

/** Minimal KV mock backed by a Map (get/put with "json" type support). */
export function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
}

/** env for the worker with mocked KV; sendEmails records instead of fetching. */
export function mockEnv(overrides = {}) {
  return {
    LS_WEBHOOK_SECRET: "test-webhook-secret",
    LICENSE_PRIVATE_KEY: TEST_PRIVATE_KEY,
    LICENSE_PUBLIC_KEY: TEST_PUBLIC_KEY,
    RESEND_API_KEY: "re_test",
    LEDGER: mockKV(),
    ...overrides,
  };
}

/** HMAC-SHA256 hex of a raw body with the LS test secret (mirrors LS). */
export async function lsSign(raw, secret = "test-webhook-secret") {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function orderCreatedEvent({ name = "Jo Tester", email = "jo@example.com", order = 1042, status = "paid" } = {}) {
  return JSON.stringify({
    meta: { event_name: "order_created" },
    data: {
      id: String(order),
      attributes: { status, user_name: name, user_email: email, order_number: order },
    },
  });
}

export const MACHINE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const MACHINE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const MACHINE_C = "cccccccccccccccccccccccccccccccc";
export const MACHINE_D = "dddddddddddddddddddddddddddddddd";
