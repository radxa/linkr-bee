//! The serial-command execution state machine, ported from
//! `web/device_executor.js`.
//!
//! The upstream executor owns device permissions and evidence: it proposes a
//! command, decides whether it needs a human click, checks the session has not
//! drifted, sends it, and then watches the log until a shell prompt returns or
//! an exit token completes. Everything that is *pure* about that — the mode
//! transitions, the approval gate, the record lifecycle, the observation
//! classifier, the full-auto window — lives here as a state machine over plain
//! data. The four I/O seams (`getStatus`, `readLog`, `sendInput`, `onRecord`)
//! are a trait, so the same machine runs against a real serial line, a pty, or
//! a scripted test double without a byte of glue changing.
//!
//! Nothing here retries, and nothing here talks to the device twice: that is
//! the upstream's whole point, and it is why a machine this small carries so
//! many "session changed / input changed / console changed" guards.

use std::collections::HashMap;

use crate::serial::console::{inspect, ConsoleKind};

/// How long Full Auto may stay armed before it reverts to Auto. A mode that
/// stays armed silently is how a tired user turns into an unattended command,
/// so the deadline is owned here rather than by the UI.
pub const FULL_AUTO_WINDOW_MS: u64 = 15 * 60 * 1000;

/// The same window as a [`Duration`], for the UI's own clock.
pub const FULL_AUTO_WINDOW: std::time::Duration =
    std::time::Duration::from_millis(FULL_AUTO_WINDOW_MS);

/// The three execution modes, matching the upstream strings exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Manual,
    FullAuto,
}

impl Mode {
    pub fn parse(value: &str) -> Result<Mode, String> {
        match value {
            "auto" => Ok(Mode::Auto),
            "manual" => Ok(Mode::Manual),
            "full-auto" => Ok(Mode::FullAuto),
            other => Err(format!("unknown execution mode: {other}")),
        }
    }

    /// The mode as the settings file spells it, and what the prompt is built
    /// from. The round partner of [`Mode::parse`].
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Manual => "manual",
            Mode::FullAuto => "full-auto",
        }
    }

    /// The next mode in the cycle, and where it starts.
    ///
    /// Auto first, because it is the recommended one; Manual last, because the
    /// cycle should end on the mode that cannot send anything.
    pub fn next(self) -> Mode {
        match self {
            Mode::Auto => Mode::FullAuto,
            Mode::FullAuto => Mode::Manual,
            Mode::Manual => Mode::Auto,
        }
    }
}

/// The externally-observed device/terminal status the machine reacts to.
#[derive(Debug, Clone, Default)]
pub struct Status {
    pub connected: bool,
    pub session_id: String,
    pub input_revision: u64,
    pub input_pending: bool,
}

/// A page of the serial log, as the ring buffer returns it.
#[derive(Debug, Clone, Default)]
pub struct LogPage {
    pub text: String,
    /// The cursor of the oldest byte still retained.
    pub start: usize,
    /// The cursor of the newest byte.
    pub cursor: usize,
    /// Whether the ring evicted bytes before `start`.
    pub truncated: bool,
}

/// The answer to `sendInput` — what revision the device acknowledged.
#[derive(Debug, Clone, Default)]
pub struct InputReceipt {
    pub input_revision: u64,
}

/// The seams the executor needs. `Clock` is split out so tests can pin time;
/// everything else is one trait so a real backend is a single struct.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// Wall-clock now, for the full-auto window and staleness.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// The backend the executor reads and writes through.
pub trait Backend {
    fn status(&self) -> Status;
    fn read_log(&self, after: usize, limit: usize) -> LogPage;
    fn send_input(
        &mut self,
        text: &str,
        append_enter: bool,
        session_id: &str,
        input_revision: u64,
    ) -> Result<InputReceipt, String>;
}

/// A caller-supplied pattern registry, mirroring the policy module's output.
#[derive(Debug, Clone, Default)]
pub struct CommandPolicy {
    pub always_ask: Vec<String>,
    pub allow: Vec<String>,
}

/// The command to run, as a caller passes it in.
#[derive(Debug, Clone)]
pub struct ExecuteArgs {
    pub text: String,
    pub append_enter: bool,
    /// A download descriptor: the executor records `partialPath`, `sha256` and
    /// `bytes` as the target reports them after a tracked command.
    pub download: Option<DownloadProbe>,
    /// When set, the completion is scanned for `TOOL:<name>:available|missing`.
    pub tool_probe: Vec<String>,
    /// When set, the completion is parsed as a device profile.
    pub profile_probe: bool,
    /// Track the exit status via a unique completion token (POSIX shell only).
    pub track_exit: bool,
}

impl Default for ExecuteArgs {
    fn default() -> Self {
        ExecuteArgs {
            text: String::new(),
            append_enter: true,
            download: None,
            tool_probe: Vec::new(),
            profile_probe: false,
            track_exit: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadProbe {
    pub partial_path: Option<String>,
    pub sha256: Option<String>,
    pub bytes: Option<u64>,
    pub status: DownloadStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadStatus {
    Pending,
    Saved,
    FailedOrUnverified,
}

impl Default for DownloadProbe {
    fn default() -> Self {
        DownloadProbe {
            partial_path: None,
            sha256: None,
            bytes: None,
            status: DownloadStatus::Pending,
        }
    }
}

/// The lifecycle of a single execution, mirroring the upstream `record`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordState {
    Proposed,
    AwaitingApproval,
    Approved,
    Sending,
    Sent,
    Denied,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    NotSent,
    Unknown,
    Sent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionStatus {
    Unknown,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    NoOutput,
    OutputObserved,
    PromptReturned,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitingFor {
    Login,
    Password,
    SudoPassword,
    Confirmation,
    Pager,
    Bootloader,
}

#[derive(Debug, Clone)]
pub struct ExecutionRecord {
    pub id: String,
    pub session_id: String,
    pub input_revision: u64,
    pub mode: Mode,
    pub console_kind: ConsoleKind,
    pub state: RecordState,
    pub delivery: Delivery,
    pub execution_status: ExecutionStatus,
    pub error: Option<String>,
    pub evidence: String,
    pub observation: Observation,
    pub waiting_for: Option<WaitingFor>,
    pub observation_closed: bool,
    pub download: Option<DownloadProbe>,
    pub exit_code: Option<u8>,
    pub log_start: usize,
    pub observed_end: usize,
    pub sent_revision: u64,
}

/// The result of an `execute` call — the record's snapshot at the moment the
/// send completed (which is before observation closes, matching upstream).
pub type ExecuteOutcome = ExecutionRecord;

/// The executor itself.
pub struct DeviceExecutor<C: Clock, B: Backend> {
    clock: C,
    backend: B,
    mode: Mode,
    mode_expires_at: u64,
    next_id: u64,
    records: Vec<ExecutionRecord>,
    active: Option<ActiveApproval>,
    profile: Option<DeviceProfile>,
    tool_capabilities: HashMap<String, ToolCapability>,
}

#[derive(Debug, Clone)]
pub struct ActiveApproval {
    pub record_id: String,
}

#[derive(Debug, Clone)]
pub struct DeviceProfile {
    pub data: String,
    pub session_id: String,
    pub cursor: usize,
    pub observed_at: u64,
    pub stale: bool,
}

#[derive(Debug, Clone)]
pub struct ToolCapability {
    pub available: bool,
    pub observed_at: u64,
    pub session_id: String,
    pub cursor: usize,
    pub stale: bool,
}

/// A snapshot of the whole executor state, for the UI.
#[derive(Debug, Clone)]
pub struct ExecutorStatus {
    pub status: Status,
    pub execution_mode: Mode,
    pub execution_mode_expires_at: u64,
    pub console_kind: ConsoleKind,
    pub profile: Option<DeviceProfile>,
    pub tool_capabilities: Vec<(String, ToolCapability)>,
}

impl<C: Clock, B: Backend> DeviceExecutor<C, B> {
    pub fn new(clock: C, backend: B) -> Self {
        DeviceExecutor {
            clock,
            backend,
            mode: Mode::Auto,
            mode_expires_at: 0,
            next_id: 0,
            records: Vec::new(),
            active: None,
            profile: None,
            tool_capabilities: HashMap::new(),
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, value: Mode) {
        // Selecting Full Auto again extends the window; other modes are a no-op
        // when already active.
        if value == self.mode && value != Mode::FullAuto {
            return;
        }
        if value != self.mode {
            self.cancel();
        }
        self.mode = value;
        if value == Mode::FullAuto {
            self.arm_full_auto();
        } else {
            self.mode_expires_at = 0;
        }
    }

    fn arm_full_auto(&mut self) {
        self.mode_expires_at = self.clock.now_ms() + FULL_AUTO_WINDOW_MS;
    }

    /// A pending approval must not survive the full-auto reversion.
    fn cancel(&mut self) {
        if self.active.is_some() {
            self.active = None;
            if let Some(record) = self
                .records
                .iter_mut()
                .find(|r| r.state == RecordState::AwaitingApproval)
            {
                record.state = RecordState::Cancelled;
                record.observation_closed = true;
            }
        }
    }

    /// Revert full-auto when its window elapses (the UI ticks this).
    pub fn expire(&mut self) {
        if self.mode == Mode::FullAuto && self.clock.now_ms() >= self.mode_expires_at {
            self.cancel();
            self.mode = Mode::Auto;
            self.mode_expires_at = 0;
        }
    }

    pub fn reset(&mut self) {
        self.cancel();
        self.mode_expires_at = 0;
        if self.mode == Mode::FullAuto {
            self.mode = Mode::Auto;
        }
        self.records.clear();
        self.profile = None;
        self.tool_capabilities.clear();
    }

    fn console_state(&self) -> (ConsoleKind, String) {
        let log = self.backend.read_log(0, 4000);
        (inspect(&log.text).kind, log.text)
    }

    /// Whether any sent record is still awaiting observation.
    pub fn needs_observation(&self) -> bool {
        self.records
            .iter()
            .any(|r| r.delivery == Delivery::Sent && !r.observation_closed)
    }

    pub fn records(&self) -> Vec<ExecutionRecord> {
        self.records
            .iter()
            .filter(|r| r.session_id == self.backend.status().session_id)
            .cloned()
            .collect()
    }

    pub fn approve(&mut self, id: &str) -> bool {
        let matches = self.active.as_ref().is_some_and(|a| a.record_id == id)
            && self
                .records
                .iter()
                .any(|r| r.id == id && r.state == RecordState::AwaitingApproval);
        if !matches {
            return false;
        }
        self.active = None;
        if let Some(record) = self.records.iter_mut().find(|r| r.id == id) {
            record.state = RecordState::Approved;
        }
        true
    }

    pub fn reject(&mut self, id: &str) -> bool {
        let matches = self.active.as_ref().is_some_and(|a| a.record_id == id)
            && self
                .records
                .iter()
                .any(|r| r.id == id && r.state == RecordState::AwaitingApproval);
        if !matches {
            return false;
        }
        self.active = None;
        if let Some(record) = self.records.iter_mut().find(|r| r.id == id) {
            record.state = RecordState::Denied;
            record.observation_closed = true;
        }
        true
    }

    /// Whether a proposed input needs a human approval in the given mode. This
    /// reuses the policy module's `requires_input_approval` and adds the
    /// console-state rule from the upstream executor: in Auto, anything that is
    /// not a clean shell prompt still needs a click.
    pub fn requires_approval(
        &self,
        mode: Mode,
        args: &ExecuteArgs,
        payload: &str,
        input_pending: bool,
        policy: &CommandPolicy,
        console: ConsoleKind,
    ) -> bool {
        let execution_mode = match mode {
            Mode::Auto => crate::exec::approval::ExecutionMode::Auto,
            Mode::Manual => crate::exec::approval::ExecutionMode::Manual,
            Mode::FullAuto => crate::exec::approval::ExecutionMode::FullAuto,
        };
        let policy = crate::exec::policy::Policy {
            always_ask: policy.always_ask.clone(),
            allow: policy.allow.clone(),
        };
        let guarded = crate::exec::approval::requires_input_approval(
            execution_mode,
            &args.text,
            payload,
            input_pending,
            args.append_enter,
            Some(&policy),
        );
        guarded || (mode == Mode::Auto && console != ConsoleKind::Shell)
    }
}

/// Build the tracked form of a command: `sh -c '…'; printf '\n%s:%s\n' TOKEN $?`.
fn tracked_command(text: &str, token: &str) -> Result<String, String> {
    let quoted = format!("'{}'", text.replace('\'', "'\\''"));
    let tracked = format!("sh -c {quoted}; printf '\\n%s:%s\\n' '{token}' \"$?\"");
    if tracked.len() > 2048 {
        return Err("tracked command is too long after shell quoting".to_string());
    }
    Ok(tracked)
}

/// The full `execute` flow, split into a pure decision + a backend call so the
/// machine is testable. Returns the record snapshot after the send.
///
/// This is intentionally *not* `async`: the caller drives it with its own
/// event loop, and between steps the caller may poll `approve`/`reject`.
pub struct PendingExecute {
    pub record: ExecutionRecord,
    pub needs_approval: bool,
    pub completion_token: Option<String>,
    pub tracked: String,
}

impl<C: Clock, B: Backend> DeviceExecutor<C, B> {
    /// Stage a command: build the record, decide approval, and return what the
    /// caller needs to either wait for approval or send immediately.
    pub fn stage(
        &mut self,
        args: &ExecuteArgs,
        policy: &CommandPolicy,
    ) -> Result<PendingExecute, String> {
        if self.active.is_some() {
            return Err("another serial action is still active".to_string());
        }
        if args.text.is_empty() || args.text.len() > 2048 {
            return Err("invalid serial input arguments".to_string());
        }
        for name in &args.tool_probe {
            let ok = !name.is_empty()
                && name.len() <= 64
                && name.chars().enumerate().all(|(i, c)| {
                    if i == 0 {
                        c.is_ascii_alphanumeric()
                    } else {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-')
                    }
                });
            if !ok {
                return Err("invalid capability probe names".to_string());
            }
        }

        let status = self.backend.status();
        if !status.connected {
            return Err("device is disconnected".to_string());
        }

        let (console_kind, _) = self.console_state();

        let (tracked, completion_token) = if args.track_exit {
            if status.input_pending || console_kind != ConsoleKind::Shell || !args.append_enter {
                return Err(
                    "tracked commands require an idle, observed POSIX shell prompt".to_string(),
                );
            }
            let token = format!("LINKR_EXIT_{}", self.next_id);
            let tracked = tracked_command(&args.text, &token)?;
            (tracked, Some(token))
        } else {
            (args.text.clone(), None)
        };

        // The wire payload: the (tracked) text plus the enter the device gets.
        let payload = if args.append_enter {
            format!("{tracked}\n")
        } else {
            tracked.clone()
        };

        self.next_id += 1;
        let record = ExecutionRecord {
            id: format!("serial-{}", self.next_id),
            session_id: status.session_id.clone(),
            input_revision: status.input_revision,
            mode: self.mode,
            console_kind,
            state: RecordState::Proposed,
            delivery: Delivery::NotSent,
            execution_status: ExecutionStatus::Unknown,
            error: None,
            evidence: String::new(),
            observation: Observation::NoOutput,
            waiting_for: None,
            observation_closed: false,
            download: args.download.clone(),
            exit_code: None,
            log_start: 0,
            observed_end: 0,
            sent_revision: 0,
        };

        let needs_approval = self.requires_approval(
            self.mode,
            args,
            &payload,
            status.input_pending,
            policy,
            console_kind,
        );

        // A guarded or non-shell command in Auto waits for a click before it
        // sends; a pre-approved query is ready to go immediately.
        let mut record = record;
        if needs_approval {
            record.state = RecordState::AwaitingApproval;
        }
        let record_id = record.id.clone();
        self.records.push(record.clone());
        // Only a record that was actually put to a person holds the slot. A
        // command that was ready to send must not leave the slot held if the
        // caller's send fails or never comes: the next `stage` would be
        // refused with "another serial action is still active" for a record
        // nobody is waiting on.
        if needs_approval {
            self.active = Some(ActiveApproval { record_id });
        }
        if self.records.len() > 50 {
            self.records.remove(0);
        }

        Ok(PendingExecute {
            record,
            needs_approval,
            completion_token,
            tracked,
        })
    }

    /// Send a staged command once it has been approved (or was never guarded).
    /// Closes older observations, marks the record sent, and returns the
    /// snapshot at the send boundary.
    pub fn send(
        &mut self,
        id: &str,
        tracked: &str,
        append_enter: bool,
    ) -> Result<ExecutionRecord, String> {
        let record = self
            .records
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or_else(|| "execution record is unavailable for this device session".to_string())?;

        // Only a record that has not been sent may be sent. A second `send` on
        // an already-sent record would type the same command into the console
        // again, which on a device is not a retry — it is a duplicate, and the
        // one thing this machine exists to make impossible.
        if !matches!(record.state, RecordState::Proposed | RecordState::Approved) {
            return Err(match record.state {
                RecordState::AwaitingApproval => {
                    "this input is still awaiting approval".to_string()
                }
                RecordState::Denied => "user rejected this input".to_string(),
                RecordState::Cancelled => "this input was cancelled".to_string(),
                RecordState::Failed => "this input already failed to send".to_string(),
                _ => "this input has already been sent".to_string(),
            });
        }

        // The decision was made before this call, so whatever the send does
        // from here — including refusing it for a stale session — the approval
        // slot is done with. Leaving it held on an error path would refuse the
        // next stage for a record nobody is waiting on, which is the same
        // wedge as a slot taken at stage time and never released.
        self.active = None;

        let status = self.backend.status();
        if !status.connected || status.session_id != record.session_id {
            return Err("device session changed; input was not sent".to_string());
        }
        if status.input_revision != record.input_revision {
            return Err("terminal input changed; request a new command before sending".to_string());
        }
        let (console_kind, _) = self.console_state();
        if console_kind != record.console_kind {
            return Err("console state changed; review a new command before sending".to_string());
        }

        // Close older observations before another command contributes output.
        for previous in self.records.iter_mut() {
            if previous.id != id {
                previous.observation_closed = true;
            }
        }

        let log_start = self.backend.read_log(0, 1).cursor;
        let receipt = self.backend.send_input(
            tracked,
            append_enter,
            &record.session_id,
            record.input_revision,
        )?;

        let record = self
            .records
            .iter_mut()
            .find(|r| r.id == id)
            .expect("record present");
        record.state = RecordState::Sent;
        record.delivery = Delivery::Sent;
        record.log_start = log_start;
        record.observed_end = log_start;
        record.sent_revision = receipt.input_revision;
        self.active = None;

        Ok(record.clone())
    }

    /// Re-classify a sent record against the current log tail.
    pub fn inspect(&mut self, id: &str) -> Option<ExecutionRecord> {
        let session_id = self.backend.status().session_id;
        let record = self.records.iter().find(|r| r.id == id).cloned()?;
        if record.session_id != session_id {
            return None;
        }
        if record.delivery != Delivery::Sent {
            return Some(record);
        }
        if record.observation_closed {
            return Some(record);
        }

        let status = self.backend.status();
        let record = if !status.connected
            || status.session_id != record.session_id
            || status.input_revision != record.sent_revision
        {
            let record = self.records.iter_mut().find(|r| r.id == id)?;
            record.observation = Observation::Interrupted;
            record.observation_closed = true;
            record.clone()
        } else {
            let observed_end = self.backend.read_log(0, 1).cursor;
            let page = self.backend.read_log(
                record.log_start,
                observed_end.saturating_sub(record.log_start),
            );
            let hint = inspect(&page.text);
            let record = self.records.iter_mut().find(|r| r.id == id)?;
            record.observed_end = observed_end;
            record.evidence = page.text.clone();
            record.observation = if page.text.is_empty() {
                Observation::NoOutput
            } else if hint.kind == ConsoleKind::Shell {
                Observation::PromptReturned
            } else {
                Observation::OutputObserved
            };
            record.waiting_for = match hint.kind {
                ConsoleKind::Login => Some(WaitingFor::Login),
                ConsoleKind::Password => Some(WaitingFor::Password),
                ConsoleKind::SudoPassword => Some(WaitingFor::SudoPassword),
                ConsoleKind::Confirmation => Some(WaitingFor::Confirmation),
                ConsoleKind::Pager => Some(WaitingFor::Pager),
                ConsoleKind::Bootloader => Some(WaitingFor::Bootloader),
                _ => None,
            };
            record.clone()
        };

        if let Some(slot) = self.records.iter_mut().find(|r| r.id == id) {
            *slot = record.clone();
        }
        Some(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, Clone)]
    struct TestBackend {
        status: Status,
        log: String,
    }

    impl TestBackend {
        fn connected() -> Self {
            TestBackend {
                status: Status {
                    connected: true,
                    session_id: "s1".to_string(),
                    input_revision: 1,
                    input_pending: false,
                },
                log: String::new(),
            }
        }
    }

    impl Backend for TestBackend {
        fn status(&self) -> Status {
            self.status.clone()
        }
        fn read_log(&self, _after: usize, _limit: usize) -> LogPage {
            LogPage {
                text: self.log.clone(),
                start: 0,
                cursor: self.log.len(),
                truncated: false,
            }
        }
        fn send_input(
            &mut self,
            _text: &str,
            _append_enter: bool,
            _session_id: &str,
            _input_revision: u64,
        ) -> Result<InputReceipt, String> {
            Ok(InputReceipt { input_revision: 1 })
        }
    }

    #[derive(Default, Clone)]
    struct TestClock {
        now: u64,
    }

    impl Clock for TestClock {
        fn now_ms(&self) -> u64 {
            self.now
        }
    }

    fn executor() -> DeviceExecutor<TestClock, TestBackend> {
        DeviceExecutor::new(TestClock { now: 0 }, TestBackend::connected())
    }

    fn executor_with_shell(log: &str) -> DeviceExecutor<TestClock, TestBackend> {
        let mut backend = TestBackend::connected();
        backend.log = log.to_string();
        DeviceExecutor::new(TestClock { now: 0 }, backend)
    }

    fn args(text: &str) -> ExecuteArgs {
        ExecuteArgs {
            text: text.to_string(),
            append_enter: true,
            ..ExecuteArgs::default()
        }
    }

    #[test]
    fn full_auto_reverts_after_its_window() {
        // A clock already past the deadline: selecting Full Auto arms the
        // window, but the deadline is computed from `now`, so we pin the
        // deadline back and the next `expire` reverts.
        let mut e = DeviceExecutor::new(TestClock { now: 1000 }, TestBackend::connected());
        e.set_mode(Mode::FullAuto);
        assert_eq!(e.mode(), Mode::FullAuto);
        // Before the deadline nothing changes.
        e.expire();
        assert_eq!(e.mode(), Mode::FullAuto);
        // Force the deadline into the past.
        e.mode_expires_at = 500;
        e.expire();
        assert_eq!(e.mode(), Mode::Auto);
        assert_eq!(e.mode_expires_at, 0);
    }

    #[test]
    fn guarded_commands_stage_for_approval() {
        let mut e = executor();
        let policy = CommandPolicy {
            always_ask: vec!["reboot".to_string()],
            allow: vec![],
        };
        let staged = e.stage(&args("sudo reboot"), &policy).unwrap();
        assert!(staged.needs_approval);
        assert_eq!(staged.record.state, RecordState::AwaitingApproval);
        // The record is registered.
        assert!(e.records().iter().any(|r| r.id == staged.record.id));
    }

    #[test]
    fn approval_and_reject_move_the_record() {
        let mut e = executor();
        let policy = CommandPolicy {
            always_ask: vec!["reboot".to_string()],
            allow: vec![],
        };
        let staged = e.stage(&args("reboot"), &policy).unwrap();
        let id = staged.record.id.clone();

        // Wrong id is a no-op.
        assert!(!e.approve("nope"));
        assert!(e.approve(&id));

        // Reject on a second staged record.
        let mut e2 = executor();
        let staged2 = e2.stage(&args("reboot"), &policy).unwrap();
        let id2 = staged2.record.id.clone();
        assert!(e2.reject(&id2));
        let rec = e2.records().into_iter().find(|r| r.id == id2).unwrap();
        assert_eq!(rec.state, RecordState::Denied);
    }

    #[test]
    fn a_send_requires_matching_session_and_console() {
        // A clean shell prompt and an allowlisted query sends without a click.
        let mut e = executor_with_shell("user@host:~$ ");
        let policy = CommandPolicy::default();
        let staged = e.stage(&args("pwd"), &policy).unwrap();
        assert!(!staged.needs_approval);
        let sent = e.send(&staged.record.id, &staged.tracked, true).unwrap();
        assert_eq!(sent.delivery, Delivery::Sent);
        assert_eq!(sent.state, RecordState::Sent);
    }

    #[test]
    fn a_send_refuses_an_unapproved_record() {
        // Without a shell prompt, even a benign echo is guarded in Auto, and
        // sending it before approval is refused.
        let mut e = executor();
        let policy = CommandPolicy::default();
        let staged = e.stage(&args("echo hi"), &policy).unwrap();
        assert!(staged.needs_approval);
        assert!(e.send(&staged.record.id, &staged.tracked, true).is_err());
        // After approval it sends.
        assert!(e.approve(&staged.record.id));
        let sent = e.send(&staged.record.id, &staged.tracked, true).unwrap();
        assert_eq!(sent.delivery, Delivery::Sent);
    }

    #[test]
    fn another_active_action_is_rejected() {
        let mut e = executor();
        let policy = CommandPolicy::default();
        let staged = e.stage(&args("echo one"), &policy).unwrap();
        let _ = staged;
        // Still active: a second stage fails.
        assert!(e.stage(&args("echo two"), &policy).is_err());
    }

    #[test]
    fn tracked_commands_require_an_idle_shell() {
        let mut e = executor();
        let policy = CommandPolicy::default();
        // Console is not a shell (empty log), so track_exit is refused.
        let mut a = args("ls");
        a.track_exit = true;
        assert!(e.stage(&a, &policy).is_err());
    }
}
