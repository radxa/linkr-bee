//! The assistant's half of the wire, end to end, against a local model.
//!
//! Unit tests cover the pieces — the request body, the SSE frames, the errors —
//! but only a real socket proves the pieces are wired to each other: the URL
//! the client composes, the headers it sends, the body it frames, and the
//! stream it reads back. The model lives on a port the kernel picks and speaks
//! hand-written SSE, so nothing here needs a network or a key.
//!
//! This is the test that caught a `delta` and its `usage` arriving in one SSE
//! event: the reader took the usage and dropped the text.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use linkr_tui::agent::config::AgentConfig;
use linkr_tui::app::App;

/// Serve one chat-completions request with the stream below, on a port the
/// kernel picks. Returns the port.
fn fake_model(stream: &'static str) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
    let port = listener.local_addr().expect("the address").port();
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("a connection");
        // Read the request head, then the body the head declares — the answer
        // only has to wait for the blank line, but the fake reads the body to
        // check what went out.
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            match socket.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => request.push(byte[0]),
            }
        }
        let head = String::from_utf8_lossy(&request).to_lowercase();
        let length = head
            .split("content-length:")
            .nth(1)
            .and_then(|rest| rest.split(['\r', '\n']).next())
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        let mut got = 0;
        while got < length {
            match socket.read(&mut body[got..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        request.extend_from_slice(&body[..got]);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            stream.len(),
            stream
        );
        let _ = socket.write_all(response.as_bytes());
        let _ = socket.flush();
        // Hold the socket open until the client has drained it.
        std::thread::sleep(Duration::from_millis(100));
        request
    });
    (port, handle)
}

fn configured_app(port: u16) -> App {
    let mut app = App {
        lang: linkr_tui::i18n::Lang::Zh,
        ..App::default()
    };
    app.assistant.configured = true;
    app.assistant.config = Some(AgentConfig {
        endpoint: format!("http://127.0.0.1:{port}/v1"),
        model: "local-test".to_string(),
        api_key: String::new(),
        headers: Vec::new(),
        provider: "openai-completions",
        reasoning: "none",
        context_window: 8192,
        max_tokens: 512,
    });
    app
}

fn send_prompt(app: &mut App, prompt: &str) {
    app.assistant.chat_mut().composer = prompt.to_string();
    linkr_tui::views::assistant::handle_key(
        app,
        crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        ),
    );
}

/// Pump until the task stops being in flight, or the deadline passes.
fn settle(app: &mut App) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        app.pump();
        let status = app
            .assistant
            .tasks
            .first()
            .map(|task| task.status.clone())
            .unwrap_or_default();
        if status == "answered" || status == "failed" {
            return status;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    app.assistant
        .tasks
        .first()
        .map(|task| task.status.clone())
        .unwrap_or_default()
}

#[test]
fn a_prompt_is_answered_by_a_local_model() {
    let (port, server) = fake_model(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\n\
         data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\r\n\r\n\
         data: [DONE]\r\n\r\n",
    );
    let mut app = configured_app(port);
    send_prompt(&mut app, "say hello");

    assert_eq!(app.assistant.tasks.len(), 1, "the prompt was not taken");
    assert_eq!(app.assistant.tasks[0].status, "asking", "queued");

    let status = settle(&mut app);
    let task = &app.assistant.tasks[0];
    assert_eq!(status, "answered", "{}", task.summary);
    assert_eq!(task.summary, "hi there", "the stream was not assembled");
    assert_eq!(
        app.assistant.chat().usage,
        (3, 2),
        "the usage was not folded in"
    );
    let thread = app.assistant.chat().display.last().expect("a model turn");
    assert_eq!(thread.role, "assistant");
    assert_eq!(thread.text, "hi there");

    let request = server.join().expect("the server");
    let head = String::from_utf8_lossy(&request).to_string();
    assert!(
        head.starts_with("POST /v1/chat/completions HTTP/1.1"),
        "{head}"
    );
    assert!(head.contains("\"model\":\"local-test\""), "{head}");
}

#[test]
fn a_provider_that_refuses_says_so_in_the_interface_language() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
    let port = listener.local_addr().expect("the address").port();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("a connection");
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            match socket.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => request.push(byte[0]),
            }
        }
        let body = "{\"error\":{\"message\":\"no such model\"}}";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(response.as_bytes());
        let _ = socket.flush();
        std::thread::sleep(Duration::from_millis(100));
    });

    let mut app = configured_app(port);
    send_prompt(&mut app, "say hello");
    let status = settle(&mut app);
    let task = &app.assistant.tasks[0];
    assert_eq!(status, "failed");
    assert!(
        task.summary.contains("服务商拒绝"),
        "the refusal is not in the interface's words: {}",
        task.summary
    );
    assert!(task.summary.contains("404"), "{}", task.summary);
    assert!(task.summary.contains("no such model"), "{}", task.summary);
    server.join().expect("the server");
}

#[test]
fn a_200_with_no_completion_is_a_failure_rather_than_an_empty_reply() {
    let (port, server) =
        fake_model("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1}}\r\n\r\n");
    let mut app = configured_app(port);
    send_prompt(&mut app, "say hello");
    let status = settle(&mut app);
    let task = &app.assistant.tasks[0];
    assert_eq!(status, "failed");
    assert!(task.summary.contains("没有回答"), "{}", task.summary);
    server.join().expect("the server");
}
