# Linkr Bee visual assets

[Project overview](../README.md) | [User guide](../docs/USAGE.md) | [Documentation](../docs/README.md)

## Logos

| File | Use |
| --- | --- |
| `linkr-bee-logo.svg` | Horizontal lockup on light backgrounds: README, docs, print |
| `linkr-bee-logo-dark.svg` | Same lockup on dark backgrounds |
| `linkr-bee-logo-mono.svg` | Single-colour printing, laser marking, silkscreen |
| `linkr-bee-mark.svg` | Icon-only mark, transparent, for dark surfaces |
| `linkr-bee-mark-light.svg` | Icon-only mark, darker green, for light surfaces |
| `linkr-bee-logo-concept.png` | Legacy concept sheet from the previous mark, kept for reference |

Web assets live with the app: `web/favicon.svg` is the same artwork on a
rounded tile, and the topbar inlines the mark so it inherits `currentColor`.

## Screenshots

| Layout | English UI | Chinese UI |
| --- | --- | --- |
| Desktop terminal | [desktop-en](screenshots/linkr-bee-terminal-desktop-en.jpg) | [desktop](screenshots/linkr-bee-terminal-desktop.jpg) |
| Serial settings | [controls-en](screenshots/linkr-bee-terminal-controls-en.jpg) | [controls](screenshots/linkr-bee-terminal-controls.jpg) |
| Phone-width terminal | [mobile-en](screenshots/linkr-bee-terminal-mobile-en.jpg) | [mobile](screenshots/linkr-bee-terminal-mobile.jpg) |

English introductions must use the `-en.jpg` captures. The original filenames are
reserved for the Chinese README and user guide; do not share a Chinese screenshot
between language editions. Screenshot links in this asset inventory are references,
not an embedded cross-language gallery.

The images show the current shared Web UI with sample UART output in a
disconnected retained-transcript state. They do not demonstrate a live BLE session,
native-app acceptance, or measured target behavior. The capture uses clean browser
contexts without API keys, user conversations, or real target data.

To regenerate all six images, install the dependencies in `mobile/`, start the
static server, and run the capture in a second terminal:

```sh
# Terminal 1, from the repository root
tools/serve_web.sh

# Terminal 2
node tools/capture_docs_screenshots.mjs
```

The script uses the existing Playwright dependency and its installed Chromium,
falling back to Google Chrome. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to choose a
browser binary, or pass a different local URL as the script's first argument.
Desktop captures use a 1440 x 900 viewport; phone captures use 430 x 932. Both use
a 2x pixel scale. English visible translation labels are checked before capture.

## proposals/

Fourteen files, not referenced by the app: the four initial directions
(`01-hive-node` … `04-comb-trio`, amber) and the three merged variants
(`a-hex-terminal` … `c-hex-negative`, green) that `app-icon.svg` was chosen
from. `a-hex-terminal` is the shipped direction — the production files one
level up are its final tuning, on a tighter view box.

## Brand colors

- Hive green: `#3FC88A` — dark theme accent, `--accent` in `web/skin-v2.css`
- Hive green, light surfaces: `#1F9D64` — light theme accent
- Ink: `#0B1118` (icon tile), `#05080D` (page background)

## The mark

One hexagon: the hive. Inside it sits a terminal prompt and a block cursor, so
the same shape reads as both "a board waiting for a command" and "a cell in a
hive". There is no second outline to collapse at small sizes.

Stroke weights are fixed on the 512 grid: outline 30, prompt 26. Do not rescale
them independently — the outline has to stay visibly heavier than the content,
otherwise the two merge into one thick glyph below 40 px.

## Sizes

- **88 px and up** — full mark, all three parts legible
- **44–88 px** — prompt and cursor still separate
- **32–44 px** — use `linkr-bee-mark.svg`; the cursor reads as a solid block
- **16 px** — only the hexagon survives. That is expected, and it is why the
  favicon uses the version with a filled tile: the silhouette carries the brand
  even when the interior is gone.

## Clear space

Keep at least 25% of the mark's height free on all sides. Do not place the mark
inside another outlined container — the hexagon is already the frame.

## Don't

- Do not rebuild the prompt from three lines. Two lines plus the vertex is the
  mark; a third line turns it into a list glyph.
- Do not use `#3FC88A` on white for anything smaller than 44 px; contrast drops
  below 3:1 and the outline disappears. Use `linkr-bee-mark-light.svg`.
- Do not rotate, skew, or outline the mark with a second stroke.
