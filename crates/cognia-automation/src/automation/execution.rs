//! Host-owned admission and cancellation, independent of the worker FIFO.
use super::types::{AutomationError, MouseButton, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Registry {
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
    held: Vec<HeldButton>,
    cleanup_active: bool,
    stopped: bool,
    quarantined: bool,
    active: usize,
    active_sessions: HashMap<String, usize>,
    queued: HashMap<String, usize>,
    epoch: u64,
    runs: HashMap<(String, String), Arc<Run>>,
}

impl Registry {
    fn invalidate_runs(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        for run in self.runs.values() {
            run.cancelled.store(true, Ordering::SeqCst);
        }
        self.runs.clear();
    }
    fn settled(&self, session: Option<&str>) -> bool {
        !self.quarantined
            && !self.cleanup_active
            && !self
                .held
                .iter()
                .any(|held| session.is_none_or(|session| held.session.as_deref() == Some(session)))
            && session.map_or(self.active == 0, |session| {
                self.active_sessions.get(session).copied().unwrap_or(0) == 0
            })
    }
}

struct HeldButton {
    button: MouseButton,
    epoch: u64,
    run: Option<std::sync::Weak<Run>>,
    session: Option<String>,
}

impl HeldButton {
    fn revoked(&self, state: &Registry) -> bool {
        state.stopped
            || state.quarantined
            || self.epoch != state.epoch
            || self.run.as_ref().is_some_and(|run| {
                run.upgrade()
                    .is_none_or(|run| run.cancelled.load(Ordering::SeqCst))
            })
    }
    fn belongs_to(&self, admission: &Admission) -> bool {
        self.epoch == admission.epoch
            && match (&self.run, &admission.run) {
                (Some(left), Some(right)) => left.ptr_eq(&Arc::downgrade(right)),
                (None, None) => true,
                _ => false,
            }
    }
}

fn notify(state: parking_lot::MutexGuard<'_, Registry>) {
    let wake = state.wake.clone();
    drop(state);
    if let Some(wake) = wake {
        wake();
    }
}

struct Run {
    owner: String,
    session: String,
    cancelled: AtomicBool,
}

#[derive(Clone, Default)]
pub struct ExecutionControl(Arc<Mutex<Registry>>);

#[derive(Clone)]
pub struct Admission {
    control: ExecutionControl,
    epoch: u64,
    run: Option<Arc<Run>>,
    deadline: Instant,
    read_only_probe: bool,
}

/// Delivery registration and its thread-local scope have the same lifetime.
pub(crate) struct DeliveryGuard {
    previous: Option<Admission>,
    control: ExecutionControl,
    session: Option<String>,
    _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Drop for DeliveryGuard {
    fn drop(&mut self) {
        let _ = DELIVERY_ADMISSION.with(|current| current.replace(self.previous.take()));
        let mut state = self.control.0.lock();
        state.active -= 1;
        if let Some(session) = &self.session {
            if let Some(count) = state.active_sessions.get_mut(session) {
                *count -= 1;
                if *count == 0 {
                    state.active_sessions.remove(session);
                }
            }
        }
        if state.stopped {
            notify(state);
        }
    }
}

pub(crate) struct QueueSlot {
    control: ExecutionControl,
    owner: String,
}

impl Drop for QueueSlot {
    fn drop(&mut self) {
        let mut state = self.control.0.lock();
        if let Some(count) = state.queued.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                state.queued.remove(&self.owner);
            }
        }
    }
}

impl std::fmt::Debug for Admission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Admission")
            .field("epoch", &self.epoch)
            .field("run_bound", &self.run.is_some())
            .finish_non_exhaustive()
    }
}

tokio::task_local! { static CALL_ADMISSION: Admission; }
thread_local! { static DELIVERY_ADMISSION: std::cell::RefCell<Option<Admission>> = const { std::cell::RefCell::new(None) }; }

impl ExecutionControl {
    pub(crate) fn with_enabled(enabled: bool) -> Self {
        Self(Arc::new(Mutex::new(Registry {
            stopped: !enabled,
            ..Registry::default()
        })))
    }

    pub(crate) fn settled_stop_epoch(&self) -> Option<u64> {
        let state = self.0.lock();
        (state.stopped && state.epoch != 0 && state.settled(None)).then_some(state.epoch)
    }
    pub(crate) fn set_waker(&self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.0.lock().wake = Some(wake);
    }

    pub(crate) fn cleanup_buttons(&self) -> Vec<MouseButton> {
        let mut state = self.0.lock();
        let mut buttons = Vec::new();
        let mut keep = Vec::new();
        for button in std::mem::take(&mut state.held) {
            if button.revoked(&state) {
                buttons.push(button.button);
            } else {
                keep.push(button);
            }
        }
        state.held = keep;
        state.cleanup_active = !buttons.is_empty();
        buttons
    }

    pub(crate) fn finish_cleanup(&self, success: bool) {
        let mut state = self.0.lock();
        state.cleanup_active = false;
        if !success {
            state.quarantined = true;
        }
    }
    pub fn quarantined(&self) -> bool {
        self.0.lock().quarantined
    }
    pub fn settled(&self, session: Option<&str>) -> bool {
        self.0.lock().settled(session)
    }
    pub fn stop(&self) -> u64 {
        let mut state = self.0.lock();
        state.stopped = true;
        state.invalidate_runs();
        let epoch = state.epoch;
        notify(state);
        epoch
    }

    pub fn resume(&self) {
        self.0.lock().stopped = false;
    }
    pub fn pending_run_epoch(&self) -> Option<u64> {
        let state = self.0.lock();
        (!state.stopped && !state.quarantined).then_some(state.epoch)
    }

    /// The Host captures the epoch before waiting to deliver a new sidecar run.
    pub fn begin_run_at(&self, epoch: u64, owner: String, session: String, turn: String) -> bool {
        let mut state = self.0.lock();
        if state.stopped
            || state.quarantined
            || state.epoch != epoch
            || state.runs.len() >= 65_536
            || state.runs.contains_key(&(session.clone(), turn.clone()))
        {
            return false;
        }
        let run_session = session.clone();
        state.runs.insert(
            (session, turn),
            Arc::new(Run {
                owner,
                session: run_session,
                cancelled: AtomicBool::new(false),
            }),
        );
        true
    }

    #[cfg(test)]
    pub(crate) fn begin_run(&self, owner: String, session: String, turn: String) {
        if let Some(epoch) = self.pending_run_epoch() {
            self.begin_run_at(epoch, owner, session, turn);
        }
    }

    pub fn revoke_run(&self, owner: &str) {
        let mut state = self.0.lock();
        state.runs.retain(|_, run| {
            if run.owner == owner {
                run.cancelled.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
        notify(state);
    }

    pub fn revoke_session(&self, session: &str) {
        let mut state = self.0.lock();
        state.runs.retain(|(id, _), run| {
            if id == session {
                run.cancelled.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
        notify(state);
    }

    pub fn revoke_all(&self) {
        let mut state = self.0.lock();
        state.invalidate_runs();
        notify(state);
    }

    pub fn admit(
        &self,
        session: Option<&str>,
        turn: Option<&str>,
        require_run: bool,
    ) -> Result<Admission> {
        let state = self.0.lock();
        if state.stopped || state.quarantined {
            return Err(refused());
        }
        let run = session
            .zip(turn)
            .and_then(|(session, turn)| state.runs.get(&(session.to_owned(), turn.to_owned())))
            .cloned();
        if require_run && run.is_none() {
            return Err(refused());
        }
        Ok(Admission {
            control: self.clone(),
            epoch: state.epoch,
            run,
            deadline: Instant::now() + Duration::from_secs(60),
            read_only_probe: false,
        })
    }

    pub fn admit_probe(&self) -> Result<Admission> {
        let state = self.0.lock();
        if state.quarantined {
            return Err(refused());
        }
        Ok(Admission {
            control: self.clone(),
            epoch: state.epoch,
            run: None,
            deadline: Instant::now() + Duration::from_secs(30),
            read_only_probe: true,
        })
    }

    pub fn capture(&self) -> Result<Admission> {
        match CALL_ADMISSION.try_with(Clone::clone) {
            Ok(admission) if Arc::ptr_eq(&admission.control.0, &self.0) => {
                admission.check()?;
                Ok(admission)
            }
            Ok(_) => Err(refused()),
            Err(_) => self.admit(None, None, false),
        }
    }
}

impl Admission {
    pub(crate) fn reserve_queue(&self) -> Result<QueueSlot> {
        self.check()?;
        let owner = self
            .run
            .as_ref()
            .map_or_else(|| "unbound".into(), |run| run.owner.clone());
        let mut state = self.control.0.lock();
        let count = state.queued.entry(owner.clone()).or_default();
        if *count >= 8 {
            return Err(AutomationError::PermissionDenied {
                reason: "automation run queue is full".into(),
            });
        }
        *count += 1;
        Ok(QueueSlot {
            control: self.control.clone(),
            owner,
        })
    }
    pub(crate) fn check_input(&self) -> Result<()> {
        self.check()?;
        let state = self.control.0.lock();
        if state.held.iter().any(|held| !held.belongs_to(self)) {
            return Err(refused());
        }
        Ok(())
    }

    pub(crate) fn button_delivered(&self, button: MouseButton, down: bool) {
        let mut state = self.control.0.lock();
        state.held.retain(|held| held.button != button);
        if down {
            state.held.push(HeldButton {
                button,
                epoch: self.epoch,
                run: self.run.as_ref().map(Arc::downgrade),
                session: self.run.as_ref().map(|run| run.session.clone()),
            });
        }
    }
    pub(crate) fn quarantine(&self) {
        let mut state = self.control.0.lock();
        state.quarantined = true;
        notify(state);
    }
    pub(crate) fn same_run(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.control.0, &other.control.0)
            && self.epoch == other.epoch
            && match (&self.run, &other.run) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
    }
    pub fn check(&self) -> Result<()> {
        let state = self.control.0.lock();
        self.check_state(&state)
    }

    fn check_state(&self, state: &Registry) -> Result<()> {
        if self.deadline <= Instant::now()
            || state.quarantined
            || (state.stopped && !self.read_only_probe)
            || state.epoch != self.epoch
            || self
                .run
                .as_ref()
                .is_some_and(|run| run.cancelled.load(Ordering::SeqCst))
        {
            return Err(refused());
        }
        Ok(())
    }

    /// Serialize process creation/registration against revocation.
    pub fn start<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let state = self.control.0.lock();
        self.check_state(&state)?;
        operation()
    }

    pub fn is_run_bound(&self) -> bool {
        self.run.is_some()
    }

    pub async fn scope<T>(&self, future: impl Future<Output = T>) -> T {
        CALL_ADMISSION.scope(self.clone(), future).await
    }

    pub(crate) fn enter_delivery(&self) -> Result<DeliveryGuard> {
        let session = self.run.as_ref().map(|run| run.session.clone());
        {
            let mut state = self.control.0.lock();
            // Revocation and active registration must be one atomic decision.
            self.check_state(&state)?;
            state.active += 1;
            if let Some(session) = &session {
                *state.active_sessions.entry(session.clone()).or_default() += 1;
            }
        }
        let previous = DELIVERY_ADMISSION.with(|current| current.replace(Some(self.clone())));
        Ok(DeliveryGuard {
            previous,
            control: self.control.clone(),
            session,
            _thread_bound: std::marker::PhantomData,
        })
    }

    #[cfg(test)]
    pub(crate) fn deliver<T>(&self, operation: impl FnOnce() -> T) -> T {
        let _delivery = self.enter_delivery().expect("live test delivery");
        operation()
    }
}

pub(crate) fn current() -> Result<Admission> {
    DELIVERY_ADMISSION
        .with(|current| current.borrow().clone())
        .ok_or_else(refused)
}

pub(crate) fn checkpoint() -> Result<()> {
    DELIVERY_ADMISSION.with(|current| {
        current
            .borrow()
            .as_ref()
            .map_or(Ok(()), Admission::check_input)
    })
}

fn refused() -> AutomationError {
    AutomationError::PermissionDenied {
        reason: "automation execution scope expired or was revoked".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_boot_does_not_admit_runs_or_emit_an_emergency_stop() {
        let control = ExecutionControl::with_enabled(false);
        assert!(control.pending_run_epoch().is_none());
        assert!(control.settled_stop_epoch().is_none());
        control.resume();
        assert!(control.pending_run_epoch().is_some());
    }
    #[test]
    fn revoked_delivery_cannot_register_after_settlement() {
        let control = ExecutionControl::default();
        let admission = control.admit(None, None, false).unwrap();
        control.stop();
        assert!(control.settled(None));
        assert!(admission.enter_delivery().is_err());
        assert!(control.settled(None));
    }

    #[test]
    fn an_active_read_only_probe_delays_global_settlement_until_its_owner_drops() {
        let control = ExecutionControl::default();
        let admission = control.admit_probe().unwrap();
        let delivery = admission.enter_delivery().unwrap();
        control.stop();
        assert!(!control.settled(None));
        drop(delivery);
        assert!(control.settled(None));
    }

    #[test]
    fn pending_run_before_stop_cannot_activate_after_resume() {
        let control = ExecutionControl::default();
        let old_epoch = control.pending_run_epoch().unwrap();
        control.stop();
        control.resume();
        assert!(!control.begin_run_at(old_epoch, "old".into(), "chat".into(), "turn".into()));
        assert!(control.admit(Some("chat"), Some("turn"), true).is_err());
        let epoch = control.pending_run_epoch().unwrap();
        assert!(control.begin_run_at(epoch, "new".into(), "chat".into(), "turn".into()));
    }
    #[test]
    fn revocation_invalidates_captured_permits_and_keeps_other_runs() {
        let control = ExecutionControl::default();
        control.begin_run("one".into(), "chat".into(), "a".into());
        control.begin_run("two".into(), "chat".into(), "b".into());
        let one = control.admit(Some("chat"), Some("a"), true).unwrap();
        let two = control.admit(Some("chat"), Some("b"), true).unwrap();
        control.revoke_run("one");
        assert!(one.check().is_err());
        assert!(two.check().is_ok());
        control.revoke_all();
        assert!(two.check().is_err());
    }

    #[test]
    fn held_input_cleanup_is_owned_and_must_be_acknowledged() {
        let control = ExecutionControl::default();
        control.begin_run("owner".into(), "chat".into(), "turn".into());
        let admission = control.admit(Some("chat"), Some("turn"), true).unwrap();
        admission.button_delivered(MouseButton::Left, true);
        control.revoke_run("owner");
        assert!(!control.settled(Some("chat")));
        assert_eq!(control.cleanup_buttons(), vec![MouseButton::Left]);
        assert!(!control.settled(Some("chat")));
        control.finish_cleanup(true);
        assert!(control.settled(Some("chat")));
        assert!(admission.check().is_err());
    }

    #[test]
    fn failed_cleanup_cannot_be_resumed_by_toggling_enabled() {
        let control = ExecutionControl::default();
        control.finish_cleanup(false);
        control.resume();
        assert!(!control.settled(None));
        assert!(control.admit(None, None, false).is_err());
    }

    #[test]
    fn one_run_cannot_fill_the_global_worker_queue() {
        let control = ExecutionControl::default();
        control.begin_run("first".into(), "chat".into(), "a".into());
        control.begin_run("second".into(), "chat".into(), "b".into());
        let first = control.admit(Some("chat"), Some("a"), true).unwrap();
        let second = control.admit(Some("chat"), Some("b"), true).unwrap();
        let mut queued: Vec<_> = (0..8).map(|_| first.reserve_queue().unwrap()).collect();
        assert!(first.reserve_queue().is_err());
        assert!(second.reserve_queue().is_ok());
        queued.pop();
        assert!(first.reserve_queue().is_ok());
    }
}
