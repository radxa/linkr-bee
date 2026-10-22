//! The emergency hang-up hook, in a binary of its own.
//!
//! [`linkr_tui::hangup`] is one slot for the whole process, because one
//! process holds one link — so a test of it cannot share a binary with the
//! rest of the suite, where session after session registers its own link on
//! other threads. Here the slot starts empty and nothing else touches it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use linkr_tui::hangup;

#[test]
fn the_slot_holds_one_link_and_an_exit_ends_that_one() {
    // Nothing has opened a link: an exit has nothing to hang up, and says so
    // rather than pretending.
    assert!(!hangup::hang_up(Duration::from_millis(0)));

    let ended = Arc::new(AtomicUsize::new(0));
    let seen = ended.clone();
    hangup::register(Arc::new(move |_grace| {
        seen.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(hangup::hang_up(hangup::EXIT_GRACE));
    assert_eq!(ended.load(Ordering::SeqCst), 1, "the live link was ended");

    // A later link replaces the earlier one — the board serves one client at a
    // time, so the older ender must never be the one an exit ends.
    let second = Arc::new(AtomicUsize::new(0));
    let seen_second = second.clone();
    hangup::register(Arc::new(move |_grace| {
        seen_second.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(hangup::hang_up(hangup::EXIT_GRACE));
    assert_eq!(second.load(Ordering::SeqCst), 1);
    assert_eq!(
        ended.load(Ordering::SeqCst),
        1,
        "the replaced one is not run"
    );

    // A link that has gone is forgotten, so an exit after a hang-up has
    // nothing to end and no stale link to end it on.
    hangup::clear();
    assert!(!hangup::hang_up(Duration::from_millis(0)));
    assert_eq!(second.load(Ordering::SeqCst), 1);
}
