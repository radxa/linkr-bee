# This crate's assets

`icon.ico` — the Linkr Bee app icon, as the Windows executable wears it: the
seven sizes Windows asks for (16/24/32/48/64/128/256), each frame drawn from
`assets/linkr-bee-icon.svg` at the repository root.

Regenerate it together with the other platform icons rather than by hand:

    python3 assets/make-icons.py    # from the repository root

`build.rs` embeds it on Windows targets only; see that file for why the check
is a target one rather than `#[cfg(windows)]`.
