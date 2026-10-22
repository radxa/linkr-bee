//! The LLM transport — the one part of the agent this crate did not carry.
//!
//! Until now a prompt was a thing the view recorded and nothing ever answered.
//! This is the answer: a streamed round trip over `reqwest` with rustls, in the
//! three wire protocols [`crate::agent::config`] lists — OpenAI-compatible
//! `/chat/completions` (OpenAI, DeepSeek, Ollama, vLLM and most gateways),
//! Anthropic `/v1/messages`, and Google `generateContent`.
//!
//! The protocol is a property of the request, not of the transport: one job
//! carries the configuration it was asked for, and the URL, the headers, the
//! body and the reading of the stream are chosen from `provider` at the one
//! place each is built. Three protocols in one file rather than three
//! transports, because everything around the difference — the runtime, the
//! channel, the redaction of a key from an error body, the UTF-8 that straddles
//! two chunks — is the same work done once.
//!
//! # Why it looks like a transport
//!
//! The three links this crate already has — BLE, LAN, and the board's own
//! serial port — each build their own multi-thread Tokio runtime on a thread of
//! their own and hand bytes back to the interface over a channel, rather than
//! making the whole program async. That is not an accident of history; it is
//! why a frame is a pure function and the event loop can be read top to bottom.
//! This transport is the fourth of the same shape, and `chat()` is synchronous
//! from the caller's side because the caller is a synchronous TUI.
//!
//! The dependency is the one honest cost. `reqwest` with `rustls` pulls
//! `aws-lc-rs`, which builds a C library; the crate was zero-dependency for
//! good reasons and now is not. What the alternative buys is a transport that
//! can only speak plain `http://`, which for a real provider means the API key
//! crosses the network in the clear — so the dependency was the cheaper of the
//! two.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use futures::StreamExt;

use crate::agent::config::AgentConfig;
use crate::agent::usage::Usage;

/// One message in a conversation. The role is a fixed set because the API has
/// exactly three, and a `String` role would let a caller invent a fourth the
/// provider rejects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Who said it, in the API's own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    /// The spelling the wire uses.
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }
}

/// One step of an answer arriving.
///
/// A model streams its reply as a series of deltas and then a final message with
/// the token counts, so the transport reports progress rather than one value.
/// The distinction matters because a reply being typed out on screen is a
/// partial one and must never be mistaken for a finished one: `Done` is what
/// moves the task from "asking" to "answered", and nothing else may.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    /// More of the reply, in order.
    Delta(String),
    /// The reply is complete, with whatever accounting the provider sent.
    Done(Usage),
    /// The reply is over and there is no answer.
    Failed(Failure),
}

/// A reply keeps its task identity even if its worker exits without sending.
#[derive(Debug)]
pub struct PendingReply {
    pub task_id: String,
    pub receiver: Receiver<(String, Progress)>,
}

impl PendingReply {
    pub fn new(task_id: impl Into<String>, receiver: Receiver<(String, Progress)>) -> Self {
        Self {
            task_id: task_id.into(),
            receiver,
        }
    }
}

/// What came back, when it came back at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    /// The reply text, with the provider's escapes resolved.
    pub text: String,
    /// Token accounting, when the provider reported it.
    pub usage: Usage,
}

/// Why there is no completion.
///
/// Two of these carry provider text, and both are redacted on the way out: a
/// provider that echoes the request back into its error body would otherwise
/// put the API key in the log, and a log is where credentials end up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The request was made and nothing answered: DNS, TCP, TLS, or a stall.
    Unreachable(String),
    /// The provider answered and refused, with its own words.
    Rejected(u16, String),
    /// The provider answered 200 but the body held no completion.
    Malformed,
}

impl Failure {
    /// One sentence for the interface, with the provider's own wording kept when
    /// it has any. Not `Display`: this is classified text and a `Display` impl
    /// would let a caller print one as though it were a log line.
    ///
    /// The sentence is the interface's own language rather than this module's
    /// English: an assistant that answers nothing is the hardest thing in the
    /// program to diagnose, and the reason has to arrive in words its reader
    /// uses.
    pub fn describe(&self, lang: crate::i18n::Lang) -> String {
        let s = lang.strings();
        match self {
            Failure::Unreachable(why) => {
                crate::text::fill(s.asst_unreachable, std::slice::from_ref(why))
            }
            Failure::Rejected(status, body) => {
                // A refusal that came with no words is the one that leaves
                // nothing to act on — a mistyped endpoint arrives as an empty
                // 404 — so the sentence says what to check rather than ending
                // in a colon.
                let body = if body.trim().is_empty() {
                    s.asst_rejected_blank.to_string()
                } else {
                    body.clone()
                };
                crate::text::fill(s.asst_rejected, &[status.to_string(), body])
            }
            Failure::Malformed => s.asst_malformed.to_string(),
        }
    }
}

/// A conversation sent to the model, and where its answer goes.
struct Job {
    config: AgentConfig,
    messages: Vec<ChatMessage>,
    reply: Option<Sender<(String, Progress)>>,
    /// The task this answers, so a reply can be matched to the goal it belongs
    /// to when it arrives out of order.
    task_id: String,
}

/// The transport. One of these lives in [`crate::app::App`] and is the only
/// thing that talks to a provider.
pub struct AgentClient {
    jobs: Sender<Job>,
}

/// `App` derives `Debug`, so this is hand-written: a transport's job shows a
/// channel and nothing else anyone would want to read, and a derive would then
/// tie the field to a `Sender`'s own `Debug`, which is not stable.
impl std::fmt::Debug for AgentClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AgentClient(1 job channel)")
    }
}

/// The first-use constructor: a thread and a runtime are what starting a
/// transport costs, which is why `App` holds `None` rather than `default()`
/// and only the send path calls this. A test suite that builds hundreds of
/// frames starts no transport at all.
impl Default for AgentClient {
    fn default() -> Self {
        AgentClient::spawn()
    }
}

impl AgentClient {
    /// Start the transport's own thread, with its own runtime.
    ///
    /// A runtime per transport rather than one shared with the BLE link, because
    /// two reactors on one process is what the existing transports do and a
    /// shared one would couple an LLM stall to a serial link dropping.
    pub fn spawn() -> AgentClient {
        let (tx, rx) = mpsc::channel::<Job>();
        thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                // No runtime means no transport, and the thread has nowhere to
                // report it: every pending job's reply channel is simply never
                // answered, which the caller's timeout turns into an
                // `Unreachable` rather than a hang.
                Err(_) => {
                    for job in rx.iter() {
                        drop(job);
                    }
                    return;
                }
            };
            while let Ok(mut job) = rx.recv() {
                // The reply channel is moved out first, because the stream sends
                // through it as it goes rather than once at the end.
                let reply = job.reply.take();
                runtime.block_on(send_stream(&job, reply));
            }
        });
        AgentClient { jobs: tx }
    }

    /// Ask the model and wait for the whole answer.
    ///
    /// The streaming path, collected. There is no second non-streaming request:
    /// a provider that answers in one message is a stream of one, and two code
    /// paths to the same wire would be two places for the parsing to drift.
    pub fn chat(
        &self,
        task_id: &str,
        config: AgentConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<Completion, Failure> {
        let (tx, rx) = mpsc::channel();
        let job = Job {
            config,
            messages,
            reply: Some(tx),
            task_id: task_id.to_string(),
        };
        if self.jobs.send(job).is_err() {
            return Err(Failure::Unreachable("the transport stopped".to_string()));
        }
        let mut text = String::new();
        loop {
            match rx.recv_timeout(timeout) {
                Ok((_, Progress::Delta(part))) => text.push_str(&part),
                Ok((_, Progress::Done(reported))) => {
                    return Ok(Completion {
                        text,
                        usage: reported,
                    })
                }
                Ok((_, Progress::Failed(failure))) => return Err(failure),
                Err(_) => return Err(Failure::Unreachable("the model took too long".to_string())),
            }
        }
    }

    /// Ask without waiting: the worker answers into a channel the interface
    /// drains on its own beat, which is what keeps a slow model from freezing
    /// the terminal.
    ///
    /// Returns the reply channel, or `None` when the transport is not running.
    pub fn submit(
        &self,
        task_id: &str,
        config: AgentConfig,
        messages: Vec<ChatMessage>,
    ) -> Option<Receiver<(String, Progress)>> {
        let (tx, rx) = mpsc::channel();
        let job = Job {
            config,
            messages,
            reply: Some(tx),
            task_id: task_id.to_string(),
        };
        self.jobs.send(job).ok()?;
        Some(rx)
    }
}

/// One round trip, streamed, reporting as it goes.
///
/// The body asks for a stream and the provider answers with a series of `data:`
/// lines separated by blank ones — server-sent events. What each event means is
/// the protocol's: OpenAI-compatible deltas of `choices[0].delta.content`
/// followed by a usage report, Anthropic `content_block_delta` events with the
/// bill split between `message_start` and `message_delta`, Google candidates
/// whose parts carry the text and a running `usageMetadata`.
///
/// A provider that does not stream still answers with one event, and the
/// readers below take the single-message shape as well: the reply arrives whole
/// and the same code path reads it.
async fn send_stream(job: &Job, reply: Option<Sender<(String, Progress)>>) {
    let key = job.config.api_key.clone();
    let provider = job.config.provider;
    let url = endpoint_url(&job.config);

    let mut request = client_for()
        .post(&url)
        .header("content-type", "application/json")
        // Accept SSE, because a provider that supports both will otherwise
        // answer with JSON and the deltas would never arrive.
        .header("accept", "text/event-stream")
        .body(request_body(&job.config, &job.messages, true));
    request = authorize(request, &job.config);
    for (name, value) in &job.config.headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(why) => {
            send(
                &reply,
                &job.task_id,
                Progress::Failed(Failure::Unreachable(redact(&why.to_string(), &key))),
            );
            return;
        }
    };
    let status = response.status().as_u16();
    if status != 200 {
        // Read the body whatever the status: a provider's reason for refusing is
        // the one thing worth showing, and it is redacted on the way out.
        let body = response.text().await.unwrap_or_default();
        send(
            &reply,
            &job.task_id,
            Progress::Failed(Failure::Rejected(status, redact(&body, &key))),
        );
        return;
    }

    let is_json = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| {
            value.trim().eq_ignore_ascii_case("application/json") || value.trim().ends_with("+json")
        });
    if is_json {
        match response.text().await {
            Ok(body) => match whole_text(provider, &body) {
                Some(text)
                    if !text.is_empty()
                        && field(&body, "error").is_none_or(|error| error.trim() == "null") =>
                {
                    send(&reply, &job.task_id, Progress::Delta(text));
                    send(
                        &reply,
                        &job.task_id,
                        Progress::Done(usage_of(provider, &body).unwrap_or_default()),
                    );
                }
                _ => send(&reply, &job.task_id, Progress::Failed(Failure::Malformed)),
            },
            Err(why) => send(
                &reply,
                &job.task_id,
                Progress::Failed(Failure::Unreachable(redact(&why.to_string(), &key))),
            ),
        }
        return;
    }

    let mut stream = response.bytes_stream();
    // A partial line survives across chunks: an SSE event is not obliged to
    // arrive in one TCP segment, and cutting the buffer at the chunk boundary
    // would split `data: {...}` in half and lose the event.
    let mut buffer = String::new();
    // Bytes of a character that straddles two chunks: a delta is UTF-8 on the
    // wire, and the unfinished tail waits here for the rest of itself.
    let mut carry: Vec<u8> = Vec::new();
    // Whether any text was ever reported. A 200 whose body carried no
    // completion is not a reply, and the difference between it and an empty one
    // is worth keeping.
    let mut saw_text = false;
    let mut usage = Usage::default();
    let mut finished = false;
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(why) => {
                send(
                    &reply,
                    &job.task_id,
                    Progress::Failed(Failure::Unreachable(redact(&why.to_string(), &key))),
                );
                return;
            }
        };
        carry.extend_from_slice(&bytes);
        let decoded = decode_utf8(&mut carry);
        if decoded.is_empty() {
            continue;
        }
        buffer.push_str(&decoded);
        // Every event in the chunk is read, and any text it holds is sent as
        // one delta: a chunk is a unit of what arrived, and one delta per chunk
        // is what the interface renders on.
        let batch = read_events(provider, &mut buffer, &mut usage);
        if let Some(error) = batch.error {
            send(
                &reply,
                &job.task_id,
                Progress::Failed(Failure::Unreachable(redact(&error, &key))),
            );
            return;
        }
        finished |= batch.finished;
        if !batch.text.is_empty() {
            saw_text = true;
            send(&reply, &job.task_id, Progress::Delta(batch.text));
        }
        if batch.done {
            break;
        }
    }
    if !saw_text || !finished {
        // Neither an empty body nor EOF midway through a reply is a completed
        // answer. Only a protocol end marker or finish reason proves that.
        send(&reply, &job.task_id, Progress::Failed(Failure::Malformed));
        return;
    }
    send(&reply, &job.task_id, Progress::Done(usage));
}

/// Push one step into the reply channel, if there is one.
///
/// A job with no channel is a job nobody asked to watch — `chat()` takes the
/// channel for itself — and a send that fails means the interface stopped
/// listening, which is not a transport error.
fn send(reply: &Option<Sender<(String, Progress)>>, task_id: &str, step: Progress) {
    if let Some(reply) = reply {
        let _ = reply.send((task_id.to_string(), step));
    }
}

/// The client, with the timeout the whole request has to fit in, and any proxy
/// the environment names.
///
/// A machine that can only reach the model through a proxy has no other way
/// out, and reqwest's own system-proxy support is not built into this binary —
/// so `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` (either case) are read here,
/// with `NO_PROXY` handed to reqwest as the bypass list. A proxy reqwest
/// cannot parse is skipped rather than made fatal: a typo in a variable is not
/// a reason for the assistant to stop working, and the request will say what
/// happened if it was the only way out.
fn client_for() -> reqwest::Client {
    let mut builder = reqwest::Client::builder().timeout(REQUEST_TIMEOUT);
    if let Some(proxy) = proxy_from_env() {
        builder = builder.proxy(proxy);
    }
    // A client per answer, because the timeout is part of the request and a
    // shared one would have to be built before the first caller knew its
    // budget. The connection pool is the cost, and an interactive assistant
    // asks one question at a time in practice.
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// The proxy the environment names, if any.
///
/// `HTTPS_PROXY` is looked at first because that is the variable every provider
/// in the list is reached through, then `ALL_PROXY`, then `HTTP_PROXY` — the
/// order curl documents. The `NO_PROXY` list is parsed by reqwest rather than
/// here, because bypassing is its own rules about domains, ports and CIDRs.
fn proxy_from_env() -> Option<reqwest::Proxy> {
    proxy_from(|name| std::env::var(name).ok())
}

/// The variables that name a proxy, in the order they are read.
const PROXY_VARS: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
];

/// The same choice, taken from a lookup rather than the process environment, so
/// the order and the skipping are testable without touching globals.
///
/// A variable set to nothing, or to something reqwest cannot parse, is passed
/// over rather than made fatal: a typo in one of six names is not a reason for
/// the assistant to stop working, and the request will say what happened if
/// that was the only way out.
fn proxy_from(mut lookup: impl FnMut(&str) -> Option<String>) -> Option<reqwest::Proxy> {
    let mut proxy = PROXY_VARS
        .iter()
        .filter_map(|name| lookup(name))
        .find_map(|url| reqwest::Proxy::all(url.trim()).ok())?;
    if let Some(no_proxy) = reqwest::NoProxy::from_env() {
        proxy = proxy.no_proxy(Some(no_proxy));
    }
    Some(proxy)
}

/// The payload of one SSE frame, or `None` when the frame carries none.
///
/// A frame is what the blank-line separator bounded, and it can hold more than
/// the `data:` line: Anthropic's stream sends `event: content_block_delta`
/// first, and a reader that required the frame to *begin* with `data:` read the
/// whole protocol as silence — the request went out, the provider answered, and
/// the panel said the answer held nothing. Several `data:` lines in one frame
/// are one payload separated by newlines, which is what the encoding says they
/// meant.
fn data_of(frame: &str) -> Option<String> {
    let mut payload: Option<String> = None;
    for line in frame.lines() {
        let Some(line) = line.strip_prefix("data:") else {
            continue;
        };
        match payload.as_mut() {
            Some(payload) => {
                payload.push('\n');
                payload.push_str(line);
            }
            None => payload = Some(line.to_string()),
        }
    }
    payload
}

/// Read every complete SSE event in `buffer`, leaving the unfinished tail
/// behind, and return the text they carried.
///
/// A chunk is not an event: one chunk can hold several events, and one event
/// can span several chunks. Reading the batch one event at a time without
/// joining them is how two events in one chunk came out as a single line of
/// mangled JSON — which parsed as nothing, and the reply went with it.
#[derive(Default, Debug)]
struct EventBatch {
    text: String,
    /// An end marker closes the response without waiting for HTTP EOF.
    done: bool,
    /// A finish reason also permits EOF, after any final usage event.
    finished: bool,
    error: Option<String>,
}

fn read_events(provider: &str, buffer: &mut String, usage: &mut Usage) -> EventBatch {
    let mut batch = EventBatch::default();
    while let Some((event, rest)) = next_event(buffer) {
        *buffer = rest;
        let Some(payload) = data_of(&event) else {
            continue;
        };
        let payload = payload.trim();
        if payload == "[DONE]" {
            batch.done = true;
            batch.finished = true;
            buffer.clear();
            break;
        }
        if let Some(error) = field(payload, "error").filter(|value| value.trim() != "null") {
            batch.error = Some(error.to_string());
            break;
        }
        match provider {
            crate::agent::config::ANTHROPIC_MESSAGES => {
                batch.done =
                    field(payload, "type").and_then(unquote).as_deref() == Some("message_stop");
                batch.finished |= batch.done;
            }
            crate::agent::config::GOOGLE_GENERATIVE_AI => {
                batch.done = field(payload, "candidates")
                    .and_then(first_element)
                    .and_then(|candidate| field(candidate, "finishReason"))
                    .and_then(unquote)
                    .is_some_and(|reason| !reason.is_empty());
                batch.finished |= batch.done;
            }
            _ => {
                if let Some(choice) = field(payload, "choices").and_then(first_element) {
                    batch.finished |= field(choice, "finish_reason")
                        .and_then(unquote)
                        .is_some_and(|reason| !reason.is_empty())
                        || field(choice, "message").is_some();
                }
            }
        }
        // Text and usage are read from the same event, not one *or* the
        // other: several providers — every gateway that reports the bill in
        // its last delta rather than in an event of its own — put the usage
        // object beside the final slice of the reply, and an event that was
        // read for its tokens alone would drop the words it came with.
        if let Some(delta) = text_of(provider, payload) {
            batch.text.push_str(&delta);
        }
        if let Some(reported) = usage_of(provider, payload) {
            if provider == crate::agent::config::ANTHROPIC_MESSAGES
                || provider == crate::agent::config::GOOGLE_GENERATIVE_AI
            {
                // These two protocols bill in pieces, and a piece is not the
                // whole bill: Anthropic sends the input count in
                // `message_start` and the finished output count in
                // `message_delta`, Gemini sends a running total on every chunk.
                // Replacing the total with each piece would throw the other
                // half away, so a counter that was not reported leaves the one
                // already read standing.
                if reported.input > 0 {
                    usage.input = reported.input;
                }
                if reported.output > 0 {
                    usage.output = reported.output;
                }
                if reported.total_tokens > 0 {
                    usage.total_tokens = reported.total_tokens;
                }
            } else {
                *usage = reported;
            }
        }
        if batch.done {
            buffer.clear();
            break;
        }
    }
    batch
}

#[cfg(test)]
fn drain_events(provider: &str, buffer: &mut String, usage: &mut Usage) -> String {
    read_events(provider, buffer, usage).text
}

/// The complete JSON shapes used when a gateway does not stream.
fn whole_text(provider: &str, body: &str) -> Option<String> {
    if provider != crate::agent::config::ANTHROPIC_MESSAGES {
        return text_of(provider, body);
    }
    let mut text = String::new();
    for block in array_elements(field(body, "content")?) {
        if field(block, "type").and_then(unquote).as_deref() == Some("text") {
            text.push_str(&unquote(field(block, "text")?)?);
        }
    }
    Some(text)
}

/// Decode the valid UTF-8 prefix of `bytes`, holding an unfinished character
/// back for the next call.
///
/// A delta may split a multi-byte character across two chunks, and the half
/// that arrives is not the character. Decoded lossily, one `你` becomes two
/// replacement characters — visible in the reply, and wrong in whatever the
/// interface stores from it. Decoded here, it arrives whole one chunk later.
fn decode_utf8(bytes: &mut Vec<u8>) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let text = text.to_string();
            bytes.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            // Only the last character is incomplete: decode what is whole and
            // keep the rest for the next chunk.
            let whole = std::str::from_utf8(&bytes[..error.valid_up_to()])
                .expect("valid_up_to is a character boundary")
                .to_string();
            bytes.drain(..error.valid_up_to());
            whole
        }
        Err(_) => {
            // Genuinely invalid bytes: replacement characters are the honest
            // reading, and the character the provider meant to send never
            // existed.
            let text = String::from_utf8_lossy(bytes).into_owned();
            bytes.clear();
            text
        }
    }
}

/// The next complete SSE event in `buffer`, and what is left after it.
///
/// `\n\n` is the separator, and a lone `\r\n\r\n` is what some gateways send —
/// so the search is for the longest run of blank-line separators and the event
/// is everything before it.
fn next_event(buffer: &str) -> Option<(String, String)> {
    if let Some((at, separator)) = ["\r\n\r\n", "\n\n"]
        .into_iter()
        .filter_map(|separator| buffer.find(separator).map(|at| (at, separator)))
        .min_by_key(|(at, _)| *at)
    {
        let (event, rest) = buffer.split_at(at);
        let event = event.trim_end_matches('\r').to_string();
        let rest = rest[separator.len()..].to_string();
        return Some((event, rest));
    }
    None
}

/// The text one stream event carries, if it carries any.
fn text_of(provider: &str, event: &str) -> Option<String> {
    match provider {
        crate::agent::config::ANTHROPIC_MESSAGES => anthropic_text(event),
        crate::agent::config::GOOGLE_GENERATIVE_AI => google_text(event),
        _ => completions_text(event),
    }
}

/// The text one `/chat/completions` event carries, if it carries any.
///
/// Two shapes reach here and both are real: a delta during the answer
/// (`choices[0].delta.content`), and a provider that answers in one message
/// (`choices[0].message.content`). Reading the delta first is not a preference —
/// a provider that sends both sends the message only once, at the end, and
/// reading the message on every event would repeat the whole reply.
fn completions_text(event: &str) -> Option<String> {
    let choices = field(event, "choices")?;
    let first = first_element(choices)?;
    if let Some(delta) = field(first, "delta") {
        if let Some(content) = field(delta, "content") {
            return unquote(content);
        }
    }
    let message = field(first, "message")?;
    unquote(field(message, "content")?)
}

/// The text one Messages event carries: a `text_delta` and nothing else.
///
/// `content_block_delta` is not always the answer. A model asked to think
/// streams `thinking_delta` events through the same field, and painting those
/// would put the model's working into the reply — where the panel would show it
/// as the assistant's own words and the session would store it as an answer.
/// The type is checked rather than the text being read blind.
///
/// A `content_block_start` carries an empty text block and a `message_stop`
/// carries none: both read as nothing here.
fn anthropic_text(event: &str) -> Option<String> {
    let delta = field(event, "delta")?;
    if unquote(field(delta, "type")?).as_deref() != Some("text_delta") {
        return None;
    }
    unquote(field(delta, "text")?)
}

/// The text one Gemini chunk carries: every part of the first candidate that
/// the model did not mark as a thought.
///
/// Parts arrive split for no reason the reader is told — a chunk can hold the
/// first half of a sentence in one and the rest in the next — so they are
/// joined rather than taking the first. `thought: true` is Gemini's spelling of
/// the same private working Anthropic streams as `thinking_delta`, and is
/// skipped for the same reason.
fn google_text(event: &str) -> Option<String> {
    let candidates = field(event, "candidates")?;
    let first = first_element(candidates)?;
    let content = field(first, "content")?;
    let parts = field(content, "parts")?;
    let mut out = String::new();
    for part in array_elements(parts) {
        if field(part, "thought").is_some_and(|raw| raw.trim() == "true") {
            continue;
        }
        if let Some(text) = field(part, "text").and_then(unquote) {
            out.push_str(&text);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The token accounting a stream event carries, if it carries one.
fn usage_of(provider: &str, event: &str) -> Option<Usage> {
    match provider {
        crate::agent::config::ANTHROPIC_MESSAGES => anthropic_usage(event),
        crate::agent::config::GOOGLE_GENERATIVE_AI => google_usage(event),
        _ => completions_usage(event),
    }
}

/// The bill in one `/chat/completions` event.
fn completions_usage(event: &str) -> Option<Usage> {
    let usage = field(event, "usage")?;
    // A provider that was not asked for its accounting still spells the key —
    // OpenAI sends `"usage":null` on every chunk — and reading that as a
    // report would overwrite the real one with zeros.
    let usage = usage.trim();
    if usage.is_empty() || usage == "null" {
        return None;
    }
    Some(parse_usage(usage))
}

/// The bill in one Messages event.
///
/// Two events carry it: `message_start` puts the input count (and the first
/// output count) inside `message.usage`, and `message_delta` carries the final
/// output count in a `usage` of its own. Both are named here because both are
/// real, and neither is complete.
fn anthropic_usage(event: &str) -> Option<Usage> {
    let usage = field(event, "message")
        .and_then(|message| field(message, "usage"))
        .or_else(|| field(event, "usage"))?;
    if usage.trim() == "null" {
        return None;
    }
    Some(Usage {
        input: number_in(usage, "input_tokens"),
        output: number_in(usage, "output_tokens"),
        total_tokens: number_in(usage, "total_tokens"),
        ..Usage::default()
    })
}

/// The bill in one Gemini chunk, under Gemini's own names.
fn google_usage(event: &str) -> Option<Usage> {
    let usage = field(event, "usageMetadata")?;
    Some(Usage {
        input: number_in(usage, "promptTokenCount"),
        output: number_in(usage, "candidatesTokenCount"),
        total_tokens: number_in(usage, "totalTokenCount"),
        ..Usage::default()
    })
}

/// The chat-completions URL. A trailing slash is stripped rather than
/// appended to, because `…/v1//chat/completions` is a 404 on some gateways and
/// `…/v1/chat/completions` is right on all of them.
///
/// An endpoint that already names the path is left alone. Providers document
/// the full URL as often as the base one, and a user who pastes what the docs
/// said would otherwise be sent to `…/chat/completions/chat/completions` — a
/// 404 with no body to explain it.
fn chat_url(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    format!("{base}/chat/completions")
}

/// The URL one request goes to: the protocol's own path on the configured
/// endpoint.
fn endpoint_url(config: &AgentConfig) -> String {
    match config.provider {
        crate::agent::config::ANTHROPIC_MESSAGES => messages_url(&config.endpoint),
        crate::agent::config::GOOGLE_GENERATIVE_AI => {
            generate_content_url(&config.endpoint, &config.model)
        }
        _ => chat_url(&config.endpoint),
    }
}

/// The Messages URL, completed to `/v1/messages` unless the endpoint already
/// says where it is.
///
/// The same rule as `chat_url`, with one more spelling to get right: the
/// official API's base already carries the version (`https://api.anthropic.com/v1`,
/// which is what the settings hint tells users to paste), so `/v1` is not
/// appended to it a second time. An endpoint that names the version itself
/// (`…/anthropic`, the shape DeepSeek documents) gets the version added, and
/// one that names the whole path is left exactly as it is.
fn messages_url(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.ends_with("/messages") {
        return base.to_string();
    }
    if base.ends_with("/v1") {
        return format!("{base}/messages");
    }
    format!("{base}/v1/messages")
}

/// The Gemini streaming URL: `…/models/<model>:streamGenerateContent?alt=sse`.
///
/// The model is part of the path rather than of the body, and `alt=sse` is what
/// makes the answer a stream: without it the SDK-shaped endpoint answers with
/// one buffered JSON array instead of the `data:` lines this reader knows.
fn generate_content_url(endpoint: &str, model: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.contains(":streamGenerateContent") {
        return base.to_string();
    }
    format!("{base}/models/{model}:streamGenerateContent?alt=sse")
}

/// Add the protocol's own headers, the credential among them.
///
/// The credential is not always `Authorization: Bearer`: Anthropic's API takes
/// `x-api-key` and Gemini's takes `x-goog-api-key`, and a request that sends
/// the key in the wrong header is refused with a message about the key — which
/// sends the user looking at a key that was never wrong.
///
/// `anthropic-version` is a protocol header rather than an auth one and is sent
/// even when no key is configured: an endpoint that speaks the protocol without
/// a key still needs to be told which version of it is being spoken.
fn authorize(request: reqwest::RequestBuilder, config: &AgentConfig) -> reqwest::RequestBuilder {
    let request = match config.provider {
        crate::agent::config::ANTHROPIC_MESSAGES => {
            request.header("anthropic-version", "2023-06-01")
        }
        _ => request,
    };
    let key = config.api_key.trim();
    if key.is_empty() {
        return request;
    }
    match config.provider {
        crate::agent::config::ANTHROPIC_MESSAGES => request.header("x-api-key", key),
        crate::agent::config::GOOGLE_GENERATIVE_AI => request.header("x-goog-api-key", key),
        _ => request.header("authorization", format!("Bearer {key}")),
    }
}

/// The request body, written by hand.
///
/// No `serde_json`: the request has a handful of fields, and a dependency that
/// serialises a struct with `#[derive]` to save a page of `format!` is a
/// dependency that then has to be taught about the response too. A function
/// per protocol rather than one function with three sets of branches, because
/// the protocols disagree about where the system prompt goes, what the
/// assistant's role is called, and whether streaming is in the URL or the body.
fn request_body(config: &AgentConfig, messages: &[ChatMessage], stream: bool) -> String {
    match config.provider {
        crate::agent::config::ANTHROPIC_MESSAGES => anthropic_body(config, messages, stream),
        crate::agent::config::GOOGLE_GENERATIVE_AI => google_body(config, messages),
        _ => completions_body(config, messages, stream),
    }
}

/// The OpenAI-compatible body.
fn completions_body(config: &AgentConfig, messages: &[ChatMessage], stream: bool) -> String {
    let mut out = String::from("{\"model\":");
    out.push_str(&crate::agent::tasks::json_string(&config.model));
    out.push_str(",\"messages\":[");
    for (i, message) in messages.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"role\":");
        out.push_str(&crate::agent::tasks::json_string(message.role.as_str()));
        out.push_str(",\"content\":");
        out.push_str(&crate::agent::tasks::json_string(&message.content));
        out.push('}');
    }
    out.push_str("],\"max_tokens\":");
    out.push_str(&max_tokens(config).to_string());
    // The reasoning level goes out under the name this protocol gave it. `off`
    // adds nothing at all, which is the default and what the web build does for
    // the custom endpoints this protocol is used with: a server that does not
    // know the field is a server that answers a 400, and one that does know it
    // has been told nothing about how much thinking the user wants.
    if let Some(level) = effort_level(config.reasoning) {
        out.push_str(",\"reasoning_effort\":");
        out.push_str(&crate::agent::tasks::json_string(level));
    }
    if stream {
        // `stream` on its own is enough for the deltas; `stream_options` is what
        // asks for the token counts in a final event, because the default is
        // that a streaming reply reports no usage at all — which would leave the
        // accounting permanently at zero for every question asked this way.
        out.push_str(",\"stream\":true");
        out.push_str(",\"stream_options\":{\"include_usage\":true}");
    }
    out.push('}');
    out
}

/// The Anthropic Messages body.
///
/// The differences from the OpenAI shape are all in this one function: the
/// system prompt is a field of its own rather than a message, `max_tokens` is
/// mandatory rather than optional, and a thinking model is asked for its budget
/// rather than for an effort word.
fn anthropic_body(config: &AgentConfig, messages: &[ChatMessage], stream: bool) -> String {
    let (system, turns) = split_system(messages);
    let ceiling = max_tokens(config);
    let mut out = String::from("{\"model\":");
    out.push_str(&crate::agent::tasks::json_string(&config.model));
    out.push_str(",\"max_tokens\":");
    out.push_str(&ceiling.to_string());
    if !system.is_empty() {
        out.push_str(",\"system\":");
        out.push_str(&crate::agent::tasks::json_string(&system));
    }
    out.push_str(",\"messages\":[");
    for (i, message) in turns.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"role\":");
        out.push_str(&crate::agent::tasks::json_string(message.role.as_str()));
        out.push_str(",\"content\":");
        out.push_str(&crate::agent::tasks::json_string(&message.content));
        out.push('}');
    }
    out.push(']');
    // A budget, not a word: this protocol asks in tokens. The request is
    // refused rather than downgraded when the budget cannot keep its promised
    // room for the answer, so a ceiling too small to think in sends no thinking
    // field at all — a plain answer beats a guaranteed 400.
    if let Some(budget) = thinking_budget(config.reasoning, ceiling) {
        out.push_str(",\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":");
        out.push_str(&budget.to_string());
        out.push('}');
    }
    if stream {
        out.push_str(",\"stream\":true");
    }
    out.push('}');
    out
}

/// The Gemini body.
///
/// Streaming is not a field here — it is `:streamGenerateContent` in the URL —
/// so this function takes no `stream` argument. The assistant's role is spelled
/// `model`, the system prompt is `systemInstruction`, and the whole bill of
/// settings lives under `generationConfig`.
fn google_body(config: &AgentConfig, messages: &[ChatMessage]) -> String {
    let (system, turns) = split_system(messages);
    let ceiling = max_tokens(config);
    let mut out = String::from("{\"contents\":[");
    for (i, message) in turns.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"role\":");
        let role = match message.role {
            ChatRole::Assistant => "model",
            _ => "user",
        };
        out.push_str(&crate::agent::tasks::json_string(role));
        out.push_str(",\"parts\":[{\"text\":");
        out.push_str(&crate::agent::tasks::json_string(&message.content));
        out.push_str("}]}");
    }
    out.push(']');
    if !system.is_empty() {
        out.push_str(",\"systemInstruction\":{\"parts\":[{\"text\":");
        out.push_str(&crate::agent::tasks::json_string(&system));
        out.push_str("}]}");
    }
    out.push_str(",\"generationConfig\":{\"maxOutputTokens\":");
    out.push_str(&ceiling.to_string());
    if let Some(budget) = thinking_budget(config.reasoning, ceiling) {
        // `includeThoughts` is what makes the model show its working at all;
        // the budget is the cap. Both are asked for, and the reply reader skips
        // the thought parts — the count is what the level was for.
        out.push_str(",\"thinkingConfig\":{\"includeThoughts\":true,\"thinkingBudget\":");
        out.push_str(&budget.to_string());
        out.push('}');
    }
    out.push_str("}}");
    out
}

/// The conversation split into its system prompt and its turns.
///
/// Two of the three protocols carry the system prompt in a field of its own
/// rather than as a message with a `system` role, and a request that sends it
/// as a message is refused by name. Several system messages are joined rather
/// than all but the first dropped: this crate writes one, and a caller that
/// wrote two meant both.
fn split_system(messages: &[ChatMessage]) -> (String, Vec<&ChatMessage>) {
    let mut system: Vec<&str> = Vec::new();
    let mut turns: Vec<&ChatMessage> = Vec::new();
    for message in messages {
        match message.role {
            ChatRole::System => system.push(&message.content),
            _ => turns.push(message),
        }
    }
    (system.join("\n\n"), turns)
}

/// The output ceiling that actually goes out (see [`AgentConfig::output_ceiling`]).
fn max_tokens(config: &AgentConfig) -> i64 {
    config.output_ceiling()
}

/// The output of an answer that is spent thinking before a word is written.
const MIN_ANSWER_TOKENS: i64 = 1024;

/// The effort word, when the user asked for reasoning at all.
///
/// `off` is the default and sends nothing: a model that was not asked to think
/// is not being told to think cheaply.
fn effort_level(level: &str) -> Option<&str> {
    match level {
        "low" | "medium" | "high" => Some(level),
        _ => None,
    }
}

/// The thinking budget a level asks for, in tokens.
///
/// The numbers are the upstream adapter's own — low, medium and high are 2k,
/// 8k and 16k — and the budget never eats the last kilotoken of the answer,
/// because a model that spends its whole output allowance thinking has no room
/// left to say anything. A ceiling with no room at all leaves `None`, and the
/// caller sends no thinking field: thinking past the answer's own limit is a
/// request the provider refuses.
fn thinking_budget(level: &str, max_tokens: i64) -> Option<i64> {
    let base = match level {
        "low" => 2048,
        "medium" => 8192,
        "high" => 16384,
        _ => return None,
    };
    let budget = base.min((max_tokens - MIN_ANSWER_TOKENS).max(0));
    (budget > 0).then_some(budget)
}

// ---------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------

/// Pull the completion out of a 200 response.
///
/// The reader walks the object rather than deserialising one, because that is
/// what the crate already does for its own stored JSON and a second parser for
/// the same format in the same binary is a second place for the bugs to live.
/// It is deliberately tolerant of what the response adds and strict about what
/// the completion needs: an unknown field is skipped, a missing one is the end
/// of the read.
pub fn parse_completion(text: &str) -> Option<Completion> {
    let choices = field(text, "choices")?;
    let first = first_element(choices)?;
    let message = field(first, "message")?;
    let content = field(message, "content")?;
    let text_out = unquote(content)?;

    let usage = field(text, "usage").map(parse_usage).unwrap_or_default();
    Some(Completion {
        text: text_out,
        usage,
    })
}

/// The token accounting from an OpenAI-compatible report. A missing or
/// non-numeric field reads as zero rather than as an error: a provider that
/// reports usage for some models and not others must not make the reply
/// unusable.
fn parse_usage(object: &str) -> Usage {
    Usage {
        input: number_in(object, "prompt_tokens"),
        output: number_in(object, "completion_tokens"),
        total_tokens: number_in(object, "total_tokens"),
        ..Usage::default()
    }
}

/// One numeric field of a JSON object, or zero.
fn number_in(object: &str, key: &str) -> u64 {
    field(object, key)
        .and_then(|raw| raw.trim().parse().ok())
        .unwrap_or(0)
}

/// The value of `key` in a flat JSON object, as a raw span.
///
/// Walks the object rather than searching for `"key":`, because a value that
/// *contains* `"key":` — a system prompt quoting the wire format, a file whose
/// contents are JSON — would otherwise match itself.
fn field<'a>(object: &'a str, key: &str) -> Option<&'a str> {
    let inner = object.trim().strip_prefix('{')?.strip_suffix('}')?;
    let bytes = inner.as_bytes();
    let mut i = skip_ws(bytes, 0);
    while i < bytes.len() {
        if bytes[i] != b'"' {
            return None;
        }
        let (key_span, after_key) = value_span(inner, i)?;
        if unquote(key_span)?.as_str() != key {
            i = skip_ws(bytes, after_key);
            if bytes.get(i) != Some(&b':') {
                return None;
            }
            // Skip this value and move to the next pair.
            let (_, after_value) = value_span(inner, skip_ws(bytes, i + 1))?;
            i = skip_ws(bytes, after_value);
            if bytes.get(i) == Some(&b',') {
                i = skip_ws(bytes, i + 1);
                continue;
            }
            return None;
        }
        i = skip_ws(bytes, after_key);
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        let (value, _) = value_span(inner, skip_ws(bytes, i + 1))?;
        return Some(value);
    }
    None
}

/// The first element of a JSON array, as a raw span.
fn first_element(array: &str) -> Option<&str> {
    array_elements(array).into_iter().next()
}

/// Every element of a JSON array, as raw spans.
///
/// The reader that needs more than the first: Gemini splits an answer across
/// `parts` without telling the reader how many there are, so each has to be
/// visited rather than the first taken and the rest assumed empty.
fn array_elements(array: &str) -> Vec<&str> {
    let mut elements = Vec::new();
    let Some(inner) = array
        .trim()
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
    else {
        return elements;
    };
    let bytes = inner.as_bytes();
    let mut at = skip_ws(bytes, 0);
    while at < bytes.len() {
        let Some((span, next)) = value_span(inner, at) else {
            break;
        };
        elements.push(span);
        at = skip_ws(bytes, next);
        if bytes.get(at) != Some(&b',') {
            break;
        }
        at = skip_ws(bytes, at + 1);
    }
    elements
}

/// The span of the JSON value starting at `at`, and the index after it.
///
/// The one place in this file that understands JSON's grammar, so the readers
/// above can be about the fields they want.
fn value_span(s: &str, at: usize) -> Option<(&str, usize)> {
    let bytes = s.as_bytes();
    if at >= bytes.len() {
        return None;
    }
    match bytes[at] {
        b'"' => {
            let mut i = at + 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' => i += 2,
                    b'"' => return Some((&s[at..i + 1], i + 1)),
                    _ => i += 1,
                }
            }
            None
        }
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut in_string = false;
            let mut i = at;
            while i < bytes.len() {
                let byte = bytes[i];
                if in_string {
                    match byte {
                        b'\\' => i += 2,
                        b'"' => {
                            in_string = false;
                            i += 1;
                        }
                        _ => i += 1,
                    }
                    continue;
                }
                match byte {
                    b'"' => {
                        in_string = true;
                        i += 1;
                    }
                    b'{' | b'[' => {
                        depth += 1;
                        i += 1;
                    }
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some((&s[at..i + 1], i + 1));
                        }
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            None
        }
        _ => {
            // A number, `true`, `false` or `null`: everything up to what ends it.
            let mut i = at;
            while i < bytes.len()
                && !matches!(bytes[i], b',' | b'}' | b']')
                && !bytes[i].is_ascii_whitespace()
            {
                i += 1;
            }
            (i > at).then(|| (&s[at..i], i))
        }
    }
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

/// Resolve a JSON string literal into text, `\uXXXX` and all.
///
/// `agent::tasks::parse_json_string_literal` gets close but leaves an unknown
/// escape as `\` plus its letter, which turns a provider's `\u003c` into six
/// characters of soup in the middle of a reply. The escape set is small and
/// closed, so it is written out rather than extended by trial.
fn unquote(literal: &str) -> Option<String> {
    let literal = literal.trim();
    let body = literal.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next()? {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'u' => {
                let mut code = 0u32;
                for _ in 0..4 {
                    let digit = chars.next()?.to_digit(16)?;
                    code = code * 16 + digit;
                }
                // A surrogate pair arrives as two escapes and is one character;
                // an unpaired one is not a character at all.
                if (0xd800..0xdc00).contains(&code) {
                    if chars.next() != Some('\\') || chars.next() != Some('u') {
                        out.push('\u{fffd}');
                        continue;
                    }
                    let mut low = 0u32;
                    for _ in 0..4 {
                        low = low * 16 + chars.next()?.to_digit(16)?;
                    }
                    // The escape after a high surrogate has to be a low one.
                    // Anything else is a lone surrogate, and subtracting the
                    // low range's start from a value below it would wrap — a
                    // provider typo is a replacement character, not a panic.
                    if !(0xdc00..0xe000).contains(&low) {
                        out.push('\u{fffd}');
                        continue;
                    }
                    match char::from_u32(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)) {
                        Some(paired) => out.push(paired),
                        None => out.push('\u{fffd}'),
                    }
                } else {
                    out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                }
            }
            other => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    Some(out)
}

/// Remove a secret from anything that is about to be printed.
///
/// Provider error bodies quote the request, and the request carries the key in
/// an `authorization` header. A transport that logged its own errors verbatim
/// would be a transport that puts a credential in the interface's log.
fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    text.replace(key, "[redacted]")
}

/// The per-request ceiling.
///
/// Generous enough for a model thinking over a long system prompt, bounded
/// enough that the interface cannot be left waiting. The caller's own timeout
/// is the one the user feels; this one is what actually closes the socket.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::config::{ANTHROPIC_MESSAGES, GOOGLE_GENERATIVE_AI, OPENAI_COMPLETIONS};
    use crate::i18n::Lang;

    fn config(endpoint: &str) -> AgentConfig {
        AgentConfig {
            endpoint: endpoint.to_string(),
            model: "m".to_string(),
            api_key: String::new(),
            headers: Vec::new(),
            provider: crate::agent::config::OPENAI_COMPLETIONS,
            reasoning: "off",
            context_window: 8192,
            max_tokens: 1024,
        }
    }

    /// A trailing slash is the difference between a working endpoint and a 404,
    /// and users type it without thinking. An endpoint that already carries
    /// `/chat/completions` — which is how several providers document it — is
    /// not asked for the path twice.
    #[test]
    fn the_url_survives_a_trailing_slash() {
        assert_eq!(chat_url("http://x/v1/"), "http://x/v1/chat/completions");
        assert_eq!(chat_url("http://x/v1"), "http://x/v1/chat/completions");
        assert_eq!(chat_url(" http://x/v1 "), "http://x/v1/chat/completions");
        assert_eq!(
            chat_url("http://x/v1/chat/completions"),
            "http://x/v1/chat/completions"
        );
        assert_eq!(
            chat_url("http://x/chat/completions/"),
            "http://x/chat/completions"
        );
    }

    /// The body is valid JSON by construction and carries what a provider needs.
    #[test]
    fn the_body_carries_the_conversation() {
        let body = request_body(
            &config("http://x/v1"),
            &[
                ChatMessage {
                    role: ChatRole::System,
                    content: "you are brief".to_string(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: "hi\nthere".to_string(),
                },
            ],
            false,
        );
        // A request is not a reply: reading one back yields nothing, which is
        // the failure a caller would otherwise take for an empty answer.
        assert!(parse_completion(&body).is_none());
        assert!(body.contains("\"model\":\"m\""));
        assert!(body.contains("\"role\":\"system\""));
        assert!(body.contains("\"role\":\"user\""));
        // A newline in the content is escaped, not raw: raw is invalid JSON.
        assert!(body.contains("hi\\nthere"));
        assert!(!body.contains("hi\n\nthere"), "the newline was written raw");
    }

    /// A stored zero is this program's "the built-in default decides", and it
    /// has to become that default before it leaves: a provider reads the
    /// literal field, its range starts at 1, and DeepSeek answers a zero with
    /// `Invalid max_tokens value` — every question, every time.
    #[test]
    fn a_zero_ceiling_becomes_the_built_in_default() {
        let mut cfg = config("http://x/v1");
        cfg.max_tokens = 0;
        let body = request_body(
            &cfg,
            &[ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            }],
            false,
        );
        assert!(
            body.contains(&format!(
                "\"max_tokens\":{}",
                crate::agent::config::AGENT_DEFAULT_MAX_TOKENS
            )),
            "{body}"
        );
        assert!(!body.contains("\"max_tokens\":0"), "{body}");

        // A ceiling the user set is sent as it stands.
        let mut cfg = config("http://x/v1");
        cfg.max_tokens = 512;
        let body = request_body(
            &cfg,
            &[ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            }],
            false,
        );
        assert!(body.contains("\"max_tokens\":512"), "{body}");
    }

    /// A refusal that came with no words says what to check — an empty 404 is
    /// the shape a mistyped endpoint arrives in — and the provider's own words
    /// are kept when there are any.
    #[test]
    fn an_empty_refusal_says_what_to_check() {
        for lang in [Lang::Zh, Lang::En] {
            let said = Failure::Rejected(404, String::new()).describe(lang);
            assert!(said.contains("404"), "{said}");
            assert!(said.contains(lang.strings().asst_rejected_blank), "{said}");
            let said = Failure::Rejected(503, "upstream is down".into()).describe(lang);
            assert!(said.contains("upstream is down"), "{said}");
            assert!(!said.contains(lang.strings().asst_rejected_blank), "{said}");
        }
    }

    /// A reply whose text contains the shape of another reply must not be read
    /// as that other reply. This is the bug a `contains("\"content\":")` search
    /// would have.
    #[test]
    fn a_reply_quoting_the_wire_format_is_read_itself() {
        let text = r#"{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"the reply says {\"role\":\"user\"} inside it"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}"#;
        let parsed = parse_completion(text).expect("parses");
        assert_eq!(parsed.text, "the reply says {\"role\":\"user\"} inside it");
        assert_eq!(parsed.usage.input, 3);
        assert_eq!(parsed.usage.output, 5);
        assert_eq!(parsed.usage.total_tokens, 0);
    }

    /// An empty choices array is a malformed reply, not a panic.
    #[test]
    fn an_empty_choices_array_is_not_a_completion() {
        let text = r#"{"choices":[],"usage":{}}"#;
        assert!(parse_completion(text).is_none());
    }

    /// A missing usage is zeroed rather than refused.
    #[test]
    fn a_missing_usage_is_zero() {
        let text = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
        let parsed = parse_completion(text).expect("parses");
        assert_eq!(parsed.text, "ok");
        assert_eq!(parsed.usage.input, 0);
    }

    /// Escapes a provider actually emits, including a surrogate pair and an
    /// emoji.
    #[test]
    fn unquote_resolves_what_providers_emit() {
        assert_eq!(unquote("\"a\\nb\"").as_deref(), Some("a\nb"));
        assert_eq!(unquote("\"a\\tb\"").as_deref(), Some("a\tb"));
        assert_eq!(unquote("\"\\u003cdiv\\u003e\"").as_deref(), Some("<div>"));
        assert_eq!(unquote("\"\\ud83d\\ude00\"").as_deref(), Some("\u{1f600}"));
        assert_eq!(unquote("\"no escapes\"").as_deref(), Some("no escapes"));
        assert_eq!(unquote("\"unterminated"), None);
    }

    /// A chunk can hold several events, and every one of them is read in
    /// order. Joined into a single line without separators, the mangled JSON
    /// parsed as nothing and the whole reply was lost.
    #[test]
    fn every_event_in_a_batch_is_read() {
        let mut buffer = String::from(
            "data: {\"choices\":[{\"delta\":{\"content\":\"one \"}}]}\n\
             \ndata: {\"choices\":[{\"delta\":{\"content\":\"two\"}}]}\n\n\
             data: [DONE]\n\n",
        );
        let mut usage = Usage::default();
        let text = drain_events(OPENAI_COMPLETIONS, &mut buffer, &mut usage);
        assert_eq!(text, "one two");
        assert!(buffer.is_empty(), "the whole batch was consumed");

        // And an event split across two chunks waits for its other half.
        let mut buffer = String::from("data: {\"choices\":[{\"delta\":{\"content\":\"hal");
        assert_eq!(
            drain_events(OPENAI_COMPLETIONS, &mut buffer, &mut usage),
            ""
        );
        buffer.push_str("f\"}}]}\n\n");
        assert_eq!(
            drain_events(OPENAI_COMPLETIONS, &mut buffer, &mut usage),
            "half"
        );
    }

    /// A character split across two chunks stays one character: decoded
    /// lossily it would arrive as two replacement characters, in the reply and
    /// in whatever the interface stores from it.
    #[test]
    fn a_character_split_across_chunks_is_joined() {
        let text = "温度";
        let bytes = text.as_bytes();
        let mut carry = bytes[..4].to_vec();
        assert_eq!(
            decode_utf8(&mut carry),
            "温",
            "the whole character came out"
        );
        carry.extend_from_slice(&bytes[4..]);
        assert_eq!(decode_utf8(&mut carry), "度");
        assert!(carry.is_empty(), "nothing was left over");
    }

    /// The environment is the only way out on a machine that can only reach the
    /// model through a proxy: the first variable naming a usable one is taken,
    /// a blank or unparsable one is passed over rather than made fatal, and no
    /// variable at all is no proxy rather than an error.
    #[test]
    fn the_proxy_comes_from_the_environment_in_order() {
        assert!(
            proxy_from(|_| None).is_none(),
            "no variable, no proxy — and no complaint"
        );

        let lowercase =
            |name: &str| (name == "all_proxy").then(|| "http://127.0.0.1:7890".to_string());
        assert!(proxy_from(lowercase).is_some(), "a lowercase name counts");

        let blank_then_good = |name: &str| match name {
            "HTTPS_PROXY" => Some("   ".to_string()),
            "http_proxy" => Some("http://127.0.0.1:7890".to_string()),
            _ => None,
        };
        assert!(
            proxy_from(blank_then_good).is_some(),
            "a variable set to nothing is not a proxy, and the next one is"
        );

        let garbage_then_good = |name: &str| match name {
            "HTTPS_PROXY" => Some("not a url".to_string()),
            "HTTP_PROXY" => Some("http://127.0.0.1:7890".to_string()),
            _ => None,
        };
        assert!(
            proxy_from(garbage_then_good).is_some(),
            "an unparsable variable is skipped rather than made fatal"
        );

        assert!(
            proxy_from(|_| Some("not a url".to_string())).is_none(),
            "nothing usable anywhere is no proxy"
        );
    }

    /// A failed turn is said in the interface's own words: the reason an
    /// assistant answered nothing is the hardest thing in the program to
    /// diagnose, and an English sentence under a Chinese interface is half of
    /// the reason.
    #[test]
    fn a_failure_is_said_in_the_interfaces_language() {
        let unreachable = Failure::Unreachable("connection refused".to_string());
        assert_eq!(
            unreachable.describe(Lang::En),
            "the model did not answer: connection refused"
        );
        assert_eq!(
            unreachable.describe(Lang::Zh),
            "模型没有应答：connection refused",
            "the provider's own wording is kept as it came"
        );

        let rejected = Failure::Rejected(503, "upstream is down".to_string());
        assert_eq!(
            rejected.describe(Lang::Zh),
            "服务商拒绝（HTTP 503）：upstream is down"
        );
        assert!(rejected
            .describe(Lang::En)
            .starts_with("the provider refused"));

        let malformed = Failure::Malformed;
        assert_eq!(
            malformed.describe(Lang::Zh),
            "服务商返回了正文，但里面没有回答"
        );
        assert_eq!(
            malformed.describe(Lang::En),
            "the provider answered, but its body held no reply"
        );
    }

    /// A secret never survives into something the interface would print.
    #[test]
    fn a_key_is_redacted_from_provider_text() {
        const KEY: &str = "sk-super-secret-key";
        let body = format!("{{\"error\":\"bad key {KEY}\"}}");
        let shown = redact(&body, KEY);
        assert!(!shown.contains(KEY), "the key was not redacted");
        assert!(shown.contains("[redacted]"));
        // And an empty key redacts nothing rather than mangling the text.
        assert_eq!(redact("plain", ""), "plain");
    }

    /// The timeout is what the user feels, and it is a real bound: a worker
    /// that never answers — the sender still in hand, the answer simply not
    /// coming — must not wedge the interface for ever.
    #[test]
    fn a_silent_job_times_out_rather_than_hanging() {
        let (tx, rx) = mpsc::channel::<Result<Completion, Failure>>();
        let started = std::time::Instant::now();
        let outcome = rx.recv_timeout(Duration::from_millis(20));
        assert_eq!(
            outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "a channel whose sender is alive must wait, not answer"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(20),
            "the wait was cut short: {:?}",
            started.elapsed()
        );
        drop(tx);
    }

    /// A worker whose thread has ended answers at once rather than waiting the
    /// timeout out: the closed channel *is* the answer.
    #[test]
    fn a_dropped_job_is_answered_at_once() {
        let (tx, rx) = mpsc::channel::<Result<Completion, Failure>>();
        drop(tx);
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        );
    }

    /// A stream event is only complete when its blank line has arrived, and a
    /// chunk can split one — cutting the buffer at the chunk boundary would
    /// lose the event.
    #[test]
    fn a_partial_event_is_kept_until_its_blank_line() {
        let mut buffer = "data: {\"choices\":[".to_string();
        assert!(
            next_event(&buffer).is_none(),
            "an incomplete event was read"
        );
        buffer.push_str("{\"finish_reason\":\"stop\"}]}\n\n");
        let (event, rest) = next_event(&buffer).expect("now complete");
        assert_eq!(event, "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}");
        assert!(rest.is_empty());
    }

    /// Both blank-line spellings, because gateways send either.
    #[test]
    fn both_blank_line_spellings_separate_events() {
        for separator in ["\n\n", "\r\n\r\n"] {
            let text = format!("data: one{separator}data: two{separator}");
            let (first, rest) = next_event(&text).expect("split");
            assert_eq!(first, "data: one", "{separator:?}");
            assert_eq!(rest, format!("data: two{separator}"));
        }
    }

    /// A delta is what arrives while the model writes.
    #[test]
    fn a_delta_is_what_arrives_mid_stream() {
        let event = r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}"#;
        assert_eq!(text_of(OPENAI_COMPLETIONS, event).as_deref(), Some("hel"));
    }

    /// The event that carries the bill carries words too, on every gateway that
    /// reports usage beside its last delta rather than in an event of its own:
    /// read for its tokens alone, the reply loses its ending — live, this was
    /// `hi there` arriving as `hi`.
    #[test]
    fn a_delta_and_its_usage_are_read_from_one_event() {
        let mut buffer = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n"
        )
        .to_string();
        let mut usage = Usage::default();
        let text = drain_events(OPENAI_COMPLETIONS, &mut buffer, &mut usage);
        assert_eq!(text, "hi there", "the last delta went with the usage");
        assert_eq!(usage.input, 3);
        assert_eq!(usage.output, 2);
    }

    /// `"usage":null` is a key with no report in it — OpenAI spells it that way
    /// when the accounting was not asked for — and reading it as a report would
    /// overwrite a real one with zeros.
    #[test]
    fn a_null_usage_is_not_a_report() {
        assert!(usage_of(OPENAI_COMPLETIONS, r#"{"choices":[],"usage":null}"#).is_none());
        assert!(usage_of(OPENAI_COMPLETIONS, r#"{"choices":[]}"#).is_none());
        let reported =
            usage_of(OPENAI_COMPLETIONS, r#"{"usage":{"prompt_tokens":5}}"#).expect("a report");
        assert_eq!(reported.input, 5);
    }

    /// A provider that answers in one message puts it in `message`, not `delta`.
    #[test]
    fn a_single_message_is_read_from_message() {
        let event = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}"#;
        assert_eq!(text_of(OPENAI_COMPLETIONS, event).as_deref(), Some("done"));
        let usage = usage_of(OPENAI_COMPLETIONS, event).expect("usage");
        assert_eq!(usage.input, 2);
        assert_eq!(usage.output, 3);
    }

    /// `[DONE]` is a sentinel with no JSON, and must not be read as a delta.
    #[test]
    fn the_done_sentinel_is_not_a_delta() {
        assert!(text_of(OPENAI_COMPLETIONS, "data: [DONE]").is_none());
    }

    /// The three protocols answer at three different paths, and an endpoint
    /// that already names the path it needs is not asked for it twice.
    #[test]
    fn each_protocol_answers_at_its_own_path() {
        // The Messages API: the official base already carries the version —
        // which is exactly what the settings hint tells users to paste — so it
        // is not appended a second time.
        assert_eq!(
            messages_url("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            messages_url("https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/anthropic/v1/messages",
            "a base without the version gets one"
        );
        assert_eq!(
            messages_url("https://api.anthropic.com/"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            messages_url("https://gateway/v1/messages"),
            "https://gateway/v1/messages"
        );

        // Gemini: the model and the streaming verb are both in the URL.
        assert_eq!(
            generate_content_url(
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-2.5-flash"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            generate_content_url(
                "https://gateway/v1beta/models/m:streamGenerateContent?alt=sse",
                "m"
            ),
            "https://gateway/v1beta/models/m:streamGenerateContent?alt=sse"
        );

        // And the choice is taken from the configured protocol, not guessed.
        let mut cfg = config("https://api.anthropic.com/v1");
        cfg.provider = ANTHROPIC_MESSAGES;
        assert!(endpoint_url(&cfg).ends_with("/v1/messages"), "{cfg:?}");
        let mut cfg = config("https://generativelanguage.googleapis.com/v1beta");
        cfg.provider = GOOGLE_GENERATIVE_AI;
        assert!(endpoint_url(&cfg).contains("/models/m:streamGenerateContent"));
    }

    /// The key rides in the header the protocol actually reads it from, and
    /// `anthropic-version` goes out even when there is no key: it is the
    /// protocol's header, not the credential's.
    #[test]
    fn the_key_rides_in_the_protocols_own_header() {
        let headers = |provider: &'static str| {
            let mut cfg = config("https://x/v1");
            cfg.provider = provider;
            cfg.api_key = "sk-test".to_string();
            let built = authorize(client_for().post("https://x/v1"), &cfg)
                .build()
                .expect("a built request");
            let read = |name: &str| {
                built
                    .headers()
                    .get(name)
                    .map(|value| value.to_str().unwrap().to_string())
            };
            (
                read("authorization"),
                read("x-api-key"),
                read("x-goog-api-key"),
                read("anthropic-version"),
            )
        };

        let openai = headers(OPENAI_COMPLETIONS);
        assert_eq!(openai.0.as_deref(), Some("Bearer sk-test"));

        let anthropic = headers(ANTHROPIC_MESSAGES);
        assert_eq!(anthropic.1.as_deref(), Some("sk-test"));
        assert_eq!(anthropic.3.as_deref(), Some("2023-06-01"));
        assert!(anthropic.0.is_none(), "a bearer header this API ignores");

        let google = headers(GOOGLE_GENERATIVE_AI);
        assert_eq!(google.2.as_deref(), Some("sk-test"));

        // Keyless: Anthropic still has to be told which version is spoken.
        let mut cfg = config("https://x/v1");
        cfg.provider = ANTHROPIC_MESSAGES;
        let built = authorize(client_for().post("https://x/v1"), &cfg)
            .build()
            .expect("a built request");
        assert!(built.headers().get("x-api-key").is_none());
        assert_eq!(
            built.headers().get("anthropic-version").unwrap(),
            "2023-06-01"
        );
    }

    /// The Messages body says the system prompt in a field of its own — a
    /// `system` message is refused by name — and asks for thinking in tokens
    /// rather than in effort words.
    #[test]
    fn the_messages_body_carries_a_system_field_and_a_budget() {
        let mut cfg = config("https://api.anthropic.com/v1");
        cfg.provider = ANTHROPIC_MESSAGES;
        cfg.reasoning = "medium";
        cfg.max_tokens = 4096;
        let body = request_body(
            &cfg,
            &[
                ChatMessage {
                    role: ChatRole::System,
                    content: "be brief".to_string(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: "hi".to_string(),
                },
                ChatMessage {
                    role: ChatRole::Assistant,
                    content: "hello".to_string(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: "again".to_string(),
                },
            ],
            true,
        );
        assert!(body.contains("\"system\":\"be brief\""), "{body}");
        assert!(
            !body.contains("\"role\":\"system\""),
            "the system prompt is not a message here: {body}"
        );
        assert!(body.contains("\"max_tokens\":4096"), "{body}");
        assert!(body.contains("\"stream\":true"), "{body}");
        // medium asks for 8k, and the answer keeps the last kilotoken: 4096-1024.
        assert!(
            body.contains("\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":3072}"),
            "{body}"
        );
        assert!(
            !body.contains("stream_options"),
            "a field this protocol does not have: {body}"
        );

        // And `off` sends no thinking at all rather than a disabled one.
        let mut cfg = config("https://api.anthropic.com/v1");
        cfg.provider = ANTHROPIC_MESSAGES;
        let body = request_body(
            &cfg,
            &[ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            }],
            true,
        );
        assert!(!body.contains("thinking"), "{body}");
    }

    /// Gemini's body keeps the system prompt out of the turns, calls the
    /// assistant `model`, and carries the whole configuration under
    /// `generationConfig` — with streaming in the URL rather than the body.
    #[test]
    fn the_gemini_body_speaks_gemini() {
        let mut cfg = config("https://generativelanguage.googleapis.com/v1beta");
        cfg.provider = GOOGLE_GENERATIVE_AI;
        cfg.reasoning = "low";
        cfg.max_tokens = 4096;
        let body = request_body(
            &cfg,
            &[
                ChatMessage {
                    role: ChatRole::System,
                    content: "be brief".to_string(),
                },
                ChatMessage {
                    role: ChatRole::Assistant,
                    content: "hello".to_string(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: "again".to_string(),
                },
            ],
            true,
        );
        assert!(
            body.contains("\"systemInstruction\":{\"parts\":[{\"text\":\"be brief\"}]}"),
            "{body}"
        );
        assert!(body.contains("\"role\":\"model\""), "{body}");
        assert!(
            !body.contains("\"role\":\"assistant\""),
            "the role has this protocol's own name: {body}"
        );
        assert!(
            body.contains("\"generationConfig\":{\"maxOutputTokens\":4096"),
            "{body}"
        );
        assert!(
            body.contains("\"thinkingConfig\":{\"includeThoughts\":true,\"thinkingBudget\":2048}"),
            "{body}"
        );
        assert!(
            !body.contains("\"stream\""),
            "streaming is the URL's business here: {body}"
        );
    }

    /// The budget follows the level and never eats the answer's last
    /// kilotoken; a ceiling with no room for both sends no thinking field at
    /// all, because the request would be refused rather than downgraded.
    #[test]
    fn a_thinking_budget_keeps_room_for_the_answer() {
        assert_eq!(thinking_budget("off", 4096), None);
        assert_eq!(thinking_budget("low", 4096), Some(2048));
        assert_eq!(thinking_budget("medium", 4096), Some(3072));
        assert_eq!(thinking_budget("high", 4096), Some(3072));
        assert_eq!(thinking_budget("high", 100_000), Some(16384));
        assert_eq!(thinking_budget("medium", 1024), None, "no room to think in");
        assert_eq!(effort_level("off"), None);
        assert_eq!(effort_level("low"), Some("low"));
    }

    /// Anthropic's stream is read from `content_block_delta`, and the model's
    /// own thinking is not the answer: `thinking_delta` has the same shape and
    /// must not be painted as a reply.
    #[test]
    fn a_thinking_delta_is_not_an_answer() {
        let musing = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#;
        assert!(text_of(ANTHROPIC_MESSAGES, musing).is_none(), "{musing}");
        let answer =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}"#;
        assert_eq!(text_of(ANTHROPIC_MESSAGES, answer).as_deref(), Some("ok"));
        // A block start carries an empty text block and reads as nothing.
        let start =
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#;
        assert!(text_of(ANTHROPIC_MESSAGES, start).is_none());
    }

    /// The Messages bill arrives in two halves and the total is both of them:
    /// read one-for-one, the input count from `message_start` was overwritten
    /// by `message_delta`, which carries the output alone.
    #[test]
    fn the_messages_bill_is_read_from_both_halves() {
        let mut buffer = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        )
        .to_string();
        let mut usage = Usage::default();
        let text = drain_events(ANTHROPIC_MESSAGES, &mut buffer, &mut usage);
        assert_eq!(text, "hi", "the thinking events carried no text anyway");
        assert_eq!(usage.input, 11, "the input count survived the second event");
        assert_eq!(usage.output, 42, "and the output count is the final one");
    }

    /// Anthropic names the event on a line of its own before the payload, and a
    /// reader that wanted the frame to *begin* with `data:` read the whole
    /// protocol as silence — the request went out, the provider answered, and
    /// the panel said the answer held nothing. The frames here are the ones the
    /// endpoint actually sends, `event:` line and all.
    #[test]
    fn a_frame_that_names_its_event_is_still_read() {
        let mut buffer = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"山\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"高\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        )
        .to_string();
        let mut usage = Usage::default();
        let text = drain_events(ANTHROPIC_MESSAGES, &mut buffer, &mut usage);
        assert_eq!(text, "山高", "the frames were read as silence");
        assert_eq!(usage.input, 5, "the message_start bill was read");
        assert_eq!(usage.output, 2, "and the message_delta one");
    }

    /// Gemini splits an answer across `parts` without saying how many, and a
    /// part marked `thought` is the model's working rather than its answer.
    #[test]
    fn gemini_parts_arrive_joined_and_thoughts_skipped() {
        let event = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"one "},{"thought":true,"text":"private"},{"text":"two"}]}}]}"#;
        assert_eq!(
            text_of(GOOGLE_GENERATIVE_AI, event).as_deref(),
            Some("one two")
        );
        let musing = r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"musing"}]}}]}"#;
        assert!(
            text_of(GOOGLE_GENERATIVE_AI, musing).is_none(),
            "a thought is not an answer"
        );
        let bill = r#"{"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}"#;
        assert!(
            text_of(GOOGLE_GENERATIVE_AI, bill).is_none(),
            "a bill is not text"
        );
        let usage = usage_of(GOOGLE_GENERATIVE_AI, bill).expect("usage");
        assert_eq!(usage.input, 7);
        assert_eq!(usage.output, 3);
        assert_eq!(usage.total_tokens, 10);
    }

    /// A transport that is started and answered by nothing is `Unreachable`,
    /// not a hang — the only way to test the whole path without a server.
    #[test]
    fn a_client_is_constructed_explicitly() {
        let client = AgentClient::spawn();
        let outcome = client.chat(
            "t1",
            config("http://127.0.0.1:1/v1"),
            vec![ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            }],
            Duration::from_millis(200),
        );
        // Nothing is listening, so this is `Unreachable` and not a hang.
        assert!(matches!(outcome, Err(Failure::Unreachable(_))));
    }

    #[test]
    fn provider_end_markers_keep_text_and_final_usage() {
        for (provider, body) in [
            (ANTHROPIC_MESSAGES, concat!(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n")),
            (GOOGLE_GENERATIVE_AI, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"candidatesTokenCount\":7}}\n\n"),
        ] {
            let mut buffer = body.to_string();
            let mut usage = Usage::default();
            let batch = read_events(provider, &mut buffer, &mut usage);
            assert!(batch.done && batch.finished, "{provider}");
            assert_eq!(batch.text, "hi");
            assert_eq!(usage.output, 7);
        }
    }
}
