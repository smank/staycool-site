# Cartridge Screenshots

The marketing site (`docs/index.html`) references the following PNGs in this folder:

| File | Used in | Recommended size |
|---|---|---|
| `hero.png` | Right-side hero art | Standalone full window, 940×720 minimum, 1880×1440 retina |
| `main.png` | Screenshots grid — "Classic engine" | Full UI, Classic mode active, 16:10 crop ok |
| `modern.png` | Screenshots grid — "Modern engine" | Modern mode active |
| `sequencer.png` | Screenshots grid — "step sequencer" | Mod bar expanded on Step Seq accordion |
| `fx.png` | Screenshots grid — "FX rack" | Close-up of the FX bar, all 5 sections visible |

## To capture

I tried to take these autonomously while you were asleep but macOS Screen Recording
permission isn't granted to my shell, so the screenshots are placeholders for now.

Grab them when you wake:

```bash
# 1. Launch the latest build
open /Users/shred/Developer/cartridge/build/Cartridge_artefacts/Release/Standalone/Cartridge.app

# 2. Cmd+Shift+4 then Space, click the Cartridge window
#    Screenshots land on the Desktop. Move + rename them:
mv ~/Desktop/Screenshot*.png ~/Developer/cartridge/docs/screenshots/hero.png  # etc.

# 3. Commit + push and GitHub Pages picks them up immediately
cd ~/Developer/cartridge
git add docs/screenshots/*.png
git commit -m "site: add product screenshots"
git push
```

The CSS auto-fits whatever you drop in — no markup edits needed as long as the file
names match the table above.
