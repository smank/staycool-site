# Cartridge Screenshots

The Cartridge sub-page (`cartridge/index.html`) auto-references PNGs in this folder:

| File | Used in | Recommended size |
|---|---|---|
| `hero.png` | Right-side hero art | Standalone full window, 940×720 minimum, 1880×1440 retina |
| `main.png` | Screenshots grid — "Classic engine" | Full UI, Classic mode active, 16:10 crop ok |
| `modern.png` | Screenshots grid — "Modern engine" | Modern mode active |
| `sequencer.png` | Screenshots grid — "step sequencer" | Mod bar expanded on Step Seq accordion |
| `fx.png` | Screenshots grid — "FX rack" | Close-up of the FX bar, all 5 sections visible |

## To capture

```bash
# 1. Launch the latest build
open ~/Developer/cartridge/build/Cartridge_artefacts/Release/Standalone/Cartridge.app

# 2. Cmd+Shift+4 then Space, click the Cartridge window
mv ~/Desktop/Screenshot*.png ~/Developer/cartridge-site/cartridge/screenshots/hero.png

# 3. Commit + push and Pages picks them up immediately
cd ~/Developer/cartridge-site
git add cartridge/screenshots/*.png
git commit -m "site: add cartridge screenshots"
git push
```

The CSS auto-fits whatever lands here — no markup edits needed as long as file names match the table above.
