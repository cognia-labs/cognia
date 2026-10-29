//! In-app orchestration over the installed service. Native evidence producers
//! are shared with the stopped-Host operator; only approval/identity differ.
use super::*;
use cognia_automation::cua_sandbox::managed::service::qualification::run_workload_qualification_smoke;
use std::collections::BTreeMap;
use tokio::sync::watch;

pub use cognia_automation::cua_sandbox::managed::{
    ManagedDesktopQualificationRun, QualificationHandoff, QualificationScope,
};

const RUN_STOP_TIMEOUT: Duration = Duration::from_secs(1);
struct ActiveRun {
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
    task: tokio::task::JoinHandle<()>,
}
struct WorkTask(tokio::task::JoinHandle<Result<()>>);
impl Drop for WorkTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[cfg(test)]
type TestCategoryRunner = Arc<
    dyn Fn(
            Arc<RunHost>,
            NativeQualificationKind,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>>
        + Send
        + Sync,
>;
pub struct QualificationRuntime {
    #[cfg(test)]
    category_runner: Option<TestCategoryRunner>,
    service: Arc<ManagedDesktopService>,
    events: Option<HostEventSink>,
    active: parking_lot::Mutex<BTreeMap<String, ActiveRun>>,
}
impl Drop for QualificationRuntime {
    fn drop(&mut self) {
        for run in self.active.lock().values() {
            let _ = run.cancel.send(true);
            run.task.abort();
        }
    }
}
fn emit(events: &Option<HostEventSink>) {
    if let Some(events) = events {
        events(QUALIFICATION_CHANGED_TOPIC, serde_json::json!({}));
    }
}
fn permit() -> ExplicitPaidSmokeAuthorization {
    ExplicitPaidSmokeAuthorization::for_in_app_run()
}
struct RunHost {
    service: Arc<ManagedDesktopService>,
    p: ManagedDesktopPrincipal,
    run_id: String,
    cancelled: watch::Receiver<bool>,
    events: Option<HostEventSink>,
    current: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    handoffs: Arc<parking_lot::Mutex<Vec<String>>>,
    #[cfg(test)]
    category_runner: Option<TestCategoryRunner>,
}
#[async_trait]
impl ManagedDesktopSmokeHost for RunHost {
    fn provider(&self) -> Arc<dyn ManagedDesktopProvider> {
        self.service.diagnostic_provider()
    }
    fn open(&self, provider: Arc<dyn ManagedDesktopProvider>) -> Result<ManagedDesktopService> {
        Ok(self.service.qualification_handle(provider, &self.run_id))
    }
    async fn checkpoint(
        &self,
        service: ManagedDesktopService,
        _: Arc<dyn ManagedDesktopProvider>,
        desktops: &[String],
    ) -> Result<ManagedDesktopService> {
        service.diagnostic_control_checkpoint(desktops).await?;
        Ok(service)
    }
    async fn approve_quote(
        &self,
        quote: &ManagedDesktopQuote,
        purpose: AuthorizationPurpose,
    ) -> Result<()> {
        let current = self.current.clone();
        tokio::task::spawn_blocking(move || current())
            .await
            .map_err(|_| refused("managed_desktop_forbidden"))??;
        let mut changed = self.service.qualification_notifications(&self.run_id);
        self.service
            .qualification_await_quote(&self.p, &self.run_id, quote.clone(), purpose)
            .await?;
        emit(&self.events);
        let mut cancel = self.cancelled.clone();
        let expires_in = Duration::from_millis(
            quote
                .expires_at
                .saturating_sub(chrono::Utc::now().timestamp_millis())
                .max(0) as u64,
        );
        let expiry = tokio::time::sleep(expires_in);
        tokio::pin!(expiry);
        loop {
            if *cancel.borrow() {
                return Err(refused("managed_desktop_qualification_cancelled"));
            }
            let run = self
                .service
                .qualification_status(&self.p, &self.run_id)
                .await?;
            if run.state == QualificationRunState::Running && run.awaiting_approval.is_none() {
                return Ok(());
            }
            if !run.state.active() {
                return Err(refused("managed_desktop_qualification_cancelled"));
            }
            tokio::select! {
                result = changed.changed() => {
                    if result.is_err() { return Err(refused("managed_desktop_qualification_cancelled")); }
                },
                _ = cancel.changed() => {},
                _ = &mut expiry => return Err(refused("managed_desktop_quote_expired")),
            }
        }
    }
}
impl QualificationRuntime {
    pub fn new(service: Arc<ManagedDesktopService>, events: Option<HostEventSink>) -> Self {
        Self {
            service,
            events,
            active: Default::default(),
            #[cfg(test)]
            category_runner: None,
        }
    }
    pub async fn start(
        &self,
        directory: PathBuf,
        p: ManagedDesktopPrincipal,
        config: String,
        scope: QualificationScope,
        handoff: Option<QualificationHandoff>,
        current: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Result<ManagedDesktopQualificationRun> {
        p.require_admin()?;
        let delivery_revision = if let Some(handoff) = &handoff {
            handoff.validate()?;
            Some(
                crate::managed_desktop_handoff::list(&directory, &p)
                    .await?
                    .into_iter()
                    .find(|d| d.id == handoff.delivery_id)
                    .ok_or_else(|| refused("managed_desktop_handoff_delivery_unknown"))?
                    .revision,
            )
        } else {
            None
        };
        let check = current.clone();
        tokio::task::spawn_blocking(move || check())
            .await
            .map_err(|_| refused("managed_desktop_forbidden"))??;
        let run = self
            .service
            .qualification_start(&p, &config, scope, handoff)
            .await?;
        let (cancel, cancelled) = watch::channel(false);
        let (finished, wait_finished) = watch::channel(false);
        let handoffs = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let host = Arc::new(RunHost {
            service: self.service.clone(),
            p: p.clone(),
            run_id: run.run_id.clone(),
            cancelled: cancelled.clone(),
            events: self.events.clone(),
            current,
            handoffs: handoffs.clone(),
            #[cfg(test)]
            category_runner: self.category_runner.clone(),
        });
        let mut cancellation = cancelled;
        let events = self.events.clone();
        let service = self.service.clone();
        let run_id = run.run_id.clone();
        let selected = run.clone();
        let live = host.current.clone();
        let cleanup_directory = directory.clone();
        let task = tokio::spawn(async move {
            // A separate task turns panics in a native diagnostic into a failed
            // run, while its RAII guards unwind and durable cleanup still runs.
            let mut work = WorkTask(tokio::spawn(async move {
                orchestrate(host, directory, selected, delivery_revision).await
            }));
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            let outcome = loop {
                tokio::select! {
                    result = &mut work.0 => break result.unwrap_or_else(|_| Err(refused("managed_desktop_qualification_panicked"))),
                    _ = cancellation.changed() => {
                        work.0.abort(); let _ = (&mut work.0).await;
                        break Err(refused("managed_desktop_qualification_cancelled"));
                    }
                    _ = interval.tick() => {
                        let live = live.clone();
                        if !tokio::task::spawn_blocking(move || live()).await.is_ok_and(|r| r.is_ok())
                            // Recheck after a panicked worker as well as a revoked identity.
                        { work.0.abort(); let _ = (&mut work.0).await; break Err(refused("managed_desktop_forbidden")); }
                    }
                }
            };
            // The native transfer future may have been aborted. Finish every
            // claimed operation and acceptance row after unwinding its guards.
            let operations = handoffs.lock().clone();
            let mut handoff_error = None;
            for operation in operations {
                if let Err(error) = crate::managed_desktop_handoff_operator::finish_interrupted(
                    &cleanup_directory,
                    &service,
                    &p,
                    &operation,
                )
                .await
                {
                    handoff_error.get_or_insert(error);
                } else if let Err(error) = service
                    .qualification_handoff_operation(&p, &run_id, &operation, false)
                    .await
                {
                    handoff_error.get_or_insert(error);
                }
            }
            let cleanup = service
                .qualification_cleanup(&p, &run_id)
                .await
                .and_then(|_| handoff_error.map_or(Ok(()), Err));
            let terminal = if *cancellation.borrow() {
                QualificationRunState::Cancelled
            } else if outcome.is_ok() && cleanup.is_ok() {
                QualificationRunState::Passed
            } else {
                QualificationRunState::Failed
            };
            let error = if terminal == QualificationRunState::Cancelled {
                cleanup.err().map(|e| e.code)
            } else {
                outcome.err().or_else(|| cleanup.err()).map(|e| e.code)
            };
            if let Err(error) = service
                .qualification_finish(&p, &run_id, terminal, error)
                .await
            {
                log::warn!("managed desktop qualification finalization: {}", error.code);
            }
            if let Err(error) = reconcile_devices(&service).await {
                log::warn!(
                    "managed desktop qualification device cleanup: {}",
                    error.code
                );
            }
            emit(&events);
            let _ = finished.send(true);
        });
        {
            let mut active = self.active.lock();
            active.retain(|_, r| !r.task.is_finished());
            active.insert(
                run.run_id.clone(),
                ActiveRun {
                    cancel,
                    finished: wait_finished,
                    task,
                },
            );
        }
        emit(&self.events);
        Ok(run)
    }
    pub fn has_active_tasks(&self) -> bool {
        self.active
            .lock()
            .values()
            .any(|run| !run.task.is_finished())
    }
    pub async fn shutdown(&self) {
        let runs = std::mem::take(&mut *self.active.lock());
        for run in runs.values() {
            let _ = run.cancel.send(true);
        }
        let deadline = tokio::time::Instant::now() + RUN_STOP_TIMEOUT;
        for (_, mut run) in runs {
            if tokio::time::timeout_at(deadline, &mut run.task)
                .await
                .is_err()
            {
                run.task.abort();
                let _ = run.task.await;
            }
        }
    }
    pub async fn approve(
        &self,
        p: &ManagedDesktopPrincipal,
        run: &str,
        quote: &str,
    ) -> Result<ManagedDesktopQualificationRun> {
        let result = self.service.qualification_approve(p, run, quote).await?;
        emit(&self.events);
        Ok(result)
    }
    pub async fn cancel(
        &self,
        p: &ManagedDesktopPrincipal,
        run: &str,
    ) -> Result<ManagedDesktopQualificationRun> {
        p.require_admin()?;
        self.service.qualification_status(p, run).await?;
        // Terminal state fences a queued authorize/create before cancellation
        // drops the native future. Cleanup uses the already persisted intents.
        self.service
            .qualification_finish(p, run, QualificationRunState::Cancelled, None)
            .await?;
        let wait = self.active.lock().get(run).map(|active| {
            let _ = active.cancel.send(true);
            active.finished.clone()
        });
        let cleanup = async {
            if let Some(mut wait) = wait {
                while !*wait.borrow() && wait.changed().await.is_ok() {}
            } else {
                self.service.qualification_cleanup(p, run).await?;
            }
            Ok::<(), ManagedDesktopError>(())
        };
        let error = match tokio::time::timeout(RUN_STOP_TIMEOUT, cleanup).await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error.code),
            Err(_) => Some("managed_desktop_smoke_cleanup_pending".into()),
        };
        if let Some(error) = error {
            self.service
                .qualification_finish(p, run, QualificationRunState::Cancelled, Some(error))
                .await?;
        }
        // A timed-out worker remains owned by the runtime. Its durable delete
        // intents are retried by reconciliation and shutdown can still join it.
        self.active
            .lock()
            .retain(|_, active| !active.task.is_finished());
        emit(&self.events);
        self.service.qualification_status(p, run).await
    }
}
async fn orchestrate(
    host: Arc<RunHost>,
    directory: PathBuf,
    run: ManagedDesktopQualificationRun,
    delivery_revision: Option<u64>,
) -> Result<()> {
    let service = &host.service;
    let p = &host.p;
    let config = &run.provider_config_id;
    for category in &run.categories {
        let kind = category.category;
        let current = host.current.clone();
        tokio::task::spawn_blocking(move || current())
            .await
            .map_err(|_| refused("managed_desktop_forbidden"))??;
        service
            .qualification_category(p, &run.run_id, kind, QualificationCategoryState::Running)
            .await?;
        emit(&host.events);
        #[cfg(test)]
        let handled = if let Some(runner) = &host.category_runner {
            runner(host.clone(), kind).await?;
            true
        } else {
            false
        };
        #[cfg(not(test))]
        let handled = false;
        if !handled {
            match kind {
                NativeQualificationKind::Lifecycle => {
                    run_qualification_smoke(&*host, p, config, permit()).await?;
                }
                NativeQualificationKind::Control => {
                    run_control_qualification_smoke(&*host, p, config, permit()).await?;
                }
                NativeQualificationKind::Authority => {
                    let evidence = authority_operator::run_installed(
                        &*host,
                        service,
                        p,
                        config,
                        &run.run_id,
                        permit(),
                    )
                    .await?;
                    service
                        .record_authority_qualification_smoke(p, config, evidence, permit())
                        .await?;
                }
                NativeQualificationKind::Workload => {
                    run_workload_qualification_smoke(&*host, p, config, permit()).await?;
                }
                NativeQualificationKind::Commit | NativeQualificationKind::Bundle => {
                    let handoff = run
                        .handoff
                        .as_ref()
                        .ok_or_else(|| refused("managed_desktop_handoff_delivery_unknown"))?;
                    use crate::managed_desktop_handoff::{PrepareHandoff, TransferMode};
                    let request = PrepareHandoff {
                        delivery_id: handoff.delivery_id.clone(),
                        delivery_revision: delivery_revision
                            .ok_or_else(|| refused("managed_desktop_handoff_delivery_unknown"))?,
                        mode: if kind == NativeQualificationKind::Commit {
                            TransferMode::Commit
                        } else {
                            TransferMode::Bundle
                        },
                        provider_config_id: config.clone(),
                        lifetime_seconds: 240,
                        criteria: vec!["Qualification launch and private checkpoint".into()],
                        acceptance_files: vec![],
                        argv: vec!["npm".into(), "run".into(), handoff.script.clone()],
                    };
                    let operation_id = uuid::Uuid::new_v4().to_string();
                    service
                        .qualification_handoff_operation(p, &run.run_id, &operation_id, true)
                        .await?;
                    host.handoffs.lock().push(operation_id.clone());
                    crate::managed_desktop_handoff_operator::run_request(
                        &*host,
                        p,
                        &directory,
                        config,
                        crate::managed_desktop_handoff_operator::DiagnosticRequest {
                            operation_id,
                            request,
                        },
                        true,
                    )
                    .await?;
                }
            }
        }
        service
            .qualification_category(p, &run.run_id, kind, QualificationCategoryState::Passed)
            .await?;
        emit(&host.events);
    }
    if run.scope == QualificationScope::Acceptance {
        service
            .complete_native_qualification(p, config, permit())
            .await?;
    }
    Ok(())
}
/// Crash recovery and bounded-shutdown cleanup share the same finally path.
pub async fn reconcile_handoffs(directory: &Path, service: &ManagedDesktopService) -> Result<()> {
    let mut first_error = None;
    for (run, operation, p) in service.qualification_orphan_handoffs().await {
        let result = async {
            crate::managed_desktop_handoff_operator::finish_interrupted(
                directory, service, &p, &operation,
            )
            .await?;
            service
                .qualification_handoff_operation(&p, &run, &operation, false)
                .await
        }
        .await;
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Also runs on startup: an interrupted run cannot leave a paired owner behind.
pub async fn reconcile_devices(service: &ManagedDesktopService) -> Result<()> {
    let mut first_error = None;
    for (id, tenant, device, p) in service.qualification_orphan_devices().await {
        let result = async {
            authority_operator::wait_for_enrollment(&device).await?;
            let store = security_store().ok_or_else(|| refused("managed_desktop_forbidden"))?;
            tokio::task::spawn_blocking(move || {
                authority_operator::clean_device(&store, &tenant, &device)
            })
            .await
            .map_err(|_| refused("managed_desktop_forbidden"))??;
            service.qualification_device(&p, &id, None).await
        }
        .await;
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_automation::cua_sandbox::managed::provider::{
        CreatedDesktop, LifecycleAdmission, ProviderDesktop,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeProvider {
        resources: tokio::sync::Mutex<BTreeMap<String, ProviderDesktop>>,
        creates: AtomicUsize,
        delete_blocked: std::sync::atomic::AtomicBool,
        delete_started: tokio::sync::Notify,
        delete_resume: tokio::sync::Notify,
    }
    #[async_trait]
    impl ManagedDesktopProvider for FakeProvider {
        async fn verify_release(&self, _: &ManagedDesktopConfig) -> Result<()> {
            Ok(())
        }
        async fn verify_smoke_egress(
            &self,
            _: &DesktopRecord,
            _: &DesktopSecrets,
        ) -> Result<EgressProbeReport> {
            Err(refused("test_unused_egress"))
        }
        async fn observe_boundary(
            &self,
            _: &DesktopRecord,
            _: &DesktopSecrets,
        ) -> Result<ProcessBoundaryReport> {
            serde_json::from_value(serde_json::json!({
                "reportVersion":1,"workloadIsolationRevision":1,"phase":"desktopLive",
                "boundaryGeneration":"6a370d8e-2d69-40fb-9586-786b7424365a",
                "namespaceInitPid":20,"namespaceInitStartTime":1,"workloadPid":21,"workloadStartTime":2,
                "namespaces":{"user":"user:[2]","mnt":"mnt:[2]","pid":"pid:[2]","net":"net:[2]","ipc":"ipc:[2]","uts":"uts:[2]","cgroup":"cgroup:[2]"},
                "providerNamespaces":{"user":"user:[1]","mnt":"mnt:[1]","pid":"pid:[1]","net":"net:[1]","ipc":"ipc:[1]","uts":"uts:[1]","cgroup":"cgroup:[1]"},
                "status":"Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n",
                "networkDevices":"header\nheader\n lo: 0\n","ipv4Routes":"header\n","ipv6Routes":"",
                "descriptors":{"0":{"target":"/dev/null","flags":0,"socketScope":null},"1":{"target":"/dev/null","flags":0,"socketScope":null},"2":{"target":"/dev/null","flags":0,"socketScope":null}}
            })).map_err(|_| refused("test_boundary_invalid"))
        }
        async fn register_template(
            &self,
            c: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &str,
            admission: LifecycleAdmission,
        ) -> Result<TemplateIdentity> {
            admission()?;
            Ok(TemplateIdentity {
                template_id: "template".into(),
                build_id: uuid::Uuid::new_v4().to_string(),
                image_digest: c.release.image_digest.clone(),
                recipe_revision: c.release.recipe_revision.clone(),
                protocol: c.release.protocol.clone(),
            })
        }
        async fn start_template(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &TemplateIdentity,
            admission: LifecycleAdmission,
        ) -> Result<()> {
            admission()
        }
        async fn template_status(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &TemplateIdentity,
        ) -> Result<TemplateState> {
            Ok(TemplateState::Ready)
        }
        async fn delete_template(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &str,
        ) -> Result<bool> {
            Ok(true)
        }
        async fn create(
            &self,
            row: &DesktopRecord,
            _: &ProviderSecret,
            secrets: &DesktopSecrets,
            _: u64,
            admission: LifecycleAdmission,
        ) -> Result<CreatedDesktop> {
            admission()?;
            let id = format!("resource-{}", self.creates.fetch_add(1, Ordering::SeqCst));
            let resource = ProviderDesktop {
                resource_id: id.clone(),
                running: true,
                metadata: row.metadata(),
                template_id: Some(row.template.template_id.clone()),
                deadline_at: Some(row.desktop.deadline_at),
                kill_on_timeout: true,
                auto_resume: false,
                private_ingress: true,
                allow_out: vec![],
                deny_out: vec!["0.0.0.0/0".into()],
            };
            self.resources.lock().await.insert(id, resource.clone());
            Ok(CreatedDesktop {
                resource,
                secrets: secrets.clone(),
            })
        }
        async fn inspect(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            id: &str,
        ) -> Result<Option<ProviderDesktop>> {
            Ok(self.resources.lock().await.get(id).cloned())
        }
        async fn list(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            metadata: &BTreeMap<String, String>,
        ) -> Result<Vec<ProviderDesktop>> {
            Ok(self
                .resources
                .lock()
                .await
                .values()
                .filter(|r| metadata.iter().all(|(k, v)| r.metadata.get(k) == Some(v)))
                .cloned()
                .collect())
        }
        async fn delete(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            id: &str,
        ) -> Result<()> {
            if self.delete_blocked.load(Ordering::SeqCst) {
                self.delete_started.notify_one();
                self.delete_resume.notified().await;
            }
            self.resources.lock().await.remove(id);
            Ok(())
        }
        async fn bootstrap(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<()> {
            Ok(())
        }
        async fn health(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<()> {
            Ok(())
        }
    }
    async fn fixture() -> (
        tempfile::TempDir,
        Arc<ManagedDesktopService>,
        ManagedDesktopPrincipal,
        Arc<FakeProvider>,
    ) {
        let provider = Arc::new(FakeProvider::default());
        let (directory, service, p) =
            super::super::tests::qualification_fixture_with_provider(None, provider.clone()).await;
        service
            .set_credential(
                &p,
                "e2b",
                1,
                ProviderSecret::parse("fake-provider-key").unwrap(),
            )
            .await
            .unwrap();
        (directory, service, p, provider)
    }
    // The runtime/state/approval/provider integration is exercised here. Wire
    // control and native evidence producers have their own fixed-runner suites;
    // this mock deliberately cannot manufacture qualification receipts.
    async fn paid_desktop(
        host: &RunHost,
        kind: NativeQualificationKind,
        source: String,
    ) -> Result<ManagedDesktop> {
        if kind == NativeQualificationKind::Lifecycle {
            let quote = host.service.quote(&host.p, "e2b", 120).await?;
            host.approve_quote(&quote, AuthorizationPurpose::PrepareTemplate)
                .await?;
            let auth = host
                .service
                .authorize(
                    &host.p,
                    "e2b",
                    &quote.id,
                    AuthorizationPurpose::PrepareTemplate,
                    None,
                )
                .await?;
            host.service
                .prepare_template(
                    &host.p,
                    CreateManagedDesktop {
                        provider_config_id: "e2b".into(),
                        quote_id: quote.id,
                        authorization_id: auth.id,
                        idempotency_key: uuid::Uuid::new_v4().to_string(),
                    },
                )
                .await?;
        }
        let quote = host.service.quote(&host.p, "e2b", 120).await?;
        host.approve_quote(&quote, AuthorizationPurpose::Smoke)
            .await?;
        let auth = host
            .service
            .authorize(
                &host.p,
                "e2b",
                &quote.id,
                AuthorizationPurpose::Smoke,
                Some(source),
            )
            .await?;
        host.service
            .create_smoke(
                &host.p,
                CreateManagedDesktop {
                    provider_config_id: "e2b".into(),
                    quote_id: quote.id,
                    authorization_id: auth.id,
                    idempotency_key: uuid::Uuid::new_v4().to_string(),
                },
            )
            .await
    }
    fn category_runner() -> TestCategoryRunner {
        Arc::new(|host, kind| {
            Box::pin(async move {
                let desktop = paid_desktop(&host, kind, "runtime-test".into()).await?;
                host.service
                    .delete(&host.p, &desktop.id, desktop.generation)
                    .await?;
                Ok(())
            })
        })
    }
    async fn awaiting(
        service: &ManagedDesktopService,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> ManagedDesktopQualificationRun {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let run = service.qualification_status(p, id).await.unwrap();
                if run.state == QualificationRunState::AwaitingApproval {
                    break run;
                }
                assert!(run.state.active(), "unexpected terminal state: {run:?}");
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    async fn drive(
        runtime: &QualificationRuntime,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> ManagedDesktopQualificationRun {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let run = runtime.service.qualification_status(p, id).await.unwrap();
                if let Some(approval) = run.awaiting_approval {
                    runtime.approve(p, id, &approval.quote.id).await.unwrap();
                } else if !run.state.active() {
                    break run;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test(flavor = "current_thread")]
    async fn full_gui_runtime_run_approves_each_paid_step_and_passes_with_fake_provider() {
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, provider) = fixture().await;
        let mut runtime = QualificationRuntime::new(service.clone(), None);
        runtime.category_runner = Some(category_runner());
        let run = runtime
            .start(
                directory.path().into(),
                p.clone(),
                "e2b".into(),
                QualificationScope::Gui,
                None,
                Arc::new(|| Ok(())),
            )
            .await
            .unwrap();
        let first = awaiting(&service, &p, &run.run_id).await;
        assert_eq!(provider.creates.load(Ordering::SeqCst), 0);
        assert!(first.awaiting_approval.unwrap().template_build_charges);
        assert_eq!(
            runtime
                .approve(&p, &run.run_id, "other-quote")
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_quote_mismatch"
        );
        let passed = drive(&runtime, &p, &run.run_id).await;
        assert_eq!(passed.state, QualificationRunState::Passed);
        assert!(passed
            .categories
            .iter()
            .all(|c| c.state == QualificationCategoryState::Passed));
        assert_eq!(provider.creates.load(Ordering::SeqCst), 4);
        assert!(provider.resources.lock().await.is_empty());
        assert!(
            !service.list_configs(&p).await.unwrap()[0]
                .enablement
                .manual_gui
        );
        runtime.shutdown().await;
    }
    #[tokio::test(flavor = "current_thread")]
    async fn approve_after_runtime_cancel_is_refused_and_shutdown_releases_the_installed_journal() {
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, _) = fixture().await;
        let runtime = qualification_runtime().unwrap();
        let run = runtime
            .start(
                directory.path().into(),
                p.clone(),
                "e2b".into(),
                QualificationScope::Gui,
                None,
                Arc::new(|| Ok(())),
            )
            .await
            .unwrap();
        let quote = awaiting(&service, &p, &run.run_id)
            .await
            .awaiting_approval
            .unwrap()
            .quote
            .id;
        assert_eq!(
            runtime.cancel(&p, &run.run_id).await.unwrap().state,
            QualificationRunState::Cancelled
        );
        assert_eq!(
            runtime
                .approve(&p, &run.run_id, &quote)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_not_awaiting"
        );
        let next = runtime
            .start(
                directory.path().into(),
                p.clone(),
                "e2b".into(),
                QualificationScope::Gui,
                None,
                Arc::new(|| Ok(())),
            )
            .await
            .unwrap();
        awaiting(&service, &p, &next.run_id).await;
        let weak = Arc::downgrade(&service);
        drop(runtime);
        drop(service);
        shutdown();
        tokio::time::timeout(Duration::from_secs(4), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(journal::JournalStore::open(directory.path()).is_ok());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn interrupted_authority_device_is_cleaned_after_startup_without_changing_the_account() {
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, provider) = fixture().await;
        let binding = host_identity::current().unwrap();
        let store = security_store().unwrap();
        let before = store.list_devices(&binding.remote_tenant_id).unwrap();
        let run = service
            .qualification_start(&p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let device = "crashed-qualification";
        service
            .qualification_device(
                &p,
                &run.run_id,
                Some((binding.remote_tenant_id.clone(), device.into())),
            )
            .await
            .unwrap();
        authority_operator::enroll(&store, &binding.remote_tenant_id, device).unwrap();
        shutdown();
        drop(service);
        let reopened = ManagedDesktopService::open(
            directory.path(),
            "test-host".into(),
            provider,
            Arc::new(FileManagedDesktopSecrets::open(&directory.path().join("vault")).unwrap()),
            None,
        )
        .unwrap();
        assert_eq!(
            reopened
                .qualification_status(&p, &run.run_id)
                .await
                .unwrap()
                .state,
            QualificationRunState::Interrupted
        );
        reconcile_devices(&reopened).await.unwrap();
        assert!(reopened.qualification_orphan_devices().await.is_empty());
        assert!(store
            .device_state(&binding.remote_tenant_id, device)
            .unwrap()
            .is_none());
        assert_eq!(host_identity::current().unwrap(), binding);
        assert!(Arc::ptr_eq(&security_store().unwrap(), &store));
        assert_eq!(
            store.list_devices(&binding.remote_tenant_id).unwrap().len(),
            before.len()
        );
        assert!(authority_operator::enroll(&store, &binding.remote_tenant_id, device).is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn device_publication_and_cancel_interleavings_cannot_orphan_an_owner() {
        let _scope = super::super::tests::TestScope::new();
        let (_directory, service, p, _) = fixture().await;
        let binding = host_identity::current().unwrap();
        let store = security_store().unwrap();
        for before_pointer in [true, false] {
            let run = service
                .qualification_start(&p, "e2b", QualificationScope::Gui, None)
                .await
                .unwrap();
            let device = format!("enrollment-race-{before_pointer}");
            let enrollment = authority_operator::enrollment_scope(&device).await.unwrap();
            if !before_pointer {
                service
                    .qualification_device(
                        &p,
                        &run.run_id,
                        Some((binding.remote_tenant_id.clone(), device.clone())),
                    )
                    .await
                    .unwrap();
            }
            service
                .qualification_finish(&p, &run.run_id, QualificationRunState::Cancelled, None)
                .await
                .unwrap();
            if before_pointer {
                reconcile_devices(&service).await.unwrap();
                assert_eq!(
                    service
                        .qualification_device(
                            &p,
                            &run.run_id,
                            Some((binding.remote_tenant_id.clone(), device.clone()))
                        )
                        .await
                        .unwrap_err()
                        .code,
                    "managed_desktop_qualification_not_awaiting"
                );
                drop(enrollment);
            } else {
                let copied = service.clone();
                let cleanup = tokio::spawn(async move { reconcile_devices(&copied).await });
                tokio::task::yield_now().await;
                assert!(!cleanup.is_finished());
                authority_operator::enroll(&store, &binding.remote_tenant_id, &device).unwrap();
                drop(enrollment);
                cleanup.await.unwrap().unwrap();
            }
            assert!(store
                .device_state(&binding.remote_tenant_id, &device)
                .unwrap()
                .is_none());
            assert!(service.qualification_orphan_devices().await.is_empty());
        }
        assert_eq!(host_identity::current().unwrap(), binding);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_and_shutdown_bound_a_stuck_provider_and_keep_durable_cleanup() {
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, provider) = fixture().await;
        provider.delete_blocked.store(true, Ordering::SeqCst);
        let mut runtime = QualificationRuntime::new(service.clone(), None);
        runtime.category_runner = Some(category_runner());
        let runtime = Arc::new(runtime);
        let run = runtime
            .start(
                directory.path().into(),
                p.clone(),
                "e2b".into(),
                QualificationScope::Gui,
                None,
                Arc::new(|| Ok(())),
            )
            .await
            .unwrap();
        for _ in 0..2 {
            let approval = awaiting(&service, &p, &run.run_id)
                .await
                .awaiting_approval
                .unwrap();
            runtime
                .approve(&p, &run.run_id, &approval.quote.id)
                .await
                .unwrap();
        }
        provider.delete_started.notified().await;
        let cancelled = tokio::time::timeout(
            RUN_STOP_TIMEOUT + Duration::from_millis(500),
            runtime.cancel(&p, &run.run_id),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(cancelled.state, QualificationRunState::Cancelled);
        assert_eq!(
            cancelled.error_code.as_deref(),
            Some("managed_desktop_smoke_cleanup_pending")
        );
        let desktops = service.list(&p).await.unwrap();
        assert_eq!(desktops.len(), 1);
        assert_ne!(desktops[0].state, ManagedDesktopState::Destroyed);
        tokio::time::timeout(
            RUN_STOP_TIMEOUT + Duration::from_millis(500),
            runtime.shutdown(),
        )
        .await
        .unwrap();
        assert!(runtime.active.lock().is_empty());
        // The worker was aborted, but the already committed delete intent can
        // be finished by the normal reconciler once the provider responds.
        provider.delete_blocked.store(false, Ordering::SeqCst);
        service.reconcile().await.unwrap();
        assert_eq!(
            service.list(&p).await.unwrap()[0].state,
            ManagedDesktopState::Destroyed
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancel_mid_handoff_closes_the_operation_and_system_acceptance_row() {
        use cognia_automation::cua_sandbox::managed::evidence::*;
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, provider) = fixture().await;
        let ready = Arc::new(tokio::sync::Notify::new());
        let signal = ready.clone();
        let operation = uuid::Uuid::new_v4().to_string();
        let id = operation.clone();
        let root = directory.path().to_owned();
        let mut runtime = QualificationRuntime::new(service.clone(), None);
        runtime.category_runner = Some(Arc::new(move |host, kind| {
            let root = root.clone();
            let id = id.clone();
            let signal = signal.clone();
            Box::pin(async move {
                host.handoffs.lock().push(id.clone());
                crate::managed_desktop_handoff_operator::claim_operation(&root, &id).await?;
                let desktop = paid_desktop(&host, kind, format!("handoff:{id}")).await?;
                let owner = host.p.owner_principal_id.clone();
                let host_id = host.p.host_id.clone();
                tokio::task::spawn_blocking(move || {
                    EvidenceStore::new(&root)
                        .register(
                            &owner,
                            &host_id,
                            AcceptanceBinding {
                                acceptance_id: id,
                                owner_account_id: owner.clone(),
                                host_id: host_id.clone(),
                                source_id: "source".into(),
                                session_id: "chat".into(),
                                task_id: "task".into(),
                                parent_run_id: "parent".into(),
                                origin_run_ref: Some("origin".into()),
                                delivery_id: "delivery".into(),
                                delivery_revision: 1,
                                commit: "a".repeat(40),
                                desktop_id: desktop.id,
                                desktop_generation: desktop.generation,
                                manifest_digest: "b".repeat(64),
                                agent_principal_id: None,
                                criteria: vec![AcceptanceCriterion {
                                    id: "loads".into(),
                                    text: "loads".into(),
                                    required_evidence: true,
                                }],
                            },
                        )
                        .unwrap();
                })
                .await
                .unwrap();
                signal.notify_one();
                std::future::pending::<Result<()>>().await
            })
        }));
        let run = runtime
            .start(
                directory.path().into(),
                p.clone(),
                "e2b".into(),
                QualificationScope::Gui,
                None,
                Arc::new(|| Ok(())),
            )
            .await
            .unwrap();
        for _ in 0..2 {
            let approval = awaiting(&service, &p, &run.run_id)
                .await
                .awaiting_approval
                .unwrap();
            runtime
                .approve(&p, &run.run_id, &approval.quote.id)
                .await
                .unwrap();
        }
        ready.notified().await;
        assert_eq!(
            runtime.cancel(&p, &run.run_id).await.unwrap().state,
            QualificationRunState::Cancelled
        );
        let report: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                directory
                    .path()
                    .join("managed-desktop-handoffs")
                    .join(format!("{operation}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(report["state"], "failed");
        assert_eq!(report["cleanupPending"], false);
        let result = EvidenceStore::new(directory.path())
            .get(&p.owner_principal_id, &p.host_id, &operation)
            .unwrap();
        assert_eq!(
            result.system_outcome.unwrap().outcome,
            AcceptanceOutcome::Inconclusive
        );
        assert!(!result.cleanup_pending);
        assert!(provider.resources.lock().await.is_empty());
        runtime.shutdown().await;
    }
    #[tokio::test(flavor = "current_thread")]
    async fn startup_closes_a_claimed_handoff_interrupted_before_desktop_creation() {
        use cognia_automation::cua_sandbox::managed::evidence::*;
        let _scope = super::super::tests::TestScope::new();
        let (directory, service, p, provider) = fixture().await;
        let run = service
            .qualification_start(&p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        service
            .qualification_handoff_operation(&p, &run.run_id, &operation, true)
            .await
            .unwrap();
        crate::managed_desktop_handoff_operator::claim_operation(directory.path(), &operation)
            .await
            .unwrap();
        let store = EvidenceStore::new(directory.path());
        store
            .register(
                &p.owner_principal_id,
                &p.host_id,
                AcceptanceBinding {
                    acceptance_id: operation.clone(),
                    owner_account_id: p.owner_principal_id.clone(),
                    host_id: p.host_id.clone(),
                    source_id: "source".into(),
                    session_id: "chat".into(),
                    task_id: "task".into(),
                    parent_run_id: "parent".into(),
                    origin_run_ref: Some("origin".into()),
                    delivery_id: "delivery".into(),
                    delivery_revision: 1,
                    commit: "a".repeat(40),
                    desktop_id: "desktop".into(),
                    desktop_generation: 1,
                    manifest_digest: "b".repeat(64),
                    agent_principal_id: None,
                    criteria: vec![AcceptanceCriterion {
                        id: "loads".into(),
                        text: "loads".into(),
                        required_evidence: true,
                    }],
                },
            )
            .unwrap();
        shutdown();
        drop(service);
        let reopened = ManagedDesktopService::open(
            directory.path(),
            "test-host".into(),
            provider,
            Arc::new(FileManagedDesktopSecrets::open(&directory.path().join("vault")).unwrap()),
            None,
        )
        .unwrap();
        assert_eq!(
            reopened
                .qualification_status(&p, &run.run_id)
                .await
                .unwrap()
                .state,
            QualificationRunState::Interrupted
        );
        reconcile_handoffs(directory.path(), &reopened)
            .await
            .unwrap();
        assert!(reopened.qualification_orphan_handoffs().await.is_empty());
        let result = store
            .get(&p.owner_principal_id, &p.host_id, &operation)
            .unwrap();
        assert_eq!(
            result.system_outcome.unwrap().outcome,
            AcceptanceOutcome::Inconclusive
        );
        assert!(!result.cleanup_pending);
        let report: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                directory
                    .path()
                    .join("managed-desktop-handoffs")
                    .join(format!("{operation}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(report["state"], "failed");
        assert_eq!(report["cleanupPending"], false);
    }
}
