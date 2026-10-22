"""Print the ink column runs of each row, for a screenshot or a frame.

The cell comparator answers "do these agree"; this answers "where is the ink",
which is what you need when they disagree: a run that starts one column early
is an indent bug, a run that is absent is a missing glyph, a run that is one row
lower is a wrap bug.

Needs Pillow. `--crop` bounds the runs reported, so `--crop 32` reads the
sidebar and `--from-col 29 --crop 110` reads the centre pane.

    python3 dev/rowink.py --frame mine.txt --first 20 --limit 24 --crop 32
"""

import argparse
import sys
from collections import Counter

CELL_W = 10
CELL_H = 20
INK_TOP = 6
INK_BOTTOM = 20


def shot_grid(path, cols, rows):
    from PIL import Image

    img = Image.open(path).convert("RGB")
    px = img.load()
    grid = [[False] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            x0 = c * CELL_W
            y0 = r * CELL_H + INK_TOP
            y1 = min(r * CELL_H + INK_BOTTOM, img.size[1])
            pixels = [px[x, y] for y in range(y0, y1) for x in range(x0, x0 + CELL_W)]
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
            if c >= cols:
                break
            if ch != " ":
                grid[r][c] = True
                if c + 1 < cols and wide(ch):
                    grid[r][c + 1] = True
            c += 2 if wide(ch) else 1
    return grid


def runs(row):
    out = []
    start = None
    for c, ink in enumerate(row + [False]):
        if ink and start is None:
            start = c
        elif not ink and start is not None:
            out.append((start, c - 1))
            start = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot")
    ap.add_argument("--frame")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--cols", type=int, default=110)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--crop", type=int, default=32, help="only report runs starting before this col")
    ap.add_argument("--from-col", type=int, default=0, help="only report runs starting at or after this col")
    ap.add_argument("--first", type=int, default=0, help="first row to report")
    a = ap.parse_args()

    if a.shot:
        grid, name = shot_grid(a.shot, a.cols, a.rows), "shot " + a.shot
    else:
        grid, name = frame_grid(a.frame, a.cols, a.rows), "frame " + a.frame

    print(f"--- {name} ---")
    for r in range(a.first, min(a.limit, a.rows)):
        rr = [(s, e) for s, e in runs(grid[r]) if a.from_col <= s < a.crop]
        if rr:
            print(f"row {r:2d}: " + "  ".join(f"{s}-{e}" for s, e in rr))
        else:
            print(f"row {r:2d}: (none)")


if __name__ == "__main__":
    sys.exit(main())
