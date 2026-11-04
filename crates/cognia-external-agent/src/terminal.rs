//! ACP Terminal Management
//!
//! Provides terminal functionality for ACP agents.
//! Handles spawning, output collection, and lifecycle management
//! of terminal processes requested by external agents.

use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{timeout, Duration};

/// Terminal output line
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub text: String,
    pub is_stderr: bool,
    pub timestamp: u64,
}

/// Terminal process exit status
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// Lightweight liveness snapshot of one ACP terminal, consumed by the
/// unified managed-process registry (`src-tauri/src/process_registry`). Kept
/// deliberately small — just what the performance panel's "Managed Processes"
/// tab needs to attribute + join the OS process by PID.
#[derive(Debug, Clone)]
pub struct AcpTerminalManagedInfo {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub pid: Option<u32>,
    pub running: bool,
}

/// Terminal process state
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum TerminalState {
    Running,
    Exited(i32),
    Killed,
    Error(String),
}

/// ACP Terminal instance
pub struct AcpTerminal {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub state: TerminalState,
    child: Child,
    // Unix lifecycle uses WNOWAIT: the unreaped leader pins pid/pgid until
    // final teardown. After reaping, this identity is probe-only, never signalled.
    process_group_id: Option<u32>,
    group_confirmed_empty: bool,
    group_proof_supported: bool,
    exit_observed: Option<std::process::ExitStatus>,
    identity_owned: bool,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    output_rx: mpsc::Receiver<TerminalOutput>,
    output_buffer: Vec<TerminalOutput>,
    default_output_byte_limit: Option<usize>,
    last_exit_code: Option<i32>,
    last_exit_signal: Option<String>,
}

impl AcpTerminal {
    fn update_exit_status_from_process_status(&mut self, status: std::process::ExitStatus) {
        self.last_exit_code = status.code();
        #[cfg(unix)]
        {
            self.last_exit_signal = status.signal().map(|s| s.to_string());
        }
        #[cfg(not(unix))]
        {
            self.last_exit_signal = None;
        }
        self.state = TerminalState::Exited(self.last_exit_code.unwrap_or(-1));
    }

    fn current_exit_status(&self) -> TerminalExitStatus {
        TerminalExitStatus {
            exit_code: self.last_exit_code,
            signal: self.last_exit_signal.clone(),
        }
    }

    fn record_kill(&mut self, leader_was_running: bool) {
        if leader_was_running {
            self.state = TerminalState::Killed;
            self.last_exit_code = None;
            self.last_exit_signal = Some("killed".into());
        }
    }

    fn truncate_output_tail(output: &str, max_bytes: usize) -> (String, bool) {
        if output.len() <= max_bytes {
            return (output.to_string(), false);
        }
        if max_bytes == 0 {
            return (String::new(), !output.is_empty());
        }

        let mut start = output.len() - max_bytes;
        while start < output.len() && !output.is_char_boundary(start) {
            start += 1;
        }
        (output[start..].to_string(), true)
    }

    /// Collect output from the terminal
    pub async fn collect_output(&mut self) -> Vec<TerminalOutput> {
        // Drain any pending output from the channel
        while let Ok(output) = self.output_rx.try_recv() {
            self.output_buffer.push(output);
        }
        self.output_buffer.clone()
    }

    /// Get accumulated output as string
    pub async fn get_output_string(&mut self) -> String {
        let outputs = self.collect_output().await;
        outputs
            .iter()
            .map(|o| o.text.as_str())
            .collect::<Vec<_>>()
            .join("")
    }

    /// Get accumulated output with optional byte limit
    pub async fn get_output_with_limit(
        &mut self,
        requested_limit: Option<usize>,
    ) -> (String, bool) {
        let output = self.get_output_string().await;
        let limit = requested_limit.or(self.default_output_byte_limit);
        if let Some(max_bytes) = limit {
            return Self::truncate_output_tail(&output, max_bytes);
        }
        (output, false)
    }

    fn observe_exit(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if let Some(status) = self.exit_observed {
            return Ok(Some(status));
        }
        #[cfg(unix)]
        let observed = if self.identity_owned {
            peek_terminal_exit(self.process_group_id)?
        } else {
            self.child.try_wait()?
        };
        #[cfg(not(unix))]
        let observed = self.child.try_wait()?;
        if let Some(status) = observed {
            self.exit_observed = Some(status);
            if self.state != TerminalState::Killed {
                self.update_exit_status_from_process_status(status);
            }
        }
        Ok(observed)
    }

    /// Lifecycle follows the leader, independently of retained group proof.
    pub async fn is_running(&mut self) -> bool {
        match self.observe_exit() {
            Ok(status) => status.is_none(),
            Err(error) => {
                self.state = TerminalState::Error(error.to_string());
                false
            }
        }
    }

    fn signal_group_with(&mut self, signal: i32, send: impl FnOnce(u32, i32)) {
        if !self.identity_owned || !self.group_is_running() {
            return;
        }
        if let Some(pid) = self.process_group_id {
            send(pid, signal);
        }
    }

    fn signal_group(&mut self, signal: i32) {
        #[cfg(unix)]
        self.signal_group_with(signal, |pid, signal| unsafe {
            libc::kill(-(pid as i32), signal);
        });
        #[cfg(not(unix))]
        {
            let _ = signal;
            if self.identity_owned {
                let _ = self.child.start_kill();
            }
        }
    }

    // Final teardown: signal while the unreaped leader still pins the number,
    // then reap. There are NO subsequent signals; ESRCH is verified separately.
    fn reap_for_teardown(&mut self) {
        if self.observe_exit().ok().flatten().is_some() {
            self.identity_owned = false;
            let _ = self.child.try_wait();
        }
    }

    fn retire_identity(&mut self) {
        #[cfg(unix)]
        self.signal_group(libc::SIGKILL);
        #[cfg(not(unix))]
        if self.identity_owned {
            let _ = self.child.start_kill();
        }
        self.reap_for_teardown();
        self.identity_owned = false;
        self.process_group_id = None;
    }

    fn group_is_running(&mut self) -> bool {
        if !self.group_proof_supported {
            return true;
        }
        if self.group_confirmed_empty {
            return false;
        }
        if group_is_empty(self.process_group_id) {
            self.process_group_id = None;
            self.identity_owned = false;
            self.group_confirmed_empty = true;
            return false;
        }
        true
    }

    /// Get exit code if the process has exited
    pub fn exit_code(&self) -> Option<i32> {
        self.last_exit_code
    }

    /// Get terminal exit status
    pub fn exit_status(&self) -> TerminalExitStatus {
        self.current_exit_status()
    }

    /// Wait for the terminal to exit with optional timeout
    pub async fn wait_for_exit(
        &mut self,
        timeout_secs: Option<u64>,
    ) -> Result<TerminalExitStatus, String> {
        let wait_future = async {
            loop {
                if self.observe_exit().map_err(|e| e.to_string())?.is_some() {
                    return Ok(self.current_exit_status());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };

        if let Some(secs) = timeout_secs {
            timeout(Duration::from_secs(secs), wait_future)
                .await
                .map_err(|_| "Timeout waiting for terminal to exit".to_string())?
        } else {
            wait_future.await
        }
    }
}

struct ReleasedTerminalGroup {
    terminal: Arc<Mutex<AcpTerminal>>,
}

/// ACP Terminal Manager
/// Manages all terminal instances for ACP agents
pub struct AcpTerminalManager {
    terminals: RwLock<HashMap<String, Arc<Mutex<AcpTerminal>>>>,
    next_id: Mutex<u64>,
    group_proof_supported: bool,
    // Lifecycle release drops IO. The retained Unix Child pins pid/pgid via
    // WNOWAIT; final session teardown folds proof and retires these handles.
    released_groups: RwLock<HashMap<String, ReleasedTerminalGroup>>,
    // Immutable ownership is indexed outside IO; release never creates a gap.
    owners: RwLock<HashMap<String, String>>,
    // Owner-level result survives retirement of all process identities.
    session_proofs: RwLock<HashMap<String, bool>>,
    admission: RwLock<()>,
    closed_sessions: RwLock<HashSet<String>>,
    all_closed: std::sync::atomic::AtomicBool,
}

impl Default for AcpTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpTerminalManager {
    pub fn new() -> Self {
        Self::with_group_proof(cfg!(unix))
    }

    fn with_group_proof(group_proof_supported: bool) -> Self {
        Self {
            group_proof_supported,
            released_groups: RwLock::new(HashMap::new()),
            owners: RwLock::new(HashMap::new()),
            session_proofs: RwLock::new(HashMap::new()),
            admission: RwLock::new(()),
            closed_sessions: RwLock::new(HashSet::new()),
            all_closed: std::sync::atomic::AtomicBool::new(false),
            terminals: RwLock::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    /// Create a new terminal
    pub async fn create(
        &self,
        session_id: &str,
        command: &str,
        args: &[String],
        cwd: Option<&str>,
        env: Option<&HashMap<String, String>>,
        output_byte_limit: Option<usize>,
    ) -> Result<String, String> {
        let _admission = self.admission.read().await;
        if self.all_closed.load(std::sync::atomic::Ordering::SeqCst)
            || self.closed_sessions.read().await.contains(session_id)
        {
            return Err("Terminal session admission is closed".into());
        }
        // Generate unique terminal ID
        let mut next_id = self.next_id.lock().await;
        let terminal_id = format!("term_{}", *next_id);
        *next_id += 1;
        drop(next_id);

        // Build command. Resolve the program against PATH (× PATHEXT on
        // Windows) so `.cmd`/`.bat` shims spawn correctly. AcpTerminal owns
        // teardown: Tokio kill_on_drop must not signal after identity retirement.
        let program = super::command_resolver::resolve_command(command);
        let mut cmd = Command::new(&program);
        cmd.args(args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(false);

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        if let Some(env_map) = env {
            for (key, value) in env_map {
                cmd.env(key, value);
            }
        }

        super::process::apply_workspace_command_env(&mut cmd, cwd).await?;

        // Set environment to prevent interactive prompts
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Own process group (Unix) so killing the terminal also kills any
        // children the command forks. No-op on Windows.
        super::proc_group::apply_process_group(&mut cmd);

        // No cancellable await after spawn until both indexes own the child.
        // A cancelled create can only happen before OS admission.
        let mut terminals = self.terminals.write().await;
        let mut owners = self.owners.write().await;
        // Spawn the process
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn terminal: {}", e))?;

        // Take ownership of stdin
        let stdin = child.stdin.take();

        // Create output channel
        let (output_tx, output_rx) = mpsc::channel::<TerminalOutput>(1000);

        // Spawn stdout reader
        if let Some(stdout) = child.stdout.take() {
            let tx = output_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let output = TerminalOutput {
                        text: format!("{}\n", line),
                        is_stderr: false,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    };
                    if tx.send(output).await.is_err() {
                        break;
                    }
                }
            });
        }

        // Spawn stderr reader
        if let Some(stderr) = child.stderr.take() {
            let tx = output_tx;
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let output = TerminalOutput {
                        text: format!("{}\n", line),
                        is_stderr: true,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    };
                    if tx.send(output).await.is_err() {
                        break;
                    }
                }
            });
        }

        // Create terminal instance
        let process_group_id = child.id();
        let terminal = AcpTerminal {
            id: terminal_id.clone(),
            session_id: session_id.to_string(),
            command: command.to_string(),
            state: TerminalState::Running,
            child,
            process_group_id,
            group_confirmed_empty: false,
            group_proof_supported: self.group_proof_supported,
            exit_observed: None,
            identity_owned: true,
            stdin: Arc::new(Mutex::new(stdin)),
            output_rx,
            output_buffer: Vec::new(),
            default_output_byte_limit: output_byte_limit,
            last_exit_code: None,
            last_exit_signal: None,
        };

        owners.insert(terminal_id.clone(), session_id.to_string());
        // Store terminal
        terminals.insert(terminal_id.clone(), Arc::new(Mutex::new(terminal)));

        log::info!(
            "[ACP Terminal] Created terminal {} for session {}",
            terminal_id,
            session_id
        );

        Ok(terminal_id)
    }

    /// Get output from a terminal
    pub async fn get_output(
        &self,
        terminal_id: &str,
        requested_limit: Option<usize>,
    ) -> Result<(String, bool, TerminalExitStatus), String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        terminal.is_running().await;
        let (output, truncated) = terminal.get_output_with_limit(requested_limit).await;
        let exit_status = terminal.exit_status();

        Ok((output, truncated, exit_status))
    }

    async fn process_handle(&self, id: &str) -> Result<Arc<Mutex<AcpTerminal>>, String> {
        if let Some(handle) = self.terminals.read().await.get(id).cloned() {
            return Ok(handle);
        }
        self.released_groups
            .read()
            .await
            .get(id)
            .map(|g| g.terminal.clone())
            .ok_or_else(|| format!("Terminal group proof unavailable: {id}"))
    }

    /// Stdin has its own mutex: teardown never waits behind write_all.
    pub async fn kill(&self, terminal_id: &str) -> Result<(), String> {
        let handle = self.process_handle(terminal_id).await?;
        let leader_was_running = handle.lock().await.is_running().await;
        #[cfg(unix)]
        handle.lock().await.signal_group(libc::SIGTERM);
        #[cfg(not(unix))]
        handle.lock().await.signal_group(9);
        let start = tokio::time::Instant::now();
        let mut final_teardown = false;
        loop {
            {
                let mut terminal = handle.lock().await;
                let running = terminal.is_running().await;
                if !self.group_proof_supported && !running {
                    terminal.record_kill(leader_was_running);
                    return Ok(());
                }
                if !terminal.group_is_running() {
                    terminal.record_kill(leader_was_running);
                    return Ok(());
                }
                if start.elapsed() >= Duration::from_millis(500) {
                    if !final_teardown {
                        #[cfg(unix)]
                        terminal.signal_group(libc::SIGKILL);
                        final_teardown = true;
                    }
                    terminal.reap_for_teardown();
                    if !terminal.group_is_running() {
                        terminal.record_kill(leader_was_running);
                        return Ok(());
                    }
                }
            }
            if start.elapsed() >= Duration::from_millis(1_500) {
                return Err(format!("Terminal {terminal_id} stop unconfirmed"));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Release lifecycle IO. Only a still-unconfirmed Unix owner keeps its Child.
    pub async fn release(&self, terminal_id: &str) -> Result<(), String> {
        let mut terminals = self.terminals.write().await;
        let handle = terminals
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;
        let mut terminal = handle.lock().await;
        // Release IO without waiting for a possibly back-pressured stdin lock.
        // The unreaped Child alone retains proof ownership.
        #[cfg(unix)]
        terminal.signal_group(libc::SIGKILL);
        terminal.stdin = Arc::new(Mutex::new(None));
        terminal.output_rx.close();
        while terminal.output_rx.try_recv().is_ok() {}
        terminal.output_buffer.clear();
        let pending = terminal.group_is_running();
        if self.group_proof_supported && pending {
            self.released_groups.write().await.insert(
                terminal_id.to_string(),
                ReleasedTerminalGroup {
                    terminal: handle.clone(),
                },
            );
        } else {
            if !self.group_proof_supported {
                self.session_proofs
                    .write()
                    .await
                    .insert(terminal.session_id.clone(), false);
                terminal.reap_for_teardown();
            }
            self.owners.write().await.remove(terminal_id);
        }
        terminals.remove(terminal_id);
        Ok(())
    }

    pub async fn is_group_running(&self, terminal_id: &str) -> Result<bool, String> {
        if let Some(session) = terminal_id.strip_prefix("unconfirmed-session:") {
            return Ok(self.session_proofs.read().await.get(session) != Some(&true));
        }
        Ok(self
            .process_handle(terminal_id)
            .await?
            .lock()
            .await
            .group_is_running())
    }

    /// Wait for a terminal to exit
    pub async fn wait_for_exit(
        &self,
        terminal_id: &str,
        timeout_secs: Option<u64>,
    ) -> Result<TerminalExitStatus, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?
            .clone();
        drop(terminals);

        // Poll/reap with short lock acquisitions. An unbounded ACP wait must
        // never hold the terminal mutex and prevent concurrent kill/release.
        let wait = async {
            loop {
                {
                    let mut terminal = terminal.lock().await;
                    if terminal.state == TerminalState::Killed {
                        return Ok(terminal.current_exit_status());
                    }
                    match terminal.observe_exit() {
                        Ok(Some(status)) => {
                            terminal.update_exit_status_from_process_status(status);
                            return Ok(terminal.current_exit_status());
                        }
                        Ok(None) => {}
                        Err(error) => return Err(format!("Failed to wait for terminal: {error}")),
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        match timeout_secs {
            Some(secs) => timeout(Duration::from_secs(secs), wait)
                .await
                .map_err(|_| "Timeout waiting for terminal to exit".to_string())?,
            None => wait.await,
        }
    }

    /// Get all terminals for a session
    pub async fn get_session_terminals(&self, session_id: &str) -> Vec<String> {
        self.owners
            .read()
            .await
            .iter()
            .filter(|(_, owner)| owner.as_str() == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    }

    async fn cleanup_terminals(&self, mut ids: Vec<String>) -> Result<(), String> {
        ids.sort();
        ids.dedup();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.kill(&id).await {
                errors.push(error);
            }
            if self.terminals.read().await.contains_key(&id) {
                if let Err(error) = self.release(&id).await {
                    errors.push(error);
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Attempt every terminal, including released groups, before reporting errors.
    pub async fn kill_session_terminals(&self, session_id: &str) -> Result<(), String> {
        let _closed = self.admission.write().await;
        self.kill_session_terminals_closed(session_id).await
    }

    async fn kill_session_terminals_closed(&self, session_id: &str) -> Result<(), String> {
        if !self
            .closed_sessions
            .write()
            .await
            .insert(session_id.to_string())
        {
            return if self.session_proofs.read().await.get(session_id) == Some(&true) {
                Ok(())
            } else {
                Err("Terminal stop unconfirmed".into())
            };
        }
        self.session_proofs
            .write()
            .await
            .insert(session_id.to_string(), false);
        let ids = self.get_session_terminals(session_id).await;
        let mut handles = Vec::new();
        for id in &ids {
            if let Ok(handle) = self.process_handle(id).await {
                handles.push(handle);
            }
        }
        let result = self.cleanup_terminals(ids.clone()).await;
        let mut confirmed = result.is_ok() && self.group_proof_supported;
        for handle in handles {
            let mut terminal = handle.lock().await;
            if terminal.group_is_running() {
                confirmed = false;
            }
            terminal.retire_identity();
        }
        // Fold proof into the owner before retiring Child/pgid/IO entries.
        self.session_proofs
            .write()
            .await
            .insert(session_id.to_string(), confirmed);
        for id in ids {
            self.owners.write().await.remove(&id);
            self.terminals.write().await.remove(&id);
            self.released_groups.write().await.remove(&id);
        }
        if confirmed {
            Ok(())
        } else {
            Err(format!(
                "Terminal session stop unconfirmed: {}",
                result.err().unwrap_or_default()
            ))
        }
    }

    pub async fn kill_all(&self) -> Result<(), String> {
        let _closed = self.admission.write().await;
        self.all_closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut sessions: Vec<_> = self.owners.read().await.values().cloned().collect();
        sessions.extend(self.session_proofs.read().await.keys().cloned());
        sessions.sort();
        sessions.dedup();
        let mut errors = Vec::new();
        for session in sessions {
            if let Err(e) = self.kill_session_terminals_closed(&session).await {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Write to a terminal's stdin
    pub async fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let handle = self
            .terminals
            .read()
            .await
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;
        let stdin = handle.lock().await.stdin.clone();
        let mut stdin = stdin.lock().await;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "Terminal stdin not available".to_string())?;
        stdin
            .write_all(data.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Check if a terminal is running
    pub async fn is_running(&self, terminal_id: &str) -> Result<bool, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        Ok(terminal.is_running().await)
    }

    /// Get terminal info
    pub async fn get_info(&self, terminal_id: &str) -> Result<serde_json::Value, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        terminal.is_running().await;
        Ok(serde_json::json!({
            "id": terminal.id,
            "sessionId": terminal.session_id,
            "command": terminal.command,
            "state": terminal.state,
            "exitCode": terminal.exit_code(),
            "exitStatus": terminal.exit_status()
        }))
    }

    /// List all terminal IDs
    pub async fn list(&self) -> Vec<String> {
        let terminals = self.terminals.read().await;
        terminals.keys().cloned().collect()
    }

    /// Recovery enumerates proof ownership, including lifecycle-released groups.
    pub async fn list_for_stop_proof(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.owners.read().await.keys().cloned().collect();
        ids.extend(
            self.session_proofs
                .read()
                .await
                .iter()
                .filter(|(_, confirmed)| !**confirmed)
                .map(|(session, _)| format!("unconfirmed-session:{session}")),
        );
        ids
    }

    /// Snapshot every terminal for the unified managed-process registry.
    ///
    /// Lifecycle consumers see only the live leader and its PID.
    pub async fn managed_snapshot(&self) -> Vec<AcpTerminalManagedInfo> {
        let terminals: Vec<_> = self.terminals.read().await.values().cloned().collect();
        let mut snapshot = Vec::new();
        for terminal in terminals {
            let mut terminal = terminal.lock().await;
            let running = terminal.is_running().await;
            snapshot.push(AcpTerminalManagedInfo {
                id: terminal.id.clone(),
                session_id: terminal.session_id.clone(),
                command: terminal.command.clone(),
                pid: if running { terminal.process_group_id } else { None },
                running,
            });
        }
        snapshot
    }
}

impl Drop for AcpTerminal {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.signal_group(libc::SIGKILL);
        #[cfg(not(unix))]
        if self.identity_owned {
            let _ = self.child.start_kill();
        }
    }
}

// A group escape (setsid/double fork) remains an ADR-0244 residual: only
// a sandbox can close it. Windows has no Job Object and cannot prove emptiness.
#[cfg(unix)]
fn peek_terminal_exit(pid: Option<u32>) -> std::io::Result<Option<std::process::ExitStatus>> {
    let Some(pid) = pid else { return Ok(None); };
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT | libc::WNOHANG) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { info.si_pid() } == 0 { return Ok(None); }
    let status = unsafe { info.si_status() };
    Ok(Some(std::process::ExitStatus::from_raw(if info.si_code == libc::CLD_EXITED { status << 8 } else { status })))
}

fn group_is_empty(pid: Option<u32>) -> bool {
    #[cfg(unix)]
    if let Some(pid) = pid {
        return unsafe { libc::kill(-(pid as i32), 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    }
    #[cfg(not(unix))]
    let _ = pid;
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_backpressured_stdin_does_not_block_other_session_or_retirement() {
        let manager = Arc::new(AcpTerminalManager::new());
        let blocked = manager
            .create("blocked", "/bin/sleep", &["60".into()], None, None, None)
            .await
            .unwrap();
        let other = manager
            .create("other", "/bin/cat", &[], None, None, None)
            .await
            .unwrap();
        let writer = {
            let manager = manager.clone();
            let blocked = blocked.clone();
            tokio::spawn(async move { manager.write(&blocked, &"x".repeat(8 * 1024 * 1024)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!writer.is_finished());
        let stopped = timeout(
            Duration::from_secs(3),
            manager.kill_session_terminals("other"),
        )
        .await;
        writer.abort();
        let _ = manager.kill_session_terminals("blocked").await;
        stopped.unwrap().unwrap();
        assert!(!manager.owners.read().await.contains_key(&other));
        assert!(manager.released_groups.read().await.is_empty());
        assert!(manager.terminals.read().await.is_empty());
        assert!(manager
            .create("other", "/bin/cat", &[], None, None, None)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_reaped_identity_cannot_be_signalled_again() {
        let manager = AcpTerminalManager::new();
        let id = manager
            .create("s", "/bin/cat", &[], None, None, None)
            .await
            .unwrap();
        let handle = manager.process_handle(&id).await.unwrap();
        manager.kill(&id).await.unwrap();
        let mut terminal = handle.lock().await;
        assert!(!terminal.identity_owned);
        terminal.signal_group_with(libc::SIGKILL, |_, _| panic!("retired pgid signalled"));
        drop(terminal);
        manager.kill_session_terminals("s").await.unwrap();
        assert!(manager.owners.read().await.is_empty());
        assert!(manager.released_groups.read().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_terminal_windows_strategy_settles_lifecycle_without_proof() {
        let manager = AcpTerminalManager::with_group_proof(false);
        for _ in 0..4 {
            let id = manager
                .create(
                    "windows",
                    "/bin/sh",
                    &["-c".into(), "exit 0".into()],
                    None,
                    None,
                    None,
                )
                .await
                .unwrap();
            manager.wait_for_exit(&id, Some(2)).await.unwrap();
            assert!(!manager.is_running(&id).await.unwrap());
            assert!(manager.is_group_running(&id).await.unwrap());
            let snapshot = manager.managed_snapshot().await;
            assert!(!snapshot[0].running);
            assert_eq!(snapshot[0].pid, None);
            manager.kill(&id).await.unwrap();
            manager.release(&id).await.unwrap();
        }
        assert!(manager.list().await.is_empty());
        assert!(manager.released_groups.read().await.is_empty());
        assert_eq!(
            manager
                .session_proofs
                .read()
                .await
                .values()
                .filter(|confirmed| !**confirmed)
                .count(),
            1
        );
        let proof_ids = manager.list_for_stop_proof().await;
        assert_eq!(proof_ids, vec!["unconfirmed-session:windows"]);
        assert!(manager.is_group_running(&proof_ids[0]).await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_terminal_kill_all_attempts_remaining_terminals_after_failure() {
        let manager = AcpTerminalManager::new();
        let first = manager
            .create("s", "/bin/cat", &[], None, None, None)
            .await
            .unwrap();
        let second = manager
            .create("s", "/bin/cat", &[], None, None, None)
            .await
            .unwrap();
        let first_handle = manager.terminals.read().await[&first].clone();
        let second_handle = manager.terminals.read().await[&second].clone();
        let first_pid = first_handle.lock().await.process_group_id;
        first_handle.lock().await.process_group_id = None;
        assert!(manager.kill_all().await.unwrap_err().contains(&first));
        assert!(!first_handle.lock().await.identity_owned);
        first_handle
            .lock()
            .await
            .signal_group_with(libc::SIGKILL, |_, _| panic!("retired identity signalled"));
        assert!(!second_handle.lock().await.is_running().await);
        assert!(manager.list().await.is_empty());
        assert!(
            manager.kill_all().await.is_err(),
            "owner-level uncertainty survives process retirement"
        );
        assert!(manager
            .create("new", "/bin/cat", &[], None, None, None)
            .await
            .is_err());
        // Restore the deliberately hidden identity and reap the failing fixture.
        first_handle.lock().await.process_group_id = first_pid;
        super::super::proc_group::kill_process_group(first_pid);
        first_handle.lock().await.child.wait().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_cancelled_registration_never_admits_an_unowned_child() {
        let manager = Arc::new(AcpTerminalManager::new());
        let owners = manager.owners.write().await;
        let creating = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .create("cancelled", "/bin/cat", &[], None, None, None)
                    .await
            })
        };
        tokio::task::yield_now().await;
        creating.abort();
        let _ = creating.await;
        drop(owners);
        assert!(manager.terminals.read().await.is_empty());
        manager.kill_session_terminals("cancelled").await.unwrap();
        assert!(manager.owners.read().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_kill_polling_never_blocks_managed_snapshot() {
        let manager = Arc::new(AcpTerminalManager::new());
        let id = manager
            .create(
                "s",
                "/bin/sh",
                &[
                    "-c".into(),
                    // Use only shell builtins: this test isolates lock contention,
                    // independently of orphan-descendant reaping after group kill.
                    "trap '' TERM; echo ready; while :; do :; done".into(),
                ],
                None,
                None,
                None,
            )
            .await
            .unwrap();
        while !manager
            .get_output(&id, None)
            .await
            .unwrap()
            .0
            .contains("ready")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let killer = Arc::clone(&manager);
        let kill_id = id.clone();
        let kill = tokio::spawn(async move { killer.kill(&kill_id).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        timeout(Duration::from_millis(100), manager.managed_snapshot())
            .await
            .unwrap();
        kill.await.unwrap().unwrap();
        manager.release(&id).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_terminal_group_proof_outlives_leader_and_lifecycle_release() {
        let manager = AcpTerminalManager::new();
        let id = manager
            .create(
                "session",
                "/bin/sh",
                &["-c".into(), "sleep 60 & exit 0".into()],
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            manager.wait_for_exit(&id, Some(2)).await.unwrap().exit_code,
            Some(0)
        );
        assert!(!manager.is_running(&id).await.unwrap());
        let snapshot = manager.managed_snapshot().await;
        assert!(!snapshot[0].running);
        assert_eq!(snapshot[0].pid, None);
        assert!(manager.is_group_running(&id).await.unwrap());
        manager.release(&id).await.unwrap();
        assert!(manager.is_group_running(&id).await.unwrap());
        assert!(manager.list_for_stop_proof().await.contains(&id));
        manager.kill(&id).await.unwrap();
        assert!(!manager.is_group_running(&id).await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_terminal_pending_wait_never_blocks_kill_or_session_cleanup() {
        let manager = Arc::new(AcpTerminalManager::new());
        let id = manager
            .create(
                "session",
                "/bin/sh",
                &["-c".into(), "sleep 60".into()],
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let waiter = {
            let manager = Arc::clone(&manager);
            let id = id.clone();
            tokio::spawn(async move { manager.wait_for_exit(&id, None).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        timeout(Duration::from_secs(2), async {
            manager.kill_session_terminals("session").await.unwrap();
            waiter.await.unwrap().unwrap();
        })
        .await
        .expect("pending wait blocked cleanup");
        assert!(manager.list().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn acp_terminal_workspace_env_is_last_and_errors_refuse_spawn() {
        for kind in ["some", "none", "error"] {
            let cwd = crate::workspace_env_fixture(kind);
            let manager = AcpTerminalManager::new();
            let env = HashMap::from([("PORT".into(), "user-port".into())]);
            let result = manager
                .create(
                    "session",
                    "/usr/bin/env",
                    &[],
                    cwd.path().to_str(),
                    Some(&env),
                    None,
                )
                .await;
            if kind == "error" {
                assert!(result.unwrap_err().contains("fixture port range exhausted"));
                assert!(manager.list().await.is_empty());
                continue;
            }
            let id = result.unwrap();
            manager.wait_for_exit(&id, Some(5)).await.unwrap();
            let mut output = manager.get_output(&id, None).await.unwrap();
            for _ in 0..200 {
                let expected = if kind == "some" {
                    "PORT=41000"
                } else {
                    "PORT=user-port"
                };
                if output.0.lines().any(|line| line == expected) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
                output = manager.get_output(&id, None).await.unwrap();
            }
            if kind == "some" {
                assert!(
                    output.0.contains("COGNIA_PORT=41000"),
                    "missing trusted COGNIA_PORT"
                );
                assert!(output.0.contains("COGNIA_PORT_COUNT=10"));
                assert!(output.0.lines().any(|line| line == "PORT=41000"));
                assert!(!output.0.contains("PORT=user-port"));
            } else {
                assert!(output.0.contains("PORT=user-port"));
                assert!(!output.0.contains("COGNIA_PORT="));
            }
            manager.release(&id).await.unwrap();
        }
    }

    // ---- truncate_output_tail: byte-limit / char-boundary handling --------

    #[test]
    fn truncate_keeps_short_output_untouched() {
        let (out, truncated) = AcpTerminal::truncate_output_tail("hello", 10);
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn truncate_zero_limit_drops_everything_but_flags_truncated() {
        let (out, truncated) = AcpTerminal::truncate_output_tail("hello", 0);
        assert_eq!(out, "");
        assert!(truncated);
        // Empty input at a zero limit is not "truncated" — nothing was dropped.
        let (out2, truncated2) = AcpTerminal::truncate_output_tail("", 0);
        assert_eq!(out2, "");
        assert!(!truncated2);
    }

    #[test]
    fn truncate_returns_the_tail_when_over_limit() {
        let (out, truncated) = AcpTerminal::truncate_output_tail("abcdefghij", 3);
        assert_eq!(out, "hij");
        assert!(truncated);
    }

    #[test]
    fn truncate_respects_utf8_char_boundaries() {
        // "é" is two bytes; a naive byte slice mid-character would panic. The
        // tail is advanced to the next boundary, yielding valid UTF-8.
        let input = "aéb"; // bytes: 'a'(1) 'é'(2) 'b'(1) = 4 bytes
        let (out, truncated) = AcpTerminal::truncate_output_tail(input, 2);
        assert!(truncated);
        assert!(input.ends_with(&out));
        // Result is always valid UTF-8 (String guarantees it; assert no panic).
        assert!(out.len() <= 2);
    }

    // ---- manager error paths: every op rejects an unknown terminal id -----

    #[tokio::test]
    async fn unknown_terminal_ops_return_not_found() {
        let mgr = AcpTerminalManager::new();
        assert!(mgr.get_output("ghost", None).await.is_err());
        assert!(mgr.kill("ghost").await.is_err());
        assert!(mgr.release("ghost").await.is_err());
        assert!(mgr.write("ghost", "x").await.is_err());
        assert!(mgr.is_running("ghost").await.is_err());
        assert!(mgr.wait_for_exit("ghost", Some(1)).await.is_err());
        assert!(mgr.get_info("ghost").await.is_err());
        assert!(mgr.list().await.is_empty());
    }

    // ---- real process lifecycle (unix-only: relies on `echo` / `cat`) -----

    #[cfg(unix)]
    #[tokio::test]
    async fn echo_runs_to_completion_and_reports_exit_zero() {
        let mgr = AcpTerminalManager::new();
        let id = mgr
            .create("sess", "echo", &["hello".to_string()], None, None, None)
            .await
            .expect("spawn echo");

        assert!(mgr.list().await.contains(&id));
        assert!(mgr.get_info(&id).await.is_ok());

        let status = mgr.wait_for_exit(&id, Some(5)).await.expect("wait echo");
        assert_eq!(status.exit_code, Some(0));

        // Release removes it from the manager; subsequent ops are not-found.
        mgr.release(&id).await.expect("release");
        assert!(!mgr.list().await.contains(&id));
        assert!(mgr.get_output(&id, None).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_write_then_kill_transitions_state_to_killed() {
        let mgr = AcpTerminalManager::new();
        // `cat` echoes stdin and stays alive until its stdin closes — a stable
        // target for exercising write() + kill() without a race to exit.
        let id = mgr
            .create("sess", "cat", &[], None, None, None)
            .await
            .expect("spawn cat");

        mgr.write(&id, "data\n").await.expect("write to stdin");
        mgr.kill(&id).await.expect("kill");

        let info = mgr.get_info(&id).await.expect("info after kill");
        assert_eq!(info["state"], serde_json::json!("Killed"));
        assert_eq!(info["exitStatus"]["signal"], serde_json::json!("killed"));

        mgr.release(&id).await.expect("release");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_all_clears_every_terminal() {
        let mgr = AcpTerminalManager::new();
        let a = mgr
            .create("sess-a", "cat", &[], None, None, None)
            .await
            .expect("spawn cat a");
        let b = mgr
            .create("sess-b", "cat", &[], None, None, None)
            .await
            .expect("spawn cat b");
        assert_eq!(mgr.list().await.len(), 2);

        mgr.kill_all().await.expect("kill_all");

        assert!(mgr.list().await.is_empty());
        assert!(mgr.get_info(&a).await.is_err());
        assert!(mgr.get_info(&b).await.is_err());
        // Idempotent on an already-empty manager.
        mgr.kill_all().await.expect("kill_all empty");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_snapshot_reports_live_terminal_with_pid() {
        let mgr = AcpTerminalManager::new();
        // Empty on a fresh manager.
        assert!(mgr.managed_snapshot().await.is_empty());

        let id = mgr
            .create("sess", "cat", &[], None, None, None)
            .await
            .expect("spawn cat");

        let snap = mgr.managed_snapshot().await;
        let row = snap
            .iter()
            .find(|r| r.id == id)
            .expect("terminal in snapshot");
        assert_eq!(row.command, "cat");
        assert_eq!(row.session_id, "sess");
        assert!(row.running);
        assert!(row.pid.is_some(), "live terminal should report an OS pid");

        mgr.kill_all().await.expect("cleanup");
        assert!(mgr.managed_snapshot().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_byte_limit_truncates_collected_output() {
        let mgr = AcpTerminalManager::new();
        let id = mgr
            .create(
                "sess",
                "echo",
                &["abcdefghij".to_string()],
                None,
                None,
                Some(3),
            )
            .await
            .expect("spawn echo");
        mgr.wait_for_exit(&id, Some(5)).await.expect("wait echo");
        // Give the stdout reader task a tick to drain the line into the channel.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (output, truncated, _status) = mgr.get_output(&id, None).await.expect("output");
        // echo appends a newline → "abcdefghij\n" (11 bytes), tail-limited to 3.
        assert!(truncated);
        assert_eq!(output.len(), 3);
        mgr.release(&id).await.expect("release");
    }
}
