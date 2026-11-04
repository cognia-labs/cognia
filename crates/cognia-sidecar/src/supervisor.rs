use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex as ParkingMutex;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use super::host::SidecarHost;
use cognia_core::host_runtime::{RuntimeConfig, RuntimeKind, RuntimeRole};
use cognia_core::supervision_backoff::CrashBackoff;

/// Tauri event channel name. The frontend subscribes via
/// `listen("claude://message", ...)`.
pub const SIDECAR_EVENT: &str = "claude://message";

/// Dedicated event channel for A2UI dispatches (createSurface,
/// updateComponents, dataModelUpdate, deleteSurface). Kept separate from
/// `SIDECAR_EVENT` so the a2ui store can subscribe without sifting through
/// every sidecar message.
pub const A2UI_EVENT: &str = "a2ui://dispatch";

/// Canonical agent-event channel (ADR-0090 Phase 3). Sessions with a frozen
/// execution spec dual-emit `agent_event` envelopes here; the raw legacy
/// stream on `SIDECAR_EVENT` is unchanged.
pub const AGENT_EVENT: &str = "agent://message";

/// How long a freshly spawned sidecar has to announce `{"type":"ready"}`
/// before the watchdog kills it. Deliberately generous: a tighter bound would
/// kill a healthy-but-slow cold start (large `node_modules`, cold disk) — the
/// same false-positive class that ruled out a blanket reader-inactivity timeout.
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Minimum Node.js major version the chat sidecar requires. Matches the repo's
/// `engines.node` (>= 26): the sidecar's native addons (`better-sqlite3` 13.x,
/// `node-pty`) declare Node >= 22, and the `@anthropic-ai/claude-agent-sdk` +
/// undici proxy stack assumes a current runtime. Older runtimes fail late and
/// opaquely deep inside the SDK, so we probe up front and surface an actionable
/// error instead.
const MIN_NODE_MAJOR: u32 = 26;

/// Parse the major version out of `node --version` output (e.g. `"v20.11.0\n"`
/// → `Some(20)`). Tolerates a missing leading `v`. Pure — unit-tested.
fn parse_node_major(version_output: &str) -> Option<u32> {
    let trimmed = version_output.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    without_v.split('.').next()?.parse::<u32>().ok()
}

fn background_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

fn node_resource_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(std::path::Component::Prefix(prefix)) = path.components().next() {
        use std::path::Prefix;
        let mut normalized = match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", drive as char)),
            Prefix::VerbatimUNC(server, share) => {
                let mut root = std::ffi::OsString::from(r"\\");
                root.push(server);
                root.push(r"\");
                root.push(share);
                PathBuf::from(root)
            }
            _ => return path.to_path_buf(),
        };
        normalized.extend(path.components().skip(1));
        return normalized;
    }
    path.to_path_buf()
}

fn sidecar_command(
    runtime_executable: &Path,
    script: &Path,
    runtime: RuntimeKind,
) -> Result<Command, String> {
    // Node's CLI realpath resolution rejects canonical Windows `\\?\` paths
    // with EISDIR, including paths derived from its working directory.
    let script = node_resource_path(script);
    let cwd = script
        .parent()
        .ok_or_else(|| "sidecar script has no parent dir".to_string())?;
    let mut command = background_command(&node_resource_path(runtime_executable));
    command
        .args(runtime.launch_args())
        .arg(&script)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(command)
}

/// Cancellation before admission must kill the entire uncommitted Bun tree.
struct StartupProcessGuard(Option<u32>);

impl Drop for StartupProcessGuard {
    fn drop(&mut self) {
        cognia_exec_sandbox::proc_group::kill_process_group(self.0);
    }
}

/// Hand the sidecar the confinement wrapper for `run_code` children, when this
/// host has one.
///
/// Deliberately infallible and silent-on-absence: a host without a sandbox
/// backend is a normal, supported configuration (Windows today, Linux without
/// `bwrap`). Failing the sidecar spawn over it would break chat entirely to
/// disable one optional mode. The consequence of the variable being unset is
/// that Code fails closed, which is the whole point.
fn apply_code_sandbox_env(cmd: &mut Command, node_executable: &Path, sidecar_root: &Path) {
    use crate::code_sandbox::{
        code_sandbox_scope, encode_launcher, render_code_sandbox_launcher,
        CODE_SANDBOX_LAUNCHER_ENV,
    };

    let scratch = std::env::temp_dir().join("cognia-code-sandbox");
    if let Err(error) = std::fs::create_dir_all(&scratch) {
        log::warn!("code sandbox scratch dir unavailable, Code mode disabled: {error}");
        return;
    }

    let node_root = node_executable.parent().unwrap_or(node_executable);
    let scope = code_sandbox_scope(&scratch, node_root, sidecar_root);

    match render_code_sandbox_launcher(&scope).and_then(|prefix| encode_launcher(&prefix)) {
        Some(encoded) => {
            cmd.env(CODE_SANDBOX_LAUNCHER_ENV, encoded);
        }
        None => {
            log::info!("no OS sandbox backend on this host; Code tool presentation stays disabled")
        }
    }
}

fn apply_managed_proxy_env(
    cmd: &mut Command,
    proxy_cfg: &cognia_net::proxy_config::ProxyConfig,
) -> Result<(), String> {
    let env = proxy_cfg.env_vars();
    if proxy_cfg.is_active() && env.is_empty() {
        return Err("PROXY_INVALID_CONFIG: sidecar proxy environment is unavailable".to_string());
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    if proxy_cfg.is_active() {
        // Frozen execution specs rebuild the Claude subprocess environment.
        // This marker lets the sidecar distinguish host-managed proxy values
        // from ambient shell variables without sending credentials through
        // the renderer as a per-session env overlay.
        cmd.env("COGNIA_MANAGED_NETWORK_PROXY", "1");
        return Ok(());
    }

    // Explicit direct mode must not inherit stale parent/system proxy env.
    for key in &[
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        cmd.env_remove(key);
    }
    cmd.env_remove("COGNIA_MANAGED_NETWORK_PROXY");
    Ok(())
}

fn handle_active_run_event(state: &SidecarState, generation: u64, value: &Value) {
    let session_id = value.get("sessionId").and_then(Value::as_str);
    match value.get("type").and_then(Value::as_str) {
        Some("executor_started") => {
            if let (Some(session_id), Some(executor_id)) =
                (session_id, value.get("executorId").and_then(Value::as_str))
            {
                let mut registry = state.active_runs.lock();
                if let Some(hold) = registry.by_session.get_mut(session_id).and_then(|holds| {
                    holds.iter_mut().find(|hold| {
                        hold.generation == Some(generation)
                            && hold.executor_id.is_none()
                            && hold.turn_id.as_deref()
                                == value.get("turnId").and_then(Value::as_str)
                    })
                }) {
                    hold.executor_id = Some(executor_id.to_owned());
                }
            }
        }
        // Turn liveness and the wake assertion are independent. An explicit
        // process snapshot can release power without claiming disposal.
        Some("session_ended" | "turn_settled")
            if value
                .get("backgroundProcessesRunning")
                .and_then(Value::as_bool)
                == Some(false) =>
        {
            if let Some(session_id) = session_id {
                let mut registry = state.active_runs.lock();
                if let Some(holds) = registry.by_session.get_mut(session_id) {
                    for hold in holds.iter_mut().filter(|hold| {
                        hold.generation == Some(generation)
                            && value
                                .get("executorId")
                                .and_then(Value::as_str)
                                .is_none_or(|id| hold.executor_id.as_deref() == Some(id))
                    }) {
                        if hold.wake_held {
                            hold.wake_held = false;
                            cognia_power::release(&cognia_power::WakeReason::ActiveRun(
                                session_id.to_owned(),
                            ));
                        }
                    }
                }
            }
        }
        // Only disposal removes session liveness across renderer reloads.
        Some("session_disposed") => {
            if let (Some(session_id), Some(executor_id)) =
                (session_id, value.get("executorId").and_then(Value::as_str))
            {
                let tokens: Vec<_> = state
                    .active_runs
                    .lock()
                    .by_session
                    .get(session_id)
                    .into_iter()
                    .flatten()
                    .filter(|hold| {
                        hold.generation == Some(generation)
                            && hold.executor_id.as_deref() == Some(executor_id)
                    })
                    .map(|hold| ActiveRunToken {
                        session_id: session_id.to_owned(),
                        token_id: hold.token_id,
                    })
                    .collect();
                for token in tokens {
                    state.cancel_active_run(token);
                }
            }
        }
        Some("command_ack") if value.get("duplicate").and_then(Value::as_bool) == Some(true) => {
            if let (Some(session_id), Some(command_id)) =
                (session_id, value.get("commandId").and_then(Value::as_str))
            {
                state.finish_duplicate_active_run(generation, session_id, command_id);
            }
        }
        Some("capability_error")
            if value.get("command").and_then(Value::as_str) == Some("send") =>
        {
            if let Some(session_id) = session_id {
                state.finish_active_run(generation, session_id);
            }
        }
        _ => {}
    }
}

/// Shared, mutable state. Cloned cheaply via `Arc`.
#[derive(Clone, Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Inner>>,
    active_runs: Arc<ParkingMutex<ActiveRunRegistry>>,
    /// The live child's stdin, kept behind its own lock — separate from
    /// `inner` so a slow control-message write never blocks state reads
    /// (`is_ready`). Mirrors the owned-stdin
    /// shape in `external_agent/process.rs`.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Held for the entire `spawn` body so concurrent callers serialize: the
    /// second one blocks, then sees the live child and no-ops. Mirrors the
    /// `materialize_lock` idiom in `plugin_api/python/mod.rs`.
    spawn_lock: Arc<Mutex<()>>,
    /// Monotonic spawn generation, bumped on each `spawn`. The ready watchdog
    /// captures its generation and refuses to act once a newer spawn supersedes
    /// it — otherwise a stale watchdog could adopt (and kill) a *healthy*
    /// successor child after the original crashed and respawned.
    spawn_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// ADR-0028 Phase 14 — incremented every time `spawn` succeeds after
    /// boot. Surfaced through `sidecar_restart_count` for the Diagnostics
    /// → Sidecar card so users can see how often the sidecar has
    /// recovered without restarting the app. `AtomicU64` keeps the
    /// counter lock-free.
    restart_count: Arc<std::sync::atomic::AtomicU64>,
    /// Set once a `node --version` probe confirms Node >= [`MIN_NODE_MAJOR`].
    /// Caches the happy path so we don't fork `node --version` on every spawn;
    /// a failed probe leaves this `false` so a later spawn (after the user
    /// installs/upgrades Node) re-checks.
    node_version_ok: Arc<std::sync::atomic::AtomicBool>,
    /// A Bun boot failure switches this sidecar slot to Node until host restart.
    bun_disabled: Arc<std::sync::atomic::AtomicBool>,
    /// Invalidates a private pre-ready attempt when teardown starts.
    stop_epoch: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Debug)]
struct ActiveRunHold {
    token_id: u64,
    generation: Option<u64>,
    command_id: Option<String>,
    turn_id: Option<String>,
    executor_id: Option<String>,
    wake_held: bool,
}

#[derive(Default)]
struct ActiveRunRegistry {
    next_token_id: u64,
    by_session: HashMap<String, VecDeque<ActiveRunHold>>,
}

pub struct ActiveRunToken {
    token_id: u64,
    session_id: String,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    ready: bool,
    /// Crash-loop backoff counters (shared shape with the brain supervisor —
    /// `supervision_backoff.rs`). Reset the moment the sidecar announces
    /// `ready`, advanced on every reader exit.
    backoff: CrashBackoff,
    /// Latched by [`kill_sidecar`], consumed by [`SidecarState::note_exit`].
    ///
    /// `CrashBackoff` charges *every* exit, which is right for a backoff that
    /// resets the moment the child announces ready. The recovery restart
    /// budget (ADR-0102 §4) is not so forgiving — it only clears after ten
    /// healthy minutes — so charging a deliberate restart against it would
    /// disable the sidecar and drop the app into safe mode after four ordinary
    /// "restart sidecar" clicks. Only unexpected deaths count.
    intentional_stop: bool,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of times the sidecar has been spawned (re-spawned counts).
    /// The first boot returns 1; each `kill_sidecar` + subsequent `spawn`
    /// increments the counter.
    pub fn restart_count(&self) -> u64 {
        self.restart_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Increment the restart counter — called by `spawn` after the child
    /// process is in the map.
    pub fn bump_restart_count(&self) {
        self.restart_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Probe the host-resolved Node executable once and verify Node >=
    /// [`MIN_NODE_MAJOR`] before the first spawn. The desktop host supplies the
    /// verified bundled runtime; headless deployments retain their explicit
    /// `node`-on-`PATH` contract.
    async fn ensure_node_version(&self, node_executable: &Path) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if self.node_version_ok.load(Ordering::Relaxed) {
            return Ok(());
        }
        let output = background_command(node_executable)
            .arg("--version")
            .output()
            .await
            .map_err(|e| {
                format!(
                    "failed to execute Node.js at {} — the chat sidecar requires Node.js >= \
                     {MIN_NODE_MAJOR} ({e})",
                    node_executable.display()
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "`{} --version` failed (exit {:?}) — the chat sidecar requires Node.js >= \
                 {MIN_NODE_MAJOR}",
                node_executable.display(),
                output.status.code()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let major = parse_node_major(&stdout).ok_or_else(|| {
            format!(
                "could not parse Node.js version from {:?} at {} — the chat sidecar requires \
                 Node.js >= {MIN_NODE_MAJOR}",
                stdout.trim(),
                node_executable.display()
            )
        })?;
        if major < MIN_NODE_MAJOR {
            return Err(format!(
                "Node.js {} at {} is too old — the chat sidecar requires Node.js >= \
                 {MIN_NODE_MAJOR}",
                stdout.trim(),
                node_executable.display()
            ));
        }
        self.node_version_ok.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// The current spawn generation. The watchdog compares this against the
    /// generation it was armed with to detect that a newer spawn superseded it.
    fn current_epoch(&self) -> u64 {
        self.spawn_epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Bump and return the new spawn generation. Called once per `spawn`, under
    /// `spawn_lock`, so generations are assigned serially.
    fn next_epoch(&self) -> u64 {
        self.spawn_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .wrapping_add(1)
    }

    pub fn begin_active_run(&self, session_id: &str, command_id: Option<&str>) -> ActiveRunToken {
        self.begin_run(session_id, command_id, Some(self.current_epoch()))
    }

    pub fn begin_pending_run(&self, session_id: &str, command_id: Option<&str>) -> ActiveRunToken {
        self.begin_run(session_id, command_id, None)
    }

    fn activate_pending_run(&self, token: &ActiveRunToken, message: &Value) {
        if let Some(hold) = self
            .active_runs
            .lock()
            .by_session
            .get_mut(&token.session_id)
            .and_then(|holds| {
                holds
                    .iter_mut()
                    .find(|hold| hold.token_id == token.token_id)
            })
        {
            hold.generation = Some(self.current_epoch());
            hold.turn_id = message
                .get("options")
                .and_then(|options| options.get("turnId"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
    }

    fn begin_run(
        &self,
        session_id: &str,
        command_id: Option<&str>,
        generation: Option<u64>,
    ) -> ActiveRunToken {
        let mut registry = self.active_runs.lock();
        registry.next_token_id = registry.next_token_id.wrapping_add(1);
        let token_id = registry.next_token_id;
        cognia_power::acquire(cognia_power::WakeReason::ActiveRun(session_id.to_string()));
        registry
            .by_session
            .entry(session_id.to_string())
            .or_default()
            .push_back(ActiveRunHold {
                token_id,
                generation,
                command_id: command_id.map(str::to_string),
                turn_id: None,
                executor_id: None,
                wake_held: true,
            });
        ActiveRunToken {
            token_id,
            session_id: session_id.to_string(),
        }
    }

    pub fn cancel_active_run(&self, token: ActiveRunToken) {
        self.release_active_run_matching(&token.session_id, |hold| hold.token_id == token.token_id);
    }

    /// Host-owned executors survive renderer reloads, including background
    /// processes after a turn ends. Disposal releases their holds.
    pub fn live_session_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.active_runs.lock().by_session.keys().cloned().collect();
        ids.sort();
        ids
    }

    fn finish_active_run(&self, generation: u64, session_id: &str) {
        self.release_active_run_matching_from_back(session_id, |hold| {
            hold.generation == Some(generation) && hold.executor_id.is_none()
        });
    }

    fn finish_duplicate_active_run(&self, generation: u64, session_id: &str, command_id: &str) {
        self.release_active_run_matching_from_back(session_id, |hold| {
            hold.generation == Some(generation)
                && hold.command_id.as_deref() == Some(command_id)
                && hold.executor_id.is_none()
        });
    }

    fn finish_generation_active_runs(&self, generation: u64) {
        let releases = {
            let mut registry = self.active_runs.lock();
            let mut releases = Vec::new();
            registry.by_session.retain(|session_id, holds| {
                let before = holds.iter().filter(|hold| hold.wake_held).count();
                // Host-owned jobs can survive a sidecar crash. Started runtimes
                // remain unknown until independently disposed, even after exit.
                holds.retain(|hold| {
                    hold.generation != Some(generation) || hold.executor_id.is_some()
                });
                releases.extend(std::iter::repeat_n(
                    session_id.clone(),
                    before - holds.iter().filter(|hold| hold.wake_held).count(),
                ));
                !holds.is_empty()
            });
            releases
        };
        for session_id in releases {
            cognia_power::release(&cognia_power::WakeReason::ActiveRun(session_id));
        }
    }

    fn release_active_run_matching(
        &self,
        session_id: &str,
        predicate: impl FnMut(&ActiveRunHold) -> bool,
    ) {
        self.release_active_run_at(session_id, |holds| holds.iter().position(predicate));
    }

    fn release_active_run_matching_from_back(
        &self,
        session_id: &str,
        predicate: impl FnMut(&ActiveRunHold) -> bool,
    ) {
        self.release_active_run_at(session_id, |holds| holds.iter().rposition(predicate));
    }

    fn release_active_run_at(
        &self,
        session_id: &str,
        index: impl FnOnce(&VecDeque<ActiveRunHold>) -> Option<usize>,
    ) {
        let removed = {
            let mut registry = self.active_runs.lock();
            let Some(holds) = registry.by_session.get_mut(session_id) else {
                return;
            };
            let removed = index(holds).and_then(|index| holds.remove(index));
            if holds.is_empty() {
                registry.by_session.remove(session_id);
            }
            removed
        };
        if removed.is_some_and(|hold| hold.wake_held) {
            cognia_power::release(&cognia_power::WakeReason::ActiveRun(session_id.to_string()));
        }
    }

    /// Send one JSON-line command to the running sidecar. Locks only `stdin`
    /// (not the shared `inner` state) so a slow write never blocks hook-state
    /// reads; the `stdin` lock still serializes concurrent writers, preserving
    /// line ordering.
    pub async fn write_command(&self, msg: &Value) -> Result<(), String> {
        self.write_command_inner(msg, None).await
    }

    pub async fn write_pending_run_command(
        &self,
        msg: &Value,
        token: &ActiveRunToken,
    ) -> Result<(), String> {
        self.write_command_inner(msg, Some(token)).await
    }

    async fn write_command_inner(
        &self,
        msg: &Value,
        token: Option<&ActiveRunToken>,
    ) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "sidecar not running".to_string())?;
        // The exit path also needs stdin's lock before generation cleanup.
        // Until this lock is held, a pending writer must survive that cleanup.
        if let Some(token) = token {
            self.activate_pending_run(token, msg);
        }
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark the sidecar ready and reset the crash-loop counter. Called when the
    /// reader observes `{"type":"ready"}`.
    async fn note_ready(&self) {
        let mut guard = self.inner.lock().await;
        guard.ready = true;
        guard.backoff.reset();
    }

    /// Single sink for everything that must happen when the sidecar exits
    /// (crash, clean shutdown, or watchdog kill): drop the child + stdin, clear
    /// per-session hook state (R6 — otherwise orphaned on crash), and record the
    /// failure for backoff (R4). Locks `stdin` and `inner` sequentially (never
    /// nested) so there is no lock-ordering hazard.
    ///
    /// Returns whether the exit was *unexpected* — i.e. not preceded by
    /// [`kill_sidecar`]. Only unexpected exits are charged against the recovery
    /// restart budget; see [`Inner::intentional_stop`].
    async fn note_exit(&self, now: Instant) -> bool {
        self.stdin.lock().await.take();
        let mut guard = self.inner.lock().await;
        guard.child = None;
        guard.ready = false;
        guard.backoff.note_failure(now);
        !std::mem::take(&mut guard.intentional_stop)
    }

    /// Latch that the next exit was asked for, so [`note_exit`] does not charge
    /// it against the recovery restart budget.
    ///
    /// [`note_exit`]: Self::note_exit
    async fn note_intentional_stop(&self) {
        self.inner.lock().await.intentional_stop = true;
    }

    /// Remaining crash-backoff window at `now`, or `None` if a respawn may
    /// proceed immediately. Pure over the stored counters — unit-tested by
    /// injecting `now`.
    async fn backoff_remaining(&self, now: Instant) -> Option<Duration> {
        self.inner.lock().await.backoff.remaining(now)
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.ready
    }

    /// Wait for the live child to announce its ready frame.
    ///
    /// `spawn` intentionally returns once the process and reader tasks exist so
    /// send paths can queue work immediately. Boot/recovery callers need a
    /// stronger contract: they must not mark the subsystem healthy until the
    /// host has completed initialization. This method observes the same state
    /// the stdout reader updates and shares the watchdog's deadline.
    pub async fn wait_until_ready(&self) -> Result<(), String> {
        tokio::time::timeout(SIDECAR_READY_TIMEOUT, async {
            loop {
                {
                    let guard = self.inner.lock().await;
                    if guard.ready {
                        return Ok(());
                    }
                    if guard.child.is_none() {
                        return Err("sidecar exited before becoming ready".to_string());
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| {
            format!(
                "sidecar did not become ready within {}s",
                SIDECAR_READY_TIMEOUT.as_secs()
            )
        })?
    }

    /// Liveness snapshot for the unified managed-process registry
    /// (`crate::process_registry`). `Some((pid, ready))` while a child is
    /// alive (`pid` is `None` only if the OS already reaped it), `None` when
    /// no sidecar is running. Locks `inner` briefly and returns owned data —
    /// never held across an `.await`.
    pub async fn managed_snapshot(&self) -> Option<(Option<u32>, bool)> {
        let guard = self.inner.lock().await;
        guard.child.as_ref().map(|c| (c.id(), guard.ready))
    }
}

/// Spawn the Agent sidecar and start pumping its stdout into host events
/// (Tauri events on desktop, the companion EventBus headless — see
/// [`super::host`]).
///
/// Safe to call multiple times — subsequent calls become no-ops while the
/// child is alive.
pub async fn spawn(host: Arc<dyn SidecarHost>, state: SidecarState) -> Result<(), String> {
    let config =
        RuntimeConfig::from_env(RuntimeRole::Sidecar).map_err(|error| error.to_string())?;
    spawn_with_runtime(host, state, config, SIDECAR_READY_TIMEOUT).await
}

async fn spawn_with_runtime(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
    config: RuntimeConfig,
    ready_timeout: Duration,
) -> Result<(), String> {
    // Serialize concurrent spawns (mirrors `plugin_api/python` materialize_lock):
    // a second caller blocks here, then sees the live child below and no-ops,
    // so we can never start two sidecar processes for one slot.
    let _spawn_guard = state.spawn_lock.lock().await;
    let stop_epoch = state.stop_epoch.load(std::sync::atomic::Ordering::SeqCst);

    if state.inner.lock().await.child.is_some() {
        return Ok(());
    }

    // Recovery is holding the sidecar back — either its restart budget ran out
    // or the operator chose "keep off" in the diagnostics shell. Both are
    // cleared by `recovery_retry`, so the shell's Retry button is what makes
    // this path reachable again. Checked before backoff: a held-back subsystem
    // is a decision, not a delay, and the caller deserves to be told which.
    if host.is_disabled() {
        return Err(
            "sidecar is disabled by recovery; retry it from the diagnostics screen".to_string(),
        );
    }

    // Crash-loop backoff: don't hot-respawn a sidecar that keeps dying before it
    // can announce ready. A single transient death maps to a zero delay, so this
    // never penalizes a normal restart.
    if let Some(remaining) = state.backoff_remaining(Instant::now()).await {
        return Err(format!(
            "sidecar in crash-backoff ({} ms remaining); retry shortly",
            remaining.as_millis()
        ));
    }

    let script = host.resolve_script()?;
    let cwd = script
        .parent()
        .ok_or_else(|| "sidecar script has no parent dir".to_string())?
        .to_path_buf();

    // Probe only after explicit opt-in. A failed Bun is not retried on each send.
    let bun = if state
        .bun_disabled
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        None
    } else {
        match tokio::task::spawn_blocking(move || config.preferred_bun())
            .await
            .map_err(|error| error.to_string())?
        {
            Ok(runtime) => runtime,
            Err(error) => {
                log::warn!("sidecar: {error}; falling back to Node");
                state
                    .bun_disabled
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                None
            }
        }
    };
    let mut bun = bun;
    let mut startup_guard = StartupProcessGuard(None);
    let (child, stdout, stderr, stdin, mut startup_lines) = loop {
        if state.stop_epoch.load(std::sync::atomic::Ordering::SeqCst) != stop_epoch {
            return Err("sidecar startup cancelled by shutdown".into());
        }
        let executable = if let Some(runtime) = &bun {
            log::info!("sidecar: starting Bun {}", runtime.version);
            runtime.executable.clone()
        } else {
            let node = host.resolve_node_executable()?;
            state.ensure_node_version(&node).await?;
            node
        };
        let mut cmd = sidecar_command(
            &executable,
            &script,
            if bun.is_some() {
                RuntimeKind::Bun
            } else {
                RuntimeKind::Node
            },
        )?;
        cognia_exec_sandbox::proc_group::apply_process_group(&mut cmd);

        // Inject the host-resolved provider credentials (OAuth bearer → API key;
        // base URL orthogonal). See `host::inject_provider_env` for the precedence
        // rationale.
        host.inject_env(&mut cmd).await;

        // Inject the user's network proxy config so the Node sidecar's outbound
        // HTTP (Anthropic SDK + any provider relays) routes through the same
        // proxy as the rest of the app. The interceptor at
        // `sidecar/src/platform/net/fetch-interceptor.ts` reads HTTPS_PROXY at boot
        // and wraps the global undici dispatcher.
        let proxy_cfg = cognia_net::proxy_config::current().map_err(|error| error.to_string())?;
        apply_managed_proxy_env(&mut cmd, &proxy_cfg)?;

        // Code tool presentation (ADR-0117 Phase 4). The sidecar itself runs
        // unconfined — it needs egress to reach the model — so it cannot confine
        // the `run_code` children it forks. We hand it the OS confinement wrapper
        // to exec through instead. When this host has no backend the variable stays
        // unset, and the sidecar then refuses to register `run_code` at all.
        apply_code_sandbox_env(&mut cmd, &executable, &cwd);

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) if bun.is_some() => {
                log::warn!("sidecar: Bun spawn failed: {error}; falling back to Node");
                state
                    .bun_disabled
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                bun = None;
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "failed to spawn sidecar with Node.js at {}: {error}",
                    executable.display()
                ))
            }
        };

        startup_guard.0 = child.id();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "child has no stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "child has no stderr".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "child has no stdin".to_string())?;
        let mut stdout = BufReader::new(stdout).lines();
        let mut startup_lines = VecDeque::new();
        if bun.is_some() {
            // Nothing is published in state yet: no command can reach a failed Bun.
            // Drain stderr concurrently so a full pipe cannot stall the ready frame.
            let stderr_task = tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    log::warn!("[sidecar.stderr] {line}");
                }
            });
            let readiness = tokio::time::timeout(ready_timeout, async {
                let mut bytes = 0;
                loop {
                    if state.stop_epoch.load(std::sync::atomic::Ordering::SeqCst) != stop_epoch {
                        return Err("sidecar startup cancelled by shutdown".into());
                    }
                    let line = tokio::select! {
                        line = stdout.next_line() => line,
                        _ = tokio::time::sleep(Duration::from_millis(20)) => continue,
                    }
                    .map_err(|error| error.to_string())?
                    .ok_or("Bun sidecar exited before ready")?;
                    bytes += line.len();
                    if bytes > 1024 * 1024 {
                        return Err("Bun sidecar startup output exceeded 1 MiB".to_string());
                    }
                    let ready = serde_json::from_str::<Value>(&line)
                        .ok()
                        .is_some_and(|event| {
                            event.get("type").and_then(Value::as_str) == Some("ready")
                        });
                    startup_lines.push_back(line);
                    if ready {
                        return Ok(());
                    }
                }
            })
            .await
            .unwrap_or_else(|_| Err("Bun sidecar ready deadline exceeded".into()));
            if let Err(error) = readiness {
                cognia_exec_sandbox::proc_group::kill_process_group(child.id());
                let _ = child.start_kill();
                tokio::time::timeout(Duration::from_secs(3), child.wait())
                    .await
                    .map_err(|_| "could not reap failed Bun sidecar; Node fallback refused")?
                    .map_err(|error| format!("could not reap failed Bun sidecar: {error}"))?;
                startup_guard.0 = None;
                stderr_task.abort();
                if state.stop_epoch.load(std::sync::atomic::Ordering::SeqCst) != stop_epoch {
                    return Err("sidecar startup cancelled by shutdown".into());
                }
                log::warn!("sidecar: {error}; falling back to Node");
                state
                    .bun_disabled
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                bun = None;
                continue;
            }
            // The Bun stderr task already owns this stream.
            break (child, stdout, None, stdin, startup_lines);
        }
        break (child, stdout, Some(stderr), stdin, startup_lines);
    };

    // Claim this spawn's generation (under `spawn_lock`, so it's serial). The
    // watchdog below captures it to avoid acting on a superseded child.
    let my_epoch = state.next_epoch();

    // stdin lives behind its own lock (see `write_command`); child + ready stay
    // in the shared state.
    {
        // Wait for both slots before publishing either. Cancellation still
        // leaves the process group owned by the startup guard at this point.
        let mut stdin_slot = state.stdin.lock().await;
        let mut guard = state.inner.lock().await;
        *stdin_slot = Some(stdin);
        guard.child = Some(child);
        guard.ready = false;
    }
    // ADR-0028 Phase 14 — surface the spawn so Diagnostics can show
    // "Sidecar restarted N times this session".
    state.bump_restart_count();

    // Pipe stdout: each line is one JSON event we forward through the host.
    {
        let host = Arc::clone(&host);
        let state = state.clone();
        tokio::spawn(async move {
            let mut reader = stdout;
            loop {
                let next = match startup_lines.pop_front() {
                    Some(line) => Ok(Some(line)),
                    None => reader.next_line().await,
                };
                match next {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => {
                                // Track the sidecar's "ready" announcement so we can short-circuit
                                // status checks before it has fully booted (also resets the
                                // crash-loop counter and disarms the ready watchdog).
                                if value.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    state.note_ready().await;
                                }
                                handle_active_run_event(&state, my_epoch, &value);
                                // PreToolUse hook: when the sidecar emits a permission_request
                                // we may need to short-circuit it with an automatic deny.
                                // Spawn the hook eval as a task so the reader keeps draining
                                // — concurrent permission_request events are evaluated in
                                // parallel.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("permission_request")
                                {
                                    let host = Arc::clone(&host);
                                    tokio::spawn(async move {
                                        handle_permission_request(host, value).await;
                                    });
                                    continue;
                                }
                                // `host_rpc` is answered HERE, in Rust, and never
                                // forwarded to the renderer. That is the whole
                                // point of the frame: background-job calls have
                                // to work on a headless host (no renderer at
                                // all) and must not pay an extra network hop
                                // when a remote client is driving the desktop.
                                // Spawned so the reader keeps draining — a
                                // long-polling `jobs.wait` would otherwise block
                                // every other event behind it.
                                if value.get("type").and_then(|t| t.as_str()) == Some("host_rpc") {
                                    let host = Arc::clone(&host);
                                    let state = state.clone();
                                    tokio::spawn(async move {
                                        answer_host_rpc(host, state, value).await;
                                    });
                                    continue;
                                }
                                // A2UI bridge dispatches go on a dedicated channel so the
                                // a2ui store can listen without filtering every sidecar event.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("a2ui_dispatch")
                                {
                                    host.emit(A2UI_EVENT, &value);
                                    continue;
                                }
                                // Canonical envelopes (ADR-0090) ride their own
                                // channel; they are additive alongside the raw
                                // stream and never re-enter SIDECAR_EVENT.
                                if value.get("type").and_then(|t| t.as_str()) == Some("agent_event")
                                {
                                    host.emit(AGENT_EVENT, &value);
                                    continue;
                                }
                                // Built-in lifecycle execution is SDK-native.
                                // Rust only owns external-agent compatibility
                                // hooks; reclassifying this stream would execute
                                // SessionStart/Stop/Task handlers twice.
                                host.emit(SIDECAR_EVENT, &value);
                            }
                            Err(e) => {
                                log::warn!("sidecar emitted non-JSON line: {e}: {trimmed}");
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::error!("sidecar stdout read error: {e}");
                        break;
                    }
                }
            }
            // The sidecar exited. Clear state (incl. orphaned per-session hook
            // state) and record the failure so the next spawn can back off a
            // crash loop. `note_exit` is the single sink for all of that.
            let unexpected = state.note_exit(Instant::now()).await;
            state.finish_generation_active_runs(my_epoch);
            if unexpected {
                // ADR-0102 §4 — three automatic restarts per subsystem, then
                // the subsystem is held back and the app enters safe mode. The
                // local `CrashBackoff` above paces the *next* respawn; this
                // budget is what stops an unpaceable loop.
                host.report_failure();
            }
            log::warn!("sidecar process ended");
            host.emit(
                SIDECAR_EVENT,
                &serde_json::json!({ "type": "sidecar_exited" }),
            );
        });
    }

    // Forward stderr to the parent log so users can debug install issues.
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("[sidecar.stderr] {line}");
            }
        });
    }

    // Ready watchdog: a child that never announces `ready` (e.g. Node hung on a
    // bad install) would otherwise sit forever while sends silently queue. Wait
    // up to SIDECAR_READY_TIMEOUT (reusing tokio::time::timeout + the existing
    // kill_sidecar) and kill it if it never boots, so the failure surfaces and
    // the next spawn can back off.
    {
        let host = Arc::clone(&host);
        let state = state.clone();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(SIDECAR_READY_TIMEOUT, async {
                loop {
                    // A newer spawn superseded us — our child is gone; stop
                    // watching so we never kill a healthy successor.
                    if state.current_epoch() != my_epoch {
                        return false;
                    }
                    {
                        let guard = state.inner.lock().await;
                        if guard.ready {
                            return true; // became ready
                        }
                        if guard.child.is_none() {
                            return false; // already exited; the reader handled it
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await;
            // Only act on a timeout, and only if we're still the current
            // generation (the child we armed against is the live one).
            if outcome.is_err() && state.current_epoch() == my_epoch {
                // Still pending at the deadline — kill so the reader records the
                // failure (feeding backoff). The reader's EOF handler emits the
                // `sidecar_exited` event; we add a `log` line so the user sees
                // *why* (avoids a duplicate `sidecar_exited`).
                //
                // A child that never announced ready is a genuine failure, so
                // report it here: `kill_sidecar` latches the exit as
                // intentional, which would otherwise let a boot that hangs
                // forever escape the recovery restart budget entirely.
                host.report_failure();
                kill_sidecar(state.clone()).await;
                host.emit(
                    SIDECAR_EVENT,
                    &serde_json::json!({
                        "type": "log",
                        "level": "error",
                        "message": format!(
                            "sidecar did not become ready within {}s; restarting",
                            SIDECAR_READY_TIMEOUT.as_secs()
                        ),
                    }),
                );
            }
        });
    }

    startup_guard.0 = None;
    Ok(())
}
/// Answer one `host_rpc` frame and write the result back down the sidecar's
/// stdin.
///
/// Deliberately terminal: unlike `plugin_tool_exec`, this frame is never
/// emitted onward to the renderer. Background jobs are owned by Rust, so the
/// renderer has nothing to contribute and a headless host has no renderer to
/// ask.
///
/// A failed dispatch still writes a frame — an unanswered `rpcId` would leave
/// the sidecar's caller hanging until its own timeout, turning a clean error
/// into a stall.
async fn answer_host_rpc(host: Arc<dyn SidecarHost>, state: SidecarState, value: Value) {
    let Some(rpc_id) = value.get("rpcId").and_then(|v| v.as_str()) else {
        log::warn!("host_rpc frame without an rpcId; dropping");
        return;
    };
    let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = value.get("params").cloned().unwrap_or(Value::Null);

    let dispatched = host.dispatch_host_rpc(method, &params).await;

    let reply = match dispatched {
        Ok(result) => serde_json::json!({
            "type": "host_rpc_result",
            "rpcId": rpc_id,
            "ok": true,
            "result": result,
        }),
        Err(error) => {
            log::warn!("host_rpc {method} failed: {error}");
            serde_json::json!({
                "type": "host_rpc_result",
                "rpcId": rpc_id,
                "ok": false,
                "error": error,
            })
        }
    };
    if let Err(e) = state.write_command(&reply).await {
        // The sidecar is gone; its pending calls are rejected on its own side
        // when stdin closes, so there is nothing further to do here.
        log::warn!("could not deliver host_rpc_result for {method}: {e}");
    }
}

/// Forward a `permission_request` event from the sidecar. Both PreToolUse and
/// PermissionRequest hooks run in the SDK-native sidecar callback pipeline;
/// Rust must not execute either event again.
///
/// The forward at the bottom is load-bearing on headless hosts: it MUST reach
/// the EventBus (→ `/ws/v1/events`) or every gated tool call deadlocks
/// waiting for an approval nobody saw.
async fn handle_permission_request(host: Arc<dyn SidecarHost>, value: Value) {
    // Forward so the normal approval flow can run (WebView approval store on
    // desktop; `/ws/v1/events` subscribers headless).
    host.emit(SIDECAR_EVENT, &value);
}

/// Stop the running sidecar (drop stdin, kill the child). The next
/// `claude_send` will respawn it. Safe to call when no sidecar is running.
///
/// Deliberate by definition — the resulting exit is latched as intentional so
/// it is not charged against the recovery restart budget. The one caller that
/// kills because of a *genuine* failure (the ready watchdog) reports that
/// failure itself before calling this.
pub async fn shutdown_sidecar(state: SidecarState) -> Result<(), String> {
    state
        .stop_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _spawn_guard = state.spawn_lock.lock().await;
    shutdown_sidecar_locked(&state).await
}

async fn shutdown_sidecar_locked(state: &SidecarState) -> Result<(), String> {
    state.note_intentional_stop().await;
    // Closing stdin first lets the sidecar exit cleanly (its stdin EOF handler
    // tears down active sessions). stdin lives behind its own lock; take it
    // before touching `inner` (stdin→inner order, never nested).
    state.stdin.lock().await.take();
    let child = {
        let mut guard = state.inner.lock().await;
        guard.ready = false;
        guard.child.take()
    };
    let Some(mut child) = child else {
        return Ok(());
    };

    // Give the stdin-EOF handler a bounded opportunity to close active SDK
    // sessions and their descendants before escalating. A credential boundary
    // must not report success while the old process is still alive.
    match tokio::time::timeout(Duration::from_millis(750), child.wait()).await {
        Ok(Ok(_)) => return Ok(()),
        Ok(Err(error)) => return Err(format!("failed waiting for sidecar shutdown: {error}")),
        Err(_) => {}
    }

    let pid = child.id();
    cognia_exec_sandbox::proc_group::kill_process_group(pid);
    child
        .start_kill()
        .map_err(|error| format!("failed to kill sidecar: {error}"))?;
    tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .map_err(|_| "timed out waiting for sidecar process to exit".to_string())?
        .map_err(|error| format!("failed reaping sidecar process: {error}"))?;
    Ok(())
}

pub async fn kill_sidecar(state: SidecarState) {
    if let Err(error) = shutdown_sidecar(state).await {
        log::warn!("sidecar shutdown failed: {error}");
    }
}

/// Serialize a configuration-driven restart against spawn and propagate any
/// shutdown/reap failure to the settings command. The next request respawns the
/// child with a fresh, already-committed environment.
pub async fn restart_sidecar_for_config(state: SidecarState) -> Result<(), String> {
    shutdown_sidecar(state).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    struct RuntimeTestHost {
        script: PathBuf,
        events: ParkingMutex<Vec<Value>>,
    }

    #[cfg(unix)]
    #[async_trait::async_trait]
    impl SidecarHost for RuntimeTestHost {
        fn resolve_script(&self) -> Result<PathBuf, String> {
            Ok(self.script.clone())
        }
        fn emit(&self, _: &str, payload: &Value) {
            self.events.lock().push(payload.clone());
        }
        async fn inject_env(&self, _: &mut Command) {}
        fn is_disabled(&self) -> bool {
            false
        }
        fn report_failure(&self) {
            panic!("pre-admission fallback must not spend the recovery budget")
        }
        async fn dispatch_host_rpc(&self, _: &str, _: &Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn kind(&self) -> &'static str {
            "runtime-test"
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bun_boot_failures_fall_back_before_commands_are_admitted() {
        use std::os::unix::fs::PermissionsExt;
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        for body in ["exit 9", "exec sleep 30"] {
            let dir = tempfile::tempdir().unwrap();
            let bun = dir.path().join("bun");
            std::fs::write(&bun, format!("#!/bin/sh\nif [ \"$1\" = --eval ]; then printf cognia-bun:1.4.0; exit; fi\n{body}\n")).unwrap();
            std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o700)).unwrap();
            let script = dir.path().join("host.mjs");
            std::fs::write(&script, "import readline from 'node:readline';\nconsole.log(JSON.stringify({type:'ready',runtime:process.versions.bun?'bun':'node'}));\nreadline.createInterface({input:process.stdin}).on('line', line=>console.log(line)).on('close',()=>process.exit(0));\n").unwrap();
            let host = Arc::new(RuntimeTestHost {
                script,
                events: ParkingMutex::new(Vec::new()),
            });
            let state = SidecarState::new();
            let config = RuntimeConfig::parse(Some("bun"), Some(bun)).unwrap();
            let spawn_task = tokio::spawn(spawn_with_runtime(
                host.clone(),
                state.clone(),
                config,
                Duration::from_millis(100),
            ));
            if body == "exec sleep 30" {
                tokio::time::sleep(Duration::from_millis(20)).await;
                // The failed Bun never owns a visible stdin or generation.
                assert_eq!(state.restart_count(), 0);
                assert!(state
                    .write_command(&serde_json::json!({"type":"never-admitted"}))
                    .await
                    .is_err());
            }
            spawn_task.await.unwrap().unwrap();
            state.wait_until_ready().await.unwrap();
            assert!(state
                .bun_disabled
                .load(std::sync::atomic::Ordering::Relaxed));
            assert_eq!(state.restart_count(), 1);
            state
                .write_command(&serde_json::json!({"type":"accepted-once"}))
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if host
                        .events
                        .lock()
                        .iter()
                        .any(|event| event["type"] == "accepted-once")
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            shutdown_sidecar(state.clone()).await.unwrap();
            assert_eq!(
                host.events
                    .lock()
                    .iter()
                    .filter(|event| event["type"] == "accepted-once")
                    .count(),
                1
            );
            assert!(host
                .events
                .lock()
                .iter()
                .any(|event| event["type"] == "ready" && event["runtime"] == "node"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_bun_can_start_the_real_sidecar_protocol() {
        let Some(bun) = std::env::var_os("COGNIA_TEST_BUN") else {
            return;
        };
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        let host = Arc::new(RuntimeTestHost {
            script: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../sidecar/agent-host.mjs")
                .canonicalize()
                .unwrap(),
            events: ParkingMutex::new(Vec::new()),
        });
        let state = SidecarState::new();
        let config = RuntimeConfig::parse(Some("bun"), Some(bun.into())).unwrap();
        spawn_with_runtime(host.clone(), state.clone(), config, Duration::from_secs(20))
            .await
            .unwrap();
        state.wait_until_ready().await.unwrap();
        assert!(
            !state
                .bun_disabled
                .load(std::sync::atomic::Ordering::Relaxed),
            "real Bun must not silently fall back"
        );
        state
            .write_command(&serde_json::json!({"command":"close","sessionId":"runtime-smoke"}))
            .await
            .unwrap();
        shutdown_sidecar(state).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_cancels_private_bun_startup_without_late_publication_or_fallback() {
        use std::os::unix::fs::PermissionsExt;
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let bun = dir.path().join("bun");
        let pid_file = dir.path().join("started");
        std::fs::write(&bun, format!("#!/bin/sh\nif [ \"$1\" = --eval ]; then printf cognia-bun:1.4.0; exit; fi\necho $$ > '{}'\nexec sleep 30\n", pid_file.display())).unwrap();
        std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = dir.path().join("host.mjs");
        std::fs::write(
            &script,
            "throw new Error('Node fallback must not start after shutdown')",
        )
        .unwrap();
        let host = Arc::new(RuntimeTestHost {
            script,
            events: ParkingMutex::new(Vec::new()),
        });
        let state = SidecarState::new();
        let config = RuntimeConfig::parse(Some("bun"), Some(bun)).unwrap();
        let task = tokio::spawn(spawn_with_runtime(
            host,
            state.clone(),
            config,
            Duration::from_secs(30),
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), shutdown_sidecar(state.clone()))
            .await
            .unwrap()
            .unwrap();
        assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
        assert_eq!(state.restart_count(), 0);
        assert!(state.managed_snapshot().await.is_none());
        assert!(!state
            .bun_disabled
            .load(std::sync::atomic::Ordering::Relaxed));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        assert!(!std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .status()
            .unwrap()
            .success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn abort_during_publication_keeps_stdin_empty_and_kills_bun_descendants() {
        use std::os::unix::fs::PermissionsExt;
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let bun = dir.path().join("bun");
        let marker = dir.path().join("started");
        let descendant = dir.path().join("descendant");
        let release = dir.path().join("ready");
        std::fs::write(&bun, format!("#!/bin/sh\nif [ \"$1\" = --eval ]; then printf cognia-bun:1.4.0; exit; fi\necho $$ > '{}'\nsleep 30 &\necho $! > '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nprintf '{{\"type\":\"ready\"}}\\n'\nwait\n", marker.display(), descendant.display(), release.display())).unwrap();
        std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = dir.path().join("host.mjs");
        std::fs::write(&script, "unused").unwrap();
        let host = Arc::new(RuntimeTestHost {
            script,
            events: ParkingMutex::new(Vec::new()),
        });
        let state = SidecarState::new();
        let config = RuntimeConfig::parse(Some("bun"), Some(bun)).unwrap();
        let task = tokio::spawn(spawn_with_runtime(
            host,
            state.clone(),
            config,
            Duration::from_secs(3),
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !descendant.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let inner = state.inner.lock().await;
        std::fs::write(release, "ready").unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.stdin.try_lock().is_ok() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(state.stdin.lock().await.is_none());
        assert!(inner.child.is_none());
        drop(inner);
        for file in [marker, descendant] {
            let pid = std::fs::read_to_string(file).unwrap();
            let mut alive = true;
            for _ in 0..50 {
                alive = std::process::Command::new("kill")
                    .args(["-0", pid.trim()])
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!alive, "cancelled startup left process {pid} alive");
        }
    }
    #[cfg(windows)]
    #[test]
    fn node_resource_paths_preserve_drive_unc_and_non_verbatim_paths() {
        for (input, expected) in [
            (
                r"\\?\D:\app with spaces\测试\agent-host.mjs",
                r"D:\app with spaces\测试\agent-host.mjs",
            ),
            (
                r"\\?\UNC\server\share\app\agent-host.mjs",
                r"\\server\share\app\agent-host.mjs",
            ),
            (r"D:\app\agent-host.mjs", r"D:\app\agent-host.mjs"),
            (
                r"\\server\share\app\agent-host.mjs",
                r"\\server\share\app\agent-host.mjs",
            ),
            (r"\\?\Volume{test}\app", r"\\?\Volume{test}\app"),
            ("node", "node"),
        ] {
            assert_eq!(node_resource_path(Path::new(input)), Path::new(expected));
        }
    }

    #[tokio::test]
    async fn sidecar_entrypoint_starts_from_canonical_resource_path() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("sidecar with spaces 测试");
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("agent-host.mjs");
        std::fs::write(&script, "console.log('sidecar-entrypoint-ready')").unwrap();
        let script = script.canonicalize().unwrap();
        let node = std::env::var_os("COGNIA_TEST_NODE").unwrap_or_else(|| "node".into());
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            sidecar_command(Path::new(&node), &script, RuntimeKind::Node)
                .unwrap()
                .output(),
        )
        .await
        .expect("Node entrypoint timed out")
        .expect("Node runtime must be installed to test sidecar startup");
        assert!(
            output.status.success(),
            "Node could not start the canonical resource path: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "sidecar-entrypoint-ready"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn sidecar_background_children_have_no_console_window() {
        let output = background_command(Path::new("powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();' -Name ConsoleProbe -Namespace Cognia; [Cognia.ConsoleProbe]::GetConsoleWindow().ToInt64()",
            ])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[test]
    fn old_generation_cleanup_preserves_successor_holds() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let reason = cognia_power::WakeReason::ActiveRun("shared-session".into());

        let old_generation = state.next_epoch();
        state.begin_active_run("shared-session", Some("old-command"));
        let new_generation = state.next_epoch();
        state.begin_active_run("shared-session", Some("new-command"));

        state.finish_generation_active_runs(old_generation);
        assert!(cognia_power::active_reasons().contains(&reason));

        state.finish_generation_active_runs(new_generation);
        assert!(!cognia_power::active_reasons().contains(&reason));
    }

    #[test]
    fn disposal_releases_only_its_executor_and_all_of_that_executors_turns() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let generation = state.next_epoch();
        for executor in ["old", "old", "replacement"] {
            state.begin_active_run("reused-session", None);
            handle_active_run_event(
                &state,
                generation,
                &serde_json::json!({
                    "type": "executor_started", "sessionId": "reused-session", "executorId": executor
                }),
            );
        }
        for executor in ["unknown", "old"] {
            handle_active_run_event(
                &state,
                generation,
                &serde_json::json!({
                    "type": "session_disposed", "sessionId": "reused-session", "executorId": executor
                }),
            );
            assert_eq!(state.live_session_ids(), vec!["reused-session"]);
        }
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "capability_error", "command": "send", "sessionId": "reused-session"
            }),
        );
        assert_eq!(state.live_session_ids(), vec!["reused-session"]);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_disposed", "sessionId": "reused-session", "executorId": "replacement"
            }),
        );
        assert!(state.live_session_ids().is_empty());
    }

    #[test]
    fn idle_turn_releases_wake_without_claiming_session_disposal() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let generation = state.next_epoch();
        let reason = cognia_power::WakeReason::ActiveRun("idle-chat".into());
        state.begin_active_run("idle-chat", None);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "executor_started", "sessionId": "idle-chat", "executorId": "executor"
            }),
        );
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_ended", "sessionId": "idle-chat"
            }),
        );
        assert!(cognia_power::active_reasons().contains(&reason));
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "turn_settled", "sessionId": "idle-chat", "executorId": "executor", "backgroundProcessesRunning": false
            }),
        );
        assert!(!cognia_power::active_reasons().contains(&reason));
        assert_eq!(state.live_session_ids(), vec!["idle-chat"]);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_disposed", "sessionId": "idle-chat", "executorId": "executor"
            }),
        );
        assert!(state.live_session_ids().is_empty());
    }

    #[test]
    fn turn_end_keeps_background_executor_live_until_disposal() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let generation = state.next_epoch();
        state.begin_active_run("background-child", None);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "executor_started", "sessionId": "background-child", "executorId": "executor"
            }),
        );
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_ended", "sessionId": "background-child"
            }),
        );
        assert_eq!(state.clone().live_session_ids(), vec!["background-child"]);
        state.finish_generation_active_runs(generation);
        assert_eq!(state.clone().live_session_ids(), vec!["background-child"]);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_disposed", "sessionId": "background-child", "executorId": "executor"
            }),
        );
        assert!(state.live_session_ids().is_empty());
    }

    #[test]
    fn host_liveness_survives_renderer_reload_until_all_turns_end() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        assert!(state.live_session_ids().is_empty());
        let generation = state.next_epoch();
        let first = state.begin_active_run("surviving-session", None);
        state.begin_active_run("surviving-session", Some("queued"));
        // The WebView reloads; the Rust state and pending turns survive.
        let reloaded = state.clone();
        assert_eq!(reloaded.live_session_ids(), vec!["surviving-session"]);
        state.cancel_active_run(first);
        assert_eq!(reloaded.live_session_ids(), vec!["surviving-session"]);
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "executor_started", "sessionId": "surviving-session", "executorId": "executor"
            }),
        );
        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "session_disposed", "sessionId": "surviving-session", "executorId": "executor"
            }),
        );
        assert!(reloaded.live_session_ids().is_empty());
        state.begin_active_run("old-host", None);
        assert!(SidecarState::new().live_session_ids().is_empty());
        state.finish_generation_active_runs(generation);
        assert!(reloaded.live_session_ids().is_empty());
    }

    #[test]
    fn pending_native_admission_survives_spawn_and_old_generation_cleanup() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let old = state.next_epoch();
        let pending = state.begin_pending_run("pending-send", None);
        assert_eq!(state.clone().live_session_ids(), vec!["pending-send"]);
        state.finish_generation_active_runs(old);
        assert_eq!(state.live_session_ids(), vec!["pending-send"]);
        let next = state.next_epoch();
        state.activate_pending_run(&pending, &serde_json::json!({}));
        state.finish_generation_active_runs(old);
        assert_eq!(state.live_session_ids(), vec!["pending-send"]);
        handle_active_run_event(
            &state,
            next,
            &serde_json::json!({
                "type": "executor_started", "sessionId": "pending-send", "executorId": "executor"
            }),
        );
        handle_active_run_event(
            &state,
            next,
            &serde_json::json!({
                "type": "session_disposed", "sessionId": "pending-send", "executorId": "executor"
            }),
        );
        assert!(state.live_session_ids().is_empty());
        let failed = state.begin_pending_run("rejected-send", None);
        state.cancel_active_run(failed);
        assert!(state.live_session_ids().is_empty());
    }

    #[tokio::test]
    async fn native_send_is_live_while_waiting_for_spawn_admission() {
        use std::future::Future;
        let state = SidecarState::new();
        let spawn_guard = state.spawn_lock.lock().await;
        let host = Arc::new(crate::host::tests::TestHost {
            disabled: true,
            ..Default::default()
        });
        let mut send = Box::pin(crate::commands::claude_send_with_host_and_id(
            host,
            state.clone(),
            "pending-native-admission".into(),
            serde_json::json!("work"),
            None,
            None,
        ));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(send.as_mut().poll(&mut cx).is_pending());
        assert_eq!(
            state.clone().live_session_ids(),
            vec!["pending-native-admission"]
        );
        drop(spawn_guard);
        assert!(send.await.is_err());
        assert!(state.live_session_ids().is_empty());
    }

    #[test]
    fn rejected_send_event_releases_its_generation_hold() {
        let _guard = cognia_power::ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let generation = state.next_epoch();
        let reason = cognia_power::WakeReason::ActiveRun("rejected-session".into());
        state.begin_active_run("rejected-session", Some("rejected-command"));

        handle_active_run_event(
            &state,
            generation,
            &serde_json::json!({
                "type": "capability_error",
                "sessionId": "rejected-session",
                "command": "send",
            }),
        );

        assert!(!cognia_power::active_reasons().contains(&reason));
    }

    #[test]
    fn parse_node_major_handles_all_forms() {
        // Canonical `node --version` output.
        assert_eq!(parse_node_major("v20.11.0\n"), Some(20));
        assert_eq!(parse_node_major("v18.19.0"), Some(18));
        // Missing leading `v` is tolerated.
        assert_eq!(parse_node_major("22.1.0"), Some(22));
        // Surrounding whitespace is trimmed.
        assert_eq!(parse_node_major("  v24.0.0  "), Some(24));
        // Garbage / empty input yields None (caller treats as "unknown").
        assert_eq!(parse_node_major(""), None);
        assert_eq!(parse_node_major("vX.Y.Z"), None);
        assert_eq!(parse_node_major("not a version"), None);
    }

    fn command_env(cmd: &Command, key: &str) -> Option<Option<String>> {
        cmd.as_std()
            .get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new(key))
            .map(|(_, value)| value.map(|item| item.to_string_lossy().into_owned()))
    }

    #[test]
    fn active_proxy_env_is_marked_as_host_managed() {
        let mut cmd = Command::new("node");
        let cfg = cognia_net::proxy_config::ProxyConfig {
            mode: cognia_net::proxy_config::ProxyMode::Manual,
            protocol: cognia_net::proxy_config::ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            ..cognia_net::proxy_config::ProxyConfig::default()
        };

        apply_managed_proxy_env(&mut cmd, &cfg).unwrap();

        assert_eq!(
            command_env(&cmd, "HTTPS_PROXY"),
            Some(Some("http://127.0.0.1:7890".to_string()))
        );
        assert_eq!(
            command_env(&cmd, "COGNIA_MANAGED_NETWORK_PROXY"),
            Some(Some("1".to_string()))
        );
    }

    #[test]
    fn direct_proxy_policy_removes_inherited_proxy_env_and_marker() {
        let mut cmd = Command::new("node");

        apply_managed_proxy_env(&mut cmd, &cognia_net::proxy_config::ProxyConfig::default())
            .unwrap();

        assert_eq!(command_env(&cmd, "HTTPS_PROXY"), Some(None));
        assert_eq!(
            command_env(&cmd, "COGNIA_MANAGED_NETWORK_PROXY"),
            Some(None)
        );
    }

    #[test]
    fn active_proxy_without_a_valid_environment_is_rejected() {
        let mut cmd = Command::new("node");
        let cfg = cognia_net::proxy_config::ProxyConfig {
            mode: cognia_net::proxy_config::ProxyMode::Manual,
            protocol: cognia_net::proxy_config::ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            username: Some("alice".to_string()),
            password: None,
            ..cognia_net::proxy_config::ProxyConfig::default()
        };

        assert_eq!(
            apply_managed_proxy_env(&mut cmd, &cfg).unwrap_err(),
            "PROXY_INVALID_CONFIG: sidecar proxy environment is unavailable"
        );
        assert_eq!(command_env(&cmd, "HTTPS_PROXY"), None);
    }

    // The pure backoff-table tests moved to `supervision_backoff.rs` with the
    // extraction (R6); the state-level tests below still exercise the
    // SidecarState wiring around `CrashBackoff`.

    #[tokio::test]
    async fn an_unasked_for_exit_is_reported_as_unexpected() {
        let s = SidecarState::new();
        assert!(
            s.note_exit(Instant::now()).await,
            "a crash must be charged against the recovery restart budget"
        );
    }

    #[tokio::test]
    async fn a_deliberate_stop_is_not_charged_to_the_restart_budget() {
        let s = SidecarState::new();
        s.note_intentional_stop().await;
        assert!(!s.note_exit(Instant::now()).await);
    }

    #[tokio::test]
    async fn configuration_restart_is_safe_without_a_running_child() {
        restart_sidecar_for_config(SidecarState::new())
            .await
            .expect("restart");
    }

    #[tokio::test]
    async fn the_intentional_latch_covers_exactly_one_exit() {
        // Otherwise a single "restart sidecar" click would mask every later
        // crash, and the budget would never fire.
        let s = SidecarState::new();
        s.note_intentional_stop().await;
        assert!(!s.note_exit(Instant::now()).await);
        assert!(s.note_exit(Instant::now()).await);
    }

    #[tokio::test]
    async fn killing_the_sidecar_latches_the_intentional_stop() {
        let s = SidecarState::new();
        // No child is running; the latch must still be set, because the reader
        // task for a child that is already dying will consume it.
        kill_sidecar(s.clone()).await;
        assert!(!s.note_exit(Instant::now()).await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn strict_shutdown_waits_until_the_sidecar_is_reaped() {
        let state = SidecarState::new();
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30")
            .stdin(Stdio::piped())
            .kill_on_drop(true);
        cognia_exec_sandbox::proc_group::apply_process_group(&mut command);
        let child = command.spawn().expect("spawn test sidecar");
        let pid = child.id().expect("child pid");
        state.inner.lock().await.child = Some(child);

        shutdown_sidecar(state.clone())
            .await
            .expect("strict shutdown");

        assert!(state.inner.lock().await.child.is_none());
        let still_alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        assert!(!still_alive, "sidecar process {pid} must be reaped");
    }

    #[tokio::test]
    async fn backoff_remaining_none_before_any_failure() {
        let s = SidecarState::new();
        assert!(s.backoff_remaining(Instant::now()).await.is_none());
    }

    #[tokio::test]
    async fn backoff_remaining_single_failure_is_immediate() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await; // failures = 1 → delay 0 → no backoff
        assert!(s.backoff_remaining(t0).await.is_none());
    }

    #[tokio::test]
    async fn backoff_remaining_inside_and_past_window() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await; // failures = 1
        s.note_exit(t0).await; // failures = 2 → delay 250ms
        let inside = s.backoff_remaining(t0 + Duration::from_millis(100)).await;
        assert!(inside.is_some());
        assert!(inside.unwrap() <= Duration::from_millis(150));
        assert!(s
            .backoff_remaining(t0 + Duration::from_millis(300))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn note_ready_resets_crash_loop() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await;
        s.note_exit(t0).await; // failures = 2
        s.note_ready().await; // a successful boot clears the counter
        assert!(s
            .backoff_remaining(t0 + Duration::from_millis(1))
            .await
            .is_none());
    }

    #[test]
    fn spawn_epoch_advances_monotonically() {
        let s = SidecarState::new();
        assert_eq!(s.current_epoch(), 0);
        let e1 = s.next_epoch();
        let e2 = s.next_epoch();
        assert_eq!(e1, 1);
        assert_eq!(e2, 2);
        assert_eq!(s.current_epoch(), 2);
        // A watchdog armed at generation e1 can detect it has been superseded.
        assert_ne!(e1, s.current_epoch());
    }

    #[tokio::test]
    async fn write_command_errors_when_not_running() {
        let s = SidecarState::new();
        let err = s
            .write_command(&serde_json::json!({ "type": "send" }))
            .await
            .unwrap_err();
        assert!(err.contains("not running"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn managed_snapshot_is_none_when_no_child() {
        let s = SidecarState::new();
        assert!(s.managed_snapshot().await.is_none());
    }
    #[tokio::test]
    async fn host_recovery_refuses_spawn_before_resolving_a_script() {
        let host = Arc::new(crate::host::tests::TestHost {
            disabled: true,
            ..Default::default()
        });
        let error = spawn(host, SidecarState::new()).await.unwrap_err();
        assert!(error.contains("disabled by recovery"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn host_rpc_reply_uses_the_host_dispatcher_without_emitting_to_renderer() {
        let host = Arc::new(crate::host::tests::TestHost::default());
        let state = SidecarState::new();
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        *state.stdin.lock().await = child.stdin.take();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        answer_host_rpc(
            host.clone(),
            state.clone(),
            serde_json::json!({
                "rpcId": "rpc-1", "method": "sessionStore.append", "params": { "sessionId": "s1" }
            }),
        )
        .await;
        let line = tokio::time::timeout(Duration::from_secs(2), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["type"], "host_rpc_result");
        assert_eq!(reply["rpcId"], "rpc-1");
        assert_eq!(reply["result"]["method"], "sessionStore.append");
        assert_eq!(reply["result"]["params"]["sessionId"], "s1");
        assert!(host.events.lock().is_empty());
        state.stdin.lock().await.take();
        child.wait().await.unwrap();
    }
}
