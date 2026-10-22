"""Map a design screenshot's background regions, cell by cell.

Sampling the top of each cell (above the text ink) gives the ground the cell is
painted on, which is how the panel structure becomes visible: which columns are
sidebar, which are the centre card, where a chip starts. Text is irrelevant
here, so every token cell collapses to one letter.

This is what shows that the centre column is not inset: it takes the whole band
between the two bars, and the only thing that changes per view is its ground —
`--terminal` for the serial pane, `--panel` for everything else.

Needs Pillow.

    python3 dev/bgmap.py --shot tui_main_zh_dark.png --theme dark --rows 6
"""

import argparse
import sys

CELL_W = 10
CELL_H = 20
# Above the text: the ink band starts around y+6.
SAMPLE_Y = 3
SAMPLE_X = 2

DARK = {
    "bg": (0x09, 0x0D, 0x14),
    "panel": (0x11, 0x16, 0x1F),
    "panel2": (0x15, 0x1B, 0x26),
    "panel3": (0x1C, 0x23, 0x30),
    "terminal": (0x05, 0x08, 0x0D),
    "accent": (0x3F, 0xC8, 0x8A),
}
LIGHT = {
    "bg": (0xEE, 0xF2, 0xF7),
    "panel": (0xFF, 0xFF, 0xFF),
    "panel2": (0xF6, 0xF8, 0xFB),
    "panel3": (0xE9, 0xEE, 0xF5),
    "terminal": (0xFF, 0xFF, 0xFF),
    "accent": (0x1F, 0x9D, 0x64),
}

LETTER = {
    "bg": ".",
    "panel": "P",
    "panel2": "2",
    "panel3": "3",
    "terminal": "t",
    "accent": "A",
}


def classify(rgb, palette):
    best, dist = None, 1 << 30
    for name, ref in palette.items():
        d = sum((rgb[i] - ref[i]) ** 2 for i in range(3))
        if d < dist:
            best, dist = name, d
    return best, dist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", required=True)
    ap.add_argument("--theme", choices=["dark", "light"], default="dark")
    ap.add_argument("--cols", type=int, default=110)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--zoom-cols", type=int, default=0, help="restrict the printed columns")
    a = ap.parse_args()

    from PIL import Image

    palette = DARK if a.theme == "dark" else LIGHT
    img = Image.open(a.shot).convert("RGB")
    px = img.load()
    n = a.zoom_cols or a.cols

    print(f"--- {a.shot} ({a.theme}) ---")
    print("    " + "".join(str((c // 10) % 10) for c in range(n)))
    print("    " + "".join(str(c % 10) for c in range(n)))
    for r in range(a.rows):
        y = r * CELL_H + SAMPLE_Y
        out = []
        for c in range(n):
            rgb = px[c * CELL_W + SAMPLE_X, y]
            name, dist = classify(rgb, palette)
            out.append(LETTER[name])
        print(f"{r:3d} " + "".join(out))


if __name__ == "__main__":
    sys.exit(main())
