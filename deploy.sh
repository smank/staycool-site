#!/usr/bin/env bash
# Stay Cool and Stay Cool — Cloudflare Pages deploy.
#
# Site structure:
#   /                — Stay Cool label home (Stay Cool and Stay Cool LLC)
#   /cartridge/      — Cartridge product page
#   /littlefreaks/   — Little Freaks product page (when ready)
#
# First-time setup:
#   1) wrangler login            (browser opens, authorise once)
#   2) ./deploy.sh               (creates the Pages project if missing, deploys)
#
# Subsequent deploys: just ./deploy.sh
#
# After the first successful deploy:
#   - Cloudflare → Workers & Pages → staycool-site → Custom domains
#       → add  staycoolandstaycool.com  (DNS auto-creates in your Cloudflare zone)
#       → also add  www.staycoolandstaycool.com  as a 301 redirect target
#   - Cloudflare → Zero Trust → Access → Applications → Add an application
#       → Self-hosted → host = staycoolandstaycool.com → Policy:
#         "Include: Emails" with allowlist of tester emails
#         → Identity provider: One-time PIN
#       Result: testers visit the URL, get a 6-digit email PIN, then see the site.
#
# To remove the gate at launch: delete the Access application. Free tier
# supports up to 50 users on the OTP policy, more than enough for beta.

set -euo pipefail

PROJECT_NAME="staycool-site"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler not installed. Run: npm install -g wrangler"
  exit 1
fi

if ! wrangler whoami 2>&1 | grep -q "You are logged in"; then
  echo "Not authenticated. Run: wrangler login"
  exit 1
fi

# Create the project the first time (idempotent — fails silently if it exists)
wrangler pages project create "$PROJECT_NAME" \
  --production-branch main \
  --compatibility-date 2026-05-27 \
  2>/dev/null || true

# Deploy current directory contents as the production build
wrangler pages deploy . \
  --project-name "$PROJECT_NAME" \
  --branch main \
  --commit-dirty=true

echo
echo "Deploy complete. Default Pages URL:"
echo "  https://${PROJECT_NAME}.pages.dev"
echo
echo "Custom domain + Access gate are dashboard tasks — see comments at top of this script."
