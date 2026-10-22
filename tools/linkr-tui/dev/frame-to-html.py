#!/usr/bin/env python3
"""Turn the crate's ANSI frame dump into a standalone HTML file.

Why this exists: the frame dump (`bee --print-frame --ansi`) carries the real
palette as true-colour escapes, but a terminal is the only place those show up.
This renders the same bytes as a grid of fixed one-column cells, so the preview
lines up exactly like the TUI does — including wide (CJK) glyphs, which occupy
two columns — no matter which fonts the viewing browser happens to have.

Usage:
    cargo run --quiet -- --print-frame 100x30 --ansi > frame.ansi
    python3 dev/frame-to-html.py frame.ansi preview.html [--title "..."]
"""
from __future__ import annotations

import html
import re
import sys
import unicodedata

ESCAPE = re.compile(r"\x1b\[([0-9;]*)m")

# U+FE0E/U+FE0F and the other variation selectors are modifiers, not glyphs:
# they choose which *form* the character in front of them takes, and they paint
# no cell of their own. Clustered into the previous cell so a marker like
# `⚠\ufe0e` stays one column, exactly as the TUI measured it.
VARIATION_SELECTOR = re.compile("[\ufe00-\ufe0f\U000e0100-\U000e01ef]")


def cell_width(ch: str) -> int:
    """One column for most glyphs, two for East Asian wide/fullwidth ones."""
    if VARIATION_SELECTOR.match(ch):
        return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


class Style:
    def __init__(self) -> None:
        self.fg: str | None = None
        self.bg: str | None = None
        self.bold = False
        self.dim = False
        self.reverse = False

    def css(self) -> str:
        fg, bg = self.fg, self.bg
        if self.reverse:
            fg, bg = bg or "var(--bg)", fg or "var(--fg)"
        parts = []
        if fg:
            parts.append(f"color:{fg}")
        if bg:
            parts.append(f"background:{bg}")
        if self.bold:
            parts.append("font-weight:500")
        if self.dim:
            parts.append("opacity:.72")
        return ";".join(parts)


def apply(style: Style, params: str) -> None:
    """Apply one SGR sequence to the running style."""
    codes = [int(p) for p in params.split(";") if p != ""] or [0]
    i = 0
    while i < len(codes):
        code = codes[i]
        if code == 0:
            style.fg = style.bg = None
            style.bold = style.dim = style.reverse = False
        elif code == 1:
            style.bold = True
        elif code == 2:
            style.dim = True
        elif code == 7:
            style.reverse = True
        elif code == 22:
            style.bold = style.dim = False
        elif code == 27:
            style.reverse = False
        elif code == 39:
            style.fg = None
        elif code == 49:
            style.bg = None
        elif code in (38, 48) and i + 4 < len(codes) and codes[i + 1] == 2:
            colour = f"rgb({codes[i + 2]},{codes[i + 3]},{codes[i + 4]})"
            if code == 38:
                style.fg = colour
            else:
                style.bg = colour
            i += 4
        elif code in (38, 48) and i + 2 < len(codes) and codes[i + 1] == 5:
            index = codes[i + 2]
            colour = f"var(--p{index})"
            if code == 38:
                style.fg = colour
            else:
                style.bg = colour
            i += 2
        i += 1


def parse_rows(dump: str) -> list[list[tuple[str, int, Style]]]:
    """Split the dump into rows of (glyph, column span, style)."""
    rows: list[list[tuple[str, int, Style]]] = []
    style = Style()
    row: list[tuple[str, int, Style]] = []
    i = 0
    while i < len(dump):
        match = ESCAPE.match(dump, i)
        if match:
            apply(style, match.group(1))
            i = match.end()
            continue
        ch = dump[i]
        if ch == "\n":
            rows.append(row)
            row = []
        elif VARIATION_SELECTOR.match(ch) and row:
            # Modifier: rides on the cell in front of it rather than opening one.
            glyph, span, style = row[-1]
            row[-1] = (glyph + ch, span, style)
        else:
            row.append((ch, cell_width(ch), Style_with(style)))
        i += 1
    if row:
        rows.append(row)
    return rows


def Style_with(style: Style) -> Style:
    """A copy: every cell keeps the style that was in force when it was drawn."""
    copy = Style()
    copy.fg, copy.bg = style.fg, style.bg
    copy.bold, copy.dim, copy.reverse = style.bold, style.dim, style.reverse
    return copy


def screen_markup(rows: list[list[tuple[str, int, Style]]]) -> str:
    """The screen as a grid of cells, with its own column count.

    The count travels on the element as `--cols` rather than being baked into
    the page's stylesheet, so several screens of different widths can sit on one
    page without their grids disagreeing.
    """
    columns = sum(span for _, span, _ in (rows[0] if rows else []))
    body = []
    for row in rows:
        cells = []
        for glyph, span, style in row:
            css = style.css()
            attribute = f' style="{html.escape(css, quote=True)}"' if css else ""
            extra = f" grid-column: span {span};" if span > 1 else ""
            if extra:
                merge = html.escape(extra.strip(), quote=True)
                attribute = (
                    f' style="{merge} {html.escape(css, quote=True)}"'
                    if css
                    else f' style="{merge}"'
                )
            text = "&nbsp;" if glyph == " " else html.escape(glyph)
            cells.append(f"<i{attribute}>{text}</i>")
        body.append(f'<div class="row">{"".join(cells)}</div>')
    return f'<div class="screen" style="--cols:{columns}">{"".join(body)}</div>'


def render(rows: list[list[tuple[str, int, Style]]], title: str) -> str:
    columns = sum(span for _, span, _ in (rows[0] if rows else []))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>
{SCREEN_CSS}
</style>
</head>
<body>
<figure>
<figcaption>{html.escape(title)} — {columns} columns, {len(rows)} rows</figcaption>
{screen_markup(rows)}
</figure>
</body>
</html>
"""


SCREEN_CSS = """  :root {
    --p0:#000;--p1:#8b2c2c;--p2:#2c7a3f;--p3:#8a7a2c;--p4:#33518a;--p5:#7a2c7a;
    --p6:#2c7a7a;--p7:#b8b8b8;--p8:#666;--p9:#e06060;--p10:#54c46a;--p11:#d8c860;
    --p12:#6f9ae0;--p13:#c86fc8;--p14:#5fc8c8;--p15:#fff;
  }
  body { margin:0; padding:24px; background:#888; }
  figure { margin:0; }
  figcaption { font:13px/1.6 system-ui,sans-serif; color:#f2f2f2; margin-bottom:10px; }
  .screen {
    display:inline-block; padding:10px; background:#000; border-radius:8px;
    font-family:"Sarasa Mono SC","Noto Sans Mono CJK SC","Noto Sans Mono",
                "DejaVu Sans Mono",monospace;
    font-size:14px; line-height:1.2; letter-spacing:0; white-space:pre;
  }
  .row { display:grid; grid-template-columns:repeat(var(--cols),1ch); }
  /* Every cell is exactly one column of the monospace grid, so a glyph wider
   * than that column would be shaved off by the overflow rule. `text` is what
   * keeps an emoji-capable mark (⚠, ✔, …) drawn from the monospace font rather
   * than from a colour emoji font whose glyph does not fit — the frame's own
   * U+FE0E already asks for this, and the CSS says it again for the glyphs that
   * arrive without one. */
  i { font-style:normal; overflow:hidden; font-variant-emoji:text; }"""


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    source, target = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else "bee TUI"
    with open(source, encoding="utf-8") as handle:
        dump = handle.read()
    rows = parse_rows(dump)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(render(rows, title))
    print(f"{target}: {len(rows)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
