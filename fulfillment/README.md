# Cartridge — Lemon Squeezy fulfillment + activation Worker

On a paid Lemon Squeezy order, LS calls `POST /webhook`. The Worker verifies
the signature, signs an **unbound** Cartridge licence key (v2 format:
`2|full|name|email|order|0|`), and emails it via Resend. The buyer pastes the
key into the plugin's DEMO badge; the plugin calls `POST /activate` once to
bind it to that machine (3 seats per order, tracked in KV), then verifies
offline forever after. `POST /deactivate` releases a machine's seat.

Beta keys never touch this Worker — they're minted offline with
`CartridgeLicenseTool sign-beta` (wildcard machine + expiry date).

## Routes

| Route | Purpose |
| --- | --- |
| `POST /webhook` | LS `order_created` → mint unbound key, email buyer |
| `POST /activate` | `{key, machine}` → `{licence}` bound to machine, or `409 seat_limit` |
| `POST /deactivate` | `{licence}` → releases that machine's seat (idempotent) |

## Setup (one time)

1. **Rotate the signing key** (the beta key is compromised). On your machine:
   `CartridgeLicenseTool keygen 2048` → PRIVATE stays secret (1Password), PUBLIC
   gets embedded in the plugin (`src/License/LicenseManager.cpp` `kPublicKey`)
   **and** pasted into `LICENSE_PUBLIC_KEY` in `wrangler.toml`. Never let the
   private key touch a shared log.
2. **KV (required):** `npx wrangler kv namespace create LEDGER` → paste the id
   into the `[[kv_namespaces]]` block in `wrangler.toml`. Holds issued licences
   (`order:<order>`) and activation seat lists (`seats:<order>`).
3. **Deploy:** `cd fulfillment && npx wrangler deploy`
4. **Secrets:**
   `wrangler secret put LS_WEBHOOK_SECRET`
   `wrangler secret put LICENSE_PRIVATE_KEY`   (the rotated private key)
   `wrangler secret put RESEND_API_KEY`
5. **Resend:** verify `staycoolandstaycool.com` as a sending domain (SPF/DKIM).
6. **Lemon Squeezy:** create the Cartridge product ($29, LS's own "generate
   license keys" toggle OFF); add a webhook → `<worker-url>/webhook`, event
   `order_created`, using the same signing secret. NOTE: test-mode and
   live-mode webhooks are separate in LS — re-create the webhook in live mode
   after store activation.
7. **Test:** LS test-mode order → email arrives → paste key in plugin →
   online activation succeeds → relaunch offline still licensed.

## Local dev / e2e

```sh
# .dev.vars (not committed): LS_WEBHOOK_SECRET, LICENSE_PRIVATE_KEY, RESEND_API_KEY
# wrangler.toml LICENSE_PUBLIC_KEY must match the dev private key.
npx wrangler dev          # http://127.0.0.1:8787, KV mocked locally
npm test                  # node --test: sign/parse/verify + route handlers
```

Point the plugin at the dev server with the `CARTRIDGE_LICENSE_SERVER`
environment variable (Standalone build).

## Only testable against real LS later (launch checklist)

- Real `order_created` payload shape and a real webhook signing secret
- Resend deliverability (DKIM/SPF on the verified domain)
- The full buy → email → paste → activate loop
- File download delivery (LS disables downloads for test-mode orders)

## Behaviour notes

- Signing is deterministic raw RSA, so LS webhook retries and `/activate`
  retries are idempotent for free (same payload → identical licence string).
- The webhook skips the duplicate email if the LEDGER already records the
  identical licence for that order.
- Seat bookkeeping is a KV read-modify-write; simultaneous activations can
  race — at one-buyer scale that's acceptable (Durable Object per order is the
  upgrade path if it ever matters).
- CORS on `/activate` + `/deactivate` is scoped to
  `https://staycoolandstaycool.com` for the future web activation page
  (offline machines: paste key + machine code in the browser, get a bound
  licence back). The plugin itself ignores CORS.
