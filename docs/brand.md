# The mark

A ledger receipt: cream slip, torn bottom edge, and a receipt-green total line.
The colours are the app's own tokens (`apps/web/src/design/tokens.css`)
transcribed to sRGB, because the files that consume them cannot read `oklch()`.

| Token           | oklch                  | sRGB      |
| --------------- | ---------------------- | --------- |
| `--ink-bg`      | `oklch(0.17 0.008 60)` | `#120f0c` |
| `--ink-rule`    | `oklch(0.27 0.018 50)` | `#2e241f` |
| `--ink-cream`   | `oklch(0.96 0.01 80)`  | `#f5f1ea` |
| `--ink-muted`   | `oklch(0.62 0.015 65)` | `#8d847d` |
| `--ink-receipt` | `oklch(0.7 0.14 155)`  | `#47b777` |

## Files

Everything lives in `apps/web/public/`, which vite copies verbatim into both
`dist` and `dist-demo`, and which `apps/server` serves as-is.

| File                   | Consumer                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `icon.svg`             | the master — every raster derives from it                                                        |
| `favicon.svg`          | the tab, at every size                                                                           |
| `apple-touch-icon.png` | Safari "Add to Dock", iOS                                                                        |
| `icon-192.png`         | Chrome's installability gate                                                                     |
| `icon-512.png`         | the install prompt                                                                               |
| `icon-1024.png`        | the macOS dock (Chrome builds an `.icns` from these)                                             |
| `og.png`               | link unfurls, and the GitHub social card                                                         |
| `manifest.webmanifest` | name, colours, icon set — **relative paths only**, so it is correct under `/` and under `/demo/` |

## Regenerating the rasters

The PNGs are committed, so nothing is needed to build or serve the dashboard.
To change the mark, edit `icon.svg` and re-render:

```bash
brew install librsvg            # rsvg-convert
bun run --cwd apps/web brand
```

Two traps the script fails loudly on rather than letting you ship:

- **librsvg does not parse `oklch()`** — it renders those fills as black, with
  no warning. Keep `icon.svg` in hex. The script re-renders with every fill
  stripped and compares hashes, so a colour that stopped parsing is a build
  error.
- **rsvg-convert cannot use Host Grotesk.** Homebrew's FreeType is built
  without brotli and `@fontsource-variable` ships only `.woff2`, so it silently
  substitutes a default sans. `og.png` — the only artifact with type in it —
  goes through headless Chrome with the font inlined, and the script renders it
  twice (with and without the `@font-face`) to prove the real face loaded.

Binaries have no delta in git history, so settle the SVG first and re-render
once, rather than committing a PNG beside every tweak.

## The GitHub social card

`apps/web/public/og.png` is already the right size (1280×640). GitHub does not
read it from the repo — it is an upload:

**Settings → General → Social preview → Edit → Upload an image.**

Committing the file is not the same as shipping it.
