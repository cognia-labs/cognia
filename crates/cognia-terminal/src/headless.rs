//! Headless terminal execution (unattended workflow path).
//!
//! Runs shell command lines in a *real* shell with OSC 633 integration —
//! exactly like a dock tab — but the PTY lives in this process, not the
//! durable terminal host: no renderer session row, no visible tab. The
//! renderer's policy layer (`lib/terminal/headless-exec.ts`) gates every
//! call through the command-safety classifier before it reaches here.
//!
//! Two shapes:
//!   * `terminal_headless_exec` — one-shot: spawn, run one line, kill.
//!   * `terminal_headless_spawn` / `_run` / `_kill` — a persistent private
//!     session for multi-step workflow nodes (same shell, same cwd, same
//!     env across steps), tracked in [`HeadlessTerminalState`].
//!
//! Output capture: the OSC 633 `C` (command start) event opens a capture
//! window in the raw byte stream and `D` (command end, with exit code)
//! schedules it to close on the *next* data chunk (the chunk carrying `D`
//! usually also carries the tail of the command's output and the next
//! prompt). The window is then stripped of escape sequences, and a
//! trailing line without a newline (the freshly painted prompt) is
//! dropped. Best-effort by construction — when shell integration is
//! broken the run ends by timeout with the stripped raw tail instead.

// Without `tauri-host` the headless-terminal commands compile out (ADR-0196),
// leaving the state methods and imports only they use; the feature build
// still lints all of them.
#![cfg_attr(not(feature = "tauri-host"), allow(dead_code, unused_imports))]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
#[cfg(feature = "tauri-host")]
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, Mutex as TokioMutex};
use uuid::Uuid;

use super::integration::ShellKind;
use super::osc633::IntegrationEvent;
use super::session::{
    detached_desk_channel, spawn_session_with_sink, EventSink, PtySession, SessionOrigin,
    SpawnRequest, TerminalEvent,
};

/// Hard ceiling for one run's wall clock.
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Cap on the raw capture buffer per session (newest bytes kept).
const MAX_RAW_BYTES: usize = 4 * 1024 * 1024;
/// Wide columns so wrapped lines don't litter the captured output.
const HEADLESS_COLS: u16 = 200;
const HEADLESS_ROWS: u16 = 24;

// Only the real child-wait Exit event records proof. Registry removal is
// independent: performance-panel kill must remain immediate and non-waiting.
const EXIT_PROOF_CAP: usize = 4096;
#[derive(Default)]
struct ExitProofStore {
    records: HashMap<String, Instant>,
}
impl ExitProofStore {
    fn proof(&mut self, id: &str, record: bool) -> HeadlessExitProof {
        if record {
            if !self.records.contains_key(id) && self.records.len() >= EXIT_PROOF_CAP {
                let oldest = self
                    .records
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    self.records.remove(&oldest);
                }
            }
            self.records.insert(id.to_owned(), Instant::now());
        }
        if self.records.contains_key(id) {
            HeadlessExitProof::Exited
        } else {
            HeadlessExitProof::Unknown
        }
    }
}
static EXIT_PROOFS: OnceLock<StdMutex<ExitProofStore>> = OnceLock::new();
fn exit_proof(id: &str, record: bool) -> HeadlessExitProof {
    EXIT_PROOFS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .proof(id, record)
}
#[cfg(feature = "tauri-host")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessExitNotification {
    session_id: String,
}
#[cfg(feature = "tauri-host")]
fn proof_notifier<R: Runtime>(app: AppHandle<R>) -> Arc<dyn Fn(String) + Send + Sync> {
    Arc::new(move |session_id| {
        let _ = app.emit(
            "terminal:headless-exit-proof",
            HeadlessExitNotification { session_id },
        );
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessExecResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessSpawnResult {
    pub session_id: String,
    pub shell: String,
}

/// Only Exited is a successful child-wait proof. Unknown identities and
/// bounded waits must never release a Host process lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HeadlessExitProof {
    Exited,
    StillRunning,
    Unknown,
}

/// What the sink reports back to a pending `run`.
enum RunSignal {
    /// A command completed (OSC 633 D) and its capture window was drained.
    Done {
        /// Byte offset the window opened at — lets `run` discard
        /// completions for windows that began before its own write (the
        /// startup prompt's D, a previously timed-out command, …).
        start: usize,
        exit_code: Option<i32>,
        output: String,
    },
    /// The shell process itself exited — the session is dead.
    SessionExited { code: Option<u32> },
}

enum Phase {
    Idle,
    /// OSC 633 C seen — output is accumulating from `start`.
    Capturing {
        start: usize,
    },
    /// OSC 633 D seen — close the window after the next data chunk lands.
    Draining {
        start: usize,
        exit_code: Option<i32>,
    },
}

struct CaptureState {
    raw: Vec<u8>,
    truncated: bool,
    phase: Phase,
    /// Write-time anchor installed by `run` — consumed by the next
    /// CommandStart/CommandEnd so a D arriving while the phase is mid-drain
    /// (stale window) still opens *this* run's window at the right offset.
    pending_anchor: Option<usize>,
}

pub struct HeadlessSession {
    pub id: String,
    pub shell: String,
    managed: AtomicBool,
    session: PtySession,
    capture: Arc<StdMutex<CaptureState>>,
    /// Receiver half of the run-completion channel. A `run` holds this
    /// (tokio) lock for its whole duration, which also serializes runs —
    /// the PTY is single-writer.
    signals: TokioMutex<mpsc::UnboundedReceiver<RunSignal>>,
    /// Flips true on the first OSC 633 B (prompt end) — the shell is
    /// interactive and the startup banner/prompt noise is behind us.
    /// `run` waits for this before writing so the startup prompt's D can
    /// never masquerade as a command completion.
    ready: tokio::sync::watch::Receiver<bool>,
    exited: Arc<AtomicBool>,
}

struct LingeringHeadlessSession {
    id: String,
    shell: String,
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
    wait_failed: Arc<AtomicBool>,
    killer: StdMutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}
impl LingeringHeadlessSession {
    fn capture(session: &HeadlessSession) -> Self {
        let killer = session
            .session
            .killer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone_killer();
        Self {
            id: session.id.clone(),
            shell: session.shell.clone(),
            pid: session.session.pid,
            alive: session.session.alive.clone(),
            wait_failed: session.session.wait_failed.clone(),
            killer: StdMutex::new(killer),
        }
    }
    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && !self.wait_failed.load(Ordering::SeqCst)
    }
    fn observed_proof(&self) -> HeadlessExitProof {
        let alive = self.alive.load(Ordering::SeqCst);
        if self.wait_failed.load(Ordering::SeqCst) {
            HeadlessExitProof::Unknown
        } else if alive {
            HeadlessExitProof::StillRunning
        } else {
            HeadlessExitProof::Exited
        }
    }
    fn kill(&self) -> std::io::Result<()> {
        if !self.alive() {
            return Ok(());
        }
        self.killer
            .lock()
            .map_err(|_| std::io::Error::other("killer mutex poisoned"))?
            .kill()
    }
    fn wait_for_proof(&self) -> HeadlessExitProof {
        let started = Instant::now();
        loop {
            let proof = self.observed_proof();
            if proof != HeadlessExitProof::StillRunning
                || started.elapsed() >= Duration::from_secs(2)
            {
                return proof;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn kill_with_proof(&self) -> std::io::Result<HeadlessExitProof> {
        if self.wait_failed.load(Ordering::SeqCst) {
            return Ok(HeadlessExitProof::Unknown);
        }
        self.kill()?;
        Ok(self.wait_for_proof())
    }
}

/// Registry of live headless sessions — managed Tauri state, independent of
/// the dock's host-owned sessions.
#[derive(Default)]
pub struct HeadlessTerminalState {
    lingering: StdMutex<HashMap<String, Arc<LingeringHeadlessSession>>>,
    sessions: StdMutex<HashMap<String, Arc<HeadlessSession>>>,
}

impl HeadlessTerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, session: Arc<HeadlessSession>) {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session.id.clone(), session);
    }

    fn get(&self, id: &str) -> Option<Arc<HeadlessSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    fn remove(&self, id: &str) -> Option<Arc<HeadlessSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
    }

    fn get_lingering(&self, id: &str) -> Option<Arc<LingeringHeadlessSession>> {
        self.lingering
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }
    fn remove_lingering(&self, id: &str) {
        self.lingering
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }
    /// Snapshot for the unified managed-process registry. Headless sessions
    /// are their own PTY registry, so without this they were invisible to the
    /// performance panel and survived app exit.
    pub fn managed_snapshot(&self) -> Vec<HeadlessManagedInfo> {
        let mut rows: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|s| s.managed.load(Ordering::SeqCst))
            .map(|s| HeadlessManagedInfo {
                id: s.id.clone(),
                shell: s.shell.clone(),
                pid: s.session.info().pid,
                alive: s.session.is_alive(),
            })
            .collect();
        let mut lingering = self.lingering.lock().unwrap_or_else(|p| p.into_inner());
        lingering.retain(|_, process| process.alive());
        rows.extend(lingering.values().map(|s| HeadlessManagedInfo {
            id: s.id.clone(),
            shell: s.shell.clone(),
            pid: s.pid,
            alive: true,
        }));
        rows
    }

    /// Retain unconfirmed children for retry; failed waits report Unknown and forget the native handle.
    pub fn kill_with_proof(&self, id: &str) -> Result<HeadlessExitProof, String> {
        let proof = if let Some(session) = self.get(id) {
            session.kill_with_proof()
        } else if let Some(session) = self.get_lingering(id) {
            session.kill_with_proof()
        } else {
            return Ok(exit_proof(id, false));
        }
        .map_err(|error| format!("headless kill: {error}"))?;
        if matches!(
            proof,
            HeadlessExitProof::Exited | HeadlessExitProof::Unknown
        ) {
            self.remove(id);
            self.remove_lingering(id);
        }
        Ok(proof)
    }

    pub fn kill(&self, id: &str) -> bool {
        match self.remove(id) {
            Some(session) => {
                session.kill();
                true
            }
            None => {
                if let Some(process) = self.get_lingering(id) {
                    let _ = process.kill();
                    if !process.alive() {
                        self.remove_lingering(id);
                    }
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Kill every session. Called from the app-exit teardown.
    pub fn kill_all(&self) {
        let sessions: Vec<Arc<HeadlessSession>> = self
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.kill();
        }
        let lingering: Vec<_> = self
            .lingering
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        for process in lingering {
            let _ = process.kill();
            if !process.alive() {
                self.remove_lingering(&process.id);
            }
        }
    }
}

/// One headless PTY session as the managed-process registry sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessManagedInfo {
    pub id: String,
    pub shell: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

/// Strip terminal escape sequences from captured bytes: OSC
/// (`ESC ] … BEL` / `ESC ] … ESC \`), CSI (`ESC [ … <final>`), and other
/// two-byte ESC forms. Lossy-UTF-8 the remainder and normalize CRLF.
fn strip_escapes(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1b {
            out.push(b);
            i += 1;
            continue;
        }
        // ESC sequence — classify by the next byte.
        let Some(&next) = bytes.get(i + 1) else {
            break;
        };
        match next {
            b']' => {
                // OSC — runs to BEL or ESC \.
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            b'[' => {
                // CSI — runs to a final byte in 0x40..=0x7e.
                i += 2;
                while i < bytes.len() {
                    let c = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
            }
            _ => {
                // Two-byte escape (charset selection, keypad modes, …).
                i += 2;
            }
        }
    }
    let text = String::from_utf8_lossy(&out).replace("\r\n", "\n");
    text.replace('\r', "\n")
}

/// Drop a leading line that is just the echoed command (write-time-anchored
/// windows include the echo; C-anchored windows start past it and are
/// unaffected unless the command's first output line literally repeats it).
fn strip_command_echo(output: &str, command: &str) -> String {
    match output.split_once('\n') {
        Some((first, rest)) if first.trim_end().ends_with(command) => rest.to_string(),
        None if output.trim_end().ends_with(command) => String::new(),
        _ => output.to_string(),
    }
}

/// Post-process one capture window into the result text: strip escapes,
/// then drop a trailing line with no newline of its own — that's the next
/// prompt being painted, not command output.
fn finalize_output(window: &[u8]) -> String {
    let text = strip_escapes(window);
    match text.rfind('\n') {
        Some(idx) => text[..=idx].trim_end_matches('\n').to_string(),
        // No newline at all — a no-output command; whatever is here is
        // prompt noise.
        None => String::new(),
    }
}

/// Build the sink that maintains the capture state machine and reports
/// run completions / session exit through `tx`.
fn build_capture_sink(
    capture: Arc<StdMutex<CaptureState>>,
    exited: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<RunSignal>,
    ready_tx: tokio::sync::watch::Sender<bool>,
) -> EventSink {
    Arc::new(move |_seq, event| {
        let mut state = capture.lock().unwrap_or_else(|p| p.into_inner());
        match event {
            TerminalEvent::Data { bytes } => {
                if state.raw.len() < MAX_RAW_BYTES {
                    let room = MAX_RAW_BYTES - state.raw.len();
                    if bytes.len() > room {
                        state.raw.extend_from_slice(&bytes[..room]);
                        state.truncated = true;
                    } else {
                        state.raw.extend_from_slice(&bytes);
                    }
                } else {
                    state.truncated = true;
                }
                if let Phase::Draining { start, exit_code } = state.phase {
                    let output = finalize_output(&state.raw[start.min(state.raw.len())..]);
                    state.phase = Phase::Idle;
                    let _ = tx.send(RunSignal::Done {
                        start,
                        exit_code,
                        output,
                    });
                }
            }
            TerminalEvent::Integration { event } => match event {
                IntegrationEvent::CommandStart => {
                    // C refines the window start past the echoed command
                    // line. Shells without the C hook (headless pwsh, cmd)
                    // keep the write-time anchor `run` installed instead.
                    state.pending_anchor = None;
                    state.phase = Phase::Capturing {
                        start: state.raw.len(),
                    };
                }
                IntegrationEvent::CommandEnd { exit_code } => {
                    let start = match state.phase {
                        Phase::Capturing { start } => start,
                        // No C seen — fall back to the write-time anchor
                        // (or the whole tail under degraded integration).
                        _ => state.pending_anchor.unwrap_or(0),
                    };
                    state.pending_anchor = None;
                    state.phase = Phase::Draining { start, exit_code };
                }
                IntegrationEvent::PromptEnd => {
                    // First interactive prompt — the session is ready for
                    // scripted input.
                    let _ = ready_tx.send(true);
                }
                _ => {}
            },
            TerminalEvent::Exit { code } => {
                exited.store(true, Ordering::SeqCst);
                let _ = tx.send(RunSignal::SessionExited { code });
            }
        }
    })
}

/// Spawn a private headless PTY session (not registered in the dock).
pub fn spawn_headless(
    shell: Option<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    script_dir: &std::path::Path,
    path: &super::session::PathInjection,
    sandboxed: bool,
    exit_notify: Option<Arc<dyn Fn(String) + Send + Sync>>,
) -> Result<HeadlessSession, String> {
    let shell = shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_headless_shell);

    let mut env = env;
    // Integration scripts skip interactive-only machinery (PSReadLine key
    // handlers) when this is set; explicit caller env still wins.
    env.entry("COGNIA_TERM_HEADLESS".to_string())
        .or_insert_with(|| "1".to_string());

    let req = SpawnRequest {
        args: no_profile_args(&shell),
        shell,
        cwd: cwd.filter(|s| !s.trim().is_empty()),
        env,
        rows: HEADLESS_ROWS,
        cols: HEADLESS_COLS,
        project_id: None,
        extension_id: None,
        enable_shell_integration: true,
        force_utf8: true,
        origin: SessionOrigin::Local,
        skip_user_profile: true,
        // ADR-0028 Phase 3.3 — honor the caller's sandbox choice. The
        // workflow terminal node and the chat headless-exec path read the
        // global `settings.terminal.sandboxed` toggle and pass it through;
        // spawn_session_with_sink then wraps the shell in bwrap / sandbox-exec.
        sandboxed,
        sandbox_network: None,
    };

    let capture = Arc::new(StdMutex::new(CaptureState {
        raw: Vec::new(),
        truncated: false,
        phase: Phase::Idle,
        pending_anchor: None,
    }));
    let exited = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let sink = build_capture_sink(capture.clone(), exited.clone(), tx, ready_tx);
    let id = Uuid::new_v4().to_string();
    let proof_id = id.clone();
    let proof_sink: EventSink = Arc::new(move |seq, event| {
        if matches!(&event, TerminalEvent::Exit { code: Some(_) }) {
            exit_proof(&proof_id, true);
            if let Some(notify) = &exit_notify {
                notify(proof_id.clone());
            }
        }
        sink(seq, event);
    });

    let session =
        spawn_session_with_sink(req, script_dir, path, proof_sink, detached_desk_channel())?;
    Ok(HeadlessSession {
        id,
        shell: session.shell.clone(),
        managed: AtomicBool::new(true),
        session,
        capture,
        signals: TokioMutex::new(rx),
        ready: ready_rx,
        exited,
    })
}

/// Skip the user's interactive profile for headless runs. Prompt
/// frameworks and custom PSReadLine key handlers are exactly the kind of
/// interactive machinery that breaks unattended input (and they fight the
/// injected shell-integration hooks, which still load via the
/// integration argv/env on top of these flags).
fn no_profile_args(shell: &str) -> Vec<String> {
    match ShellKind::from_shell_path(shell) {
        ShellKind::Pwsh | ShellKind::PowerShell => {
            vec!["-NoLogo".into(), "-NoProfile".into()]
        }
        ShellKind::Bash => vec!["--noprofile".into()],
        _ => Vec::new(),
    }
}

/// Platform default shell for headless runs (mirrors the dock defaults).
pub fn default_headless_shell() -> String {
    if cfg!(windows) {
        "pwsh.exe".to_string()
    } else if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

impl HeadlessSession {
    /// Write one command line and wait for its OSC 633 command-end (or the
    /// timeout). Serializes with other runs on the same session.
    pub async fn run(
        &self,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> Result<HeadlessExecResult, String> {
        let command = command.trim();
        if command.is_empty() {
            return Err("command is required".into());
        }
        if self.exited.load(Ordering::SeqCst) {
            return Err("headless session has exited".into());
        }
        let budget =
            Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
        let started = Instant::now();

        // Exclusive run slot.
        let mut rx = self.signals.lock().await;

        // Wait for the first interactive prompt before typing — otherwise
        // the startup prompt's D event is indistinguishable from this
        // command's completion. Degraded integration (no OSC 633) never
        // flips ready; proceed after a bounded wait and rely on timeout.
        if !*self.ready.borrow() {
            let mut ready = self.ready.clone();
            let wait = budget.min(Duration::from_secs(10));
            let _ = tokio::time::timeout(wait, async {
                while !*ready.borrow() {
                    if ready.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }

        // Drain stale completions (the startup prompt's D, an earlier
        // timed-out run) so we never return their results here.
        while let Ok(stale) = rx.try_recv() {
            if let RunSignal::SessionExited { .. } = stale {
                self.exited.store(true, Ordering::SeqCst);
                return Err("headless session has exited".into());
            }
        }

        // Anchor the capture window at the write position so shells whose
        // integration lacks the C (pre-exec) hook still get a window that
        // starts at this command. A later C event narrows it past the echo.
        let write_pos = {
            let mut state = self.capture.lock().unwrap_or_else(|p| p.into_inner());
            let pos = state.raw.len();
            state.pending_anchor = Some(pos);
            if matches!(state.phase, Phase::Idle) {
                state.phase = Phase::Capturing { start: pos };
            }
            pos
        };

        let line = format!("{command}\r");
        self.session
            .write(line.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;

        loop {
            let remaining = budget.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Ok(self.timeout_result(started));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(RunSignal::Done {
                    start,
                    exit_code,
                    output,
                })) => {
                    if start < write_pos {
                        // A window that opened before our write — the
                        // startup prompt or a previously timed-out command
                        // completing late. Not ours; keep waiting.
                        continue;
                    }
                    return Ok(HeadlessExecResult {
                        output: strip_command_echo(&output, command),
                        exit_code,
                        timed_out: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                        pending_session_id: None,
                        error: None,
                    });
                }
                Ok(Some(RunSignal::SessionExited { code })) => {
                    self.exited.store(true, Ordering::SeqCst);
                    return Ok(HeadlessExecResult {
                        output: self.raw_tail(),
                        exit_code: code.map(|c| c as i32),
                        timed_out: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                        pending_session_id: None,
                        error: None,
                    });
                }
                Ok(None) => return Err("headless session event stream closed".into()),
                Err(_) => return Ok(self.timeout_result(started)),
            }
        }
    }

    fn timeout_result(&self, started: Instant) -> HeadlessExecResult {
        HeadlessExecResult {
            output: self.raw_tail(),
            exit_code: None,
            timed_out: true,
            duration_ms: started.elapsed().as_millis() as u64,
            pending_session_id: None,
            error: None,
        }
    }

    /// Stripped capture-window-so-far (timeout / session-death fallback).
    fn raw_tail(&self) -> String {
        let state = self.capture.lock().unwrap_or_else(|p| p.into_inner());
        let start = match state.phase {
            Phase::Capturing { start } | Phase::Draining { start, .. } => start,
            Phase::Idle => 0,
        };
        strip_escapes(&state.raw[start.min(state.raw.len())..])
            .trim_end()
            .to_string()
    }

    pub fn kill(&self) {
        let _ = self.session.kill();
    }

    pub fn kill_with_proof(&self) -> std::io::Result<HeadlessExitProof> {
        if self.session.wait_failed() {
            return Ok(HeadlessExitProof::Unknown);
        }
        self.session.kill()?;
        Ok(if self.session.wait_for_exit(Duration::from_secs(2)) {
            HeadlessExitProof::Exited
        } else if self.session.wait_failed() {
            HeadlessExitProof::Unknown
        } else {
            HeadlessExitProof::StillRunning
        })
    }
}

impl Drop for HeadlessSession {
    fn drop(&mut self) {
        // Belt-and-braces: a headless PTY must never outlive its handle.
        if self.session.is_alive() {
            let _ = self.session.kill();
        }
    }
}

/// One-shot cleanup must not release a process lease on timeout or error.
async fn settle_one_shot(
    state: &HeadlessTerminalState,
    session: Arc<HeadlessSession>,
    result: Result<HeadlessExecResult, String>,
) -> Result<HeadlessExecResult, String> {
    let id = session.id.clone();
    let normal = matches!(&result, Ok(output) if !output.timed_out && output.error.is_none());
    let proof = if normal {
        let lingering = Arc::new(LingeringHeadlessSession::capture(&session));
        {
            let mut records = state.lingering.lock().unwrap_or_else(|p| p.into_inner());
            records.retain(|_, record| record.alive());
            records.insert(id.clone(), lingering.clone());
        }
        drop(state.remove(&id));
        drop(session);
        tokio::task::spawn_blocking(move || Ok::<_, std::io::Error>(lingering.wait_for_proof()))
            .await
    } else {
        session.managed.store(true, Ordering::SeqCst);
        tokio::task::spawn_blocking(move || session.kill_with_proof()).await
    };
    let exited = matches!(&proof, Ok(Ok(HeadlessExitProof::Exited)));
    if matches!(
        &proof,
        Ok(Ok(HeadlessExitProof::Exited | HeadlessExitProof::Unknown))
    ) {
        state.remove(&id);
        state.remove_lingering(&id);
    }
    let pending = if exited { None } else { Some(id) };
    match result {
        Ok(mut output) => {
            output.pending_session_id = pending;
            Ok(output)
        }
        Err(error) => Ok(HeadlessExecResult {
            output: String::new(),
            exit_code: None,
            timed_out: false,
            duration_ms: 0,
            pending_session_id: pending,
            error: Some(error),
        }),
    }
}

// --- Tauri commands --------------------------------------------------------

#[cfg(feature = "tauri-host")]
fn resolve_dirs<R: Runtime>(app: &AppHandle<R>) -> (PathBuf, super::session::PathInjection) {
    (
        super::commands::resolve_script_dir(app),
        super::commands::build_cli_path_injection(app),
    )
}

/// One-shot: spawn a private shell, run one line, kill. The workhorse for
/// the unattended workflow terminal node.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn terminal_headless_exec<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, HeadlessTerminalState>,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    sandboxed: Option<bool>,
) -> Result<HeadlessExecResult, String> {
    let (script_dir, path) = resolve_dirs(&app);
    let notify = proof_notifier(app.clone());
    let session = tokio::task::spawn_blocking(move || {
        spawn_headless(
            shell,
            cwd,
            env.unwrap_or_default(),
            &script_dir,
            &path,
            sandboxed.unwrap_or(false),
            Some(notify),
        )
    })
    .await
    .map_err(|error| format!("terminal headless spawn task failed: {error}"))??;
    let session = session;
    session.managed.store(false, Ordering::SeqCst);
    let session = Arc::new(session);
    state.insert(session.clone());
    let result = session.run(&command, timeout_ms).await;
    settle_one_shot(&state, session, result).await
}

/// Spawn a persistent headless session for multi-step runs.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub fn terminal_headless_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, HeadlessTerminalState>,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
    sandboxed: Option<bool>,
) -> Result<HeadlessSpawnResult, String> {
    let (script_dir, path) = resolve_dirs(&app);
    let session = spawn_headless(
        shell,
        cwd,
        env.unwrap_or_default(),
        &script_dir,
        &path,
        sandboxed.unwrap_or(false),
        Some(proof_notifier(app.clone())),
    )?;
    let result = HeadlessSpawnResult {
        session_id: session.id.clone(),
        shell: session.shell.clone(),
    };
    state.insert(Arc::new(session));
    Ok(result)
}

/// Run one command line in a persistent headless session.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn terminal_headless_run(
    state: tauri::State<'_, HeadlessTerminalState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<HeadlessExecResult, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("unknown headless session: {session_id}"))?;
    session.run(&command, timeout_ms).await
}

/// Kill + forget a persistent headless session. Idempotent.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn terminal_headless_kill(
    state: tauri::State<'_, HeadlessTerminalState>,
    session_id: String,
    observe_only: Option<bool>,
) -> Result<HeadlessExitProof, String> {
    let proof = if let Some(session) = state.get(&session_id) {
        if observe_only.unwrap_or(false) {
            return Ok(if session.session.wait_failed() {
                HeadlessExitProof::Unknown
            } else if session.session.is_alive() {
                HeadlessExitProof::StillRunning
            } else {
                exit_proof(&session_id, false)
            });
        }
        tokio::task::spawn_blocking(move || session.kill_with_proof()).await
    } else if let Some(process) = state.get_lingering(&session_id) {
        if observe_only.unwrap_or(false) {
            return Ok(process.observed_proof());
        }
        tokio::task::spawn_blocking(move || process.kill_with_proof()).await
    } else {
        return Ok(exit_proof(&session_id, false));
    }
    .map_err(|error| format!("headless kill task failed: {error}"))?
    .map_err(|error| format!("headless kill: {error}"))?;
    if matches!(
        proof,
        HeadlessExitProof::Exited | HeadlessExitProof::Unknown
    ) {
        state.remove(&session_id);
        state.remove_lingering(&session_id);
    }
    Ok(proof)
}

#[cfg(test)]
mod tests {
    #[derive(Debug)]
    struct TestKiller {
        fail: bool,
    }
    impl portable_pty::ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            if self.fail {
                Err(std::io::Error::other("kill refused"))
            } else {
                Ok(())
            }
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self { fail: self.fail })
        }
    }

    #[test]
    fn r3_exit_proofs_have_no_time_expiry_and_evict_by_count() {
        let mut store = ExitProofStore::default();
        store.records.insert(
            "old".into(),
            Instant::now()
                .checked_sub(Duration::from_secs(3600))
                .unwrap(),
        );
        assert_eq!(store.proof("old", false), HeadlessExitProof::Exited);
        for index in 0..EXIT_PROOF_CAP - 1 {
            store.proof(&format!("fresh-{index}"), true);
        }
        store.proof("newest", true);
        assert_eq!(store.records.len(), EXIT_PROOF_CAP);
        assert_eq!(store.proof("old", false), HeadlessExitProof::Unknown);
        assert_eq!(store.proof("newest", false), HeadlessExitProof::Exited);
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn r2_normal_hup_ignoring_command_drops_pty_and_exposes_any_survivor() {
        let state = HeadlessTerminalState::new();
        let raw = spawn_test_session();
        raw.managed.store(false, Ordering::SeqCst);
        let session = Arc::new(raw);
        let id = session.id.clone();
        let pid = session.session.pid;
        let alive = session.session.alive.clone();
        state.insert(session.clone());
        let result = session
            .run("trap '' HUP; echo r2-normal", Some(60_000))
            .await;
        let settled = settle_one_shot(&state, session, result).await;
        let retained = state.get(&id).is_some();
        let was_alive = alive.load(Ordering::SeqCst);
        let visible = state
            .managed_snapshot()
            .iter()
            .any(|row| row.id == id && row.alive);
        if was_alive {
            if let Some(pid) = pid {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        state.kill_all();
        let output = settled.unwrap();
        assert!(!output.timed_out);
        assert!(output.error.is_none());
        assert_eq!(output.exit_code, Some(0));
        assert!(output.output.contains("r2-normal"));
        assert!(!retained);
        if was_alive {
            assert!(visible);
        }
    }
    #[tokio::test(flavor = "multi_thread")]
    #[cfg(unix)]
    async fn q5_timeout_survivor_retains_identity_until_real_exit() {
        let state = HeadlessTerminalState::new();
        let session = spawn_test_session();
        session.managed.store(false, Ordering::SeqCst);
        let session = Arc::new(session);
        session
            .run("trap '' HUP; echo q5-ready", Some(60_000))
            .await
            .unwrap();
        let id = session.id.clone();
        let pid = session.session.info().pid.unwrap();
        state.insert(session.clone());
        let timed = session
            .run("while :; do read -r line; done", Some(50))
            .await;
        let output = settle_one_shot(&state, session.clone(), timed)
            .await
            .unwrap();
        let pending = output.pending_session_id.clone();
        let proof = state.kill_with_proof(&id).unwrap();
        // Always terminate the survivor before any assertion can panic.
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", &pid.to_string()])
            .status();
        let reaped = session.session.wait_for_exit(Duration::from_secs(2));
        assert!(output.timed_out);
        assert_eq!(pending.as_deref(), Some(id.as_str()));
        assert_eq!(proof, HeadlessExitProof::StillRunning);
        assert!(reaped);
        assert_eq!(
            state.kill_with_proof(&id).unwrap(),
            HeadlessExitProof::Exited
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn q5_abnormal_return_keeps_unconfirmed_identity_and_error() {
        let state = HeadlessTerminalState::new();
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        let original = std::mem::replace(
            &mut *session.session.killer.lock().unwrap(),
            Box::new(TestKiller { fail: true }),
        );
        state.insert(session.clone());
        let output = settle_one_shot(&state, session.clone(), Err("event stream closed".into()))
            .await
            .unwrap();
        let retained = state.get(&id).is_some();
        *session.session.killer.lock().unwrap() = original;
        let cleanup = state.kill_with_proof(&id);
        assert!(retained);
        assert_eq!(output.pending_session_id.as_deref(), Some(id.as_str()));
        assert_eq!(output.error.as_deref(), Some("event stream closed"));
        assert_eq!(cleanup.unwrap(), HeadlessExitProof::Exited);
    }

    #[test]
    fn q7_removed_sessions_retain_only_real_child_wait_proof() {
        for all in [false, true] {
            let state = HeadlessTerminalState::new();
            let session = Arc::new(spawn_test_session());
            let id = session.id.clone();
            state.insert(session.clone());
            if all {
                state.kill_all();
            } else {
                assert!(state.kill(&id));
            }
            assert!(state.get(&id).is_none());
            assert!(session.session.wait_for_exit(Duration::from_secs(2)));
            // alive=false precedes the real Exit sink; wait for that publication.
            let deadline = Instant::now() + Duration::from_secs(2);
            while exit_proof(&id, false) != HeadlessExitProof::Exited && Instant::now() < deadline {
                std::thread::yield_now();
            }
            assert_eq!(
                state.kill_with_proof(&id).unwrap(),
                HeadlessExitProof::Exited
            );
            assert_eq!(
                state.kill_with_proof(&id).unwrap(),
                HeadlessExitProof::Exited
            );
        }
    }

    #[test]
    fn q8_one_shot_is_not_a_managed_process() {
        let state = HeadlessTerminalState::new();
        let one_shot = spawn_test_session();
        one_shot.managed.store(false, Ordering::SeqCst);
        let hidden_id = one_shot.id.clone();
        state.insert(Arc::new(one_shot));
        let persistent = Arc::new(spawn_test_session());
        let visible_id = persistent.id.clone();
        state.insert(persistent);
        let snapshot = state.managed_snapshot();
        state.kill_all();
        assert!(!snapshot.iter().any(|row| row.id == hidden_id));
        assert!(snapshot.iter().any(|row| row.id == visible_id));
    }

    #[test]
    fn personal_egress_headless_exit_proof_retains_failed_and_unconfirmed_children() {
        let state = HeadlessTerminalState::new();
        assert_eq!(
            state.kill_with_proof("missing").unwrap(),
            HeadlessExitProof::Unknown
        );
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        let original = std::mem::replace(
            &mut *session.session.killer.lock().unwrap(),
            Box::new(TestKiller { fail: true }),
        );
        state.insert(session.clone());
        assert!(state
            .kill_with_proof(&id)
            .unwrap_err()
            .contains("kill refused"));
        assert!(state.get(&id).is_some());
        *session.session.killer.lock().unwrap() = Box::new(TestKiller { fail: false });
        assert_eq!(
            state.kill_with_proof(&id).unwrap(),
            HeadlessExitProof::StillRunning
        );
        assert!(state.get(&id).is_some());
        *session.session.killer.lock().unwrap() = original;
        assert_eq!(
            state.kill_with_proof(&id).unwrap(),
            HeadlessExitProof::Exited
        );
        assert!(!session.session.is_alive());
        assert!(state.get(&id).is_none());
        assert_eq!(
            serde_json::to_value(HeadlessExitProof::Exited).unwrap(),
            serde_json::json!({ "status": "exited" })
        );
    }

    #[test]
    fn p5_failed_wait_is_unknown_and_removes_native_identity() {
        let state = HeadlessTerminalState::new();
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        session.session.wait_failed.store(true, Ordering::SeqCst);
        state.insert(session.clone());
        assert_eq!(
            state.kill_with_proof(&id).unwrap(),
            HeadlessExitProof::Unknown
        );
        assert!(state.get(&id).is_none());
        session.kill();
    }

    #[test]
    fn p5_legacy_kill_removes_even_when_signalling_fails() {
        let state = HeadlessTerminalState::new();
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        let original = std::mem::replace(
            &mut *session.session.killer.lock().unwrap(),
            Box::new(TestKiller { fail: true }),
        );
        state.insert(session.clone());
        assert!(state.kill(&id));
        assert!(state.get(&id).is_none());
        *session.session.killer.lock().unwrap() = original;
        session.kill();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn workspace_env_reaches_the_headless_pty() {
        for kind in ["some", "none"] {
            let cwd = crate::workspace_env_fixture(kind);
            let session = spawn_headless(
                Some(test_shell()),
                Some(cwd.path().to_string_lossy().into_owned()),
                HashMap::from([("PORT".into(), "user-port".into())]),
                &script_dir(),
                &super::super::session::PathInjection::default(),
                false,
                None,
            )
            .unwrap();
            let result = session.run(
                r#"printf '%s:%s:%s\n' "${COGNIA_PORT-unset}" "${COGNIA_PORT_COUNT-unset}" "$PORT""#,
                Some(60_000),
            ).await.unwrap();
            let _ = session.kill();
            assert!(
                !result.timed_out,
                "workspace env command timed out: {result:?}"
            );
            let expected = if kind == "some" {
                "41000:10:41000"
            } else {
                "unset:unset:user-port"
            };
            assert!(result.output.contains(expected), "{result:?}");
        }
        let failed = crate::workspace_env_fixture("error");
        let result = spawn_headless(
            Some(test_shell()),
            Some(failed.path().to_string_lossy().into_owned()),
            HashMap::new(),
            &script_dir(),
            &super::super::session::PathInjection::default(),
            false,
            None,
        );
        assert!(result
            .err()
            .unwrap()
            .contains("fixture port range exhausted"));
    }

    use super::*;

    fn script_dir() -> PathBuf {
        // Mirror `commands::resolve_script_dir`'s dev fallback: the shell
        // integration scripts live under src-tauri/resources/terminal/;
        // CARGO_MANIFEST_DIR is crates/cognia-terminal, two hops below the
        // workspace root (ADR-0067 extraction). Pointing at the crate-local
        // `resources/terminal` (which doesn't exist) silently disables OSC 633
        // integration, so `run` never sees a CommandEnd marker and times out.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .ancestors()
            .nth(2)
            .map(|root| root.join("src-tauri"))
            .unwrap_or(manifest)
            .join("resources")
            .join("terminal")
    }

    fn test_shell() -> String {
        if cfg!(windows) {
            // resolve_shell_binary falls back to powershell.exe when
            // PowerShell 7 isn't installed.
            "pwsh.exe".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }

    fn spawn_test_session() -> HeadlessSession {
        spawn_headless(
            Some(test_shell()),
            None,
            HashMap::new(),
            &script_dir(),
            &super::super::session::PathInjection::default(),
            false,
            None,
        )
        .expect("headless spawn")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_a_command_and_captures_output_and_exit() {
        let session = spawn_test_session();
        let result = session
            .run("echo cognia-headless-ok", Some(60_000))
            .await
            .expect("run ok");
        let _ = session.kill();
        assert!(!result.timed_out, "should not time out: {result:?}");
        assert!(
            result.output.contains("cognia-headless-ok"),
            "output: {:?}",
            result.output
        );
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    fn managed_snapshot_lists_sessions_and_kill_all_drains_the_registry() {
        // Headless PTYs are a second, independent terminal registry; before
        // this they were invisible to the performance panel and survived exit.
        let state = HeadlessTerminalState::new();
        assert!(state.managed_snapshot().is_empty());

        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        state.insert(session);

        let snapshot = state.managed_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, id);
        assert!(snapshot[0].alive, "a freshly spawned shell is alive");

        assert!(!state.kill("no-such-session"));
        state.kill_all();
        assert!(state.managed_snapshot().is_empty());
    }

    #[test]
    fn kill_removes_only_the_named_session() {
        let state = HeadlessTerminalState::new();
        let a = Arc::new(spawn_test_session());
        let b = Arc::new(spawn_test_session());
        let (id_a, id_b) = (a.id.clone(), b.id.clone());
        state.insert(a);
        state.insert(b);

        assert!(state.kill(&id_a));
        let remaining = state.managed_snapshot();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, id_b);
        state.kill_all();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_a_nonzero_exit_code() {
        let session = spawn_test_session();
        let cmd = if cfg!(windows) { "exit 3" } else { "(exit 3)" };
        let result = session.run(cmd, Some(60_000)).await.expect("run ok");
        let _ = session.kill();
        // `exit 3` in pwsh ends the shell itself on some hosts; accept
        // either the captured code or a session-exit with code 3.
        assert_eq!(result.exit_code, Some(3), "result: {result:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sequential_runs_share_the_session_state() {
        let session = spawn_test_session();
        let setvar = if cfg!(windows) {
            "$env:COGNIA_HL_T = 'persisted'"
        } else {
            "COGNIA_HL_T=persisted"
        };
        let readvar = if cfg!(windows) {
            "echo $env:COGNIA_HL_T"
        } else {
            "echo $COGNIA_HL_T"
        };
        session.run(setvar, Some(60_000)).await.expect("set");
        let result = session.run(readvar, Some(60_000)).await.expect("read");
        let _ = session.kill();
        assert!(
            result.output.contains("persisted"),
            "output: {:?}",
            result.output
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn times_out_a_hanging_command() {
        let session = spawn_test_session();
        let sleeper = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let result = session.run(sleeper, Some(1_500)).await.expect("run ok");
        let _ = session.kill();
        assert!(result.timed_out, "expected timeout: {result:?}");
        assert!(result.exit_code.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_an_empty_command_and_runs_after_kill_fail() {
        let session = spawn_test_session();
        assert!(session.run("   ", Some(5_000)).await.is_err());
        let _ = session.kill();
    }

    #[test]
    fn registry_roundtrip_and_idempotent_remove() {
        let state = HeadlessTerminalState::new();
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        state.insert(session);
        assert!(state.get(&id).is_some());
        let removed = state.remove(&id).expect("removed");
        let _ = removed.kill();
        assert!(state.get(&id).is_none());
        assert!(state.remove(&id).is_none());
    }

    #[test]
    fn strip_escapes_removes_osc_and_csi() {
        let bytes = b"\x1b]633;C;nonce\x07hello \x1b[32mgreen\x1b[0m\r\nworld\r\n\x1b]633;D;nonce;0\x07prompt>";
        let text = strip_escapes(bytes);
        assert_eq!(text, "hello green\nworld\nprompt>");
    }

    #[test]
    fn finalize_output_drops_the_trailing_prompt_line() {
        let bytes = b"hello\r\nworld\r\nPS D:\\repo>";
        assert_eq!(finalize_output(bytes), "hello\nworld");
        assert_eq!(finalize_output(b"no-newline-prompt>"), "");
    }
}
