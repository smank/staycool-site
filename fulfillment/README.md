# Cartridge — Lemon Squeezy fulfillment Worker

On a paid Lemon Squeezy order, LS calls this Worker's webhook. It verifies the
signature, signs an **offline** Cartridge licence for the buyer (matching the
plugin's embedded public key), optionally records it in KV, and emails the key
via Resend. The buyer pastes it into the plugin's DEMO badge to unlock — no
server, no phone-home.

## Setup (one time)
1. **Rotate the signing key** (the beta key is compromised). On your machine:
   `CartridgeLicenseTool keygen` → keep PRIVATE secret, give the PUBLIC to embed
   in the plugin. Never let the private key touch a shared log.
2. **Deploy:** `cd fulfillment && wrangler deploy`
3. **Secrets:**
   `wrangler secret put LS_WEBHOOK_SECRET`
   `wrangler secret put LICENSE_PRIVATE_KEY`   (the rotated private key)
   `wrangler secret put RESEND_API_KEY`
4. **Resend:** verify `staycoolandstaycool.com` as a sending domain (SPF/DKIM).
5. **Lemon Squeezy:** create the Cartridge product ($29); add a webhook →
   the deployed Worker URL, event `order_created`, using the same signing secret.
6. **Test:** LS test-mode order → confirm the email arrives and the key activates.
