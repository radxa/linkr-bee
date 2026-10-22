//! The Linkr Bee host terminal, as a library.
//!
//! The binary in `main.rs` is a thin shell over this: every piece of behaviour
//! worth testing — state, theme, strings, and the composition of a frame — is
//! reachable without a terminal, so the test suite runs headless.

pub mod accessory;
pub mod agent;
pub mod app;
pub mod base64;
pub mod capability;
pub mod cli;
pub mod clipboard;
pub mod device;
pub mod dialogs;
pub mod doctor;
pub mod event;
pub mod exec;
pub mod hangup;
pub mod i18n;
pub mod lan_token_store;
pub mod licenses;
pub mod logo;
pub mod palette;
pub mod private_file;
pub mod protocol;
pub mod serial;
pub mod serve;
pub mod session;
pub mod settings;
pub mod text;
pub mod theme;
pub mod trace;
pub mod traffic;
pub mod transport;
pub mod ui;
pub mod views;
pub mod vt;
pub mod watch;
