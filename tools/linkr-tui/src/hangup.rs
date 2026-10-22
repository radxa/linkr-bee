//! One link, reachable from anywhere on the way out.
//!
//! Leaving is not one code path. The interface closes on the quit key, on
//! Ctrl+C, on a paint that failed, on a terminal that went away — and a
//! program can also end in ways nothing planned for: a panic, or a console
//! window being closed, which on Windows is a request to the process rather
//! than a keystroke. Every one of them has the same duty to the board: end
//! the link, out loud where the bearer can end it. A board left connected to
//! a client that is gone stops advertising, and the next client — a phone, a
//! tablet, a second bench — cannot find it.
//!
//! The exits that run through the session call [`Session::hang_up`] and are
//! done; this module is for the others. The live link is registered here as a
//! plain closure, so a panic hook or a console handler — which have no
//! session, no app and often no time — can still ask for the goodbye.
//!
//! [`Session::hang_up`]: crate::session::Session::hang_up

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// How long an emergency exit waits for the link to go down.
///
/// Long enough for a radio to complete a disconnect, short enough that a
/// Windows console close — which gives a process a few seconds before it is
/// killed — is still inside its budget.
pub const EXIT_GRACE: Duration = Duration::from_millis(500);

/// What ends the link: the transport's own goodbye, in a closure so the
/// caller here does not need to know which transport it is.
pub type Ender = Arc<dyn Fn(Duration) + Send + Sync>;

/// The link the process is on, if any. One process holds one link, because the
/// board serves one client at a time — a second would be the same board with
/// two opinions about it.
static SLOT: OnceLock<Mutex<Option<Ender>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Ender>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Remember the link an emergency exit should hang up.
pub fn register(ender: Ender) {
    if let Ok(mut slot) = slot().lock() {
        *slot = Some(ender);
    }
}

/// Forget it: the link it belongs to is gone.
pub fn clear() {
    if let Ok(mut slot) = slot().lock() {
        *slot = None;
    }
}

/// Hang up the live link, if there is one, waiting `grace` for the transport
/// to end it. `true` when a link was asked.
pub fn hang_up(grace: Duration) -> bool {
    let ender = slot().lock().ok().and_then(|slot| slot.clone());
    match ender {
        Some(ender) => {
            ender(grace);
            true
        }
        None => false,
    }
}

/// Whatever a panic wants to do with it first, hang up before it does.
///
/// A panic is the loudest way a program leaves, and the least likely to have
/// run any exit path at all: the hook is the one moment the process is still
/// alive, still able to send the goodbye, and no longer able to pretend the
/// run is going to continue. Chaining the previous hook afterwards keeps the
/// message the user reads.
pub fn catch_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        hang_up(EXIT_GRACE);
        previous(info);
    }));
}

/// Ask Windows to tell this process before its console goes away.
///
/// Closing the console window is not a keystroke: the process is asked to
/// leave and killed a few seconds later whatever it answers. Without this the
/// board would be left connected to a client that no longer exists — the one
/// case the quit key's hang-up cannot cover. A no-op everywhere else.
#[cfg(windows)]
pub fn catch_console_close() {
    use std::os::raw::{c_int, c_ulong};
    use std::sync::Once;

    // The three that mean "leave now", from `wincon.h`. The interrupt keys —
    // `CTRL_C_EVENT` and `CTRL_BREAK_EVENT`, 0 and 1 — are deliberately not in
    // this list: see the handler below.
    const CTRL_CLOSE_EVENT: c_ulong = 2;
    const CTRL_LOGOFF_EVENT: c_ulong = 5;
    const CTRL_SHUTDOWN_EVENT: c_ulong = 6;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(c_ulong) -> c_int>,
            add: c_int,
        ) -> c_int;
    }

    unsafe extern "system" fn handler(event: c_ulong) -> c_int {
        // The goodbye is owed on every way out, this one included, so it is
        // asked for before the question of whose event this is.
        hang_up(EXIT_GRACE);
        if matches!(
            event,
            CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT
        ) {
            // `TRUE`: the process has nothing more to say. Windows kills it
            // when this returns, which is why the hang-up above had to happen
            // inside the handler rather than after it.
            return 1;
        }
        // The interrupt keys are handed on rather than claimed. Ctrl+C and
        // Ctrl+Break are the console's own way of ending a program that is not
        // reading input raw — a `scan`, an `exec` — and a handler that answered
        // `TRUE` for them would swallow the only key that can end such a run.
        // In raw mode the terminal delivers them as input and this never runs;
        // `FALSE` says exactly that: not mine.
        0
    }

    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| unsafe {
        SetConsoleCtrlHandler(Some(handler), 1);
    });
}

#[cfg(not(windows))]
pub fn catch_console_close() {}
