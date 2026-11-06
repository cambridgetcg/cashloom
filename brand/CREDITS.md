# Credits

Who made each asset, with what, and under which licence. Where an agent made something, the line says so, and
anything published under Yu's accounts carries that through. If an asset's maker isn't known, write "not recorded"
rather than guessing.

## Assets

| Asset | Made by | Date | Tools | Notes |
|---|---|---|---|---|
| `kit/` (generated, 71 files) | agent: Claude Code session dd025d89, on the Studio | 2026-10-27 | artcraft-brand brandkit.py 1.8, vectorcraft-cli 0.17.0 | built from `kit/source/brand.json`; verify 270 checks, 0 failed, 0 warnings; a second build gave 69 of 69 files byte-identical (PR #23, commit 5d4fe85) |
| `atlas/public/` icons, manifest and `og.jpg` (8 files) | agent: Claude Code session dd025d89 | 2026-10-27 | `cp` from `kit/web/`, checked with `cmp` | PR #23, commit cc8121d; held to the kit by `atlas/tests/brand-kit.sync.test.ts` |
| the site's header badge the mark follows (`ui/theme.css`, `.cashloom-brand-mark`) | not recorded: commit 71066a5 by "Beta" | 2026-09-29 | CSS, with a Georgia "c" | not a kit file; the kit redraws its "c" in Source Serif 4 |

## Fonts

Every face in the kit is outlined or rasterised, so no kit file needs a font installed. The licence still governs
using the face in a logo and on a website (`kit/BRAND.md`, "Typefaces and licences").

| Family | File | Licence | Source | SHA-256 |
|---|---|---|---|---|
| Inter SemiBold (wordmark, lockups, colour sheet heading, card title) | bundled with vectorcraft-cli | SIL OFL 1.1 | https://github.com/rsms/inter | not recorded (inside the CLI) |
| Inter Light (card subtitle and footer) | `Inter-Light.otf`, installed in `~/Library/Fonts` on the Studio (Inter 4.001) | SIL OFL 1.1: name ID 13 of the installed file, read 2026-11-05 (`kit/BRAND.md` says it was not checked) | https://github.com/rsms/inter; where this copy was downloaded from is not recorded | `0817fd071377740a8e1cba673baf2c726ef5e5c4e6e0962c6e5bdc096329586d` |
| Source Serif 4 Regular (the "c" monogram) | bundled with vectorcraft-cli | SIL OFL 1.1 | https://github.com/adobe-fonts/source-serif | not recorded (inside the CLI) |
| JetBrains Mono Regular (colour sheet labels) | bundled with vectorcraft-cli | SIL OFL 1.1 | https://github.com/JetBrains/JetBrainsMono | not recorded (inside the CLI) |

Which installed file VectorCraft read for Inter Light (`Inter-Light.otf` or `InterVariable.ttf`, both installed) is
not recorded; the kit rebuilds byte for byte on the Studio with both present.

The site's own webfonts (Fraunces, Spline Sans and Spline Sans Mono in `sovereign/ui/src/assets/fonts/`) are not part
of the kit, and this folder doesn't record their licences.

## Images and other material

| Item | Maker | Licence | Source |
|---|---|---|---|
| none: the kit has no photographs, illustrations or third-party artwork | | | |
