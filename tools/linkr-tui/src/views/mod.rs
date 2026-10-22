//! The content of each centre-column view.
//!
//! A view is two things kept deliberately apart: a *model* — what the device
//! said, as plain data — and a *painter*, a pure function from `&App` plus a
//! width to the lines the pane shows. The split is what makes a view testable
//! with no terminal, no session and no clock, and it is the shape every
//! remaining view copies: get the model right, then place it.

pub mod assistant;
pub mod diagnostics;
pub mod network;
pub mod terminal;

/// The sample reply used by `--sample` and by tests, so the grid can be looked
/// at with real data instead of an empty state. Kept here rather than in the
/// tests so the CLI and the tests cannot drift apart.
pub fn sample_reply() -> Vec<String> {
    diagnostics::SAMPLE
        .iter()
        .map(|line| (*line).to_string())
        .collect()
}
