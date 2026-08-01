#!/usr/bin/env bash
# build-manual-pdf.sh — render the Cartridge operator's manual to a versioned PDF.
#
# The manual is authored as the web page public/cartridge/manual/index.html and
# printed to PDF with headless Chrome, using the page's own print stylesheet.
# The version shown on the manual lives in that HTML (header meta + footer);
# --set-version stamps it there IN PLACE so the web manual and the PDF always
# carry the same version, then renders.
#
# Usage:
#   tools/build-manual-pdf.sh                         render at the current version
#   tools/build-manual-pdf.sh --set-version 1.13.1    stamp the version, then render
#   tools/build-manual-pdf.sh --set-version 1.13.1 --date "August 2026"
#
# Options:
#   --set-version X.Y.Z   rewrite the manual's version (in place) before rendering
#   --date "MONTH YEAR"   rewrite the manual's date (in place); implies a revision
#   --out FILE            output path (default: dist/Cartridge-Manual-v<ver>.pdf)
#   -h, --help            show this header
#
# After --set-version, commit + deploy the site so the live web manual matches,
# and pass the PDF to the release with:
#   cartridge/scripts/release-macos.sh --repackage --manual <pdf>

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MANUAL="$ROOT/public/cartridge/manual/index.html"
[[ -f "$MANUAL" ]] || { echo "manual not found: $MANUAL" >&2; exit 1; }

SET_VERSION="" DATE="" OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set-version) SET_VERSION="${2:?--set-version needs X.Y.Z}"; shift ;;
    --date)        DATE="${2:?--date needs a value}"; shift ;;
    --out)         OUT="${2:?--out needs a path}"; shift ;;
    -h|--help)     awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[[ "$(uname)" == "Darwin" ]] || { echo "macOS only (uses Chrome print-to-pdf)." >&2; exit 1; }
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME" ]] || { echo "Chrome not found at: $CHROME (override with \$CHROME)" >&2; exit 1; }

# The manual carries its version as vX.Y.Z in the header meta and the footer.
CUR="$(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' "$MANUAL" | head -1)"
[[ -n "$CUR" ]] || { echo "could not find a version (vX.Y.Z) in the manual" >&2; exit 1; }

if [[ -n "$SET_VERSION" ]]; then
  NEW="v$SET_VERSION"
  if [[ "$NEW" != "$CUR" ]]; then
    # Escape dots so the old version matches literally.
    sed -i '' "s/${CUR//./\\.}/$NEW/g" "$MANUAL"
    echo "==> stamped version: $CUR -> $NEW"
  else
    echo "==> version already $NEW"
  fi
  CUR="$NEW"
fi

if [[ -n "$DATE" ]]; then
  UP="$(printf '%s' "$DATE" | tr '[:lower:]' '[:upper:]')"
  # The only MONTH-YEAR token in the manual is the footer revision date.
  sed -i '' -E "s/[A-Z]+ 20[0-9][0-9]/$UP/" "$MANUAL"
  echo "==> stamped date: $UP"
fi

VER="${CUR#v}"
OUT="${OUT:-$ROOT/dist/Cartridge-Manual-v$VER.pdf}"
mkdir -p "$(dirname "$OUT")"

echo "==> rendering manual -> $OUT"
# --virtual-time-budget lets images/fonts settle before the PDF is captured
# (without it the capture can race and drop the artwork). Do NOT add
# --user-data-dir: with new headless it wedges and never exits.
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=15000 \
  --print-to-pdf="$OUT" "file://$MANUAL" >/dev/null 2>&1

[[ -s "$OUT" ]] || { echo "render produced no output" >&2; exit 1; }

# Add a chapter bookmark outline so PDF viewers get a navigation panel (the
# in-page TOC already jumps; this lets you jump from anywhere). Needs pypdf;
# the step no-ops cleanly if it isn't installed.
echo "==> adding PDF outline"
python3 "$HERE/_add_pdf_outline.py" "$OUT" "$MANUAL" || echo "  (outline step skipped)"

echo "==> done: $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Next:"
echo "  • if you used --set-version, commit + ./deploy.sh so the web manual matches"
echo "  • bundle it into the release:"
echo "      ~/Developer/cartridge/scripts/release-macos.sh --repackage --manual \"$OUT\""
