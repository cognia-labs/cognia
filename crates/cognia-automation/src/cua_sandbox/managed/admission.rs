//! Synchronous agent send projection. Publication and account/registry reads
//! happen in blocking transaction jobs, never in the command pump or hold tick.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct AgentAdmissionSnapshot {
    pub(super) desktops: BTreeMap<String, AgentDesktopAdmission>,
    pub(super) grants: Vec<delegation::ManagedDesktopDelegation>,
    pub(super) observed_at: i64,
}
pub(super) struct AgentDesktopAdmission {
    pub(super) generation: u64,
    pub(super) owner: String,
    pub(super) running: bool,
    pub(super) deadline: i64,
    pub(super) config: ManagedDesktopConfig,
    pub(super) template: TemplateIdentity,
    pub(super) agent_control: bool,
}

/// Activity is current in memory, but is checkpointed at most every 30 seconds.
pub(super) fn persisted_view(
    state: &ManagedDesktopJournal,
    activity: &BTreeMap<String, i64>,
    coalesce: bool,
) -> ManagedDesktopJournal {
    let mut state = state.clone();
    for (id, row) in &mut state.desktops {
        if let Some(previous) = activity.get(id) {
            if !coalesce || row.last_activity_at.saturating_sub(*previous) < 30_000 {
                row.last_activity_at = *previous;
            }
        }
    }
    state
}

pub(super) fn semantic_value(state: &ManagedDesktopJournal) -> serde_json::Value {
    let mut value = serde_json::to_value(state).expect("journal is serializable");
    value.as_object_mut().unwrap().remove("revision");
    value.as_object_mut().unwrap().remove("lastObservedAt");
    value
}

/// Only inputs read by WP4's effective_enablement invalidate its cache.
pub(super) fn enablement_inputs(state: &ManagedDesktopJournal) -> serde_json::Value {
    serde_json::json!({
        "templates": state.templates,
        "qualifications": state.qualifications,
        "lifecycle": state.lifecycle_diagnostics,
        "control": state.control_qualifications,
        "authority": state.authority_diagnostics,
        "workload": state.workload_diagnostics,
        "handoff": state.handoff_diagnostics,
        "boundaries": state.workload_boundaries,
        "smokeDesktops": state.desktops.iter().filter(|(_, row)| row.smoke)
            .map(|(id, row)| {
                let mut row = row.clone();
                row.last_activity_at = 0;
                (id, row)
            }).collect::<BTreeMap<_, _>>(),
    })
}

impl ManagedDesktopService {
    /// Caller holds the journal lock and runs on a blocking worker. Retaining
    /// the registry avoids rereading files for unrelated journal transactions.
    pub(super) fn publish_agent_admission(
        &self,
        state: &ManagedDesktopJournal,
        refresh: bool,
    ) -> Result<()> {
        let epoch = self
            .enablement_epoch
            .load(std::sync::atomic::Ordering::SeqCst);
        let mut cached = self.agent_registry.lock();
        if refresh || cached.as_ref().is_none_or(|(version, _)| *version != epoch) {
            match self.store.registry() {
                Ok(registry) => *cached = Some((epoch, registry)),
                Err(error) => {
                    *cached = None;
                    return Err(error);
                }
            }
        }
        let registry = &cached.as_ref().unwrap().1;
        let runtime = self.delegation_runtime.read().clone();
        if let Some(runtime) = &runtime {
            runtime.prepare(
                state
                    .desktops
                    .values()
                    .map(|r| r.config.owner_principal_id.as_str())
                    .chain(
                        state
                            .delegations
                            .values()
                            .filter(|g| g.state == delegation::ManagedDesktopDelegationState::Live)
                            .map(|g| g.owner_principal_id.as_str()),
                    ),
            );
        }
        let now = (self.clock)().max(state.last_observed_at);
        let desktops = state
            .desktops
            .iter()
            .map(|(id, row)| {
                let current = registry.providers.iter().find(|config| {
                    config.id == row.config.id
                        && config.owner_principal_id == row.config.owner_principal_id
                        && config.host_id == row.config.host_id
                });
                let enabled = current.is_some_and(|config| {
                    config.enabled
                        && self.trusted_release.as_ref() == Some(&config.release)
                        && config.binding_digest() == row.config.binding_digest()
                        && latest_template(state, &config.binding_digest())
                            .and_then(|t| t.identity.as_ref())
                            == Some(&row.template)
                        && qualification::effective_enablement(state, config, now).agent_control
                });
                (
                    id.clone(),
                    AgentDesktopAdmission {
                        generation: row.desktop.generation,
                        owner: row.config.owner_principal_id.clone(),
                        running: !row.delete_requested
                            && row.desktop.state == ManagedDesktopState::Running,
                        deadline: row.desktop.deadline_at.min(
                            row.last_activity_at
                                .saturating_add(row.desktop.idle_timeout_seconds as i64 * 1_000),
                        ),
                        config: current.unwrap_or(&row.config).clone(),
                        template: row.template.clone(),
                        agent_control: enabled,
                    },
                )
            })
            .collect();
        *self.agent_admission.write() = AgentAdmissionSnapshot {
            desktops,
            grants: state
                .delegations
                .values()
                .filter(|g| g.state == delegation::ManagedDesktopDelegationState::Live)
                .cloned()
                .collect(),
            observed_at: now,
        };
        Ok(())
    }

    pub(super) async fn refresh_agent_admission(&self) -> Result<()> {
        let state = self.state.clone().lock_owned().await;
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let result = service.publish_agent_admission(&state, true);
            if result.is_err() {
                *service.agent_admission.write() = Default::default();
            }
            result
        })
        .await
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
    }

    pub(super) fn agent_live(
        &self,
        id: &str,
        generation: u64,
        session: Option<&str>,
        character: Option<&str>,
    ) -> bool {
        if self.pending_agent_cleanup.lock().contains(id) {
            return false;
        }
        let snapshot = self.agent_admission.read();
        let now = (self.clock)().max(snapshot.observed_at);
        let Some(row) = snapshot.desktops.get(id) else {
            return false;
        };
        let Some(binding) = self.delegation_binding(&row.owner) else {
            return false;
        };
        row.generation == generation
            && row.running
            && now < row.deadline
            && snapshot.grants.iter().any(|grant| {
                grant.host_id == self.host_id
                    && grant.owner_principal_id == row.owner
                    && grant.account_binding_epoch == Some(binding.epoch)
                    && grant.account_binding_instance_id.as_deref()
                        == Some(binding.instance_id.as_str())
                    && grant.desktop_id == id
                    && grant.desktop_generation == generation
                    && grant.mode == delegation::ManagedDesktopDelegationMode::ComputerUse
                    && now < grant.expires_at
                    && grant.grantee.matches(session, character)
            })
    }

    pub(super) fn agent_enabled(&self, row: &DesktopRecord) -> bool {
        let snapshot = self.agent_admission.read();
        let now = (self.clock)().max(snapshot.observed_at);
        snapshot
            .desktops
            .get(&row.desktop.id)
            .is_some_and(|current| {
                current.generation == row.desktop.generation
                    && current.agent_control
                    && current.config.binding_digest() == row.config.binding_digest()
                    && current.template == row.template
                    && current.config.validate(now).is_ok()
            })
    }

    pub(super) fn newly_ended(
        old: &ManagedDesktopJournal,
        next: &ManagedDesktopJournal,
    ) -> BTreeSet<String> {
        old.delegations
            .values()
            .filter(|g| g.state == delegation::ManagedDesktopDelegationState::Live)
            .filter(|g| {
                next.delegations
                    .get(&g.id)
                    .is_none_or(|n| n.state == delegation::ManagedDesktopDelegationState::Ended)
            })
            .map(|g| g.desktop_id.clone())
            .collect()
    }
}
