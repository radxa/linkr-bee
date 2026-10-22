//! Probe a Bluetooth link: connect, send, listen, report, and hang up.
//!
//! The interface cannot be driven from a script — it wants a keyboard and a
//! terminal, and it is right to. This binary is the other half of testing:
//! the same [`BleLink`] the product dials, driven without a human, so a link
//! can be exercised on a machine nobody is sitting at.
//!
//! It exists because the interesting failures are not in the code, they are
//! in whether the board answers. Everything else in the link — the UUIDs, the
//! segmentation, the matching — is asserted against fixed input in unit tests;
//! "did it connect and did the bytes come back" cannot be.
//!
//! Usage:
//!
//! ```text
//! cargo run --example ble-probe -- --address EE:C7:42:34:48:CF \
//!     --send 'uname -a' --listen 4
//! ```
//!
//! Anything it receives is printed raw, so a target answering with a shell
//! prompt looks like a shell prompt — which is the point of printing raw.

use std::io;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use linkr_tui::transport::ble::{BleLink, Selection};
use linkr_tui::transport::Link;

fn main() -> io::Result<()> {
    let argv: Vec<String> = std::env::args().collect();
    let mut selection = Selection::Any;
    let mut payload: Vec<u8> = Vec::new();
    let mut listen = Duration::from_secs(5);

    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--name" => {
                selection = Selection::Name(next(&argv, &mut i, "--name")?);
            }
            "--address" => {
                selection = Selection::Address(next(&argv, &mut i, "--address")?);
            }
            "--send" => {
                let text = next(&argv, &mut i, "--send")?;
                // A command is what a shell expects: text and then Enter.
                let mut out = text.replace("\\r", "\r").replace("\\n", "\n");
                if !out.ends_with('\n') && !out.ends_with('\r') {
                    out.push('\r');
                }
                payload = out.into_bytes();
            }
            "--listen" => {
                let seconds: u64 = next(&argv, &mut i, "--listen")?
                    .parse()
                    .map_err(|_| arg("--listen expects a number of seconds"))?;
                listen = Duration::from_secs(seconds);
            }
            other => return Err(arg(&format!("{other} is not understood"))),
        }
        i += 1;
    }

    if let Err(why) = selection.reachable() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, why));
    }

    println!("dialling ble:{}", selection.label());
    let link = Box::new(BleLink::new(selection));
    let (mut reader, mut writer) = link.open()?;
    println!("connected");

    // Reading is a thread of its own because `read` blocks, and the bytes have
    // to be collected even while this end is still deciding what to send.
    let (heard, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || heard.send(buf[..n].to_vec()).is_err() {
                return;
            }
        }
    });

    if !payload.is_empty() {
        writer.write_all(&payload)?;
        writer.flush()?;
        println!("sent {} bytes", payload.len());
    } else {
        println!("sending nothing, listening only");
    }

    let deadline = Instant::now() + listen;
    let mut total = 0usize;
    while Instant::now() < deadline {
        // A timeout is the ordinary outcome: it is how often the deadline is
        // checked while listening.
        if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(200)) {
            total += bytes.len();
            print!("{}", String::from_utf8_lossy(&bytes));
            use std::io::Write as _;
            let _ = io::stdout().flush();
        }
    }
    println!("\n--- heard {total} bytes ---");
    Ok(())
}

/// The next argument, or a complaint shaped like every other one here.
fn next(argv: &[String], i: &mut usize, name: &str) -> io::Result<String> {
    *i += 1;
    argv.get(*i)
        .cloned()
        .ok_or_else(|| arg(&format!("a value is required for {name}")))
}

fn arg(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}
