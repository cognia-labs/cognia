//! The job supervisor: spawn, observe, and reap background commands.
//!
//! Two properties distinguish this from the sidecar registry it replaces:
//!
//! 1. **Process groups.** Children are spawned into their own session
//!    (`setsid`) so a kill signals the whole tree. The previous implementation
//!    called `child.kill()` on the wrapper shell, which left `sh -c "pnpm dev"`
//!    grandchildren alive holding their ports while reporting success.
//! 2. **Lifetime is owner-scoped, not session-scoped.** A job owned by a
//!    scheduled task outlives the chat turn that created it.
//!
//! Locking discipline: `parking_lot` mutexes are taken, cloned out of, and
//! released — never held across an `.await`. Group handles retain their Child
//! under a short lock; lifecycle observation never reaps the pinned leader.
//! Final teardown revokes signal authority before retiring the group.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::limits::{
    EXIT_TAIL_DRAIN_GRACE, JOB_OUTPUT_TAIL_BYTES, MAX_JOBS_GLOBAL, MAX_JOBS_PER_SESSION,
    MAX_LOG_BYTES_GLOBAL,
};
use crate::output::JobOutput;
use crate::store::JobStore;
use crate::types::{
    now_ms, JobDelivery, JobError, JobExit, JobOrigin, JobOutputSlice, JobOwner, JobRecord,
    JobStatus, JobStopCause, Result, SpawnJobRequest,
};

/// Most settlements one reconciliation query returns.
const MAX_SETTLEMENTS: usize = 200;

/// How long a killed process group gets to exit on SIGTERM before SIGKILL.
const KILL_ESCALATION: Duration = Duration::from_secs(3);

/// Live state for a running job. Terminal jobs drop theirs and are served
/// entirely from the store plus the on-disk log.
///
/// "Terminal" here means settled AND drained: the row settles as soon as the
/// direct child exits, but a grandchild can still hold the stdout/stderr pipes
/// open, so the entry (and its ring buffer) is only removed once both pumps
/// have hit EOF and the log is flushed. Removing it earlier would send
/// `read` to the on-disk log while bytes were still landing in an orphaned
/// `JobOutput`.
struct LiveJob {
    output: Arc<Mutex<JobOutput>>,
    /// Fires whenever output lands or the job settles — drives long-polling
    /// without a sleep loop.
    notify: Arc<Notify>,
    killed: Arc<AtomicBool>,
}

/// Listener invoked once per job when it reaches a terminal state.
///
/// The Tauri layer uses this to emit `job:exited` onto the scheduler event bus
/// and to wake any registered `Monitor`.
pub type ExitListener = Arc<dyn Fn(JobExit) + Send + Sync>;

// WNOWAIT observes lifecycle without reaping: the Child pins pid/pgid until
// final teardown. Signals and retirement are serialized under the group lock.
struct JobGroup {
    child: tokio::process::Child,
    pid: Option<u32>,
    owned: bool,
    empty: bool,
    exit: Option<std::process::ExitStatus>,
}
impl JobGroup {
    fn observe(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        #[cfg(unix)]
        let status = if self.owned {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let pid = self
                .pid
                .ok_or_else(|| std::io::Error::other("missing child identity"))?;
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
                )
            } == -1
            {
                return Err(std::io::Error::last_os_error());
            }
            if unsafe { info.si_pid() } == 0 {
                None
            } else {
                let code = unsafe { info.si_status() };
                Some(std::process::ExitStatus::from_raw(
                    if info.si_code == libc::CLD_EXITED {
                        code << 8
                    } else {
                        code
                    },
                ))
            }
        } else {
            self.child.try_wait()?
        };
        #[cfg(not(unix))]
        let status = self.child.try_wait()?;
        self.exit = status;
        Ok(status)
    }
    fn probe(&mut self) -> bool {
        if self.empty {
            return false;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            if unsafe { libc::kill(-(pid as i32), 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                self.pid = None;
                self.owned = false;
                self.empty = true;
                return false;
            }
        }
        true
    }
    fn signal_with(&mut self, signal: i32, send: impl FnOnce(u32, i32)) {
        if self.owned && self.probe() {
            if let Some(pid) = self.pid {
                send(pid, signal);
            }
        }
    }
    fn signal(&mut self, signal: i32) {
        #[cfg(unix)]
        self.signal_with(signal, |pid, signal| unsafe {
            libc::kill(-(pid as i32), signal);
        });
        #[cfg(not(unix))]
        {
            let _ = signal;
            if self.owned {
                let _ = self.child.start_kill();
            }
        }
    }
    fn retire(&mut self) {
        // Final best effort while the leader still pins ownership. Outstanding
        // waiter/kill handles lose signal authority before the owner retires.
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(not(unix))]
        self.signal(9);
        self.reap_for_teardown();
        self.owned = false;
        self.pid = None;
    }

    fn reap_for_teardown(&mut self) {
        if self.observe().ok().flatten().is_some() {
            // Final teardown handoff: no signal can use this identity again.
            self.owned = false;
            let _ = self.child.try_wait();
        }
    }
}

impl Drop for JobGroup {
    fn drop(&mut self) {
        self.signal(9);
    }
}

pub struct JobSupervisor {
    store: Arc<JobStore>,
    log_dir: PathBuf,
    /// Shared with each job's waiter task, which removes the entry once the
    /// job is settled and its output has drained.
    live: Arc<Mutex<HashMap<String, Arc<LiveJob>>>>,
    process_groups: Arc<Mutex<HashMap<String, Arc<Mutex<JobGroup>>>>>,
    origins: Mutex<HashMap<String, JobOrigin>>,
    pending_records: Mutex<HashMap<String, JobRecord>>,
    // Owner-level proof, with no retained signalable identity after retirement.
    session_proofs: Mutex<HashMap<String, bool>>,
    admission: tokio::sync::RwLock<()>,
    closed_sessions: Mutex<HashSet<String>>,
    owner_proofs: Mutex<HashMap<String, bool>>,
    all_closed: AtomicBool,
    group_proof_supported: bool,
    exit_listeners: Mutex<Vec<ExitListener>>,
}

impl Drop for JobSupervisor {
    fn drop(&mut self) {
        #[cfg(unix)]
        for group in self.process_groups.lock().values() { group.lock().signal(libc::SIGKILL); }
    }
}

impl JobSupervisor {
    pub fn new(store: Arc<JobStore>, log_dir: PathBuf) -> Self {
        Self::with_group_proof(store, log_dir, cfg!(unix))
    }

    fn with_group_proof(
        store: Arc<JobStore>,
        log_dir: PathBuf,
        group_proof_supported: bool,
    ) -> Self {
        Self {
            store,
            log_dir,
            live: Arc::new(Mutex::new(HashMap::new())),
            process_groups: Arc::new(Mutex::new(HashMap::new())),
            origins: Mutex::new(HashMap::new()),
            pending_records: Mutex::new(HashMap::new()),
            session_proofs: Mutex::new(HashMap::new()),
            admission: tokio::sync::RwLock::new(()),
            closed_sessions: Mutex::new(HashSet::new()),
            owner_proofs: Mutex::new(HashMap::new()),
            all_closed: AtomicBool::new(false),
            group_proof_supported,
            exit_listeners: Mutex::new(Vec::new()),
        }
    }

    /// Boot reconcile. Any row still `running` belongs to a process from a
    /// previous app lifetime, so it is flipped to `interrupted`. Must run
    /// before the first `spawn`, otherwise the concurrency caps count ghosts.
    pub fn reconcile_on_boot(&self) -> Result<Vec<String>> {
        self.store.interrupt_orphans_on_boot(now_ms())
    }

    /// Register a terminal-transition listener. Called once per job, after the
    /// store has recorded the verdict, with the listener set frozen at spawn
    /// time so a late registration cannot retroactively observe an old job.
    pub fn on_exit(&self, listener: ExitListener) {
        self.exit_listeners.lock().push(listener);
    }

    /// Background jobs running on this host now. An unreadable store counts
    /// as busy: a host updates itself only when it knows nothing is running
    /// (ADR-0224 A10).
    pub fn running_count(&self) -> usize {
        self.list(None)
            .map(|jobs| jobs.iter().filter(|job| self.job_is_live(job)).count())
            .unwrap_or(usize::MAX)
    }

    /// Enforce the per-owner and global concurrency caps.
    fn check_capacity(&self, owner: &JobOwner) -> Result<()> {
        if self.running_count() >= MAX_JOBS_GLOBAL {
            return Err(JobError::LimitReached(format!(
                "at most {MAX_JOBS_GLOBAL} background jobs may run at once on this host"
            )));
        }
        // Only session-owned work is capped per owner; scheduled tasks and
        // app-owned jobs are already gated by the scheduler and by approval.
        if matches!(owner, JobOwner::Session { .. })
            && self
                .list(Some(owner))?
                .iter()
                .filter(|job| self.job_is_live(job))
                .count()
                >= MAX_JOBS_PER_SESSION
        {
            return Err(JobError::LimitReached(format!(
                "at most {MAX_JOBS_PER_SESSION} background jobs may run at once in one session; \
                 stop one with kill_shell first"
            )));
        }
        Ok(())
    }

    /// Start a background job. Returns as soon as the child is spawned.
    pub async fn spawn(&self, req: SpawnJobRequest) -> Result<JobRecord> {
        self.spawn_with_origin(req, None).await
    }

    pub(crate) async fn spawn_with_origin(
        &self,
        req: SpawnJobRequest,
        origin: Option<JobOrigin>,
    ) -> Result<JobRecord> {
        self.spawn_attributed(req, origin, None).await
    }

    /// Start a job an agent asked for. `delivery` names the chat session and
    /// run its end reports into (ADR-0249). That is the conversation, not the
    /// job's owner: a tool session owns its jobs under its executor's id.
    pub(crate) async fn spawn_attributed(
        &self,
        req: SpawnJobRequest,
        origin: Option<JobOrigin>,
        delivery: Option<JobDelivery>,
    ) -> Result<JobRecord> {
        let _admission = self.admission.read().await;
        // Legacy session-owned jobs have the same admission owner even without
        // explicit attempt metadata (detached jobs keep their explicit origin).
        let origin = origin.or_else(|| match &req.owner {
            JobOwner::Session { session_id } => Some(JobOrigin {
                session_id: session_id.clone(),
                child_run_id: None,
                dispatch_epoch: None,
            }),
            _ => None,
        });
        let owner_closed = match &req.owner {
            JobOwner::Session { session_id } => {
                self.closed_sessions.lock().contains(session_id)
                    || self.session_proofs.lock().contains_key(session_id)
                    || self.owner_proofs.lock().contains_key(session_id)
            }
            _ => false,
        };
        if delivery
            .as_ref()
            .is_some_and(|delivery| delivery.session_id.trim().is_empty())
        {
            return Err(JobError::Store(
                "a job's delivery must name the session it reports into".into(),
            ));
        }
        let delivery = delivery.map(|delivery| JobDelivery {
            stopped_by: None,
            claimed_by: None,
            ..delivery
        });
        if owner_closed
            || self.all_closed.load(Ordering::SeqCst)
            || origin.as_ref().is_some_and(|origin| {
                self.closed_sessions.lock().contains(&origin.session_id)
                    || self.session_proofs.lock().contains_key(&origin.session_id)
                    || self.owner_proofs.lock().contains_key(&origin.session_id)
            })
        {
            return Err(JobError::Store("job origin admission is closed".into()));
        }
        self.check_capacity(&req.owner)?;
        self.enforce_log_budget();

        let id = uuid::Uuid::new_v4().to_string();
        let started_at_ms = now_ms();
        let output = JobOutput::open(&self.log_dir, &id, Instant::now())
            .map_err(|e| JobError::Spawn(format!("could not open job log: {e}")))?;

        let mut cmd = tokio::process::Command::new(&req.program);
        cmd.args(&req.args)
            .current_dir(&req.cwd)
            .env_clear()
            // The Host's proxy, applied BEFORE the request's own env so an
            // explicit override in the job definition still wins. Without it a
            // job spawned with `env_clear()` is the one outbound path that
            // dials past the proxy the user configured — and on a network that
            // only permits egress through it, simply fails.
            .envs(cognia_net::proxy_config::child_network_env())
            // Includes the sidecar's host-resolved workspace port overlay;
            // keep this final so neither ambient nor host defaults replace it.
            .envs(&req.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP — no console flash,
            // and the group is addressable for a tree kill.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            if req.windows_verbatim_arguments {
                cmd.raw_arg(req.args.join(" "));
            }
        }

        // Put the child in its OWN session so a kill reaches grandchildren.
        // Same idiom as `cognia-exec-sandbox/src/macos.rs`.
        // SAFETY: post-fork / pre-exec; no allocation and no locks taken.
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    // Already a group leader on the rare path — fall back.
                    if libc::setpgid(0, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| JobError::Spawn(format!("{}: {e}", req.program)))?;
        let pid = child.id();

        let record = JobRecord {
            id: id.clone(),
            command: req.command.clone(),
            cwd: req.cwd.to_string_lossy().into_owned(),
            owner: req.owner.clone(),
            status: JobStatus::Running,
            exit_code: None,
            pid,
            started_at_ms,
            ended_at_ms: None,
            total_output_bytes: 0,
            dropped_output_bytes: 0,
            label: req.label.clone(),
        };
        // Register before any fallible journal write. Failed persistence cannot
        // erase an admitted group's origin and produce an authoritative empty.
        if let Some(origin) = &origin {
            self.origins.lock().insert(id.clone(), origin.clone());
        }
        self.pending_records
            .lock()
            .insert(id.clone(), record.clone());

        let output = Arc::new(Mutex::new(output));
        let notify = Arc::new(Notify::new());
        let killed = Arc::new(AtomicBool::new(false));

        self.live.lock().insert(
            id.clone(),
            Arc::new(LiveJob {
                output: Arc::clone(&output),
                notify: Arc::clone(&notify),
                killed: Arc::clone(&killed),
            }),
        );

        // Pump stdout and stderr into the same offset space. They are separate
        // pipes (unlike a PTY, which merges them) but interleave into one log
        // in arrival order, which is what a reader expects.
        let mut pumps = Vec::with_capacity(2);
        for stream in [
            child.stdout.take().map(StreamKind::Stdout),
            child.stderr.take().map(StreamKind::Stderr),
        ]
        .into_iter()
        .flatten()
        {
            let output = Arc::clone(&output);
            let notify = Arc::clone(&notify);
            pumps.push(tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                match stream {
                    StreamKind::Stdout(mut s) => {
                        pump(&mut s, &mut buf, &output, &notify).await;
                    }
                    StreamKind::Stderr(mut s) => {
                        pump(&mut s, &mut buf, &output, &notify).await;
                    }
                }
            }));
        }

        let group = Arc::new(Mutex::new(JobGroup {
            child,
            pid,
            owned: true,
            empty: false,
            exit: None,
        }));
        self.process_groups.lock().insert(id.clone(), group.clone());
        if let Err(error) =
            self.store
                .insert_attributed(&record, origin.as_ref(), delivery.as_ref())
        {
            #[cfg(unix)]
            group.lock().signal(libc::SIGKILL);
            #[cfg(not(unix))]
            {
                let _ = group.lock().child.start_kill();
            }
            let deadline = Instant::now() + Duration::from_millis(1_500);
            loop {
                group.lock().reap_for_teardown();
                if !group.lock().probe() || Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if let Some(origin) = &origin {
                self.session_proofs
                    .lock()
                    .insert(origin.session_id.clone(), false);
            }
            // Failed persistence remains unconfirmed even if rollback cleanup
            // succeeds: no durable acceptance record exists for this attempt.
            group.lock().retire();
            self.process_groups.lock().remove(&id);
            self.pending_records.lock().remove(&id);
            self.origins.lock().remove(&id);
            self.live.lock().remove(&id);
            for pump in pumps {
                pump.abort();
            }
            return Err(error);
        }
        self.pending_records.lock().remove(&id);

        // Waiter: owns the `Child`, so kill and wait never contend on a lock.
        let store = Arc::clone(&self.store);
        let waiter_id = id.clone();
        let waiter_output = Arc::clone(&output);
        let waiter_notify = Arc::clone(&notify);
        let waiter_owner = req.owner.clone();
        let waiter_killed = Arc::clone(&killed);
        let waiter_live = Arc::clone(&self.live);
        let waiter_groups = Arc::clone(&self.process_groups);
        let group_proof_supported = self.group_proof_supported;
        let listeners = self.exit_listeners.lock().clone();
        let waiter_command = req.command.clone();
        let waiter_label = req.label.clone();
        tokio::spawn(async move {
            let status = loop {
                match group.lock().observe() {
                    Ok(Some(status)) => break Some(status),
                    Err(_) => break None,
                    Ok(None) => {}
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            // Windows retains the journal origin as an unconfirmed session proof,
            // not an ever-growing set of dead process identities.
            if !group_proof_supported {
                group.lock().reap_for_teardown();
                waiter_groups.lock().remove(&waiter_id);
            }

            let ended_at_ms = now_ms();
            let was_killed = waiter_killed.load(Ordering::SeqCst);
            let final_status = if was_killed {
                JobStatus::Killed
            } else {
                JobStatus::Exited
            };
            // A killed process reports no meaningful code — keep it `None`
            // rather than surfacing a signal number as an exit status.
            let exit_code = if was_killed {
                None
            } else {
                status.and_then(|s| s.code())
            };

            // The direct child's last bytes can still be in its pipes. Give
            // the pumps a short grace so the tail an agent reads is complete,
            // without letting a grandchild that holds a pipe delay the event.
            let mut pumps: Vec<Option<tokio::task::JoinHandle<()>>> =
                pumps.into_iter().map(Some).collect();
            let grace = tokio::time::Instant::now() + EXIT_TAIL_DRAIN_GRACE;
            for slot in pumps.iter_mut() {
                if let Some(handle) = slot.as_mut() {
                    if tokio::time::timeout_at(grace, handle).await.is_ok() {
                        *slot = None;
                    }
                }
            }
            let delivery = store.job_delivery(&waiter_id).ok().flatten();
            let output_tail = {
                let mut out = waiter_output.lock();
                out.flush();
                let _ = store.update_output_counters(
                    &waiter_id,
                    out.total_bytes(),
                    out.dropped_bytes(),
                );
                delivery.as_ref().map(|_| {
                    let total = out.total_bytes();
                    out.read(
                        total.saturating_sub(JOB_OUTPUT_TAIL_BYTES as u64),
                        JOB_OUTPUT_TAIL_BYTES,
                    )
                    .data
                })
            };
            let _ = store.settle(&waiter_id, final_status, exit_code, ended_at_ms);
            waiter_notify.notify_waiters();
            // A kill settles the row before this waiter runs: its verdict wins.
            let settled = store.get(&waiter_id).ok().flatten();

            let exit = JobExit {
                job_id: waiter_id,
                status: settled.as_ref().map_or(final_status, |row| row.status),
                exit_code: settled.as_ref().map_or(exit_code, |row| row.exit_code),
                owner: waiter_owner,
                ended_at_ms: settled
                    .as_ref()
                    .and_then(|row| row.ended_at_ms)
                    .unwrap_or(ended_at_ms),
                started_at_ms,
                command: waiter_command,
                label: waiter_label,
                output_tail,
                delivery,
            };
            for listener in listeners {
                listener(exit.clone());
            }

            // Drain before dropping the live state. Grandchildren that inherited
            // the pipes keep the pumps running past the direct child's exit;
            // until both hit EOF, late bytes only exist in this `JobOutput`.
            for handle in pumps.into_iter().flatten() {
                let _ = handle.await;
            }
            {
                let mut out = waiter_output.lock();
                out.flush();
                let _ = store.update_output_counters(
                    &exit.job_id,
                    out.total_bytes(),
                    out.dropped_bytes(),
                );
            }
            // Remove BEFORE the final wake: a woken poller then either still
            // holds a clone of the (fully flushed) output or falls through to
            // the on-disk log, which now has every byte.
            waiter_live.lock().remove(&exit.job_id);
            waiter_notify.notify_waiters();
        });

        Ok(record)
    }

    /// Read a slice of a job's output. Non-consuming.
    pub fn read(&self, job_id: &str, from_offset: u64, max_bytes: usize) -> Result<JobOutputSlice> {
        let record = self
            .store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        let live = self.live.lock().get(job_id).cloned();
        let mut slice = match live {
            Some(job) => job.output.lock().read(from_offset, max_bytes),
            // Terminal job whose live state was dropped: reopen the log.
            None => {
                let mut out = JobOutput::open(&self.log_dir, job_id, Instant::now())?;
                out.read(from_offset, max_bytes)
            }
        };
        slice.status = record.status;
        slice.exit_code = record.exit_code;
        Ok(slice)
    }

    /// Long-poll for new output at or past `from_offset`, or for the job to
    /// settle, whichever happens first.
    ///
    /// Unlike the registry this replaces, a `wait` that returns no *matching*
    /// bytes does not consume them: `from_offset` is only advanced by the
    /// caller, from `next_offset`.
    pub async fn wait_for_output(
        &self,
        job_id: &str,
        from_offset: u64,
        max_bytes: usize,
        wait: Duration,
    ) -> Result<JobOutputSlice> {
        let deadline = Instant::now() + wait;
        loop {
            // Take the notify and create the `Notified` BEFORE reading: a
            // `notify_waiters()` that lands after this point wakes it even
            // though it is not polled yet, and one that landed before it is
            // already reflected in the read below. The `Notify` stays valid
            // even if the waiter drops the live entry in between.
            let notify = self
                .live
                .lock()
                .get(job_id)
                .map(|job| Arc::clone(&job.notify));
            let notified = notify.as_ref().map(|n| n.notified());

            let slice = self.read(job_id, from_offset, max_bytes)?;
            if !slice.data.is_empty() || slice.status.is_terminal() {
                return Ok(slice);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(slice);
            }
            match notified {
                Some(notified) => {
                    let _ = tokio::time::timeout(remaining, notified).await;
                }
                // No live state yet the row is not terminal — nothing will
                // ever wake us, so answer now rather than spin.
                None => return Ok(slice),
            }
        }
    }

    /// Terminate a job's whole process group. Idempotent.
    ///
    /// `requester` scopes the permission check: an agent may only kill jobs its
    /// own session owns. `None` means the UI, which may kill anything.
    pub async fn kill(&self, job_id: &str, requester: Option<&JobOwner>) -> Result<JobRecord> {
        let record = self
            .store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if let Some(req) = requester {
            if !owner_matches(req, &record.owner) {
                return Err(JobError::Forbidden(job_id.to_string()));
            }
        }
        if !self.job_is_live(&record) {
            return Ok(record);
        }
        // A scoped kill is the agent's own (`kill_shell`); an unscoped one is
        // a person's, from the Job Center.
        let cause = if requester.is_some() {
            JobStopCause::Agent
        } else {
            JobStopCause::Person
        };
        self.stop_job(&record, false, cause).await
    }

    async fn stop_job(
        &self,
        record: &JobRecord,
        require_group_proof: bool,
        cause: JobStopCause,
    ) -> Result<JobRecord> {
        let job_id = &record.id;
        // Before the signal: the exit this causes must carry its cause.
        self.store.mark_job_stopped_by(job_id, cause)?;
        let live = self.live.lock().get(job_id).cloned();
        let group = self
            .process_groups
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| JobError::Store(format!("job {job_id} process identity is unknown")))?;
        if group.lock().observe().ok().flatten().is_none() {
            if let Some(job) = &live {
                job.killed.store(true, Ordering::SeqCst);
            }
        }
        #[cfg(unix)]
        group.lock().signal(libc::SIGTERM);
        #[cfg(not(unix))]
        {
            group.lock().signal(9);
        }
        let start = Instant::now();
        let mut escalated = false;
        loop {
            if self.group_proof_supported {
                if self.process_group_running(job_id) == Some(false) {
                    break;
                }
            } else if group.lock().observe().ok().flatten().is_some() {
                break;
            }
            if !escalated && start.elapsed() >= KILL_ESCALATION {
                #[cfg(unix)]
                group.lock().signal(libc::SIGKILL);
                escalated = true;
            }
            if escalated {
                group.lock().reap_for_teardown();
            }
            if start.elapsed() >= KILL_ESCALATION + Duration::from_millis(500) {
                return Err(JobError::Store(format!(
                    "job {job_id} process group stop unconfirmed"
                )));
            }
            if !require_group_proof
                && !self.group_proof_supported
                && group.lock().observe().ok().flatten().is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Publish the leader's lifecycle verdict before returning group proof;
        // the independent waiter can still be scheduled after this query.
        if let Some(status) = group.lock().observe().ok().flatten() {
            let killed = live
                .as_ref()
                .is_some_and(|job| job.killed.load(Ordering::SeqCst));
            self.store.settle(
                job_id,
                if killed {
                    JobStatus::Killed
                } else {
                    JobStatus::Exited
                },
                if killed { None } else { status.code() },
                now_ms(),
            )?;
        }
        self.store
            .get(job_id)?
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))
    }

    /// Kill every job belonging to `owner`. Returns the ids killed.
    pub async fn kill_owned_by(&self, owner: &JobOwner) -> Result<Vec<String>> {
        let _admission = self.admission.write().await;
        let records = self.store.list_by_owner(owner)?;
        let mut stopped = Vec::new();
        let mut errors = Vec::new();
        if let JobOwner::Session { session_id } = owner {
            if self.session_proofs.lock().get(session_id) == Some(&false) {
                errors.push("origin journal admission was unconfirmed".into());
            }
        }
        for record in &records {
            if self.job_is_live(record) || self.process_group_running(&record.id) == Some(true) {
                match self
                    .stop_job(record, self.group_proof_supported, JobStopCause::Owner)
                    .await
                {
                    Ok(_) => stopped.push(record.id.clone()),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            if self.process_group_running(&record.id) != Some(false) {
                errors.push(format!("job {} process group stop unconfirmed", record.id));
            }
        }
        // Ordinary session disposal excludes app-promoted jobs. Fold only this
        // owner's result; origin disposal still covers its promoted groups.
        if let JobOwner::Session { session_id } = owner {
            self.owner_proofs
                .lock()
                .insert(session_id.clone(), errors.is_empty());
            for record in &records {
                if let Some(group) = self.process_groups.lock().remove(&record.id) {
                    group.lock().retire();
                }
                self.origins.lock().remove(&record.id);
                self.pending_records.lock().remove(&record.id);
            }
        }
        if errors.is_empty() {
            Ok(stopped)
        } else {
            Err(JobError::Store(errors.join("; ")))
        }
    }

    pub(crate) fn list_by_origin_session(&self, session_id: &str) -> Result<Vec<JobRecord>> {
        if self.session_proofs.lock().get(session_id) == Some(&false) {
            return Err(JobError::Store("origin session stop unconfirmed".into()));
        }
        self.origin_records(session_id)
    }

    fn origin_records(&self, session_id: &str) -> Result<Vec<JobRecord>> {
        let mut records = self.store.list_by_origin_session(session_id)?;
        for (id, origin) in self.origins.lock().iter() {
            if origin.session_id == session_id && !records.iter().any(|r| &r.id == id) {
                if let Some(record) = self.pending_records.lock().get(id) {
                    records.push(record.clone());
                }
            }
        }
        Ok(records)
    }

    pub(crate) async fn kill_origin_session(&self, session_id: &str) -> Result<Vec<String>> {
        let _admission = self.admission.write().await;
        if !self.closed_sessions.lock().insert(session_id.to_string()) {
            return if self.session_proofs.lock().get(session_id) == Some(&true) {
                Ok(Vec::new())
            } else {
                Err(JobError::Store("origin session stop unconfirmed".into()))
            };
        }
        let previously_uncertain = self.session_proofs.lock().get(session_id) == Some(&false);
        // A failed journal insert poisons proof, but must not skip cleanup of
        // other jobs already admitted for this origin.
        // The write barrier closed admission before this authoritative snapshot.
        self.session_proofs
            .lock()
            .insert(session_id.to_string(), false);
        let records = match self.origin_records(session_id) {
            Ok(records) => records,
            Err(error) => {
                // A failed journal read cannot reopen admission or strand
                // signalable identities outside the retired owner's record.
                let ids: Vec<_> = self
                    .origins
                    .lock()
                    .iter()
                    .filter(|(_, origin)| origin.session_id == session_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some(group) = self.process_groups.lock().remove(&id) {
                        group.lock().retire();
                    }
                    self.origins.lock().remove(&id);
                    self.pending_records.lock().remove(&id);
                }
                return Err(error);
            }
        };
        let mut stopped = Vec::new();
        let mut errors = Vec::new();
        if previously_uncertain {
            errors.push("origin journal admission was unconfirmed".into());
        }
        for record in &records {
            let proof = self.process_group_running(&record.id);
            if self.job_is_live(&record) || proof == Some(true) {
                match self
                    .stop_job(&record, self.group_proof_supported, JobStopCause::Owner)
                    .await
                {
                    Ok(_) => stopped.push(record.id.clone()),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            if self.process_group_running(&record.id) != Some(false) {
                errors.push(format!("job {} process group stop unconfirmed", record.id));
            }
        }
        let confirmed = errors.is_empty();
        self.session_proofs
            .lock()
            .insert(session_id.to_string(), confirmed);
        let mut ids: Vec<_> = records.iter().map(|record| record.id.clone()).collect();
        ids.extend(
            self.origins
                .lock()
                .iter()
                .filter(|(_, origin)| origin.session_id == session_id)
                .map(|(id, _)| id.clone()),
        );
        ids.sort();
        ids.dedup();
        for id in ids {
            if let Some(group) = self.process_groups.lock().remove(&id) {
                group.lock().retire();
            }
            self.origins.lock().remove(&id);
            self.pending_records.lock().remove(&id);
        }
        if !confirmed {
            return Err(JobError::Store(errors.join("; ")));
        }
        Ok(stopped)
    }

    /// Kill everything. Called at app exit so no job becomes an orphan daemon.
    pub async fn shutdown(&self) -> Result<Vec<String>> {
        let _admission = self.admission.write().await;
        self.all_closed.store(true, Ordering::SeqCst);
        let records = self.store.list_all()?;
        let mut stopped = Vec::new();
        let mut errors = Vec::new();
        for record in records {
            if self.process_groups.lock().contains_key(&record.id) {
                match self
                    .stop_job(&record, self.group_proof_supported, JobStopCause::Shutdown)
                    .await
                {
                    Ok(_) => stopped.push(record.id.clone()),
                    Err(error) => errors.push(error.to_string()),
                }
            }
        }
        for (_, group) in self.process_groups.lock().drain() {
            group.lock().retire();
        }
        self.origins.lock().clear();
        self.pending_records.lock().clear();
        if errors.is_empty() {
            Ok(stopped)
        } else {
            Err(JobError::Store(errors.join("; ")))
        }
    }

    pub fn get(&self, job_id: &str) -> Result<Option<JobRecord>> {
        self.store.get(job_id)
    }

    /// Take the delivery of an ended agent-started job for `consumer`
    /// (ADR-0249 §7). Only the first consumer to claim it delivers.
    pub fn claim_delivery(&self, job_id: &str, consumer: &str) -> Result<bool> {
        self.store.claim_job_delivery(job_id, consumer, now_ms())
    }

    /// Ended agent-started jobs as the exit events that reported them, for a
    /// consumer reconciling what its events missed (ADR-0249 §7). Newest
    /// first, at most [`MAX_SETTLEMENTS`]; the tail is read from the log.
    pub fn settlements(
        &self,
        session_id: Option<&str>,
        since_ms: Option<i64>,
    ) -> Result<Vec<JobExit>> {
        let rows = self.store.list_job_settlements(session_id, since_ms)?;
        Ok(rows
            .into_iter()
            .take(MAX_SETTLEMENTS)
            .map(|(record, delivery)| {
                let output_tail = self
                    .read(
                        &record.id,
                        record
                            .total_output_bytes
                            .saturating_sub(JOB_OUTPUT_TAIL_BYTES as u64),
                        JOB_OUTPUT_TAIL_BYTES,
                    )
                    .ok()
                    .map(|slice| slice.data);
                JobExit {
                    ended_at_ms: record.ended_at_ms.unwrap_or(record.started_at_ms),
                    job_id: record.id,
                    status: record.status,
                    exit_code: record.exit_code,
                    owner: record.owner,
                    started_at_ms: record.started_at_ms,
                    command: record.command,
                    label: record.label,
                    output_tail,
                    delivery: Some(delivery),
                }
            })
            .collect())
    }

    /// Find a RUNNING job by its OS pid.
    ///
    /// Exists for `terminate_process`, whose contract is pid-addressed. Only
    /// running jobs are considered: a terminal row's pid is cleared, and a
    /// recycled pid must never resolve to a finished job.
    pub fn find_running_by_pid(&self, pid: u32) -> Result<Option<JobRecord>> {
        Ok(self
            .store
            .list_running()?
            .into_iter()
            .find(|r| r.pid == Some(pid)))
    }

    /// Kill a running job addressed by pid. `Ok(None)` means no job owns that
    /// pid, leaving the caller free to fall back to a plain signal.
    pub async fn kill_by_pid(
        &self,
        pid: u32,
        requester: Option<&JobOwner>,
    ) -> Result<Option<JobRecord>> {
        let Some(found) = self.find_running_by_pid(pid)? else {
            return Ok(None);
        };
        self.kill(&found.id, requester).await.map(Some)
    }

    pub fn list(&self, owner: Option<&JobOwner>) -> Result<Vec<JobRecord>> {
        match owner {
            Some(JobOwner::Session { session_id })
                if self.session_proofs.lock().get(session_id) == Some(&false)
                    || self.owner_proofs.lock().get(session_id) == Some(&false) =>
            {
                Err(JobError::Store("owner process stop unconfirmed".into()))
            }
            Some(o) => self.store.list_by_owner(o),
            None => self.store.list_all(),
        }
    }

    /// None means ownership was lost, not that a former group's exit was seen.
    pub(crate) fn process_group_running(&self, job_id: &str) -> Option<bool> {
        if !self.group_proof_supported {
            return None;
        }
        if let Some(group) = self.process_groups.lock().get(job_id).cloned() {
            return Some(group.lock().probe());
        }
        if let Some(session) = self.store.origin_session(job_id).ok().flatten() {
            if self.session_proofs.lock().get(&session) == Some(&true) {
                return Some(false);
            }
        }
        if let JobOwner::Session { session_id } = self.store.get(job_id).ok().flatten()?.owner {
            if self.owner_proofs.lock().get(&session_id) == Some(&true) {
                return Some(false);
            }
        }
        None
    }

    fn job_is_live(&self, record: &JobRecord) -> bool {
        !record.status.is_terminal()
    }

    /// Evict oldest-finished jobs' logs until the global disk budget holds.
    fn enforce_log_budget(&self) {
        let Ok(terminal) = self.store.list_terminal_oldest_first() else {
            return;
        };
        let mut total: u64 = terminal.iter().map(|r| r.total_output_bytes).sum();
        for rec in terminal {
            if total <= MAX_LOG_BYTES_GLOBAL {
                break;
            }
            let mut out = match JobOutput::open(&self.log_dir, &rec.id, Instant::now()) {
                Ok(o) => o,
                Err(_) => continue,
            };
            out.remove_files();
            total = total.saturating_sub(rec.total_output_bytes);
            let _ = self.store.update_output_counters(&rec.id, 0, 0);
        }
    }
}

/// Does `requester` own `owner`'s jobs? Exact match — a session may not touch
/// another session's, a scheduled task's, or an app-owned job.
fn owner_matches(requester: &JobOwner, owner: &JobOwner) -> bool {
    requester == owner
}

enum StreamKind {
    Stdout(tokio::process::ChildStdout),
    Stderr(tokio::process::ChildStderr),
}

/// Drain one pipe into the job's output store, waking pollers per chunk.
async fn pump<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
    output: &Arc<Mutex<JobOutput>>,
    notify: &Arc<Notify>,
) {
    loop {
        match reader.read(buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Lock is taken and released inside the loop body — never held
                // across the `.await` above.
                output.lock().append(&buf[..n], Instant::now());
                notify.notify_waiters();
            }
        }
    }
}

/// SIGTERM the whole process group (negated pid).
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn supervisor(dir: &TempDir) -> JobSupervisor {
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        JobSupervisor::new(store, dir.path().join("logs"))
    }

    fn session(id: &str) -> JobOwner {
        JobOwner::Session {
            session_id: id.into(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_journal_failure_never_returns_authoritative_empty() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        let sup = JobSupervisor::new(store.clone(), dir.path().join("logs"));
        let sibling = sup
            .spawn_with_origin(
                sh("exec sleep 60", JobOwner::App),
                Some(JobOrigin {
                    session_id: "failed-origin".into(),
                    child_run_id: Some("child".into()),
                    dispatch_epoch: Some(1),
                }),
            )
            .await
            .unwrap();
        let sibling_group = sup.process_groups.lock()[&sibling.id].clone();
        store.fail_next_insert();
        let result = sup
            .spawn_with_origin(
                sh("sleep 60 & exit 0", JobOwner::App),
                Some(JobOrigin {
                    session_id: "failed-origin".into(),
                    child_run_id: Some("child".into()),
                    dispatch_epoch: Some(1),
                }),
            )
            .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("journal write failure"));
        assert!(sup.list_by_origin_session("failed-origin").is_err());
        assert!(sup.kill_origin_session("failed-origin").await.is_err());
        assert!(
            sibling_group.lock().observe().unwrap().is_some(),
            "journal failure must not skip admitted siblings"
        );
        assert!(!sibling_group.lock().owned);
        sibling_group
            .lock()
            .signal_with(libc::SIGKILL, |_, _| panic!("retired identity signalled"));
        assert!(sup.process_groups.lock().is_empty());
        assert!(sup.origins.lock().is_empty());
        assert!(sup.pending_records.lock().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_owner_retirement_cannot_signal_reused_identity() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let job = sup
            .spawn_with_origin(
                sh("sleep 60", JobOwner::App),
                Some(JobOrigin {
                    session_id: "owner".into(),
                    child_run_id: None,
                    dispatch_epoch: Some(1),
                }),
            )
            .await
            .unwrap();
        let group = sup.process_groups.lock()[&job.id].clone();
        sup.kill_origin_session("owner").await.unwrap();
        assert!(!group.lock().owned);
        group
            .lock()
            .signal_with(libc::SIGKILL, |_, _| panic!("retired pgid signalled"));
        assert!(sup.process_groups.lock().is_empty());
        assert!(sup.origins.lock().is_empty());
        assert_eq!(sup.process_group_running(&job.id), Some(false));
        assert!(
            sup.spawn(sh("exit 0", session("owner"))).await.is_err(),
            "legacy owner cannot reopen retired admission"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_legacy_owner_retirement_clears_process_entries() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let job = sup
            .spawn(sh("exec sleep 60", session("legacy")))
            .await
            .unwrap();
        sup.kill_owned_by(&session("legacy")).await.unwrap();
        assert!(sup.process_groups.lock().is_empty());
        assert!(sup.origins.lock().is_empty());
        assert_eq!(sup.process_group_running(&job.id), Some(false));
        assert!(sup.spawn(sh("exit 0", session("legacy"))).await.is_err());
        assert!(
            sup.spawn_with_origin(
                sh("exit 0", session("legacy")),
                Some(JobOrigin {
                    session_id: "different-origin".into(),
                    child_run_id: None,
                    dispatch_epoch: None,
                })
            )
            .await
            .is_err(),
            "explicit origin cannot reopen a retired owner"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_unconfirmed_retirement_fences_outstanding_handles() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let job = sup
            .spawn(sh("exec sleep 60", session("uncertain")))
            .await
            .unwrap();
        let group = sup.process_groups.lock()[&job.id].clone();
        // Lose proof support while keeping a real, unreaped fixture leader.
        // Retirement itself is exercised independently of a successful reap.
        group.lock().retire();
        assert!(!group.lock().owned);
        group
            .lock()
            .signal_with(libc::SIGKILL, |_, _| panic!("retired identity signalled"));
        assert!(sup.kill_origin_session("uncertain").await.is_err());
        assert!(sup.process_groups.lock().is_empty());
        assert!(sup.origins.lock().is_empty());
    }

    #[cfg(unix)]
    fn sh(command: &str, owner: JobOwner) -> SpawnJobRequest {
        let mut env = BTreeMap::new();
        // Keep PATH so the child can find real binaries under `env_clear()`.
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        SpawnJobRequest {
            command: command.to_string(),
            program: "/bin/sh".to_string(),
            args: vec!["-c".into(), command.into()],
            cwd: std::env::temp_dir(),
            env,
            owner,
            windows_verbatim_arguments: false,
            label: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_windows_strategy_settles_lifecycle_without_process_group_proof() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new(dir.path().join("jobs.db")).unwrap());
        let sup = JobSupervisor::with_group_proof(store, dir.path().join("logs"), false);
        for _ in 0..(MAX_JOBS_PER_SESSION + 2) {
            let job = sup
                .spawn_with_origin(
                    sh("exit 0", session("windows")),
                    Some(JobOrigin {
                        session_id: "windows".into(),
                        child_run_id: None,
                        dispatch_epoch: None,
                    }),
                )
                .await
                .unwrap();
            assert_eq!(await_settled(&sup, &job.id).await.status, JobStatus::Exited);
            assert_eq!(sup.running_count(), 0);
            assert_eq!(sup.process_group_running(&job.id), None);
            assert!(sup.kill(&job.id, None).await.unwrap().status.is_terminal());
        }
        assert!(sup.process_groups.lock().is_empty());
        assert!(sup
            .list_by_origin_session("windows")
            .unwrap()
            .iter()
            .all(|job| job.status == JobStatus::Exited));
        assert!(sup.kill_origin_session("windows").await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_proof_origin_disposal_reaps_groups_after_leader_exit_and_pipe_drain() {
        for command in [
            "sleep 60 & exit 0",
            "sleep 60 </dev/null >/dev/null 2>&1 & exit 0",
        ] {
            let dir = TempDir::new().unwrap();
            let sup = supervisor(&dir);
            let job = sup
                .spawn_with_origin(
                    sh(command, JobOwner::App),
                    Some(JobOrigin {
                        session_id: "origin".into(),
                        child_run_id: Some("child".into()),
                        dispatch_epoch: Some(1),
                    }),
                )
                .await
                .unwrap();
            assert_eq!(await_settled(&sup, &job.id).await.status, JobStatus::Exited);
            assert_eq!(sup.process_group_running(&job.id), Some(true));
            assert_eq!(sup.running_count(), 0);
            if command.contains("/dev/null") {
                await_live_dropped(&sup, &job.id).await;
                assert_eq!(sup.process_group_running(&job.id), Some(true));
            }
            assert_eq!(
                sup.kill_origin_session("origin").await.unwrap(),
                vec![job.id.clone()]
            );
            assert_eq!(sup.process_group_running(&job.id), Some(false));
            assert_eq!(sup.running_count(), 0);
        }
    }

    /// Lifetime promotion never changes which session must dispose the job.
    #[cfg(unix)]
    #[tokio::test]
    async fn origin_disposal_reaps_promoted_jobs_without_reaching_other_sessions() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let detached = sup
            .spawn_with_origin(
                sh("sleep 60", JobOwner::App),
                Some(JobOrigin {
                    session_id: "origin".into(),
                    child_run_id: Some("child".into()),
                    dispatch_epoch: Some(3),
                }),
            )
            .await
            .unwrap();
        let sibling = sup
            .spawn_with_origin(
                sh("sleep 60", JobOwner::App),
                Some(JobOrigin {
                    session_id: "sibling".into(),
                    child_run_id: None,
                    dispatch_epoch: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            sup.list_by_origin_session("origin").unwrap()[0].status,
            JobStatus::Running
        );
        assert_eq!(
            sup.kill_origin_session("origin").await.unwrap(),
            vec![detached.id.clone()]
        );
        assert_eq!(
            await_settled(&sup, &detached.id).await.status,
            JobStatus::Killed
        );
        assert!(sup
            .list_by_origin_session("origin")
            .unwrap()
            .iter()
            .all(|job| job.status.is_terminal()));
        assert_eq!(
            sup.get(&sibling.id).unwrap().unwrap().status,
            JobStatus::Running
        );
        sup.kill_origin_session("sibling").await.unwrap();
        await_settled(&sup, &sibling.id).await;
    }

    #[tokio::test]
    async fn stop_proof_lost_origin_process_ownership_never_proves_stop() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        let record: JobRecord = serde_json::from_value(serde_json::json!({
            "id": "lost", "command": "work", "cwd": "/", "owner": { "kind": "app" },
            "status": "interrupted", "pid": null, "exitCode": null, "startedAtMs": 1,
            "endedAtMs": 2, "totalOutputBytes": 0, "droppedOutputBytes": 0, "label": null
        }))
        .unwrap();
        store
            .insert_with_origin(
                &record,
                Some(&JobOrigin {
                    session_id: "origin".into(),
                    child_run_id: None,
                    dispatch_epoch: None,
                }),
            )
            .unwrap();
        let sup = JobSupervisor::new(store, dir.path().join("logs"));
        assert_eq!(
            sup.list_by_origin_session("origin").unwrap()[0].status,
            JobStatus::Interrupted
        );
        assert!(sup.kill_origin_session("origin").await.is_err());
        assert!(sup.list_by_origin_session("other").unwrap().is_empty());
    }

    /// Poll the store until the job settles or the budget runs out.
    async fn await_settled(sup: &JobSupervisor, id: &str) -> JobRecord {
        for _ in 0..200 {
            let rec = sup.get(id).unwrap().unwrap();
            if rec.status.is_terminal() {
                return rec;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("job {id} did not settle in time");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_preserves_workspace_port_env_received_over_rpc() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let mut request = serde_json::to_value(sh(
            "printf '%s/%s/%s' \"$COGNIA_PORT\" \"$COGNIA_PORT_COUNT\" \"$PORT\"",
            session("ports"),
        ))
        .unwrap();
        request["env"]["COGNIA_PORT"] = serde_json::json!("41020");
        request["env"]["COGNIA_PORT_COUNT"] = serde_json::json!("10");
        request["env"]["PORT"] = serde_json::json!("41020");
        let rec = sup
            .spawn(serde_json::from_value(request).unwrap())
            .await
            .unwrap();
        assert_eq!(await_settled(&sup, &rec.id).await.exit_code, Some(0));
        assert_eq!(sup.read(&rec.id, 0, 4096).unwrap().data, "41020/10/41020");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_captures_output_and_records_the_real_exit_code() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo hello; exit 3", session("s1")))
            .await
            .unwrap();
        assert_eq!(rec.status, JobStatus::Running);

        let settled = await_settled(&sup, &rec.id).await;
        assert_eq!(settled.status, JobStatus::Exited);
        assert_eq!(
            settled.exit_code,
            Some(3),
            "real exit code, not a PTY guess"
        );

        let slice = sup.read(&rec.id, 0, 4096).unwrap();
        assert!(slice.data.contains("hello"), "got {:?}", slice.data);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn running_count_follows_jobs_until_they_settle() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        assert_eq!(sup.running_count(), 0);
        let rec = sup.spawn(sh("sleep 0.3", session("s1"))).await.unwrap();
        assert_eq!(sup.running_count(), 1);
        await_settled(&sup, &rec.id).await;
        assert_eq!(sup.running_count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_is_captured_alongside_stdout() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo out; echo err 1>&2", session("s1")))
            .await
            .unwrap();
        await_settled(&sup, &rec.id).await;
        let data = sup.read(&rec.id, 0, 4096).unwrap().data;
        assert!(data.contains("out"), "got {data:?}");
        assert!(data.contains("err"), "got {data:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_reaps_the_whole_process_group_not_just_the_wrapper_shell() {
        // THE regression test for the orphan-grandchild defect. The wrapper
        // `sh` spawns a grandchild `sleep` and exits its own foreground; a
        // plain `child.kill()` would leave the `sleep` running. Killing the
        // process group must reap it.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let marker = dir.path().join("grandchild.pid");
        let cmd = format!(
            "sh -c 'echo $$ > {} ; sleep 60' & wait",
            marker.to_string_lossy()
        );
        let rec = sup.spawn(sh(&cmd, session("s1"))).await.unwrap();

        // Wait for the grandchild to announce its pid.
        let mut grandchild_pid = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    grandchild_pid = Some(pid);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let grandchild_pid = grandchild_pid.expect("grandchild should have written its pid");
        // Sanity: it is alive right now.
        assert_eq!(unsafe { libc::kill(grandchild_pid, 0) }, 0);

        sup.kill(&rec.id, None).await.unwrap();
        await_settled(&sup, &rec.id).await;

        // Give the group kill a beat to land, then assert the grandchild is gone.
        let mut reaped = false;
        for _ in 0..80 {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            reaped,
            "grandchild {grandchild_pid} survived the kill — process group was not reaped"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_marks_the_job_killed_and_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();

        sup.kill(&rec.id, None).await.unwrap();
        let settled = await_settled(&sup, &rec.id).await;
        assert_eq!(settled.status, JobStatus::Killed);

        // Second kill on an already-terminal job is a no-op, not an error.
        let again = sup.kill(&rec.id, None).await.unwrap();
        assert_eq!(again.status, JobStatus::Killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_agent_cannot_kill_another_sessions_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("owner"))).await.unwrap();

        let err = sup.kill(&rec.id, Some(&session("intruder"))).await;
        assert!(matches!(err, Err(JobError::Forbidden(_))));
        // Still running — the rejection did not partially act.
        assert_eq!(
            sup.get(&rec.id).unwrap().unwrap().status,
            JobStatus::Running
        );

        // The owner may, and so may the UI (requester = None).
        sup.kill(&rec.id, Some(&session("owner"))).await.unwrap();
        await_settled(&sup, &rec.id).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_on_an_unknown_id_is_not_found() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        assert!(matches!(
            sup.kill("nope", None).await,
            Err(JobError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn per_session_cap_rejects_the_ninth_concurrent_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let owner = session("s1");
        let mut ids = Vec::new();
        for _ in 0..MAX_JOBS_PER_SESSION {
            ids.push(sup.spawn(sh("sleep 30", owner.clone())).await.unwrap().id);
        }
        let err = sup.spawn(sh("sleep 30", owner.clone())).await;
        assert!(
            matches!(err, Err(JobError::LimitReached(_))),
            "expected the per-session cap to reject, got {err:?}"
        );

        // Another session is unaffected — the cap is per owner, not global-only.
        sup.spawn(sh("sleep 30", session("s2"))).await.unwrap();

        for id in ids {
            let _ = sup.kill(&id, None).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_returns_as_soon_as_bytes_land() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("sleep 0.2; echo late-arrival", session("s1")))
            .await
            .unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            slice.data.contains("late-arrival"),
            "long-poll should have woken on the write, got {:?}",
            slice.data
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_returns_on_exit_even_with_no_output() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("sleep 0.1; exit 0", session("s1")))
            .await
            .unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(slice.status.is_terminal());
        assert_eq!(slice.data, "");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_output_times_out_without_consuming_anything() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();

        let slice = sup
            .wait_for_output(&rec.id, 0, 4096, Duration::from_millis(150))
            .await
            .unwrap();
        assert_eq!(slice.data, "");
        assert_eq!(
            slice.next_offset, 0,
            "a timeout must not advance the offset"
        );
        let _ = sup.kill(&rec.id, None).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_survives_the_live_state_being_dropped() {
        // After settle, reads fall back to the on-disk log. This is what makes
        // "what did last night's build print?" answerable across a restart.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh("echo durable-line", session("s1")))
            .await
            .unwrap();
        await_settled(&sup, &rec.id).await;

        sup.live.lock().remove(&rec.id);
        let slice = sup.read(&rec.id, 0, 4096).unwrap();
        assert!(slice.data.contains("durable-line"), "got {:?}", slice.data);
    }

    /// Poll until the waiter has drained the pumps and dropped the live entry.
    async fn await_live_dropped(sup: &JobSupervisor, id: &str) {
        for _ in 0..200 {
            if !sup.live.lock().contains_key(id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("live state for job {id} was never dropped");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finished_jobs_release_their_live_state_without_losing_late_bytes() {
        // Leak regression: the live map used to keep every finished job's ring
        // buffer for the process lifetime. A backgrounded grandchild holds the
        // pipes past the wrapper's exit and writes after the row has settled;
        // those bytes must survive the live entry being dropped.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup
            .spawn(sh(
                "echo first; (sleep 0.3; echo grandchild-tail) & printf last-before-exit",
                session("s1"),
            ))
            .await
            .unwrap();

        let settled = await_settled(&sup, &rec.id).await;
        assert_eq!(settled.status, JobStatus::Exited);
        // Settled but the grandchild still holds the pipes: not yet drained.
        assert!(
            sup.live.lock().contains_key(&rec.id),
            "live state must outlive settle while the pumps are still open"
        );

        await_live_dropped(&sup, &rec.id).await;
        assert!(sup.live.lock().is_empty(), "no finished job may stay live");

        let slice = sup.read(&rec.id, 0, 4096).unwrap();
        for needle in ["first", "last-before-exit", "grandchild-tail"] {
            assert!(
                slice.data.contains(needle),
                "missing {needle:?} in {:?}",
                slice.data
            );
        }
        assert!(slice.status.is_terminal());
        let after = sup.get(&rec.id).unwrap().unwrap();
        assert_eq!(
            after.total_output_bytes, slice.next_offset,
            "counters are refreshed after the drain, not frozen at settle"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_listeners_fire_once_with_the_terminal_verdict() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen: Arc<Mutex<Vec<JobExit>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        sup.on_exit(Arc::new(move |exit| sink.lock().push(exit)));

        let rec = sup.spawn(sh("exit 7", session("s1"))).await.unwrap();
        await_settled(&sup, &rec.id).await;
        // The listener runs after settle; give the task a beat to land.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let events = seen.lock().clone();
        assert_eq!(events.len(), 1, "exactly one exit event per job");
        assert_eq!(events[0].job_id, rec.id);
        assert_eq!(events[0].exit_code, Some(7));
        assert_eq!(events[0].status, JobStatus::Exited);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_owned_by_reaps_one_session_and_leaves_others_alone() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let doomed = sup.spawn(sh("sleep 30", session("doomed"))).await.unwrap();
        let spared = sup.spawn(sh("sleep 30", session("spared"))).await.unwrap();

        let killed = sup.kill_owned_by(&session("doomed")).await.unwrap();
        assert_eq!(killed, vec![doomed.id.clone()]);
        await_settled(&sup, &doomed.id).await;
        assert_eq!(
            sup.get(&spared.id).unwrap().unwrap().status,
            JobStatus::Running
        );
        let _ = sup.kill(&spared.id, None).await;
    }

    #[tokio::test]
    async fn reconcile_on_boot_clears_ghost_rows_before_the_caps_count_them() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(JobStore::new_in_memory().unwrap());
        // Simulate a previous lifetime that died with a job still running.
        store
            .insert(&JobRecord {
                id: "ghost".into(),
                command: "sleep 999".into(),
                cwd: "/tmp".into(),
                owner: session("old"),
                status: JobStatus::Running,
                exit_code: None,
                pid: Some(999_999),
                started_at_ms: 1,
                ended_at_ms: None,
                total_output_bytes: 0,
                dropped_output_bytes: 0,
                label: None,
            })
            .unwrap();

        let sup = JobSupervisor::new(Arc::clone(&store), dir.path().join("logs"));
        let ids = sup.reconcile_on_boot().unwrap();
        assert_eq!(ids, vec!["ghost".to_string()]);
        assert_eq!(
            store.get("ghost").unwrap().unwrap().status,
            JobStatus::Interrupted
        );
        assert_eq!(store.count_running(None).unwrap(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_reaps_the_owning_job() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("s1"))).await.unwrap();
        let pid = rec.pid.expect("spawned job has a pid");

        let killed = sup.kill_by_pid(pid, None).await.unwrap();
        assert_eq!(killed.map(|r| r.id), Some(rec.id.clone()));
        assert_eq!(await_settled(&sup, &rec.id).await.status, JobStatus::Killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_returns_none_for_a_pid_we_do_not_own() {
        // The caller must be able to tell "not ours" from "failed", so it can
        // fall back to a plain signal instead of refusing to act.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        assert!(sup.kill_by_pid(999_999, None).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_does_not_resolve_a_recycled_pid_to_a_finished_job() {
        // Terminal rows clear their pid; if they did not, an unrelated process
        // that later reused the number could be matched to a dead job.
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("exit 0", session("s1"))).await.unwrap();
        let pid = rec.pid.expect("spawned job has a pid");
        await_settled(&sup, &rec.id).await;

        assert!(sup.kill_by_pid(pid, None).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_by_pid_still_honours_owner_scoping() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let rec = sup.spawn(sh("sleep 30", session("owner"))).await.unwrap();
        let pid = rec.pid.unwrap();

        assert!(matches!(
            sup.kill_by_pid(pid, Some(&session("intruder"))).await,
            Err(JobError::Forbidden(_))
        ));
        let _ = sup.kill(&rec.id, None).await;
    }

    #[test]
    fn owner_matching_is_exact_across_kinds_and_ids() {
        assert!(owner_matches(&session("a"), &session("a")));
        assert!(!owner_matches(&session("a"), &session("b")));
        assert!(!owner_matches(&session("a"), &JobOwner::App));
        assert!(!owner_matches(
            &JobOwner::ScheduledTask {
                task_id: "t".into()
            },
            &session("t")
        ));
        assert!(owner_matches(&JobOwner::App, &JobOwner::App));
    }

    #[cfg(unix)]
    fn delivered(session_id: &str, notify: crate::types::JobNotify) -> JobDelivery {
        JobDelivery {
            session_id: session_id.into(),
            run_id: Some(format!("execution:agent:{session_id}")),
            notify,
            stopped_by: None,
            claimed_by: None,
        }
    }

    #[cfg(unix)]
    fn origin_of(session_id: &str) -> JobOrigin {
        JobOrigin {
            session_id: session_id.into(),
            child_run_id: None,
            dispatch_epoch: None,
        }
    }

    #[cfg(unix)]
    fn exits(sup: &JobSupervisor) -> Arc<Mutex<Vec<JobExit>>> {
        let seen: Arc<Mutex<Vec<JobExit>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        sup.on_exit(Arc::new(move |exit| sink.lock().push(exit)));
        seen
    }

    #[cfg(unix)]
    async fn await_exit(seen: &Arc<Mutex<Vec<JobExit>>>, id: &str) -> JobExit {
        for _ in 0..200 {
            if let Some(exit) = seen.lock().iter().find(|exit| exit.job_id == id) {
                return exit.clone();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("no exit event for job {id}");
    }

    /// ADR-0249: a fast job can exit before its start returns; its exit event
    /// still carries the session and run it reports into, and its output.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_agent_started_job_reports_its_contract_and_tail_on_exit() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen = exits(&sup);
        let rec = sup
            .spawn_attributed(
                sh("echo first; echo done; exit 3", session("s1")),
                Some(origin_of("s1")),
                Some(delivered("s1", crate::types::JobNotify::OnExit)),
            )
            .await
            .unwrap();
        let exit = await_exit(&seen, &rec.id).await;
        assert_eq!(exit.exit_code, Some(3));
        assert_eq!(exit.command, "echo first; echo done; exit 3");
        assert_eq!(exit.started_at_ms, rec.started_at_ms);
        assert!(exit.output_tail.as_deref().unwrap_or("").contains("done"));
        assert_eq!(
            exit.delivery,
            Some(delivered("s1", crate::types::JobNotify::OnExit))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_job_without_a_delivery_contract_carries_no_tail() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen = exits(&sup);
        let rec = sup.spawn(sh("echo quiet", session("s1"))).await.unwrap();
        let exit = await_exit(&seen, &rec.id).await;
        assert!(exit.delivery.is_none());
        assert!(exit.output_tail.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_delivery_must_name_the_session_it_reports_into() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let refused = sup
            .spawn_attributed(
                sh("true", session("executor-1")),
                Some(origin_of("executor-1")),
                Some(delivered(" ", crate::types::JobNotify::OnExit)),
            )
            .await;
        assert!(refused.is_err());
        assert!(sup.list(None).unwrap().is_empty(), "nothing was started");
    }

    /// `kill_shell` is the agent stopping its own job: it must not wake it.
    /// A person's stop from the Job Center is reported.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stop_records_whether_the_agent_or_a_person_asked() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen = exits(&sup);
        let mut ids = Vec::new();
        for _ in 0..2 {
            ids.push(
                sup.spawn_attributed(
                    sh("sleep 30", session("s1")),
                    Some(origin_of("s1")),
                    Some(delivered("s1", crate::types::JobNotify::OnExit)),
                )
                .await
                .unwrap()
                .id,
            );
        }
        sup.kill(&ids[0], Some(&session("s1"))).await.unwrap();
        sup.kill(&ids[1], None).await.unwrap();
        let by_agent = await_exit(&seen, &ids[0]).await;
        let by_person = await_exit(&seen, &ids[1]).await;
        assert_eq!(by_agent.status, JobStatus::Killed);
        assert_eq!(
            by_agent.delivery.and_then(|delivery| delivery.stopped_by),
            Some(JobStopCause::Agent)
        );
        assert_eq!(
            by_person.delivery.and_then(|delivery| delivery.stopped_by),
            Some(JobStopCause::Person)
        );
    }

    /// Reconciliation reads what the events reported, from the store.
    #[cfg(unix)]
    #[tokio::test]
    async fn settlements_list_ended_agent_jobs_for_a_session() {
        let dir = TempDir::new().unwrap();
        let sup = supervisor(&dir);
        let seen = exits(&sup);
        let ended = sup
            .spawn_attributed(
                sh("echo reconciled", session("s1")),
                Some(origin_of("s1")),
                Some(delivered("s1", crate::types::JobNotify::None)),
            )
            .await
            .unwrap();
        let running = sup
            .spawn_attributed(
                sh("sleep 30", session("s1")),
                Some(origin_of("s1")),
                Some(delivered("s1", crate::types::JobNotify::OnExit)),
            )
            .await
            .unwrap();
        let other = sup
            .spawn_attributed(
                sh("true", session("s2")),
                Some(origin_of("s2")),
                Some(delivered("s2", crate::types::JobNotify::OnExit)),
            )
            .await
            .unwrap();
        let plain = sup.spawn(sh("true", session("s1"))).await.unwrap();
        for id in [&ended.id, &other.id, &plain.id] {
            await_exit(&seen, id).await;
        }

        let rows = sup.settlements(Some("s1"), None).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row.job_id.as_str())
                .collect::<Vec<_>>(),
            vec![ended.id.as_str()],
            "only ended, agent-started jobs of the session"
        );
        assert!(rows[0]
            .output_tail
            .as_deref()
            .unwrap_or("")
            .contains("reconciled"));
        assert_eq!(
            rows[0].delivery.as_ref().map(|delivery| delivery.notify),
            Some(crate::types::JobNotify::None)
        );
        assert_eq!(sup.settlements(None, None).unwrap().len(), 2);
        assert!(sup
            .settlements(Some("s1"), Some(rows[0].ended_at_ms + 1))
            .unwrap()
            .is_empty());
        let _ = sup.kill(&running.id, None).await;
    }
}
