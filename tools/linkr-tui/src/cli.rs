//! The command line's own shape: one table, two readers.
//!
//! Usage text and shell completion are the same list looked at twice, which is
//! why they live next to each other rather than in a help string here and a
//! script there. A flag added to one and not the other is a flag that works and
//! cannot be completed on — invisible until somebody tab-completes `--lang`
//! and finds nothing, which nobody reports as a bug.
//!
//! The reference clients (`tools/linkr_ble_terminal.py`,
//! `tools/linkr_ble_terminal_c`) print scripts for the same three shells from
//! the same kind of table, so `bee --print-completion zsh` can be dropped
//! next to `linkr_ble_terminal.py --print-completion zsh` and behave.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::thread;
use std::time::{Duration, Instant};

use btleplug::api::{Central, Manager as _, Peripheral as _};
use futures::StreamExt as _;

use crate::app::App;
use btleplug::platform::Manager;

/// How a flag's value should be completed, which is also how its value reads
/// in the usage text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value {
    /// The flag takes no value at all.
    None,
    /// The value is chosen from this list, and nothing else is accepted.
    Choice,
    /// A path that must exist or be created: a completion for it is a
    /// *filename* completion, which is not the same thing as a choice list.
    File,
    /// Anything at all. Completing it offers nothing, which is still better
    /// than offering the wrong thing.
    Free,
    /// An optional value, as in `--print-frame` with or without a size.
    Optional,
}

/// One flag the command line understands.
#[derive(Debug, Clone, Copy)]
pub struct Flag {
    pub name: &'static str,
    pub value: Value,
    /// The accepted values, when [`Value::Choice`]; what a completion offers.
    pub choices: &'static [&'static str],
    /// One line, in the imperative-less style the rest of the tool uses.
    pub help: &'static str,
}

impl Flag {
    const fn new(name: &'static str, value: Value, help: &'static str) -> Flag {
        Flag {
            name,
            value,
            choices: &[],
            help,
        }
    }

    const fn with_choices(
        name: &'static str,
        choices: &'static [&'static str],
        help: &'static str,
    ) -> Flag {
        Flag {
            name,
            value: Value::Choice,
            choices,
            help,
        }
    }
}

/// Every flag, in the order the usage text lists them.
///
/// Kept in one place and `const` so it can be walked twice — once to print
/// help, once to print a completion script — and, in the tests, once more to
/// assert that nothing drifts.
pub const FLAGS: &[Flag] = &[
    Flag::new("-h", Value::None, "print this help"),
    Flag::new("--help", Value::None, "print this help"),
    Flag::new("-V", Value::None, "print the version and exit"),
    Flag::new("--version", Value::None, "print the version and exit"),
    Flag::new(
        "--licenses",
        Value::None,
        "print third-party components and licences, and exit",
    ),
    Flag::new(
        "--print-completion",
        Value::Choice,
        "print a shell completion script and exit",
    )
    ._choices(&["bash", "zsh", "fish"]),
    // Interface
    Flag::with_choices("--lang", &["zh", "en"], "interface language"),
    Flag::with_choices(
        "--theme",
        &["dark", "light", "nord", "gruvbox", "dracula", "solarized"],
        "colour theme",
    ),
    Flag::with_choices(
        "--view",
        &["terminal", "diagnostics", "network", "assistant"],
        "open on this view",
    ),
    Flag::with_choices(
        "--overlay",
        &[
            "palette", "help", "notices", "confirm", "wifi", "settings", "about", "licenses",
            "splash",
        ],
        "open on this modal",
    ),
    Flag::with_choices(
        "--state",
        &["disconnected", "connecting", "connected", "failed"],
        "preview this connection state",
    ),
    Flag::new(
        "--print-frame",
        Value::Optional,
        "render one frame as text and exit",
    ),
    Flag::new(
        "--ansi",
        Value::None,
        "with --print-frame, emit colour escapes",
    ),
    Flag::new(
        "--sample",
        Value::None,
        "fill the preview with the sample reply",
    ),
    Flag::new(
        "--feed",
        Value::Free,
        "push text through the emulator before drawing",
    ),
    // Links
    Flag::with_choices(
        "--transport",
        &["ble", "lan", "stdio"],
        "pin the link and lock it",
    ),
    Flag::new(
        "--bridge",
        Value::Free,
        "run the session over a child process; - loops back",
    ),
    Flag::new(
        "--ble-address",
        Value::Free,
        "dial the board at this Bluetooth address",
    ),
    Flag::new(
        "--ble-name",
        Value::Free,
        "dial the board whose advertised name contains this (a label the owner can change; --ble-address is the identity)",
    ),
    Flag::new(
        "--lan-host",
        Value::Free,
        "dial the bridge's WebSocket; host, host:port or ws:// URL",
    ),
    Flag::new("--lan-token", Value::Free, "the token that bridge asks for"),
    Flag::new(
        "--lan-token-file",
        Value::File,
        "read that token from a file instead",
    ),
    Flag::new(
        "--scan",
        Value::None,
        "list nearby Linkr Bee boards and exit (not every Bluetooth device)",
    ),
    Flag::new(
        "--timeout",
        Value::Free,
        "seconds for a scan to listen, or for --exec to run",
    ),
    Flag::new(
        "--connect-timeout",
        Value::Free,
        "seconds to wait for a dialled link to come up",
    ),
    // Scripting
    Flag::new(
        "--no-terminal",
        Value::None,
        "connect, run the asked-for commands, exit",
    ),
    Flag::new(
        "--cli-then-tui",
        Value::None,
        "run the asked-for commands, then open the terminal",
    ),
    Flag::new(
        "--serve",
        Value::None,
        "hold the link and answer JSON requests on stdin until it ends",
    ),
    Flag::new(
        "--json",
        Value::None,
        "write events to stdout as JSON lines",
    ),
    Flag::new("--quiet", Value::None, "suppress progress lines on stderr"),
    // Command execution, which is what a caller wiring this into something
    // else came for: one command, one definite ending, the target's own exit
    // status.
    Flag::new(
        "--exec",
        Value::Free,
        "run this shell command on the target and return its exit code",
    ),
    Flag::new(
        "--idle",
        Value::Free,
        "end --exec when its output has been quiet this long",
    ),
    Flag::new(
        "--rc-marker",
        Value::None,
        "end --exec on the status it prints (the default)",
    ),
    Flag::new(
        "--retry",
        Value::Free,
        "send --exec again up to this many times if it times out",
    ),
    Flag::new(
        "--dry-run",
        Value::None,
        "print what --exec would send, and exit",
    ),
    Flag::new(
        "--capabilities",
        Value::None,
        "print what this tool is and can do, and exit",
    ),
    Flag::new(
        "--doctor",
        Value::None,
        "check the link, the bridge, the loopback and the target once",
    ),
    Flag::with_choices(
        "--send",
        &["line", "raw"],
        "send stdin without waiting for an ending; line adds newlines",
    ),
    // The bridge itself
    Flag::new(
        "--query-info",
        Value::None,
        "ask @i? and print what the bridge answers",
    ),
    Flag::new(
        "--query-uart",
        Value::None,
        "ask @u? and print the bridge's UART settings",
    ),
    Flag::new(
        "--query-wifi",
        Value::None,
        "ask @w? and print the WiFi status",
    ),
    Flag::new(
        "--query-webdav",
        Value::None,
        "ask @d? and print the log-upload status",
    ),
    Flag::new(
        "--query-ble-name",
        Value::None,
        "ask @n? and print the advertised BLE name",
    ),
    Flag::new(
        "--query-lan",
        Value::None,
        "ask @s? and print the bridge's LAN address and token state",
    ),
    Flag::new(
        "--uart",
        Value::Free,
        "set UART as baud,data,parity,stop,flow",
    ),
    Flag::new("--wifi", Value::Free, "join a network as SSID[,PASSWORD]"),
    Flag::new(
        "--wifi-key-file",
        Value::File,
        "read that password from the first line of a file",
    ),
    Flag::new("--wifi-off", Value::None, "forget the saved WiFi network"),
    Flag::new(
        "--wifi-scan",
        Value::None,
        "list the networks the board can see",
    ),
    Flag::new(
        "--webdav",
        Value::Free,
        "set the HTTP upload URL for the log",
    ),
    Flag::new("--webdav-off", Value::None, "turn log upload off"),
    Flag::new(
        "--rename-ble",
        Value::Free,
        "set the advertised BLE name (1-29 UTF-8 bytes)",
    ),
    Flag::new(
        "--reset-ble-name",
        Value::None,
        "restore the MAC-derived advertised BLE name",
    ),
    Flag::new(
        "--loopback-test",
        Value::Optional,
        "send these bytes and require the same back",
    ),
    Flag::new(
        "--loopback-timeout",
        Value::Free,
        "seconds to wait for that echo",
    ),
    Flag::new(
        "--link-state",
        Value::None,
        "print this link's state and counters, then exit",
    ),
    // The terminal
    Flag::with_choices(
        "--enter",
        &["raw", "cr", "lf", "crlf"],
        "translate Enter before sending",
    ),
    Flag::new(
        "--local-echo",
        Value::None,
        "echo typed bytes into the pane locally",
    ),
    Flag::new(
        "--line-mode",
        Value::None,
        "hold a typed line until Enter before sending it",
    ),
    Flag::new(
        "--escape",
        Value::Free,
        "the byte that leaves, as ^] or 0x1d",
    ),
    // Records of the session
    Flag::new(
        "--log-file",
        Value::File,
        "append every byte the device sends to a file",
    ),
    Flag::new("--debug-io", Value::None, "trace both directions on stderr"),
];

impl Flag {
    /// A small builder kept private to the table above, so a choice list can
    /// never be written somewhere the completion script does not read it.
    const fn _choices(mut self, choices: &'static [&'static str]) -> Flag {
        self.value = Value::Choice;
        self.choices = choices;
        self
    }
}

/// The subcommands, and what each one is an alias of.
///
/// A subcommand is not a second command line: `bee scan` is the *same* line
/// as `bee --scan`, written as words. [`expand_subcommand`] rewrites it
/// before the one parser sees anything, so a subcommand can never mean
/// something the flag of the same name does not — there is one grammar to
/// teach, one table for the help and the completion, and one place a bug can
/// live.
///
/// The order is the order the help lists them.
pub const SUBCOMMANDS: &[(&str, &str)] = &[
    ("scan", "list nearby Bluetooth devices, and never connect"),
    (
        "doctor",
        "one checkup: the link, the bridge, the loopback, the target",
    ),
    (
        "query",
        "read one thing: info, uart, wifi, webdav, ble-name or lan",
    ),
    (
        "set",
        "change one thing and read it back: uart, wifi, webdav or ble-name",
    ),
    (
        "exec",
        "run a command on the target and bring its status back: exec -- <cmd>",
    ),
    (
        "send",
        "send without waiting for an ending: send --line, or send --raw",
    ),
    (
        "loopback",
        "send a payload and require it back: loopback <payload>",
    ),
    ("tui", "open the terminal after whatever else was asked for"),
    ("capabilities", "print what this tool is and can do"),
];

/// The subcommand `word` names, if it names one.
pub fn subcommand_named(word: &str) -> Option<&'static str> {
    SUBCOMMANDS
        .iter()
        .find(|(name, _)| *name == word)
        .map(|(name, _)| *name)
}

/// The subcommands the capability document lists.
///
/// The grammar knows `tui` in every build — a binary without the interface
/// still answers `bee tui`, with the sentence that it has no interface to
/// open — but the help and the capability document promise what *this* binary
/// can be asked for, and opening the terminal is not something it can do. The
/// same rule the operations list in `main.rs` follows, told from the one table
/// so the two lists cannot disagree about the word.
fn listed_subcommands() -> impl Iterator<Item = &'static (&'static str, &'static str)> {
    SUBCOMMANDS
        .iter()
        .filter(|(name, _)| *name != "tui" || cfg!(feature = "tui"))
}

/// The subcommand names as a JSON array, for the capability document.
pub fn subcommands_json() -> String {
    let names: Vec<String> = listed_subcommands()
        .map(|(name, _)| json_string(name))
        .collect();
    format!("[{}]", names.join(","))
}

/// The subcommand names as a line of prose, for the capability document's text.
pub fn subcommands_words() -> String {
    listed_subcommands()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether the flag at `flag` takes the word after it as its value.
///
/// `None` for a word this table does not know: an unknown flag is the parser's
/// to refuse, and the expansion only has to avoid mistaking a *value* for a
/// subcommand.
fn takes_a_value(flag: &str) -> Option<bool> {
    let known = FLAGS.iter().find(|known| known.name == flag)?;
    Some(!matches!(known.value, Value::None))
}

/// Rewrite a subcommand form of the command line into the flag form.
///
/// `bee scan --json` becomes `bee --scan --json`, `bee exec -- df -h`
/// becomes `bee --exec "df -h"`, and a line with no subcommand in it is
/// handed back untouched — which is what keeps every existing script, every
/// existing flag and every existing test working. The subcommand's own words
/// are consumed, the flags around them (before *and* after, because a global
/// flag written after the subcommand means what it says) are left where they
/// are, and the one parser reads the result.
///
/// `--` says where the flags stop and the words begin: after it everything is
/// data, even a word that looks like a flag. Written without one, the words are
/// the bare words leading, and a command that starts with a dash then needs the
/// `--` — which is exactly what it is for.
///
/// The error is a sentence for the caller: a subcommand whose words do not add
/// up is a usage error, and naming the word it wanted is the answer.
pub fn expand_subcommand(argv: Vec<String>) -> Result<Vec<String>, String> {
    // Where the subcommand is, if there is one: the first bare word that is not
    // the value of a flag before it. `--ble-name doctor` names a board called
    // doctor, and reading that value as a subcommand would be a lie about the
    // command line the caller wrote.
    let mut at = 0;
    while at < argv.len() {
        let word = argv[at].as_str();
        if takes_a_value(word) == Some(true) {
            at += 2;
            continue;
        }
        if word.starts_with('-') {
            at += 1;
            continue;
        }
        break;
    }
    let Some(name) = argv.get(at).and_then(|word| subcommand_named(word)) else {
        return Ok(argv);
    };
    let after = &argv[at + 1..];
    // The three parts a subcommand's tail can have: flags written before a
    // `--`, the words that are the data, and the flags written after them.
    let (mut before, words, mut after_flags): (Vec<String>, Vec<String>, Vec<String>) =
        match after.iter().position(|word| word == "--") {
            Some(sep) => (after[..sep].to_vec(), after[sep + 1..].to_vec(), Vec::new()),
            None => {
                let bare = after
                    .iter()
                    .take_while(|word| !word.starts_with('-'))
                    .count();
                (Vec::new(), after[..bare].to_vec(), after[bare..].to_vec())
            }
        };

    let mut translated: Vec<String> = Vec::new();
    match name {
        "scan" | "capabilities" | "doctor" | "tui" => {
            reject_words(name, &words)?;
            translated.push(
                match name {
                    "scan" => "--scan",
                    "capabilities" => "--capabilities",
                    "doctor" => "--doctor",
                    // Opening the terminal is what `--cli-then-tui` names: run
                    // what else was asked for, then take the screen. A `tui`
                    // with nothing else asked for is the plain launch.
                    _ => "--cli-then-tui",
                }
                .to_string(),
            );
        }
        "query" => {
            let [what] = one_word(name, &words)?;
            translated.push(
                match what.as_str() {
                    "info" => "--query-info",
                    "uart" => "--query-uart",
                    "wifi" => "--query-wifi",
                    "webdav" => "--query-webdav",
                    "ble-name" => "--query-ble-name",
                    "lan" => "--query-lan",
                    other => {
                        return Err(format!(
                        "query reads one of info, uart, wifi, webdav, ble-name or lan; '{other}' is not one"
                    ))
                    }
                }
                .to_string(),
            );
        }
        "set" => {
            let [what, value] = two_words(name, &words)?;
            if what == "webdav" && value.eq_ignore_ascii_case("off") {
                translated.push("--webdav-off".to_string());
            } else if what == "ble-name" && value.eq_ignore_ascii_case("default") {
                translated.push("--reset-ble-name".to_string());
            } else {
                translated.push(
                    match what.as_str() {
                        "uart" => "--uart",
                        "wifi" => "--wifi",
                        "webdav" => "--webdav",
                        "ble-name" => "--rename-ble",
                        other => {
                            return Err(format!(
                                "set changes one of uart, wifi, webdav or ble-name; '{other}' is not one"
                            ))
                        }
                    }
                    .to_string(),
                );
                translated.push(value);
            }
        }
        "loopback" => {
            let [payload] = one_word(name, &words)?;
            translated.push("--loopback-test".to_string());
            translated.push(payload);
        }
        "exec" => {
            // The words are the command. Joining them with spaces is what the
            // flag form would have received had the caller quoted them, and it
            // is the shell's own reading of an unquoted command line.
            let command = words.join(" ");
            if command.is_empty() {
                return Err("exec wants a command to run: exec -- <command>".to_string());
            }
            translated.push("--exec".to_string());
            translated.push(command);
        }
        "send" => {
            if let Some(word) = words.first() {
                return Err(format!("send takes no words; '{word}' is not one"));
            }
            // `--line` and `--raw` say how, so they are the subcommand's own
            // words in flag clothing: taken out here, where the flag form has
            // the one `--send line|raw` to keep.
            let mut chosen: Option<&'static str> = None;
            take_send_marker(&mut before, &mut chosen)?;
            take_send_marker(&mut after_flags, &mut chosen)?;
            let Some(how) = chosen else {
                return Err("send wants --line or --raw to say how".to_string());
            };
            translated.push("--send".to_string());
            translated.push(how.to_string());
        }
        _ => unreachable!("every subcommand is in the match"),
    }
    let mut out: Vec<String> = argv[..at].to_vec();
    out.extend(before);
    out.extend(translated);
    out.extend(after_flags);
    Ok(out)
}

/// Take `--line` or `--raw` out of the words it was written among, and say
/// which one was asked for. Both at once is a contradiction, and neither is a
/// `send` that never said how.
fn take_send_marker(
    words: &mut Vec<String>,
    chosen: &mut Option<&'static str>,
) -> Result<(), String> {
    let mut kept = Vec::with_capacity(words.len());
    for word in words.drain(..) {
        match word.as_str() {
            "--line" | "--raw" => {
                let how = if word == "--line" { "line" } else { "raw" };
                match *chosen {
                    // Writing the same marker twice says the same thing twice,
                    // which is what every other flag on this command line lets
                    // a caller do; only the two different markers contradict.
                    Some(already) if already != how => {
                        return Err("send takes --line or --raw, not both".to_string())
                    }
                    _ => *chosen = Some(how),
                }
            }
            _ => kept.push(word),
        }
    }
    *words = kept;
    Ok(())
}

fn reject_words(name: &str, words: &[String]) -> Result<(), String> {
    match words.first() {
        Some(word) => Err(format!("{name} takes no words; '{word}' is not one")),
        None => Ok(()),
    }
}

fn one_word(name: &str, words: &[String]) -> Result<[String; 1], String> {
    match words {
        [word] => Ok([word.clone()]),
        [] => Err(format!("{name} wants one word after it")),
        _ => Err(format!(
            "{name} takes one word; {} is too many",
            words.len()
        )),
    }
}

fn two_words(name: &str, words: &[String]) -> Result<[String; 2], String> {
    match words {
        [first, second] => Ok([first.clone(), second.clone()]),
        [] | [_] => Err(format!(
            "{name} wants two words: what to change, and to what"
        )),
        _ => Err(format!(
            "{name} takes two words; {} is too many",
            words.len()
        )),
    }
}

/// The usage text, generated from the table rather than written beside it.
///
/// Two columns like the reference clients': a flag and what it does. Generated
/// because a hand-written block next to a machine-read list is how the two come
/// to disagree — and the disagreement is always in the newest flag, which is
/// the one most people are trying to use.
pub fn usage(prog: &str, about: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "{about}");
    let _ = writeln!(out);
    let _ = writeln!(out, "Usage: {prog} [OPTIONS]");
    let _ = writeln!(out, "       {prog} <SUBCOMMAND> [OPTIONS]");
    let _ = writeln!(out);
    // The subcommands are the same flags in words. One table, printed from —
    // see `SUBCOMMANDS` — and the list is what this build can actually do:
    // a CLI-only binary does not offer to open a terminal it does not have.
    let _ = writeln!(
        out,
        "Subcommands (the same runs, written as words; one per command line):"
    );
    let subcommand_width = listed_subcommands()
        .map(|(name, _)| name.len())
        .max()
        .unwrap_or(0);
    for (name, about) in listed_subcommands() {
        let _ = writeln!(out, "  {name:subcommand_width$}  {about}");
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "Options:");
    let width = FLAGS
        .iter()
        .map(|flag| flag.name.len() + flag.value_width())
        .max()
        .unwrap_or(0);
    for flag in FLAGS {
        let mut rendered = flag.name.to_string();
        match flag.value {
            Value::None => {}
            Value::Optional => {
                rendered.push_str(" [");
                rendered.push_str(flag.value_name());
                rendered.push(']');
            }
            _ => {
                rendered.push(' ');
                rendered.push_str(flag.value_name());
            }
        }
        let _ = writeln!(out, "  {:<width$}  {}", rendered, flag.help, width = width);
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "A LAN token may also come from $LINKR_LAN_TOKEN, or from a token remembered for
that bridge. It is never echoed: anything the bridge says about itself has the
token scrubbed before it reaches the screen, the notices or the log."
    );
    if !cfg!(feature = "tui") {
        // The flags above are one table for both builds — the help and the
        // completion scripts read it — so the one thing that differs between
        // them is said here, in the build where it is true.
        let _ = writeln!(
            out,
            "\nThis build has no interface: --enter, --local-echo, --line-mode,
--escape and --cli-then-tui are refused, not ignored."
        );
    }
    out
}

impl Flag {
    /// How the value reads in a completion script's label.
    fn value_name(&self) -> &'static str {
        match self.value {
            Value::None => "",
            Value::File => "PATH",
            // Named per flag rather than once for all of them: the two
            // optional values are a terminal size and a byte string, and a
            // metavariable that said `COLSxROWS` on `--loopback-test` would be
            // telling whoever is typing it the wrong thing to type.
            Value::Optional => {
                if self.name == "--print-frame" {
                    "COLSxROWS"
                } else {
                    "VALUE"
                }
            }
            _ => {
                if self.name == "--print-completion" {
                    "SHELL"
                } else {
                    "VALUE"
                }
            }
        }
    }

    /// How wide the metavariable is, for aligning the usage text.
    fn value_width(&self) -> usize {
        match self.value {
            Value::None => 0,
            // `[`, `]` and the space before the metavariable.
            Value::Optional => self.value_name().len() + 3,
            _ => self.value_name().len() + 1,
        }
    }

    /// "--ble-write-size" -> "ble write size", the way zsh labels a value.
    fn zsh_label(&self) -> String {
        if self.value == Value::None {
            return String::new();
        }
        let trimmed = self.name.trim_start_matches('-');
        if trimmed.is_empty() {
            return self.value_name().to_string();
        }
        trimmed.replace('-', " ")
    }

    fn zsh_spec(&self) -> String {
        let help = self
            .help
            .replace('\\', "\\\\")
            .replace('[', "\\[")
            .replace(']', "\\]");
        let label = self.zsh_label();
        let argument = match self.value {
            Value::None => String::new(),
            Value::Choice => {
                let choices: Vec<String> = self.choices.iter().map(|c| shell_quote(c)).collect();
                format!(":{label}:({})", choices.join(" "))
            }
            Value::File => format!(":{label}:_files"),
            Value::Free => format!(":{label}:"),
            Value::Optional => format!("::{label}:"),
        };
        format!("{}[{help}]{argument}", self.name)
    }
}

/// The shells a completion script can be printed for.
pub const COMPLETION_SHELLS: [&str; 3] = ["bash", "zsh", "fish"];

/// Print a completion script for `shell`, or `None` if it is not one we know.
///
/// Generated from [`FLAGS`] at run time so a new flag completes itself: nothing
/// here has to be edited when one is added, which is the entire reason the
/// table exists.
pub fn completion_script(shell: &str, prog: &str) -> Option<String> {
    match shell {
        "bash" => Some(bash_completion(prog)),
        "zsh" => Some(zsh_completion(prog)),
        "fish" => Some(fish_completion(prog)),
        _ => None,
    }
}

/// Escape one single-quoted string for a shell script — the quoting every one
/// of these three shells uses for a literal.
fn shell_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// The function name a completion serves under: one per program name, so two
/// builds installed side by side do not fight over `_bee`.
fn function_name(prog: &str) -> String {
    let mut name = String::from("_");
    for ch in prog.chars() {
        name.push(if ch.is_ascii_alphanumeric() { ch } else { '_' });
    }
    name
}

fn bash_completion(prog: &str) -> String {
    let function = function_name(prog);
    let mut out = String::new();
    out.push_str("# bash completion for ");
    out.push_str(prog);
    out.push('\n');
    // Built by concatenation rather than by a format string, because a bash
    // completion is mostly `${...}` and `$(...)` — and escaping every brace to
    // get them past a formatter is how a script becomes unreadable and then
    // subtly wrong.
    out.push_str(&format!("{function}() {{\n"));
    out.push_str("    local cur opts\n");
    out.push_str("    cur=\"${COMP_WORDS[COMP_CWORD]}\"\n");
    out.push_str("    opts=\"");
    for flag in FLAGS {
        out.push(' ');
        out.push_str(flag.name);
    }
    out.push_str(" \"\n");
    // A `--flag=<partial>` completes to a filename where a filename belongs,
    // which is the useful default rather than silence.
    out.push_str("    case \"$cur\" in\n");
    for flag in FLAGS {
        if flag.value == Value::File {
            out.push_str(&format!(
                "        {}*) COMPREPLY=( $(compgen -f -- \"${{cur#{}=}}\") ); return 0 ;;\n",
                flag.name, flag.name
            ));
        }
    }
    out.push_str("    esac\n");
    out.push_str("    COMPREPLY=( $(compgen -W \"$opts\" -- \"$cur\") )\n");
    out.push_str("    return 0\n");
    out.push_str("}\n");
    out.push_str(&format!("complete -F {function} {prog}\n"));
    out
}

fn zsh_completion(prog: &str) -> String {
    let function = function_name(prog);
    let mut out = String::new();
    out.push_str("#compdef ");
    out.push_str(prog);
    out.push('\n');
    out.push_str(&format!("# zsh completion for {prog}\n"));
    out.push_str(&format!("{function}() {{\n"));
    out.push_str("    local -a flags\n");
    out.push_str("    flags=(\n");
    for flag in FLAGS {
        // _arguments reads each specification as one string; quote the whole
        // value so brackets, spaces and choice lists cannot become shell syntax.
        out.push_str(&format!("        {}\n", shell_quote(&flag.zsh_spec())));
    }
    out.push_str("    )\n");
    out.push_str("    _arguments \"${flags[@]}\"\n");
    out.push_str("}\n");
    out.push_str(&format!("compdef {function} {prog}\n"));
    out
}

fn fish_completion(prog: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# fish completion for {prog}");
    for flag in FLAGS {
        // fish spells a short and a long flag differently — `h` is `-s h` and
        // `help` is `-l help` — and getting that wrong is a completion that
        // silently offers nothing rather than one that fails loudly.
        let (switch, condition) = if flag.name.starts_with("--") {
            (
                format!("-l {}", &flag.name[2..]),
                format!("-l {}", &flag.name[2..]),
            )
        } else {
            (
                format!("-s {}", &flag.name[1..]),
                format!("-s {}", &flag.name[1..]),
            )
        };
        let takes_value = match flag.value {
            Value::None => "",
            // `-r` requires an argument; without it fish completes the next
            // word as another flag, and a value typed after the flag is
            // completed into an error.
            _ => " -r",
        };
        let _ = writeln!(
            out,
            "complete -c {prog} {switch}{takes_value} -d {}",
            shell_quote(flag.help)
        );
        for choice in flag.choices {
            let _ = writeln!(
                out,
                "complete -c {prog} -n '__fish_seen_argument {condition}' -a {} -d {}",
                shell_quote(choice),
                shell_quote(choice)
            );
        }
    }
    out
}

/// Read an escape byte, as `^]`, as `0x1d`, or as the byte itself.
///
/// The caret form is `^` followed by the character you would press with
/// Control held: `^]` is Control-`]`, which is `0x1d`. It is the form the
/// reference client takes and the one everybody already knows from telnet, and
/// it exists because `0x1d` is not a thing anyone can remember.
///
/// A lone `^` is refused rather than read as a literal: it is unambiguously
/// the start of the caret form, and reading it as a byte would quietly make
/// `--escape ^` mean "leave when I type a caret".
pub fn parse_escape(value: &str) -> Result<u8, String> {
    const WRONG: &str = "escape must be one byte, like ^] or 0x1d";
    if value == "^" {
        return Err(WRONG.to_string());
    }
    if let Some(letter) = value.strip_prefix('^') {
        let mut chars = letter.chars();
        let Some(only) = chars.next() else {
            return Err(WRONG.to_string());
        };
        if chars.next().is_some() || !only.is_ascii() {
            return Err(WRONG.to_string());
        }
        // Control-<letter> is the letter's code with its two high bits
        // cleared, which is why `^]` and `^_` land where they do and why the
        // form cannot express every byte — `^@` is NUL and nothing else.
        return Ok(only as u8 & 0x1f);
    }
    if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        let parsed = u32::from_str_radix(digits, 16)
            .map_err(|_| "hex escape must be between 0x00 and 0xff".to_string())?;
        if parsed > 0xff {
            return Err("hex escape must be between 0x00 and 0xff".to_string());
        }
        return Ok(parsed as u8);
    }
    let raw = value.as_bytes();
    if raw.len() != 1 {
        return Err(WRONG.to_string());
    }
    Ok(raw[0])
}

/// One device seen while scanning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundDevice {
    /// The advertised name, when it advertised one.
    pub name: Option<String>,
    /// Where the device is, as the platform spells an address — a MAC on
    /// BlueZ, as in `FB:F6:91:14:33:3A`. This is the one spelling that names
    /// the device everywhere: what the rows show, what `--ble-address` takes,
    /// what the shelf remembers, and what a dial is matched against, because
    /// it is the address a dial matches — see
    /// `transport::ble::Selection::accepts`.
    ///
    /// It is deliberately *not* the platform's internal identifier: BlueZ
    /// identifies a device by the path it keeps it under (`hci0/dev_FB_…`),
    /// and a path shown where an address belongs is a device name nobody can
    /// match against anything.
    pub address: String,
    /// Whether the advertisement identifies a Linkr Bee. New firmware is
    /// identified by the Linkr Management Service and confirmed by its Device
    /// ID after connecting; the oldest NUS-only firmware remains identified
    /// by its fixed legacy name. See [`crate::transport::ble::is_board`].
    pub board: bool,
    /// How strong the advertisement was heard, in dBm. `None` when the
    /// adapter's own report had no reading — a fresh scan on a busy adapter
    /// can hear a device before it has a number for it.
    pub rssi: Option<i16>,
}

/// Which answer a scan is after.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Until {
    /// Everything the room has to say, until `timeout` runs out: the `--scan`
    /// list and the picker's own scan, where the user asked what is around.
    TheWindowEnds,
    /// The first board that can be dialled, or `timeout`: the startup dial's
    /// scan, where a second board nobody asked about is not worth the wait of
    /// the whole window.
    ABoardAnswers,
}

/// Listen for `timeout` and report every Linkr Bee that answered.
///
/// The scan is the one command that answers a question nothing else can — "is
/// the board on the air at all". New firmware is selected by the Linkr
/// Management Service; the oldest NUS-only firmware is still listed when it
/// uses its fixed `Linkr BLE UART` name. A new name alone is never enough.
pub fn scan_devices(timeout: Duration) -> Result<Vec<FoundDevice>, String> {
    drain_scan(scan_stream(timeout, Until::TheWindowEnds))
}

/// Listen until the first board answers, or `timeout` runs out.
///
/// The shape the startup dial runs. The same list comes back, but the scan
/// ends the moment a board is heard: a board in range answers
/// within a scan interval or two, and waiting out the whole window for a
/// second board that may not exist is the difference between a start that
/// feels instant and one the user goes looking at the radio for. A bench with
/// two boards is what the `--scan` list is for, where the user asked.
pub fn scan_first_board(timeout: Duration) -> Result<Vec<FoundDevice>, String> {
    drain_scan(scan_stream(timeout, Until::ABoardAnswers))
}

/// One line of a scan in flight.
///
/// A scan is slow the way a conversation is slow: the radio waits, then
/// something answers, and a list that only appears when the window closes
/// makes every wait look like nothing happening. The stream is what lets a
/// caller show what the adapter has heard *while* it is still listening —
/// `--scan` prints each device as it arrives, and the interface's picker
/// fills while its dialog is open.
pub enum ScanEvent {
    /// Everything heard so far, posted whenever the set of devices changes.
    /// Sorted the way the final list is, so a live list and a finished one
    /// read the same.
    Seen(Vec<FoundDevice>),
    /// The scan is over, and this is the final list.
    Done(Vec<FoundDevice>),
    /// The scan could not run. Carried here because a scan that fails part
    /// way — the adapter is pulled, the manager dies — has no list to end
    /// with and would otherwise look like a scan that heard nothing.
    Failed(String),
}

/// Run a scan on a thread of its own and post what it hears as it hears it.
///
/// The channel is the whole interface: [`ScanEvent::Seen`] whenever the set
/// of devices changes, then exactly one [`ScanEvent::Done`] or
/// [`ScanEvent::Failed`]. A caller that only wants the answer drains it with
/// [`scan_devices`]; one that wants to show progress reads it as it goes.
pub fn scan_stream(timeout: Duration, until: Until) -> std::sync::mpsc::Receiver<ScanEvent> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let last = match listen(timeout, until, &tx) {
            Ok(devices) => ScanEvent::Done(devices),
            Err(why) => ScanEvent::Failed(why),
        };
        let _ = tx.send(last);
    });
    rx
}

/// Read a scan stream to its answer, ignoring what it saw on the way.
fn drain_scan(rx: std::sync::mpsc::Receiver<ScanEvent>) -> Result<Vec<FoundDevice>, String> {
    while let Ok(event) = rx.recv() {
        match event {
            ScanEvent::Seen(_) => {}
            ScanEvent::Done(devices) => return Ok(devices),
            ScanEvent::Failed(why) => return Err(why),
        }
    }
    // The sender drops without an answer only when the scan's own thread
    // died, which the old join reported as a panic.
    Err("the scan's own thread panicked".to_string())
}

/// How often the scan's results are looked at while a scan is listening.
///
/// BlueZ reports an advertisement as soon as it hears one, so a quarter of a
/// second is invisible to the user and kind to the radio.
const SCAN_POLL: Duration = Duration::from_millis(250);

/// How long the listener's stream must be quiet before the replay of devices
/// the daemon already knows can be called over.
///
/// The replay is handed over the moment the stream is first read, so this is
/// not a wait so much as a full stop: it is the silence between the memory and
/// the air that starts the scan. See [`forget_the_memory`].
const A_QUIET_MOMENT: Duration = Duration::from_millis(250);

/// How long a finished scan spends letting its D-Bus housekeeping run before
/// the reactor it ran on goes away. See the end of [`listen`].
const THE_LAST_MOMENT: Duration = Duration::from_millis(50);

/// How long the drain at the end of a scan may go on at most, quiet or not:
/// the adapter is shared, and another program's discovery keeps this stream
/// talking. One scan's packing up may not wait out another's radio.
const A_LONGER_MOMENT: Duration = Duration::from_secs(1);

/// The body both scans share: one reactor of its own on its own thread, for the
/// same reason the BLE link builds one — this program is synchronous and the
/// radio library is not.
fn listen(
    timeout: Duration,
    until: Until,
    tx: &std::sync::mpsc::Sender<ScanEvent>,
) -> Result<Vec<FoundDevice>, String> {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(why) => return Err(format!("the scan could not be started: {why}")),
    };
    runtime.block_on(async move {
        let manager = match Manager::new().await {
            Ok(manager) => manager,
            Err(why) => return Err(format!("no Bluetooth manager could be opened: {why}")),
        };
        let adapters = match manager.adapters().await {
            Ok(adapters) => adapters,
            Err(why) => return Err(format!("no Bluetooth adapter could be listed: {why}")),
        };
        let Some(adapter) = adapters.into_iter().next() else {
            return Err(
                "this machine has no Bluetooth adapter — one is needed to look for the board"
                    .to_string(),
            );
        };
        // A scan is evidence, not memory. The adapter's event stream opens
        // with a replay of every device the daemon already knows — boards
        // switched off days ago included — so the replay is drained before
        // discovery starts: from that moment on, every event really was heard
        // on the air just now.
        let mut events = adapter
            .events()
            .await
            .map_err(|why| format!("the scan could not be listened to: {why}"))?;
        forget_the_memory(&mut events).await;
        let listening = crate::transport::ble::Listening::begin(&adapter).await?;

        // The listening itself — and then, whatever it returned, the packing up
        // below. The order the scan lets go of the daemon in matters more than
        // the reason it stopped, and a scan that dies of a D-Bus error leaves
        // the same announcements in flight as one that ran its window out.
        let outcome = the_window(&adapter, &mut events, timeout, until, tx).await;
        listening.stop().await;
        // Stopping discovery is itself heard: the daemon announces a last
        // round of bookkeeping — a signal reading going back to zero for every
        // device it found — and that round lands right as the scan packs up.
        // It is read out here, while the stream still has an ear, because a
        // message that arrives for a stream already dropped takes the D-Bus
        // match rule down with it, and the task `bluez-async` sends to remove
        // that rule then looks it up and finds it gone — which the library
        // reports by panicking on a worker thread, in red, over the user's
        // terminal.
        hear_the_last_words(&mut events).await;
        // Now let go of everything that talks to the daemon while the daemon
        // is still there to be talked to. The last moment is spent letting
        // the removal each of these asks for run.
        drop(events);
        drop(listening);
        drop(adapter);
        #[cfg(target_os = "linux")]
        drop(manager);
        tokio::time::sleep(THE_LAST_MOMENT).await;
        outcome
    })
}

/// The listening half of a scan: everything until the window closes, until a
/// board answers, or until the stream gives up — the last of which ends the
/// window without answering it, because the list is then what was heard up to
/// there.
///
/// Split out of [`listen`] so that the packing up after it happens on the way
/// out of an error as well: a scan that dies halfway still has to read the
/// announcements on their way to a stream that is about to be dropped. See the
/// end of [`listen`].
async fn the_window<S>(
    adapter: &btleplug::platform::Adapter,
    events: &mut S,
    timeout: Duration,
    until: Until,
    tx: &std::sync::mpsc::Sender<ScanEvent>,
) -> Result<Vec<FoundDevice>, String>
where
    S: futures::Stream<Item = btleplug::api::CentralEvent> + Unpin,
{
    let deadline = Instant::now() + timeout;
    // What has been heard since discovery started: each device's freshest
    // reading, or `None` when the event that said it was there carried no
    // reading. A device the daemon remembers and this map does not is one
    // that was not on the air.
    let mut heard: HashMap<String, Option<i16>> = HashMap::new();
    let mut found: Vec<FoundDevice>;
    // The addresses already posted, so an unchanged list is not posted
    // again every quarter of a second: what a caller is watching for is a
    // new device appearing, not the same five devices on a timer. A device
    // that goes out of range changes the set too, and the list it is
    // missing from is as true as the one it was on.
    let mut posted: Vec<String> = Vec::new();
    loop {
        // Listen until the next look at the list, or until the window
        // closes — whichever comes first.
        let look = (Instant::now() + SCAN_POLL).min(deadline);
        let tick = tokio::time::sleep_until(look.into());
        tokio::pin!(tick);
        loop {
            tokio::select! {
                _ = &mut tick => break,
                event = events.next() => match event {
                    Some(event) => {
                        if let Some((address, rssi)) = heard_in(&event) {
                            let slot = heard.entry(address).or_insert(rssi);
                            if rssi.is_some() {
                                *slot = rssi;
                            }
                        }
                    }
                    // The stream ended — the adapter went away, or the
                    // session it was read through: the list is what was
                    // heard up to here.
                    None => break,
                },
            }
        }
        found = heard_now(adapter, &heard).await?;
        sort_found(&mut found);
        let addresses: Vec<String> = found.iter().map(|device| device.address.clone()).collect();
        if addresses != posted {
            posted = addresses;
            let _ = tx.send(ScanEvent::Seen(found.clone()));
        }
        if (until == Until::ABoardAnswers && found.iter().any(|device| device.board))
            || Instant::now() >= deadline
        {
            break;
        }
    }
    Ok(found)
}

/// Most useful first: by name, then by signal. Every row is a Linkr Bee;
/// unrelated NUS devices and new names without the management service never
/// get here.
fn sort_found(devices: &mut [FoundDevice]) {
    devices.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            // Two boards with one name are told apart by who is
            // closer: the stronger reading is the one the user is
            // probably standing next to.
            .then_with(|| right.rssi.cmp(&left.rssi))
    });
}

/// Read and throw away the stream's opening replay of every device the daemon
/// already knows.
///
/// The replay is one event for each remembered device and is handed over the
/// moment the stream is first read — a board that has been switched off for a
/// week replays exactly like one standing on the bench. The quiet moment is
/// what says the replay is over, and the scan can start counting what it hears.
async fn forget_the_memory<S>(events: &mut S)
where
    S: futures::Stream + Unpin,
{
    while let Ok(Some(_)) = tokio::time::timeout(A_QUIET_MOMENT, events.next()).await {}
}

/// Read the announcements still on their way when a scan stops, before the
/// stream that would receive them is let go.
///
/// The same loop as [`forget_the_memory`] with an end in sight: an adapter that
/// another program is scanning keeps producing events, so the drain gives up
/// after [`A_LONGER_MOMENT`] rather than sit through a stranger's radio
/// traffic. Not reading them is not an option — see the end of [`listen`].
async fn hear_the_last_words<S>(events: &mut S)
where
    S: futures::Stream + Unpin,
{
    let end = Instant::now() + A_LONGER_MOMENT;
    while Instant::now() < end {
        let quiet_left = A_QUIET_MOMENT.min(end.saturating_duration_since(Instant::now()));
        match tokio::time::timeout(quiet_left, events.next()).await {
            Ok(Some(_)) => {}
            _ => break,
        }
    }
}

/// What one event hears: the device that spoke, and the signal reading it
/// carried when it carried one. `None` for everything that is not a device
/// being heard just now — the adapter's own state, links coming and going, a
/// device that was merely remembered.
fn heard_in(event: &btleplug::api::CentralEvent) -> Option<(String, Option<i16>)> {
    use btleplug::api::CentralEvent;
    let (id, rssi) = match event {
        CentralEvent::DeviceDiscovered(id) => (id, None),
        CentralEvent::RssiUpdate { id, rssi } => (id, Some(*rssi)),
        CentralEvent::ManufacturerDataAdvertisement { id, .. }
        | CentralEvent::ServiceDataAdvertisement { id, .. }
        | CentralEvent::ServicesAdvertisement { id, .. } => (id, None),
        _ => return None,
    };
    Some((id.to_string(), rssi))
}

/// The rows for the devices heard since discovery started.
async fn heard_now(
    adapter: &btleplug::platform::Adapter,
    heard: &HashMap<String, Option<i16>>,
) -> Result<Vec<FoundDevice>, String> {
    let mut known = Vec::new();
    for candidate in adapter
        .peripherals()
        .await
        .map_err(|why| format!("the scan's results could not be read: {why}"))?
    {
        // A device that has just gone out of range cannot introduce
        // itself; that is not interesting and must not end the scan.
        let Ok(Some(properties)) = candidate.properties().await else {
            continue;
        };
        known.push((candidate.id().to_string(), properties));
    }
    Ok(rows_of_heard(heard, known))
}

/// The rule the scan exists for, on its own so it can be asserted without a
/// radio: a remembered device is listed when it was heard, and left out when
/// it was only remembered.
fn rows_of_heard(
    heard: &HashMap<String, Option<i16>>,
    known: Vec<(String, btleplug::api::PeripheralProperties)>,
) -> Vec<FoundDevice> {
    let mut found = Vec::new();
    for (id, properties) in known {
        let Some(reading) = heard.get(&id) else {
            continue;
        };
        // The picker is a Linkr Bee picker, not a dump of every radio nearby.
        // New firmware must carry the management service; the oldest images
        // are allowed through only by their fixed legacy name.
        if !crate::transport::ble::is_board(&properties.services, properties.local_name.as_deref())
        {
            continue;
        }
        found.push(FoundDevice {
            name: crate::transport::ble::display_name(properties.local_name.as_deref()),
            address: properties.address.to_string(),
            board: true,
            // The reading the advertisement that was just heard carried, or
            // the last one the daemon has on file when that event carried
            // none — an advertisement that only changed a service list, say.
            rssi: reading.or(properties.rssi),
        });
    }
    found
}

/// What the command line asked the bridge to do instead of opening a terminal.
///
/// Empty unless a flag named one of these, which is how a script run is told
/// apart from a plain launch: nobody asked for anything to be *done*, so there
/// is nothing to exit on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Requests {
    /// Reads, in the order they were asked for.
    pub queries: Vec<crate::device::Query>,
    /// `@u=<spec>`, when `--uart` named one.
    pub uart: Option<String>,
    /// `@w=<ssid>,<password>`, when `--wifi` named one.
    pub wifi: Option<(String, String)>,
    /// `@w off`.
    pub wifi_off: bool,
    /// `@w scan`.
    pub wifi_scan: bool,
    /// `@d=<url>`, when `--webdav` named one.
    pub webdav: Option<String>,
    /// `@d off`.
    pub webdav_off: bool,
    /// `@n=<name>`, when `--rename-ble` named one.
    pub ble_name: Option<String>,
    /// `@n default`.
    pub ble_name_default: bool,
}

impl Requests {
    /// Whether anything at all was asked for.
    pub fn is_empty(&self) -> bool {
        self.queries.is_empty()
            && self.uart.is_none()
            && self.wifi.is_none()
            && !self.wifi_off
            && !self.wifi_scan
            && self.webdav.is_none()
            && !self.webdav_off
            && self.ble_name.is_none()
            && !self.ble_name_default
    }
}

/// How long a dialled link has to finish coming up.
///
/// The BLE transport itself gives a dial twenty seconds before calling the
/// link dead; this waits beside the same clock rather than inventing a second
/// one.
/// How long `--scan` listens when the command line did not say.
pub const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a dialled link has to come up when the command line did not say:
/// the window a script run pumps while the link settles into "connected", and
/// the number `--connect-timeout` replaces.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// A little longer than a question's own patience.
///
/// The conversation gives up a question itself — see `device::Query::patience`
/// — and this clock is only the outer bound for the pumps in between, so it
/// must never cut off a window the conversation still holds open.
const SETTLE_SLACK: Duration = Duration::from_millis(500);

/// How a script run reports what it saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Lines a person can read, the shape the reference client prints.
    Text,
    /// One JSON object per event, one per line.
    Json,
}

/// Run every request, wait for each answer, and report.
///
/// This is `--no-terminal`: connect, do what was asked, hang up. It exists
/// because a bridge is configured far more often than it is talked to — and
/// configuring one by opening a terminal, typing `@u=115200,8,n,1,none` and
/// reading the reply off a screen is how a value gets mistyped and then
/// scripted wrong.
///
/// Each request is sent and *waited for* rather than fired off together,
/// because the bridge answers one question at a time and two outstanding ones
/// would have two `OK`s arriving in no order anyone can rely on.
pub fn run_requests(app: &mut App, requests: &Requests, format: Format, connect: Duration) -> i32 {
    app.collect_output = true;
    // The dial opened the link; the session reports itself connected a pump
    // later. Asking in between came back "not connected — nothing was sent"
    // for a link that was up a moment after the question, which is a wrong
    // answer about the one state the user had just watched come up.
    wait_for_connected(app, connect);
    let mut failed = 0;

    for query in &requests.queries {
        match app.ask_device(*query) {
            Err(why) => failed += report(format, query_name(*query), false, &why),
            Ok(()) => failed += wait_and_report(app, *query, format),
        }
    }
    // A write is followed by the read that confirms it, so what gets reported
    // is what the bridge is doing and not what it was asked to do — see
    // `App::set_uart`.
    if let Some(spec) = &requests.uart {
        match crate::accessory::parse_uart_spec(spec).and_then(|settings| app.set_uart(&settings)) {
            Err(why) => failed += report(format, "uart", false, &why),
            Ok(()) => failed += wait_and_report(app, crate::device::Query::Uart, format),
        }
    }
    if requests.wifi_off || requests.wifi.is_some() {
        let asked = requests.wifi.as_ref().map(|pair| pair.0.clone());
        let (ssid, password) = requests
            .wifi
            .as_ref()
            .map_or(("", ""), |pair| (pair.0.as_str(), pair.1.as_str()));
        match app.set_wifi(ssid, password) {
            Err(why) => failed += report(format, "wifi", false, &why),
            Ok(()) => failed += wait_and_report_wifi(app, format, asked.as_deref()),
        }
    }
    if requests.webdav_off || requests.webdav.is_some() {
        let result = match (requests.webdav_off, requests.webdav.as_deref()) {
            (true, Some(_)) => Err("choose either --webdav or --webdav-off".to_string()),
            (true, None) => app.disable_webdav(),
            (false, Some(url)) => app.set_webdav(url),
            (false, None) => unreachable!(),
        };
        match result {
            Err(why) => failed += report(format, "webdav", false, &why),
            Ok(()) => failed += wait_and_report(app, crate::device::Query::Webdav, format),
        }
    }
    if requests.ble_name.is_some() || requests.ble_name_default {
        let result = match (requests.ble_name.as_deref(), requests.ble_name_default) {
            (Some(_), true) => Err("choose either --rename-ble or --reset-ble-name".to_string()),
            (Some(name), false) => app.set_ble_name(name),
            (None, true) => app.reset_ble_name(),
            (None, false) => unreachable!(),
        };
        match result {
            Err(why) => failed += report(format, "ble-name", false, &why),
            Ok(()) => failed += wait_and_report(app, crate::device::Query::BleName, format),
        }
    }
    if requests.wifi_scan {
        match app.scan_wifi() {
            Err(why) => failed += report(format, "wifi-scan", false, &why),
            // The question carries its own long patience: a scan is the
            // board's radio working through every channel, and the ordinary
            // reply timeout would call a running scan a silent bridge.
            Ok(()) => failed += wait_and_report_scan(app, format),
        }
    }

    // What the target said while all this was going on, printed last so the
    // answers are above it: the output is a by-product here, the answers are
    // what was asked for.
    drain(app, format);
    failed
}

/// Print what the device has said since the last look, and forget it.
///
/// The checkup is the caller: it wants the device's own greeting — the banner
/// every other command prints — on screen before its first check, and the
/// round trip below deliberately discards whatever is already in flight, which
/// is right for an echo test and wrong for a greeting.
pub fn flush_output(app: &mut App, format: Format) {
    app.pump();
    drain(app, format);
}

/// How `--send` frames what arrives on standard input.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Framing {
    /// One line at a time, each ending with a newline: what a person would have
    /// typed into a terminal.
    Line,
    /// The bytes exactly as they arrive, framing and all.
    Raw,
}

impl Framing {
    /// The framing `name` asks for, if it is one this build knows.
    pub fn from_name(name: &str) -> Option<Framing> {
        match name {
            "line" => Some(Framing::Line),
            "raw" => Some(Framing::Raw),
            _ => None,
        }
    }
}

/// Send standard input to the target, printing what comes back as it comes.
///
/// This is the human-in-the-loop half of `--exec`: the caller types (or pipes)
/// what they would have typed into a terminal, and this forwards it without
/// deciding when anything has ended. There is no ending rule here and no
/// marker, because the bytes *are* the point — a `--send` that invented an
/// ending would be an `--exec` that does not bring a status back with it.
///
/// The bytes go out as the caller produces them, and the answers are printed
/// while the next line is still being typed, which is what makes it usable with
/// a person at the keyboard. The run's answer is whether all of them went out;
/// an empty standard input is a failure and not a quiet success, for the same
/// reason an empty `--exec` is (issue 01): a run that did nothing must not look
/// like one that worked.
pub fn send_stdin(app: &mut App, how: Framing, format: Format) -> i32 {
    use std::io::{BufRead, Read};

    app.collect_output = true;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut sent = 0usize;
    let mut missing = 0usize;
    // Why standard input stopped before its end, if it did: an end is `Ok(0)`,
    // and anything else that ends the loop means the rest of the answer was
    // never read — which is not the same as there being nothing to send.
    let mut unreadable: Option<std::io::Error> = None;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = if how == Framing::Line {
            match input.read_until(b'\n', &mut buffer) {
                Ok(read) => read,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => {
                    unreadable = Some(err);
                    break;
                }
            }
        } else {
            // A read at a time: `raw` has no framing of its own, so the only
            // sensible size is the one that keeps a pipe moving.
            buffer.resize(4096, 0);
            match input.read(&mut buffer) {
                Ok(read) => {
                    buffer.truncate(read);
                    read
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => {
                    unreadable = Some(err);
                    break;
                }
            }
        };
        if read == 0 {
            break;
        }
        let outgoing = match how {
            Framing::Raw => buffer.clone(),
            Framing::Line => {
                // The newline is the framing and is put back below; a carriage
                // return before it is the file's line ending, not the caller's
                // keystroke, and sending both would frame twice.
                let mut line = buffer.clone();
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                line.push(b'\n');
                line
            }
        };
        if app.send_bytes(&outgoing) {
            sent += outgoing.len();
        } else {
            missing += outgoing.len();
        }
        app.pump();
        drain(app, format);
    }
    // One last look: the answer to the last line may still be on its way, and a
    // human who just typed something expects to see the answer to *that* one
    // and not only to the ones before it.
    let deadline = Instant::now() + SETTLE_SLACK;
    while Instant::now() < deadline {
        app.pump();
        drain(app, format);
        thread::sleep(Duration::from_millis(5));
    }
    match send_detail(sent, missing, unreadable.as_ref()) {
        Ok(detail) => report(format, "send", true, &detail),
        Err(detail) => report(format, "send", false, &detail),
    }
}

/// The sentence a `send` ends with, given what happened on the way.
///
/// The three failures are different things and say so: bytes the link would
/// not take (the link went away), an input that stopped early (the run does
/// not know what it was handed), and an input with nothing in it (the run did
/// nothing, and a run that did nothing is not a success). `Ok` is the one
/// success sentence.
fn send_detail(
    sent: usize,
    missing: usize,
    unreadable: Option<&std::io::Error>,
) -> Result<String, String> {
    if missing > 0 {
        return Err(format!(
            "{sent} bytes sent, {missing} could not be sent — the link went away"
        ));
    }
    if let Some(err) = unreadable {
        // Read to an end is `Ok(0)`; this is the input itself failing (a
        // background process reading its terminal gets `EIO`), and a run whose
        // input stopped early has not sent what the caller handed it.
        return Err(if sent == 0 {
            format!("standard input could not be read: {err}")
        } else {
            format!("{sent} bytes sent, then standard input could not be read: {err}")
        });
    }
    if sent == 0 {
        return Err("standard input was empty: nothing was sent".to_string());
    }
    Ok(format!("{sent} bytes sent"))
}

/// Send `payload` and require the same bytes back.
///
/// This is the wiring test, and it is the only check that proves the round trip
/// rather than one half of it: a board that accepts writes and never sends
/// anything back looks healthy to every other command here, because every
/// other command is answered by the bridge and not by the target. The
/// loopback is answered by the target's own UART with its TX and RX joined,
/// which is the thing that has to work before any of this is useful.
///
/// The payload is matched as a *substring* of what came back, because the
/// target may well have echoed it between other output — a console that is
/// printing a prompt is still a working wire.
pub fn loopback_test(app: &mut App, payload: &[u8], timeout: Duration, format: Format) -> bool {
    match loopback_round_trip(app, payload, timeout) {
        Ok(detail) => {
            let _ = report(format, "loopback", true, &detail);
            true
        }
        Err(why) => {
            let _ = report(format, "loopback", false, &why);
            false
        }
    }
}

/// Send `payload` and require the same bytes back, handing back what was heard
/// — or the reason the round trip did not happen. `loopback_test` is this,
/// printed; the checkup is the caller that wants the answer as a value.
pub fn loopback_round_trip(
    app: &mut App,
    payload: &[u8],
    timeout: Duration,
) -> Result<String, String> {
    app.collect_output = true;
    // Anything already in flight belongs to whatever happened before the test,
    // and counting it as the echo would let a board pass without answering.
    app.take_output();
    // An empty payload would match at once — a window of length zero is found
    // at every position, including before anything arrived — and a test that
    // passes on silence is worse than no test.
    if payload.is_empty() {
        return Err("the payload is empty".to_string());
    }
    if !app.send_bytes(payload) {
        return Err(app.strings().not_connected.to_string());
    }

    let mut seen: Vec<u8> = Vec::new();
    let deadline = Instant::now() + timeout;
    loop {
        app.pump();
        for chunk in app.take_output() {
            seen.extend_from_slice(&chunk);
        }
        if seen.windows(payload.len()).any(|window| window == payload) {
            return Ok(crate::trace::debugged(payload));
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    Err(format!(
        "timed out after {} s; heard {}",
        timeout.as_secs_f64(),
        crate::trace::debugged(&seen)
    ))
}

/// Pump until a dialled link is connected enough to be asked things.
///
/// The wait is bounded by the connect window. A link that never gets there
/// is not this loop's to report: every request that follows says for itself
/// that nothing went out, which is the report a user can act on. The resident
/// session waits here too, once per dial it makes on a request's behalf.
pub(crate) fn wait_for_connected(app: &mut App, window: Duration) {
    let deadline = Instant::now() + window;
    while app.session.is_live() && !app.connected() && Instant::now() < deadline {
        app.pump();
        thread::sleep(Duration::from_millis(5));
    }
}

/// Wait for a scan's answer, and — when it failed — say why it failed.
///
/// A scan that fails says "retry in a moment", which is not a reason: the
/// reason is in the bridge's state, and a bridge whose WiFi is off fails every
/// scan for that one cause. `--query-info` would have shown it, but a caller
/// who asked for a scan should not have to also ask why it did not happen —
/// so when the failure arrives without a state behind it, the state is read
/// once, best effort, and carried into the report. The read cannot turn the
/// failure into a success: the sentence to report was captured first, and a
/// bridge that will not answer the state question either keeps its own words.
///
/// The wait is [`crate::app::scan_answer_window`] rather than one patience,
/// because a board busy with another WiFi operation refuses a scan by saying
/// nothing at all and the app asks again on its own — see [`crate::app::ScanRetry`].
/// A window sized for the first attempt alone would end the process in the
/// middle of those retries and report a busy board as a silent one.
fn wait_and_report_scan(app: &mut App, format: Format) -> i32 {
    let window = crate::app::scan_answer_window();
    let answered = settle(app, format, window);
    if !answered {
        let why = app
            .diagnostics
            .error
            .clone()
            .or_else(|| app.network.error.clone())
            .unwrap_or_else(|| "the bridge did not answer".to_string());
        return report(format, "wifi-scan", false, &with_wifi_state(app, &why));
    }
    let Some(why) = app.network.error.clone() else {
        return report_query(app, crate::device::Query::WifiScan, format);
    };
    if app.network.wifi.is_none() && app.session.is_live() {
        let patience = crate::device::Query::Wifi.patience() + SETTLE_SLACK;
        if app.ask_device(crate::device::Query::Wifi).is_ok() {
            settle(app, format, patience);
        }
    }
    let detail = with_wifi_state(app, &why);
    report(format, "wifi-scan", false, &detail)
}

/// A failure sentence, with the WiFi state it happened in when that is known.
///
/// The spelling is the one the diagnostics use (`state=off`), so the two
/// lines can be read side by side; a state already spelled in the sentence is
/// not repeated.
fn with_wifi_state(app: &App, why: &str) -> String {
    let Some(wifi) = &app.network.wifi else {
        return why.to_string();
    };
    if wifi.state.is_empty() || why.contains(&format!("state={}", wifi.state)) {
        return why.to_string();
    }
    if wifi.ssid.is_empty() {
        format!("{why} (wifi state={})", wifi.state)
    } else {
        format!("{why} (wifi state={}, ssid={})", wifi.state, wifi.ssid)
    }
}

/// Wait for one answer and print what it said. Returns 1 when it failed.
///
/// The wait is the question's own patience with a little room on top: what
/// ends it is the answer, the question's own timeout, or the link going away
/// — and the report afterwards reads whichever of those happened off the
/// state it left.
fn wait_and_report(app: &mut App, query: crate::device::Query, format: Format) -> i32 {
    if !wait_for_query(app, query, format) {
        return report(format, query_name(query), false, &why_no_answer(app));
    }
    report_query(app, query, format)
}

/// Ask one management question and wait for the answer, handing it back as a
/// value instead of printing it.
///
/// The waiting is the same waiting — the same patience, the same busy retries
/// through `App::ask_device` — because a checkup that waited differently would
/// describe a different bridge. Only the printing is the caller's, and the
/// checkup is that caller: it compares the answer with what it expects.
pub fn ask_and_wait(
    app: &mut App,
    query: crate::device::Query,
    format: Format,
) -> Result<String, String> {
    app.collect_output = true;
    app.ask_device(query)?;
    if !wait_for_query(app, query, format) {
        return Err(why_no_answer(app));
    }
    answer_of(app, query)
}

/// Wait for the answer to the question that was just asked, and say whether it
/// arrived.
///
/// A join is answered twice — an ack, then the phases of an asynchronous
/// operation — and it can be refused for busy and asked again on a later
/// beat. The wait covers the whole of that, because a write still owed an
/// attempt is a question still outstanding. Every other query ends with its
/// own patience, so the wider window costs them nothing.
fn wait_for_query(app: &mut App, query: crate::device::Query, format: Format) -> bool {
    let window = match query {
        crate::device::Query::Wifi => crate::app::wifi_write_window(),
        _ => query.patience(),
    } + SETTLE_SLACK;
    settle(app, format, window)
}

/// Why a question that was asked has no answer: whatever the wait left behind
/// as the reason, or the plainest possible one.
fn why_no_answer(app: &App) -> String {
    app.diagnostics
        .error
        .clone()
        .or_else(|| app.network.error.clone())
        .unwrap_or_else(|| "the bridge did not answer".to_string())
}

/// Wait for a WiFi write to end, and report what it ended on.
///
/// A write is answered twice — an ack, and then the ending — and the ack is
/// not the outcome. The firmware takes the write and joins on its own clock,
/// so a wait that stops at the ack prints `ok:true, reply:""` ten seconds
/// before the read-back says `wifi=off`. This waits for the ending the view
/// itself waits for — `@event wifi`, or the read-back its own fallback
/// performs — and only then reads the state that ending left. A board that
/// is still connecting when the window closes is reported as unfinished
/// rather than as a success it has not reached: "not yet" and "done" are
/// different answers, and an empty line cannot tell them apart.
fn wait_and_report_wifi(app: &mut App, format: Format, ssid: Option<&str>) -> i32 {
    let window = crate::app::wifi_answer_window() + SETTLE_SLACK;
    settle(app, format, window);
    // A refusal or a failed operation already left its sentence in the view;
    // the report below prints it. What is checked here is the other ending:
    // one that arrived and said nothing.
    if app.network.error.is_none() {
        if let Some(why) = wifi_unfinished(app, ssid) {
            return report(format, "wifi", false, &why);
        }
    }
    report_query(app, crate::device::Query::Wifi, format)
}

/// Why the board is not finished with a WiFi write, when it is not; `None`
/// when it is done.
///
/// Done means the state the board reports agrees with what was asked: a join
/// that ended connected to the network it named, or a forget that ended off.
/// Everything else is an answer of its own — still connecting, dropped back
/// to off without a word, or connected to a *different* network, which is the
/// board saying "already" without the refusal to go with it.
fn wifi_unfinished(app: &App, ssid: Option<&str>) -> Option<String> {
    let s = app.strings();
    let state = app.network.wifi.as_ref().map(|wifi| wifi.state.as_str());
    match (ssid, state) {
        (Some(asked), Some("connected")) => {
            let joined = app
                .network
                .wifi
                .as_ref()
                .map(|wifi| wifi.ssid.as_str())
                .unwrap_or("");
            // A bridge that does not name the network it joined is taken at
            // its word: `ssid=-` is how "connected, name unknown" is spelled,
            // and there is nothing to compare the ask against.
            (!joined.is_empty() && !joined.eq_ignore_ascii_case(asked.trim()))
                .then(|| app.lang.wifi_failure(crate::accessory::WIFI_ALREADY))
        }
        (Some(_), Some(state)) => Some(crate::text::fill(s.net_wifi_pending, &[state.to_string()])),
        (Some(_), None) => Some(s.mgmt_no_answer.to_string()),
        (None, Some("off")) => None,
        (None, Some(state)) => Some(crate::text::fill(
            s.net_wifi_off_pending,
            &[state.to_string()],
        )),
        (None, None) => Some(s.mgmt_no_answer.to_string()),
    }
}

/// Pump until the question asked is no longer outstanding, or until `window`
/// runs out. Returns whether the wait ended on its own.
///
/// "No longer outstanding" is not the same as "answered": the conversation
/// ends a question by timing it out too, and the caller reads the difference
/// off the state that ending left. What this returns is only whether the wait
/// had to be cut off from the outside.
fn settle(app: &mut App, format: Format, window: Duration) -> bool {
    let deadline = std::time::Instant::now() + window;
    while app.waiting_on_device() {
        if std::time::Instant::now() > deadline {
            return false;
        }
        app.pump();
        drain(app, format);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // One more pump: an answer may have arrived on the tick that ended the
    // wait, and a reply known about but not folded in is a reply the report
    // would call missing.
    app.pump();
    drain(app, format);
    true
}

/// Print whatever the target said while the bridge was being asked things.
fn drain(app: &mut App, format: Format) {
    for chunk in app.take_output() {
        match format {
            Format::Text => print_raw(&chunk),
            Format::Json => println!(
                "{}",
                json_line(&[("event", "output"), ("text", &lossy(&chunk))])
            ),
        }
    }
}

pub fn print_raw(bytes: &[u8]) {
    use std::io::Write as _;
    let out = std::io::stdout();
    let mut lock = out.lock();
    let _ = lock.write_all(bytes);
    let _ = lock.flush();
}

fn query_name(query: crate::device::Query) -> &'static str {
    match query {
        crate::device::Query::Diagnostics => "info",
        crate::device::Query::Uart => "uart",
        crate::device::Query::Wifi => "wifi",
        crate::device::Query::WifiScan => "wifi-scan",
        crate::device::Query::Webdav => "webdav",
        crate::device::Query::BleName => "ble-name",
        crate::device::Query::Lan => "lan",
    }
}

/// Print one request's outcome. Returns 1 when it failed, so the exit code
/// counts failures rather than merely mentioning them.
fn report(format: Format, what: &str, ok: bool, detail: &str) -> i32 {
    match format {
        Format::Text => {
            if detail.is_empty() {
                println!("{what}: ok");
            } else {
                println!("{what}: {detail}");
            }
        }
        Format::Json => println!(
            "{}",
            json_event(&[
                ("event", Json::Text("result")),
                ("what", Json::Text(what)),
                // A boolean, not its spelling: `"ok":"false"` is a string, and
                // a script that branches on `ok` reads every string as true.
                ("ok", Json::Bool(ok)),
                ("detail", Json::Text(detail)),
            ])
        ),
    }
    if ok {
        0
    } else {
        1
    }
}

/// Print what a read came back with.
/// What one query's answer is, as text, or the reason there is none.
///
/// A read that did not arrive — nothing answered, or what answered could not be
/// read — is an error rather than an empty answer: an empty reply next to
/// `ok=false` reads as a read that came back empty rather than one that never
/// happened, which sends the reader to the wrong half of the link.
///
/// A value and not a print because the checkup (`--doctor`) is a caller: it
/// compares the answer with what it expects, and a line on standard output
/// cannot be compared.
fn answer_of(app: &App, query: crate::device::Query) -> Result<String, String> {
    let error = match query {
        crate::device::Query::Diagnostics => &app.diagnostics.error,
        _ => &app.network.error,
    };
    if let Some(why) = error {
        return Err(why.clone());
    }
    Ok(match query {
        crate::device::Query::Diagnostics => app.diagnostics.raw.join("\n"),
        crate::device::Query::Uart => app
            .baud
            .map(|baud| format!("uart={baud}"))
            .unwrap_or_default(),
        crate::device::Query::Wifi => match &app.network.wifi {
            Some(wifi) => format!("wifi={},ssid={},ip={}", wifi.state, wifi.ssid, wifi.ip),
            None => String::new(),
        },
        // One network per line, in the order the bridge heard them. The scan
        // stream's own lines (`OK accepted`, `@scan done`) are already off the
        // list — see `App`'s `scan_results`.
        crate::device::Query::WifiScan => app.network.scan_results.join("\n"),
        // The URL may embed credentials, so the answer is redacted the same
        // way the trace and the approval card are. A CLI's output goes to a
        // pipe and a pipe goes to a log.
        crate::device::Query::Webdav => match &app.network.webdav {
            Some(dav) => {
                let url = crate::accessory::redact_command(&format!("@d={}", dav.url));
                let url = url.strip_prefix("@d=").unwrap_or(&url);
                format!("webdav={},url={}", dav.state, url)
            }
            None => String::new(),
        },
        crate::device::Query::BleName => match &app.network.ble_name {
            Some(name) => format!(
                "name={},custom={}",
                name.name,
                match name.custom {
                    Some(true) => "yes",
                    Some(false) => "no",
                    None => "unknown",
                }
            ),
            None => String::new(),
        },
        // The state is reported; the token never is. A CLI's output goes to a
        // pipe and a pipe goes to a log, and a token in a log is a token that
        // has to be rotated.
        crate::device::Query::Lan => {
            if app.lan_status.ws.is_empty() {
                String::new()
            } else {
                format!(
                    "ws={},token={}",
                    app.lan_status.ws,
                    if app.lan_status.token.is_empty() {
                        "none"
                    } else {
                        "captured"
                    }
                )
            }
        }
    })
}

fn report_query(app: &App, query: crate::device::Query, format: Format) -> i32 {
    let detail = match answer_of(app, query) {
        Ok(detail) => detail,
        Err(why) => return report(format, query_name(query), false, &why),
    };
    match format {
        Format::Text => {
            if detail.is_empty() {
                println!("{}: ok", query_name(query));
            } else {
                for line in detail.lines() {
                    println!("{}: {}", query_name(query), line);
                }
            }
        }
        Format::Json => println!(
            "{}",
            json_event(&[
                ("event", Json::Text("result")),
                ("what", Json::Text(query_name(query))),
                ("ok", Json::Bool(true)),
                // Raw: the writer escapes the string, and a newline escaped
                // here first came out as a literal `\n` in the value.
                ("reply", Json::Text(&detail)),
            ])
        ),
    }
    0
}

/// One JSON value, for the events whose payload is not all text.
///
/// The exec events carry numbers a caller sorts on (`rc`, `elapsed_ms`) and
/// booleans it branches on (`ok`), so a writer that could only spell strings
/// would put quotes around values the events are meant to be read as bare.
pub enum Json<'a> {
    Text(&'a str),
    Number(i64),
    Bool(bool),
    Null,
    /// A value already spelled as JSON.
    ///
    /// For the lists and nested shapes this writer is not big enough to
    /// build — an operation list in a session's opening line — where the
    /// alternative is a second writer or a string that has to be decoded
    /// again. What goes in must be JSON: nothing here escapes it.
    Raw(&'a str),
}

/// One string as a JSON string literal, quotes and escaping included.
///
/// For the shapes this writer is not big enough to build by nesting:
/// [`Json::Raw`] values are written by hand, and a hand-written value that
/// carries text needs the same escaping as every other — a detail read off a
/// device is exactly the text that breaks a hand-written one.
pub fn json_string(text: &str) -> String {
    format!("\"{}\"", escape(text))
}

/// One JSON object on one line, escaped by hand.
///
/// Written rather than brought in as a dependency for two reasons: the payload
/// is a handful of fields of known shape, and a crate that would let a bridge's
/// answer become malformed JSON is a crate that has to be trusted with a
/// device's output for no gain.
pub fn json_event(fields: &[(&str, Json)]) -> String {
    let mut out = String::from("{");
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&escape(key));
        out.push_str("\":");
        match value {
            Json::Text(text) => {
                out.push('"');
                out.push_str(&escape(text));
                out.push('"');
            }
            Json::Number(number) => out.push_str(&number.to_string()),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Null => out.push_str("null"),
            Json::Raw(raw) => out.push_str(raw),
        }
    }
    out.push('}');
    out
}

/// The all-text shape of [`json_event`], for the events that have always been
/// plain strings.
fn json_line(fields: &[(&str, &str)]) -> String {
    let typed: Vec<(&str, Json)> = fields
        .iter()
        .map(|(key, value)| (*key, Json::Text(value)))
        .collect();
    json_event(&typed)
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Bytes as text, replacing what cannot be read rather than failing: a JSON
/// line that could not be produced is worse than one with a replacement in it.
pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A completion that offers a flag the parser has never heard of completes
    /// a command line into an error, and a flag the parser knows but the
    /// completion does not is a flag nobody will ever find. The two lists are
    /// the same list here, but the *point* of the test is the second half:
    /// adding a flag to `main.rs` and forgetting the table is the mistake this
    /// catches.
    #[test]
    fn every_flag_the_parser_matches_on_has_a_completion() {
        let source = include_str!("main.rs");
        for flag in FLAGS {
            let needle = format!("\"{}\"", flag.name);
            assert!(
                source.contains(&needle),
                "{} is advertised but never parsed: it would tab-complete into an error",
                flag.name
            );
        }
        // And the other way round: a literal flag handled by the parser that is
        // absent from the table cannot be completed.
        for quoted in quoted_flag_literals(source) {
            assert!(
                FLAGS.iter().any(|flag| flag.name == quoted),
                "{quoted} is parsed but never advertised"
            );
        }
    }

    /// A boolean is written bare and a string that spells one stays quoted:
    /// `"ok":"false"` is a string, and a script that branches on `ok` reads
    /// every string as true.
    #[test]
    fn a_boolean_is_written_bare() {
        let line = json_event(&[
            ("ok", Json::Bool(false)),
            ("live", Json::Bool(true)),
            ("rc", Json::Number(-3)),
            ("none", Json::Null),
        ]);
        assert_eq!(line, r#"{"ok":false,"live":true,"rc":-3,"none":null}"#);
        assert_eq!(
            json_event(&[("ok", Json::Text("false"))]),
            r#"{"ok":"false"}"#,
            "text that spells a boolean is still text"
        );
    }

    /// And a string with a newline in it comes out escaped once: the escaping
    /// is the writer's job, and a caller that escaped first spelled `\n` three
    /// characters wide.
    #[test]
    fn a_newline_is_escaped_once() {
        assert_eq!(
            json_event(&[("reply", Json::Text("a\nb"))]),
            r#"{"reply":"a\nb"}"#
        );
    }

    /// A join that has not ended is not a join that succeeded. The state the
    /// board reports decides — connected to the network that was asked for, or
    /// an answer of its own — and "still connecting" is its own answer, not an
    /// empty line a caller reads as success.
    #[test]
    fn a_join_is_only_done_when_the_board_says_so() {
        let mut app = App {
            lang: crate::i18n::Lang::En,
            ..App::default()
        };
        let wifi = |state: &str, ssid: &str| {
            Some(crate::accessory::WifiStatus {
                state: state.to_string(),
                ssid: ssid.to_string(),
                ip: String::new(),
            })
        };

        app.network.wifi = wifi("connected", "BenchNet");
        assert!(wifi_unfinished(&app, Some("BenchNet")).is_none());
        assert!(
            wifi_unfinished(&app, Some("benchnet")).is_none(),
            "the name is compared the way radios spell them"
        );

        // Connected to something else is the board saying "already" — the one
        // ending that arrives looking like a success and is not one.
        app.network.wifi = wifi("connected", "OtherNet");
        let why = wifi_unfinished(&app, Some("BenchNet")).expect("not the network asked for");
        assert_eq!(why, app.lang.wifi_failure(crate::accessory::WIFI_ALREADY));
        // A bridge that does not name the network it joined is taken at its
        // word: `ssid=-` is "connected, name unknown", and there is nothing to
        // compare the ask against.
        app.network.wifi = wifi("connected", "");
        assert!(wifi_unfinished(&app, Some("BenchNet")).is_none());

        // Still working, dropped to off without a word, or never read back:
        // three endings, none of them the one that was asked for.
        for state in ["connecting", "off", "dhcp"] {
            app.network.wifi = wifi(state, "");
            let why = wifi_unfinished(&app, Some("BenchNet"))
                .unwrap_or_else(|| panic!("{state} is not an ending"));
            assert!(why.contains(state), "{state} is named: {why}");
        }
        app.network.wifi = None;
        assert!(wifi_unfinished(&app, Some("BenchNet")).is_some());

        // A forget is done when it is off — and not when the board is still
        // holding a network.
        app.network.wifi = wifi("off", "");
        assert!(wifi_unfinished(&app, None).is_none());
        app.network.wifi = wifi("connected", "OtherNet");
        let why = wifi_unfinished(&app, None).expect("a forget that did not take");
        assert!(why.contains("connected"), "{why}");
    }

    /// The flag literals a hand-written parser says it accepts. Read from the
    /// source rather than from a second list, because a second list is what the
    /// drift would be made of.
    fn quoted_flag_literals(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for line in source.lines() {
            let trimmed = line.trim();
            // The parser's own shape: `"--name" => …`, or `"-h" | "--help" =>`.
            if !trimmed.starts_with('"') {
                continue;
            }
            for token in trimmed.split(" | ") {
                let literal = token.trim().trim_start_matches('"');
                if !literal.starts_with("--") && !literal.starts_with("-[a-zA-Z]") {
                    continue;
                }
                let end = literal.find('"').unwrap_or(literal.len());
                let name = &literal[..end];
                if name.starts_with('-') && (name.len() > 2 || name != "-") {
                    found.push(name.to_string());
                }
            }
        }
        found.sort();
        found.dedup();
        found
    }

    /// Each shell gets a script that names every flag, which is what "complete"
    /// means — and each names the program it was asked about, so two builds
    /// installed under different names do not overwrite each other's
    /// completion.
    #[test]
    fn each_shell_names_every_flag_and_the_program_it_serves() {
        for shell in COMPLETION_SHELLS {
            let script = completion_script(shell, "bee").expect("a script");
            for flag in FLAGS {
                // fish spells the dashes separately: `--lang` is offered as
                // `-l lang`, and `-h` as `-s h`. The flag is still the flag,
                // which is what this is checking.
                let needle = if shell == "fish" {
                    let (switch, bare) = flag
                        .name
                        .split_at(flag.name.len() - flag.name.trim_start_matches('-').len());
                    let long = switch.starts_with("--");
                    format!("-{} {}", if long { 'l' } else { 's' }, bare)
                } else {
                    flag.name.to_string()
                };
                assert!(
                    script.contains(&needle),
                    "{shell} does not offer {}: {script}",
                    flag.name
                );
            }
            assert!(script.contains("bee"), "{shell} never names the program");
            // fish has no function of its own: `complete -c` is all it needs,
            // which is why it is the one shell with nothing to name.
            if shell != "fish" {
                assert!(script.contains("_bee"), "{shell} misses its function name");
            }
        }
        assert!(completion_script("csh", "bee").is_none());
    }

    /// A program name that is not a shell identifier must not produce a broken
    /// function name: `linkr-tui` would otherwise be completed by a function
    /// nobody can define.
    #[test]
    fn a_program_with_a_dash_still_gets_a_usable_function_name() {
        let script = completion_script("bash", "linkr-tui").expect("a script");
        assert!(script.contains("_linkr_tui() {"), "{script}");
        assert!(script.contains("complete -F _linkr_tui linkr-tui"));
    }

    /// The escape byte is read in every form the reference client takes, and
    /// a lone caret is refused: it is unambiguously the start of the `^X` form,
    /// and reading it as a byte would make `--escape ^` mean "leave when I type
    /// a caret".
    #[test]
    fn an_escape_byte_is_read_in_every_form_the_reference_client_takes() {
        assert_eq!(parse_escape("^]").expect("^]"), 0x1d);
        assert_eq!(parse_escape("^C").expect("^C"), 0x03);
        assert_eq!(
            parse_escape("^c").expect("lowercase is the same chord"),
            0x03
        );
        assert_eq!(parse_escape("0x1d").expect("hex"), 0x1d);
        assert_eq!(parse_escape("]").expect("the byte itself"), b']');
        assert!(parse_escape("^").is_err(), "a lone caret is not a byte");
        assert!(parse_escape("0x1ff").is_err(), "one byte only");
        assert!(parse_escape("0xzz").is_err(), "hex that is not hex");
        assert!(parse_escape("ab").is_err(), "two characters is not a byte");
    }

    /// The default is the byte the reference client reserves, so `--escape` is
    /// a change and not a requirement.
    #[test]
    fn the_default_escape_is_the_one_the_reference_client_uses() {
        assert_eq!(parse_escape("^]").expect("parses"), 0x1d);
    }

    /// The loopback is the only check that proves the round trip: everything
    /// else here is answered by the bridge, and a board that accepts writes and
    /// never sends anything back looks healthy to all of it.
    #[test]
    fn a_loopback_passes_when_the_target_echoes_and_fails_when_it_does_not() {
        let (mut app, wire) = connected_app();
        // The device's TX and RX joined, which is what a loopback plug is.
        let plug = std::thread::spawn(move || {
            for _ in 0..400 {
                let sent = wire.take_sent();
                if !sent.is_empty() {
                    wire.feed(&sent);
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        assert!(
            loopback_test(&mut app, b"A", Duration::from_secs(2), Format::Text),
            "the same byte came back"
        );
        let _ = plug.join();

        // Silence is a failure. The timeout is short and the pass above is
        // long, so this cannot be a test that merely ran out of clock.
        let (mut app, _wire) = connected_app();
        assert!(
            !loopback_test(&mut app, b"A", Duration::from_millis(150), Format::Text),
            "nothing came back"
        );
        // An empty payload can never pass: a window of length zero is found
        // before anything arrives, so a test that accepted it would be one
        // that passes on silence.
        assert!(!loopback_test(
            &mut app,
            b"",
            Duration::from_millis(50),
            Format::Text
        ));
    }

    /// What a `send` says at the end is a small decision table, and every row
    /// is a different kind of bad — which is why the sentence cannot be built
    /// from the byte count alone: a run whose input failed does not know what
    /// it was handed, and calling that "empty" would blame the caller.
    #[test]
    fn a_send_ends_with_the_thing_that_actually_happened() {
        // The one success row reports only the count.
        assert_eq!(send_detail(8, 0, None).as_deref(), Ok("8 bytes sent"));
        // Nothing to send is a failure, for the same reason an empty `--exec`
        // is: a run that did nothing must not report that it worked.
        assert_eq!(
            send_detail(0, 0, None).unwrap_err(),
            "standard input was empty: nothing was sent"
        );
        // The link going away names how much of the caller's input was left.
        let why = send_detail(5, 3, None).expect_err("the link went away");
        assert!(why.contains("5 bytes sent, 3 could not be sent"), "{why}");
        // An input that failed is not an empty one, whether or not some bytes
        // had already gone out.
        let failed = std::io::Error::from(std::io::ErrorKind::BrokenPipe);
        let why = send_detail(0, 0, Some(&failed)).expect_err("the input failed");
        assert!(why.contains("could not be read"), "{why}");
        assert!(why.contains("broken pipe"), "{why}");
        assert!(!why.contains("empty"), "{why}");
        let why = send_detail(4, 0, Some(&failed)).expect_err("the input failed");
        assert!(why.starts_with("4 bytes sent, then"), "{why}");
    }

    /// An app on the end of an in-memory link, which is what a script run is
    /// driven by here: no radio, and the pump is pumped by hand.
    fn connected_app() -> (App, crate::transport::testing::MemoryLink) {
        let mut app = App::default();
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !app.connected() && Instant::now() < deadline {
            app.pump();
            thread::sleep(Duration::from_millis(2));
        }
        assert!(app.connected(), "the memory link opens");
        (app, wire)
    }

    /// A dialled link is not asked anything until the session says it is
    /// connected. The bug this pins: a script run sent its first request
    /// between the dial and the session's own connected state, and the answer
    /// was "not connected — nothing was sent" for a link that was up a moment
    /// later.
    #[test]
    fn a_dialled_link_is_waited_for_before_it_is_asked() {
        let mut app = App::default();
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(
            !app.connected(),
            "the state arrives with a pump, not with the dial"
        );
        wait_for_connected(&mut app, Duration::from_secs(2));
        assert!(app.connected(), "and the wait was what brought it");
    }

    /// Values the shell could offer are listed once, so `--transport` completes
    /// to the three links that exist and nothing invented.
    #[test]
    fn choices_are_offered_everywhere_a_value_is_chosen() {
        let transport = FLAGS
            .iter()
            .find(|flag| flag.name == "--transport")
            .expect("documented");
        assert_eq!(transport.choices, &["ble", "lan", "stdio"]);
        let zsh = completion_script("zsh", "bee").expect("script");
        assert!(zsh.contains(&shell_quote(&transport.zsh_spec())), "{zsh}");

        // The theme choices are the themes: a palette that cannot be named on
        // the command line is a palette half-shipped.
        let theme = FLAGS
            .iter()
            .find(|flag| flag.name == "--theme")
            .expect("documented");
        let named: Vec<&str> = crate::theme::THEMES
            .iter()
            .map(|choice| choice.as_str())
            .collect();
        assert_eq!(theme.choices, named.as_slice());
    }

    /// Help and completion come from the same table, so they cannot disagree
    /// about what a flag is called — and every flag appears in the usage text.
    #[test]
    fn usage_lists_the_same_flags_the_completion_does() {
        let text = usage("bee", "about line");
        for flag in FLAGS {
            assert!(
                text.contains(flag.name),
                "usage omits {}: {text}",
                flag.name
            );
            assert!(
                text.contains(flag.help),
                "usage omits {}\u{2019}s help",
                flag.name
            );
        }
        assert!(text.starts_with("about line"));
        assert!(text.contains("Usage: bee [OPTIONS]"));
    }

    /// Words with a quote in them must not end the string early: a flag's help
    /// is a quoted string in three different shells and a parenthesis is legal
    /// in every one of them.
    #[test]
    fn a_value_with_an_apostrophe_survives_being_quoted() {
        assert_eq!(shell_quote("don't"), "'don'\\''t'");
        assert_eq!(shell_quote("plain"), "'plain'");
    }

    /// A subcommand is the flag it stands for, word for word. Written as a
    /// table because that is what it is: the expansion is the whole
    /// implementation, and each row is one promise `--help` makes.
    #[test]
    fn a_subcommand_expands_into_the_flag_it_stands_for() {
        let cases: &[(&[&str], &[&str])] = &[
            (&["scan"], &["--scan"]),
            (&["scan", "--json"], &["--scan", "--json"]),
            (&["capabilities"], &["--capabilities"]),
            (&["doctor"], &["--doctor"]),
            (&["tui"], &["--cli-then-tui"]),
            (&["query", "info"], &["--query-info"]),
            (&["query", "uart"], &["--query-uart"]),
            (&["query", "wifi"], &["--query-wifi"]),
            (&["query", "webdav"], &["--query-webdav"]),
            (&["query", "ble-name"], &["--query-ble-name"]),
            (&["query", "lan"], &["--query-lan"]),
            (&["query", "info", "--json"], &["--query-info", "--json"]),
            (
                &["set", "uart", "115200,8,n,1,none"],
                &["--uart", "115200,8,n,1,none"],
            ),
            (
                &["set", "wifi", "Bench,secret"],
                &["--wifi", "Bench,secret"],
            ),
            (
                &["set", "webdav", "http://dav.example/logs/"],
                &["--webdav", "http://dav.example/logs/"],
            ),
            (&["set", "webdav", "off"], &["--webdav-off"]),
            (
                &["set", "ble-name", "Bench Bee"],
                &["--rename-ble", "Bench Bee"],
            ),
            (&["set", "ble-name", "测试😀"], &["--rename-ble", "测试😀"]),
            (&["set", "ble-name", "default"], &["--reset-ble-name"]),
            (&["exec", "--", "df", "-h"], &["--exec", "df -h"]),
            (&["exec", "--", "echo", "hi"], &["--exec", "echo hi"]),
            (
                &["exec", "--timeout", "15", "--", "df -h"],
                &["--timeout", "15", "--exec", "df -h"],
            ),
            (&["loopback", "AB"], &["--loopback-test", "AB"]),
            (&["send", "--line"], &["--send", "line"]),
            (&["send", "--raw"], &["--send", "raw"]),
            // The same framing said twice is the same framing; only the two
            // different ones contradict (see the refusal test below).
            (&["send", "--line", "--line"], &["--send", "line"]),
            (
                &["--quiet", "send", "--raw", "--json"],
                &["--quiet", "--send", "raw", "--json"],
            ),
            (
                &["--ble-name", "UART-1", "exec", "--", "uname -a"],
                &["--ble-name", "UART-1", "--exec", "uname -a"],
            ),
            // A word that names a subcommand is translated wherever it is a
            // *word*: `--scan doctor` is a batch, and the caller wrote the same
            // thing as `--scan --doctor`.
            (&["--scan", "doctor"], &["--scan", "--doctor"]),
        ];
        for (written, expected) in cases {
            let argv: Vec<String> = written.iter().map(|word| word.to_string()).collect();
            let expanded = expand_subcommand(argv).expect("the words add up");
            let wanted: Vec<String> = expected.iter().map(|word| word.to_string()).collect();
            assert_eq!(expanded, wanted, "{written:?}");
        }
    }

    /// The flag form is the one every existing script uses, and it is handed
    /// back untouched — including a flag whose *value* is a subcommand's name:
    /// a board called `doctor` is a board called doctor.
    #[test]
    fn the_flag_form_is_left_alone() {
        for written in [
            &["--query-info"][..],
            &["--ble-name", "doctor", "--query-info"],
            &["--exec", "scan"],
            &["--send", "line"],
        ] {
            let argv: Vec<String> = written.iter().map(|word| word.to_string()).collect();
            assert_eq!(
                expand_subcommand(argv.clone()).expect("nothing to translate"),
                argv,
                "{written:?}"
            );
        }
    }

    /// A subcommand whose words do not add up is a usage error that names what
    /// was wanted, and never a run with half a meaning.
    #[test]
    fn a_subcommand_that_does_not_add_up_is_refused() {
        for (written, wanted) in [
            (&["query"][..], "wants one word"),
            (&["query", "nope"], "not one"),
            (&["query", "info", "uart"], "takes one word"),
            (&["set", "webdav"], "two words"),
            (&["set", "uart"], "two words"),
            (&["set", "uart", "a", "b"], "two words"),
            (&["exec"], "wants a command"),
            (&["loopback"], "wants one word"),
            (&["scan", "everything"], "takes no words"),
            (&["send"], "wants --line or --raw"),
            (&["send", "--line", "--raw"], "not both"),
        ] {
            let argv: Vec<String> = written.iter().map(|word| word.to_string()).collect();
            let why = expand_subcommand(argv).expect_err("the words do not add up");
            assert!(why.contains(wanted), "{written:?}: {why}");
        }
    }

    /// Every expansion is written in flags the table knows, and every
    /// subcommand is in the help: the two things a reader of `--help` and a
    /// caller of `bee <word>` both depend on.
    #[test]
    fn every_subcommand_is_in_the_help_and_expands_into_real_flags() {
        let text = usage("bee", "about line");
        for (name, about) in listed_subcommands() {
            assert!(text.contains(name), "help omits {name}");
            assert!(text.contains(about), "help omits {name}'s line");
        }
        // The CLI-only build can still parse `tui` so it can explain that
        // there is no interface to open, but the help must not offer it as a
        // run this binary can perform.
        #[cfg(not(feature = "tui"))]
        assert!(!text.contains("  tui  "), "CLI help offers tui: {text}");
        // Each subcommand, expanded with no words of its own, uses only flags
        // the table lists: the arithmetic is the point, because a subcommand is
        // an alias and an alias of nothing is a bug the help cannot show.
        for (name, _) in SUBCOMMANDS {
            let argv = vec![name.to_string()];
            let Ok(expanded) = expand_subcommand(argv) else {
                // The words-taking subcommands are checked through their own
                // forms in the table above; here only the flags matter.
                continue;
            };
            for word in expanded.iter().filter(|word| word.starts_with("--")) {
                assert!(
                    FLAGS.iter().any(|flag| flag.name == word),
                    "{name} expands into {word}, which is not a flag"
                );
            }
        }
        // The document lists the aliases this build can be asked for: `tui`
        // where there is an interface to open, and not where the run would
        // only answer that there is none.
        #[cfg(feature = "tui")]
        assert_eq!(
            subcommands_json(),
            r#"["scan","doctor","query","set","exec","send","loopback","tui","capabilities"]"#
        );
        #[cfg(not(feature = "tui"))]
        assert_eq!(
            subcommands_json(),
            r#"["scan","doctor","query","set","exec","send","loopback","capabilities"]"#
        );
        #[cfg(feature = "tui")]
        assert!(subcommands_words().contains("tui"));
        #[cfg(not(feature = "tui"))]
        assert!(!subcommands_words().contains("tui"));
    }

    /// A device as the daemon lists it: its address, its name, and the last
    /// reading the daemon has for it.
    fn seen(address: &str, name: &str, rssi: Option<i16>) -> btleplug::api::PeripheralProperties {
        btleplug::api::PeripheralProperties {
            address: address.parse().expect("an address"),
            local_name: Some(name.to_string()),
            services: vec![crate::transport::ble::MGMT_SERVICE],
            rssi,
            ..Default::default()
        }
    }

    /// A scan is a question about the air, not about the daemon's memory: a
    /// board switched off yesterday is still remembered, and listing it is what
    /// sends a user to dial a board that is not there.
    #[test]
    fn only_a_device_that_was_heard_is_listed() {
        let known = vec![
            (
                "/org/bluez/hci0/dev_DA_EB_CC_48_40_1A".to_string(),
                seen("DA:EB:CC:48:40:1A", "Linkr BLE UART-1", Some(-88)),
            ),
            (
                "/org/bluez/hci0/dev_FB_F6_91_14_33_3A".to_string(),
                seen("FB:F6:91:14:33:3A", "Linkr BLE UART-3", Some(-40)),
            ),
        ];
        let heard = HashMap::from([(
            "/org/bluez/hci0/dev_FB_F6_91_14_33_3A".to_string(),
            Some(-61),
        )]);
        let rows = rows_of_heard(&heard, known);
        assert_eq!(rows.len(), 1, "the board that was not heard is not there");
        assert_eq!(
            rows[0].address, "FB:F6:91:14:33:3A",
            "the row shows the board's address, not the daemon's path for it"
        );
        assert!(rows[0].board);
        assert_eq!(
            rows[0].rssi,
            Some(-61),
            "the reading just heard beats the one the daemon has been keeping"
        );
    }

    /// A nearby keyboard, sensor, or another vendor's NUS bridge was heard,
    /// but it does not advertise the Linkr Management Service and must not
    /// appear in the Linkr Bee picker.
    #[test]
    fn a_stranger_is_not_listed_even_when_it_was_heard() {
        let mut properties = seen("AA:BB:CC:DD:EE:FF", "Some Keyboard", Some(-30));
        properties.services.clear();
        let known = vec![("/org/bluez/hci0/dev_AA".to_string(), properties)];
        let heard = HashMap::from([("/org/bluez/hci0/dev_AA".to_string(), Some(-30))]);
        assert!(rows_of_heard(&heard, known).is_empty());
    }

    /// The oldest firmware advertised NUS only and a fixed name. It has no
    /// Device ID to verify, but it is still a Linkr Bee and must remain
    /// searchable so an owner can keep using it.
    #[test]
    fn legacy_nus_only_firmware_is_still_listed() {
        let mut properties = seen("AA:BB:CC:DD:EE:FF", "Linkr BLE UART-3", Some(-30));
        properties.services = vec![crate::transport::ble::NUS_SERVICE];
        let known = vec![("/org/bluez/hci0/dev_AA".to_string(), properties)];
        let heard = HashMap::from([("/org/bluez/hci0/dev_AA".to_string(), Some(-30))]);
        let rows = rows_of_heard(&heard, known);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name.as_deref(), Some("Linkr BLE UART-3"));
        assert!(rows[0].board);
    }

    /// A new-style name is not a substitute for the Management Service.
    #[test]
    fn a_new_name_without_the_service_is_not_listed() {
        let mut properties = seen("AA:BB:CC:DD:EE:FF", "Linkr Bee 078C", Some(-30));
        properties.services = vec![crate::transport::ble::NUS_SERVICE];
        let known = vec![("/org/bluez/hci0/dev_AA".to_string(), properties)];
        let heard = HashMap::from([("/org/bluez/hci0/dev_AA".to_string(), Some(-30))]);
        assert!(rows_of_heard(&heard, known).is_empty());
    }

    /// An event that says a device is there without saying how loud it is — a
    /// service list changing, say — still means it is there; the row shows the
    /// last reading the daemon has instead of nothing.
    #[test]
    fn a_hearing_without_a_reading_still_lists_the_device() {
        let known = vec![(
            "/org/bluez/hci0/dev_FB_F6_91_14_33_3A".to_string(),
            seen("FB:F6:91:14:33:3A", "Linkr BLE UART-3", Some(-40)),
        )];
        let heard = HashMap::from([("/org/bluez/hci0/dev_FB_F6_91_14_33_3A".to_string(), None)]);
        let rows = rows_of_heard(&heard, known);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rssi, Some(-40));
    }

    /// The replay of remembered devices is over when the stream has been quiet
    /// for a moment — however much the replay carried — and a stream that says
    /// nothing at all must not hold the scan up for ever.
    #[test]
    fn the_replay_is_drained_and_a_silent_stream_ends_it() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a reactor");
        runtime.block_on(async {
            let drained = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = drained.clone();
            let mut remembered = futures::stream::iter(["a remembered board"])
                .map(move |event| {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    event
                })
                .chain(futures::stream::pending());
            forget_the_memory(&mut remembered).await;
            assert_eq!(
                drained.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "the replay is read and thrown away"
            );

            let mut silent = futures::stream::pending::<&str>();
            tokio::time::timeout(Duration::from_secs(5), forget_the_memory(&mut silent))
                .await
                .expect("a quiet stream still lets the scan start");
        });
    }
}
