//! Agent configuration (`web/agent_config.js`).
//!
//! Endpoint security classification, the HTTP-header codec, the provider list,
//! reasoning levels, and the strict config validator. Plain HTTP sends the API
//! key and serial logs in cleartext, so a non-loopback `http:` endpoint is
//! flagged so the UI can ask for consent before a credential is stored.

/// A shared key-value storage seam (`localStorage` upstream, any map here).
pub trait Storage {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&mut self, key: &str, value: &str);
    fn remove(&mut self, key: &str);
}

pub const AGENT_CONFIG_KEY: &str = "linkr-agent-model";

/// What a plain `http:` endpoint exposes: the key only when it is not loopback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndpointSecurity {
    pub plaintext: bool,
    pub loopback: bool,
    pub exposes_key: bool,
}

/// Classify an endpoint URL. A local model server over loopback never leaves
/// the machine, so it stays a normal configuration; anything else over plain
/// HTTP exposes the credential.
pub fn endpoint_security(endpoint: &str) -> EndpointSecurity {
    // A URL parse that can fail returns the safe "nothing exposed" shape.
    let Some((protocol, hostname)) = parse_url_parts(endpoint) else {
        return EndpointSecurity {
            plaintext: false,
            loopback: false,
            exposes_key: false,
        };
    };
    let host = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let loopback = host == "localhost"
        || host == "::1"
        || host.ends_with(".localhost")
        || is_loopback_v4(&host);
    let plaintext = protocol == "http";
    EndpointSecurity {
        plaintext,
        loopback,
        exposes_key: plaintext && !loopback,
    }
}

/// Whether a lower-case host is an IPv4 address in `127.0.0.0/8`.
///
/// A bare `127.` prefix is not enough: `127.evil.com` is a name that merely
/// starts with the same digits, and a name can resolve anywhere — which is the
/// one thing a loopback endpoint cannot do. The all-numeric spellings a
/// resolver reads as `127.0.0.1` (`127.1`, `127.0.0.1`) are all accepted.
fn is_loopback_v4(host: &str) -> bool {
    let Some(rest) = host.strip_prefix("127.") else {
        return false;
    };
    rest.split('.')
        .all(|octet| !octet.is_empty() && octet.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Split a URL into `(protocol, hostname)` without pulling in a URL parser.
/// Returns `None` when the string is not a plausible `http(s)://host` URL.
fn parse_url_parts(endpoint: &str) -> Option<(String, String)> {
    let rest = endpoint
        .strip_prefix("http://")
        .or_else(|| endpoint.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let hostname = authority.split('@').next_back()?; // drop userinfo if present
    let hostname = strip_port(hostname);
    if hostname.is_empty() {
        return None;
    }
    Some((
        if endpoint.starts_with("https://") {
            "https"
        } else {
            "http"
        }
        .to_string(),
        hostname.to_string(),
    ))
}

pub const AGENT_HEADER_LIMIT: usize = 8;

/// Drop a trailing `:port`, but keep a bracketed IPv6 host intact.
fn strip_port(authority: &str) -> &str {
    if authority.starts_with('[') {
        match authority.find(']') {
            Some(close) => &authority[..=close],
            None => authority,
        }
    } else {
        match authority.find(':') {
            Some(i) => &authority[..i],
            None => authority,
        }
    }
}

/// Parse `Name: value` lines into a header map. Names and values are restricted
/// so a stored record cannot inject a new line into the HTTP request.
pub fn parse_agent_headers(text: &str) -> Result<Vec<(String, String)>, &'static str> {
    let mut headers: Vec<(String, String)> = Vec::new();
    let lines: Vec<&str> = text
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() > AGENT_HEADER_LIMIT {
        return Err("bad header");
    }
    for line in lines {
        let separator = line.find(':').ok_or("bad header")?;
        if separator == 0 {
            return Err("bad header");
        }
        let name = line[..separator].trim();
        let value = line[separator + 1..].trim();
        if !valid_header_name(name)
            || value.is_empty()
            || value.len() > 256
            || value.chars().any(|c| c.is_control())
        {
            return Err("bad header");
        }
        // A duplicate name keeps the last value, matching the object assignment.
        headers.retain(|(n, _)| n != name);
        headers.push((name.to_string(), value.to_string()));
    }
    Ok(headers)
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Serialise a header map back to `Name: value` lines, in insertion order.
pub fn format_agent_headers(headers: &[(String, String)]) -> String {
    headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A provider's identity and its bilingual display strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProvider {
    pub id: &'static str,
    pub label_zh: &'static str,
    pub label_en: &'static str,
    pub hint_zh: &'static str,
    pub hint_en: &'static str,
}

impl AgentProvider {
    /// The name the settings window shows for this protocol.
    pub fn label(&self, lang: crate::i18n::Lang) -> &'static str {
        match lang {
            crate::i18n::Lang::Zh => self.label_zh,
            crate::i18n::Lang::En => self.label_en,
        }
    }
}

/// The protocol ids, spelled once.
///
/// The provider list, the validator and the transport all read these, so a
/// rename cannot leave the request builder speaking a protocol the settings
/// form no longer offers — which would be a mismatch no test of either half
/// alone could see.
pub const OPENAI_COMPLETIONS: &str = "openai-completions";
pub const ANTHROPIC_MESSAGES: &str = "anthropic-messages";
pub const GOOGLE_GENERATIVE_AI: &str = "google-generative-ai";

pub const AGENT_PROVIDERS: [AgentProvider; 3] = [
    AgentProvider {
        id: OPENAI_COMPLETIONS,
        label_zh: "OpenAI 兼容接口",
        label_en: "OpenAI-compatible API",
        hint_zh: "适用于提供 /chat/completions 的服务，例如 OpenAI、DeepSeek、Ollama、vLLM",
        hint_en: "For services exposing /chat/completions, such as OpenAI, DeepSeek, Ollama or vLLM",
    },
    AgentProvider {
        id: ANTHROPIC_MESSAGES,
        label_zh: "Anthropic Messages 接口",
        label_en: "Anthropic Messages API",
        hint_zh: "适用于提供 /v1/messages 的服务，例如 https://api.anthropic.com/v1",
        hint_en: "For services exposing /v1/messages, such as https://api.anthropic.com/v1",
    },
    AgentProvider {
        id: GOOGLE_GENERATIVE_AI,
        label_zh: "Google Gemini 接口",
        label_en: "Google Generative AI",
        hint_zh: "适用于提供 generateContent 的服务，例如 https://generativelanguage.googleapis.com/v1beta",
        hint_en: "For services exposing generateContent, such as https://generativelanguage.googleapis.com/v1beta",
    },
];

/// Ascending thinking budget. `off` leaves reasoning options out of the request.
pub const AGENT_REASONING_LEVELS: [&str; 4] = ["off", "low", "medium", "high"];

/// The provider record an id names, or the default's.
pub fn provider_for(id: &str) -> &'static AgentProvider {
    AGENT_PROVIDERS
        .iter()
        .find(|provider| provider.id == id)
        .unwrap_or(&AGENT_PROVIDERS[0])
}

/// The provider a stored (or hand-edited) id names, or the first one.
///
/// A store can be edited by hand and a future version can drop a protocol, so
/// an id that names nothing lands on the built-in default rather than on a
/// value the request builder would then have to guess about.
pub fn provider_or_default(id: &str) -> &'static str {
    provider_for(id).id
}

/// The same for a reasoning level: a stored value naming no level reads `off`,
/// which is the one level that adds nothing to a request.
pub fn reasoning_or_default(level: &str) -> &'static str {
    AGENT_REASONING_LEVELS
        .iter()
        .find(|candidate| **candidate == level)
        .copied()
        .unwrap_or(AGENT_REASONING_LEVELS[0])
}

/// The word for a reasoning level, in the interface language.
pub fn reasoning_label(level: &str, lang: crate::i18n::Lang) -> &'static str {
    let s = lang.strings();
    match level {
        "low" => s.agent_reasoning_low,
        "medium" => s.agent_reasoning_medium,
        "high" => s.agent_reasoning_high,
        _ => s.agent_reasoning_off,
    }
}

pub const AGENT_DEFAULT_CONTEXT_WINDOW: i64 = 32768;
pub const AGENT_DEFAULT_MAX_TOKENS: i64 = 4096;

/// What the assistant costs before any conversation is sent: the system prompt
/// plus every tool description. A window below this cannot hold a request.
pub const AGENT_FIXED_CONTEXT_TOKENS: i64 = 8000;

/// The smallest context window that can carry the fixed part plus the output
/// plus a little history and framing.
pub fn minimum_useful_context_window(max_tokens: i64) -> i64 {
    let output = if max_tokens > 0 {
        max_tokens
    } else {
        AGENT_DEFAULT_MAX_TOKENS
    };
    AGENT_FIXED_CONTEXT_TOKENS + output + 512
}

/// `0` means "use the built-in default", so it is never tight. Only an explicit
/// window is judged.
pub fn is_context_window_tight(context_window: i64, max_tokens: i64) -> bool {
    if context_window <= 0 {
        return false;
    }
    context_window < minimum_useful_context_window(max_tokens)
}

/// A fully validated, normalised agent configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    pub headers: Vec<(String, String)>,
    pub provider: &'static str,
    pub reasoning: &'static str,
    pub context_window: i64,
    pub max_tokens: i64,
}

impl AgentConfig {
    /// The output ceiling that actually goes out.
    ///
    /// `0` is this program's spelling of "let the built-in default decide" (the
    /// upstream web build sends `maxTokens || 4096`), but a provider reads the
    /// literal field and the range it accepts starts at 1 — DeepSeek answers a
    /// zero with `Invalid max_tokens value, the valid range of max_tokens is
    /// [1, 393216]` and every question fails.
    pub fn output_ceiling(&self) -> i64 {
        if self.max_tokens > 0 {
            self.max_tokens
        } else {
            AGENT_DEFAULT_MAX_TOKENS
        }
    }

    /// The context window the budget is calculated from.
    ///
    /// The same spelling of "default" as the ceiling: an unset window is the
    /// built-in one rather than an unknown, which is what the web build hands
    /// its own budget function.
    pub fn effective_context_window(&self) -> i64 {
        if self.context_window > 0 {
            self.context_window
        } else {
            AGENT_DEFAULT_CONTEXT_WINDOW
        }
    }
}

/// Validate a config and normalise it. Field-specific errors are reported by
/// name, matching the upstream `throw new Error(field)`.
pub fn validate_agent_config(input: &AgentConfigInput) -> Result<AgentConfig, String> {
    // endpoint: http(s), no userinfo, no query, no fragment.
    let endpoint = input.endpoint.trim();
    let (protocol, hostname) = parse_url_parts(endpoint).ok_or_else(|| "endpoint".to_string())?;
    let _ = protocol;
    // Reject userinfo / query / fragment by checking the raw string shape.
    let rest = endpoint
        .strip_prefix("http://")
        .or_else(|| endpoint.strip_prefix("https://"))
        .ok_or_else(|| "endpoint".to_string())?;
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err("endpoint".to_string());
    }
    if hostname.is_empty() {
        return Err("endpoint".to_string());
    }

    if input.model.trim().is_empty() {
        return Err("model".to_string());
    }

    // headers
    let mut normalized_headers: Vec<(String, String)> = Vec::new();
    if input.headers.len() > AGENT_HEADER_LIMIT {
        return Err("headers".to_string());
    }
    for (name, value) in &input.headers {
        if !valid_header_name(name)
            || value.is_empty()
            || value.len() > 256
            || value.chars().any(|c| c.is_control())
        {
            return Err("headers".to_string());
        }
        normalized_headers.retain(|(n, _)| n != name);
        normalized_headers.push((name.clone(), value.clone()));
    }

    if !AGENT_PROVIDERS.iter().any(|p| p.id == input.provider) {
        return Err("provider".to_string());
    }
    if !AGENT_REASONING_LEVELS.contains(&input.reasoning) {
        return Err("reasoning".to_string());
    }

    Ok(AgentConfig {
        endpoint: endpoint.trim_end_matches('/').to_string(),
        model: input.model.trim().to_string(),
        api_key: input.api_key.clone(),
        headers: normalized_headers,
        provider: input.provider,
        reasoning: input.reasoning,
        context_window: validate_range(input.context_window, "contextWindow", (1000, 2_000_000))?,
        max_tokens: validate_range(input.max_tokens, "maxTokens", (1, 100_000))?,
    })
}

fn validate_range(value: i64, field: &str, (min, max): (i64, i64)) -> Result<i64, String> {
    if value != 0 && !(min..=max).contains(&value) {
        return Err(field.to_string());
    }
    Ok(value)
}

/// The unvalidated input shape, mirroring the upstream `{...}` argument.
#[derive(Debug, Clone, Default)]
pub struct AgentConfigInput {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    pub headers: Vec<(String, String)>,
    pub provider: &'static str,
    pub reasoning: &'static str,
    pub context_window: i64,
    pub max_tokens: i64,
}

impl AgentConfigInput {
    /// A blank input, with the provider and reasoning already at their defaults.
    pub fn new() -> Self {
        AgentConfigInput {
            provider: AGENT_PROVIDERS[0].id,
            reasoning: AGENT_REASONING_LEVELS[0],
            ..AgentConfigInput::default()
        }
    }
}

/// A request that never reached the model arrives as an opaque transport
/// error. Both the SDK's `APIConnectionError` name and the common message
/// phrasings are recognised, because the fix is browser-side, not model-side.
pub fn is_endpoint_unreachable(error_name: &str, message: &str) -> bool {
    if error_name == "APIConnectionError" {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    [
        "failed to fetch",
        "fetch failed",
        "networkerror",
        "load failed",
        "network request failed",
        "connection error",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_non_loopback_exposes_the_key() {
        let s = endpoint_security("http://10.0.0.5:8080/v1");
        assert!(s.plaintext);
        assert!(!s.loopback);
        assert!(s.exposes_key);
    }

    #[test]
    fn loopback_plaintext_does_not_expose_the_key() {
        for host in [
            "http://localhost:8080",
            "http://127.0.0.1:11434",
            "http://[::1]:8080",
        ] {
            let s = endpoint_security(host);
            assert!(s.plaintext, "{host}");
            assert!(s.loopback, "{host}");
            assert!(!s.exposes_key, "{host}");
        }
    }

    #[test]
    fn a_name_that_only_starts_with_127_is_not_loopback() {
        // `127.evil.com` is a name a resolver can point anywhere; only an
        // address that never leaves the machine counts as loopback.
        for host in ["http://127.evil.com:8080", "http://127.0.0.1.evil.com"] {
            let s = endpoint_security(host);
            assert!(!s.loopback, "{host}");
            assert!(s.exposes_key, "{host}");
        }
        for host in [
            "http://127.0.0.1:11434",
            "http://127.1:8080",
            "http://127.0.0.2/",
        ] {
            let s = endpoint_security(host);
            assert!(s.loopback, "{host}");
            assert!(!s.exposes_key, "{host}");
        }
    }

    #[test]
    fn https_is_never_plaintext() {
        let s = endpoint_security("https://api.example.com/v1");
        assert!(!s.plaintext);
        assert!(!s.exposes_key);
    }

    #[test]
    fn an_unparseable_endpoint_is_safe_by_default() {
        let s = endpoint_security("not a url");
        assert!(!s.exposes_key);
    }

    #[test]
    fn headers_round_trip() {
        let headers = parse_agent_headers("Authorization: Bearer x\nX-Target: rk3588").unwrap();
        assert_eq!(headers.len(), 2);
        assert_eq!(
            headers[0],
            ("Authorization".to_string(), "Bearer x".to_string())
        );
        assert_eq!(
            format_agent_headers(&headers),
            "Authorization: Bearer x\nX-Target: rk3588"
        );
    }

    #[test]
    fn headers_reject_control_characters_and_blank_names() {
        assert!(parse_agent_headers("Bad: has\u{0}control").is_err());
        assert!(parse_agent_headers(": no name").is_err());
        assert!(parse_agent_headers("no-colon-here").is_err());
    }

    #[test]
    fn headers_reject_more_than_the_limit() {
        let many = (0..9)
            .map(|i| format!("X-H{i}: v"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(parse_agent_headers(&many).is_err());
    }

    #[test]
    fn a_valid_config_normalises_the_endpoint_trailing_slash() {
        let cfg = validate_agent_config(&AgentConfigInput {
            endpoint: "https://api.example.com/v1/".to_string(),
            model: " model-x ".to_string(),
            provider: "anthropic-messages",
            reasoning: "off",
            ..AgentConfigInput::default()
        })
        .unwrap();
        assert_eq!(cfg.endpoint, "https://api.example.com/v1");
        assert_eq!(cfg.model, "model-x");
    }

    #[test]
    fn a_config_with_userinfo_query_or_fragment_is_refused() {
        for bad in ["https://u:p@h/v1", "https://h/v1?q=1", "https://h/v1#frag"] {
            assert_eq!(
                validate_agent_config(&AgentConfigInput {
                    endpoint: bad.to_string(),
                    model: "m".to_string(),
                    ..AgentConfigInput::default()
                }),
                Err("endpoint".to_string())
            );
        }
    }

    #[test]
    fn an_unknown_provider_or_reasoning_is_refused() {
        let base = AgentConfigInput::new();
        let base = AgentConfigInput {
            endpoint: "https://h/v1".to_string(),
            model: "m".to_string(),
            ..base
        };
        assert_eq!(
            validate_agent_config(&AgentConfigInput {
                provider: "nope",
                ..base.clone()
            }),
            Err("provider".to_string())
        );
        assert_eq!(
            validate_agent_config(&AgentConfigInput {
                reasoning: "nope",
                ..base.clone()
            }),
            Err("reasoning".to_string())
        );
    }

    #[test]
    fn context_window_tightness_tracks_the_floor() {
        assert!(!is_context_window_tight(0, 0));
        assert!(!is_context_window_tight(
            minimum_useful_context_window(0),
            0
        ));
        assert!(is_context_window_tight(1000, 0));
    }
}

/// The keys the agent configuration is stored under, and where.
///
/// Separate keys rather than one blob, because the store is a key-value shelf
/// and a form that edits one field should not have to parse and rewrite the
/// rest to do it. The API key has its own for the same reason and one more:
/// the key is the field most likely to be rotated alone.
///
/// The four protocol keys joined the four address keys when the form stopped
/// being one protocol's. They are stored as written rather than as parsed, for
/// the same reason the address fields are: a half-typed window is not a broken
/// configuration and a load must hand back exactly what a save took.
const KEY_ENDPOINT: &str = "linkr-agent-model:endpoint";
const KEY_MODEL: &str = "linkr-agent-model:model";
const KEY_API_KEY: &str = "linkr-agent-model:key";
const KEY_HEADERS: &str = "linkr-agent-model:headers";
const KEY_PROVIDER: &str = "linkr-agent-model:provider";
const KEY_REASONING: &str = "linkr-agent-model:reasoning";
const KEY_CONTEXT_WINDOW: &str = "linkr-agent-model:context-window";
const KEY_MAX_TOKENS: &str = "linkr-agent-model:max-tokens";

/// The form's contents, as the view keeps them.
///
/// Not `AgentConfigInput` and not `AgentConfig`: this is what a half-typed form
/// looks like, so a load hands back exactly what a save took rather than
/// something already validated. The validation belongs to the Enter key that
/// saves it, not to a reader that would then fail on its own data.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredAgentConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    /// Extra headers, one `Name: Value` per line — [`format_agent_headers`]'s
    /// own output, so a round trip is the same function backwards.
    pub headers: String,
    /// The protocol id, as `AGENT_PROVIDERS` spells it. Blanks and unknown ids
    /// read as the default at load.
    pub provider: String,
    /// One of `AGENT_REASONING_LEVELS`.
    pub reasoning: String,
    /// The context window and the output ceiling as typed. Empty means "the
    /// built-in default", which is the same meaning `0` has once parsed.
    pub context_window: String,
    pub max_tokens: String,
}

/// Write the fields. A blank field is written as blank rather than removed, so
/// "the user cleared the model" and "there is no model yet" are the same thing
/// and a load cannot tell them apart by accident.
pub fn save_agent_config<S: Storage>(storage: &mut S, config: &StoredAgentConfig) {
    storage.set(KEY_ENDPOINT, &config.endpoint);
    storage.set(KEY_MODEL, &config.model);
    storage.set(KEY_API_KEY, &config.api_key);
    storage.set(KEY_HEADERS, &config.headers);
    storage.set(KEY_PROVIDER, &config.provider);
    storage.set(KEY_REASONING, &config.reasoning);
    storage.set(KEY_CONTEXT_WINDOW, &config.context_window);
    storage.set(KEY_MAX_TOKENS, &config.max_tokens);
}

/// Read them back. A store with nothing in it gives a blank form, which is the
/// same shape the view starts with.
///
/// The protocol and the reasoning level are the two fields that are always
/// *something*: a select paints a value whether or not one was ever chosen, so
/// a blank or unknown store entry resolves to the default here rather than
/// leaving the window painting an empty row the user cannot select back to.
pub fn load_agent_config<S: Storage>(storage: &S) -> StoredAgentConfig {
    let chosen = |key: &str| storage.get(key).unwrap_or_default();
    StoredAgentConfig {
        endpoint: chosen(KEY_ENDPOINT),
        model: chosen(KEY_MODEL),
        api_key: chosen(KEY_API_KEY),
        headers: chosen(KEY_HEADERS),
        provider: provider_or_default(&chosen(KEY_PROVIDER)).to_string(),
        reasoning: reasoning_or_default(&chosen(KEY_REASONING)).to_string(),
        context_window: chosen(KEY_CONTEXT_WINDOW),
        max_tokens: chosen(KEY_MAX_TOKENS),
    }
}

#[cfg(test)]
mod store_tests {
    use super::super::store::JsonFile;
    use super::*;

    /// A saved configuration is read back exactly, which is the whole point of
    /// having a load: without it the view asks for an endpoint it already has.
    #[test]
    fn a_saved_config_is_read_back() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-cfg-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut store = JsonFile::at(&path);
            save_agent_config(
                &mut store,
                &StoredAgentConfig {
                    endpoint: "http://localhost:8080/v1".into(),
                    model: "llama-3".into(),
                    api_key: "sk-x".into(),
                    headers: "X-A: 1".into(),
                    provider: "anthropic-messages".into(),
                    reasoning: "medium".into(),
                    context_window: "16000".into(),
                    max_tokens: "2048".into(),
                },
            );
        }
        let loaded = load_agent_config(&JsonFile::at(&path));
        assert_eq!(loaded.endpoint, "http://localhost:8080/v1");
        assert_eq!(loaded.model, "llama-3");
        assert_eq!(loaded.api_key, "sk-x");
        assert_eq!(loaded.headers, "X-A: 1");
        assert_eq!(loaded.provider, "anthropic-messages");
        assert_eq!(loaded.reasoning, "medium");
        assert_eq!(loaded.context_window, "16000");
        assert_eq!(loaded.max_tokens, "2048");
        let _ = std::fs::remove_file(&path);
    }

    /// A store with nothing in it gives a blank form, not an error: the view
    /// opens on an empty configuration and that is the designed first frame.
    /// The two selects are the exception — a select paints a value whatever the
    /// store holds.
    #[test]
    fn an_empty_store_is_a_blank_form() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-cfg-empty-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let loaded = load_agent_config(&JsonFile::at(&path));
        assert_eq!(
            loaded,
            StoredAgentConfig {
                provider: AGENT_PROVIDERS[0].id.to_string(),
                reasoning: AGENT_REASONING_LEVELS[0].to_string(),
                ..StoredAgentConfig::default()
            }
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A stored id that names nothing — a hand-edited file, or a protocol a
    /// later version dropped — reads as the default rather than as a value the
    /// request builder would then have to guess about.
    #[test]
    fn an_unknown_protocol_reads_as_the_default() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-cfg-unknown-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut store = JsonFile::at(&path);
            store.set("linkr-agent-model:provider", "carrier-pigeon");
            store.set("linkr-agent-model:reasoning", "maximum");
        }
        let loaded = load_agent_config(&JsonFile::at(&path));
        assert_eq!(loaded.provider, AGENT_PROVIDERS[0].id);
        assert_eq!(loaded.reasoning, AGENT_REASONING_LEVELS[0]);
        let _ = std::fs::remove_file(&path);
    }

    /// A blank field stays blank rather than becoming a value, so a load cannot
    /// turn "cleared the key" into "still has the old key".
    #[test]
    fn a_blank_field_stays_blank() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-cfg-blank-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut store = JsonFile::at(&path);
            save_agent_config(&mut store, &StoredAgentConfig::default());
        }
        let loaded = load_agent_config(&JsonFile::at(&path));
        assert!(loaded.api_key.is_empty());
        assert!(loaded.model.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
