//! Command policy and execution approval (`web/command_policy.js` +
//! `web/agent_execution_policy.js`).
//!
//! Two lists, both matched against what would actually be typed on the wire:
//! `alwaysAsk` (explicit approval in every mode) and `allow` (exact commands
//! that may be sent unattended in Auto mode). Neither can override a
//! destructive guard, a pending input line, or a mode that asks by design.

pub mod approval;
pub mod cli;
pub mod executor;
pub mod policy;
