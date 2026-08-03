# Cartridge — Lemon Squeezy fulfillment + activation Worker

On a paid Lemon Squeezy order, LS calls `POST /webhook`. The Worker matches
the LS product name against the `PRODUCTS` catalog (worker.js), signs an
**unbound** licence key (v2 format: `2|product|full|name|email|order|0|`),
and emails it via Resend. The buyer pastes the key into the plugin's DEMO
badge; the plugin calls `POST /activate` once to bind it to that machine
(3 seats per order per product, tracked in KV), then verifies offline forever
after. `POST /deactivate` releases a machine's seat.

One signing key serves every product — the `product` slug in the signed
payload is what stops one plugin's key unlocking another (each build only
honours its own slug). **New product = one row in `PRODUCTS`** (LS name
matcher → slug + display name); no new keys, endpoints, or store code.

Beta keys are minted through the Worker too (`POST /mint-beta`, admin-token
gated) so the private key never leaves Cloudflare — drive it with
`cartridge/tools/beta-keys.py` (mint/batch/list + committed ledger).
`CartridgeLicenseTool sign-beta` remains as the fully offline fallback.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /webhook` | LS `order_created` → mint unbound key, email buyer |
| `POST /activate` | `{key, machine}` → `{licence}` bound to machine, or `409 seat_limit` |
| `POST /deactivate` | `{licence}` → releases that machine's seat (idempotent) |
| `POST /mint-beta` | vendor-only (Bearer `BETA_ADMIN_TOKEN`): mint a beta key (wildcard machine, required expiry); optional `send:true` emails it via Resend. Use `cartridge/tools/beta-keys.py`. |

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
   `wrangler secret put BETA_ADMIN_TOKEN`   (1P: "Cartridge Beta Admin Token")
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

## Data handling (GDPR posture)

The Worker persists as little as possible. KV (`LEDGER`) holds, per order:
`order:<order>` → `{licHash, at}` (SHA-256 of the issued licence, for webhook
dedup) and `seats:<order>` → `{machines:[{m, at}]}` (machine hashes for the
seat limit). **Buyer name, email, and licence keys pass through requests but
are never stored** — a regression test (`routes.test.mjs` "LEDGER never
persists…") enforces this. Lost keys are re-sent from the LS dashboard
(webhook resend re-mints the identical key), not from our records.

- Lawful basis: performance of contract (the buyer asked for a seat-limited
  licence; the seat list is the licence).
- Erasure request: `wrangler kv key delete --binding LEDGER "order:ls-<n>"`
  and `"seats:ls-<n>"` — that is the entirety of our copy. (Purchase records
  live with Lemon Squeezy, the merchant of record.)
- Retention: for the life of the licence (the seat list must outlive the sale).
- Processors: Cloudflare (Workers/KV, standard DPA), Resend (email transit,
  DPA), Lemon Squeezy (merchant of record — they are the controller for the
  purchase itself).
- The site privacy policy must disclose the above (see launch wording pass).

## Behaviour notes

- Signing is deterministic raw RSA, so LS webhook retries and `/activate`
  retries are idempotent for free (same payload → identical licence string).
- The webhook skips the duplicate email if the LEDGER already records the
  identical licence hash for that order.
- Seat bookkeeping is a KV read-modify-write; simultaneous activations can
  race — at one-buyer scale that's acceptable (Durable Object per order is the
  upgrade path if it ever matters).
- CORS on `/activate` + `/deactivate` is scoped to
  `https://staycoolandstaycool.com` for the future web activation page
  (offline machines: paste key + machine code in the browser, get a bound
  licence back). The plugin itself ignores CORS.

## Email

All outbound mail lives in `src/email.js`. Builders return
`{ subject, text, html }` and send nothing; `send()` does the Resend call. That
split means templates are tested without stubbing the network — see
`test/email.test.mjs`.

**Every message ships both parts, and the html is not decoration.** A licence
key is ~600 characters. In plain text, mail clients hard-wrap it, so the pasted
key arrives with newlines embedded — which the plugin rejected outright before
v1.14.1. CSS soft-wrapping (`word-break:break-all`) renders the key across
lines while copying as one unbroken string, because no newline is ever put into
the text. Plain text remains the fallback.

Messages:

| Builder | Trigger | From |
|---|---|---|
| `licenceEmail` | LS `order_created`, and `/recover-key` | `licences@` |
| `betaEmail` | `/mint-beta` with `send: true` | `licences@` |

The contact form is a **different worker** (`public/_worker.js`) and sends from
`hello@`. It is deliberately not shared: separate deploys, separate concerns.

### Deliverability

Mail leaves via the `send.` subdomain, which has its own SPF
(`include:amazonses.com`) and MX for bounces. The root domain's SPF authorises
Google only, which is correct — that path is for mail typed by hand in Gmail.
Root `resend._domainkey` signs outbound, so DMARC passes on DKIM alignment.

### Debugging a missing key

1. Resend dashboard → Emails, filter by recipient. A send that never happened
   means the webhook never fired or `productForOrder` returned null.
2. Worker logs (`npx wrangler tail cartridge-fulfillment`) show the webhook
   arriving and any signature rejection.
3. Signing is deterministic, so re-sending the webhook from Lemon Squeezy mints
   the identical key. `/recover-key` does the same thing self-serve.
