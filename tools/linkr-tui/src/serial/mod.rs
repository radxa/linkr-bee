//! Serial-console semantics carried over from the web client.
//!
//! Three of the web's serial modules live here, kept as one module because they
//! all turn raw device bytes into something the interface can show:
//!
//! - [`console`] — `web/serial_console.js`: the *passive* prompt heuristic. It
//!   only reads the tail of untrusted output and names the kind of interaction
//!   the device is waiting for (`shell`, `login`, `password`, `pager`, …). It is
//!   deliberately not a parser that grants anything.
//! - [`journal`] — `web/serial_journal.js`: a bounded ring of received bytes,
//!   control-character masked, with cursor-based paging so a read costs the
//!   page, not the whole window.
//! - [`keys`] — `web/terminal_keys.js`: the byte sequences a keystroke sends to
//!   the device, including control folding and modifier prefixes.
//!
//! The watch engine (`web/serial_watch.js`) is large enough to keep its own
//! module at [`crate::watch`].

pub mod console;
pub mod journal;
pub mod keys;
