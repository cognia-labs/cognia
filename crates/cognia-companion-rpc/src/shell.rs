// `!cmd` mode in the chat composer routes through this command. We intentionally
// invoke the platform's default shell so users can write the same one-liners
// they would in their terminal (`ls -la`, `dir`, pipes, &&, ...). Output is
// captured and returned to the renderer as a single blob — no streaming.
//
// Safety: this is a desktop app for a developer audience, not a sandboxed
// surface. We still bound runtime via `wait-timeout` so a hung command can't
// pin a Tauri worker thread, and we cap captured output so a chatty command
// can't blow up the IPC channel.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 5 * 60;
/// Polling granularity while waiting on a running shell so cancellation
/// interrupts promptly without busy-spinning.
const WAIT_POLL_SLICE: Duration = Duration::from_millis(50);
/// Hard budget for process-tree teardown plus output pipe EOF after exit,
/// timeout, or cancellation (F8).
const CLEANUP_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed by the timeout or cancellation.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    #[serde(default)]
    pub cancelled: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Default)]
struct PipeCaptureState {
    raw: Vec<u8>,
    truncated: bool,
    eof: bool,
}

/// Concurrent pipe drainer whose collection is bounded by a deadline.
///
/// Even if an escaped or detached descendant keeps the write end of stdout or
/// stderr open after the process tree is terminated, [`collect_bounded`]
/// returns within the cleanup budget with whatever bytes arrived so far rather
/// than pinning a worker thread forever on `JoinHandle::join`.
#[derive(Clone)]
struct BoundedPipeCapture {
    inner: Arc<(Mutex<PipeCaptureState>, Condvar)>,
}

impl BoundedPipeCapture {
    fn spawn<R: Read + Send + 'static>(mut src: R) -> Self {
        let inner = Arc::new((Mutex::new(PipeCaptureState::default()), Condvar::new()));
        let worker = Arc::clone(&inner);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match src.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let exceeded = {
                            let mut state = worker.0.lock().unwrap_or_else(|e| e.into_inner());
                            if state.raw.len() + n > MAX_OUTPUT_BYTES {
                                let take = MAX_OUTPUT_BYTES.saturating_sub(state.raw.len());
                                state.raw.extend_from_slice(&buf[..take]);
                                state.truncated = true;
                                true
                            } else {
                                state.raw.extend_from_slice(&buf[..n]);
                                false
                            }
                        };
                        if exceeded {
                            // Drain the remainder so the child is not stalled on a full pipe.
                            let _ = std::io::copy(&mut src, &mut std::io::sink());
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let mut state = worker.0.lock().unwrap_or_else(|e| e.into_inner());
            state.eof = true;
            worker.1.notify_all();
        });
        Self { inner }
    }

    fn collect_bounded(&self, deadline: Instant) -> (String, bool) {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        while !state.eof {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let (next, wait_res) = cvar
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
            if wait_res.timed_out() {
                break;
            }
        }
        let stream_unclosed = !state.eof;
        let truncated = state.truncated || stream_unclosed;
        let mut output = String::from_utf8_lossy(&state.raw).into_owned();
        if stream_unclosed {
            output.push_str("\n... (truncated: output stream still open after cleanup budget)");
        } else if state.truncated {
            output.push_str("\n... (truncated)");
        }
        (output, truncated)
    }
}

/// Spawn `cmd` via the platform shell inside `cwd` and capture stdout+stderr
/// up to the configured cap. Times out after `timeout_secs` (default 30, hard
/// max 5 minutes) — the child tree is killed and `timed_out` is set.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn shell_exec(
    cmd: String,
    cwd: String,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    shell_exec_with_env(cmd, cwd, timeout_secs, BTreeMap::new())
}

pub(crate) fn shell_exec_with_env(
    cmd: String,
    cwd: String,
    timeout_secs: Option<u64>,
    environment: BTreeMap<String, String>,
) -> Result<ShellResult, String> {
    shell_exec_with_env_timeout_cap(cmd, cwd, timeout_secs, environment, MAX_TIMEOUT_SECS, true)
}

pub(crate) fn shell_exec_with_env_timeout_cap(
    cmd: String,
    cwd: String,
    timeout_secs: Option<u64>,
    environment: BTreeMap<String, String>,
    max_timeout_secs: u64,
    inherit_environment: bool,
) -> Result<ShellResult, String> {
    shell_exec_with_cancel(
        cmd,
        cwd,
        timeout_secs,
        environment,
        max_timeout_secs,
        inherit_environment,
        None,
    )
}

pub(crate) fn shell_exec_with_cancel(
    cmd: String,
    cwd: String,
    timeout_secs: Option<u64>,
    environment: BTreeMap<String, String>,
    max_timeout_secs: u64,
    inherit_environment: bool,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<ShellResult, String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let cwd_path = std::path::PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {}", cwd));
    }
    if cancel
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Acquire))
    {
        return Ok(ShellResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: false,
            cancelled: true,
            stdout_truncated: false,
            stderr_truncated: false,
        });
    }
    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, max_timeout_secs);
    let deadline = Instant::now() + Duration::from_secs(timeout);

    #[cfg(windows)]
    {
        run_shell_windows(
            trimmed,
            &cwd_path,
            &environment,
            inherit_environment,
            deadline,
            cancel.as_deref(),
        )
    }

    #[cfg(not(windows))]
    {
        run_shell_unix(
            trimmed,
            &cwd_path,
            environment,
            inherit_environment,
            deadline,
            cancel.as_deref(),
        )
    }
}

#[cfg(windows)]
fn run_shell_windows(
    trimmed: &str,
    cwd_path: &std::path::Path,
    environment: &BTreeMap<String, String>,
    inherit_environment: bool,
    deadline: Instant,
    cancel: Option<&AtomicBool>,
) -> Result<ShellResult, String> {
    let mut child = cognia_exec_sandbox::proc_group::windows_job::WindowsJobChild::spawn_shell(
        trimmed,
        cwd_path,
        environment,
        inherit_environment,
    )?;
    let stdout_capture = child.stdout.take().map(BoundedPipeCapture::spawn);
    let stderr_capture = child.stderr.take().map(BoundedPipeCapture::spawn);

    let mut exit_code: Option<i32> = None;
    let mut timed_out = false;
    let mut cancelled = false;

    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            cancelled = true;
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        let slice = remaining.min(WAIT_POLL_SLICE);
        match child.wait_slice(slice) {
            Ok(Some(code)) => {
                exit_code = Some(code);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let cleanup_deadline = Instant::now() + CLEANUP_BUDGET;
                let _ = child.terminate_tree_and_wait(
                    cleanup_deadline.saturating_duration_since(Instant::now()),
                );
                if let Some(capture) = &stdout_capture {
                    let _ = capture.collect_bounded(cleanup_deadline);
                }
                if let Some(capture) = &stderr_capture {
                    let _ = capture.collect_bounded(cleanup_deadline);
                }
                return Err(format!("wait shell: {error}"));
            }
        }
    }

    // Reap the entire Job Object on normal completion, timeout, and
    // cancellation alike so grandchildren cannot linger or hold inherited
    // pipes open past CLEANUP_BUDGET.
    let cleanup_deadline = Instant::now() + CLEANUP_BUDGET;
    let _ =
        child.terminate_tree_and_wait(cleanup_deadline.saturating_duration_since(Instant::now()));

    let (stdout_buf, stdout_truncated) = stdout_capture
        .map(|capture| capture.collect_bounded(cleanup_deadline))
        .unwrap_or_default();
    let (stderr_buf, stderr_truncated) = stderr_capture
        .map(|capture| capture.collect_bounded(cleanup_deadline))
        .unwrap_or_default();

    Ok(ShellResult {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: if timed_out || cancelled {
            None
        } else {
            exit_code
        },
        timed_out,
        cancelled,
        stdout_truncated,
        stderr_truncated,
    })
}

#[cfg(not(windows))]
fn run_shell_unix(
    trimmed: &str,
    cwd_path: &std::path::Path,
    environment: BTreeMap<String, String>,
    inherit_environment: bool,
    deadline: Instant,
    cancel: Option<&AtomicBool>,
) -> Result<ShellResult, String> {
    use std::process::{Command, Stdio};
    use wait_timeout::ChildExt;

    let mut command = Command::new("sh");
    command.arg("-c").arg(trimmed);
    if !inherit_environment {
        command.env_clear();
    }
    command
        .current_dir(cwd_path)
        .envs(environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("spawn shell: {}", e))?;

    // Drain both streams while the child runs: waiting before reading can
    // deadlock an initialization command that fills either OS pipe.
    let stdout_capture = child.stdout.take().map(BoundedPipeCapture::spawn);
    let stderr_capture = child.stderr.take().map(BoundedPipeCapture::spawn);

    let mut exit_code: Option<i32> = None;
    let mut timed_out = false;
    let mut cancelled = false;

    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            cancelled = true;
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        let slice = remaining.min(WAIT_POLL_SLICE);
        match child.wait_timeout(slice) {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let cleanup_deadline = Instant::now() + CLEANUP_BUDGET;
                reap_unix_child(&mut child, cleanup_deadline);
                if let Some(capture) = &stdout_capture {
                    let _ = capture.collect_bounded(cleanup_deadline);
                }
                if let Some(capture) = &stderr_capture {
                    let _ = capture.collect_bounded(cleanup_deadline);
                }
                return Err(format!("wait shell: {error}"));
            }
        }
    }

    // Reap background children after normal completion, timeout, or cancel so
    // inherited pipe handles cannot keep the reader threads alive indefinitely.
    let cleanup_deadline = Instant::now() + CLEANUP_BUDGET;
    reap_unix_child(&mut child, cleanup_deadline);

    let (stdout_buf, stdout_truncated) = stdout_capture
        .map(|capture| capture.collect_bounded(cleanup_deadline))
        .unwrap_or_default();
    let (stderr_buf, stderr_truncated) = stderr_capture
        .map(|capture| capture.collect_bounded(cleanup_deadline))
        .unwrap_or_default();

    Ok(ShellResult {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: if timed_out || cancelled {
            None
        } else {
            exit_code
        },
        timed_out,
        cancelled,
        stdout_truncated,
        stderr_truncated,
    })
}

#[cfg(not(windows))]
fn reap_unix_child(child: &mut std::process::Child, cleanup_deadline: Instant) {
    let pid = child.id();
    let _ = child.kill();
    #[cfg(unix)]
    {
        let remaining = cleanup_deadline.saturating_duration_since(Instant::now());
        let _ = cognia_exec_sandbox::proc_group::kill_process_group_and_wait_blocking(
            Some(pid),
            remaining,
        );
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, cleanup_deadline);
        cognia_exec_sandbox::proc_group::kill_process_group(Some(child.id()));
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cwd() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cognia-shell-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[cfg(unix)]
    #[test]
    fn isolated_shell_keeps_explicit_variables_and_clears_the_ambient_environment() {
        let cwd = tempfile::tempdir().unwrap();
        let result = shell_exec_with_env_timeout_cap(
            r#"printf '%s:%s' "${HOME-unset}" "$COGNIA_SHELL_FIXTURE""#.into(),
            cwd.path().to_string_lossy().into(),
            Some(5),
            BTreeMap::from([("COGNIA_SHELL_FIXTURE".into(), "explicit".into())]),
            MAX_TIMEOUT_SECS,
            false,
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "unset:explicit");
    }

    #[test]
    fn echoes_text() {
        let cwd = temp_cwd();
        let res = shell_exec(
            if cfg!(target_os = "windows") {
                "echo hi".into()
            } else {
                "printf hi".into()
            },
            cwd.to_string_lossy().to_string(),
            Some(5),
        )
        .unwrap();
        assert!(res.stdout.contains("hi"), "stdout: {:?}", res.stdout);
        assert!(!res.timed_out);
        assert!(!res.cancelled);
        assert_eq!(res.exit_code, Some(0));
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    #[cfg(unix)]
    fn drains_large_output_without_waiting_for_timeout() {
        let cwd = temp_cwd();
        let result = shell_exec(
            "yes x | head -c 200000; yes y | head -c 200000 >&2".into(),
            cwd.to_string_lossy().into(),
            Some(5),
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(!result.cancelled);
        assert!(result.stdout_truncated && result.stderr_truncated);
    }

    #[test]
    #[cfg(unix)]
    fn timeout_closes_descendant_pipes() {
        let started = Instant::now();
        let result = shell_exec(
            "sleep 30 & wait".into(),
            std::env::temp_dir().to_string_lossy().into(),
            Some(1),
        )
        .unwrap();
        assert!(result.timed_out);
        assert!(!result.cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[cfg(unix)]
    fn cancellation_terminates_process_tree_promptly() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            trigger.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let result = shell_exec_with_cancel(
            "echo started; sleep 30 & wait".into(),
            std::env::temp_dir().to_string_lossy().into(),
            Some(30),
            BTreeMap::new(),
            MAX_TIMEOUT_SECS,
            true,
            Some(cancel),
        )
        .unwrap();
        assert!(result.cancelled);
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, None);
        assert!(result.stdout.contains("started"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn bounded_pipe_capture_returns_partial_output_when_writer_never_closes() {
        struct HangingReader {
            first: bool,
        }
        impl Read for HangingReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.first {
                    self.first = false;
                    let chunk = b"partial output";
                    buf[..chunk.len()].copy_from_slice(chunk);
                    return Ok(chunk.len());
                }
                std::thread::sleep(Duration::from_secs(5));
                Ok(0)
            }
        }

        let capture = BoundedPipeCapture::spawn(HangingReader { first: true });
        std::thread::sleep(Duration::from_millis(20));
        let started = Instant::now();
        let (text, truncated) = capture.collect_bounded(Instant::now() + Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(truncated);
        assert!(text.contains("partial output"));
        assert!(text.contains("still open after cleanup budget"));
    }

    #[test]
    fn rejects_empty() {
        let res = shell_exec(
            "   ".into(),
            std::env::temp_dir().to_string_lossy().into(),
            Some(1),
        );
        assert!(res.is_err());
    }

    #[test]
    fn rejects_bad_cwd() {
        let res = shell_exec(
            "echo hi".into(),
            "/definitely/not/a/real/path-xyz".into(),
            Some(1),
        );
        assert!(res.is_err());
    }
}
