//! One checkout acquisition: its deadline, its cancel, and what each phase cost.
//!
//! A managed checkout is a chain of git calls (mirror fetch, blob backfill,
//! derive, `worktree add`, sparse, checkout) and each used to carry its own
//! limit or none at all. Some had no bound, so a hung fetch held a task
//! forever; none could be cancelled, because the service runs under
//! `spawn_blocking` and dropping the join handle does not stop git; and a
//! failure came back as a string, so a caller could not tell "the token is
//! wrong" from "the network blinked" and either retried the first or gave up
//! on the second.
//!
//! [`AcquisitionBudget`] is the one context every phase runs under:
//!
//! - **Deadline.** Each phase runs for the shorter of its ceiling and what is
//!   left of the overall deadline. A phase that starts after the deadline
//!   fails as [`FailureClass::TimedOut`] without spawning anything.
//! - **Cancel.** [`CancelToken`] is polled by the runner; a cancelled phase is
//!   killed and reaped like a timed-out one.
//! - **Classes.** [`classify_stderr`] sorts a failure into the few classes a
//!   caller acts on, and [`FailureClass::is_retryable`] says which ones are
//!   worth another attempt.
//! - **Report.** Every phase is timed into an [`AcquisitionReport`] and into a
//!   `cognia_instrument` span, so a slow acquisition says where the time went.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::runner::{run_git, GitRun, RunError};

/// What a failed git call means for the caller.
///
/// Deliberately few: these are the distinctions that change what happens
/// next (retry, fall back to the network, or tell the person), not a mirror of
/// every git error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureClass {
    /// The remote said the repository, branch or ref does not exist (or is
    /// not visible to this credential).
    NotFound,
    /// The remote refused the credential, or wanted one nobody can type.
    Auth,
    /// The transport failed: DNS, connect, TLS, a dropped connection.
    Network,
    /// The phase ran past its budget and was killed.
    TimedOut,
    /// Someone cancelled the acquisition and the phase was killed.
    Cancelled,
    /// Another git process holds a lock in the repository.
    Lock,
    /// The disk is full.
    DiskFull,
    /// Anything else.
    Other,
}

impl FailureClass {
    /// Whether another attempt can reasonably succeed where this one failed.
    ///
    /// Only transport trouble. An auth failure retried is the same request
    /// sent again with the same token, and a missing branch does not appear
    /// because we asked twice.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Network | Self::TimedOut)
    }

    /// Whether falling back from the mirror to a network clone could change
    /// the answer. It cannot when the remote itself refused the request: the
    /// network clone asks the same remote with the same credential.
    pub fn network_could_help(self) -> bool {
        !matches!(self, Self::Auth | Self::NotFound | Self::Cancelled)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "notFound",
            Self::Auth => "auth",
            Self::Network => "network",
            Self::TimedOut => "timedOut",
            Self::Cancelled => "cancelled",
            Self::Lock => "lock",
            Self::DiskFull => "diskFull",
            Self::Other => "other",
        }
    }

    /// The class a runner error belongs to.
    pub fn of(error: &RunError) -> Self {
        match error {
            RunError::TimedOut(_) => Self::TimedOut,
            RunError::Cancelled => Self::Cancelled,
            RunError::Spawn(detail) => {
                if detail.to_lowercase().contains("no space left") {
                    Self::DiskFull
                } else {
                    Self::Other
                }
            }
            RunError::Failed(detail) => classify_stderr(detail),
        }
    }
}

/// Sort a git failure by its stderr.
///
/// The runner pins `LC_ALL=C`, so these English strings are what git prints.
/// Order matters where two can appear together: an HTTP 403 also says "unable
/// to access", and it is an auth failure, not a network one.
pub fn classify_stderr(stderr: &str) -> FailureClass {
    let s = stderr.to_lowercase();
    if s.contains("no space left on device") || s.contains("disk quota exceeded") {
        return FailureClass::DiskFull;
    }
    if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("permission denied (publickey)")
        || s.contains("terminal prompts disabled")
        || s.contains("invalid username or password")
        || s.contains("the requested url returned error: 401")
        || s.contains("the requested url returned error: 403")
        || s.contains("401 unauthorized")
        || s.contains("403 forbidden")
    {
        return FailureClass::Auth;
    }
    if s.contains("repository not found")
        || s.contains("couldn't find remote ref")
        || s.contains("could not find remote branch")
        || s.contains("not found in upstream origin")
        || s.contains("the requested url returned error: 404")
        || (s.contains("remote branch") && s.contains("not found"))
    {
        return FailureClass::NotFound;
    }
    if s.contains("index.lock") || (s.contains("unable to create") && s.contains(".lock")) {
        return FailureClass::Lock;
    }
    if s.contains("could not resolve host")
        || s.contains("failed to connect")
        || s.contains("connection timed out")
        || s.contains("connection reset")
        || s.contains("connection refused")
        || s.contains("network is unreachable")
        || s.contains("unable to access")
        || s.contains("the remote end hung up unexpectedly")
        || s.contains("early eof")
        || s.contains("ssl_error")
        || s.contains("gnutls_handshake")
        || s.contains("operation timed out")
        || s.contains("the requested url returned error: 5")
    {
        return FailureClass::Network;
    }
    FailureClass::Other
}

/// A request to stop an acquisition, shared between whoever started it and
/// the runner polling it. Cloning shares the flag.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The steps of an acquisition, each with its own ceiling and span.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Bring the mirror up to date (`fetch`), or a repository's `origin`.
    Fetch,
    /// Create the mirror, or clone from the network.
    Clone,
    /// Have the mirror fetch the file contents a checkout will need.
    Backfill,
    /// Clone a working checkout out of the mirror.
    Derive,
    /// `git worktree add`.
    WorktreeAdd,
    /// `git sparse-checkout`.
    Sparse,
    /// Writing the working tree.
    Checkout,
    /// Links and copies from the repository's declaration.
    Provisioning,
}

impl Phase {
    pub const ALL: [Phase; 8] = [
        Phase::Fetch,
        Phase::Clone,
        Phase::Backfill,
        Phase::Derive,
        Phase::WorktreeAdd,
        Phase::Sparse,
        Phase::Checkout,
        Phase::Provisioning,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Clone => "clone",
            Self::Backfill => "backfill",
            Self::Derive => "derive",
            Self::WorktreeAdd => "worktreeAdd",
            Self::Sparse => "sparse",
            Self::Checkout => "checkout",
            Self::Provisioning => "provisioning",
        }
    }

    /// The `cognia_instrument` span name. Static because the registry keys on
    /// `&'static str`.
    pub fn span(self) -> &'static str {
        match self {
            Self::Fetch => "git_mirror.fetch",
            Self::Clone => "git_mirror.clone",
            Self::Backfill => "git_mirror.backfill",
            Self::Derive => "git_mirror.derive",
            Self::WorktreeAdd => "workspace.worktree_add",
            Self::Sparse => "workspace.sparse",
            Self::Checkout => "workspace.checkout",
            Self::Provisioning => "workspace.provisioning",
        }
    }

    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|phase| *phase == self)
            .unwrap_or(0)
    }
}

/// One timed phase of an acquisition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseRecord {
    pub phase: Phase,
    /// Milliseconds since the acquisition started.
    pub started_ms: u64,
    pub duration_ms: u64,
    pub ok: bool,
    /// Set when the phase failed.
    pub class: Option<FailureClass>,
    /// 1 for the first attempt; a retried phase records each attempt.
    pub attempt: u32,
    /// A short fact about the phase, such as `"hit"` / `"miss"` for a mirror.
    pub note: Option<String>,
}

/// Everything an acquisition recorded about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionReport {
    pub total_ms: u64,
    pub phases: Vec<PhaseRecord>,
}

/// Retry shape for transport failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Attempts in total, including the first. 1 disables retrying.
    pub attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(8),
        }
    }
}

/// How long to wait before attempt `attempt + 1`: exponential with a cap, and
/// full jitter so a fleet of acquisitions that failed together does not retry
/// together.
pub fn backoff_delay(policy: &RetryPolicy, attempt: u32, entropy: u64) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16);
    let ceiling = policy
        .base_delay
        .saturating_mul(1u32 << exponent)
        .min(policy.max_delay);
    let millis = ceiling.as_millis() as u64;
    if millis == 0 {
        return Duration::ZERO;
    }
    // Full jitter, but never below half the ceiling, so a retry is not
    // effectively immediate.
    Duration::from_millis(millis / 2 + entropy % (millis / 2 + 1))
}

/// [`backoff_delay`] with clock-derived jitter, for callers outside an
/// [`AcquisitionBudget`] (the async GitHub workspace clone, for one).
pub fn jittered_backoff(policy: &RetryPolicy, attempt: u32) -> Duration {
    backoff_delay(policy, attempt, entropy(attempt))
}

fn entropy(attempt: u32) -> u64 {
    // xorshift over the clock: no dependency for what only needs to be
    // different across processes and attempts, not unpredictable.
    let mut x = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15)
        ^ (u64::from(std::process::id()) << 32)
        ^ u64::from(attempt);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

/// The deadline, cancel and log of one acquisition. Cheap to share by
/// reference; the log is internally synchronised.
#[derive(Debug)]
pub struct AcquisitionBudget {
    started: Instant,
    /// The overall limit, and when it runs out. The end moves when
    /// [`Self::restart_deadline`] is called after a wait.
    limit: Option<Duration>,
    deadline: Mutex<Option<Instant>>,
    ceilings: [Option<Duration>; Phase::ALL.len()],
    cancel: CancelToken,
    retry: RetryPolicy,
    log: Mutex<Vec<PhaseRecord>>,
}

/// Overall limit for one local acquisition when the caller names none.
///
/// Long, because a first checkout of a very large repository is slow by
/// nature; finite, because "forever" is what a hung fetch used to cost.
pub const DEFAULT_ACQUISITION_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Ceiling for one incremental fetch (mirror refresh, `fetch origin`, a pull
/// request head). A fetch that needs longer is stuck, not slow.
pub const DEFAULT_FETCH_CEILING: Duration = Duration::from_secs(180);

/// Ceiling for creating a mirror, a network clone, a derive or a backfill.
/// The same ten minutes the mirror callers have always given themselves.
pub const DEFAULT_CLONE_CEILING: Duration = Duration::from_secs(10 * 60);

impl AcquisitionBudget {
    /// A budget with an overall deadline and no per-phase ceilings.
    pub fn new(deadline: Option<Duration>) -> Self {
        let started = Instant::now();
        Self {
            started,
            limit: deadline,
            deadline: Mutex::new(deadline.map(|limit| started + limit)),
            ceilings: [None; Phase::ALL.len()],
            cancel: CancelToken::new(),
            retry: RetryPolicy::default(),
            log: Mutex::new(Vec::new()),
        }
    }

    /// The standard budget for a checkout acquisition: the default overall
    /// deadline, the fetch ceiling on fetches and the clone ceiling on clones,
    /// derives and backfills. Writing the tree has no ceiling of its own; it
    /// takes as long as the repository is large, inside the deadline.
    pub fn standard() -> Self {
        Self::new(Some(DEFAULT_ACQUISITION_DEADLINE))
            .with_ceiling(Phase::Fetch, DEFAULT_FETCH_CEILING)
            .with_ceiling(Phase::Clone, DEFAULT_CLONE_CEILING)
            .with_ceiling(Phase::Derive, DEFAULT_CLONE_CEILING)
            .with_ceiling(Phase::Backfill, DEFAULT_CLONE_CEILING)
    }

    pub fn with_ceiling(mut self, phase: Phase, ceiling: Duration) -> Self {
        self.ceilings[phase.index()] = Some(ceiling);
        self
    }

    pub fn with_cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = cancel;
        self
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// What is left of the overall deadline, `None` when there is none.
    pub fn remaining(&self) -> Option<Duration> {
        self.deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// Start the overall deadline again from now.
    ///
    /// For a caller that queued (on an admission or repository lock) before
    /// doing any work: the deadline bounds work that hangs, not time spent
    /// waiting for a turn. The report's clock is not reset, so its total
    /// still shows the wait.
    pub fn restart_deadline(&self) {
        *self
            .deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            self.limit.map(|limit| Instant::now() + limit);
    }

    /// The limit a phase may run under right now.
    ///
    /// `Err` when the phase must not start at all: the acquisition was
    /// cancelled, or its deadline has passed.
    pub fn limit_for(&self, phase: Phase) -> Result<Option<Duration>, RunError> {
        if self.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let ceiling = self.ceilings[phase.index()];
        match (ceiling, self.remaining()) {
            (_, Some(left)) if left.is_zero() => Err(RunError::TimedOut(Duration::ZERO)),
            (Some(ceiling), Some(left)) => Ok(Some(ceiling.min(left))),
            (Some(ceiling), None) => Ok(Some(ceiling)),
            (None, left) => Ok(left),
        }
    }

    /// Run one git call as `phase`: under its limit, with the cancel, timed.
    pub fn run(&self, phase: Phase, run: GitRun<'_>) -> Result<String, RunError> {
        self.run_attempt(phase, run, 1)
    }

    fn run_attempt(&self, phase: Phase, run: GitRun<'_>, attempt: u32) -> Result<String, RunError> {
        let started = Instant::now();
        let result = match self.limit_for(phase) {
            Ok(limit) => run_git(run.maybe_budget(limit).cancel(self.cancel.clone())),
            Err(error) => Err(error),
        };
        self.record(phase, started, result.as_ref().err(), attempt, None);
        result
    }

    /// Run a network call as `phase`, retrying transport failures.
    ///
    /// `make` builds the call afresh for each attempt (a `GitRun` borrows its
    /// arguments, so it cannot be reused). `before_retry` runs between
    /// attempts, for clearing a half-written destination. Retrying stops when
    /// the class is not retryable, the attempts run out, the acquisition is
    /// cancelled, or the backoff would outlast the deadline.
    pub fn run_retrying<'a>(
        &self,
        phase: Phase,
        make: impl FnMut() -> GitRun<'a>,
        before_retry: impl FnMut(),
    ) -> Result<String, RunError> {
        self.run_retrying_if(phase, make, before_retry, FailureClass::is_retryable)
    }

    /// [`Self::run_retrying`] with the caller's own choice of which classes
    /// are worth another attempt, a subset of the retryable ones. A fetch
    /// with the user's configuration does not retry a timeout: it may be an
    /// SSH prompt nobody can answer, and three of those are nine minutes.
    pub fn run_retrying_if<'a>(
        &self,
        phase: Phase,
        mut make: impl FnMut() -> GitRun<'a>,
        mut before_retry: impl FnMut(),
        retry_if: impl Fn(FailureClass) -> bool,
    ) -> Result<String, RunError> {
        let mut attempt = 1;
        loop {
            let result = self.run_attempt(phase, make(), attempt);
            let Err(error) = &result else {
                return result;
            };
            let class = FailureClass::of(error);
            if attempt >= self.retry.attempts.max(1) || !class.is_retryable() || !retry_if(class) {
                return result;
            }
            let delay = backoff_delay(&self.retry, attempt, entropy(attempt));
            if self.remaining().is_some_and(|left| left <= delay) {
                return result;
            }
            if !self.sleep_unless_cancelled(delay) {
                return Err(RunError::Cancelled);
            }
            before_retry();
            attempt += 1;
        }
    }

    fn sleep_unless_cancelled(&self, delay: Duration) -> bool {
        let until = Instant::now() + delay;
        while Instant::now() < until {
            if self.is_cancelled() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25).min(until - Instant::now()));
        }
        !self.is_cancelled()
    }

    /// Time a phase that is not a single git call (several calls, or file
    /// work such as provisioning).
    pub fn timed<T, E>(
        &self,
        phase: Phase,
        work: impl FnOnce() -> Result<T, E>,
        class_of: impl FnOnce(&E) -> FailureClass,
    ) -> Result<T, E> {
        let started = Instant::now();
        let result = work();
        let class = result.as_ref().err().map(class_of);
        self.push(phase, started, class, 1, None);
        result
    }

    /// Record a fact about a phase that did not run git, such as a mirror hit.
    pub fn note(&self, phase: Phase, note: impl Into<String>) {
        let started = Instant::now();
        self.push(phase, started, None, 1, Some(note.into()));
    }

    fn record(
        &self,
        phase: Phase,
        started: Instant,
        error: Option<&RunError>,
        attempt: u32,
        note: Option<String>,
    ) {
        self.push(phase, started, error.map(FailureClass::of), attempt, note);
    }

    fn push(
        &self,
        phase: Phase,
        started: Instant,
        class: Option<FailureClass>,
        attempt: u32,
        note: Option<String>,
    ) {
        let elapsed = started.elapsed();
        cognia_instrument::record(phase.span(), elapsed, class.is_none());
        let record = PhaseRecord {
            phase,
            started_ms: millis(started.saturating_duration_since(self.started)),
            duration_ms: millis(elapsed),
            ok: class.is_none(),
            class,
            attempt,
            note,
        };
        self.log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(record);
    }

    /// The phases so far, and the time since the acquisition started.
    pub fn report(&self) -> AcquisitionReport {
        AcquisitionReport {
            total_ms: millis(self.started.elapsed()),
            phases: self
                .log
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
        }
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn stderr_is_sorted_into_the_classes_callers_act_on() {
        let cases = [
            (
                "fatal: Authentication failed for 'https://github.com/o/r.git/'",
                FailureClass::Auth,
            ),
            (
                "fatal: unable to access 'https://h/': The requested URL returned error: 403",
                FailureClass::Auth,
            ),
            (
                "remote: Repository not found.\nfatal: repository 'x' not found",
                FailureClass::NotFound,
            ),
            (
                "fatal: couldn't find remote ref refs/heads/nope",
                FailureClass::NotFound,
            ),
            (
                "warning: Could not find remote branch nope to clone.",
                FailureClass::NotFound,
            ),
            (
                "fatal: unable to access 'https://h/': Could not resolve host: h",
                FailureClass::Network,
            ),
            (
                "error: RPC failed; curl 18\nfatal: early EOF",
                FailureClass::Network,
            ),
            (
                "fatal: Unable to create '/r/.git/index.lock': File exists.",
                FailureClass::Lock,
            ),
            (
                "fatal: write error: No space left on device",
                FailureClass::DiskFull,
            ),
            ("fatal: bad object deadbeef", FailureClass::Other),
        ];
        for (stderr, class) in cases {
            assert_eq!(classify_stderr(stderr), class, "{stderr}");
        }
    }

    #[test]
    fn only_transport_failures_are_retried_and_a_refusal_skips_the_network() {
        assert!(FailureClass::Network.is_retryable());
        assert!(FailureClass::TimedOut.is_retryable());
        for class in [
            FailureClass::Auth,
            FailureClass::NotFound,
            FailureClass::Cancelled,
            FailureClass::Lock,
            FailureClass::DiskFull,
            FailureClass::Other,
        ] {
            assert!(!class.is_retryable(), "{class:?}");
        }
        assert!(!FailureClass::Auth.network_could_help());
        assert!(!FailureClass::NotFound.network_could_help());
        assert!(FailureClass::Network.network_could_help());
        assert!(FailureClass::Other.network_could_help());
    }

    #[test]
    fn backoff_grows_is_capped_and_never_collapses_to_zero() {
        let policy = RetryPolicy {
            attempts: 6,
            base_delay: Duration::from_millis(400),
            max_delay: Duration::from_secs(2),
        };
        for entropy in [0, 1, 7, u64::MAX] {
            let first = backoff_delay(&policy, 1, entropy);
            assert!(first >= Duration::from_millis(200) && first <= Duration::from_millis(400));
            let late = backoff_delay(&policy, 5, entropy);
            assert!(
                late >= Duration::from_secs(1) && late <= Duration::from_secs(2),
                "{late:?}"
            );
        }
    }

    #[test]
    fn a_phase_runs_for_the_shorter_of_its_ceiling_and_the_deadline() {
        let budget = AcquisitionBudget::new(Some(Duration::from_secs(60)))
            .with_ceiling(Phase::Fetch, Duration::from_secs(5));
        let fetch = budget.limit_for(Phase::Fetch).unwrap().unwrap();
        assert!(fetch <= Duration::from_secs(5));
        let checkout = budget.limit_for(Phase::Checkout).unwrap().unwrap();
        assert!(checkout > Duration::from_secs(55) && checkout <= Duration::from_secs(60));
        assert_eq!(
            AcquisitionBudget::new(None)
                .limit_for(Phase::Checkout)
                .unwrap(),
            None
        );
    }

    #[test]
    fn nothing_starts_after_the_deadline_or_a_cancel() {
        let expired = AcquisitionBudget::new(Some(Duration::ZERO));
        assert!(matches!(
            expired.limit_for(Phase::Fetch),
            Err(RunError::TimedOut(_))
        ));
        let dir = tempfile::TempDir::new().unwrap();
        let cancelled = AcquisitionBudget::new(None);
        cancelled.cancel_token().cancel();
        let err = cancelled
            .run(Phase::Fetch, GitRun::new(dir.path(), &args(&["--version"])))
            .unwrap_err();
        assert_eq!(err, RunError::Cancelled);
        let report = cancelled.report();
        assert_eq!(report.phases.len(), 1);
        assert_eq!(report.phases[0].class, Some(FailureClass::Cancelled));
    }

    #[test]
    fn a_running_phase_is_killed_when_the_acquisition_is_cancelled() {
        let dir = tempfile::TempDir::new().unwrap();
        let budget = AcquisitionBudget::new(None);
        let token = budget.cancel_token();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            token.cancel();
        });
        let started = Instant::now();
        let err = budget
            .run(
                Phase::Fetch,
                GitRun::new(
                    dir.path(),
                    &args(&[
                        "-c",
                        "protocol.ext.allow=always",
                        "ls-remote",
                        "ext::sleep 30",
                    ]),
                ),
            )
            .unwrap_err();
        canceller.join().unwrap();
        assert_eq!(err, RunError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_transport_failure_is_retried_and_each_attempt_is_reported() {
        let dir = tempfile::TempDir::new().unwrap();
        let budget =
            AcquisitionBudget::new(Some(Duration::from_secs(30))).with_retry(RetryPolicy {
                attempts: 3,
                base_delay: Duration::from_millis(10),
                max_delay: Duration::from_millis(20),
            });
        // Port 1 on loopback refuses the connection: a Network failure.
        let probe = args(&["ls-remote", "http://127.0.0.1:1/o/r.git"]);
        let mut cleared = 0;
        let err = budget
            .run_retrying(
                Phase::Fetch,
                || GitRun::new(dir.path(), &probe),
                || cleared += 1,
            )
            .unwrap_err();
        assert_eq!(FailureClass::of(&err), FailureClass::Network, "{err}");
        let attempts: Vec<u32> = budget.report().phases.iter().map(|p| p.attempt).collect();
        assert_eq!(attempts, vec![1, 2, 3]);
        assert_eq!(cleared, 2);
    }

    #[test]
    fn a_caller_can_narrow_which_classes_are_retried() {
        let dir = tempfile::TempDir::new().unwrap();
        let budget =
            AcquisitionBudget::new(Some(Duration::from_secs(30))).with_retry(RetryPolicy {
                attempts: 3,
                base_delay: Duration::from_millis(10),
                max_delay: Duration::from_millis(20),
            });
        let probe = args(&["ls-remote", "http://127.0.0.1:1/o/r.git"]);
        let err = budget
            .run_retrying_if(
                Phase::Fetch,
                || GitRun::new(dir.path(), &probe),
                || {},
                |class| class != FailureClass::Network,
            )
            .unwrap_err();
        assert_eq!(FailureClass::of(&err), FailureClass::Network);
        assert_eq!(budget.report().phases.len(), 1, "not retried");
    }

    #[test]
    fn a_restarted_deadline_counts_from_the_restart() {
        let budget = AcquisitionBudget::new(Some(Duration::from_millis(50)));
        std::thread::sleep(Duration::from_millis(80));
        assert!(matches!(
            budget.limit_for(Phase::Fetch),
            Err(RunError::TimedOut(_))
        ));
        budget.restart_deadline();
        let limit = budget.limit_for(Phase::Fetch).unwrap().unwrap();
        assert!(limit > Duration::from_millis(20) && limit <= Duration::from_millis(50));
        // The report still counts from the start, wait included.
        assert!(budget.report().total_ms >= 80);
    }

    #[test]
    fn a_refusal_is_not_retried() {
        let dir = tempfile::TempDir::new().unwrap();
        let budget = AcquisitionBudget::new(None);
        let missing = Path::new("/definitely/not/a/repository");
        let probe = args(&["ls-remote", &missing.to_string_lossy()]);
        let _ = budget.run_retrying(Phase::Fetch, || GitRun::new(dir.path(), &probe), || {});
        assert_eq!(budget.report().phases.len(), 1);
    }

    #[test]
    fn the_report_carries_notes_and_failed_work() {
        let budget = AcquisitionBudget::new(None);
        budget.note(Phase::Fetch, "hit");
        let _: Result<(), &str> =
            budget.timed(Phase::Provisioning, || Err("copy"), |_| FailureClass::Other);
        let report = budget.report();
        assert_eq!(report.phases[0].note.as_deref(), Some("hit"));
        assert!(report.phases[0].ok);
        assert_eq!(report.phases[1].phase, Phase::Provisioning);
        assert_eq!(report.phases[1].class, Some(FailureClass::Other));
    }
}
