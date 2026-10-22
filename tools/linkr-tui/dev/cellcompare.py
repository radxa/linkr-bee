"""Compare a rendered frame with a design screenshot, cell by cell.

The screenshots are 10 px per column and 20 px per row, so a 1100x600 picture is
a 110x30 frame. Laying both out on that grid turns "does it look the same" into
"which cells disagree", which is a question a machine can answer.

Ink is decided per cell against that cell's own dominant colour, so a glyph on a
highlighted chip still counts and a chip's padding still does not.

Needs Pillow (`python3 -m pip install pillow`).

    bee --lang zh --theme dark --transport ble --print-frame 110x30 > mine.txt
    python3 dev/cellcompare.py --frame mine.txt --shot tui_main_zh_dark.png

Two readings of the output matter:

- A column that differs on *every* row is a rule, not a bug. The design draws
  its sidebar divider as a 2 px `--line` hairline, below this tool's ink
  threshold; the TUI draws the same column as a `│` glyph, above it. Expect col
  29 to differ on every sidebar row and read past it.
- A row that differs on one side only, with the rows around it mirrored, is a
  *shifted* row: something wrapped. Compare with `rowink.py` to see which side
  moved.
"""

import argparse
import sys
from collections import Counter

from PIL import Image

CELL_W = 10
CELL_H = 20
INK_TOP = 6
# One pixel short of the next cell: a chip's background starts on its own row
# boundary, and sampling that row would credit the cell above it with ink.
INK_BOTTOM = 20


def shot_grid(path, cols, rows):
    img = Image.open(path).convert("RGB")
    px = img.load()
    grid = [[False] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            x0, x1 = c * CELL_W, c * CELL_W + CELL_W
            y0, y1 = r * CELL_H + INK_TOP, min(r * CELL_H + INK_BOTTOM, img.size[1])
            pixels = [px[x, y] for y in range(y0, y1) for x in range(x0, x1)]
            base = Counter(pixels).most_common(1)[0][0]
            for p in pixels:
                if sum(abs(p[i] - base[i]) for i in range(3)) > 90:
                    grid[r][c] = True
                    break
    return grid


def frame_grid(path, cols, rows):
    import unicodedata

    def wide(ch):
        return unicodedata.east_asian_width(ch) in ("W", "F")

    lines = open(path, encoding="utf-8").read().split("\n")
    grid = [[False] * cols for _ in range(rows)]
    for r, line in enumerate(lines[:rows]):
        c = 0
        for ch in line:
            w = 2 if wide(ch) else 1
            if c >= cols:
                break
            if ch != " ":
                grid[r][c] = True
                if w == 2 and c + 1 < cols:
                    grid[r][c + 1] = True
            c += w
    return grid


def show(grid, cols, rows, title):
    print(f"--- {title} ---")
    for r in range(rows):
        print("".join("#" if grid[r][c] else "." for c in range(cols)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", required=True)
    ap.add_argument("--shot")
    ap.add_argument("--cols", type=int, default=110)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()

    mine = frame_grid(a.frame, a.cols, a.rows)
    if a.show:
        show(mine, a.cols, a.rows, "frame " + a.frame)
    if not a.shot:
        return

    theirs = shot_grid(a.shot, a.cols, a.rows)
    if a.show:
        show(theirs, a.cols, a.rows, "screenshot " + a.shot)

    diff = [(r, c, mine[r][c], theirs[r][c]) for r in range(a.rows) for c in range(a.cols) if mine[r][c] != theirs[r][c]]
    print(f"# cells: {a.cols * a.rows}   differing: {len(diff)}")
    per_row = Counter(r for r, _, _, _ in diff)
    for r in sorted(per_row):
        cells = [c for rr, c, _, _ in diff if rr == r]
        extra = "".join("m" if mine[r][c] else "d" for c in cells)
        print(f"  row {r:2d}: {per_row[r]:3d} cells  cols={cells[:24]}{'...' if len(cells) > 24 else ''}  [{extra[:24]}]")
    # A row that is entirely ink on one side only is usually a shifted row, not
    # a wrong row, so call that out.
    print("# m = only my frame has ink, d = only the design has ink")


if __name__ == "__main__":
    sys.exit(main())
