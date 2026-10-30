//! WP9 Host orchestration. One durable intent precedes all paid work. Domain
//! transactions own fences; delivery and evidence stores remain their owners.
use crate::managed_desktop_handoff::{self as handoff_rpc, PrepareHandoff, TransferMode};
use crate::managed_desktop_results::{self as results, Capture, Complete};
use crate::managed_desktops::HostEventSink;
use cognia_automation::cua_sandbox::managed::{evidence::*, handoff::*, *};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub use cognia_automation::cua_sandbox::managed::ACCEPTANCE_CHANGED_TOPIC;
type Current = Arc<dyn Fn() -> Result<()> + Send + Sync>;
struct Work {
    task: tokio::task::JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}
struct ProvisionTask(tokio::task::JoinHandle<Result<()>>);
impl Drop for ProvisionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub struct AcceptanceRuntime {
    service: Arc<ManagedDesktopService>,
    events: Option<HostEventSink>,
    active: parking_lot::Mutex<BTreeMap<String, Work>>,
    serial: Arc<tokio::sync::Mutex<()>>,
}
impl Drop for AcceptanceRuntime {
    fn drop(&mut self) {
        for work in self.active.lock().values() {
            work.cancelled.store(true, Ordering::SeqCst);
            work.task.abort();
        }
    }
}
fn emit(events: &Option<HostEventSink>) {
    if let Some(events) = events {
        events(ACCEPTANCE_CHANGED_TOPIC, json!({}));
    }
}
fn request(input: &AcceptanceStartInput) -> PrepareHandoff {
    PrepareHandoff {
        delivery_id: input.delivery_id.clone(),
        delivery_revision: input.delivery_revision,
        mode: input.mode,
        provider_config_id: input.provider_config_id.clone(),
        lifetime_seconds: input.lifetime_seconds,
        criteria: input.criteria.clone(),
        acceptance_files: input.acceptance_files.clone(),
        argv: input.argv.clone(),
    }
}
struct RunAuthority {
    current: Current,
}
#[async_trait::async_trait]
impl ManagedControlAuthority for RunAuthority {
    async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
        let current = self.current.clone();
        tokio::task::spawn_blocking(move || current())
            .await
            .map_err(|_| refused("managed_desktop_forbidden"))?
    }
    fn input_admission(&self, _: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let current = self.current.clone();
        Arc::new(move || current().is_ok())
    }
}
impl AcceptanceRuntime {
    pub fn new(service: Arc<ManagedDesktopService>, events: Option<HostEventSink>) -> Self {
        Self {
            service,
            events,
            active: Default::default(),
            serial: Default::default(),
        }
    }
    pub fn notify(&self) {
        emit(&self.events);
    }
    pub async fn start(
        &self,
        directory: PathBuf,
        p: ManagedDesktopPrincipal,
        input: AcceptanceStartInput,
        current: Current,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        input.validate()?;
        let authority = RunAuthority {
            current: current.clone(),
        };
        authority.revalidate(&p).await?;
        // Retry before re-resolving a now-expired quote/source: never spend twice.
        if let Some(row) = self
            .service
            .acceptance_retry(&p, &input.idempotency_key)
            .await?
        {
            return Ok(row.run);
        }
        let root = directory.clone();
        let principal = p.clone();
        let prepare = request(&input);
        let (delivery, source) =
            tokio::task::spawn_blocking(move || handoff_rpc::resolve(&root, &principal, &prepare))
                .await
                .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
        let (row, created) = self
            .service
            .acceptance_begin(
                &p,
                input,
                source.id,
                AcceptanceRunSource {
                    session_id: source.conversation_id,
                    task_id: Some(source.task_id),
                    parent_run_id: Some(source.coding_run_id),
                },
                source.origin_run_ref,
                delivery
                    .commit
                    .ok_or_else(|| refused("managed_desktop_handoff_delivery_unavailable"))?,
                &authority,
            )
            .await?;
        if !created {
            return Ok(row.run);
        }
        let summary = row.run.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let service = self.service.clone();
        let events = self.events.clone();
        let serial = self.serial.clone();
        let id = row.run.acceptance_id.clone();
        let task = tokio::spawn(async move {
            let root = directory.clone();
            let principal = p.clone();
            let prepare = request(&row.request);
            let provisioning_service = service.clone();
            let provisioning_id = id.clone();
            let check: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
                !cancel.load(Ordering::SeqCst)
                    && provisioning_service.acceptance_provisioning_live(&provisioning_id)
                    && current().is_ok()
                    && handoff_rpc::resolve(&root, &principal, &prepare).is_ok()
            });
            let run_check = check.clone();
            let authority = RunAuthority {
                current: Arc::new(move || {
                    if run_check() {
                        Ok(())
                    } else {
                        Err(refused("managed_desktop_acceptance_authority_expired"))
                    }
                }),
            };
            let root = directory.clone();
            let runner = service.clone();
            let principal = p.clone();
            let publication = serial.clone();
            let mut work = ProvisionTask(tokio::spawn(async move {
                provision(
                    &root,
                    &runner,
                    &principal,
                    &row,
                    &authority,
                    check,
                    publication,
                )
                .await
            }));
            // A panic still produces a terminal intent and durable deletion.
            let outcome = (&mut work.0)
                .await
                .unwrap_or_else(|_| Err(refused("managed_desktop_acceptance_interrupted")));
            if let Err(error) = outcome {
                let _ = service
                    .acceptance_end(&p, &id, AcceptanceRunState::Failed, Some(error.code))
                    .await;
            }
            emit(&events);
            if let Err(error) = reconcile_inner(&directory, &service, &events, &serial).await {
                log::warn!("managed desktop acceptance cleanup: {}", error.code);
            }
        });
        let mut active = self.active.lock();
        active.retain(|_, w| !w.task.is_finished());
        active.insert(summary.acceptance_id.clone(), Work { task, cancelled });
        emit(&self.events);
        Ok(summary)
    }
    pub async fn reconcile(&self, directory: &Path) -> Result<()> {
        self.service.reconcile_delegations().await?;
        self.stop_ended().await;
        let result = reconcile_inner(directory, &self.service, &self.events, &self.serial).await;
        self.stop_ended().await;
        result
    }
    async fn stop_ended(&self) {
        let rows = self.service.acceptance_records().await;
        let mut active = self.active.lock();
        for row in rows.into_iter().filter(|r| !r.run.state.active()) {
            if let Some(work) = active.remove(&row.run.acceptance_id) {
                work.cancelled.store(true, Ordering::SeqCst);
                work.task.abort();
            }
        }
    }
    pub async fn cancel(
        &self,
        directory: &Path,
        p: &ManagedDesktopPrincipal,
        id: &str,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedDesktopAcceptanceRun> {
        p.require_admin()?;
        authority.revalidate(p).await?;
        let _serial = self.serial.lock().await;
        let record = self.service.acceptance_record(p, id).await?;
        let verdict = read_result(directory, &record).await?;
        let completed = verdict.as_ref().is_some_and(|r| r.agent_verdict.is_some());
        let ended = self
            .service
            .acceptance_end(
                p,
                id,
                if completed {
                    AcceptanceRunState::Completed
                } else {
                    AcceptanceRunState::Cancelled
                },
                (!completed).then(|| "managed_desktop_acceptance_cancelled".into()),
            )
            .await?;
        if let Some(work) = self.active.lock().remove(id) {
            work.cancelled.store(true, Ordering::SeqCst);
            work.task.abort();
        }
        drop(_serial);
        self.reconcile(directory).await?;
        Ok(ended)
    }
}

async fn provision(
    directory: &Path,
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    row: &AcceptanceRunRecord,
    authority: &dyn ManagedControlAuthority,
    source_current: Arc<dyn Fn() -> bool + Send + Sync>,
    publication: Arc<tokio::sync::Mutex<()>>,
) -> Result<()> {
    let input = &row.request;
    let id = &row.run.acceptance_id;
    let authorization = service
        .authorize_with_authority(
            p,
            &input.provider_config_id,
            &input.quote_id,
            AuthorizationPurpose::Create,
            Some(format!("acceptance:{id}")),
            authority,
        )
        .await?;
    let mut desktop = service
        .create_with_authority(
            p,
            CreateManagedDesktop {
                provider_config_id: input.provider_config_id.clone(),
                quote_id: input.quote_id.clone(),
                authorization_id: authorization.id,
                idempotency_key: id.clone(),
            },
            authority,
        )
        .await?;
    while desktop.state == ManagedDesktopState::Creating {
        authority.revalidate(p).await?;
        if chrono::Utc::now().timestamp_millis() >= desktop.deadline_at {
            return Err(refused("managed_desktop_acceptance_deadline"));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        desktop = service.connect(p, &desktop.id, desktop.generation).await?;
    }
    if desktop.state != ManagedDesktopState::Running {
        return Err(refused("managed_desktop_acceptance_desktop_unavailable"));
    }
    let (_cancel, cancelled) = tokio::sync::watch::channel(false);
    let budget = HandoffBudget {
        deadline_at_ms: desktop.deadline_at,
        cancel: cancelled,
    };
    let prepare = request(input);
    let root = directory.to_owned();
    let principal = p.clone();
    let check = prepare.clone();
    let (delivery, source) =
        tokio::task::spawn_blocking(move || handoff_rpc::resolve(&root, &principal, &check))
            .await
            .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    let proxy = crate::managed_desktop_handoff_operator::source_proxy(&source).await?;
    let recovery = if input.mode == TransferMode::Bundle {
        Some(RecoverySource {
            path: PathBuf::from(
                delivery.publish["recovery"]["bundle"]
                    .as_str()
                    .ok_or_else(|| refused("managed_desktop_handoff_delivery_unavailable"))?,
            ),
            trusted_root: directory.join("sandbox-recovery"),
            expected_sha256: None,
        })
    } else {
        None
    };
    let prepared = prepare_source(
        &TrustedHandoffSource {
            commit: row.run.commit.clone(),
            readonly_proxy_port: proxy.port(),
            recovery,
        },
        &input.acceptance_files,
        &budget,
    )
    .await
    .map_err(|_| refused("managed_desktop_handoff_transfer_failed"))?;
    let launch =
        parse_launch(&input.argv).map_err(|_| refused("managed_desktop_handoff_invalid_launch"))?;
    service
        .install_handoff(
            p,
            &desktop,
            HandoffTransfer {
                prepared: &prepared,
                operation_id: id,
                launch: launch.as_ref(),
                budget: &budget,
                source_current,
            },
        )
        .await?;
    authority.revalidate(p).await?;
    let binding = production_binding(row, &desktop, prepared.manifest_digest())?;
    let owner = p.owner_principal_id.clone();
    let host = p.host_id.clone();
    let admission = authority.input_admission(p);
    let guard = publication.lock_owned().await;
    results::disk(directory, move |s| {
        let _guard = guard;
        s.with_admission(admission).register(&owner, &host, binding)
    })
    .await?;
    service.acceptance_await_session(p, id, authority).await?;
    Ok(())
}
pub(crate) fn production_binding(
    row: &AcceptanceRunRecord,
    desktop: &ManagedDesktop,
    transfer: &str,
) -> Result<AcceptanceBinding> {
    let input = &row.request;
    let manifest = json!({"version":1,"acceptanceRunId":row.run.acceptance_id,"parentRunId":row.run.source.parent_run_id,
        "originRunRef":row.origin_run_ref,"sessionId":row.run.source.session_id,"taskId":row.run.source.task_id,
        "sourceId":row.source_id,"ownerAccountId":row.owner_principal_id,"hostId":row.host_id,
        "deliveryId":input.delivery_id,"deliveryRevision":input.delivery_revision,"commit":row.run.commit,
        "mode":input.mode,"criteria":input.criteria,"desktopId":desktop.id,"desktopGeneration":desktop.generation,
        "deadlineAt":desktop.deadline_at,"launchArgv":input.argv,"cwd":".","acceptanceFiles":input.acceptance_files,
        "transferManifestDigest":transfer});
    Ok(AcceptanceBinding {
        acceptance_id: row.run.acceptance_id.clone(),
        owner_account_id: row.owner_principal_id.clone(),
        host_id: row.host_id.clone(),
        source_id: row.source_id.clone(),
        session_id: row.run.source.session_id.clone(),
        task_id: row
            .run
            .source
            .task_id
            .clone()
            .ok_or_else(|| refused("managed_desktop_handoff_source_unavailable"))?,
        parent_run_id: row
            .run
            .source
            .parent_run_id
            .clone()
            .ok_or_else(|| refused("managed_desktop_handoff_source_unavailable"))?,
        origin_run_ref: Some(row.origin_run_ref.clone()),
        delivery_id: input.delivery_id.clone(),
        delivery_revision: input.delivery_revision,
        commit: row.run.commit.clone(),
        desktop_id: desktop.id.clone(),
        desktop_generation: desktop.generation,
        manifest_digest: hex::encode(Sha256::digest(
            serde_json::to_vec(&manifest)
                .map_err(|_| refused("managed_desktop_invalid_request"))?,
        )),
        agent_principal_id: Some(format!("acceptance:{}", row.run.acceptance_id)),
        criteria: input
            .criteria
            .iter()
            .enumerate()
            .map(|(i, c)| AcceptanceCriterion {
                id: format!("criterion-{i}"),
                text: c.description.clone(),
                required_evidence: c.screenshot_required,
            })
            .collect(),
    })
}
async fn read_result(
    directory: &Path,
    row: &AcceptanceRunRecord,
) -> Result<Option<AcceptanceResult>> {
    let owner = row.owner_principal_id.clone();
    let host = row.host_id.clone();
    let id = row.run.acceptance_id.clone();
    results::disk(directory, move |s| match s.get(&owner, &host, &id) {
        Ok(row) => Ok(Some(row)),
        Err(e)
            if matches!(
                e.as_str(),
                "evidence_not_found" | "evidence_deleted_or_deleting"
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    })
    .await
}
async fn reconcile_inner(
    directory: &Path,
    service: &ManagedDesktopService,
    events: &Option<HostEventSink>,
    serial: &tokio::sync::Mutex<()>,
) -> Result<()> {
    let _serial = serial.lock().await;
    reconcile_locked(directory, service, events).await
}
async fn reconcile_locked(
    directory: &Path,
    service: &ManagedDesktopService,
    events: &Option<HostEventSink>,
) -> Result<()> {
    for record in service.acceptance_records().await {
        let p = record.principal();
        let id = record.run.acceptance_id.clone();
        let result = read_result(directory, &record).await?;
        // A verdict's durable publication wins a simultaneous expiry/cancel.
        if result.as_ref().is_some_and(|r| r.agent_verdict.is_some())
            && record.run.state != AcceptanceRunState::Completed
        {
            service
                .acceptance_end(&p, &id, AcceptanceRunState::Completed, None)
                .await?;
        }
        let mut current = service.acceptance_record(&p, &id).await?;
        if current.run.state.active() {
            let root = directory.to_owned();
            let principal = p.clone();
            let prepare = request(&current.request);
            let live_source = tokio::task::spawn_blocking(move || {
                handoff_rpc::resolve(&root, &principal, &prepare).is_ok()
            })
            .await
            .unwrap_or(false);
            let enabled = service
                .effective_enablement(&p, &current.run.provider_config_id)
                .await
                .is_ok_and(|e| e.acceptance);
            if !live_source || !enabled {
                service
                    .acceptance_end(
                        &p,
                        &id,
                        AcceptanceRunState::Failed,
                        Some("managed_desktop_acceptance_authority_expired".into()),
                    )
                    .await?;
                current = service.acceptance_record(&p, &id).await?;
            }
        }
        if current.run.state.active() || !current.cleanup_pending {
            continue;
        }
        if let Some(result) = &result {
            let owner = p.owner_principal_id.clone();
            let host = p.host_id.clone();
            let acceptance = id.clone();
            let cancelled = current.run.state == AcceptanceRunState::Cancelled;
            let finish = result.agent_verdict.is_none() && result.system_outcome.is_none();
            results::disk(directory, move |s| {
                if finish {
                    s.finish_system(
                        &owner,
                        &host,
                        &acceptance,
                        if cancelled {
                            AcceptanceOutcome::Cancelled
                        } else {
                            AcceptanceOutcome::Inconclusive
                        },
                        if cancelled {
                            "acceptance_cancelled"
                        } else {
                            "acceptance_incomplete"
                        },
                    )?;
                }
                s.set_cleanup_pending(&owner, &host, &acceptance, true)
            })
            .await?;
        }
        let cleaned = if let Some(desktop) = &current.run.desktop_id {
            // Read the current generation for cleanup: a generation fence must
            // not leave the same owned resource billed indefinitely.
            match service
                .list(&p)
                .await?
                .into_iter()
                .find(|d| &d.id == desktop)
            {
                Some(d) => service
                    .delete(&p, &d.id, d.generation)
                    .await
                    .is_ok_and(|d| d.state == ManagedDesktopState::Destroyed),
                None => true,
            }
        } else {
            true
        };
        if cleaned {
            if result.is_some() {
                let owner = p.owner_principal_id.clone();
                let host = p.host_id.clone();
                let acceptance = id.clone();
                results::disk(directory, move |s| {
                    s.set_cleanup_pending(&owner, &host, &acceptance, false)
                })
                .await?;
            }
            service.acceptance_cleaned(&p, &id).await?;
        }
        emit(events);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunId {
    pub acceptance_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attach {
    pub acceptance_id: String,
    pub session_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    acceptance_id: String,
    session_key: String,
    criterion_id: String,
    idempotency_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finish {
    acceptance_id: String,
    session_key: String,
    idempotency_key: String,
    outcome: AcceptanceOutcome,
    criteria: Vec<CriterionResult>,
    summary: String,
}

struct ChildAuthority {
    service: ManagedDesktopService,
    p: ManagedDesktopPrincipal,
    id: String,
    session: String,
    owner_live: Arc<dyn Fn() -> bool + Send + Sync>,
}
#[async_trait::async_trait]
impl ManagedControlAuthority for ChildAuthority {
    async fn revalidate(&self, p: &ManagedDesktopPrincipal) -> Result<()> {
        if p.owner_principal_id != self.p.owner_principal_id
            || p.host_id != self.p.host_id
            || p.principal_id != self.p.principal_id
            || p.authority != ManagedDesktopAuthority::Agent
        {
            return Err(refused("managed_desktop_acceptance_delegation_required"));
        }
        self.service.reconcile_delegations().await?;
        if !(self.input_admission(p))() {
            return Err(refused("managed_desktop_acceptance_delegation_required"));
        }
        Ok(())
    }
    fn input_admission(&self, _: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let service = self.service.clone();
        let p = self.p.clone();
        let id = self.id.clone();
        let session = self.session.clone();
        let live = self.owner_live.clone();
        Arc::new(move || live() && service.acceptance_session_live(&p, &id, &session))
    }
}
fn local_tools(local: bool) -> Result<()> {
    if local {
        Ok(())
    } else {
        Err(refused("managed_desktop_acceptance_local_only"))
    }
}
pub(crate) async fn tools(
    directory: &Path,
    runtime: &AcceptanceRuntime,
    p: &ManagedDesktopPrincipal,
    authority: &dyn ManagedControlAuthority,
    local: bool,
    name: &str,
    args: Value,
) -> Result<Value> {
    local_tools(local)?;
    if !name.starts_with("managed_desktop_acceptance_")
        || !crate::managed_desktops::COMMANDS.contains(&name)
    {
        return Err(refused("managed_desktop_unknown_command"));
    }
    let decode =
        |v| serde_json::from_value(v).map_err(|_| refused("managed_desktop_invalid_request"));
    let (id, session) = if name == "managed_desktop_acceptance_checkpoint" {
        let a: Checkpoint = decode(args.clone())?;
        (a.acceptance_id, a.session_key)
    } else {
        let a: Finish = serde_json::from_value(args.clone())
            .map_err(|_| refused("managed_desktop_invalid_request"))?;
        (a.acceptance_id, a.session_key)
    };
    let agent = ManagedDesktopPrincipal {
        principal_id: format!("acceptance:{id}"),
        authority: ManagedDesktopAuthority::Agent,
        ..p.clone()
    };
    let child = ChildAuthority {
        service: (*runtime.service).clone(),
        p: agent.clone(),
        id: id.clone(),
        session,
        owner_live: authority.input_admission(p),
    };
    child.revalidate(&agent).await?;
    if name == "managed_desktop_acceptance_checkpoint" {
        let a: Checkpoint =
            serde_json::from_value(args).map_err(|_| refused("managed_desktop_invalid_request"))?;
        if a.idempotency_key.trim().is_empty() || a.idempotency_key.len() > 256 {
            return Err(refused("managed_desktop_invalid_request"));
        }
        // Canonical opaque artifact ID derived from this run's semantic retry.
        let hash = hex::encode(Sha256::digest(
            format!("{}:{}", id, a.idempotency_key).as_bytes(),
        ));
        let artifact = uuid::Uuid::parse_str(&hash[..32])
            .map_err(|_| refused("managed_desktop_invalid_request"))?
            .to_string();
        results::capture(
            directory,
            &runtime.service,
            &agent,
            &child,
            Capture {
                acceptance_id: id,
                artifact_id: artifact,
                criterion_id: a.criterion_id,
                kind: CaptureKind::Checkpoint,
            },
        )
        .await
    } else {
        let a: Finish =
            serde_json::from_value(args).map_err(|_| refused("managed_desktop_invalid_request"))?;
        let _serial = runtime.serial.lock().await;
        let value = results::complete(
            directory,
            &runtime.service,
            &agent,
            &child,
            Complete {
                acceptance_id: id,
                idempotency_key: a.idempotency_key,
                outcome: a.outcome,
                criteria: a.criteria,
                summary: a.summary,
            },
        )
        .await?;
        reconcile_locked(directory, &runtime.service, &runtime.events).await?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn criteria_flags_bind_the_production_manifest_and_wire_requests_are_closed() {
        let input = AcceptanceStartInput {
            delivery_id: "delivery".into(),
            delivery_revision: 1,
            mode: AcceptanceTransferMode::Commit,
            provider_config_id: "e2b".into(),
            lifetime_seconds: 120,
            criteria: vec![AcceptanceCriterionInput {
                description: "Page loads".into(),
                screenshot_required: true,
            }],
            acceptance_files: vec![],
            argv: vec![],
            quote_id: "quote".into(),
            idempotency_key: "key".into(),
        };
        let mut row = AcceptanceRunRecord {
            run: ManagedDesktopAcceptanceRun {
                acceptance_id: "run".into(),
                provider_config_id: "e2b".into(),
                delivery_id: "delivery".into(),
                commit: "a".repeat(40),
                mode: input.mode,
                state: AcceptanceRunState::Provisioning,
                desktop_id: None,
                desktop_generation: None,
                deadline_at: None,
                delegation_id: None,
                child_session_key: None,
                source: AcceptanceRunSource {
                    session_id: "source-session".into(),
                    task_id: Some("source-task".into()),
                    parent_run_id: Some("source-run".into()),
                },
                error_code: None,
                created_at: 1000,
                updated_at: 1000,
                ended_at: None,
            },
            owner_principal_id: "owner".into(),
            host_id: "host".into(),
            principal_id: "human".into(),
            account_binding_epoch: Some(1),
            account_binding_instance_id: Some("process".into()),
            request: input,
            source_id: "source".into(),
            origin_run_ref: "origin".into(),
            cleanup_pending: false,
        };
        let desktop = ManagedDesktop {
            id: "desktop".into(),
            provider_config_id: "e2b".into(),
            generation: 1,
            state: ManagedDesktopState::Running,
            deadline_at: 121000,
            idle_timeout_seconds: 600,
            created_at: 1000,
            updated_at: 1000,
            last_error_code: None,
            cleanup_attempts: 0,
            qualification: "qualified".into(),
        };
        let binding = production_binding(&row, &desktop, &"b".repeat(64)).unwrap();
        assert!(binding.criteria[0].required_evidence);
        assert_eq!(
            binding.agent_principal_id.as_deref(),
            Some("acceptance:run")
        );
        assert_eq!(binding.session_id, "source-session");
        assert_eq!(binding.parent_run_id, "source-run");
        row.request.criteria[0].screenshot_required = false;
        let changed = production_binding(&row, &desktop, &"b".repeat(64)).unwrap();
        assert!(!changed.criteria[0].required_evidence);
        assert_ne!(changed.manifest_digest, binding.manifest_digest);
        for key in [
            "ownerAccountId",
            "agentPrincipalId",
            "source",
            "sessionKey",
            "parentRunId",
        ] {
            let mut value = serde_json::to_value(&row.request).unwrap();
            value[key] = json!("forged");
            assert!(serde_json::from_value::<AcceptanceStartInput>(value).is_err());
        }
        let summary = serde_json::to_value(&row.run).unwrap();
        assert_eq!(summary.as_object().unwrap().len(), 16);
        assert!(summary["childSessionKey"].is_null());
        assert!(summary["endedAt"].is_null());
        assert_eq!(
            summary["source"],
            json!({"sessionId":"source-session","taskId":"source-task","parentRunId":"source-run"})
        );
        assert!(local_tools(true).is_ok());
        assert_eq!(
            local_tools(false).unwrap_err().code,
            "managed_desktop_acceptance_local_only"
        );
    }
}
