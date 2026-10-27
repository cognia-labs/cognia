//! `VirtualDisplayController` — owns the virtual-display lifecycle on one
//! dedicated OS thread.
//!
//! Why a dedicated thread (mirrors `worker.rs`): the parsec-vdd device
//! `HANDLE` and the `SetThreadExecutionState` keepalive are thread-affine, and
//! the driver must be pinged on a steady ~100 ms cadence. A single
//! `recv_timeout` loop owns the driver, services `Arm`/`Release`/`Shutdown`
//! messages, pings while acquired, and auto-releases after an idle window — no
//! separate timer thread, so no stale-release race (the keepalive-generation
//! debounce from the design is subsumed by doing the idle check inline).
//!
//! The [`VddDriver`] is injectable, so this whole state machine is unit-tested
//! cross-platform against a mock; the real Windows driver is built by
//! [`super::build_driver`] on this thread.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::{ArmOutcome, ReleaseReason, VddDriver};
use crate::automation::audit::{AuditEntry, AuditRing, Decision};
use crate::automation::host::{self, AppHandle};
use crate::automation::permission::Surface;

/// Default idle window before an unused virtual display is torn down. Long
/// enough to span slow model round-trips and human-away gaps without churning
/// the driver (each create/destroy reshuffles windows).
pub const DEFAULT_IDLE: Duration = Duration::from_secs(300);
/// parsec-vdd unplugs added displays ~1 s after the last ping; 100 ms keeps a
/// comfortable margin.
pub const PING_INTERVAL: Duration = Duration::from_millis(100);
/// How long `arm()` waits for the controller thread to acquire (or fail).
const ARM_TIMEOUT: Duration = Duration::from_secs(10);

enum Msg {
    Arm {
        reply: mpsc::Sender<ArmOutcome>,
        probe_owner: Option<u64>,
    },
    ReleaseLease {
        owner: u64,
    },
    Release {
        reason: ReleaseReason,
    },
}

/// Cheap, lock-protected view of the controller used by health/status reads
/// from other threads (the device itself stays owned by the controller thread).
#[derive(Debug, Default, Clone)]
pub struct Status {
    pub active: bool,
    pub active_monitor: Option<String>,
    pub last_error: Option<String>,
    probe_owner: Option<u64>,
}

#[derive(Clone)]
pub struct VirtualDisplayController {
    tx: mpsc::Sender<Msg>,
    status: Arc<Mutex<Status>>,
    _thread: Arc<ThreadJoiner>,
}

static NEXT_LEASE: AtomicU64 = AtomicU64::new(1);

/// A settings probe owns an exclusive lease. Dropping it releases only the
/// generation it acquired, never a display that another action has since armed.
pub struct ProbeLease {
    controller: VirtualDisplayController,
    owner: u64,
    pub monitor: String,
}
impl ProbeLease {
    pub fn is_current(&self) -> bool {
        let status = self.controller.status.lock();
        status.active && status.probe_owner == Some(self.owner)
    }
}

impl Drop for ProbeLease {
    fn drop(&mut self) {
        let _ = self
            .controller
            .tx
            .send(Msg::ReleaseLease { owner: self.owner });
    }
}

struct ThreadJoiner(Option<JoinHandle<()>>);

impl Drop for ThreadJoiner {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            let _ = h.join();
        }
    }
}

impl VirtualDisplayController {
    /// Spawn with production defaults. `builder` runs on the controller thread
    /// (so the driver may be `!Send`); `audit`/`app` enable `automation:event`
    /// emission (pass `None` in tests).
    pub fn spawn<F>(builder: F, audit: Option<AuditRing>, app: Option<AppHandle>) -> Self
    where
        F: Fn() -> Box<dyn VddDriver> + Send + 'static,
    {
        Self::spawn_with_config(builder, DEFAULT_IDLE, PING_INTERVAL, audit, app)
    }

    /// Test/explicit constructor — lets unit tests inject a short idle window
    /// and fast ping cadence.
    pub fn spawn_with_config<F>(
        builder: F,
        idle_after: Duration,
        ping_interval: Duration,
        audit: Option<AuditRing>,
        app: Option<AppHandle>,
    ) -> Self
    where
        F: Fn() -> Box<dyn VddDriver> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Msg>();
        let status = Arc::new(Mutex::new(Status::default()));
        let status_thread = status.clone();
        let thread = thread::Builder::new()
            .name("virtual-display".into())
            .spawn(move || {
                let driver = builder();
                run(
                    rx,
                    status_thread,
                    driver,
                    idle_after,
                    ping_interval,
                    audit,
                    app,
                );
            })
            .expect("spawn virtual-display thread");
        Self {
            tx,
            status,
            _thread: Arc::new(ThreadJoiner(Some(thread))),
        }
    }

    /// Ensure a virtual display is active for the current screen-off turn. If
    /// one already exists, re-arms the idle timer; otherwise acquires one. On a
    /// missing/unsupported driver returns [`ArmOutcome::Unavailable`] so the
    /// caller can fail strictly instead of capturing a black screen.
    ///
    /// Blocks briefly on the controller thread's reply — call from a blocking
    /// context (Tauri commands use `spawn_blocking`).
    pub fn arm(&self) -> ArmOutcome {
        self.arm_owned(None)
    }

    pub fn acquire_probe(&self) -> Result<ProbeLease, String> {
        let owner = NEXT_LEASE.fetch_add(1, Ordering::Relaxed);
        match self.arm_owned(Some(owner)) {
            ArmOutcome::Acquired { monitor } => Ok(ProbeLease {
                controller: self.clone(),
                owner,
                monitor,
            }),
            ArmOutcome::AlreadyActive => {
                Err("busy: another session owns the virtual display".into())
            }
            ArmOutcome::Unavailable(error) => Err(error),
        }
    }

    fn arm_owned(&self, probe_owner: Option<u64>) -> ArmOutcome {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .tx
            .send(Msg::Arm {
                reply: reply_tx,
                probe_owner,
            })
            .is_err()
        {
            return ArmOutcome::Unavailable("virtual display controller stopped".into());
        }
        match reply_rx.recv_timeout(ARM_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => ArmOutcome::Unavailable("virtual display controller timed out".into()),
        }
    }

    /// Tear down the virtual display now (kill switch / session close / app
    /// teardown). Best-effort and non-blocking.
    pub fn force_release(&self, reason: ReleaseReason) {
        let _ = self.tx.send(Msg::Release { reason });
    }

    /// Current status (active flag, monitor label, last error) for the health
    /// probe / settings card.
    pub fn status(&self) -> Status {
        self.status.lock().clone()
    }

    pub fn is_active(&self) -> bool {
        self.status.lock().active
    }
}

fn set_active(status: &Arc<Mutex<Status>>, monitor: Option<String>, probe_owner: Option<u64>) {
    let mut g = status.lock();
    g.active = true;
    g.active_monitor = monitor;
    g.probe_owner = probe_owner;
    g.last_error = None;
}

fn set_inactive(status: &Arc<Mutex<Status>>, error: Option<String>) {
    let mut g = status.lock();
    g.active = false;
    g.active_monitor = None;
    g.probe_owner = None;
    if error.is_some() {
        g.last_error = error;
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    rx: mpsc::Receiver<Msg>,
    status: Arc<Mutex<Status>>,
    mut driver: Box<dyn VddDriver>,
    idle_after: Duration,
    ping_interval: Duration,
    audit: Option<AuditRing>,
    app: Option<AppHandle>,
) {
    let mut idle_deadline: Option<Instant> = None;
    let mut probe_lease: Option<u64> = None;
    loop {
        // Block indefinitely when idle; ping-cadence poll while a display is up.
        let wait = if driver.is_acquired() {
            ping_interval
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::ReleaseLease { owner }) => {
                if probe_lease == Some(owner) {
                    driver.release(ReleaseReason::Manual);
                    probe_lease = None;
                    idle_deadline = None;
                    set_inactive(&status, driver.release_error());
                }
            }
            Ok(Msg::Arm { reply, probe_owner }) => {
                if probe_lease.is_some() || (driver.is_acquired() && probe_owner.is_some()) {
                    let _ = reply.send(ArmOutcome::Unavailable(
                        "busy: another session owns the virtual display".into(),
                    ));
                    continue;
                }
                if driver.is_acquired() {
                    idle_deadline = Some(Instant::now() + idle_after);
                    let _ = reply.send(ArmOutcome::AlreadyActive);
                    continue;
                }
                let started = Instant::now();
                match driver.acquire() {
                    Ok(acq) => {
                        idle_deadline = Some(Instant::now() + idle_after);
                        set_active(&status, Some(acq.label.clone()), probe_owner);
                        emit(
                            &audit,
                            &app,
                            "vdd_enter",
                            Decision::Allow,
                            Some(format!("virtual display {} active", acq.label)),
                            None,
                            started.elapsed(),
                        );
                        probe_lease = probe_owner;
                        if reply
                            .send(ArmOutcome::Acquired { monitor: acq.label })
                            .is_err()
                        {
                            // A timed-out/cancelled arm must not create a late orphan.
                            driver.release(ReleaseReason::Manual);
                            probe_lease = None;
                            idle_deadline = None;
                            set_inactive(&status, driver.release_error());
                        }
                    }
                    Err(err) => {
                        let msg = err.to_string();
                        set_inactive(&status, Some(msg.clone()));
                        emit(
                            &audit,
                            &app,
                            "vdd_enter",
                            Decision::Deny,
                            Some("vdd_unavailable".into()),
                            Some(msg.clone()),
                            started.elapsed(),
                        );
                        let _ = reply.send(ArmOutcome::Unavailable(msg));
                    }
                }
            }
            Ok(Msg::Release { reason }) => {
                if driver.is_acquired() {
                    driver.release(reason);
                    idle_deadline = None;
                    set_inactive(&status, driver.release_error());
                    probe_lease = None;
                    emit(
                        &audit,
                        &app,
                        "vdd_release",
                        Decision::Allow,
                        Some(reason.as_reason().to_string()),
                        None,
                        Duration::ZERO,
                    );
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !driver.is_acquired() {
                    continue;
                }
                if let Err(err) = driver.ping() {
                    // Ping failed — the display is gone or the device closed.
                    // Tear down cleanly and surface the error.
                    let msg = err.to_string();
                    driver.release(ReleaseReason::DriverLost);
                    idle_deadline = None;
                    let msg = match driver.release_error() {
                        Some(restore) => format!("{msg}; {restore}"),
                        None => msg,
                    };
                    set_inactive(&status, Some(msg.clone()));
                    probe_lease = None;
                    emit(
                        &audit,
                        &app,
                        "vdd_release",
                        Decision::Deny,
                        Some("ping failed".into()),
                        Some(msg),
                        Duration::ZERO,
                    );
                    continue;
                }
                if let Some(dl) = idle_deadline {
                    if Instant::now() >= dl {
                        driver.release(ReleaseReason::Idle);
                        idle_deadline = None;
                        set_inactive(&status, driver.release_error());
                        probe_lease = None;
                        emit(
                            &audit,
                            &app,
                            "vdd_release",
                            Decision::Allow,
                            Some(ReleaseReason::Idle.as_reason().to_string()),
                            None,
                            Duration::ZERO,
                        );
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if driver.is_acquired() {
                    driver.release(ReleaseReason::Shutdown);
                }
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(
    audit: &Option<AuditRing>,
    app: &Option<AppHandle>,
    command: &str,
    decision: Decision,
    reason: Option<String>,
    error: Option<String>,
    duration: Duration,
) {
    let Some(ring) = audit else {
        return;
    };
    let entry = ring.record(AuditEntry {
        id: String::new(),
        ts: chrono::Utc::now().timestamp_millis(),
        surface: Surface::ComputerUse,
        plugin_id: Some("cognia-computer-use".into()),
        command: command.into(),
        process_name: None,
        window_title: None,
        decision,
        reason,
        duration_ms: duration.as_millis() as u64,
        error,
    });
    if let Some(handle) = app {
        let _ = host::emit(handle, "automation:event", &entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::virtual_display::{AcquiredDisplay, VddError};

    #[derive(Default)]
    pub(super) struct MockState {
        acquire_calls: u32,
        ping_calls: u32,
        pub(super) release_calls: u32,
        acquired: bool,
        fail_acquire: bool,
        fail_release: bool,
        fail_ping_after: Option<u32>,
        pub(super) last_release_reason: Option<ReleaseReason>,
    }

    #[derive(Clone)]
    pub(super) struct MockHandle(pub(super) Arc<Mutex<MockState>>);

    impl MockHandle {
        pub(super) fn new() -> Self {
            Self(Arc::new(Mutex::new(MockState::default())))
        }
        fn with_fail_acquire() -> Self {
            let h = Self::new();
            h.0.lock().fail_acquire = true;
            h
        }
        pub(super) fn driver(&self) -> Box<dyn VddDriver> {
            Box::new(MockDriver(self.0.clone()))
        }
    }

    struct MockDriver(Arc<Mutex<MockState>>);

    impl VddDriver for MockDriver {
        fn acquire(&mut self) -> Result<AcquiredDisplay, VddError> {
            let mut s = self.0.lock();
            s.acquire_calls += 1;
            if s.fail_acquire {
                return Err(VddError::Unavailable("mock unavailable".into()));
            }
            s.acquired = true;
            Ok(AcquiredDisplay {
                label: "\\\\.\\DISPLAY9".into(),
                width: 1920,
                height: 1080,
            })
        }
        fn ping(&mut self) -> Result<(), VddError> {
            let mut s = self.0.lock();
            s.ping_calls += 1;
            if let Some(after) = s.fail_ping_after {
                if s.ping_calls > after {
                    s.acquired = false;
                    return Err(VddError::Driver("mock ping lost".into()));
                }
            }
            Ok(())
        }
        fn release(&mut self, reason: ReleaseReason) {
            let mut s = self.0.lock();
            s.release_calls += 1;
            s.acquired = false;
            s.last_release_reason = Some(reason);
        }
        fn is_acquired(&self) -> bool {
            self.0.lock().acquired
        }
        fn release_error(&self) -> Option<String> {
            self.0
                .lock()
                .fail_release
                .then(|| "restore_failure: original display is missing".into())
        }
    }

    #[test]
    fn virtual_display_cleanup_failure_is_visible_after_manual_release() {
        let mock = MockHandle::new();
        let builder = mock.clone();
        let ctrl = VirtualDisplayController::spawn(move || builder.driver(), None, None);
        ctrl.arm();
        mock.0.lock().fail_release = true;
        ctrl.force_release(ReleaseReason::Manual);
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert!(ctrl
            .status()
            .last_error
            .unwrap()
            .starts_with("restore_failure:"));
    }

    #[test]
    fn virtual_display_abandoned_arm_rolls_back_instead_of_leaking() {
        let mock = MockHandle::new();
        let (tx, rx) = mpsc::channel();
        let (reply, abandoned) = mpsc::channel();
        drop(abandoned);
        tx.send(Msg::Arm {
            reply,
            probe_owner: Some(42),
        })
        .unwrap();
        drop(tx);
        run(
            rx,
            Arc::new(Mutex::new(Status::default())),
            mock.driver(),
            DEFAULT_IDLE,
            PING_INTERVAL,
            None,
            None,
        );
        assert_eq!(mock.0.lock().acquire_calls, 1);
        assert_eq!(mock.0.lock().release_calls, 1);
    }

    pub(super) fn wait_until(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if pred() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        pred()
    }

    #[test]
    fn arm_acquires_then_reports_already_active() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );

        let first = ctrl.arm();
        assert!(matches!(first, ArmOutcome::Acquired { .. }));
        assert!(ctrl.is_active());

        let second = ctrl.arm();
        assert!(matches!(second, ArmOutcome::AlreadyActive));
        // Only one acquire despite two arms.
        assert_eq!(mock.0.lock().acquire_calls, 1);

        ctrl.force_release(ReleaseReason::SessionClosed);
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert_eq!(
            mock.0.lock().last_release_reason,
            Some(ReleaseReason::SessionClosed)
        );
    }

    #[test]
    fn arm_reports_unavailable_when_driver_fails() {
        let mock = MockHandle::with_fail_acquire();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        let out = ctrl.arm();
        assert!(matches!(out, ArmOutcome::Unavailable(_)));
        assert!(!ctrl.is_active());
        assert!(ctrl.status().last_error.is_some());
    }

    #[test]
    fn pings_while_acquired() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(wait_until(
            || mock.0.lock().ping_calls >= 3,
            Duration::from_secs(1)
        ));
        ctrl.force_release(ReleaseReason::Manual);
    }

    #[test]
    fn auto_releases_after_idle_window() {
        let mock = MockHandle::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_millis(40), // short idle window
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(ctrl.is_active());
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        let s = mock.0.lock();
        assert!(s.release_calls >= 1);
        assert_eq!(s.last_release_reason, Some(ReleaseReason::Idle));
    }

    #[test]
    fn ping_failure_tears_down() {
        let mock = MockHandle::new();
        mock.0.lock().fail_ping_after = Some(2);
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            None,
            None,
        );
        ctrl.arm();
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert!(ctrl.status().last_error.is_some());
        assert_eq!(
            mock.0.lock().last_release_reason,
            Some(ReleaseReason::DriverLost)
        );
    }

    #[test]
    fn audit_ring_records_enter_and_release() {
        let mock = MockHandle::new();
        let ring = AuditRing::new();
        let builder = {
            let mock = mock.clone();
            move || mock.driver()
        };
        let ctrl = VirtualDisplayController::spawn_with_config(
            builder,
            Duration::from_secs(300),
            Duration::from_millis(10),
            Some(ring.clone()),
            None,
        );
        ctrl.arm();
        ctrl.force_release(ReleaseReason::KillSwitch);
        assert!(wait_until(
            || {
                let snap = ring.snapshot();
                snap.iter().any(|e| e.command == "vdd_enter")
                    && snap.iter().any(|e| e.command == "vdd_release")
            },
            Duration::from_secs(1)
        ));
    }
}

#[cfg(test)]
mod lease_tests {
    use super::tests::{wait_until, MockHandle};
    use super::*;
    #[test]
    fn virtual_display_probe_does_not_release_an_action_display() {
        let mock = MockHandle::new();
        let builder = mock.clone();
        let ctrl = VirtualDisplayController::spawn(move || builder.driver(), None, None);
        ctrl.arm();
        assert!(ctrl.acquire_probe().is_err());
        assert!(ctrl.is_active());
        assert_eq!(mock.0.lock().release_calls, 0);
        ctrl.force_release(ReleaseReason::Manual);
    }
    #[test]
    fn virtual_display_probe_lease_is_exclusive_and_generation_bound() {
        let mock = MockHandle::new();
        let builder = mock.clone();
        let ctrl = VirtualDisplayController::spawn(move || builder.driver(), None, None);
        let lease = ctrl.acquire_probe().unwrap();
        assert!(lease.is_current());
        assert!(matches!(ctrl.arm(), ArmOutcome::Unavailable(_)));
        ctrl.force_release(ReleaseReason::KillSwitch);
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert!(matches!(ctrl.arm(), ArmOutcome::Acquired { .. }));
        assert!(!lease.is_current());
        drop(lease);
        // FIFO barrier: the stale lease release is processed before this arm.
        assert_eq!(ctrl.arm(), ArmOutcome::AlreadyActive);
        assert!(ctrl.is_active());
        ctrl.force_release(ReleaseReason::Manual);
    }
    #[test]
    fn virtual_display_probe_releases_on_drop() {
        let mock = MockHandle::new();
        let builder = mock.clone();
        let ctrl = VirtualDisplayController::spawn(move || builder.driver(), None, None);
        drop(ctrl.acquire_probe().unwrap());
        assert!(wait_until(|| !ctrl.is_active(), Duration::from_secs(1)));
        assert_eq!(mock.0.lock().release_calls, 1);
    }
    #[test]
    fn virtual_display_shutdown_releases_and_joins() {
        let mock = MockHandle::new();
        let builder = mock.clone();
        let ctrl = VirtualDisplayController::spawn(move || builder.driver(), None, None);
        ctrl.arm();
        drop(ctrl);
        assert_eq!(
            mock.0.lock().last_release_reason,
            Some(ReleaseReason::Shutdown)
        );
    }
}
