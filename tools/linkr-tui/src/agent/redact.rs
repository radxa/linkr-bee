//! Credential and URL redaction (`agent_tasks.js` `redactTaskText`).
//!
//! Task text, notes and report evidence all pass through this one function so
//! that a bearer token, a `password: …` assignment, or a URL's embedded
//! credentials never survive into durable storage or a bug report.

/// Redact bearer tokens, password/key/token/secret assignments, and URL
/// userinfo/query/fragment, then cap the result at 2000 characters.
pub fn redact_task_text(value: &str) -> String {
    redact_text(value, 2000)
}

/// Apply the same credential filtering to bounded, transient prompt evidence.
pub fn redact_text(value: &str, limit: usize) -> String {
    let out = redact_bearer_tokens(value);
    let out = redact_assignments(&out);
    let out = redact_urls(&out);
    truncate_chars(&out, limit)
}

/// `Bearer <token>` -> `Bearer [redacted]`, case-insensitive, word-boundary.
fn redact_bearer_tokens(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut search_from = 0;
    loop {
        let rest = &value[search_from..];
        let rest_lower = rest.to_ascii_lowercase();
        let Some(rel) = rest_lower.find("bearer ") else {
            break;
        };
        let start = search_from + rel;
        // Word boundary: the char before `bearer` must not be alphanumeric/underscore.
        let boundary_ok = start == 0 || {
            value[..start]
                .chars()
                .next_back()
                .map(|c| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(true)
        };
        if !boundary_ok {
            search_from = start + "bearer".len();
            continue;
        }
        out.push_str(&value[cursor..start]);
        let after = &value[start + "bearer ".len()..];
        let token_len = after
            .char_indices()
            .find(|(_, c)| c.is_whitespace())
            .map(|(i, _)| i)
            .unwrap_or(after.len());
        out.push_str("Bearer [redacted]");
        let end = start + "bearer ".len() + token_len;
        cursor = end;
        search_from = end;
    }
    out.push_str(&value[cursor..]);
    out
}

/// `password[:=]value`, `api_key[:=]value`, etc. -> `key[:=][redacted]`.
fn redact_assignments(value: &str) -> String {
    const KEYS: [&str; 6] = [
        "password", "passwd", "api-key", "api_key", "token", "secret",
    ];
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    let bytes = value.as_bytes();
    while i < bytes.len() {
        let slice = &value[i..];
        let slice_lower = slice.to_ascii_lowercase();
        let mut matched: Option<usize> = None; // the byte length of the "key:" part
        for key in KEYS {
            if !slice_lower.starts_with(key) {
                continue;
            }
            let after_key = &slice[key.len()..];
            let after_trim = after_key.trim_start_matches([' ', '\t']);
            // The next char after optional spaces must be ':' or '='.
            if after_trim.starts_with(':') || after_trim.starts_with('=') {
                let sep_at = key.len() + (after_key.len() - after_trim.len());
                // Consume the separator and any trailing spaces before the
                // value, so `password: hunter2` keeps its `: ` like upstream.
                let after_sep = &slice[sep_at + 1..];
                let trailing_ws = after_sep.len() - after_sep.trim_start_matches([' ', '\t']).len();
                matched = Some(sep_at + 1 + trailing_ws);
                break;
            }
        }
        match matched {
            Some(sep_end) => {
                out.push_str(&value[i..i + sep_end]);
                // The value runs to the next whitespace/comma/semicolon.
                let tail = &value[i + sep_end..];
                let val_len = tail
                    .char_indices()
                    .find(|(_, c)| c.is_whitespace() || *c == ',' || *c == ';')
                    .map(|(idx, _)| idx)
                    .unwrap_or(tail.len());
                out.push_str("[redacted]");
                i += sep_end + val_len;
            }
            None => {
                let ch = value[i..].chars().next().unwrap_or(' ');
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    out
}

/// Strip userinfo/query/fragment from `http(s)://…` spans; unparseable -> `[url]`.
fn redact_urls(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    for (start, end) in url_spans(value) {
        out.push_str(&value[cursor..start]);
        out.push_str(&strip_url(&value[start..end]));
        cursor = end;
    }
    out.push_str(&value[cursor..]);
    out
}

fn url_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut search_from = 0;
    while search_from < text.len() {
        let rel = lower[search_from..]
            .find("http://")
            .or_else(|| lower[search_from..].find("https://"));
        let Some(rel) = rel else { break };
        let start = search_from + rel;
        let rest = &text[start..];
        let end_rel = rest
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, '<' | '>' | '"'))
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let end = start + end_rel;
        spans.push((start, end));
        search_from = end;
    }
    spans
}

fn strip_url(url: &str) -> String {
    let scheme = if url.starts_with("https://") {
        "https://"
    } else {
        "http://"
    };
    let Some(rest) = url.strip_prefix(scheme) else {
        return "[url]".to_string();
    };
    // Drop query and fragment before splitting authority from path.
    let rest = match rest.find(['?', '#']) {
        Some(i) => &rest[..i],
        None => rest,
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let authority = match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    if authority.is_empty() {
        return "[url]".to_string();
    }
    format!("{scheme}{authority}{path}")
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_tokens_are_redacted() {
        assert_eq!(
            redact_task_text("Authorization: Bearer abcdef123"),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(redact_task_text("Bearer xyz"), "Bearer [redacted]");
    }

    #[test]
    fn password_assignments_are_redacted() {
        assert_eq!(
            redact_task_text("password: hunter2"),
            "password: [redacted]"
        );
        assert_eq!(redact_task_text("api_key=secret123"), "api_key=[redacted]");
        assert_eq!(redact_task_text("PASSWORD: abc"), "PASSWORD: [redacted]");
    }

    #[test]
    fn a_password_mention_without_a_value_is_kept() {
        assert_eq!(redact_task_text("password"), "password");
        assert_eq!(redact_task_text("the token is fine"), "the token is fine");
    }

    #[test]
    fn urls_lose_credentials_and_query() {
        assert_eq!(
            redact_task_text("see https://user:pw@host/path?q=1#f"),
            "see https://host/path"
        );
    }

    #[test]
    fn an_unparseable_url_collapses() {
        assert_eq!(redact_task_text("http://"), "[url]");
    }

    #[test]
    fn long_text_is_capped() {
        let long = "a".repeat(2500);
        assert_eq!(redact_task_text(&long).chars().count(), 2000);
    }
}
