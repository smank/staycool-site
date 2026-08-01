# Brand assets

Every mark, illustration and export in one place, split by who owns it: the
**label** (Stay Cool and Stay Cool) or the **product** (Cartridge).

This folder sits outside `public/`, so nothing here is published by
`deploy.sh`. It is the source of truth to copy *from*, not a live directory.

---

## label-stay-cool/

The label's identity. Use these for anything that represents the company
rather than a single plugin: the newsletter, the label home page, company
social cards.

**marks/**

| File | What it is |
| --- | --- |
| `shades-source-800x283.png` | The primary mark. Hand-drawn wayfarers with STAY COOL lettered in each lens, so the name reads twice. Transparent background, use this as the master. |
| `shades-avatar-512.png` | Square crop on butter yellow for avatars (Buttondown, social profiles). |
| `shades-avatar-1024.png` | Same at 2x. |

**illustrations/**

| File | What it is |
| --- | --- |
| `shipping-box.png` | Hand-drawn shipping box with a STAY COOL label. |
| `skeleton-hand-paper-plane.png` | Skeleton hand holding a paper plane out of an ink puddle. Used in the contact section of the redesign. |

**social/** — `social-card-1200x630-dark.png` is the Open Graph card for the
label home. Built in the **current dark** language (see the caveat below).

---

## product-cartridge/

Cartridge's own identity. The square-wave mark belongs to the product, not
the label.

**icon/** — the app icon, shipped inside the plugin bundles and used as the
site favicon. `cartridge-icon.svg` is the master; the PNGs are rendered from
it with transparent corners so each platform can apply its own masking.

**screenshots/** — plugin UI only, with the macOS title bar and traffic
lights cropped off. Product shots should not carry window chrome; it dates
them and ties them to one OS.

**store-lemonsqueezy/** — the three 1600x1200 images for the Lemon Squeezy
listing. Upload `main` first: it becomes the checkout and social card.

**social/** — Open Graph card for the product page, 1200x630.

---

## web-favicons/

The favicon set as deployed: an SVG for modern browsers, PNG fallbacks, and
a full-bleed `apple-touch-icon-180.png`. The touch icon is deliberately
square with no rounded corners, because iOS applies its own mask and would
otherwise show white fringing.

---

## explorations/

Rejected directions, kept so we don't redraw them. Cartridge icon concepts
(`cartridge-icon-*`) and label shades concepts (`label-shades-*`) from before
the real hand-drawn glasses turned up.

---

## Caveat worth reading before you use the cards

There are **two visual languages in play**. The live site is near-black,
monochrome and deadpan. The unpublished redesign is light and neo-brutalist:
lavender ground, hard offset shadows, rotated cards, a bright palette.

Everything in `social/` here, plus the manual, setup guide, changelog and
support pages, is built in the **dark** language. If the redesign ships,
those need rebuilding to match, and the glasses (not the wave) become the
label mark everywhere.

Also note: the Cartridge screenshot embedded in the redesign artifact is
**v1.11.0**, two versions stale. The current shots are in
`product-cartridge/screenshots/`.

See `PALETTE.md` for both colour systems.
