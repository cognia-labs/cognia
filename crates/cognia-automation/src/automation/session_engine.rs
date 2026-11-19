//! Host selection and Native provenance, separate from vendor protocol code.
use super::{
    agent_desktop::{AgentDesktop, Delivery, ExecutorLease},
    backend::ActionTargetContext,
    engine_config::{self, EngineStatus, SessionEngineId},
    execution::Admission,
    session::{ActionTarget, PreparedAction, ResolvedApplication, UiAction, UiStateRevision},
    types::{AutomationError, ElementInfo, ElementRef, Result},
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn candidate_build_health(binary: Option<&Path>) -> &'static str {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "unsupportedPlatform"
    } else if binary.is_none_or(|path| !path.is_file())
        || option_env!("COGNIA_AGENT_DESKTOP_SHA256").is_none()
    {
        "missing"
    } else {
        "ready"
    }
}

pub struct EngineHost {
    boot_config_valid: bool,
    desktop: bool,
    effective: SessionEngineId,
    binary: Option<PathBuf>,
    lease: Option<Arc<ExecutorLease>>,
    health: Mutex<(String, Option<String>)>,
    candidate_health: Mutex<String>,
    probed: AtomicBool,
    execution: std::sync::OnceLock<super::execution::ExecutionControl>,
}

impl EngineHost {
    pub fn new(binary: Option<PathBuf>, desktop: bool) -> Self {
        let config = if desktop {
            engine_config::load()
        } else {
            Ok(Default::default())
        };
        let effective = config
            .as_ref()
            .map(|config| config.desired_engine)
            .unwrap_or_default();
        let lease = if desktop {
            ExecutorLease::acquire().map(Arc::new)
        } else {
            Err(AutomationError::UnsupportedPlatform)
        };
        let candidate_health = candidate_build_health(binary.as_deref());
        let health: (String, Option<String>) = if config.is_err() {
            ("configError".into(), Some("configError".into()))
        } else if desktop && lease.is_err() {
            ("recovering".into(), Some("executorLeaseHeld".into()))
        } else if effective == SessionEngineId::AgentDesktop && candidate_health != "ready" {
            (
                candidate_health.into(),
                Some(
                    if candidate_health == "missing" {
                        "binaryMissing"
                    } else {
                        "unsupportedPlatform"
                    }
                    .into(),
                ),
            )
        } else {
            ("ready".into(), None)
        };
        Self {
            boot_config_valid: config.is_ok(),
            desktop,
            effective,
            binary,
            lease: lease.ok(),
            health: Mutex::new(health),
            candidate_health: Mutex::new(candidate_health.into()),
            probed: AtomicBool::new(false),
            execution: Default::default(),
        }
    }

    pub fn attach_execution(&self, execution: super::execution::ExecutionControl) {
        let _ = self.execution.set(execution);
    }

    pub fn status(&self) -> std::result::Result<EngineStatus, String> {
        if self
            .execution
            .get()
            .is_some_and(|control| control.quarantined())
        {
            *self.health.lock() = ("quarantined".into(), Some("executorCleanupUnproven".into()));
            *self.candidate_health.lock() = "quarantined".into();
        }
        let snapshot = engine_config::snapshot();
        let config = snapshot.config;
        let (health, reason_code) = if snapshot.configuration_error {
            ("configError".into(), Some("configError".into()))
        } else {
            self.health.lock().clone()
        };
        let available = candidate_build_health(self.binary.as_deref()) == "ready";
        Ok(EngineStatus {
            config_generation: config.generation,
            configuration_error: snapshot.configuration_error,
            recovery_token: snapshot.recovery_token,
            agent_desktop_available: available,
            candidate_health: self.candidate_health.lock().clone(),
            revision: config.revision,
            desired_engine: config.desired_engine,
            effective_engine: self.effective,
            needs_restart: !self.boot_config_valid
                || config.desired_engine != self.effective
                || (self.desktop && self.lease.is_none())
                || health == "quarantined",
            health,
            reason_code,
            binary_version: self
                .probed
                .load(Ordering::SeqCst)
                .then(|| super::agent_desktop::VERSION.into()),
            profile: self
                .probed
                .load(Ordering::SeqCst)
                .then(|| super::agent_desktop::PROFILE.into()),
        })
    }

    pub fn probe(&self, admission: &Admission) -> std::result::Result<EngineStatus, String> {
        let outcome = self
            .candidate()
            .and_then(|candidate| candidate.probe(admission));
        let health: (String, Option<String>) = match outcome {
            Ok(()) => ("ready".into(), None),
            Err(AutomationError::PermissionDenied { .. }) => (
                "permissionRequired".into(),
                Some("accessibilityRequired".into()),
            ),
            Err(_) => ("incompatible".into(), Some("profileMismatch".into())),
        };
        self.probed.store(health.0 == "ready", Ordering::SeqCst);
        *self.candidate_health.lock() = health.0.clone();
        if self.effective == SessionEngineId::AgentDesktop {
            *self.health.lock() = health;
        }
        self.status()
    }

    fn candidate(&self) -> Result<AgentDesktop> {
        AgentDesktop::new(
            self.binary
                .clone()
                .ok_or(AutomationError::UnsupportedPlatform)?,
            self.lease
                .clone()
                .ok_or(AutomationError::UnsupportedPlatform)?,
        )
    }

    pub fn check(&self) -> Result<()> {
        if self.health.lock().0 != "ready" {
            return Err(AutomationError::PermissionDenied {
                reason: "selected session engine is unavailable; inspect engine settings".into(),
            });
        }
        Ok(())
    }

    fn check_native(&self) -> Result<()> {
        if self.desktop && self.lease.is_none() {
            return Err(AutomationError::PermissionDenied {
                reason: "automation executor lease is held; old execution has not settled".into(),
            });
        }
        Ok(())
    }
}

struct NativeBinding {
    admission: Admission,
    lineage: String,
    revision: u64,
    root: ElementInfo,
    input_focus: Option<ElementRef>,
}

pub(crate) struct SessionEngine {
    host: Arc<EngineHost>,
    candidate: Option<AgentDesktop>,
    native: HashMap<String, NativeBinding>,
}

impl SessionEngine {
    pub fn prune_revoked(&mut self) -> Vec<String> {
        let mut expired = self
            .candidate
            .as_mut()
            .map_or_else(Vec::new, AgentDesktop::prune_revoked);
        expired.extend(
            self.native
                .iter()
                .filter(|(_, binding)| binding.admission.check().is_err())
                .map(|(session, _)| session.clone()),
        );
        if expired.is_empty() {
            return expired;
        }
        expired.sort();
        expired.dedup();
        self.native.retain(|session, _| !expired.contains(session));
        expired
    }
    pub fn check_native(&self) -> Result<()> {
        self.host.check_native()
    }
    pub fn new(host: Arc<EngineHost>) -> Self {
        let candidate = if host.effective == SessionEngineId::AgentDesktop && host.check().is_ok() {
            match host.candidate() {
                Ok(candidate) => Some(candidate),
                Err(_) => {
                    *host.health.lock() = ("incompatible".into(), Some("profileMismatch".into()));
                    None
                }
            }
        } else {
            None
        };
        Self {
            host,
            candidate,
            native: HashMap::new(),
        }
    }
    pub fn uses_candidate(&self) -> bool {
        self.host.effective == SessionEngineId::AgentDesktop
    }
    pub fn check(&self) -> Result<()> {
        if self
            .candidate
            .as_ref()
            .is_some_and(AgentDesktop::is_quarantined)
        {
            *self.host.health.lock() =
                ("quarantined".into(), Some("executorCleanupUnproven".into()));
        }
        self.host.check()
    }
    pub fn observe(
        &mut self,
        session: &str,
        app: &ResolvedApplication,
        window: u64,
        depth: u32,
    ) -> Result<(Vec<ElementInfo>, bool)> {
        self.check()?;
        let result = self
            .candidate
            .as_mut()
            .ok_or(AutomationError::UnsupportedPlatform)?
            .snapshot(session, app, window, depth, &super::execution::current()?);
        if result.is_ok() {
            self.host.probed.store(true, Ordering::SeqCst);
        }
        result
    }
    pub fn record_native(
        &mut self,
        state: &UiStateRevision,
        mut root: ElementInfo,
        input_focus: Option<ElementRef>,
    ) -> Result<()> {
        root.children = None;
        self.native.insert(
            state.session_id.clone(),
            NativeBinding {
                admission: super::execution::current()?,
                lineage: state.lineage_id.clone(),
                revision: state.revision,
                root,
                input_focus,
            },
        );
        Ok(())
    }
    fn native_binding(&self, prepared: &PreparedAction) -> Result<&NativeBinding> {
        let binding = self
            .native
            .get(&prepared.state.session_id)
            .ok_or(AutomationError::StaleElement)?;
        if binding.lineage != prepared.state.lineage_id
            || binding.revision != prepared.state.revision
        {
            return Err(AutomationError::StaleElement);
        }
        Ok(binding)
    }

    pub fn native_target<'a>(
        &'a self,
        prepared: &'a PreparedAction,
        target: &ActionTarget,
    ) -> Result<ActionTargetContext<'a>> {
        let binding = self.native_binding(prepared)?;
        Ok(ActionTargetContext {
            app: &prepared.state.app,
            surface: &prepared.state.surface,
            root: &binding.root,
            element: None,
            input_focus: binding.input_focus.as_ref(),
            point: if matches!(target, ActionTarget::Pixel { .. }) {
                prepared.point
            } else {
                None
            },
        })
    }

    pub fn native_prepared(
        &self,
        mut prepared: PreparedAction,
        target: &ActionTarget,
    ) -> Result<PreparedAction> {
        let binding = self.native_binding(&prepared)?;
        prepared
            .state
            .tree
            .nodes
            .first_mut()
            .ok_or(AutomationError::StaleElement)?
            .element = binding.root.clone();
        prepared.element = None;
        prepared.input_focus = binding.input_focus.clone();
        if !matches!(target, ActionTarget::Pixel { .. }) {
            prepared.point = None;
        }
        Ok(prepared)
    }
    pub fn perform(
        &mut self,
        prepared: &PreparedAction,
        action: &UiAction,
    ) -> (Delivery, Option<&'static str>) {
        let Some(candidate) = self.candidate.as_mut() else {
            return (Delivery::NotDelivered, Some("engineUnavailable"));
        };
        if prepared.refetched_from_revision.is_some() {
            return (Delivery::NotDelivered, Some("staleEngineRevision"));
        }
        let Some(element) = &prepared.element else {
            return (Delivery::NotDelivered, Some("elementRequired"));
        };
        let Some(window) = prepared.state.surface.window_id else {
            return (Delivery::NotDelivered, Some("windowRequired"));
        };
        let Ok(admission) = super::execution::current() else {
            return (Delivery::NotDelivered, Some("scopeRequired"));
        };
        candidate.perform(
            &prepared.state.session_id,
            &element.element_ref,
            window,
            action,
            &admission,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_desktop_hosts_keep_native_and_cannot_construct_a_candidate() {
        let host = EngineHost::new(None, false);
        assert_eq!(host.effective, SessionEngineId::Native);
        assert!(host.candidate().is_err());
    }
}
