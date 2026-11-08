//! Run one `git` command under a wall-clock budget, and actually stop it.
//!
//! # Why this is not `tokio::time::timeout`
//!
//! `crates/cognia-git/src/repo.rs` enforced the guarded-clone budget by wrapping
//! `exec::run` in `tokio::time::timeout`. `exec::run` awaits
//! `tokio::process::Command::output()`, and `tokio::process::Command` defaults
//! to `kill_on_drop(false)`. Dropping that future on timeout therefore does not
//! kill git. It leaves a `git clone` running, still writing into the directory
//! the timeout branch then deletes. The clone "timed out", the process did not.
//!
//! Polling `try_wait` and calling `kill` is the version that is true. It is
//! also why this module is sync: the budget is the only reason the old code
//! needed an async timer at all, and the callers already have a
//! `spawn_blocking` boundary.
//!
//! # Pipes are drained while git runs
//!
//! A child writes stderr (and stdout, when it is kept) into a pipe of a few
//! tens of kilobytes. Reading only after the child exits means a chatty git
//! fills the pipe, blocks on the write, and is then killed for a "timeout" it
//! never had. Both pipes are drained on their own threads from the start.
//!
//! # A kill takes the whole process group
//!
//! `git clone` runs `git-remote-https`, `ssh`, `index-pack`. Killing git alone
//! leaves those running and writing. On Unix the child leads its own process
//! group and the group is killed; elsewhere the child is.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::acquire::CancelToken;
use crate::credential::{self, GitCredential};

/// Most stderr kept for an error message. The rest is read and discarded, so
/// the pipe still never fills.
const STDERR_CAP: usize = 64 * 1024;

/// How often the budget is checked. Short enough that a killed clone stops
/// promptly, long enough that a multi-minute clone is not a spin loop.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// `git` could not be launched at all.
    Spawn(String),
    /// `git` ran and failed. The text is already redacted.
    Failed(String),
    /// The budget elapsed. The child was killed and reaped before this
    /// returned, so a caller is free to delete the directory it was writing to.
    TimedOut(Duration),
    /// The run was cancelled. Killed and reaped like a timeout.
    Cancelled,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(detail) => write!(f, "git spawn: {detail}"),
            Self::Failed(detail) => write!(f, "git failed: {detail}"),
            Self::TimedOut(budget) => {
                write!(f, "git timed out after {}s", budget.as_secs())
            }
            Self::Cancelled => write!(f, "git was cancelled"),
        }
    }
}

impl std::error::Error for RunError {}

/// What a command may carry. Separate from the credential so a caller cannot
/// forget the isolation env by passing `None` for the credential.
pub struct GitRun<'a> {
    pub cwd: &'a Path,
    pub args: &'a [String],
    /// `(origin, credential)`. The origin is the `https://<host>/` prefix the
    /// `extraheader` is keyed on. See [`credential::auth_env`].
    pub credential: Option<(&'a str, &'a GitCredential)>,
    /// `None` means no wall-clock limit.
    pub budget: Option<Duration>,
    /// Keep stdout. Off by default because most callers only need the status,
    /// and a clone's stdout is noise.
    pub capture_stdout: bool,
    /// Extra environment, set after the isolation (or credential) env. For a
    /// variable git reads that has no `-c` form, such as `GIT_INDEX_FILE`.
    pub env: Vec<(String, String)>,
    /// Polled while git runs; when set, git is killed and reaped.
    pub cancel: Option<CancelToken>,
    /// Run with the user's own git configuration instead of the isolation env.
    ///
    /// For commands against the user's checkout (`fetch origin` in their
    /// repository, `worktree add` from it), which must keep their credential
    /// helpers, SSH keys and `insteadOf` rules. Never combined with a
    /// credential: that path is for host-owned remotes.
    pub user_config: bool,
}

impl<'a> GitRun<'a> {
    pub fn new(cwd: &'a Path, args: &'a [String]) -> Self {
        Self {
            cwd,
            args,
            credential: None,
            budget: None,
            capture_stdout: false,
            env: Vec::new(),
            cancel: None,
            user_config: false,
        }
    }

    pub fn credential(mut self, origin: &'a str, credential: &'a GitCredential) -> Self {
        self.credential = Some((origin, credential));
        self
    }

    pub fn maybe_credential(mut self, credential: Option<(&'a str, &'a GitCredential)>) -> Self {
        self.credential = credential;
        self
    }

    pub fn budget(mut self, budget: Duration) -> Self {
        self.budget = Some(budget);
        self
    }

    /// Take the caller's budget, whatever it is. The mirror inherits the
    /// budget of the clone it is serving rather than inventing one of its own:
    /// a cache that can outlive the request it exists to make faster is not a
    /// cache, it is a hang.
    pub fn maybe_budget(mut self, budget: Option<Duration>) -> Self {
        self.budget = budget;
        self
    }

    pub fn capture_stdout(mut self) -> Self {
        self.capture_stdout = true;
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// See [`GitRun::user_config`]. Drops any credential.
    pub fn user_config(mut self) -> Self {
        self.user_config = true;
        self.credential = None;
        self
    }
}

/// Run it. Blocking.
pub fn run_git(run: GitRun<'_>) -> Result<String, RunError> {
    if run.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
        return Err(RunError::Cancelled);
    }
    let mut command = Command::new("git");
    command.current_dir(run.cwd).args(run.args);
    command.stdin(Stdio::null());
    command.stdout(if run.capture_stdout {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stderr(Stdio::piped());

    let env = if run.user_config {
        // The user's configuration stays, but nothing may stop to ask.
        vec![("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())]
    } else {
        match run.credential {
            Some((origin, credential)) => credential::auth_env(origin, credential),
            None => credential::isolation_env(),
        }
    };
    // Deterministic English stderr, so a failure can be classified.
    let locale = [
        ("LC_ALL".to_string(), "C".to_string()),
        ("LANG".to_string(), "C".to_string()),
    ];
    for (key, value) in env.into_iter().chain(locale).chain(run.env.iter().cloned()) {
        command.env(key, value);
    }
    // Stderr ends up in errors and in acquisition records, and git's curl
    // traces print the `Authorization:` header. A user-config run keeps the
    // parent's environment, so turn them off and keep redaction on whatever
    // the parent set.
    command.env_remove("GIT_CURL_VERBOSE");
    command.env_remove("GIT_TRACE_CURL");
    command.env("GIT_TRACE_REDACT", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }

    let cred = run.credential.map(|(_, credential)| credential);

    if run.budget.is_none() && run.cancel.is_none() {
        let output = command
            .output()
            .map_err(|e| RunError::Spawn(credential::redact(&e.to_string(), cred)))?;
        return finish(output.status, &output.stdout, &output.stderr, cred);
    }

    let mut child = command
        .spawn()
        .map_err(|e| RunError::Spawn(credential::redact(&e.to_string(), cred)))?;
    let stdout = child.stdout.take().map(|pipe| drain(pipe, usize::MAX));
    let stderr = child.stderr.take().map(|pipe| drain(pipe, STDERR_CAP));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                kill_and_reap(&mut child);
                return Err(RunError::Spawn(credential::redact(&e.to_string(), cred)));
            }
        }
        if run.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
            kill_and_reap(&mut child);
            return Err(RunError::Cancelled);
        }
        if let Some(budget) = run.budget {
            if started.elapsed() >= budget {
                // Kill AND reap. Without the wait the child is a zombie and the
                // directory it was writing to may still be growing when the
                // caller deletes it. The drain threads are left to finish on
                // their own: a pipe a killed grandchild still holds would
                // block a join.
                kill_and_reap(&mut child);
                return Err(RunError::TimedOut(budget));
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let stdout = stdout.map(join).unwrap_or_default();
    let stderr = stderr.map(join).unwrap_or_default();
    finish(status, &stdout, &stderr, cred)
}

/// Read a pipe to its end on a thread, keeping at most `cap` bytes.
fn drain(mut pipe: impl Read + Send + 'static, cap: usize) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = cap.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
        }
        kept
    })
}

fn join(handle: JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.join().unwrap_or_default()
}

/// Kill the child (its whole process group on Unix) and reap it.
fn kill_and_reap(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: `kill` with a negative pid signals the process group the
            // child leads (`process_group(0)` above); it touches no memory.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run it and report only whether it worked.
///
/// The mirror's callers all treat a failure as "use the network", and a cache
/// miss is not something to report to a user as an error. Output is discarded
/// rather than surfaced, which is the behaviour `run_mirror_git` had.
pub fn run_git_quietly(run: GitRun<'_>) -> bool {
    run_git(run).is_ok()
}

fn finish(
    status: std::process::ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
    cred: Option<&GitCredential>,
) -> Result<String, RunError> {
    if status.success() {
        return Ok(String::from_utf8_lossy(stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(stderr);
    Err(RunError::Failed(
        credential::redact(stderr.trim(), cred).to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_successful_command_can_return_its_stdout() {
        let dir = TempDir::new().unwrap();
        let out = run_git(GitRun::new(dir.path(), &args(&["--version"])).capture_stdout())
            .expect("git --version");
        assert!(out.starts_with("git version"), "{out}");
    }

    #[test]
    fn extra_env_reaches_the_git_it_runs() {
        let dir = TempDir::new().unwrap();
        let out = run_git(
            GitRun::new(dir.path(), &args(&["var", "GIT_AUTHOR_IDENT"]))
                .env("GIT_AUTHOR_NAME", "Mirror Probe")
                .env("GIT_AUTHOR_EMAIL", "probe@example.com")
                .capture_stdout(),
        )
        .expect("git var");
        assert!(out.starts_with("Mirror Probe <probe@example.com>"), "{out}");
    }

    #[test]
    fn a_failing_command_reports_redacted_stderr() {
        let dir = TempDir::new().unwrap();
        let err = run_git(GitRun::new(
            dir.path(),
            &args(&[
                "-c",
                "protocol.file.allow=never",
                "ls-remote",
                "https://x-access-token:ghp_leak@127.0.0.1:1/o/r.git",
            ]),
        ))
        .expect_err("unreachable remote");
        let RunError::Failed(detail) = err else {
            panic!("expected a failure, got {err:?}");
        };
        assert!(!detail.contains("ghp_leak"), "{detail}");
    }

    #[test]
    fn a_timed_out_git_is_killed_not_merely_abandoned() {
        // `git` here is a stand-in for a clone that will not finish inside the
        // budget. The assertion that matters is not the error variant: it is
        // that `run_git` has already reaped the child by the time it returns,
        // so the caller's `remove_dir_all` cannot race a process still writing.
        let dir = TempDir::new().unwrap();
        let started = Instant::now();
        let err = run_git(
            GitRun::new(
                dir.path(),
                &args(&[
                    "-c",
                    "protocol.ext.allow=always",
                    "ls-remote",
                    "ext::sleep 30",
                ]),
            )
            .budget(Duration::from_millis(300)),
        )
        .expect_err("should not finish inside the budget");

        assert!(
            matches!(err, RunError::TimedOut(_)),
            "expected a timeout, got {err:?}"
        );
        // Returned promptly rather than after the child's own 30s.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "run_git waited {:?}, so it did not kill the child",
            started.elapsed()
        );
    }

    #[test]
    fn a_command_without_a_budget_still_runs() {
        let dir = TempDir::new().unwrap();
        assert!(run_git_quietly(GitRun::new(
            dir.path(),
            &args(&["--version"])
        )));
    }

    #[test]
    fn the_credential_is_applied_as_config_not_as_an_argument() {
        // `git config --get` reads the env-based override, which is the whole
        // point: the token reached git without touching argv or any file.
        let dir = TempDir::new().unwrap();
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let out = run_git(
            GitRun::new(
                dir.path(),
                &args(&["config", "--get", "http.https://github.com/.extraheader"]),
            )
            .credential("https://github.com/", &credential)
            .capture_stdout(),
        )
        .expect("config --get");
        assert!(out.starts_with("Authorization: Basic "), "{out}");
        assert!(!out.contains("ghp_secret"), "{out}");
    }

    #[test]
    fn a_child_that_writes_more_than_a_pipe_holds_is_not_mistaken_for_a_timeout() {
        // A `!` alias runs through a shell whose stderr is git's. 300 KB is
        // several times what a pipe buffers, so a runner that read stderr only after the
        // exit would block the writer and report a timeout at 20 s.
        let dir = TempDir::new().unwrap();
        let started = Instant::now();
        let err = run_git(
            GitRun::new(
                dir.path(),
                &args(&[
                    "-c",
                    "alias.flood=!yes x | head -c 300000 >&2; exit 3",
                    "flood",
                ]),
            )
            .budget(Duration::from_secs(20)),
        )
        .expect_err("the helper exits non-zero");
        let RunError::Failed(detail) = err else {
            panic!("a full stderr pipe must not look like a timeout: {err:?}");
        };
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(detail.len() <= STDERR_CAP, "kept {} bytes", detail.len());
    }

    #[test]
    fn a_cancelled_run_never_starts() {
        let dir = TempDir::new().unwrap();
        let token = CancelToken::new();
        token.cancel();
        let err =
            run_git(GitRun::new(dir.path(), &args(&["--version"])).cancel(token)).unwrap_err();
        assert_eq!(err, RunError::Cancelled);
    }

    #[test]
    fn git_runs_under_the_c_locale_whatever_the_parent_has() {
        let dir = TempDir::new().unwrap();
        let out = run_git(
            GitRun::new(
                dir.path(),
                &args(&["-c", "alias.probe=!echo $LC_ALL/$LANG", "probe"]),
            )
            .capture_stdout(),
        )
        .unwrap();
        assert_eq!(out.trim(), "C/C");
    }

    #[test]
    fn git_s_curl_traces_are_off_and_redacted_whatever_was_asked() {
        let dir = TempDir::new().unwrap();
        let out = run_git(
            GitRun::new(
                dir.path(),
                &args(&[
                    "-c",
                    "alias.probe=!echo [$GIT_TRACE_CURL][$GIT_CURL_VERBOSE][$GIT_TRACE_REDACT]",
                    "probe",
                ]),
            )
            .user_config()
            .env("GIT_TRACE_CURL", "1")
            .env("GIT_CURL_VERBOSE", "1")
            .env("GIT_TRACE_REDACT", "0")
            .capture_stdout(),
        )
        .unwrap();
        assert_eq!(out.trim(), "[][][1]");
    }

    #[test]
    fn a_user_config_run_drops_the_isolation_env_and_the_credential() {
        let dir = TempDir::new().unwrap();
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let isolated = run_git(
            GitRun::new(dir.path(), &args(&["config", "--get", "core.hooksPath"])).capture_stdout(),
        );
        assert_eq!(isolated.unwrap().trim(), "/dev/null");
        let user = run_git(
            GitRun::new(
                dir.path(),
                &args(&["config", "--get", "http.https://github.com/.extraheader"]),
            )
            .credential("https://github.com/", &credential)
            .user_config()
            .capture_stdout(),
        );
        // No credential header reached git, so the key is unset (exit 1).
        assert!(matches!(user, Err(RunError::Failed(_))), "{user:?}");
    }
}
