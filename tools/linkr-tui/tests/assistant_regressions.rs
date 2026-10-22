//! Regression checks for device ownership, prompt evidence and response framing.
//!
//! Unit tests cover the pieces — the request body, the SSE frames, the errors —
//! but only a real socket proves the pieces are wired to each other: the URL
//! the client composes, the headers it sends, the body it frames, and the
//! stream it reads back. The model lives on a port the kernel picks and speaks
//! hand-written SSE, so nothing here needs a network or a key.
//!
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use linkr_tui::agent::config::AgentConfig;
use linkr_tui::app::App;

/// Serve one chat-completions request with the stream below, on a port the
/// kernel picks. Returns the port.
fn fake_model(stream: &'static str) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    serve_model(stream, "text/event-stream")
}

fn serve_model(
    stream: &'static str,
    content_type: &'static str,
) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
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
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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

fn fake_json_model(stream: &'static str) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    serve_model(stream, "application/json")
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
fn serial_and_notes_reach_the_model() {
    let (port, server) =
        fake_model("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
    let mut app = configured_app(port);
    app.connect(Box::new(NamedLink("board-context"))).unwrap();
    let path =
        std::env::temp_dir().join(format!("linkr-review-context-{}.json", std::process::id()));
    app.agent_store = Some(linkr_tui::agent::store::JsonFile::at(&path));
    assert!(app
        .session
        .send(b"SERIAL_EVIDENCE_f91b: Kernel panic on boot\r\n"));
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until
        && !app
            .agent_serial
            .read(None, 4000)
            .text
            .contains("SERIAL_EVIDENCE_f91b")
    {
        app.pump();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(app
        .agent_serial
        .read(None, 4000)
        .text
        .contains("SERIAL_EVIDENCE_f91b"));
    let key = app.agent_device_key();
    linkr_tui::agent::notes::NoteStore::new(app.agent_store.as_mut().unwrap())
        .add(&key, "DEVICE_NOTE_61de: Q8B Ubuntu", "confirmed", 1)
        .unwrap();
    send_prompt(
        &mut app,
        "Diagnose the current terminal output using the saved device notes",
    );
    assert_eq!(settle(&mut app), "answered");
    let request = String::from_utf8(server.join().unwrap()).unwrap();
    let _ = std::fs::remove_file(path);
    assert!(
        request.contains("SERIAL_EVIDENCE_f91b") && request.contains("DEVICE_NOTE_61de"),
        "serial={}, notes={}",
        request.contains("SERIAL_EVIDENCE_f91b"),
        request.contains("DEVICE_NOTE_61de")
    );
}

#[test]
fn an_unfinished_sse_reply_is_not_saved_as_complete() {
    let (port, server) =
        fake_model("data: {\"choices\":[{\"delta\":{\"content\":\"Step 1 of 5: download\"}}]}\n\n");
    let mut app = configured_app(port);
    send_prompt(&mut app, "give the complete procedure");
    let status = settle(&mut app);
    server.join().unwrap();
    assert_eq!(
        status,
        "failed",
        "partial reply was persisted as a complete answer: {:?}",
        app.assistant.chat().messages
    );
}

#[test]
fn json_completion_fallback_is_read() {
    let stream = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"whole reply\"},\"finish_reason\":\"stop\"}]}";
    let (port, server) = fake_json_model(stream);
    let mut app = configured_app(port);
    send_prompt(&mut app, "reply");
    let status = settle(&mut app);
    server.join().unwrap();
    assert_eq!(
        status, "answered",
        "valid single-message JSON was rejected: {}",
        app.assistant.tasks[0].summary
    );
}

#[test]
fn done_marker_finishes_without_socket_eof() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (release, wait) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).unwrap_or(0) == 0 {
                return;
            }
            request.push(byte[0]);
        }
        // Close-delimited SSE connection stays alive after its explicit end marker.
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").unwrap();
        socket.flush().unwrap();
        let _ = wait.recv_timeout(Duration::from_secs(5));
    });
    let app = configured_app(port);
    let client = linkr_tui::agent::runtime::AgentClient::spawn();
    let result = client.chat(
        "t1",
        app.assistant.config.unwrap(),
        vec![linkr_tui::agent::runtime::ChatMessage {
            role: linkr_tui::agent::runtime::ChatRole::User,
            content: "reply".into(),
        }],
        Duration::from_secs(2),
    );
    let _ = release.send(());
    server.join().unwrap();
    assert!(
        result.is_ok(),
        "finished SSE was left waiting for EOF: {result:?}"
    );
}

#[test]
fn disconnected_worker_closes_a_task_on_the_next_tick() {
    use linkr_tui::agent::{runtime::Progress, tasks::TaskRecord};
    let mut app = App::default();
    app.assistant.tasks.push(TaskRecord {
        id: "t1".into(),
        device_key: "board".into(),
        updated_at: 1,
        goal: "goal".into(),
        summary: String::new(),
        status: "asking".into(),
    });
    let (tx, rx) = std::sync::mpsc::channel();
    app.agent_replies
        .push(linkr_tui::agent::runtime::PendingReply::new("t1", rx));
    tx.send(("t1".into(), Progress::Delta("partial".into())))
        .unwrap();
    app.drain_agent_replies();
    assert_eq!(app.assistant.tasks[0].status, "typing");
    drop(tx);
    app.drain_agent_replies();
    assert_eq!(
        app.assistant.tasks[0].status,
        "failed",
        "channel removed={}, task={}",
        app.agent_replies.is_empty(),
        app.assistant.tasks[0].status
    );
}

struct NamedLink(&'static str);
impl linkr_tui::transport::Link for NamedLink {
    fn open(
        self: Box<Self>,
    ) -> std::io::Result<(
        Box<dyn linkr_tui::transport::LinkReader>,
        Box<dyn linkr_tui::transport::LinkWriter>,
    )> {
        Box::new(linkr_tui::transport::stdio::StdioBridge::loopback()).open()
    }
    fn kind(&self) -> linkr_tui::transport::LinkKind {
        linkr_tui::transport::LinkKind::Stdio
    }
    fn describe(&self) -> String {
        self.0.into()
    }
}

#[test]
fn switching_devices_does_not_overwrite_the_other_devices_chats() {
    use linkr_tui::agent::session::{load_chats, save_chats, Chat, DisplayLine};
    let path =
        std::env::temp_dir().join(format!("linkr-review-devices-{}.json", std::process::id()));
    let mut app = App {
        agent_store: Some(linkr_tui::agent::store::JsonFile::at(&path)),
        ..App::default()
    };
    let turn = |text: &str| DisplayLine {
        role: "user".into(),
        text: text.into(),
    };
    let b = Chat {
        id: 3,
        title: "B's conversation".into(),
        display: vec![turn("B_EVIDENCE")],
        messages: vec![turn("B_EVIDENCE")],
        updated_at: 1,
    };
    save_chats(app.agent_store.as_mut().unwrap(), "board-B", 3, &[b], 1);
    app.connect(Box::new(NamedLink("board-A"))).unwrap();
    app.assistant.chat_mut().messages.push(turn("A_EVIDENCE"));
    app.assistant.chat_mut().display.push(turn("A_EVIDENCE"));
    linkr_tui::views::assistant::persist_session(&mut app);
    app.connect(Box::new(NamedLink("board-B"))).unwrap();
    linkr_tui::views::assistant::persist_session(&mut app);
    let saved = load_chats(app.agent_store.as_ref().unwrap(), "board-B").unwrap();
    let _ = std::fs::remove_file(path);
    assert!(
        saved
            .chats
            .iter()
            .any(|c| c.messages.iter().any(|m| m.text == "B_EVIDENCE")),
        "B's saved conversation was overwritten with {saved:?}"
    );
    assert!(
        !saved
            .chats
            .iter()
            .any(|c| c.messages.iter().any(|m| m.text == "A_EVIDENCE")),
        "A's evidence was copied into B"
    );
}

#[test]
fn a_live_reply_channel_does_not_drop_deltas() {
    use linkr_tui::agent::{runtime::Progress, tasks::TaskRecord};
    let mut app = App::default();
    app.assistant.tasks.push(TaskRecord {
        id: "t1".into(),
        device_key: "board".into(),
        updated_at: 1,
        goal: "goal".into(),
        summary: String::new(),
        status: "asking".into(),
    });
    let (tx, rx) = std::sync::mpsc::channel();
    app.agent_replies
        .push(linkr_tui::agent::runtime::PendingReply::new("t1", rx));
    let n = 50000;
    let sender = std::thread::spawn(move || {
        for _ in 0..n {
            tx.send(("t1".into(), Progress::Delta("x".into()))).unwrap();
            std::thread::yield_now();
        }
        tx.send(("t1".into(), Progress::Done(Default::default())))
            .unwrap();
    });
    while !sender.is_finished() {
        app.drain_agent_replies();
        std::thread::yield_now();
    }
    sender.join().unwrap();
    app.drain_agent_replies();
    assert_eq!(
        app.assistant.tasks[0].summary.len(),
        n,
        "lost {} live deltas",
        n - app.assistant.tasks[0].summary.len()
    );
}

#[test]
fn mixed_sse_line_endings_preserve_every_delta() {
    let (port, server)=fake_model("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"second\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n");
    let mut app = configured_app(port);
    send_prompt(&mut app, "reply");
    let status = settle(&mut app);
    server.join().unwrap();
    assert_eq!(status, "answered");
    assert_eq!(
        app.assistant.tasks[0].summary, "firstsecond",
        "an event separated with LF was merged with the later CRLF event"
    );
}

#[test]
fn switching_devices_restores_history_and_rejects_old_replies() {
    use linkr_tui::agent::{
        runtime::{PendingReply, Progress},
        session::DisplayLine,
        tasks::TaskRecord,
    };
    let path =
        std::env::temp_dir().join(format!("linkr-switch-history-{}.json", std::process::id()));
    let mut app = App {
        agent_store: Some(linkr_tui::agent::store::JsonFile::at(&path)),
        ..App::default()
    };
    app.connect(Box::new(NamedLink("device-A"))).unwrap();
    app.assistant.chat_mut().messages.push(DisplayLine {
        role: "user".into(),
        text: "A-only history".into(),
    });
    app.assistant.tasks.push(TaskRecord {
        id: "t7".into(),
        device_key: "device-A".into(),
        updated_at: 1,
        goal: "old task".into(),
        summary: String::new(),
        status: "typing".into(),
    });
    let (tx, rx) = std::sync::mpsc::channel();
    app.agent_replies.push(PendingReply::new("t7", rx));
    app.assistant.mode = Some(linkr_tui::exec::executor::Mode::FullAuto);
    app.assistant.full_auto_until = Some(Instant::now() + Duration::from_secs(60));
    app.agent_serial.append("A-only output");
    app.connect(Box::new(NamedLink("device-B"))).unwrap();
    assert!(app.assistant.chat().messages.is_empty());
    assert!(app.assistant.tasks.is_empty());
    assert_eq!(app.agent_serial.retained(), 0);
    assert_eq!(
        app.assistant.mode,
        Some(linkr_tui::exec::executor::Mode::Auto)
    );
    assert!(app.assistant.full_auto_until.is_none());
    assert!(tx
        .send(("t7".into(), Progress::Delta("late A reply".into())))
        .is_err());
    app.disconnect();
    assert_eq!(app.agent_device_key(), "device-B");
    app.connect(Box::new(NamedLink("device-A"))).unwrap();
    assert_eq!(app.assistant.chat().messages[0].text, "A-only history");
    assert_eq!(app.assistant.tasks[0].status, "failed");
    drop(app);
    let mut restarted = App {
        agent_store: Some(linkr_tui::agent::store::JsonFile::at(&path)),
        ..App::default()
    };
    restarted.connect(Box::new(NamedLink("device-A"))).unwrap();
    assert_eq!(
        restarted.assistant.chat().messages[0].text,
        "A-only history"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn received_context_is_redacted_and_never_contains_local_echo() {
    let (port, server) =
        fake_model("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
    let mut app = configured_app(port);
    app.terminal.push_text("LOCAL_ONLY_73ad");
    app.agent_serial
        .append("password=private-value api_key=private-key\nwire evidence");
    send_prompt(&mut app, "diagnose");
    assert_eq!(settle(&mut app), "answered");
    let request = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(request.contains("wire evidence"));
    assert!(request.contains("[redacted]"));
    for secret in ["private-value", "private-key", "LOCAL_ONLY_73ad"] {
        assert!(!request.contains(secret), "{secret} leaked");
    }
}

#[test]
fn an_error_event_after_partial_text_is_not_a_success() {
    let (port,server)=fake_model("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"message\":\"overloaded\"}}\n\n");
    let mut app = configured_app(port);
    send_prompt(&mut app, "reply");
    assert_eq!(settle(&mut app), "failed");
    assert!(app.assistant.tasks[0].summary.contains("overloaded"));
    server.join().unwrap();
}

#[test]
fn a_worker_that_dies_before_its_first_delta_fails_its_own_task() {
    use linkr_tui::agent::{runtime::PendingReply, tasks::TaskRecord};
    let mut app = App::default();
    app.assistant.tasks.push(TaskRecord {
        id: "t1".into(),
        device_key: "board".into(),
        updated_at: 1,
        goal: "goal".into(),
        summary: String::new(),
        status: "asking".into(),
    });
    let (tx, rx) = std::sync::mpsc::channel();
    app.agent_replies.push(PendingReply::new("t1", rx));
    drop(tx);
    app.drain_agent_replies();
    assert_eq!(app.assistant.tasks[0].status, "failed");
}

#[test]
fn json_fallback_reads_anthropic_and_google_responses() {
    for (provider,body) in [
        ("anthropic-messages", "{\"type\":\"message\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hidden\"},{\"type\":\"text\",\"text\":\"hello\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}"),
        ("google-generative-ai", "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2}}")
    ] {
        let (port,server)=fake_json_model(body);
        let mut app=configured_app(port);
        app.assistant.config.as_mut().unwrap().provider=provider;
        send_prompt(&mut app,"reply");
        assert_eq!(settle(&mut app),"answered","{provider}: {}",app.assistant.tasks[0].summary);
        assert_eq!(app.assistant.tasks[0].summary,"hello");
        assert_eq!(app.assistant.chat().usage,(3,2));
        server.join().unwrap();
    }
}
