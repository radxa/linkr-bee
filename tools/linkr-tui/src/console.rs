//! The console's output code page, taken to UTF-8 for the run.
//!
//! The interface writes UTF-8: its own glyphs, and every byte the device
//! prints. A Chinese or Japanese Windows console starts on its ANSI code page
//! — 936, 932 — and reads those bytes as mojibake: one UTF-8 character shows
//! as two or three pieces of the local set, which is the "wrong glyphs"
//! failure a font cannot fix. Windows Terminal asks for UTF-8 for its own
//! panes; a bare `cmd.exe` does not, and that is exactly the console this
//! program is written to keep usable.
//!
//! Set when the interface takes the screen, put back however the program
//! leaves — the same contract as raw mode. The user's `chcp` is theirs: a
//! program that changed it for good would leave every later command printing
//! nonsense, and the change would outlive the program that made it.
//!
//! A no-op everywhere but Windows, so the callers are not conditional.

/// The UTF-8 code page.
#[cfg(windows)]
const UTF8: u32 = 65_001;

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicU32, Ordering};

    /// The code page the console had before this program touched it, or 0 when
    /// it did not. A static because there are two exits that may run — the
    /// guard's own restore and the panic hook's — and nothing that owns both;
    /// atomic because either may be the one that gets there.
    static ORIGINAL: AtomicU32 = AtomicU32::new(0);

    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleOutputCP() -> u32;
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }

    /// Take the console to UTF-8, remembering what it was.
    ///
    /// Only when it is not already there, and only when the console agreed:
    /// a program that cannot set the code page (a redirected stdout, a
    /// console-less host) must not restore a value it never changed.
    pub fn utf8() {
        // SAFETY: both are plain console API calls with no arguments to get
        // wrong; they are safe to call from any thread, and the answer of the
        // first is the second's input.
        unsafe {
            let previous = GetConsoleOutputCP();
            if previous == super::UTF8 || previous == 0 {
                return;
            }
            if SetConsoleOutputCP(super::UTF8) != 0 {
                ORIGINAL.store(previous, Ordering::Relaxed);
            }
        }
    }

    /// Put the console back on the code page the user had. Idempotent: the
    /// first caller takes the remembered value, and the second has nothing to
    /// put back.
    pub fn restore() {
        let original = ORIGINAL.swap(0, Ordering::Relaxed);
        if original != 0 {
            // SAFETY: a plain console API call with a value this module
            // remembered from the same API.
            unsafe {
                SetConsoleOutputCP(original);
            }
        }
    }
}

#[cfg(windows)]
pub use win::{restore, utf8};

/// Take the console to UTF-8, remembering what it was. Nothing on the
/// platforms where the console and the program already agree.
#[cfg(not(windows))]
pub fn utf8() {}

/// Put the console back on the code page the user had. Nothing on the
/// platforms where nothing was changed.
#[cfg(not(windows))]
pub fn restore() {}
