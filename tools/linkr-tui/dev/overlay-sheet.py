#!/usr/bin/env python3
"""Render the modal layer or the terminal emulator as one reviewable sheet.

`frame-to-html.py` turns *one* frame into *one* file. These surfaces are only
judgeable as a set — the palette, the help, the confirmation and the notice log
share a vocabulary, and the emulator's colour, cursor and wide-glyph handling
only means anything next to each other — so this runs the real binary once per
surface and puts the screens on a single page, the way the design reviews were
done.

Every screen here comes from `bee --print-frame --ansi`, which is the same
painting code the terminal drives; this only transcribes it. A preview that drew
the frames itself would be a second implementation, and a second implementation
is exactly what a preview is supposed to catch.

The `vt` sheet feeds the pane the way a device would — through `--feed`, which
goes through the same decoder and parser the wire uses — so what is being
reviewed is the emulator rather than a drawing of one.

Usage:
    cargo build
    python3 dev/overlay-sheet.py out.html --sheet overlays --lang zh --theme dark
    python3 dev/overlay-sheet.py out.html --sheet vt --lang zh --theme dark
"""
from __future__ import annotations

import argparse
import html
import importlib.util
import subprocess
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent


def load_renderer():
    """Load `frame-to-html.py` — the filename is not a module name."""
    path = HERE / "frame-to-html.py"
    spec = importlib.util.spec_from_file_location("frame_to_html", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RENDERER = load_renderer()

# (caption, note, extra argv). The size, language and theme are applied by the
# caller, so one sheet covers one build configuration.
OVERLAY_SURFACES = [
    (
        "Serial terminal — no overlay",
        "The frame the design draws: the pane, the rail and both bars, with the "
        "sample transcript loaded.",
        ["--sample"],
    ),
    (
        "Command palette — Ctrl+P",
        "Every action the interface has, searchable, grouped in five "
        "categories. Centred in the centre column: the rail, the counters and "
        "the key hints stay readable behind it.",
        ["--sample", "--overlay", "palette"],
    ),
    (
        "Keyboard help — F1",
        "The chord list. Walked with the arrows and PgUp/PgDn; the legend under "
        "it says how.",
        ["--sample", "--overlay", "help"],
    ),
    (
        "Guarded-command confirmation",
        "What Enter on the `reboot` row raises. The command is spelled out, and "
        "the highlighted button starts on Cancel — a dialog raised by one "
        "keystroke must not be answered by another.",
        ["--sample", "--overlay", "confirm"],
    ),
    (
        "Notice log",
        "Every announcement the session has made, oldest first, with its level "
        "spelled out. Deeper than the three toasts that fit on screen.",
        ["--sample", "--overlay", "notices"],
    ),
]


# --- the emulator sheet ----------------------------------------------------
#
# Each entry is a device's byte stream, written the way a program writes one:
# SGR for colour, `ESC [ r ; c H` to place the cursor, `ESC [ K` to fill a line,
# CR LF between rows. They are `--feed` arguments, so they travel through the
# pane's decoder and parser exactly as the wire does.

COLOURS = (
    "\x1b[2J\x1b[H"
    "\x1b[1mlinkr@bee\x1b[0m:\x1b[34m~\x1b[0m$ printf 'attributes'\r\n"
    "normal   \x1b[1mbold\x1b[0m   \x1b[2mdim\x1b[0m   \x1b[3mitalic\x1b[0m   "
    "\x1b[4munderline\x1b[0m   \x1b[7mreverse\x1b[0m   \x1b[9mstrike\x1b[0m\r\n"
    "\r\n"
    "\x1b[1mlinkr@bee\x1b[0m:\x1b[34m~\x1b[0m$ printf '16 colours'\r\n"
    "\x1b[30mblack\x1b[0m  \x1b[31mred\x1b[0m  \x1b[32mgreen\x1b[0m  "
    "\x1b[33myellow\x1b[0m  \x1b[34mblue\x1b[0m  \x1b[35mmagenta\x1b[0m  "
    "\x1b[36mcyan\x1b[0m  \x1b[37mwhite\x1b[0m\r\n"
    "\x1b[90mgrey\x1b[0m  \x1b[91mbright red\x1b[0m  \x1b[92mbright green\x1b[0m  "
    "\x1b[93mbright yellow\x1b[0m\r\n"
    "\x1b[94mbright blue\x1b[0m  \x1b[95mbright magenta\x1b[0m  "
    "\x1b[96mbright cyan\x1b[0m  \x1b[97mbright white\x1b[0m\r\n"
    "\r\n"
    "\x1b[1mlinkr@bee\x1b[0m:\x1b[34m~\x1b[0m$ printf '256 and true colour'\r\n"
    "\x1b[48;5;236m\x1b[38;5;196m 196 \x1b[0m\x1b[48;5;236m\x1b[38;5;208m 208 \x1b[0m"
    "\x1b[48;5;236m\x1b[38;5;220m 220 \x1b[0m\x1b[48;5;236m\x1b[38;5;45m 45 \x1b[0m"
    "\x1b[48;5;236m\x1b[38;5;135m 135 \x1b[0m\x1b[48;5;236m\x1b[38;5;248m 248 \x1b[0m\r\n"
    "\x1b[38;2;255;105;180m#ff69b4\x1b[0m  \x1b[38;2;0;255;127m#00ff7f\x1b[0m  "
    "\x1b[48;2;40;60;90m\x1b[38;2;230;240;255m true-colour background \x1b[0m\r\n"
    "\r\n"
    "\x1b[1mlinkr@bee\x1b[0m:\x1b[34m~\x1b[0m$ "
)

CURSOR = (
    "\x1b[2J\x1b[H"
    "\x1b[1mlinkr@bee\x1b[0m:\x1b[34m~\x1b[0m$ bee --flash firmware.bin\r\n"
    "\x1b[32m[######      ]  60%\x1b[0m\r\n"
    # The same row, painted a second time: the first bar must not be left
    # behind, and neither must the tail of a longer one.
    "\x1b[2;1H\x1b[K\x1b[32m[############] 100%  written\x1b[0m\r\n"
    "\r\n"
    # Three spinner frames written to one cell.
    "\x1b[4;1H\x1b[2mspinner\x1b[0m   \x1b[33m⠋\x1b[0m"
    "\x1b[4;11H\x1b[33m⠙\x1b[0m"
    "\x1b[4;11H\x1b[33m⠹\x1b[0m"
    "\x1b[2m   — three frames went to that one cell\x1b[0m"
    "\r\n"
    "\r\n"
    # Cursor addressing: this text starts at column 21 of row 6.
    "\x1b[6;21H\x1b[1;36mplaced at row 6, column 21\x1b[0m\r\n"
    "\r\n"
    # Reverse video, then erase to end of line: the bar fills the row.
    "\x1b[8;1H\x1b[7m linkr-tui · 1:1 NORMAL · linkr.c · line 1 of 1 \x1b[K\x1b[0m"
)


def glyph_columns(text: str) -> int:
    """Display columns: an East Asian glyph takes two."""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def pad(text: str, width: int) -> str:
    """Pad to `width` display columns, which is what a terminal aligns on."""
    return text + " " * max(0, width - glyph_columns(text))


def table(header: tuple[str, str, str], rows: list[tuple[str, str, str]]) -> str:
    """A box-drawing table, aligned by display columns rather than characters.

    `│` and `─` are one column each and a CJK glyph is two, so the padding has
    to be counted in columns for the rules to meet the corners.
    """
    widths = [max(glyph_columns(cell) for cell in column) for column in zip(header, *rows)]

    def rule(left: str, middle: str, right: str) -> str:
        return " " + left + middle.join("─" * (w + 2) for w in widths) + right

    def line(cells: tuple[str, str, str]) -> str:
        padded = (pad(cell, w) for cell, w in zip(cells, widths))
        return " │ " + " │ ".join(padded) + " │"

    drawn = [rule("┌", "┬", "┐"), line(header), rule("├", "┼", "┤")]
    drawn += [line(row) for row in rows]
    drawn.append(rule("└", "┴", "┘"))
    return "\r\n".join(drawn)


WIDE = (
    "\x1b[2J\x1b[H\x1b[?1049h"
    "\x1b[1;7m 终端模拟 · a full-screen program owns this screen \x1b[0m\x1b[K\r\n"
    "\r\n"
    + table(
        ("名称", "显示宽度", "字节"),
        [
            ("中文", "2 列", "3"),
            ("かな", "2 列", "3"),
            ("Latin", "1 列", "1"),
            ("e\u0301 组合音", "1 列", "2"),
            ("emoji 🐝", "2 列", "4"),
        ],
    )
    + "\r\n"
    "\r\n"
    " A wide glyph takes two columns and never straddles the edge, so the rules\r\n"
    " above still meet their corners. The alternate screen keeps no scrollback:\r\n"
    " this program's repaints must not fill the user's history.\r\n"
)

VT_SURFACES = [
    (
        "Colours and attributes",
        "SGR: the sixteen named colours, the 256-colour cube and true colour, "
        "with bold, dim, italic, underline, reverse and strike. The pane "
        "resolves the device's names against the theme's own palette — the same "
        "one the browser's xterm.js instance paints with.",
        ["--sample", "--feed", COLOURS],
    ),
    (
        "Cursor addressing, erasure and repaint",
        "Row 2 was painted twice: the 60% bar is gone because the program "
        "returned the cursor to it and erased the line, not because the frame "
        "forgot it. Row 4's spinner wrote three frames to one cell. Row 6 was "
        "placed by `ESC [ 6 ; 21 H`, and row 8's reverse-video bar reaches the "
        "edge because `ESC [ K` fills with the pen.",
        ["--sample", "--feed", CURSOR],
    ),
    (
        "Wide glyphs on the alternate screen",
        "Box drawing meets its corners because a CJK glyph is two columns and "
        "the table was measured that way. The pane is on the alternate screen, "
        "which is where a full-screen program's repaints land.",
        ["--sample", "--feed", WIDE],
    ),
]

SHEETS = {
    "overlays": (
        "modal layer",
        "The palette, the help, the confirmation and the notice log.",
        OVERLAY_SURFACES,
    ),
    "vt": (
        "terminal emulation",
        "What the pane does with a device's escape sequences.",
        VT_SURFACES,
    ),
}

# The screen rules come from the single-frame renderer; only its page ground is
# dropped, because this sheet has its own.
PAGE_CSS = (
    """
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 36px 28px 56px; background: #f4f5f7; color: #1d2129;
    font: 15px/1.6 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 21px; margin: 0 0 8px; letter-spacing: -.01em; }
  .lede { color: #6b7280; margin: 0 0 32px; max-width: 84ch; }
  section { margin: 0 0 30px; }
  h2 { font-size: 15px; margin: 0 0 3px; font-weight: 600; }
  .note { color: #6b7280; margin: 0 0 10px; font-size: 13.5px; max-width: 92ch; }
  .screens { display: flex; flex-direction: column; gap: 30px; }
  code {
    background: #e7e9ee; border-radius: 4px; padding: 1px 5px;
    font: 12.5px "JetBrains Mono", Menlo, monospace;
  }
  footer {
    color: #6b7280; font-size: 13px; border-top: 1px solid #e2e4e9;
    padding-top: 16px;
  }
  figure { margin: 0; }
"""
    + RENDERER.SCREEN_CSS
)


def render_screen(binary: Path, argv: list[str]) -> tuple[str, int, int]:
    """The screen markup, its row count and its column count."""
    dump = subprocess.run(
        [str(binary), "--print-frame", *argv, "--ansi"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    rows = RENDERER.parse_rows(dump)
    markup = RENDERER.screen_markup(rows)
    # `screen_markup` puts the count on the element so a page can hold screens
    # of different widths; read it back rather than recomputing the sum.
    columns = int(markup.split("--cols:", 1)[1].split('"', 1)[0])
    return markup, len(rows), columns


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="the HTML file to write")
    parser.add_argument("--sheet", default="overlays", choices=sorted(SHEETS))
    parser.add_argument("--lang", default="zh", choices=["zh", "en"])
    parser.add_argument("--theme", default="dark", choices=["dark", "light"])
    parser.add_argument("--size", default="110x32", help="COLSxROWS")
    parser.add_argument(
        "--binary",
        default=str(CRATE / "target" / "debug" / "bee"),
        help="the bee binary to render with",
    )
    options = parser.parse_args()

    binary = Path(options.binary)
    if not binary.exists():
        print(
            f"error: {binary} does not exist; run `cargo build` first",
            file=sys.stderr,
        )
        return 1

    subject, lede, surfaces = SHEETS[options.sheet]
    common = [
        options.size,
        "--lang",
        options.lang,
        "--theme",
        options.theme,
    ]
    panels = []
    for caption, note, extra in surfaces:
        markup, rows, columns = render_screen(binary, common + extra)
        panels.append(
            f"  <section>\n"
            f"    <h2>{html.escape(caption)}</h2>\n"
            f'    <p class="note">{html.escape(note)}</p>\n'
            f"    {markup}\n"
            f'    <p class="note">{options.size.replace("x", " × ")} cells — '
            f"{columns} columns, {rows} rows</p>\n"
            f"  </section>"
        )

    page = f"""<!DOCTYPE html>
<html lang="{options.lang}">
<head>
<meta charset="utf-8">
<title>linkr-tui — {subject} ({options.lang}, {options.theme})</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>linkr-tui · {subject} preview</h1>
  <p class="lede">
    Every screen below is the output of the real binary
    (<code>--print-frame --ansi</code>) — the same painting path a terminal
    drives. This page only transcribes the escape sequences, so a preview cannot
    flatter the layout. {lede} Size {options.size}, language
    <code>{options.lang}</code>, theme <code>{options.theme}</code>.
  </p>
  <div class="screens">
{chr(10).join(panels)}
  </div>
  <footer>
    Reproduce with <code>python3 dev/overlay-sheet.py out.html --sheet
    {options.sheet} --lang {options.lang} --theme {options.theme} --size
    {options.size}</code>.
  </footer>
</div>
</body>
</html>
"""
    target = Path(options.target)
    target.write_text(page, encoding="utf-8")
    print(f"{target}: {len(panels)} surfaces, {target.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
