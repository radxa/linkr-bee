//! The process bridge: a child process's standard input and output carry the
//! device's bytes.
//!
//! This is the first real link, and it is the one that makes everything else
//! checkable. A radio cannot be exercised in CI and a serial port cannot be
//! exercised on a laptop with nothing plugged into it, but a *program* can:
//! the same `Link` trait the BLE and serial links will implement is driven here
//! by `cat`, by a shell one-liner, by the Python host client, or by the built-in
//! loopback below. So the pump, the journal, the counters and the disconnect
//! path are all real from the first commit, and swapping in a radio later
//! changes which type is constructed and nothing else.
//!
//! Three shapes, all one link:
//!
//! - [`StdioBridge::new`] wraps any reader and writer this process already has.
//!   That is what the tests use, and what a future `--from-fd` would use.
//! - [`StdioBridge::spawn`] starts a program and bridges over its stdio. The
//!   command is a shell word list, so `--bridge "python3 host.py"` works the
//!   way a user expects without this module shipping a shell parser.
//! - [`StdioBridge::loopback`] is a device that does not exist: a banner and a
//!   shell that answers a handful of commands. It is what `--bridge -` runs, so
//!   a frame with real content can be looked at on a machine with no hardware
//!   attached — which is exactly the situation this link was built for.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{Link, LinkKind, LinkReader, LinkWriter};

/// A link over a process's standard streams.
pub enum StdioBridge {
    /// Streams this process already holds. Boxed because the two halves are
    /// consumed separately and neither is named again.
    Pipes {
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        describe: String,
    },
    /// A program to start and bridge over. Kept unspawned until [`Link::open`],
    /// so a failed dial is reported where a failed dial belongs.
    Command(String),
    /// The built-in device that is not a device.
    Loopback,
}

impl StdioBridge {
    /// Bridge over a reader and a writer this process already owns.
    pub fn new(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        describe: impl Into<String>,
    ) -> StdioBridge {
        StdioBridge::Pipes {
            reader: Box::new(reader),
            writer: Box::new(writer),
            describe: describe.into(),
        }
    }

    /// The description a spawned command is dialled under.
    pub fn command_description(command: &str) -> String {
        format!("stdio: {command}")
    }

    /// Start `command` and bridge over its standard streams.
    pub fn spawn(command: impl Into<String>) -> StdioBridge {
        StdioBridge::Command(command.into())
    }

    /// The built-in loopback device, as `--bridge -` selects it.
    pub fn loopback() -> StdioBridge {
        StdioBridge::Loopback
    }

    /// Split `command` into a program and its arguments, the way a shell would
    /// split it — spaces only, with a backslash escaping the next character.
    /// No quoting is invented: a command that needs quotes needs a shell, and
    /// the caller can write `sh -c '...'` for that.
    fn words(command: &str) -> io::Result<Vec<String>> {
        let mut words = Vec::new();
        let mut word = String::new();
        let mut escaped = false;
        for ch in command.chars() {
            if escaped {
                word.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch.is_whitespace() {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            } else {
                word.push(ch);
            }
        }
        if escaped {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the command ends with a trailing backslash",
            ));
        }
        if !word.is_empty() {
            words.push(word);
        }
        if words.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "no command to bridge over",
            ));
        }
        Ok(words)
    }
}

impl Link for StdioBridge {
    fn open(self: Box<Self>) -> io::Result<(Box<dyn LinkReader>, Box<dyn LinkWriter>)> {
        match *self {
            StdioBridge::Pipes { reader, writer, .. } => Ok((
                Box::new(StreamReader { inner: reader }),
                Box::new(StreamWriter {
                    inner: writer,
                    child: None,
                }),
            )),
            StdioBridge::Command(command) => {
                let words = StdioBridge::words(&command)?;
                let mut child = Command::new(&words[0])
                    .args(&words[1..])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .map_err(|err| {
                        io::Error::new(err.kind(), format!("could not start {command:?}: {err}"))
                    })?;
                let stdout = child.stdout.take().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "the bridge has no stdout")
                })?;
                let stdin = child.stdin.take().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "the bridge has no stdin")
                })?;
                Ok((
                    Box::new(StreamReader {
                        inner: Box::new(stdout),
                    }),
                    Box::new(StreamWriter {
                        inner: Box::new(stdin),
                        child: Some(Box::new(child)),
                    }),
                ))
            }
            StdioBridge::Loopback => {
                let device = Arc::new(LoopbackDevice::default());
                let (sender, receiver) = std::sync::mpsc::channel();
                Ok((
                    Box::new(DeviceReader {
                        device: Arc::clone(&device),
                        outbox: receiver,
                        pending: VecDeque::new(),
                        greeted: false,
                        sender,
                    }),
                    Box::new(DeviceWriter { device }),
                ))
            }
        }
    }

    fn kind(&self) -> LinkKind {
        LinkKind::Stdio
    }

    fn describe(&self) -> String {
        match self {
            StdioBridge::Pipes { describe, .. } => describe.clone(),
            StdioBridge::Command(command) => StdioBridge::command_description(command),
            StdioBridge::Loopback => "stdio: loopback".to_string(),
        }
    }
}

/// A reader over any `Read`.
struct StreamReader {
    inner: Box<dyn Read + Send>,
}

impl LinkReader for StreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

/// A writer over any `Write`, holding the child so it can be reaped.
struct StreamWriter {
    inner: Box<dyn Write + Send>,
    child: Option<Box<Child>>,
}

impl LinkWriter for StreamWriter {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.inner.write_all(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Drop for StreamWriter {
    fn drop(&mut self) {
        // Closing the bridge's input is the polite hang-up; a program that
        // ignores it is killed, because a leaked child holding the radio is
        // worse than a killed one.
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// --- the device that is not a device -----------------------------------------

/// The shell prompt the loopback prints, spelled once.
const PROMPT: &str = "linkr@bee:~$ ";

/// A tiny shell standing in for the board, so `--bridge -` shows a populated
/// terminal on a machine with no hardware.
#[derive(Default)]
struct LoopbackDevice {
    /// Commands typed but not yet terminated by a newline.
    line: Mutex<String>,
    /// What the "device" has to say next.
    outbox: Mutex<VecDeque<u8>>,
    /// The channel to wake a blocked reader with.
    waker: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Set when the host hangs the console up, which is the reader's
    /// end-of-stream: the writer dropping is the only hang-up this device has.
    closed: std::sync::atomic::AtomicBool,
}

impl LoopbackDevice {
    fn push(&self, text: &str) {
        if let Ok(mut outbox) = self.outbox.lock() {
            outbox.extend(text.as_bytes().iter().copied());
        }
        if let Ok(waker) = self.waker.lock() {
            if let Some(sender) = waker.as_ref() {
                let _ = sender.send(());
            }
        }
    }

    fn banner(&self) {
        self.push(
            "Linkr Bee loopback device (no radio attached)\r\n\
             Type a command; try: help, version, uname -a, df -h\r\n",
        );
        self.push(PROMPT);
    }

    /// The reply to one complete line, as the board would print it.
    ///
    /// A hair more shell than the banner admits, because the CLI's `exec`
    /// contract (a quoted `sh -c` followed by a status printer) has to be
    /// answerable without hardware: `echo`, `printf`, `true`, `false`, `exit`,
    /// `$?` and `;`-separated lists are understood, quotes group words the way a
    /// shell's do, and a `sleep` or a `sudo` password prompt is left hanging
    /// the way a real one would be. The banner's own commands keep their
    /// exact answers, and anything else stays "not found".
    ///
    /// The boundary is a wall and not a fence: the shell grammar this device
    /// does not implement — pipes, redirections, substitutions, globs — is
    /// refused with a non-zero status rather than echoed back as literal
    /// words, because a rehearsal that passes offline what the board would
    /// fail is worse than one that says what it cannot do. See
    /// [`unsupported`].
    fn reply(&self, line: &str) {
        let command = line.trim();
        if command.is_empty() {
            return;
        }
        if self.run_list(command).is_some() {
            self.push(PROMPT);
        }
    }

    fn run_list(&self, command: &str) -> Option<i32> {
        let mut status = 0;
        for segment in segments(command) {
            // A sleep or password prompt keeps the shell waiting, so later
            // segments and the prompt must wait too.
            status = self.run_segment(segment.trim(), status)?;
            if words(segment.trim())
                .first()
                .is_some_and(|word| word == "exit")
            {
                break;
            }
        }
        Some(status)
    }

    /// Run one `;`-list segment. `None` when the segment left the shell
    /// waiting rather than returning a status; the status returned is what
    /// `$?` sees in the segment that follows.
    fn run_segment(&self, segment: &str, status: i32) -> Option<i32> {
        // The grammar this device does not implement is refused before any of
        // it is read as words. `echo x | tr a-z A-Z` reaching the `echo` arm
        // would print the pipe and answer 0 — a rehearsal that passes offline
        // and fails on the board, which is worse than no rehearsal at all.
        if let Some(operator) = unsupported(segment) {
            self.push(&format!(
                "sh: {operator}: the loopback device runs simple commands only — \
                 pipes, redirections, substitutions and globs are the target \
                 shell's, not this one's\r\n"
            ));
            return Some(2);
        }
        let parsed = words(segment);
        // The single-quoted child script must reach its own shell before `$?`
        // is expanded; it does not belong to the outer shell's last status.
        if parsed.len() == 3 && parsed[0] == "sh" && parsed[1] == "-c" {
            return self.run_list(&parsed[2]);
        }
        let words: Vec<String> = parsed
            .into_iter()
            .map(|word| word.replace("$?", &status.to_string()))
            .collect();
        let (head, rest) = match words.split_first() {
            Some((head, rest)) => (head.as_str(), rest),
            None => return Some(status),
        };
        match head {
            // The shell builtins the CLI's exec contract is built on.
            "echo" => {
                self.push(&format!("{}\r\n", rest.join(" ")));
                Some(0)
            }
            // `printf` is here for the CLI's prompt classifier: a format with
            // no trailing newline is a prompt a person would answer, and
            // `needs_input` has to be producible without hardware. Only the
            // escapes and conversions that path needs are real — `\n`, `\r`,
            // `\t`, `\\`, `%%`, `%s`, `%d` — and anything else is printed as
            // it was typed, which is the tolerant half of what shells do.
            "printf" => Some(self.printf(rest)),
            // See the note on `reply`: the status ends the command, and the
            // wrapper's own status echo still runs after it.
            "exit" => {
                let code = rest
                    .first()
                    .and_then(|word| word.parse::<i32>().ok())
                    .unwrap_or(0);
                Some(code)
            }
            "true" => Some(0),
            "false" => Some(1),
            // As far as anything here can tell it never finishes: nothing is
            // printed and no prompt follows, so an `exec` that waits for one
            // waits out its own deadline instead.
            "sleep" => None,
            // A terminal reading a password: the prompt has no newline
            // because a real one does not, and naming what it waits for is
            // the classifier's job (`serial::console`), not this device's.
            "sudo" => {
                self.push("[sudo] password for root: ");
                None
            }
            // What the banner documents, with the exact answers it promised.
            "help" => {
                self.push("help version uname df reboot\r\n");
                Some(0)
            }
            "version" => {
                self.push("linkr-bee 1.0.0 (loopback)\r\n");
                Some(0)
            }
            "uname" if rest.join(" ") == "-a" => {
                self.push("Linux bee 6.6.0-linkr #1 SMP aarch64 GNU/Linux\r\n");
                Some(0)
            }
            "df" if rest.join(" ") == "-h" => {
                self.push(
                    "Filesystem      Size  Used Avail Use% Mounted on\r\n\
                     /dev/root        28G  7.4G   19G  29% /\r\n\
                     tmpfs           196M     0  196M   0% /run\r\n",
                );
                Some(0)
            }
            _ => {
                self.push(&format!("sh: {segment}: not found\r\n"));
                Some(127)
            }
        }
    }

    /// A shell's `printf`, as much of it as this device needs.
    ///
    /// The format is reused while arguments remain, as POSIX says, and a
    /// conversion with no argument left prints an empty string (`%s`) or a
    /// zero (`%d`). Newlines are the console's own `\r\n`: this device is a
    /// serial console, and a bare `\n` would leave the pane drawing a
    /// staircase.
    fn printf(&self, args: &[String]) -> i32 {
        let Some((format, values)) = args.split_first() else {
            self.push("sh: printf: usage: printf <format> [arguments]\r\n");
            return 2;
        };
        let mut values = values.iter();
        let mut out = String::new();
        loop {
            let mut consumed = false;
            let mut chars = format.chars();
            while let Some(ch) = chars.next() {
                match ch {
                    '\\' => match chars.next() {
                        Some('n') => out.push('\n'),
                        Some('r') => out.push('\r'),
                        Some('t') => out.push('\t'),
                        Some('\\') => out.push('\\'),
                        Some(other) => {
                            out.push('\\');
                            out.push(other);
                        }
                        None => out.push('\\'),
                    },
                    '%' => match chars.next() {
                        Some('%') => out.push('%'),
                        Some(conversion @ ('s' | 'd')) => {
                            let value = values.next();
                            consumed = value.is_some();
                            let text = value.cloned().unwrap_or_default();
                            if conversion == 'd' {
                                out.push_str(&text.parse::<i64>().unwrap_or(0).to_string());
                            } else {
                                out.push_str(&text);
                            }
                        }
                        Some(other) => {
                            out.push('%');
                            out.push(other);
                        }
                        None => out.push('%'),
                    },
                    other => out.push(other),
                }
            }
            // The format runs again only when it actually used an argument
            // and there is another one waiting.
            if !consumed || values.len() == 0 {
                break;
            }
        }
        self.push(&out.replace('\n', "\r\n"));
        0
    }
}

/// Split a command line on its `;` separators, ignoring the ones inside
/// quotes: `echo "a;b"` is one segment and prints `a;b`.
/// The first piece of shell grammar in this segment that the loopback device
/// does not run, if there is one.
///
/// The device is a stand-in for the target's shell, and a stand-in that
/// answers a pipeline, a redirection or a glob with the text it was given and
/// a status of 0 has lied about the board — the one kind of failure an offline
/// rehearsal must not have. So the operators are refused out loud, with a
/// status a shell would use for a line it could not parse, and only simple
/// commands are run.
///
/// Quoting is honoured, because a quoted argument is data and not grammar:
/// `echo 'a|b'` prints what it says. `$?` is the one substitution this device
/// does implement, so `$` followed by `?` is left for [`words`] to expand;
/// every other `$` is an expansion with no answer here. `#` is a comment only
/// where a word starts, which is the only place a shell reads one.
fn unsupported(segment: &str) -> Option<&'static str> {
    let mut quote: Option<char> = None;
    let mut word_start = true;
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                word_start = false;
            }
            '\\' => {
                chars.next();
                word_start = false;
            }
            '|' => return Some("|"),
            '&' => return Some("&"),
            '>' => return Some(">"),
            '<' => return Some("<"),
            '`' => return Some("`"),
            '*' => return Some("*"),
            '~' if word_start => return Some("~"),
            '(' => return Some("("),
            ')' => return Some(")"),
            '#' if word_start => return Some("#"),
            '$' if chars.peek() != Some(&'?') => return Some("$"),
            other if other.is_whitespace() => word_start = true,
            _ => word_start = false,
        }
    }
    None
}

fn segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut segment = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        match quote {
            Some(open) if ch == open => {
                quote = None;
                segment.push(ch);
            }
            Some(_) => segment.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                segment.push(ch);
            }
            None if ch == ';' => segments.push(std::mem::take(&mut segment)),
            None => segment.push(ch),
        }
    }
    segments.push(segment);
    segments
}

/// Split one segment into words, the way a shell splits them.
///
/// Quotes group: `echo "a  b"` is two words and the second keeps its inner
/// spaces, which is what a quoted argument has always meant and what
/// `split_whitespace` alone gets wrong. Both quote characters are honoured;
/// neither can be escaped, and a quote left open at the end of the segment
/// takes the rest of it, the way a shell's would before it goes on waiting
/// for more. `$?` is expanded by the caller in every word, quoted or not —
/// closer to the point than to POSIX, and every test that matters quotes it
/// because the value is not known until the segment runs.
fn words(segment: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    // Distinguished from "no word yet": `echo ""` is one empty argument, and
    // losing it would turn a quoted empty into a missing one.
    let mut started = false;
    for ch in segment.chars() {
        match quote {
            Some(open) => {
                if ch == open {
                    quote = None;
                } else {
                    word.push(ch);
                }
            }
            None => match ch {
                '"' | '\'' => {
                    quote = Some(ch);
                    started = true;
                }
                ch if ch.is_whitespace() => {
                    if started {
                        words.push(std::mem::take(&mut word));
                        started = false;
                    }
                }
                ch => {
                    word.push(ch);
                    started = true;
                }
            },
        }
    }
    if started {
        words.push(word);
    }
    words
}

struct DeviceWriter {
    device: Arc<LoopbackDevice>,
}

impl Drop for DeviceWriter {
    fn drop(&mut self) {
        // The console is closed, and the writer dropping is the only hang-up
        // this device has: whoever was reading is told, so the reader thread
        // finishes instead of waiting for bytes that will never come. The
        // parked read is woken as well — a reader already inside
        // `recv_timeout` would otherwise sit out its timeout first.
        self.device
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(waker) = self.device.waker.lock() {
            if let Some(sender) = waker.as_ref() {
                let _ = sender.send(());
            }
        }
    }
}

impl LinkWriter for DeviceWriter {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        for byte in buf {
            match *byte {
                b'\r' | b'\n' => {
                    let line = self
                        .device
                        .line
                        .lock()
                        .map(|mut line| std::mem::take(&mut *line))
                        .unwrap_or_default();
                    // The far end of a serial line is a terminal, so the echo
                    // is CRLF like the device's own output.
                    self.device.push("\r\n");
                    if !line.trim().is_empty() {
                        self.device.reply(&line);
                    } else {
                        self.device.push(PROMPT);
                    }
                }
                0x08 | 0x7f => {
                    if let Ok(mut line) = self.device.line.lock() {
                        line.pop();
                    }
                    self.device.push("\x08 \x08");
                }
                byte if byte.is_ascii_graphic() || byte == b' ' => {
                    if let Ok(mut line) = self.device.line.lock() {
                        line.push(byte as char);
                    }
                    self.device.push(&(byte as char).to_string());
                }
                // Anything else (a control key, a non-ASCII byte) is echoed
                // raw so the pane still shows what was sent.
                0x09 => self.device.push("\t"),
                other => self.device.push(&String::from_utf8_lossy(&[other])),
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct DeviceReader {
    device: Arc<LoopbackDevice>,
    outbox: std::sync::mpsc::Receiver<()>,
    pending: VecDeque<u8>,
    greeted: bool,
    sender: std::sync::mpsc::Sender<()>,
}

impl LinkReader for DeviceReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.greeted {
            self.greeted = true;
            *self.device.waker.lock().expect("waker lock") = Some(self.sender.clone());
            self.device.banner();
        }
        loop {
            if self.pending.is_empty() {
                let drained: VecDeque<u8> = {
                    let mut outbox = self.device.outbox.lock().expect("outbox lock");
                    std::mem::take(&mut *outbox)
                };
                self.pending = drained;
            }
            if !self.pending.is_empty() {
                let n = self.pending.len().min(buf.len());
                for slot in buf.iter_mut().take(n) {
                    *slot = self.pending.pop_front().expect("checked non-empty");
                }
                return Ok(n);
            }
            // Nothing left to say and the writer is gone: this is the end of
            // the stream, and saying so is what lets the reader thread finish
            // instead of polling a console that will never speak again.
            if self.device.closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Ok(0);
            }
            // Nothing to say: wait for the writer to wake us, the way a real
            // read waits on the wire. A timeout keeps the shutdown path from
            // hanging if the wake-up is missed.
            match self.outbox.recv_timeout(Duration::from_millis(50)) {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{LinkEvent, LinkHandle};
    use std::thread;
    use std::time::{Duration, Instant};

    fn wait_for(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(2));
        }
        predicate()
    }

    /// Drain a handle into everything received, up to `want` bytes.
    fn collect_until(handle: &LinkHandle, want: usize) -> (Vec<u8>, Vec<LinkEvent>) {
        let mut bytes = Vec::new();
        let mut all = Vec::new();
        wait_for(|| {
            for event in handle.drain() {
                if let LinkEvent::Data(ref chunk) = event {
                    bytes.extend(chunk.iter().copied());
                }
                all.push(event);
            }
            bytes.len() >= want
        });
        (bytes, all)
    }

    /// Drain a handle until what has arrived contains `needle`.
    ///
    /// Waiting for a *needle* rather than for a byte count is what keeps the
    /// loopback tests off the clock. The device's banner and the reply to the
    /// first command can land in the same drain, so a test that waits for N
    /// bytes can be satisfied by the banner and then assert on a reply it never
    /// received — which is a race, and it failed exactly that way under load.
    fn collect_text(handle: &LinkHandle, needle: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        wait_for(|| {
            for event in handle.drain() {
                if let LinkEvent::Data(ref chunk) = event {
                    bytes.extend(chunk.iter().copied());
                }
            }
            String::from_utf8_lossy(&bytes).contains(needle)
        });
        bytes
    }

    /// The console hanging up is the reader's end of stream: a poll that finds
    /// the writer gone says so instead of waiting for bytes that will never
    /// come. That is what lets the reader thread finish — otherwise it is one
    /// thread per dial, each ticking at 20 Hz for the life of the process.
    #[test]
    fn a_closed_console_ends_the_read() {
        let device = Arc::new(LoopbackDevice::default());
        let (sender, outbox) = std::sync::mpsc::channel();
        let mut reader = DeviceReader {
            device: Arc::clone(&device),
            outbox,
            pending: VecDeque::new(),
            greeted: false,
            sender,
        };
        let writer = DeviceWriter {
            device: Arc::clone(&device),
        };

        // What is buffered is read before the hang-up is honoured: the
        // greeting the reader asked for is still the first thing it hears.
        let mut buf = [0u8; 256];
        let n = reader.read(&mut buf).expect("reads the banner");
        assert!(n > 0, "the banner is the first thing a reader hears");
        drop(writer);
        let mut buf = [0u8; 64];
        assert_eq!(
            reader.read(&mut buf).expect("reads"),
            0,
            "a console that is gone is the end of the stream"
        );
    }

    /// A command is split the way a user writes it, and a command that cannot
    /// be split is refused rather than started wrongly.
    #[test]
    fn a_command_splits_into_words() {
        assert_eq!(
            StdioBridge::words("python3 host.py --reliable").expect("splits"),
            vec!["python3", "host.py", "--reliable"]
        );
        assert_eq!(
            StdioBridge::words("  cat   ").expect("splits"),
            vec!["cat"],
            "surrounding and repeated spaces carry no words"
        );
        assert_eq!(
            StdioBridge::words(r"sh -c echo\ hi").expect("splits"),
            vec!["sh", "-c", "echo hi"],
            "a backslash joins words"
        );
        for bad in ["", "   ", r"cat \"] {
            assert!(StdioBridge::words(bad).is_err(), "{bad:?} was accepted");
        }
    }

    /// The link names itself, and the name is what the sidebar shows.
    #[test]
    fn the_link_names_itself() {
        let bridge = StdioBridge::loopback();
        assert_eq!(bridge.kind(), LinkKind::Stdio);
        assert_eq!(bridge.describe(), "stdio: loopback");
        let spawned = StdioBridge::spawn("cat");
        assert_eq!(spawned.describe(), "stdio: cat");
    }

    /// A reader and a writer this process already owns are bridged verbatim:
    /// what is written comes out and what is fed comes back.
    #[test]
    fn a_pair_of_streams_is_bridged() {
        // Two pipes: one the host writes and the "device" reads, one the other
        // way round.
        let (mut device_input, host_to_device) = std::io::pipe().expect("pipe");
        let (host_from_device, mut device_output) = std::io::pipe().expect("pipe");
        let handle = LinkHandle::start(Box::new(StdioBridge::new(
            host_from_device,
            host_to_device,
            "test pipes",
        )))
        .expect("opens");

        handle.send(b"ping\n".to_vec());
        let mut got = [0u8; 5];
        assert!(wait_for(|| device_input.read_exact(&mut got).is_ok()));
        assert_eq!(&got, b"ping\n");

        device_output.write_all(b"pong\n").expect("writes");
        let (bytes, _) = collect_until(&handle, 5);
        assert_eq!(bytes, b"pong\n".to_vec());
    }

    /// A child process is really started and really spoken to: the stdio
    /// bridge is not a mock. `cat` is the smallest program that proves both
    /// directions, and it is present everywhere this test can run.
    #[test]
    fn a_child_process_is_bridged_both_ways() {
        let handle = LinkHandle::start(Box::new(StdioBridge::spawn("cat"))).expect("spawns cat");
        handle.send(b"hello wire\n".to_vec());
        let (bytes, events) = collect_until(&handle, 11);
        assert_eq!(bytes, b"hello wire\n".to_vec());
        assert!(
            events.iter().any(|e| matches!(e, LinkEvent::Opened)),
            "the link never opened: {events:?}"
        );
        assert!(
            !events.iter().any(|e| matches!(e, LinkEvent::Closed(_))),
            "the bridge closed while it was still in use: {events:?}"
        );
    }

    /// A program that does not exist fails at open, with the command in the
    /// message, rather than opening a link that silently swallows everything.
    #[test]
    fn a_missing_program_fails_at_open() {
        let err = LinkHandle::start(Box::new(StdioBridge::spawn("linkr-no-such-program")))
            .expect_err("nothing to start");
        assert!(
            err.to_string().contains("linkr-no-such-program"),
            "the error does not say what was dialled: {err}"
        );
    }

    /// The loopback answers the commands it documents, and the session sees a
    /// device that talks back — which is the whole point of shipping it.
    #[test]
    fn the_loopback_answers_a_command() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        // The prompt is the last thing in the banner, so waiting for it means
        // the banner is over before the command goes out.
        let banner = collect_text(&handle, "linkr@bee:~$ ");
        assert!(
            String::from_utf8_lossy(&banner).contains("loopback device"),
            "no banner: {:?}",
            String::from_utf8_lossy(&banner)
        );

        handle.send(b"uname -a\n".to_vec());
        let reply = collect_text(&handle, "aarch64");
        let text = String::from_utf8_lossy(&reply);
        assert!(text.contains("uname -a"), "no echo: {text:?}");
        assert!(text.contains("aarch64"), "no answer: {text:?}");
    }

    /// An unknown command is reported the way a shell reports it, so the pane
    /// shows a plausible device rather than an empty one.
    #[test]
    fn the_loopback_reports_an_unknown_command() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        let _ = collect_text(&handle, "linkr@bee:~$ ");
        handle.send(b"nonsense\n".to_vec());
        let reply = collect_text(&handle, "not found");
        let text = String::from_utf8_lossy(&reply);
        assert!(text.contains("not found"), "{text:?}");
    }

    /// The little shell the CLI's exec contract needs: `echo`, an exit status
    /// carried through `$?` into the marker line, and the shell convention
    /// for a command that was never there.
    #[test]
    fn the_loopback_speaks_the_exec_contract() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        let _ = collect_text(&handle, "linkr@bee:~$ ");

        handle.send(b"echo ok; echo \"LINKR_RC:$?\"\n".to_vec());
        let reply = collect_text(&handle, "LINKR_RC:0");
        let text = String::from_utf8_lossy(&reply);
        assert!(text.contains("ok\r\n"), "the echo did not answer: {text:?}");
        assert!(text.contains("LINKR_RC:0"), "no marker line: {text:?}");

        handle.send(b"nosuch; echo \"LINKR_RC:$?\"\n".to_vec());
        let reply = collect_text(&handle, "LINKR_RC:127");
        let text = String::from_utf8_lossy(&reply);
        assert!(
            text.contains("sh: nosuch: not found"),
            "the unknown command was not reported: {text:?}"
        );
        assert!(text.contains("LINKR_RC:127"), "no 127 marker: {text:?}");
    }

    /// What is typed is echoed and then answered: a line arrives in the reply
    /// buffer as it was sent, before the device's own answer to it.
    #[test]
    fn the_loopback_echoes_before_it_answers() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        let _ = collect_text(&handle, "linkr@bee:~$ ");
        handle.send(b"echo hello\n".to_vec());
        let reply = collect_text(&handle, "hello\r\n");
        let text = String::from_utf8_lossy(&reply);
        let typed = text.find("echo hello").expect("the typed line was echoed");
        let answer = text.find("hello\r\n").expect("the answer arrived");
        assert!(typed <= answer, "the answer overtook the echo: {text:?}");
    }

    /// `sleep` never comes back: nothing is printed and no prompt follows,
    /// which is the case the CLI's timeout path exists for.
    #[test]
    fn the_loopback_never_finishes_a_sleep() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        let _ = collect_text(&handle, "linkr@bee:~$ ");
        handle.send(b"sleep 9\n".to_vec());
        thread::sleep(Duration::from_millis(80));
        let after = drain_text(&handle);
        assert!(
            after.contains("sleep 9"),
            "the echo of the typed line never arrived: {after:?}"
        );
        assert!(
            !after.contains("linkr@bee:~$ "),
            "a prompt came back for a command that never finished: {after:?}"
        );
    }

    /// A `sudo` prompt is the CLI's `needs_input` case, so the loopback has
    /// to leave one hanging: the prompt arrives and nothing else does, not
    /// even a prompt of its own.
    #[test]
    fn the_loopback_leaves_a_password_prompt_hanging() {
        let handle = LinkHandle::start(Box::new(StdioBridge::loopback())).expect("opens");
        let _ = collect_text(&handle, "linkr@bee:~$ ");
        handle.send(b"sudo id\n".to_vec());
        let reply = collect_text(&handle, "[sudo] password for root: ");
        let text = String::from_utf8_lossy(&reply);
        assert!(text.contains("[sudo] password for root: "), "{text:?}");
        // The point of the case is the silence after the prompt: give a shell
        // that was going to answer anyway a moment to prove it will not.
        thread::sleep(Duration::from_millis(80));
        let after = drain_text(&handle);
        assert!(
            !after.contains("linkr@bee:~$ "),
            "a prompt followed the password prompt: {after:?}"
        );
    }

    /// Everything the handle has received since the last drain, as text.
    fn drain_text(handle: &LinkHandle) -> String {
        let bytes: Vec<u8> = handle
            .drain()
            .into_iter()
            .filter_map(|event| match event {
                LinkEvent::Data(chunk) => Some(chunk),
                _ => None,
            })
            .flatten()
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Everything the device has printed since the last read.
    fn outbox(device: &LoopbackDevice) -> String {
        let bytes: Vec<u8> = match device.outbox.lock() {
            Ok(mut outbox) => outbox.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Quotes group words, which is what makes a quoted command testable at
    /// all: the old whitespace-splitter turned `printf "Password:"` into
    /// `printf` and `Password:` — the second one found nowhere — and a
    /// quoted argument with spaces in it into two arguments.
    #[test]
    fn shell_words_honour_quotes() {
        assert_eq!(words("echo a b"), vec!["echo", "a", "b"]);
        assert_eq!(words("printf \"Password:\""), vec!["printf", "Password:"]);
        assert_eq!(words("echo 'a  b'"), vec!["echo", "a  b"]);
        assert_eq!(words("printf \"it's\""), vec!["printf", "it's"]);
        assert_eq!(words("echo \"a 'b' c\""), vec!["echo", "a 'b' c"]);
        // An empty quoted argument is an argument, not a missing one.
        assert_eq!(words("printf \"\""), vec!["printf", ""]);
        // A quote left open takes the rest of the segment.
        assert_eq!(words("echo \"open"), vec!["echo", "open"]);
    }

    /// A `;` inside quotes is part of the argument, not a separator: the old
    /// splitter ran it as a second command.
    #[test]
    fn shell_segments_ignore_quoted_semicolons() {
        assert_eq!(segments("echo a; echo b"), vec!["echo a", " echo b"]);
        assert_eq!(segments("echo \"a;b\""), vec!["echo \"a;b\""]);
        assert_eq!(
            segments("printf 'x;y'; true"),
            vec!["printf 'x;y'", " true"]
        );
    }

    /// `printf "Password:"` is the offline `needs_input`: a prompt with no
    /// newline, exactly what the classifier reads.
    #[test]
    fn printf_prints_a_prompt_with_no_newline() {
        let device = LoopbackDevice::default();
        device.reply("printf \"Password:\"");
        let text = outbox(&device);
        assert!(text.starts_with("Password:"), "{text:?}");
        assert!(!text.contains('\n'), "a prompt gained a newline: {text:?}");
        assert!(text.ends_with(PROMPT), "no prompt followed: {text:?}");
    }

    /// The conversions and escapes the offline tests lean on, and the
    /// console's own line ending on a format that asks for a newline.
    #[test]
    fn printf_understands_its_own_escapes_and_conversions() {
        let device = LoopbackDevice::default();
        device.reply("printf 'a\\nb\\t%s %% %d' done 7");
        let text = outbox(&device);
        assert!(text.starts_with("a\r\nb\tdone % 7"), "{text:?}");
    }

    /// `exit N` ends only the child shell; the outer status printer still runs.
    #[test]
    fn exit_sets_the_status_the_wrapper_reads() {
        let device = LoopbackDevice::default();
        device.reply("sh -c 'exit 42; echo unreachable'; echo \"LINKR_RC:$?\"");
        let text = outbox(&device);
        assert!(text.contains("LINKR_RC:42"), "{text:?}");
        assert!(!text.contains("unreachable"), "{text:?}");
        // And a bare `exit` is status zero, the way a shell means it.
        let device = LoopbackDevice::default();
        device.reply("sh -c 'exit'; echo \"LINKR_RC:$?\"");
        let text = outbox(&device);
        assert!(text.contains("LINKR_RC:0"), "{text:?}");
    }

    /// The shell grammar this device does not implement is refused, not
    /// faked: a pipeline that reached `echo` as literal words would come back
    /// with status 0, and an offline rehearsal that passes what the board
    /// would fail is the one kind of lie a rehearsal must not tell.
    #[test]
    fn the_loopback_refuses_the_grammar_it_does_not_run() {
        for command in [
            "echo x | tr a-z A-Z",
            "true && echo hi",
            "echo x > /tmp/f",
            "echo `id`",
            "echo $(id)",
            "echo *",
            "echo ~",
            "ls /tmp; echo x # a comment",
        ] {
            let device = LoopbackDevice::default();
            device.reply(command);
            let text = outbox(&device);
            assert!(
                text.contains("simple commands only"),
                "{command:?} was not refused: {text:?}"
            );
        }
        // The refusal is a status a shell would use for a line it could not
        // parse, and the rest of the line — the wrapper's own status echo —
        // still runs, which is what makes the answer readable.
        let device = LoopbackDevice::default();
        device.reply("echo x | cat; echo \"LINKR_RC:$?\"");
        let text = outbox(&device);
        assert!(text.contains("LINKR_RC:2"), "{text:?}");
    }

    /// Quoting is the boundary of the boundary: a metacharacter inside quotes
    /// is an argument, and `$?` is the one substitution this shell has.
    #[test]
    fn the_refusal_stops_at_quotes_and_at_dollar_question() {
        let device = LoopbackDevice::default();
        device.reply("echo 'a|b' \"c>d\"");
        let text = outbox(&device);
        assert!(
            text.contains("a|b c>d"),
            "a quoted argument was refused: {text:?}"
        );
        // `$?` expands in every word, unquoted included.
        let device = LoopbackDevice::default();
        device.reply("false; echo $?");
        let text = outbox(&device);
        assert!(text.contains("1\r\n"), "`$?` did not expand: {text:?}");
        // A `#` inside a word is a word, as it is in a shell.
        let device = LoopbackDevice::default();
        device.reply("echo a#b");
        let text = outbox(&device);
        assert!(text.contains("a#b"), "{text:?}");
    }

    /// A `~` is an expansion only where a shell reads one: at the start of a
    /// word. `a~b` is three characters, and refusing it would refuse a filename
    /// that merely contains a tilde.
    #[test]
    fn a_tilde_only_expands_at_the_start_of_a_word() {
        let device = LoopbackDevice::default();
        device.reply("echo a~b");
        let text = outbox(&device);
        assert!(text.contains("a~b"), "{text:?}");
        // At a word start it is the expansion this shell cannot do.
        let device = LoopbackDevice::default();
        device.reply("echo ~/x");
        let text = outbox(&device);
        assert!(
            text.contains("simple commands only"),
            "a home path was accepted: {text:?}"
        );
    }
}
