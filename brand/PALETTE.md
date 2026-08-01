# Palettes

Three systems, deliberately separate. The label frame stays neutral so each
product can carry its own colour without fighting it.

---

## Cartridge (product)

Taken from `src/ui/Theme.h` in the plugin, so the site and the instrument
match exactly.

| Token | Hex | Use |
| --- | --- | --- |
| primary | `#b82030` | Structural red: rules, borders, chapter numerals |
| hot | `#d43040` | The brand red. Icon, favicon, accents, links |
| hot-bright | `#e84050` | Hover and glow states |
| vrc6 | `#d04828` | Ember orange, reserved for VRC6 expansion channels |
| bg | `#141414` | Page and plugin background |
| surface | `#222222` | Panels, table headers, cards |
| surface-2 | `#2e2e2e` | Raised controls |
| outline | `#454545` | Borders |
| text-1 | `#d8d4d0` | Body text |
| text-2 | `#9a9691` | Secondary text |
| text-3 | `#646464` | Captions, disabled |
| bone | `#e8e4df` | Headings, knob pointers |

---

## Stay Cool label — current (live site)

Deliberately minimal and monochrome. The comment in `public/style.css` calls
it "deadpan so each product page underneath can carry its own visual
identity without being fought for attention."

| Token | Hex | Use |
| --- | --- | --- |
| sc-bg | `#0a0a0a` | Background |
| sc-fg | `#e8e4df` | Text |
| sc-dim | `#888888` | Secondary text |
| sc-line | `#1f1f1f` | Hairlines |
| sc-accent | `#7fa6b5` | Desaturated steel. The only colour in the frame |
| sc-cartridge | `#d43040` | Cartridge red, hover states only |
| sc-freaks | `#d8821e` | Little Freaks orange, hover states only |

---

## Stay Cool label — redesign (unpublished artifact)

A completely different register: light, playful, neo-brutalist. Hard offset
shadows, rotated elements, thick ink borders.

| Token | Hex | Use |
| --- | --- | --- |
| bg | `#e8e5f2` | Lavender ground |
| ink | `#17121f` | Near-black for text, borders, shadows |
| paper | `#fcf8ef` | Cream panels |
| blue | `#3a37f0` | Primary accent |
| coral | `#ff5a3c` | Secondary accent |
| lime | `#c3f03a` | Highlight, status dots |
| pink | `#ff8fca` | Tertiary accent |
| butter | `#ffce3a` | Highlight; the avatar background |

The glasses mark sits naturally here: its red frames and teal lenses were
drawn for this palette, not the dark one.

---

## Type

- **Mono:** JetBrains Mono, falling back to Menlo. Used for all labels,
  eyebrows, captions and numerals across both the plugin and the site.
- **Sans:** system stack (`-apple-system`, `BlinkMacSystemFont`,
  Helvetica Neue). Body copy only.
- The redesign uses heavy Helvetica Neue / Arial at weight 900 with tight
  negative tracking for headlines, which the current site does not.
