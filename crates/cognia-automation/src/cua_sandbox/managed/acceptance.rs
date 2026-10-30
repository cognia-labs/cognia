//! Durable child-run state. Delivery/security-store orchestration belongs to
//! the Host RPC crate; this module owns atomic journal fences and cleanup.
use super::*;
use crate::cua_sandbox::managed::handoff::{self, AcceptanceCriterionInput};
use delegation::*;
use serde::{Deserialize, Serialize};

pub const ACCEPTANCE_CHANGED_TOPIC: &str = "managed-desktop://acceptance-changed";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcceptanceTransferMode {
    Commit,
    Bundle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptanceStartInput {
    pub delivery_id: String,
    pub delivery_revision: u64,
    pub mode: AcceptanceTransferMode,
    pub provider_config_id: String,
    pub lifetime_seconds: u64,
    pub criteria: Vec<AcceptanceCriterionInput>,
    pub acceptance_files: Vec<String>,
    pub argv: Vec<String>,
    pub quote_id: String,
    pub idempotency_key: String,
}
impl AcceptanceStartInput {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.idempotency_key)?;
        validate_id(&self.delivery_id)?;
        validate_id(&self.provider_config_id)?;
        validate_id(&self.quote_id)?;
        if self.criteria.is_empty() || self.criteria.len() > 50 {
            return Err(refused("managed_desktop_handoff_invalid_request"));
        }
        for criterion in &self.criteria {
            criterion.validate().map_err(|e| refused(&e))?;
        }
        handoff::validate_acceptance_paths(&self.acceptance_files).map_err(|e| refused(&e))?;
        handoff::parse_launch(&self.argv).map_err(|e| refused(&e))?;
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcceptanceRunState {
    Provisioning,
    AwaitingSession,
    Running,
    Completed,
    Cancelled,
    Failed,
}
impl AcceptanceRunState {
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Provisioning | Self::AwaitingSession | Self::Running
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceRunSource {
    pub session_id: String,
    pub task_id: Option<String>,
    pub parent_run_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopAcceptanceRun {
    pub acceptance_id: String,
    pub provider_config_id: String,
    pub delivery_id: String,
    pub commit: String,
    pub mode: AcceptanceTransferMode,
    pub state: AcceptanceRunState,
    pub desktop_id: Option<String>,
    pub desktop_generation: Option<u64>,
    pub deadline_at: Option<i64>,
    pub delegation_id: Option<String>,
    pub child_session_key: Option<String>,
    pub source: AcceptanceRunSource,
    pub error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceRunRecord {
    pub run: ManagedDesktopAcceptanceRun,
    pub owner_principal_id: String,
    pub host_id: String,
    pub principal_id: String,
    #[serde(default)]
    pub account_binding_epoch: Option<u64>,
    #[serde(default)]
    pub account_binding_instance_id: Option<String>,
    pub request: AcceptanceStartInput,
    pub source_id: String,
    pub origin_run_ref: String,
    pub cleanup_pending: bool,
}
impl AcceptanceRunRecord {
    fn end(&mut self, state: AcceptanceRunState, code: Option<&str>, now: i64) {
        if self.run.state.active() {
            self.run.state = state;
            self.run.error_code = code.map(str::to_owned);
            self.run.ended_at = Some(now);
            self.run.updated_at = now;
            self.cleanup_pending = true;
        }
    }
    pub fn principal(&self) -> ManagedDesktopPrincipal {
        ManagedDesktopPrincipal {
            owner_principal_id: self.owner_principal_id.clone(),
            host_id: self.host_id.clone(),
            principal_id: self.principal_id.clone(),
            authority: ManagedDesktopAuthority::Administrator,
        }
    }
}

pub(in crate::cua_sandbox::managed) fn recover(state: &mut ManagedDesktopJournal, now: i64) {
    for row in state.acceptance_runs.values_mut() {
        if matches!(
            row.run.state,
            AcceptanceRunState::Provisioning | AcceptanceRunState::AwaitingSession
        ) {
            row.end(
                AcceptanceRunState::Failed,
                Some("managed_desktop_acceptance_interrupted"),
                now,
            );
        }
    }
    settle(state, now, None);
}
pub(super) fn settle(
    state: &mut ManagedDesktopJournal,
    now: i64,
    runtime: Option<&DelegationRuntime>,
) {
    for row in state.acceptance_runs.values_mut() {
        // The create intent and this link commit together, before provider I/O.
        if row.run.desktop_id.is_none() {
            let source = format!("acceptance:{}", row.run.acceptance_id);
            if let Some(desktop) = state.desktops.values().find(|d| {
                d.source_id.as_deref() == Some(&source)
                    && d.config.owner_principal_id == row.owner_principal_id
                    && d.config.host_id == row.host_id
            }) {
                row.run.desktop_id = Some(desktop.desktop.id.clone());
                row.run.desktop_generation = Some(desktop.desktop.generation);
                row.run.deadline_at = Some(desktop.desktop.deadline_at);
                row.run.updated_at = now;
            }
        }
        if row.run.state.active() {
            if runtime.is_some_and(|r| {
                !r.binding(&row.owner_principal_id).is_some_and(|binding| {
                    row.account_binding_epoch == Some(binding.epoch)
                        && row.account_binding_instance_id.as_deref()
                            == Some(binding.instance_id.as_str())
                })
            }) {
                row.end(
                    AcceptanceRunState::Failed,
                    Some("managed_desktop_acceptance_account_changed"),
                    now,
                );
            }
            let error = if let Some(id) = &row.run.desktop_id {
                match state.desktops.get(id) {
                    None => Some("managed_desktop_acceptance_desktop_destroyed"),
                    Some(d) if Some(d.desktop.generation) != row.run.desktop_generation => {
                        Some("managed_desktop_acceptance_generation_changed")
                    }
                    Some(d) if d.expired(now) => Some("managed_desktop_acceptance_deadline"),
                    Some(d)
                        if d.delete_requested
                            || d.desktop.state == ManagedDesktopState::Destroyed =>
                    {
                        Some("managed_desktop_acceptance_desktop_destroyed")
                    }
                    _ => None,
                }
            } else {
                None
            };
            let error = error.or_else(|| {
                row.run
                    .delegation_id
                    .as_ref()
                    .and_then(|id| match state.delegations.get(id) {
                        Some(g) if g.state == ManagedDesktopDelegationState::Live => None,
                        Some(g)
                            if g.end_reason
                                == Some(ManagedDesktopDelegationEndReason::AccountChanged) =>
                        {
                            Some("managed_desktop_acceptance_account_changed")
                        }
                        _ => Some("managed_desktop_acceptance_delegation_ended"),
                    })
            });
            if let Some(code) = error {
                row.end(AcceptanceRunState::Failed, Some(code), now);
            }
        }
        if !row.run.state.active() {
            // Also catch an orphan grant if a crash split delegation publication
            // from the awaiting-session transition.
            for grant in state.delegations.values_mut().filter(|g| g.owner_principal_id == row.owner_principal_id
                && g.host_id == row.host_id && matches!(&g.grantee, ManagedDesktopGrantee::Acceptance { acceptance_id, .. } if acceptance_id == &row.run.acceptance_id)) {
                grant.end(if row.run.state == AcceptanceRunState::Completed { ManagedDesktopDelegationEndReason::Completed }
                    else { ManagedDesktopDelegationEndReason::Revoked }, now);
            }
            if let Some(desktop) = row
                .run
                .desktop_id
                .as_ref()
                .and_then(|id| state.desktops.get_mut(id))
            {
                if desktop.desktop.state != ManagedDesktopState::Destroyed
                    && !desktop.delete_requested
                {
                    desktop.next_retry_at = now;
                    desktop.delete_requested = true;
                    desktop.desktop.state = ManagedDesktopState::Deleting;
                    desktop.cleanup_requested_at.get_or_insert(now);
                }
            }
        }
    }
    // Retain pending cleanup, but bound ordinary terminal history per owner.
    let mut ended: Vec<_> = state
        .acceptance_runs
        .values()
        .filter(|r| !r.run.state.active() && !r.cleanup_pending)
        .map(|r| {
            (
                r.owner_principal_id.clone(),
                r.run.ended_at.unwrap_or(0),
                r.run.acceptance_id.clone(),
            )
        })
        .collect();
    ended.sort_by(|a, b| b.cmp(a));
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for (owner, at, id) in ended {
        let count = counts.entry(owner).or_default();
        *count += 1;
        if *count > 64 || now.saturating_sub(at) >= 86_400_000 {
            state.acceptance_runs.remove(&id);
        }
    }
}

impl ManagedDesktopService {
    pub fn acceptance_provisioning_live(&self, id: &str) -> bool {
        self.agent_admission.read().acceptances.get(id).is_some_and(
            |(state, owner, epoch, instance)| {
                *state == AcceptanceRunState::Provisioning
                    && self.delegation_binding(owner).is_some_and(|binding| {
                        *epoch == Some(binding.epoch)
                            && instance.as_deref() == Some(binding.instance_id.as_str())
                    })
            },
        )
    }
    /// A generation change fences control, but cleanup must retain the exact
    /// metadata of the originally billed generation. All other ownership tags
    /// (operation, deadline, build, owner and Host) still have to match.
    pub(super) async fn acceptance_cleanup_record(&self, desktop: &DesktopRecord) -> DesktopRecord {
        let mut expected = desktop.clone();
        if desktop.delete_requested {
            if let Some(run) = self.state.lock().await.acceptance_runs.values().find(|r| {
                !r.run.state.active()
                    && r.run.desktop_id.as_deref() == Some(desktop.desktop.id.as_str())
                    && r.owner_principal_id == desktop.config.owner_principal_id
                    && r.host_id == desktop.config.host_id
                    && desktop.source_id.as_deref()
                        == Some(format!("acceptance:{}", r.run.acceptance_id).as_str())
            }) {
                if let Some(generation) = run.run.desktop_generation {
                    expected.desktop.generation = generation;
                }
            }
        }
        expected
    }
    pub async fn acceptance_retry(
        &self,
        p: &ManagedDesktopPrincipal,
        key: &str,
    ) -> Result<Option<AcceptanceRunRecord>> {
        p.require_admin()?;
        self.scope(p)?;
        Ok(self
            .state
            .lock()
            .await
            .acceptance_runs
            .values()
            .find(|r| {
                r.owner_principal_id == p.owner_principal_id
                    && r.host_id == p.host_id
                    && r.request.idempotency_key == key
            })
            .cloned())
    }
    pub async fn acceptance_begin(
        &self,
        p: &ManagedDesktopPrincipal,
        request: AcceptanceStartInput,
        source_id: String,
        source: AcceptanceRunSource,
        origin_run_ref: String,
        commit: String,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<(AcceptanceRunRecord, bool)> {
        p.require_admin()?;
        request.validate()?;
        self.scope(p)?;
        authority.revalidate(p).await?;
        if let Some(row) = self.acceptance_retry(p, &request.idempotency_key).await? {
            return Ok((row, false));
        }
        let config = self.config(p, &request.provider_config_id).await?;
        self.admission(&config, self.now().await)?;
        let runtime = self
            .delegation_runtime
            .read()
            .clone()
            .ok_or_else(|| refused("managed_desktop_forbidden"))?;
        let owner = p.owner_principal_id.clone();
        let binding = tokio::task::spawn_blocking(move || {
            runtime.prepare(std::iter::once(owner.as_str()));
            runtime
                .binding(&owner)
                .ok_or_else(|| refused("managed_desktop_forbidden"))
        })
        .await
        .map_err(|_| refused("managed_desktop_forbidden"))??;
        let live = authority.input_admission(p);
        self.transaction_admitted(
            Arc::new(move || {
                if live() {
                    Ok(())
                } else {
                    Err(refused("managed_desktop_forbidden"))
                }
            }),
            |s, now| {
                if let Some(row) = s.acceptance_runs.values().find(|r| {
                    r.owner_principal_id == p.owner_principal_id
                        && r.host_id == p.host_id
                        && r.request.idempotency_key == request.idempotency_key
                }) {
                    return Ok((row.clone(), false));
                }
                if !qualification::effective_enablement(s, &config, now).acceptance {
                    return Err(refused("managed_desktop_acceptance_unqualified"));
                }
                let quote = valid_quote(s, &config, p, &request.quote_id, now)?;
                if quote.lifetime_seconds != request.lifetime_seconds {
                    return Err(refused("managed_desktop_quote_expired"));
                }
                if s.acceptance_runs
                    .values()
                    .filter(|r| {
                        r.owner_principal_id == p.owner_principal_id && r.run.state.active()
                    })
                    .count()
                    >= 2
                {
                    return Err(refused("managed_desktop_capacity_limit"));
                }
                let run = ManagedDesktopAcceptanceRun {
                    acceptance_id: Uuid::new_v4().to_string(),
                    provider_config_id: config.id,
                    delivery_id: request.delivery_id.clone(),
                    commit,
                    mode: request.mode,
                    state: AcceptanceRunState::Provisioning,
                    desktop_id: None,
                    desktop_generation: None,
                    deadline_at: None,
                    delegation_id: None,
                    child_session_key: None,
                    source,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                    ended_at: None,
                };
                let record = AcceptanceRunRecord {
                    run,
                    owner_principal_id: p.owner_principal_id.clone(),
                    host_id: p.host_id.clone(),
                    principal_id: p.principal_id.clone(),
                    account_binding_epoch: Some(binding.epoch),
                    account_binding_instance_id: Some(binding.instance_id.clone()),
                    request,
                    source_id,
                    origin_run_ref,
                    cleanup_pending: false,
                };
                s.acceptance_runs
                    .insert(record.run.acceptance_id.clone(), record.clone());
                Ok((record, true))
            },
        )
        .await
    }
    pub async fn acceptance_record(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> Result<AcceptanceRunRecord> {
        self.scope(p)?;
        self.reconcile_delegations().await?;
        self.state
            .lock()
            .await
            .acceptance_runs
            .get(id)
            .filter(|r| r.owner_principal_id == p.owner_principal_id && r.host_id == p.host_id)
            .cloned()
            .ok_or_else(|| refused("managed_desktop_not_found"))
    }
    pub async fn acceptance_records(&self) -> Vec<AcceptanceRunRecord> {
        self.state
            .lock()
            .await
            .acceptance_runs
            .values()
            .cloned()
            .collect()
    }
    pub async fn acceptance_status(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        Ok(self.acceptance_record(p, id).await?.run)
    }
    pub async fn acceptance_list(
        &self,
        p: &ManagedDesktopPrincipal,
    ) -> Result<Vec<ManagedDesktopAcceptanceRun>> {
        p.require_admin()?;
        self.scope(p)?;
        self.reconcile_delegations().await?;
        let mut rows: Vec<_> = self
            .state
            .lock()
            .await
            .acceptance_runs
            .values()
            .filter(|r| r.owner_principal_id == p.owner_principal_id && r.host_id == p.host_id)
            .map(|r| r.run.clone())
            .collect();
        rows.sort_by_key(|r| (std::cmp::Reverse(r.created_at), r.acceptance_id.clone()));
        Ok(rows)
    }
    pub async fn acceptance_await_session(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        let row = self.acceptance_record(p, id).await?;
        if row.run.state != AcceptanceRunState::Provisioning {
            return Err(refused("managed_desktop_acceptance_invalid_state"));
        }
        let desktop = row
            .run
            .desktop_id
            .ok_or_else(|| refused("managed_desktop_not_found"))?;
        let grant = self
            .delegate_acceptance(
                p,
                &desktop,
                row.run.desktop_generation.unwrap_or(0),
                id,
                authority,
            )
            .await?;
        self.transaction(|s, now| {
            let row = s
                .acceptance_runs
                .get_mut(id)
                .ok_or_else(|| refused("managed_desktop_not_found"))?;
            if row.run.state != AcceptanceRunState::Provisioning {
                return Err(refused("managed_desktop_acceptance_invalid_state"));
            }
            row.run.delegation_id = Some(grant.id);
            row.run.state = AcceptanceRunState::AwaitingSession;
            row.run.updated_at = now;
            Ok(row.run.clone())
        })
        .await
    }
    pub async fn acceptance_attach(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        session: String,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        self.acceptance_record(p, id).await?;
        if session.trim().is_empty() || session.len() > 512 || session.contains('\0') {
            return Err(refused("managed_desktop_invalid_request"));
        }
        authority.revalidate(p).await?;
        let live = authority.input_admission(p);
        self.transaction_admitted(
            Arc::new(move || {
                if live() {
                    Ok(())
                } else {
                    Err(refused("managed_desktop_forbidden"))
                }
            }),
            |s, now| {
                let row = s
                    .acceptance_runs
                    .get_mut(id)
                    .ok_or_else(|| refused("managed_desktop_not_found"))?;
                if row.run.state != AcceptanceRunState::AwaitingSession
                    || row.run.child_session_key.is_some()
                {
                    return Err(refused("managed_desktop_acceptance_invalid_state"));
                }
                let grant = row
                    .run
                    .delegation_id
                    .as_ref()
                    .and_then(|id| s.delegations.get_mut(id))
                    .filter(|g| {
                        g.state == ManagedDesktopDelegationState::Live
                            && g.expires_at > now
                            && matches!(&g.grantee, ManagedDesktopGrantee::Acceptance { acceptance_id, child_session_key:None } if acceptance_id == id)
                    })
                    .ok_or_else(|| refused("managed_desktop_acceptance_delegation_required"))?;
                if let ManagedDesktopGrantee::Acceptance { child_session_key, .. } = &mut grant.grantee {
                    *child_session_key = Some(session.clone());
                }
                grant.revision += 1;
                row.run.child_session_key = Some(session);
                row.run.state = AcceptanceRunState::Running;
                row.run.updated_at = now;
                Ok(row.run.clone())
            },
        )
        .await
    }
    pub async fn acceptance_end(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        state: AcceptanceRunState,
        code: Option<String>,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        self.acceptance_record(p, id).await?;
        if state.active() {
            return Err(refused("managed_desktop_acceptance_invalid_state"));
        }
        self.transaction(|s, now| {
            let row = s
                .acceptance_runs
                .get_mut(id)
                .ok_or_else(|| refused("managed_desktop_not_found"))?;
            if state == AcceptanceRunState::Completed
                && row.run.state != AcceptanceRunState::Completed
            {
                // A durable agent verdict wins a restart/expiry fence between
                // evidence publication and this journal commit.
                row.run.state = state;
                row.run.error_code = None;
                row.run.ended_at = Some(now);
                row.run.updated_at = now;
                row.cleanup_pending = true;
            } else {
                row.end(state, code.as_deref(), now);
            }
            Ok(row.run.clone())
        })
        .await
    }
    pub async fn acceptance_cleaned(&self, p: &ManagedDesktopPrincipal, id: &str) -> Result<()> {
        p.require_admin()?;
        self.acceptance_record(p, id).await?;
        self.transaction(|s, _| {
            s.acceptance_runs.get_mut(id).unwrap().cleanup_pending = false;
            Ok(())
        })
        .await
    }
    /// Synchronous send fence reused by evidence writes and control frames.
    pub fn acceptance_session_live(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        session: &str,
    ) -> bool {
        let snapshot = self.agent_admission.read();
        snapshot.grants.iter().any(|g| g.owner_principal_id == p.owner_principal_id && g.host_id == p.host_id
            && g.mode == ManagedDesktopDelegationMode::Acceptance && g.matches(Some(session),None)
            && matches!(&g.grantee, ManagedDesktopGrantee::Acceptance { acceptance_id, .. } if acceptance_id == id)
            && p.authority == ManagedDesktopAuthority::Agent && p.principal_id == format!("acceptance:{id}")
            && self.agent_live_from_snapshot(&snapshot,g,ManagedDesktopRuntimeGate::Acceptance))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    use std::sync::atomic::Ordering;

    struct Authority;
    #[async_trait::async_trait]
    impl control::ManagedControlAuthority for Authority {
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
            Ok(())
        }
        fn input_admission(
            &self,
            _: &ManagedDesktopPrincipal,
        ) -> Arc<dyn Fn() -> bool + Send + Sync> {
            Arc::new(|| true)
        }
    }
    async fn fixture() -> Fixture {
        let f = Fixture::new();
        qualification::enablement_tests::install_gui_evidence(&f).await;
        for (index, mode) in ["commit", "bundle"].into_iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            let desktop = f.smoke(&format!("acceptance-evidence-{index}")).await;
            f.service.delete(&f.p, &desktop.id, 1).await.unwrap();
            f.service
                .transaction(|s, now| {
                    s.desktops.get_mut(&desktop.id).unwrap().source_id =
                        Some(format!("handoff:{id}"));
                    s.handoff_diagnostics.insert(
                        id.clone(),
                        NativeHandoffDiagnostic {
                            operation_id: id,
                            evidence_version: 1,
                            boundary: s.workload_boundaries[&desktop.id].clone(),
                            mode: mode.into(),
                            receipt_sha256: format!("{index}").repeat(64),
                            source_tree_sha256: "c".repeat(64),
                            recorded_at: now,
                        },
                    );
                    Ok(())
                })
                .await
                .unwrap();
        }
        let digest = f.config.binding_digest();
        f.service
            .transaction(|s, _| {
                let mut receipt = s.lifecycle_diagnostics[&digest].clone();
                receipt.workload_evidence =
                    qualification::derive_evidence(s, &digest, &receipt.template);
                assert!(receipt.workload_evidence.is_some());
                s.qualifications.insert(digest.clone(), receipt);
                Ok(())
            })
            .await
            .unwrap();
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement = ManagedDesktopEnablement {
            acceptance: true,
            agent_control: false,
            manual_gui: false,
        };
        f.service.save_registry(registry).await.unwrap();
        assert!(
            f.service
                .effective_enablement(&f.p, "e2b")
                .await
                .unwrap()
                .acceptance
        );
        f.service.set_delegation_runtime(
            Arc::new(|owner| owner == "owner"),
            Arc::new(|| 1),
            "test-process".into(),
            Arc::new(|| {}),
        );
        f
    }
    async fn input(f: &Fixture, key: &str) -> AcceptanceStartInput {
        AcceptanceStartInput {
            delivery_id: "delivery".into(),
            delivery_revision: 1,
            mode: AcceptanceTransferMode::Commit,
            provider_config_id: "e2b".into(),
            lifetime_seconds: 120,
            criteria: vec![AcceptanceCriterionInput {
                description: "Page loads".into(),
                screenshot_required: false,
            }],
            acceptance_files: vec![],
            argv: vec![],
            quote_id: f.service.quote(&f.p, "e2b", 120).await.unwrap().id,
            idempotency_key: key.into(),
        }
    }
    async fn begin(
        f: &Fixture,
        input: AcceptanceStartInput,
    ) -> Result<(AcceptanceRunRecord, bool)> {
        f.service
            .acceptance_begin(
                &f.p,
                input,
                "source".into(),
                AcceptanceRunSource {
                    session_id: "chat".into(),
                    task_id: Some("task".into()),
                    parent_run_id: Some("coding-run".into()),
                },
                "origin".into(),
                "a".repeat(40),
                &Authority,
            )
            .await
    }
    async fn create(f: &Fixture, row: &AcceptanceRunRecord) -> ManagedDesktop {
        let auth = f
            .service
            .authorize(
                &f.p,
                "e2b",
                &row.request.quote_id,
                AuthorizationPurpose::Create,
                Some(format!("acceptance:{}", row.run.acceptance_id)),
            )
            .await
            .unwrap();
        f.service
            .create(
                &f.p,
                CreateManagedDesktop {
                    provider_config_id: "e2b".into(),
                    quote_id: row.request.quote_id.clone(),
                    authorization_id: auth.id,
                    idempotency_key: row.run.acceptance_id.clone(),
                },
            )
            .await
            .unwrap()
    }
    async fn running(f: &Fixture) -> (AcceptanceRunRecord, ManagedDesktop) {
        let (row, _) = begin(f, input(f, "run").await).await.unwrap();
        let desktop = create(f, &row).await;
        f.service
            .acceptance_await_session(&f.p, &row.run.acceptance_id, &Authority)
            .await
            .unwrap();
        f.service
            .acceptance_attach(&f.p, &row.run.acceptance_id, "child".into(), &Authority)
            .await
            .unwrap();
        (
            f.service
                .acceptance_record(&f.p, &row.run.acceptance_id)
                .await
                .unwrap(),
            desktop,
        )
    }
    #[tokio::test]
    async fn start_requires_effective_switch_valid_quote_admin_and_is_idempotent() {
        let f = fixture().await;
        let request = input(&f, "one").await;
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement.acceptance = false;
        f.service.save_registry(registry.clone()).await.unwrap();
        assert_eq!(
            begin(&f, request.clone()).await.unwrap_err().code,
            "managed_desktop_acceptance_unqualified"
        );
        registry.providers[0].enablement.acceptance = true;
        f.service.save_registry(registry).await.unwrap();
        for field in ["owner", "config", "expiry"] {
            let mut request = input(&f, field).await;
            f.service
                .transaction(|s, _| {
                    let q = s.quotes.get_mut(&request.quote_id).unwrap();
                    match field {
                        "owner" => q.owner_principal_id = "foreign".into(),
                        "config" => q.provider_config_id = "foreign".into(),
                        _ => q.expires_at = 0,
                    };
                    Ok(())
                })
                .await
                .unwrap();
            assert_eq!(
                begin(&f, request.clone()).await.unwrap_err().code,
                "managed_desktop_quote_expired"
            );
            request.lifetime_seconds += 1;
            assert!(begin(&f, request).await.is_err());
        }
        for authority in [
            ManagedDesktopAuthority::Agent,
            ManagedDesktopAuthority::Human,
            ManagedDesktopAuthority::Observer,
        ] {
            let mut p = f.p.clone();
            p.authority = authority;
            assert!(f
                .service
                .acceptance_begin(
                    &p,
                    request.clone(),
                    "source".into(),
                    AcceptanceRunSource {
                        session_id: "chat".into(),
                        task_id: None,
                        parent_run_id: None
                    },
                    "origin".into(),
                    "a".repeat(40),
                    &Authority
                )
                .await
                .is_err());
        }
        let (first, created) = begin(&f, request.clone()).await.unwrap();
        assert!(created);
        let (second, created) = begin(&f, request).await.unwrap();
        assert!(!created);
        assert_eq!(first.run, second.run);
        assert_eq!(f.service.acceptance_list(&f.p).await.unwrap().len(), 1);
        let mut foreign = f.p.clone();
        foreign.owner_principal_id = "other".into();
        assert!(f
            .service
            .acceptance_status(&foreign, &first.run.acceptance_id)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn attachment_is_once_only_and_only_the_child_can_control_with_acceptance_effective() {
        let f = fixture().await;
        let (row, _) = begin(&f, input(&f, "attach").await).await.unwrap();
        let id = &row.run.acceptance_id;
        assert!(f
            .service
            .acceptance_attach(&f.p, id, "child".into(), &Authority)
            .await
            .is_err());
        let desktop = create(&f, &row).await;
        f.service
            .acceptance_await_session(&f.p, id, &Authority)
            .await
            .unwrap();
        assert!(!f.service.agent_live(&desktop.id, 1, Some("child"), None));
        let attached = f
            .service
            .acceptance_attach(&f.p, id, "child".into(), &Authority)
            .await
            .unwrap();
        assert_eq!(attached.child_session_key.as_deref(), Some("child"));
        assert!(f
            .service
            .acceptance_attach(&f.p, id, "child".into(), &Authority)
            .await
            .is_err());
        let client =
            crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(|_, _| {
                Box::pin(async { Ok(serde_json::json!({"x":1,"y":2})) })
            }));
        f.service
            .control_slot(&desktop.id, 1)
            .await
            .lock()
            .await
            .client = Some(client);
        use crate::automation::types::Action;
        assert!(f
            .service
            .agent_operation(
                &desktop.id,
                1,
                Some("other".into()),
                None,
                Action::CursorPosition
            )
            .await
            .is_err());
        f.service
            .agent_operation(
                &desktop.id,
                1,
                Some("child".into()),
                None,
                Action::CursorPosition,
            )
            .await
            .unwrap();
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement.acceptance = false;
        f.service.save_registry(registry).await.unwrap();
        assert!(f
            .service
            .agent_operation(
                &desktop.id,
                1,
                Some("child".into()),
                None,
                Action::CursorPosition
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn interrupted_provisioning_and_awaiting_session_destroy_on_reopen_without_recreating() {
        for awaiting in [false, true] {
            let f = fixture().await;
            let (row, _) = begin(&f, input(&f, "crash").await).await.unwrap();
            let desktop = create(&f, &row).await;
            if awaiting {
                f.service
                    .acceptance_await_session(&f.p, &row.run.acceptance_id, &Authority)
                    .await
                    .unwrap();
            }
            let Fixture {
                directory,
                provider,
                secrets,
                service,
                p,
                config,
                ..
            } = f;
            drop(service);
            let reopened = ManagedDesktopService::open(
                directory.path(),
                "host".into(),
                provider.clone(),
                secrets,
                Some(config.release),
            )
            .unwrap();
            assert_eq!(
                reopened
                    .acceptance_status(&p, &row.run.acceptance_id)
                    .await
                    .unwrap()
                    .state,
                AcceptanceRunState::Failed
            );
            reopened.reconcile().await.unwrap();
            assert_eq!(
                reopened
                    .list(&p)
                    .await
                    .unwrap()
                    .iter()
                    .find(|d| d.id == desktop.id)
                    .unwrap()
                    .state,
                ManagedDesktopState::Destroyed
            );
        }
    }
    #[tokio::test]
    async fn complete_cancel_deadline_revoke_generation_and_account_fence_cleanup() {
        for reason in [
            "complete",
            "cancel",
            "deadline",
            "revoke",
            "generation",
            "account",
            "destroy",
        ] {
            let f = fixture().await;
            let (row, desktop) = running(&f).await;
            let id = &row.run.acceptance_id;
            match reason {
                "complete" => {
                    f.service
                        .acceptance_end(&f.p, id, AcceptanceRunState::Completed, None)
                        .await
                        .unwrap();
                }
                "cancel" => {
                    f.service
                        .acceptance_end(
                            &f.p,
                            id,
                            AcceptanceRunState::Cancelled,
                            Some("acceptance_cancelled".into()),
                        )
                        .await
                        .unwrap();
                }
                "deadline" => {
                    f.clock.store(desktop.deadline_at, Ordering::SeqCst);
                }
                "revoke" => {
                    let g = f
                        .service
                        .delegation_list(&f.p)
                        .await
                        .unwrap()
                        .into_iter()
                        .find(|g| Some(&g.id) == row.run.delegation_id.as_ref())
                        .unwrap();
                    f.service
                        .delegation_revoke(&f.p, &g.id, g.revision, &Authority)
                        .await
                        .unwrap();
                }
                "generation" => {
                    f.service
                        .transaction(|s, _| {
                            s.desktops.get_mut(&desktop.id).unwrap().desktop.generation += 1;
                            Ok(())
                        })
                        .await
                        .unwrap();
                }
                "account" => {
                    f.service.set_delegation_runtime(
                        Arc::new(|_| false),
                        Arc::new(|| 2),
                        "other-process".into(),
                        Arc::new(|| {}),
                    );
                }
                _ => {
                    f.service.delete(&f.p, &desktop.id, 1).await.unwrap();
                }
            }
            f.service.reconcile().await.unwrap();
            let ended = f.service.acceptance_status(&f.p, id).await.unwrap();
            assert!(!ended.state.active(), "{reason}");
            let grants = f.service.delegation_list(&f.p).await.unwrap();
            let grant = grants
                .iter()
                .find(|g| Some(&g.id) == ended.delegation_id.as_ref())
                .unwrap();
            assert_eq!(
                grant.state,
                ManagedDesktopDelegationState::Ended,
                "{reason}"
            );
            if reason == "complete" {
                assert_eq!(
                    grant.end_reason,
                    Some(ManagedDesktopDelegationEndReason::Completed)
                );
            }
            assert_eq!(
                f.service
                    .list(&f.p)
                    .await
                    .unwrap()
                    .iter()
                    .find(|d| d.id == desktop.id)
                    .unwrap()
                    .state,
                ManagedDesktopState::Destroyed,
                "{reason}"
            );
            assert_eq!(
                ended.source, row.run.source,
                "the parent/source binding is never changed"
            );
        }
    }
    #[tokio::test]
    async fn terminal_run_keeps_durable_delete_retry_state_until_absence_is_confirmed() {
        let f = fixture().await;
        let (row, desktop) = running(&f).await;
        f.provider.fail_delete.store(true, Ordering::SeqCst);
        f.service
            .acceptance_end(
                &f.p,
                &row.run.acceptance_id,
                AcceptanceRunState::Completed,
                None,
            )
            .await
            .unwrap();
        let deleting = f
            .service
            .delete(&f.p, &desktop.id, desktop.generation)
            .await
            .unwrap();
        assert_eq!(deleting.state, ManagedDesktopState::DestroyRetrying);
        assert!(
            f.service
                .acceptance_record(&f.p, &row.run.acceptance_id)
                .await
                .unwrap()
                .cleanup_pending
        );
        assert_eq!(
            f.service
                .list(&f.p)
                .await
                .unwrap()
                .into_iter()
                .find(|d| d.id == desktop.id)
                .unwrap()
                .state,
            ManagedDesktopState::DestroyRetrying
        );
        f.provider.fail_delete.store(false, Ordering::SeqCst);
        f.clock.store(20_000, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert_eq!(
            f.service
                .list(&f.p)
                .await
                .unwrap()
                .into_iter()
                .find(|d| d.id == desktop.id)
                .unwrap()
                .state,
            ManagedDesktopState::Destroyed
        );
    }
}
