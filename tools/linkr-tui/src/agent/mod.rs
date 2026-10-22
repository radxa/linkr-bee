//! The agent data layer, ported from `web/agent_*.js`.
//!
//! The assistant is an upstream feature and must reach parity. What is ported
//! here is everything the runtime and the panel depend on that is *not* the
//! runtime itself: configuration validation, credential redaction, task/note
//! stores, session persistence, token accounting, the diagnostic report, and
//! the execution policy. All of it is plain functions over a `Storage` trait, so
//! the same logic runs against the web's localStorage, a JSON file, or an
//! in-memory test map.
//!
//! The LLM transport is still outside this crate. A model is a network service
//! the host process speaks to over HTTPS, and this crate is deliberately
//! zero-dependency — so the transport is a seam, not a missing piece.
//!
//! The execution policy is *not* missing and never was: it lives in
//! `src/exec/approval.rs` and `src/exec/policy.rs`, which port it from the same
//! `web/agent_execution_policy.js`, and which the assistant view reaches through
//! `crate::exec::executor::Mode`. A second copy of it wrote itself into this
//! module in `6e2681f` and `8abad99`, having been written without looking; it
//! was removed in the commit that added this note, and nothing here referenced
//! either copy.

pub mod config;
pub mod context;
pub mod markdown;
pub mod notes;
pub mod redact;
pub mod report;
pub mod runtime;
pub mod session;
pub mod store;
pub mod tasks;
pub mod usage;
