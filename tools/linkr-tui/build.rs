//! The two things this crate makes at build time: the Windows executable's
//! resource section, and the logo.
//!
//! The icon: only Windows carries resources, and only a Windows build should
//! pay for it — but "is the target Windows" is a question for the environment
//! Cargo sets and not for `#[cfg(windows)]`: a build script is compiled for the
//! *host*, and the GNU-ABI Windows binaries this project ships are
//! cross-compiled from Linux, where that attribute is false and the icon would
//! go missing without a word.
//!
//! The logo: `assets/logo.svg` is rasterised here, at compile time, with resvg
//! — pure Rust, running on the host, so cross-compilation is untouched and no
//! part of the SVG renderer reaches the shipped binary. Each cell of the
//! picture becomes a `(char, fg, bg)` triple in `OUT_DIR/logo.rs`, which
//! `src/logo.rs` includes; the runtime then picks the variant the terminal's
//! own capability calls for, and never links a renderer to do it.

use std::fs;
use std::path::PathBuf;

use resvg::tiny_skia::{Pixmap, Transform};
use usvg::Tree;

/// The box `assets/logo.svg` draws in. Every raster is this, scaled.
const SVG_SIZE: f32 = 200.0;

/// (suffix, half cols, braille cols, ascii cols) for the three sizes the
/// interface asks for: the rail's mark, the card's mark, the splash.
///
/// Half-block and braille cells are twice as tall as they are wide, and the
/// SVG is square, so those rasters are square and their cells come out square
/// on screen. A plain ASCII cell is 1:1, so that raster is 2:1 instead.
const SIZES: &[(&str, u32, u32, u32)] =
    &[("SM", 24, 24, 40), ("MD", 48, 48, 72), ("LG", 72, 72, 108)];

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=assets/logo.svg");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Relative to this crate's root, which is where a build script runs.
        winresource::WindowsResource::new()
            .set_icon("assets/icon.ico")
            .compile()
            .expect("the Windows icon could not be embedded");
    }
    render_logo();
}

/// The SVG, drawn at `w`×`h` pixels.
fn raster(w: u32, h: u32) -> Pixmap {
    let data = fs::read("assets/logo.svg").expect("assets/logo.svg could not be read");
    let tree = Tree::from_data(&data, &usvg::Options::default()).expect("the logo is not an SVG");
    let mut pm = Pixmap::new(w, h).expect("a pixmap at the asked-for size");
    let tr = Transform::from_scale(w as f32 / SVG_SIZE, h as f32 / SVG_SIZE);
    resvg::render(&tree, tr, &mut pm.as_mut());
    pm
}

// --- colour quantisation -----------------------------------------------------

/// The xterm 6×6×6 cube, for the 256-colour variant.
fn xterm256(r: u8, g: u8, b: u8) -> u8 {
    fn cv(v: u8) -> u8 {
        if v < 75 {
            0
        } else {
            ((u16::from(v) - 35) / 40) as u8
        }
    }
    16 + 36 * cv(r) + 6 * cv(g) + cv(b)
}

/// The faintest coverage a pixel can have and still become ink.
///
/// A terminal cell has one colour and no alpha. Keeping the rasteriser's
/// near-transparent fringe would turn it into a dark edge once the colour is
/// shown on a light ground — the black blocks the transparent mark must not
/// have. A pixel either belongs to the flat green mark or it does not.
const ALPHA_FLOOR: u8 = 64;

/// A pixel's own colour, with the alpha the rasteriser premultiplied into it
/// divided back out.
fn straight(p: &[u8]) -> (u8, u8, u8) {
    let a = u32::from(p[3]);
    if a == 0 {
        return (0, 0, 0);
    }
    let un = |v: u8| ((u32::from(v) * 255 + a / 2) / a).min(255) as u8;
    (un(p[0]), un(p[1]), un(p[2]))
}

/// The colour a cell should carry, and its coverage, or nothing when the
/// pixel is only fringe.
fn ink(p: &[u8]) -> Option<(u8, u8, u8, u8)> {
    (p[3] >= ALPHA_FLOOR).then(|| {
        let (r, g, b) = straight(p);
        (r, g, b, p[3])
    })
}

// --- code emission: a cell is (char, fg, bg, coverage) -----------------------

fn col_tok_true(c: (u8, u8, u8, u8)) -> String {
    format!("Color::Rgb({},{},{})", c.0, c.1, c.2)
}

fn col_tok_256(c: (u8, u8, u8, u8)) -> String {
    format!("Color::Indexed({})", xterm256(c.0, c.1, c.2))
}

/// The brand green, as one of the sixteen: 0 none, 1 green, 2 bright green.
///
/// The sixteen-colour variant is not a degraded picture but the picture in the
/// two greens an ANSI palette spells: the solid stroke, and the lighter edge
/// its coverage leaves. Coverage picks the level; the colour itself has already
/// been recovered as green in [`straight`].
fn green_level(p: &[u8]) -> u8 {
    if p[3] >= 192 {
        2
    } else if p[3] >= ALPHA_FLOOR {
        1
    } else {
        0
    }
}

fn col_tok_16(v: u8) -> &'static str {
    match v {
        2 => "Color::LightGreen",
        1 => "Color::Green",
        _ => "Color::Reset",
    }
}

/// One cell, as a `LogoCell { .. }` source fragment.
fn cell(ch: char, fg: &str, bg: &str, fg_a: u8, bg_a: u8) -> String {
    let ch_s = match ch {
        ' ' => "' '".to_string(),
        c => format!("'{}'", c.escape_default().collect::<String>()),
    };
    format!(
        "LogoCell{{ch:{},fg:{},bg:{},fg_a:{},bg_a:{}}}",
        ch_s, fg, bg, fg_a, bg_a
    )
}

/// Half-block cells: two pixel rows per cell, level 3 truecolour, 2 indexed,
/// 1 brand green.
///
/// The four cases are the whole art: both pixels transparent is a space, and
/// each of the others is a `▀` with the colours that carry it — never a `▀`
/// with the *background* standing in for a missing pixel, which paints the
/// terminal's default foreground over half the cell.
fn half_cells(pm: &Pixmap, cols: u32, level: u8) -> Vec<Vec<String>> {
    let rows = cols / 2;
    let d = pm.data();
    let mut out = Vec::new();
    for row in 0..rows {
        let mut r = Vec::new();
        for col in 0..cols {
            let top = &d[((row * 2) * cols + col) as usize * 4..][..4];
            let bot = &d[((row * 2 + 1) * cols + col) as usize * 4..][..4];
            let t = ink(top);
            let b = ink(bot);
            let (ch, fg, bg) = match level {
                3 => match (t, b) {
                    (None, None) => (' ', "Color::Reset", "Color::Reset"),
                    (Some(c), None) => ('\u{2580}', &*col_tok_true(c), "Color::Reset"),
                    (None, Some(c)) => ('\u{2584}', &*col_tok_true(c), "Color::Reset"),
                    (Some(c1), Some(c2)) => ('\u{2580}', &*col_tok_true(c1), &*col_tok_true(c2)),
                },
                2 => match (t, b) {
                    (None, None) => (' ', "Color::Reset", "Color::Reset"),
                    (Some(c), None) => ('\u{2580}', &*col_tok_256(c), "Color::Reset"),
                    (None, Some(c)) => ('\u{2584}', &*col_tok_256(c), "Color::Reset"),
                    (Some(c1), Some(c2)) => ('\u{2580}', &*col_tok_256(c1), &*col_tok_256(c2)),
                },
                _ => {
                    let fv = green_level(top);
                    let bv = green_level(bot);
                    match (fv, bv) {
                        (0, 0) => (' ', "Color::Reset", "Color::Reset"),
                        (f, 0) => ('\u{2580}', col_tok_16(f), "Color::Reset"),
                        (0, b) => ('\u{2584}', col_tok_16(b), "Color::Reset"),
                        (f, b) => ('\u{2580}', col_tok_16(f), col_tok_16(b)),
                    }
                }
            };
            let (fg_a, bg_a) = match ch {
                '\u{2580}' => (t.map_or(0, |c| c.3), b.map_or(0, |c| c.3)),
                '\u{2584}' => (b.map_or(0, |c| c.3), 0),
                _ => (0, 0),
            };
            r.push(cell(ch, fg, bg, fg_a, bg_a));
        }
        out.push(r);
    }
    out
}

/// Braille cells: a 2×4 dot grid per cell, in the terminal's own ink.
///
/// Two pixel columns and four pixel rows per cell make a square picture out of
/// one-cell-wide, two-cell-wide glyphs, and the dots themselves are what a
/// console with no colour at all still renders.
fn braille_cells(pm: &Pixmap, cols: u32) -> Vec<Vec<String>> {
    let pw = cols * 2;
    let rows = cols / 2;
    let d = pm.data();
    let dots = [
        (0u32, 0u32, 0x01u16),
        (0, 1, 0x02),
        (0, 2, 0x04),
        (1, 0, 0x08),
        (1, 1, 0x10),
        (1, 2, 0x20),
        (0, 3, 0x40),
        (1, 3, 0x80),
    ];
    let mut out = Vec::new();
    for row in 0..rows {
        let mut r = Vec::new();
        for col in 0..cols {
            let mut code = 0x2800u16;
            for (dx, dy, bit) in dots {
                if d[((row * 4 + dy) * pw + col * 2 + dx) as usize * 4 + 3] > 120 {
                    code |= bit;
                }
            }
            r.push(cell(
                char::from_u32(u32::from(code)).expect("a braille code point"),
                "Color::Reset",
                "Color::Reset",
                0,
                0,
            ));
        }
        out.push(r);
    }
    out
}

/// ASCII cells: one pixel per cell, down a grey ramp.
///
/// The ramp is coverage, not colour: the mark is one flat green, so its alpha
/// is the only thing that can make one cell heavier than another. That keeps
/// the picture legible on a light terminal and a dark one without inventing a
/// black edge for either.
fn ascii_cells(pm: &Pixmap, cols: u32) -> Vec<Vec<String>> {
    let rows = cols / 2;
    let d = pm.data();
    let ramp = b" .'`,:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
    let mut out = Vec::new();
    for row in 0..rows {
        let mut r = Vec::new();
        for col in 0..cols {
            let p = &d[(row * cols + col) as usize * 4..][..4];
            let idx = if p[3] < ALPHA_FLOOR {
                0
            } else {
                usize::from(p[3]) * (ramp.len() - 1) / 255
            };
            r.push(cell(
                ramp[idx] as char,
                "Color::Reset",
                "Color::Reset",
                0,
                0,
            ));
        }
        out.push(r);
    }
    out
}

/// One variant, as a named static.
fn static_logo(name: &str, rows: &[Vec<String>]) -> String {
    let body = rows
        .iter()
        .map(|r| format!("LogoRow{{cells:&[{}]}}", r.join(",")))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("pub static {name}: &[LogoRow] = &[{body}];\n")
}

/// Write `OUT_DIR/logo.rs`: the cell data, and nothing that knows what a
/// terminal is.
fn render_logo() {
    let mut code = String::from(
        "#[derive(Clone, Copy)] pub struct LogoCell { pub ch: char, pub fg: Color, pub bg: Color, pub fg_a: u8, pub bg_a: u8 }\n\
         #[derive(Clone, Copy)] pub struct LogoRow { pub cells: &'static [LogoCell] }\n",
    );
    for (suffix, half_cols, br_cols, as_cols) in SIZES {
        let pm_half = raster(*half_cols, *half_cols);
        let pm_br = raster(*br_cols * 2, *br_cols * 2);
        let pm_as = raster(*as_cols, *as_cols / 2);
        let n = |base: &str| format!("{base}_{suffix}");
        code.push_str(&static_logo(
            &n("LOGO_TRUECOLOR"),
            &half_cells(&pm_half, *half_cols, 3),
        ));
        code.push_str(&static_logo(
            &n("LOGO_256"),
            &half_cells(&pm_half, *half_cols, 2),
        ));
        code.push_str(&static_logo(
            &n("LOGO_16"),
            &half_cells(&pm_half, *half_cols, 1),
        ));
        code.push_str(&static_logo(
            &n("LOGO_BRAILLE"),
            &braille_cells(&pm_br, *br_cols),
        ));
        code.push_str(&static_logo(
            &n("LOGO_ASCII"),
            &ascii_cells(&pm_as, *as_cols),
        ));
    }
    let out =
        PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by Cargo")).join("logo.rs");
    fs::write(out, code).expect("OUT_DIR/logo.rs could not be written");
}
