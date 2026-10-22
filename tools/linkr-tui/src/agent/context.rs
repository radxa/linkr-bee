//! How much conversation a request may carry (`mobile/src/agent-context.mjs`).
//!
//! Every request pays for the system prompt before a single history message is
//! sent, and the prompt is large. A history budget therefore has to be what is
//! LEFT of the configured window rather than an absolute number: a user who set
//! a small window and got a constant 24,000 characters of history would see the
//! failure as a provider context-length error that names no setting.
//!
//! The web build learned this the same way, so the arithmetic here is its own:
//! the fixed part in English at 3 characters per token, the conversation
//! pessimistically at 2 because a Chinese turn runs closer to 1.5, a reserve for
//! the request framing, and the ceiling the historical constant used to be.

use crate::agent::runtime::ChatMessage;

/// The most history any request carries, whatever the window says. A large
/// window must behave exactly as it did before this budget existed.
pub const MAX_CONTEXT_CHARS: usize = 24000;

/// The least history any request carries. A window too small to hold its own
/// prompt still gets a request with a conversation in it; the settings form is
/// what reports that failure, not a silently emptied request.
pub const MIN_CONTEXT_CHARS: usize = 2000;

const FIXED_CHARS_PER_TOKEN: i64 = 3;
const HISTORY_CHARS_PER_TOKEN: i64 = 2;

/// Message framing, role markers and the request envelope the provider adds.
const FRAMING_TOKENS: i64 = 256;

/// What one history message costs, in the units the budget is counted in.
///
/// The content plus a flat allowance for the JSON around it — quotes, the role,
/// the braces and the comma. The web build measures `JSON.stringify`, which
/// counts exactly that, and a budget that ignores framing would hand out a
/// little more than it says.
fn message_chars(message: &ChatMessage) -> usize {
    message.content.chars().count() + 24
}

/// The size of a whole history, the way the budget counts it.
pub fn history_chars(messages: &[ChatMessage]) -> usize {
    messages.iter().map(message_chars).sum()
}

/// How many characters of history fit in `context_window`, given how much the
/// fixed part costs and how much of the window the answer may use.
///
/// A window of 0 is "the built-in default", which the caller resolves before
/// calling; treating an unresolved zero as "no window" would silently hand the
/// ceiling to a configuration that asked for less.
pub fn context_budget_chars(context_window: i64, fixed_chars: usize, output_tokens: i64) -> usize {
    if context_window <= 0 {
        return MAX_CONTEXT_CHARS;
    }
    let fixed_tokens = (fixed_chars as i64 + FIXED_CHARS_PER_TOKEN - 1) / FIXED_CHARS_PER_TOKEN;
    let available = context_window - fixed_tokens - output_tokens.max(0) - FRAMING_TOKENS;
    let chars = available.saturating_mul(HISTORY_CHARS_PER_TOKEN);
    chars.clamp(MIN_CONTEXT_CHARS as i64, MAX_CONTEXT_CHARS as i64) as usize
}

/// Trim a history from the oldest end until it fits the budget.
///
/// Whole messages go, never half of one: a truncated question or a reply cut
/// mid-sentence is worse than an older turn that is simply not there. The last
/// message is the one that was just asked and is never dropped, even when it
/// alone is over budget — the alternative is a request that carries no question
/// at all, and editing the user's own words is not this function's business.
///
/// The web build goes further here: it folds the dropped turns into a summary
/// message and keeps tool results intact. This crate has neither a second model
/// call nor tool results in a request, so dropping the oldest turns is the whole
/// of what its history needs.
pub fn trim_history(messages: &mut Vec<ChatMessage>, budget: usize) {
    while messages.len() > 1 && history_chars(messages) > budget {
        messages.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runtime::ChatRole;

    fn turn(role: ChatRole, text: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: text.to_string(),
        }
    }

    /// The numbers the runtime actually uses, checked against the web build's
    /// own expectations: a normal window keeps the historical ceiling, a blank
    /// one resolves to the default before it gets here, and a window smaller
    /// than the fixed part floors instead of going negative.
    #[test]
    fn a_history_budget_follows_the_configured_window() {
        const FIXED: usize = 23700;
        let budget = |window: i64, output: i64| context_budget_chars(window, FIXED, output);

        assert_eq!(budget(32768, 4096), MAX_CONTEXT_CHARS);
        assert_eq!(
            context_budget_chars(32768, 0, 0),
            MAX_CONTEXT_CHARS,
            "a window with room to spare keeps the ceiling"
        );
        assert_eq!(
            context_budget_chars(0, FIXED, 4096),
            MAX_CONTEXT_CHARS,
            "an unresolved zero is the caller's to resolve, not a small window"
        );
        assert_eq!(budget(8192, 4096), MIN_CONTEXT_CHARS);
        assert_eq!(budget(1000, 4096), MIN_CONTEXT_CHARS);
        assert_eq!(
            budget(16000, 4096),
            ((16000 - FIXED as i64 / 3 - 4096 - 256) * 2) as usize,
            "a middling window lands in between"
        );
        assert!(
            budget(16000, 8192) < budget(16000, 1024),
            "more output leaves less room for history"
        );
        assert!(
            context_budget_chars(16000, FIXED, 0) < context_budget_chars(16000, 0, 0),
            "a bigger prompt leaves less room for history"
        );
        for window in [1000, 2000, 4000, 8192] {
            assert_eq!(
                context_budget_chars(window, FIXED, 100_000),
                MIN_CONTEXT_CHARS,
                "a budget below the floor is never negative or tiny"
            );
        }
    }

    /// The oldest turns go first, one whole message at a time, and the question
    /// that was just asked survives even when it alone is over budget.
    #[test]
    fn trimming_drops_the_oldest_whole_turns() {
        let history = |n: usize| {
            (0..n)
                .map(|i| turn(ChatRole::User, &"x".repeat(100 + i)))
                .collect::<Vec<_>>()
        };

        let mut messages = history(4);
        let all = history_chars(&messages);
        trim_history(&mut messages, all);
        assert_eq!(messages.len(), 4, "a history that fits is left alone");

        let mut messages = history(4);
        trim_history(&mut messages, all - 1);
        assert_eq!(
            messages.len(),
            3,
            "one turn over the line, one turn dropped"
        );
        assert_eq!(
            messages.last().unwrap().content.chars().count(),
            103,
            "the question that was just asked is the one that stays"
        );
        assert_eq!(
            messages.first().unwrap().content.chars().count(),
            101,
            "and the oldest is the one that went"
        );

        let mut messages = vec![turn(ChatRole::User, &"y".repeat(50_000))];
        trim_history(&mut messages, 10);
        assert_eq!(
            messages.len(),
            1,
            "the question that asked is never dropped"
        );
    }
}
