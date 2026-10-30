//! Authenticated Host routing for ADR-0233. Caller identity is never RPC data.
use std::{path::{Path, PathBuf}, sync::Arc, time::Duration};

use async_trait::async_trait;
use cognia_automation::automation::{
    dispatcher::{run_gated_enf, Enforcement, GateContext},
    permission::Surface,
    session::UiAction,
    types::{AutomationError, Point},
};
use cognia_automation::cua_sandbox::managed::{
    provider::{DesktopSecrets, ProviderSecret},
    *,
};
use cognia_companion::{host_identity, security_store::security_store};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;

pub(crate) const SECRET_SERVICE: &str = "cognia-managed-desktops";
pub const COMMANDS: &[&str] = &[
    "managed_desktop_results_get_results",
    "managed_desktop_results_get_result",
    "managed_desktop_results_read_evidence",
    "managed_desktop_results_approve",
    "managed_desktop_results_capture",
    "managed_desktop_results_complete",
    "managed_desktop_results_prepare_delete",
    "managed_desktop_results_commit_delete",
    "managed_desktop_results_abort_delete",

    "managed_desktop_handoff_source_host",
    "managed_desktop_handoff_deliveries",
    "managed_desktop_handoff_prepare",
    "managed_desktop_handoff_revoke_source",
    "managed_desktop_release_status",
    "managed_desktop_config_save",
    "managed_desktop_config_delete",
    "managed_desktop_config_set_credential",
    "managed_desktop_config_rotate_credential",
    "managed_desktop_template_list",
    "managed_desktop_template_delete",
    "managed_desktop_monitor",
    "managed_desktop_qualify_start",
    "managed_desktop_qualify_status",
    "managed_desktop_qualify_list",
    "managed_desktop_qualify_approve",
    "managed_desktop_qualify_cancel",
    "managed_desktop_delegate",
    "managed_desktop_delegation_revoke",
    "managed_desktop_delegation_list",
    "managed_desktop_acceptance_start",
    "managed_desktop_acceptance_attach",
    "managed_desktop_acceptance_cancel",
    "managed_desktop_acceptance_status",
    "managed_desktop_acceptance_list",
    "managed_desktop_acceptance_checkpoint",
    "managed_desktop_acceptance_complete",
    "managed_desktop_list_configs",
    "managed_desktop_list",
    "managed_desktop_quote",
    "managed_desktop_authorize",
    "managed_desktop_prepare_template",
    "managed_desktop_create",
    "managed_desktop_connect",
    "managed_desktop_health",
    "managed_desktop_delete",
    "managed_desktop_control_status",
    "managed_desktop_control_frame",
    "managed_desktop_control_acquire",
    "managed_desktop_control_renew",
    "managed_desktop_control_release",
    "managed_desktop_control_input",
    "managed_desktop_files_read",
    "managed_desktop_files_write",
    "managed_desktop_clipboard_get",
    "managed_desktop_clipboard_set",
];
/// Recipe-8 guest operations (ADR-0233 A8): the subset of [`COMMANDS`] that
/// needs the live control runtime and a current recipe-8 receipt.
pub const OPERATION_COMMANDS: &[&str] = &[
    "managed_desktop_files_read",
    "managed_desktop_files_write",
    "managed_desktop_clipboard_get",
    "managed_desktop_clipboard_set",
];
pub use crate::managed_desktop_acceptance::ACCEPTANCE_CHANGED_TOPIC;

pub type HostEventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub type AdminAuthorityCheck = Arc<dyn Fn() -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct ManagedControlRuntime {
    pub enforcement: Enforcement,
    pub events: HostEventSink,
    pub refresh_persisted: bool,
}
static HEADLESS_ENFORCEMENT: Lazy<Enforcement> = Lazy::new(|| Enforcement {
    gate: cognia_automation::automation::permission::PermissionGate::new(Default::default()),
    audit: cognia_automation::automation::audit::AuditRing::new(),
    consent: cognia_automation::automation::consent::ConsentBroker::new(),
    policy: Default::default(),
    consent_event_sink: None,
});

#[derive(Default)]
struct HeadlessPolicySnapshot {
    version: u64,
    fingerprint: Vec<u8>,
    available: bool,
}
static HEADLESS_POLICY_SNAPSHOT: Lazy<RwLock<HeadlessPolicySnapshot>> = Lazy::new(Default::default);
static HEADLESS_POLICY_REFRESH: Lazy<parking_lot::Mutex<()>> = Lazy::new(Default::default);

/// File reads and regex compilation belong on the blocking pool, never the
/// websocket command pump. Refreshes serialize so an older read cannot replace
/// a newer snapshot. Publishing invalidates in-flight actions before replacing
/// either shared enforcement component.
async fn refresh_headless_policy() -> Result<()> {
    tokio::task::spawn_blocking(|| {
        let _refresh = HEADLESS_POLICY_REFRESH.lock();
        let result = (|| {
            let policy = cognia_automation::automation::persist::load_policy_state_strict()
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            let settings = cognia_automation::automation::persist::load_settings();
            let raw_policy = policy.get();
            let fingerprint = serde_json::to_vec(&(&settings, &raw_policy))
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            {
                let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
                if snapshot.available && snapshot.fingerprint == fingerprint {
                    return Ok(());
                }
                snapshot.version = snapshot.version.saturating_add(1);
                snapshot.available = false;
            }
            // Compiling here remains off the async executor; guards see the
            // unavailable version and fail closed during the publication.
            HEADLESS_ENFORCEMENT
                .policy
                .set(raw_policy)
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            HEADLESS_ENFORCEMENT
                .gate
                .update(|current| *current = settings);
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            snapshot.fingerprint = fingerprint;
            snapshot.available = true;
            Ok(())
        })();
        if result.is_err() {
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            snapshot.version = snapshot.version.saturating_add(1);
            snapshot.available = false;
        }
        result
    })
    .await
    .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?
}

/// Admission refreshes persisted policy; queued sends inspect only its current
/// in-memory version. A changed/corrupt snapshot fences the admitted action.
pub async fn headless_control_runtime(events: HostEventSink) -> Result<ManagedControlRuntime> {
    refresh_headless_policy().await?;
    Ok(ManagedControlRuntime {
        enforcement: HEADLESS_ENFORCEMENT.clone(),
        events,
        refresh_persisted: true,
    })
}

struct Installed {
    directory: PathBuf,
    service: Arc<ManagedDesktopService>,
    host_id: String,
    release: crate::managed_desktop_release::ReleaseStatus,
    worker: tokio::task::JoinHandle<()>,
    qualification: Arc<qualification::QualificationRuntime>,
    acceptance: Arc<crate::managed_desktop_acceptance::AcceptanceRuntime>,
    events: Option<HostEventSink>,
    control_runtime: Option<ManagedControlRuntime>,
}
impl Drop for Installed {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
static INSTALLED: Lazy<RwLock<Option<Installed>>> = Lazy::new(|| RwLock::new(None));

pub(crate) struct HostSecrets;
async fn secret_io<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| refused("managed_desktop_secret_unavailable"))?
}
#[async_trait]
impl ManagedDesktopSecrets for HostSecrets {
    async fn provider_key(&self, config: &ManagedDesktopConfig) -> Result<ProviderSecret> {
        let reference = config.secret_ref();
        secret_io(move || {
            let key = cognia_secrets::secret_store::get(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .filter(|key| !key.is_empty())
                .ok_or_else(|| refused("managed_desktop_missing_credentials"))?;
            Ok(ProviderSecret(key))
        })
        .await
    }
    async fn has_provider_key(&self, config: &ManagedDesktopConfig) -> Result<bool> {
        let reference = config.secret_ref();
        secret_io(move || {
            Ok(cognia_secrets::secret_store::get(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .is_some_and(|key| !key.is_empty()))
        })
        .await
    }
    async fn put_provider_key(
        &self,
        config: &ManagedDesktopConfig,
        key: &ProviderSecret,
    ) -> Result<()> {
        let reference = config.secret_ref();
        let key = key.0.clone();
        secret_io(move || {
            cognia_secrets::secret_store::set(SECRET_SERVICE, &reference, &key)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
    async fn remove_provider_key(&self, credential: &RetiredCredential) -> Result<()> {
        let reference = credential.secret_ref();
        secret_io(move || {
            cognia_secrets::secret_store::delete(SECRET_SERVICE, &reference)
                .map_err(|_| retryable("managed_desktop_secret_cleanup_failed"))
        })
        .await
    }
    async fn desktop(&self, id: &str) -> Result<DesktopSecrets> {
        let reference = format!("desktop:{id}");
        secret_io(move || {
            let value = cognia_secrets::secret_store::get(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?;
            serde_json::from_str(&value).map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
    async fn put_desktop(&self, id: &str, secret: &DesktopSecrets) -> Result<()> {
        let reference = format!("desktop:{id}");
        let value = serde_json::to_string(secret)
            .map_err(|_| refused("managed_desktop_secret_unavailable"))?;
        secret_io(move || {
            cognia_secrets::secret_store::set(SECRET_SERVICE, &reference, &value)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
    async fn remove_desktop(&self, id: &str) -> Result<()> {
        let reference = format!("desktop:{id}");
        secret_io(move || {
            cognia_secrets::secret_store::delete(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
}

/// Data-free invalidation; clients refetch their owner-scoped delegation list.
pub const DELEGATION_CHANGED_TOPIC: &str = "managed-desktop://delegation-changed";
/// The Host-event topic the worker raises when any owner's billing or
/// cleanup picture changes. It carries no data: clients refetch
/// `managed_desktop_monitor`, which is scoped to the caller's account, so one
/// member never receives another's billing state through the event.
pub const MONITOR_CHANGED_TOPIC: &str = "managed-desktop://monitor-changed";
pub const QUALIFICATION_CHANGED_TOPIC: &str = "managed-desktop://qualification-changed";

fn install_delegation_runtime(service: &ManagedDesktopService, events: Option<HostEventSink>) {
    service.set_delegation_runtime(
        Arc::new(|owner| {
            host_identity::current()
                .ok()
                .and_then(|binding| {
                    host_identity::namespace_for_tenant(&binding.remote_tenant_id)
                })
                .is_some_and(|current| current == owner)
        }),
        Arc::new(host_identity::account_binding_epoch),
        host_identity::account_binding_instance_id().into(),
        Arc::new(move || {
            if let Some(events) = &events {
                events(DELEGATION_CHANGED_TOPIC, serde_json::json!({}));
            }
        }),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateArgs {
    desktop_id: String,
    generation: u64,
    grantee: ManagedDesktopGrantee,
    expires_at: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationRevokeArgs {
    delegation_id: String,
    expected_revision: u64,
}
fn delegation_json(grant: &ManagedDesktopDelegation) -> Value {
    let grantee = match &grant.grantee {
        ManagedDesktopGrantee::Acceptance { acceptance_id, .. } => serde_json::json!({"kind":"acceptance","acceptanceId":acceptance_id}),
        _ => serde_json::json!(grant.grantee),
    };
    serde_json::json!({
        "id":grant.id, "desktopId":grant.desktop_id,
        "desktopGeneration":grant.desktop_generation, "providerConfigId":grant.provider_config_id,
        "grantee":grantee, "mode":grant.mode, "state":grant.state,
        "endReason":grant.end_reason, "expiresAt":grant.expires_at, "revision":grant.revision,
        "createdAt":grant.created_at, "endedAt":grant.ended_at,
    })
}

/// Installs even without a release: reads and old-resource cleanup must work
/// while new provisioning is disabled. Startup never builds a template.
/// `bundled_release` is the directory holding the manifest shipped inside the
/// signed app or server image; the data directory's copy takes precedence.
pub async fn install(
    directory: &Path,
    bundled_release: Option<&Path>,
    host_id: &str,
    events: Option<HostEventSink>,
) -> Result<()> {
    let directory = directory.to_owned();
    let bundled_release = bundled_release.map(Path::to_owned);
    let installed_directory = directory.clone();
    let identity = host_id.to_owned();
    let (service, release_status) = tokio::task::spawn_blocking(move || {
        let loaded = crate::managed_desktop_release::load_installed(
            &directory,
            bundled_release.as_deref(),
        );
        let release_status = crate::managed_desktop_release::ReleaseStatus::of(&loaded);
        let release = match loaded {
            Ok(release) => release.map(|(release, _)| release),
            Err(error) => {
                log::warn!("managed desktop release: {}", error.code);
                None
            }
        };
        let provider = Arc::new(E2bDesktopProvider::new(Arc::new(
            crate::managed_desktop_release::OciDesktopImageVerifier,
        )));
        ManagedDesktopService::open(
            &directory,
            identity,
            provider,
            Arc::new(HostSecrets),
            release,
        )
        .map(|service| (Arc::new(service), release_status))
    })
    .await
    .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    install_delegation_runtime(&service, events.clone());
    cognia_automation::cua_sandbox::registry::install_managed_agent_service(Some(&service));
    let qualification = Arc::new(qualification::QualificationRuntime::new(service.clone(), events.clone()));
    let acceptance = Arc::new(crate::managed_desktop_acceptance::AcceptanceRuntime::new(service.clone(), events.clone()));
    if let Err(error) = acceptance.reconcile(&installed_directory).await {
        log::warn!("managed desktop acceptance startup reconciliation: {}", error.code);
    }
    let acceptance_worker = acceptance.clone();
    let input_events = events.clone();
    let weak = Arc::downgrade(&service);
    let evidence_directory = installed_directory.clone();
    let evidence_host = host_id.to_owned();
    let worker = tokio::spawn(async move {
        let mut last_monitor = Vec::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(service) = weak.upgrade() else { break };
            if let Err(error) = acceptance_worker.reconcile(&evidence_directory).await {
                log::warn!("managed desktop acceptance reconciliation: {}", error.code);
            }
            if let Err(error) = crate::managed_desktop_results::reconcile(&evidence_directory, &service, &evidence_host).await {
                log::warn!("managed desktop evidence reconciliation: {}", error.code);
            }
            if let Err(error) = qualification::reconcile_handoffs(&evidence_directory, &service).await {
                log::warn!("managed desktop qualification handoff cleanup: {}", error.code);
            }
            if let Err(error) = qualification::reconcile_devices(&service).await {
                log::warn!("managed desktop qualification device cleanup: {}", error.code);
            }
            if let Err(error) = service.reconcile().await {
                log::warn!("managed desktop reconciliation: {}", error.code);
            }
            if let Some(events) = &events {
                let next = monitor_signature(&service.monitors().await);
                if next != last_monitor {
                    last_monitor = next;
                    events(MONITOR_CHANGED_TOPIC, serde_json::json!({}));
                }
            }
        }
    });
    *INSTALLED.write() = Some(Installed {
        directory: installed_directory,
        service,
        host_id: host_id.into(),
        release: release_status,
        worker,
        qualification,
        acceptance,
        events: input_events,
        control_runtime: None,
    });
    Ok(())
}

/// What makes a monitor change worth an event. Exposure shrinks every tick as
/// deadlines approach and `observed_at` always moves; neither is a change a
/// person needs to be told about.
fn monitor_signature(
    monitors: &std::collections::BTreeMap<String, ManagedDesktopMonitor>,
) -> Vec<(String, u32, Option<i64>, Option<i64>, Vec<ManagedDesktopAlert>)> {
    monitors
        .iter()
        .map(|(owner, m)| {
            (
                owner.clone(),
                m.billed_desktops,
                m.oldest_pending_create_at,
                m.oldest_pending_delete_at,
                m.alerts.clone(),
            )
        })
        .collect()
}

pub fn shutdown() {
    cognia_automation::cua_sandbox::registry::install_managed_agent_service(None);
    let installed = INSTALLED.write().take();
    // The frame provider holds the service; release it with the service.
    if let Ok(state) = cognia_remote_desktop::commands::installed() {
        if let Ok(host) = state.host() {
            host.unregister_native_frames("managed-desktop");
        }
    }
    if let Some(installed) = installed {
        installed.worker.abort();
        if installed.qualification.has_active_tasks() {
            // Existing shell callers have a synchronous shutdown hook. Retain
            // ownership only for the bounded drain; the runtime then aborts
            // stragglers and releases the exclusive journal within that bound.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    installed.qualification.shutdown().await;
                    drop(installed);
                });
            }
        }
    }
}

/// ADR-0234 N1/N2: serve managed desktops as native `cognia-frames` targets.
/// Call once both this service and the remote desktop Host are installed.
pub fn register_native_frames() -> Result<()> {
    use cognia_automation::cua_sandbox::managed::frame_source::ManagedNativeFrameProvider;
    let service = INSTALLED
        .read()
        .as_ref()
        .map(|installed| installed.service.clone())
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))?;
    let state = cognia_remote_desktop::commands::installed()
        .map_err(|_| refused("managed_desktop_frames_unavailable"))?;
    state
        .host()
        .and_then(|host| {
            host.register_native_frames(
                "managed-desktop",
                Arc::new(ManagedNativeFrameProvider::new(service, Arc::new(native_frame_context))),
            )
        })
        .map_err(|_| refused("managed_desktop_frames_unavailable"))
}

/// Desktop startup injects its live AutomationState enforcement before native
/// input is enabled. Dispatching another RPC never changes this authority.
pub fn install_native_control_runtime(runtime: ManagedControlRuntime) -> Result<()> {
    let mut installed = INSTALLED.write();
    let installed = installed
        .as_mut()
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))?;
    installed.control_runtime = Some(runtime);
    Ok(())
}

async fn native_control_runtime(
    service: &Arc<ManagedDesktopService>,
) -> Result<ManagedControlRuntime> {
    let (runtime, events) = INSTALLED
        .read()
        .as_ref()
        .filter(|installed| Arc::ptr_eq(&installed.service, service))
        .map(|installed| (installed.control_runtime.clone(), installed.events.clone()))
        .ok_or_else(|| refused("managed_desktop_forbidden"))?;
    if let Some(runtime) = runtime {
        return Ok(runtime);
    }
    // A desktop must never substitute persisted headless settings for its live
    // kill switch/permission gate. Headless hosts have no AutomationState.
    if cfg!(feature = "tauri-host") {
        return Err(refused("managed_desktop_control_policy_unavailable"));
    }
    headless_control_runtime(events.unwrap_or_else(|| Arc::new(|_, _| {}))).await
}

/// Maps a remote desktop viewer onto the same principal and live authority the
/// `managed_desktop_control_frame` RPC uses. A device's tenant is read from the
/// pairing store, never from the viewer. Store queries run off the runtime.
fn native_frame_context(
    viewer: cognia_remote_desktop::session::Principal,
) -> cognia_remote_desktop::frames::FrameFuture<
    cognia_automation::cua_sandbox::managed::frame_source::ManagedFrameContext,
> {
    use cognia_automation::cua_sandbox::managed::frame_source::ManagedFrameContext;
    use cognia_remote_desktop::error::RemoteDesktopError;
    Box::pin(cognia_remote_desktop::frames::blocking(move || {
        let forbidden = || RemoteDesktopError::new("remote_desktop_forbidden");
        let (host_id, service) = INSTALLED
            .read()
            .as_ref()
            .map(|installed| (installed.host_id.clone(), installed.service.clone()))
            .ok_or_else(|| RemoteDesktopError::new("remote_desktop_native_unavailable"))?;
        let caller = if viewer.is_local() {
            OwnedCaller {
                device_id: LOCAL_DEVICE_ID.into(),
                tenant_id: None,
                local: true,
                host_id,
            }
        } else {
            let device = viewer.id().strip_prefix("device:").ok_or_else(forbidden)?;
            let tenant = security_store()
                .and_then(|store| store.active_device_tenant(device).ok().flatten())
                .ok_or_else(forbidden)?;
            OwnedCaller {
                device_id: device.into(),
                tenant_id: Some(tenant),
                local: false,
                host_id,
            }
        };
        let managed = principal(&caller.caller(), &caller.host_id).map_err(|_| forbidden())?;
        let caller = Arc::new(caller);
        let input_executor =
            native_input_executor(caller.clone(), managed.clone(), viewer, service);
        Ok(ManagedFrameContext {
            principal: managed,
            authority: Arc::new(NativeFrameAuthority {
                caller,
                checked: Default::default(),
            }),
            input_executor,
        })
    }))
}

/// A caller identity owned so it outlives one request.
struct OwnedCaller {
    device_id: String,
    tenant_id: Option<String>,
    local: bool,
    host_id: String,
}
impl OwnedCaller {
    fn caller(&self) -> Caller<'_> {
        Caller {
            device_id: &self.device_id,
            tenant_id: self.tenant_id.as_deref(),
            scope: None,
            local: self.local,
        }
    }
}

/// The frame stream's live authority: the same identity re-derivation as
/// [`HostAuthority`], run off the runtime and reused for one remote desktop
/// admission interval so a 7 Hz stream repeats no store work. It carries no
/// input authority on its own: broker Control admission and the managed lease
/// must both succeed before this live check can authorize a mutation.
struct NativeFrameAuthority {
    caller: Arc<OwnedCaller>,
    checked: parking_lot::Mutex<Option<std::time::Instant>>,
}
#[async_trait]
impl ManagedControlAuthority for NativeFrameAuthority {
    fn input_admission(&self, _: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        Arc::new(|| false)
    }
    async fn revalidate(&self, expected: &ManagedDesktopPrincipal) -> Result<()> {
        if self.checked.lock().is_some_and(|at| {
            at.elapsed() < cognia_remote_desktop::session::ADMISSION_INTERVAL
        }) {
            return Ok(());
        }
        let caller = self.caller.clone();
        let expected_principal = expected.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            same_principal(
                &principal(&caller.caller(), &caller.host_id)?,
                &expected_principal,
            )
        })
        .await
        .map_err(|_| refused("managed_desktop_forbidden"))?;
        *self.checked.lock() = outcome.is_ok().then(std::time::Instant::now);
        outcome
    }
}

fn native_input_executor(
    caller: Arc<OwnedCaller>,
    expected: ManagedDesktopPrincipal,
    viewer: cognia_remote_desktop::session::Principal,
    service: Arc<ManagedDesktopService>,
) -> cognia_automation::cua_sandbox::managed::frame_source::ManagedInputExecutor {
    Arc::new(move |request| {
        let (caller, expected, viewer, service) = (
            caller.clone(),
            expected.clone(),
            viewer.clone(),
            service.clone(),
        );
        Box::pin(async move {
            use cognia_remote_desktop::frames::NativeInputError;
            let runtime = native_control_runtime(&service)
                .await
                .map_err(|error| NativeInputError::managed(&error.code))?;
            execute_native_input(&service, &caller, &expected, viewer, request, runtime)
                .await
                .map_err(|error| NativeInputError::managed(&error.code))
        })
    })
}

async fn execute_native_input(
    service: &ManagedDesktopService,
    caller: &OwnedCaller,
    expected: &ManagedDesktopPrincipal,
    viewer: cognia_remote_desktop::session::Principal,
    request: cognia_automation::cua_sandbox::managed::frame_source::ManagedNativeInput,
    runtime: ManagedControlRuntime,
) -> Result<()> {
    execute_native_input_with_delivery(
        expected,
        caller,
        viewer,
        request,
        runtime,
        &CoreInputDelivery {
            service,
            smoke: None,
            native: true,
        },
    )
    .await
}

async fn execute_native_input_with_delivery(
    expected: &ManagedDesktopPrincipal,
    caller: &OwnedCaller,
    viewer: cognia_remote_desktop::session::Principal,
    request: cognia_automation::cua_sandbox::managed::frame_source::ManagedNativeInput,
    runtime: ManagedControlRuntime,
    delivery: &dyn HumanInputDelivery,
) -> Result<()> {
    let action = serde_json::to_value(request.input.action)
        .map_err(|_| refused("managed_desktop_invalid_request"))?;
    // Reuse the human RPC boundary's closed action validation as well as its
    // full gate. The broker supplies the lease; the message never supplies it.
    let args: InputArgs = decode(serde_json::json!({
        "desktopId":request.desktop_id, "generation":request.generation,
        "token":request.lease.token, "fence":request.lease.fence,
        "frameId":request.input.frame_id, "point":request.input.point, "action":action,
    }))?;
    let authority = HostAuthority {
        caller: caller.caller(),
        host_id: &caller.host_id,
        admin_check: Some(Arc::new(move || {
            if viewer.admitted(cognia_remote_desktop::session::SessionMode::Control) {
                Ok(())
            } else {
                Err(refused("managed_desktop_control_admin_lease_expired"))
            }
        })),
        input_policy: None,
        admission_observer: None,
    };
    authority.revalidate(expected).await?;
    execute_input_pipeline(expected, &authority, args, runtime, delivery).await
}

/// Whether a freshly derived principal is still the one an operation began as.
fn same_principal(current: &ManagedDesktopPrincipal, expected: &ManagedDesktopPrincipal) -> Result<()> {
    if current.owner_principal_id != expected.owner_principal_id
        || current.principal_id != expected.principal_id
        || current.host_id != expected.host_id
        || current.authority != expected.authority
    {
        return Err(refused("managed_desktop_forbidden"));
    }
    Ok(())
}

/// The device id the desktop's own IPC and its native frame viewer act as.
const LOCAL_DEVICE_ID: &str = "local-desktop";

/// Created solely by native IPC or the already-authenticated RPC dispatcher.
#[derive(Clone, Copy)]
pub struct Caller<'a> {
    pub device_id: &'a str,
    pub tenant_id: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub local: bool,
}

struct HostAuthority<'a> {
    caller: Caller<'a>,
    host_id: &'a str,
    admin_check: Option<AdminAuthorityCheck>,
    input_policy: Option<&'a InputPolicyGuard>,
    // Native diagnostics observe the real command-pump decision; never override it.
    admission_observer: Option<Arc<dyn Fn(bool) + Send + Sync>>,
}
#[async_trait]
impl ManagedControlAuthority for HostAuthority<'_> {
    fn input_admission(
        &self,
        expected: &ManagedDesktopPrincipal,
    ) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let device_id = self.caller.device_id.to_owned();
        let tenant_id = self.caller.tenant_id.map(str::to_owned);
        let scope = self.caller.scope.map(str::to_owned);
        let local = self.caller.local;
        let host_id = self.host_id.to_owned();
        let expected = expected.clone();
        let admin_check = self.admin_check.clone();
        let input_policy = self.input_policy.cloned();
        let observer = self.admission_observer.clone();
        Arc::new(move || {
            if admin_check.as_ref().is_some_and(|check| check().is_err())
                || input_policy
                    .as_ref()
                    .is_some_and(|policy| policy.check().is_err())
            {
                if let Some(observer) = &observer { observer(false); }
                return false;
            }
            let caller = Caller {
                device_id: &device_id,
                tenant_id: tenant_id.as_deref(),
                scope: scope.as_deref(),
                local,
            };
            let admitted = principal(&caller, &host_id).is_ok_and(|current| {
                current.owner_principal_id == expected.owner_principal_id
                    && current.principal_id == expected.principal_id
                    && current.host_id == expected.host_id
                    && current.authority == expected.authority
                    && current.require_human().is_ok()
            });
            if let Some(observer) = &observer { observer(admitted); }
            admitted
        })
    }
    async fn revalidate(&self, expected: &ManagedDesktopPrincipal) -> Result<()> {
        if let Some(policy) = self.input_policy {
            policy.refresh().await?;
            policy.check()?;
        }
        if let Some(check) = &self.admin_check {
            check()?;
        }
        let current = qualification_principal_check(self.caller,self.host_id,expected);
        tokio::task::spawn_blocking(move || current()).await.map_err(|_| refused("managed_desktop_forbidden"))?
    }
}

fn authority(
    local: bool,
    scope: Option<&str>,
    worker: bool,
    owner: bool,
) -> ManagedDesktopAuthority {
    if local {
        return ManagedDesktopAuthority::Administrator;
    }
    if worker || cognia_companion::jwt::is_service_scope(scope) {
        return ManagedDesktopAuthority::Agent;
    }
    if scope == Some("owner") || owner {
        return ManagedDesktopAuthority::Administrator;
    }
    // WebRTC carries no scope string, but principal() has already checked
    // its authenticated active paired-device record and worker designation.
    if matches!(scope, None | Some("device" | "oidc")) {
        ManagedDesktopAuthority::Human
    } else {
        ManagedDesktopAuthority::Observer
    }
}

/// The deletion operation holds a live authenticated principal check while its
/// filesystem work is queued. Persisted cleanup later uses its exact receipt.
pub fn task_deletion_admission(caller: Caller<'_>, host: String, owner: Option<String>) -> Arc<dyn Fn() -> bool + Send + Sync> {
    let device_id = caller.device_id.to_owned(); let tenant = caller.tenant_id.map(str::to_owned);
    let scope = caller.scope.map(str::to_owned); let local = caller.local;
    Arc::new(move || principal(&Caller { device_id:&device_id,tenant_id:tenant.as_deref(),scope:scope.as_deref(),local }, &host)
        .is_ok_and(|p| Some(p.owner_principal_id) == owner))
}

fn principal(caller: &Caller<'_>, host_id: &str) -> Result<ManagedDesktopPrincipal> {
    let owner_principal_id = if caller.local {
        let binding =
            host_identity::current().map_err(|_| refused("managed_desktop_account_required"))?;
        host_identity::namespace_for_tenant(&binding.remote_tenant_id)
    } else {
        caller
            .tenant_id
            .and_then(host_identity::namespace_for_tenant)
    }
    .ok_or_else(|| refused("managed_desktop_account_required"))?;
    let (worker, owner) = if !caller.local && !matches!(caller.scope, Some("owner" | "service")) {
        let tenant = caller
            .tenant_id
            .ok_or_else(|| refused("managed_desktop_forbidden"))?;
        let store = security_store().ok_or_else(|| refused("managed_desktop_forbidden"))?;
        let devices = store
            .list_devices(tenant)
            .map_err(|_| refused("managed_desktop_forbidden"))?;
        if !devices
            .iter()
            .any(|d| d.device_id == caller.device_id && d.status == "active")
        {
            return Err(refused("managed_desktop_forbidden"));
        }
        let worker = store
            .list_worker_devices(tenant)
            .map_err(|_| refused("managed_desktop_forbidden"))?
            .iter()
            .any(|d| d.device_id == caller.device_id);
        let owner = store
            .is_owner_device(tenant, caller.device_id)
            .map_err(|_| refused("managed_desktop_forbidden"))?;
        (worker, owner)
    } else {
        (false, false)
    };
    Ok(ManagedDesktopPrincipal {
        owner_principal_id,
        principal_id: caller.device_id.into(),
        host_id: host_id.into(),
        authority: authority(caller.local, caller.scope, worker, owner),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigRevisionArgs {
    provider_config_id: String,
    expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialArgs {
    provider_config_id: String,
    expected_revision: u64,
    source: CredentialSourceArgs,
}
/// Where a new provider key comes from (ADR-0233 amendment A1).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum CredentialSourceArgs {
    /// Typed once by the administrator; never read back.
    Key { key: String },
    /// Copied inside the Host from an ADR-0221 E2B code-sandbox provider's
    /// secret-store credential. The value never crosses the RPC boundary.
    RemoteSandbox {
        #[serde(rename = "providerId")]
        provider_id: String,
    },
}

/// Resolves a credential source to a key without exposing it to the caller.
/// A copied key must name the Host's own E2B code-sandbox provider whose
/// credential is a secret-store entry; env and file sources are operator
/// configuration and are not copied (ADR-0233 §1).
async fn credential_value(directory: &Path, source: CredentialSourceArgs) -> Result<ProviderSecret> {
    match source {
        CredentialSourceArgs::Key { key } => ProviderSecret::parse(&key),
        CredentialSourceArgs::RemoteSandbox { provider_id } => {
            let directory = directory.to_owned();
            secret_io(move || {
                use cognia_sandbox_pool::providers::{CredentialSource, ProviderKind};
                let settings = cognia_sandbox_pool::desktop::DesktopRemoteSandboxes::load(&directory)
                    .map_err(|_| refused("managed_desktop_credential_source_unavailable"))?;
                let provider = settings
                    .providers
                    .providers
                    .iter()
                    .find(|p| p.id == provider_id && p.kind == ProviderKind::E2b)
                    .ok_or_else(|| refused("managed_desktop_credential_source_not_found"))?;
                let Some(CredentialSource::SecretId(secret_id)) = &provider.credential else {
                    return Err(refused("managed_desktop_credential_source_unsupported"));
                };
                let key = cognia_secrets::secret_store::get(
                    cognia_companion::remote_sandboxes::SECRET_SERVICE,
                    secret_id,
                )
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .ok_or_else(|| refused("managed_desktop_credential_source_empty"))?;
                ProviderSecret::parse(key.trim())
            })
            .await
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuoteArgs {
    provider_config_id: String,
    lifetime_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizeArgs {
    provider_config_id: String,
    quote_id: String,
    action: AuthorizationPurpose,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopArgs {
    desktop_id: String,
    generation: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquireArgs {
    desktop_id: String,
    generation: u64,
    takeover: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseArgs {
    desktop_id: String,
    generation: u64,
    token: String,
    fence: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationArgs {
    desktop_id: String,
    generation: u64,
    token: String,
    fence: u64,
    path: Option<String>,
    offset: Option<u64>,
    length: Option<usize>,
    chunk: Option<Vec<u8>>,
    r#final: Option<bool>,
    text: Option<String>,
}
impl OperationArgs {
    fn request(&self, command: &str) -> Result<operations::GuestOperation> {
        use operations::GuestOperation as Op;
        let invalid = || refused("managed_desktop_invalid_request");
        if self.token.is_empty() || self.token.len() > 256 || self.generation == 0 {
            return Err(invalid());
        }
        Ok(match command {
            "managed_desktop_files_read"
                if self.chunk.is_none() && self.r#final.is_none() && self.text.is_none() =>
            {
                Op::FileRead {
                    path: self.path.clone().ok_or_else(invalid)?,
                    offset: self.offset.ok_or_else(invalid)?,
                    length: self.length.ok_or_else(invalid)?,
                }
            }
            "managed_desktop_files_write" if self.length.is_none() && self.text.is_none() => {
                Op::FileWrite {
                    path: self.path.clone().ok_or_else(invalid)?,
                    offset: self.offset.ok_or_else(invalid)?,
                    chunk: self.chunk.clone().ok_or_else(invalid)?,
                    r#final: self.r#final.ok_or_else(invalid)?,
                }
            }
            "managed_desktop_clipboard_get" | "managed_desktop_clipboard_set"
                if self.path.is_none()
                    && self.offset.is_none()
                    && self.length.is_none()
                    && self.chunk.is_none()
                    && self.r#final.is_none() =>
            {
                if command.ends_with("_get") && self.text.is_none() {
                    Op::ClipboardGet
                } else if command.ends_with("_set") {
                    Op::ClipboardSet {
                        text: self.text.clone().ok_or_else(invalid)?,
                    }
                } else {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputArgs {
    desktop_id: String,
    generation: u64,
    token: String,
    fence: u64,
    frame_id: String,
    #[serde(default, deserialize_with = "input_point")]
    point: Option<Point>,
    #[serde(deserialize_with = "input_action")]
    action: UiAction,
}
fn closed_object(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}
fn input_point<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Point>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if !value.is_null() && !closed_object(&value, &["x", "y"]) {
        return Err(serde::de::Error::custom("invalid managed desktop point"));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn input_action<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<UiAction, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let fields: &[&str] = match value.get("kind").and_then(Value::as_str) {
        Some("click") => &["kind", "button", "count"],
        Some("drag") => &["kind", "to", "opts"],
        Some("scroll") => &["kind", "opts"],
        Some("pressKey") => &["kind", "chord"],
        Some("typeText") => &["kind", "text"],
        _ => {
            return Err(serde::de::Error::custom(
                "unsupported managed desktop action",
            ))
        }
    };
    if !closed_object(&value, fields) {
        return Err(serde::de::Error::custom("invalid managed desktop action"));
    }
    if let Some(to) = value.get("to") {
        if !closed_object(to, &["x", "y"]) {
            return Err(serde::de::Error::custom("invalid drag destination"));
        }
    }
    if let Some(opts) = value.get("opts") {
        let allowed = if value["kind"] == "drag" {
            &["button", "durationMs", "steps"][..]
        } else {
            &["dx", "dy"][..]
        };
        if !closed_object(opts, allowed) {
            return Err(serde::de::Error::custom("invalid action options"));
        }
    }
    let action: UiAction = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
    let valid = match &action {
        UiAction::Click { count, .. } => count.is_none_or(|count| (1..=3).contains(&count)),
        UiAction::TypeText { text } => text.len() <= 4096,
        UiAction::PressKey { chord } => !chord.0.is_empty() && chord.0.len() <= 256,
        UiAction::Drag { opts, .. } => {
            opts.duration_ms.unwrap_or(150) <= 2000 && opts.steps.unwrap_or(12) <= 60
        }
        _ => true,
    };
    if !valid {
        return Err(serde::de::Error::custom("managed desktop input limit"));
    }
    Ok(action)
}
fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T> {
    serde_json::from_value(args).map_err(|_| refused("managed_desktop_invalid_request"))
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| refused("managed_desktop_invalid_response"))
}

fn input_command(action: &UiAction) -> Result<&'static str> {
    match action {
        UiAction::Click { .. } => Ok("click"),
        UiAction::Drag { .. } => Ok("drag"),
        UiAction::Scroll { .. } => Ok("scroll"),
        UiAction::PressKey { .. } => Ok("keys"),
        UiAction::TypeText { .. } => Ok("type"),
        _ => Err(refused("managed_desktop_control_unsupported_action")),
    }
}

fn require_verified_target_constraints(enforcement: &Enforcement) -> Result<()> {
    let settings = enforcement.gate.settings();
    let whitelist = settings
        .per_surface
        .computer_use
        .whitelist
        .as_ref()
        .unwrap_or(&settings.whitelist);
    // The cloud driver has no authenticated foreground-window metadata.
    // Missing facts must not turn a configured process/window restriction off.
    let policy = enforcement.policy.get();
    if !whitelist.is_empty()
        || !policy.allowed_process_names.is_empty()
        || !policy.allowed_window_title_patterns.is_empty()
        || !policy.allowed_url_patterns.is_empty()
    {
        return Err(refused("managed_desktop_control_target_unverified"));
    }
    Ok(())
}

#[derive(Clone)]
struct InputPolicyGuard {
    enforcement: Enforcement,
    command: &'static str,
    point: Option<Point>,
    destination: Option<Point>,
    required_consent: bool,
    persisted_version: Option<u64>,
}
impl InputPolicyGuard {
    fn new(
        runtime: &ManagedControlRuntime,
        command: &'static str,
        point: Option<Point>,
        action: &UiAction,
    ) -> Self {
        Self::for_operation(
            runtime,
            command,
            point,
            match action {
                UiAction::Drag { to, .. } => Some(*to),
                _ => None,
            },
        )
    }
    fn for_operation(
        runtime: &ManagedControlRuntime,
        command: &'static str,
        point: Option<Point>,
        destination: Option<Point>,
    ) -> Self {
        let call = cognia_automation::automation::permission::Call {
            command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        Self {
            enforcement: runtime.enforcement.clone(),
            command,
            point,
            destination,
            required_consent: matches!(
                runtime.enforcement.gate.evaluate(&call),
                cognia_automation::automation::permission::Decision::RequireConsent { .. }
            ),
            persisted_version: runtime
                .refresh_persisted
                .then(|| HEADLESS_POLICY_SNAPSHOT.read().version),
        }
    }
    async fn refresh(&self) -> Result<()> {
        if self.persisted_version.is_some() {
            refresh_headless_policy().await?;
        }
        Ok(())
    }
    fn check(&self) -> Result<()> {
        // Hold only an in-memory read lock while checking shared enforcement.
        let snapshot = self
            .persisted_version
            .map(|_| HEADLESS_POLICY_SNAPSHOT.read());
        if let Some(snapshot) = snapshot.as_ref() {
            if !snapshot.available || Some(snapshot.version) != self.persisted_version {
                return Err(refused("managed_desktop_control_policy_changed"));
            }
        }
        require_verified_target_constraints(&self.enforcement)?;
        let call = cognia_automation::automation::permission::Call {
            command: self.command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        match self.enforcement.gate.evaluate(&call) {
            cognia_automation::automation::permission::Decision::Deny(error) => {
                return Err(policy_error(error))
            }
            cognia_automation::automation::permission::Decision::RequireConsent { .. }
                if !self.required_consent =>
            {
                return Err(refused("managed_desktop_control_consent_required"))
            }
            _ => {}
        }
        let facts = cognia_automation::automation::policy::ActionFacts {
            process_name: None,
            window_title: None,
            target_url: None,
            click_x: self.point.map(|p| p.x),
            click_y: self.point.map(|p| p.y),
        };
        if matches!(
            self.enforcement.policy.evaluate(&facts),
            cognia_automation::automation::policy::Decision::Deny { .. }
        ) {
            return Err(refused("managed_desktop_control_policy_denied"));
        }
        if let Some(to) = self.destination {
            let facts = cognia_automation::automation::policy::ActionFacts {
                click_x: Some(to.x),
                click_y: Some(to.y),
                ..facts
            };
            if matches!(
                self.enforcement.policy.evaluate(&facts),
                cognia_automation::automation::policy::Decision::Deny { .. }
            ) {
                return Err(refused("managed_desktop_control_policy_denied"));
            }
        }
        Ok(())
    }
}

fn policy_error(error: AutomationError) -> ManagedDesktopError {
    let code = match error {
        AutomationError::UserDeclined => "managed_desktop_control_consent_denied",
        AutomationError::KillSwitchActive => "managed_desktop_control_kill_switch",
        AutomationError::BackendError { message } if message.starts_with("managed_desktop_") => {
            return refused(&message)
        }
        _ => "managed_desktop_control_policy_denied",
    };
    refused(code)
}

struct PendingTasks(parking_lot::Mutex<Vec<tokio::task::JoinHandle<()>>>);
impl Drop for PendingTasks {
    fn drop(&mut self) {
        for task in self.0.get_mut().drain(..) {
            task.abort();
        }
    }
}
// Pending and approved states are read under separate shared-store locks.
// A request can become approved between those reads; consume once more before
// treating a disappeared pending request as denial/revocation/expiry.
fn resolve_closed_host_consent(
    broker: &cognia_automation::automation::consent::ConsentBroker,
    id: &str, device: &str, operations: &[String],
) {
    let approved = cognia_companion::host_consent::take_approved(device, operations);
    broker.resolve(id, approved, false, None, None);
}

fn install_host_consent_bridge(
    enforcement: &mut Enforcement,
    events: HostEventSink,
    device_id: String,
    tenant_id: Option<String>,
    target_detail: String,
    command: &'static str,
) -> Arc<PendingTasks> {
    // Grants for local desktop automation must not authorize cloud input.
    enforcement.consent = cognia_automation::automation::consent::ConsentBroker::new();
    let broker = enforcement.consent.clone();
    let tasks = Arc::new(PendingTasks(parking_lot::Mutex::new(Vec::new())));
    let weak_tasks = Arc::downgrade(&tasks);
    enforcement.consent_event_sink = Some(Arc::new(move |event| {
        let operations = vec![format!(
            "managed-desktop:{}:{}:{}",
            target_detail, command, event.id
        )];
        let ask = cognia_companion::host_consent::request(
            &device_id,
            tenant_id.as_deref(),
            operations.clone(),
        );
        events(
            cognia_companion::host_consent::CONSENT_CHANNEL,
            serde_json::to_value(&ask).unwrap_or(Value::Null),
        );
        let broker = broker.clone();
        let device_id = device_id.clone();
        let id = event.id.clone();
        let timeout = Duration::from_millis(event.timeout_ms);
        let request_id = ask.id;
        let task = tokio::spawn(async move {
            let started = tokio::time::Instant::now();
            loop {
                if cognia_companion::host_consent::take_approved(&device_id, &operations) {
                    broker.resolve(&id, true, false, None, None);
                    return;
                }
                // Denial, expiry, revocation and a racing approval all remove
                // the pending ask. Recheck approval before resolving it closed.
                if !cognia_companion::host_consent::pending().iter().any(|request| request.id == request_id) {
                    resolve_closed_host_consent(&broker, &id, &device_id, &operations);
                    return;
                }
                if started.elapsed() >= timeout {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        if let Some(tasks) = weak_tasks.upgrade() {
            tasks.0.lock().push(task);
        } else {
            task.abort();
        }
        Ok(())
    }));
    tasks
}

/// A consent request is a separate authority from the broad admin lease.
/// Use the existing automation pipeline, bridging its prompt to Host consent
/// so a headless Host never assumes a Tauri overlay exists.
async fn execute_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: InputArgs,
    runtime: ManagedControlRuntime,
) -> Result<()> {
    execute_input_inner(service, p, authority, a, runtime, None).await
}

#[async_trait]
trait HumanInputDelivery: Send + Sync {
    async fn deliver(
        &self,
        p: &ManagedDesktopPrincipal,
        input: InputArgs,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()>;
}
struct CoreInputDelivery<'a> {
    service: &'a ManagedDesktopService,
    smoke: Option<&'a ExplicitPaidSmokeAuthorization>,
    native: bool,
}
#[async_trait]
impl HumanInputDelivery for CoreInputDelivery<'_> {
    async fn deliver(
        &self,
        p: &ManagedDesktopPrincipal,
        a: InputArgs,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        let input = cognia_automation::cua_sandbox::managed::ManagedControlInput {
            token: &a.token,
            fence: a.fence,
            frame_id: &a.frame_id,
            point: a.point,
            action: a.action,
        };
        if let Some(permit) = self.smoke {
            self.service
                .control_input_smoke(p, &a.desktop_id, a.generation, input, authority, permit)
                .await
        } else if self.native {
            self.service
                .native_control_input(p, &a.desktop_id, a.generation, input, authority)
                .await
        } else {
            self.service
                .control_input(p, &a.desktop_id, a.generation, input, authority)
                .await
        }
    }
}

async fn execute_input_inner(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: InputArgs,
    runtime: ManagedControlRuntime,
    smoke: Option<&ExplicitPaidSmokeAuthorization>,
) -> Result<()> {
    execute_input_pipeline(
        p,
        authority,
        a,
        runtime,
        &CoreInputDelivery {
            service,
            smoke,
            native: false,
        },
    )
    .await
}

async fn execute_input_pipeline(
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: InputArgs,
    runtime: ManagedControlRuntime,
    delivery: &dyn HumanInputDelivery,
) -> Result<()> {
    let command = input_command(&a.action)?;
    execute_human_pipeline(
        p,
        authority,
        HumanGateInput {
            desktop_id: &a.desktop_id,
            generation: a.generation,
            fence: a.fence,
            command,
            point: a.point,
            action: Some(&a.action),
        },
        runtime,
        &InputDelivery {
            p,
            input: &a,
            delivery,
        },
    )
    .await
    .map(|_| ())
}
struct HumanGateInput<'a> {
    desktop_id: &'a str,
    generation: u64,
    fence: u64,
    command: &'static str,
    point: Option<Point>,
    action: Option<&'a UiAction>,
}
#[async_trait]
trait HumanDelivery: Send + Sync {
    async fn deliver(&self, authority: &dyn ManagedControlAuthority) -> Result<Value>;
}
struct InputDelivery<'a> {
    p: &'a ManagedDesktopPrincipal,
    input: &'a InputArgs,
    delivery: &'a dyn HumanInputDelivery,
}
#[async_trait]
impl HumanDelivery for InputDelivery<'_> {
    async fn deliver(&self, authority: &dyn ManagedControlAuthority) -> Result<Value> {
        let a = self.input;
        self.delivery
            .deliver(
                self.p,
                InputArgs {
                    desktop_id: a.desktop_id.clone(),
                    generation: a.generation,
                    token: a.token.clone(),
                    fence: a.fence,
                    frame_id: a.frame_id.clone(),
                    point: a.point,
                    action: a.action.clone(),
                },
                authority,
            )
            .await?;
        Ok(Value::Null)
    }
}
async fn finish_operation_result(
    name: &str,
    principal: &ManagedDesktopPrincipal,
    authority: &dyn ManagedControlAuthority,
    result: Result<Value>,
) -> Result<Value> {
    if result.is_ok()
        && matches!(
            name,
            "managed_desktop_files_read" | "managed_desktop_clipboard_get"
        )
    {
        authority.revalidate(principal).await?;
    }
    result
}

struct WorkspaceDelivery<'a> {
    delivered: &'a std::sync::atomic::AtomicBool,
    p: &'a ManagedDesktopPrincipal,
    service: &'a ManagedDesktopService,
    args: &'a OperationArgs,
    request: operations::GuestOperation,
}
#[async_trait]
impl HumanDelivery for WorkspaceDelivery<'_> {
    async fn deliver(&self, authority: &dyn ManagedControlAuthority) -> Result<Value> {
        self.delivered
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let p = self.p;
        let a = self.args;
        encode(
            self.service
                .human_workspace_operation(
                    p,
                    &a.desktop_id,
                    a.generation,
                    ManagedControlLeaseRef {
                        token: &a.token,
                        fence: a.fence,
                    },
                    self.request.clone(),
                    authority,
                )
                .await?,
        )
    }
}
async fn execute_human_pipeline(
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: HumanGateInput<'_>,
    mut runtime: ManagedControlRuntime,
    delivery: &dyn HumanDelivery,
) -> Result<Value> {
    p.require_human()?;
    let command = a.command;
    require_verified_target_constraints(&runtime.enforcement)?;
    let policy_guard = if let Some(action) = a.action {
        InputPolicyGuard::new(&runtime, command, a.point, action)
    } else {
        InputPolicyGuard::for_operation(&runtime, command, a.point, None)
    };
    let guarded_authority = HostAuthority {
        caller: authority.caller,
        host_id: authority.host_id,
        admin_check: authority.admin_check.clone(),
        input_policy: Some(&policy_guard),
        admission_observer: authority.admission_observer.clone(),
    };
    let authority = &guarded_authority;
    let detail = format!("Managed desktop {}: {}", a.desktop_id, command);
    let tasks = install_host_consent_bridge(
        &mut runtime.enforcement,
        runtime.events,
        p.principal_id.clone(),
        authority.caller.tenant_id.map(str::to_owned),
        format!(
            "{}:generation={}:fence={}",
            a.desktop_id, a.generation, a.fence
        ),
        command,
    );
    let context = GateContext {
        surface: Surface::ComputerUse,
        plugin_id: None,
        process_name: None,
        window_title: None,
        target_url: None,
        click_x: a.point.map(|p| p.x),
        click_y: a.point.map(|p| p.y),
        force_tier: None,
        command_detail: Some(detail),
        session_key: Some(format!(
            "managed:{}:{}:{}",
            p.owner_principal_id, a.desktop_id, a.fence
        )),
    };
    let result = run_gated_enf(None, &runtime.enforcement, context, command, || async {
        authority
            .revalidate(p)
            .await
            .map_err(|error| AutomationError::BackendError {
                message: error.code,
            })?;
        // Consent may have waited while the operator disabled automation.
        let call = cognia_automation::automation::permission::Call {
            command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        if let cognia_automation::automation::permission::Decision::Deny(error) =
            runtime.enforcement.gate.evaluate(&call)
        {
            return Err(error);
        }
        delivery
            .deliver(authority)
            .await
            .map_err(|error| AutomationError::BackendError {
                message: error.code,
            })
    })
    .await;
    drop(tasks);
    result.map_err(policy_error)
}

fn delegation_deployment(mode: cognia_companion::deployment::DeploymentMode) -> Result<()> {
    if mode == cognia_companion::deployment::DeploymentMode::MultiTenant {
        return Err(refused("managed_desktop_delegation_unsupported_deployment"));
    }
    Ok(())
}

pub async fn dispatch(
    name: &str,
    args: Value,
    caller: Caller<'_>,
    runtime: Option<ManagedControlRuntime>,
    admin_check: Option<AdminAuthorityCheck>,
) -> Result<Value> {
    if matches!(name, "managed_desktop_delegate" | "managed_desktop_delegation_revoke" | "managed_desktop_delegation_list") {
        delegation_deployment(cognia_companion::deployment::deployment_mode())?;
    }
    if !COMMANDS.contains(&name) {
        return Err(refused("managed_desktop_unknown_command"));
    }
    let (service, host_id, directory, release) = INSTALLED
        .read()
        .as_ref()
        .map(|i| {
            (
                i.service.clone(),
                i.host_id.clone(),
                i.directory.clone(),
                i.release.clone(),
            )
        })
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))?;
    let device = caller.device_id.to_owned();
    let tenant = caller.tenant_id.map(str::to_owned);
    let scope = caller.scope.map(str::to_owned);
    let local = caller.local;
    let host = host_id.clone();
    let principal = match tokio::task::spawn_blocking(move || principal(&Caller {
        device_id: &device,
        tenant_id: tenant.as_deref(),
        scope: scope.as_deref(),
        local,
    }, &host)).await.map_err(|_| refused("managed_desktop_forbidden"))? {

        Ok(principal) => principal,
        Err(error) => {
            service.revoke_control_principal(caller.device_id).await;
            return Err(error);
        }
    };
    if matches!(
        name,
        "managed_desktop_delegate"
            | "managed_desktop_delegation_revoke"
            | "managed_desktop_config_save"
            | "managed_desktop_config_delete"
            | "managed_desktop_config_set_credential"
            | "managed_desktop_config_rotate_credential"
            | "managed_desktop_qualify_start"
            | "managed_desktop_qualify_approve"
            | "managed_desktop_qualify_cancel"
            | "managed_desktop_template_delete"
            | "managed_desktop_authorize"
            | "managed_desktop_prepare_template"
            | "managed_desktop_create"
            | "managed_desktop_delete"
            | "managed_desktop_control_acquire"
            | "managed_desktop_control_renew"
            | "managed_desktop_control_release"
            | "managed_desktop_control_input"
            | "managed_desktop_acceptance_start"
            | "managed_desktop_acceptance_attach"
            | "managed_desktop_acceptance_cancel"
    ) {
        principal.require_human()?;
        if !caller.local && admin_check.is_none() {
            return Err(refused("managed_desktop_control_admin_lease_expired"));
        }
    }
    let authority = HostAuthority {
        caller,
        host_id: &host_id,
        admin_check,
        input_policy: None,
        admission_observer: None,
    };
    if OPERATION_COMMANDS.contains(&name) {
        let a: OperationArgs = decode(args)?;
        let request = a.request(name)?;
        let delivered = std::sync::atomic::AtomicBool::new(false);
        let result = async {
            principal.require_admin()?;
            if !caller.local && authority.admin_check.is_none() {
                return Err(refused("managed_desktop_control_admin_lease_expired"));
            }
            request.validate()?;
            let runtime =
                runtime.ok_or_else(|| refused("managed_desktop_control_policy_unavailable"))?;
            let command = match name {
                "managed_desktop_files_read" => "managed_desktop_files_read",
                "managed_desktop_files_write" => "managed_desktop_files_write",
                "managed_desktop_clipboard_get" => "managed_desktop_clipboard_get",
                _ => "managed_desktop_clipboard_set",
            };
            execute_human_pipeline(
                &principal,
                &authority,
                HumanGateInput {
                    desktop_id: &a.desktop_id,
                    generation: a.generation,
                    fence: a.fence,
                    command,
                    point: None,
                    action: None,
                },
                runtime,
                &WorkspaceDelivery {
                    delivered: &delivered,
                    p: &principal,
                    service: &service,
                    args: &a,
                    request: request.clone(),
                },
            )
            .await
        }
        .await;
        if !delivered.load(std::sync::atomic::Ordering::SeqCst) {
            if let Err(error) = &result {
                if let Err(audit_error) = service
                    .record_operation_audit(&a.desktop_id, &request, &Err(error.clone()))
                    .await
                {
                    log::warn!("managed operation audit: {}", audit_error.code);
                }
            }
        }
        return finish_operation_result(name, &principal, &authority, result).await;
    }
    if crate::managed_desktop_results::COMMANDS.contains(&name) {
        let value = crate::managed_desktop_results::dispatch(&directory, &service, &principal, &authority, name, args).await?;
        if name == "managed_desktop_results_complete" {
            let cleanup = match acceptance_runtime() {
                Ok(runtime) => runtime.reconcile(&directory).await,
                Err(error) => Err(error),
            };
            if let Err(error) = cleanup {
                log::warn!("managed desktop acceptance post-complete cleanup: {}", error.code);
            }
        }
        return Ok(value);
    }
    let result = match name {
        "managed_desktop_acceptance_start" => {
            require_acceptance_admin(&authority.caller, &principal)?;
            delegation_deployment(cognia_companion::deployment::deployment_mode())?;
            authority.revalidate(&principal).await?;
            let current = qualification_principal_check(authority.caller, &host_id, &principal);
            let lease = authority.admin_check.clone();
            let current = Arc::new(move || { if let Some(check) = &lease { check()?; } current() });
            encode(acceptance_runtime()?.start(directory.clone(), principal.clone(), decode(args)?, current).await?)
        }
        "managed_desktop_acceptance_attach" => {
            require_acceptance_admin(&authority.caller, &principal)?;
            let a: crate::managed_desktop_acceptance::Attach = decode(args)?;
            let value = service.acceptance_attach(&principal,&a.acceptance_id,a.session_key,&authority).await?;
            acceptance_runtime()?.notify();
            encode(value)
        }
        "managed_desktop_acceptance_cancel" => {
            require_acceptance_admin(&authority.caller, &principal)?;
            let a: crate::managed_desktop_acceptance::RunId = decode(args)?;
            encode(acceptance_runtime()?.cancel(&directory,&principal,&a.acceptance_id,&authority).await?)
        }
        "managed_desktop_acceptance_status" => {
            require_acceptance_admin(&authority.caller, &principal)?;
            let a: crate::managed_desktop_acceptance::RunId = decode(args)?;
            encode(service.acceptance_status(&principal,&a.acceptance_id).await?)
        }
        "managed_desktop_acceptance_list" => {
            require_acceptance_admin(&authority.caller, &principal)?;
            let _: QualifyEmptyArgs = decode(args)?;
            Ok(serde_json::json!({"runs":service.acceptance_list(&principal).await?}))
        }
        "managed_desktop_acceptance_checkpoint" | "managed_desktop_acceptance_complete" => {
            crate::managed_desktop_acceptance::tools(&directory,acceptance_runtime()?.as_ref(),&principal,&authority,authority.caller.local,name,args).await
        }
        "managed_desktop_delegate" => {
            let a: DelegateArgs = decode(args)?;
            principal.require_admin()?;
            authority.revalidate(&principal).await?;
            let grant = service
                .delegate(
                    &principal,
                    &a.desktop_id,
                    a.generation,
                    a.grantee,
                    a.expires_at,
                    &authority,
                )
                .await?;
            Ok(delegation_json(&grant))
        }
        "managed_desktop_delegation_revoke" => {
            let a: DelegationRevokeArgs = decode(args)?;
            principal.require_admin()?;
            authority.revalidate(&principal).await?;
            let grant = service
                .delegation_revoke(&principal, &a.delegation_id, a.expected_revision, &authority)
                .await?;
            Ok(delegation_json(&grant))
        }
        "managed_desktop_delegation_list" => {
            let _: QualifyEmptyArgs = decode(args)?;
            let grants = service.delegation_list(&principal).await?;
            Ok(serde_json::json!({"delegations":grants.iter().map(delegation_json).collect::<Vec<_>>()}))
        }
        "managed_desktop_qualify_start" => {
            let a: QualifyStartArgs = decode(args)?;
            require_qualification_admin(&principal)?;
            authority.revalidate(&principal).await?;
            let runtime = qualification_runtime()?;
            let current = qualification_principal_check(caller, &host_id, &principal);
            encode(runtime.start(directory.clone(), principal.clone(), a.provider_config_id, a.scope, a.handoff, current).await?)
        }
        "managed_desktop_qualify_status" => {
            let a: QualifyRunArgs = decode(args)?;
            encode(service.qualification_status(&principal, &a.run_id).await?)
        }
        "managed_desktop_qualify_list" => {
            let _: QualifyEmptyArgs = decode(args)?;
            Ok(serde_json::json!({"runs":service.qualification_list(&principal).await?}))
        }
        "managed_desktop_qualify_approve" => {
            let a: QualifyApproveArgs = decode(args)?;
            require_qualification_admin(&principal)?;
            authority.revalidate(&principal).await?;
            encode(qualification_runtime()?.approve(&principal, &a.run_id, &a.quote_id).await?)
        }
        "managed_desktop_qualify_cancel" => {
            let a: QualifyRunArgs = decode(args)?;
            require_qualification_admin(&principal)?;
            authority.revalidate(&principal).await?;
            encode(qualification_runtime()?.cancel(&principal, &a.run_id).await?)
        }
        "managed_desktop_handoff_source_host" => {
            if args.as_object().is_none_or(|value| !value.is_empty()) { return Err(refused("managed_desktop_invalid_request")); }
            Ok(serde_json::json!({"hostId": host_id}))
        }
        "managed_desktop_handoff_deliveries" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = decode(args)?;
            let result = crate::managed_desktop_handoff::list(&directory, &principal).await?;
            authority.revalidate(&principal).await?;
            encode(result)
        }
        "managed_desktop_handoff_prepare" => {
            let result = crate::managed_desktop_handoff::prepare(&directory, &service, &principal, decode(args)?).await?;
            authority.revalidate(&principal).await?;
            encode(result)
        }
        "managed_desktop_handoff_revoke_source" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Revoke { conversation_ids: Vec<String> }
            let request: Revoke = decode(args)?;
            authority.revalidate(&principal).await?;
            crate::managed_desktop_handoff::revoke(&directory, &principal, request.conversation_ids).await?;
            Ok(Value::Null)
        }
        "managed_desktop_release_status" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = decode(args)?;
            encode(release)
        }
        "managed_desktop_config_save" => {
            let draft: ManagedDesktopConfigDraft = decode(args)?;
            authority.revalidate(&principal).await?;
            encode(service.save_config(&principal, draft).await?)
        }
        "managed_desktop_config_delete" => {
            let a: ConfigRevisionArgs = decode(args)?;
            authority.revalidate(&principal).await?;
            service
                .delete_config(&principal, &a.provider_config_id, a.expected_revision)
                .await?;
            Ok(Value::Null)
        }
        "managed_desktop_config_set_credential" | "managed_desktop_config_rotate_credential" => {
            let a: CredentialArgs = decode(args)?;
            authority.revalidate(&principal).await?;
            let key = credential_value(&directory, a.source).await?;
            let summary = if name == "managed_desktop_config_set_credential" {
                service
                    .set_credential(&principal, &a.provider_config_id, a.expected_revision, key)
                    .await?
            } else {
                service
                    .rotate_credential(&principal, &a.provider_config_id, a.expected_revision, key)
                    .await?
            };
            encode(summary)
        }
        "managed_desktop_template_list" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = decode(args)?;
            encode(service.list_templates(&principal).await?)
        }
        "managed_desktop_template_delete" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct TemplateArgs {
                template_id: String,
            }
            let a: TemplateArgs = decode(args)?;
            authority.revalidate(&principal).await?;
            encode(service.delete_template(&principal, &a.template_id).await?)
        }
        "managed_desktop_monitor" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = decode(args)?;
            encode(service.monitor(&principal).await?)
        }
        "managed_desktop_list_configs" => encode(service.list_configs(&principal).await?),
        "managed_desktop_list" => encode(service.list(&principal).await?),
        "managed_desktop_quote" => {
            let a: QuoteArgs = decode(args)?;
            encode(
                service
                    .quote(&principal, &a.provider_config_id, a.lifetime_seconds)
                    .await?,
            )
        }
        "managed_desktop_authorize" => {
            let a: AuthorizeArgs = decode(args)?;
            // A browser/agent can never qualify a provider or authorize smoke.
            if a.action == AuthorizationPurpose::Smoke {
                return Err(refused("managed_desktop_smoke_operator_only"));
            }
            principal.require_human()?;
            // The authenticated remote dispatcher already validated the
            // ADR-0153 lease. Its issuance owns Host consent; asking again
            // here would consume approval under an unrelated operation key.
            let authorization = service
                .authorize_with_authority(
                    &principal,
                    &a.provider_config_id,
                    &a.quote_id,
                    a.action,
                    None,
                    &authority,
                )
                .await?;
            Ok(serde_json::json!({"id":authorization.id,"expiresAt":authorization.expires_at}))
        }
        "managed_desktop_prepare_template" => {
            let a: CreateManagedDesktop = decode(args)?;
            let id = a.provider_config_id.clone();
            service.prepare_template_with_authority(&principal, a, &authority).await?;
            let summary = service
                .list_configs(&principal)
                .await?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| refused("managed_desktop_config_missing"))?;
            encode(summary)
        }
        "managed_desktop_create" => encode(service.create_with_authority(&principal, decode(args)?, &authority).await?),
        "managed_desktop_connect" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .connect(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_health" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .health(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_delete" => {
            let a: DesktopArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .delete_with_authority(&principal, &a.desktop_id, a.generation, &authority)
                    .await?,
            )
        }
        "managed_desktop_control_status" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .control_status(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_control_frame" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .control_frame(&principal, &a.desktop_id, a.generation, &authority)
                    .await?,
            )
        }
        "managed_desktop_control_acquire" => {
            let a: AcquireArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .control_acquire(
                        &principal,
                        &a.desktop_id,
                        a.generation,
                        a.takeover,
                        &authority,
                    )
                    .await?,
            )
        }
        "managed_desktop_control_renew" => {
            let a: LeaseArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .control_renew(
                        &principal,
                        &a.desktop_id,
                        a.generation,
                        &a.token,
                        a.fence,
                        &authority,
                    )
                    .await?,
            )
        }
        "managed_desktop_control_release" => {
            let a: LeaseArgs = decode(args)?;
            principal.require_human()?;
            service
                .control_release(
                    &principal,
                    &a.desktop_id,
                    a.generation,
                    &a.token,
                    a.fence,
                    &authority,
                )
                .await?;
            Ok(Value::Null)
        }
        "managed_desktop_control_input" => {
            let a: InputArgs = decode(args)?;
            principal.require_human()?;
            if !service
                .control_status(&principal, &a.desktop_id, a.generation)
                .await?
                .qualified
            {
                return Err(refused("managed_desktop_control_unqualified"));
            }
            let runtime =
                runtime.ok_or_else(|| refused("managed_desktop_control_policy_unavailable"))?;
            execute_input(&service, &principal, &authority, a, runtime).await?;
            Ok(Value::Null)
        }
        _ => Err(refused("managed_desktop_unknown_command")),
    };
    // A queued read must not return the previous account's projection after
    // revocation; accepted cleanup itself remains independent of this reply.
    authority.revalidate(&principal).await?;
    result
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn managed_desktop_local_call(
    app: tauri::AppHandle,
    name: String,
    args: Option<Value>,
) -> Result<Value> {
    use tauri::{Emitter, Manager};
    let automation = app.state::<cognia_automation::automation::commands::AutomationState>();
    let events_app = app.clone();
    let runtime = ManagedControlRuntime {
        enforcement: Enforcement::from_state(&automation),
        events: Arc::new(move |topic, value| {
            let _ = events_app.emit(topic, value);
        }),
        refresh_persisted: false,
    };
    let args = args.unwrap_or_else(|| serde_json::json!({}));
    dispatch(
        &name,
        args,
        Caller {
            device_id: LOCAL_DEVICE_ID,
            tenant_id: None,
            scope: None,
            local: true,
        },
        Some(runtime),
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct ObservedInput(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl HumanInputDelivery for ObservedInput {
        async fn deliver(
            &self,
            p: &ManagedDesktopPrincipal,
            _: InputArgs,
            authority: &dyn ManagedControlAuthority,
        ) -> Result<()> {
            authority.revalidate(p).await?;
            if !(authority.input_admission(p))() {
                return Err(refused("managed_desktop_forbidden"));
            }
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }
    fn native_request(
        action: cognia_remote_desktop::frames::NativeUiAction,
    ) -> cognia_automation::cua_sandbox::managed::frame_source::ManagedNativeInput {
        cognia_automation::cua_sandbox::managed::frame_source::ManagedNativeInput {
            desktop_id: "desktop".into(),
            generation: 1,
            lease: ManagedControlLease {
                token: "host-owned-lease".into(),
                fence: 1,
                expires_at: i64::MAX,
            },
            input: cognia_remote_desktop::frames::NativeInput {
                point: Some(cognia_remote_desktop::frames::NativePoint { x: 15, y: 15 }),
                frame_id: uuid::Uuid::new_v4().to_string(),
                action,
            },
        }
    }
    #[tokio::test]
    async fn broker_and_rpc_share_coordinate_deny_computer_use_deny_consent_and_allowed_input() {
        use cognia_automation::automation::{
            permission::Tier,
            policy::{Policy, ScreenRect},
        };
        use cognia_remote_desktop::{
            frames::{NativeDragOptions, NativePoint, NativeUiAction},
            session::Principal,
        };
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        host_identity::bind_local_account("native-gate-owner", "native-gate-owner").unwrap();
        let caller = OwnedCaller {
            device_id: LOCAL_DEVICE_ID.into(),
            tenant_id: None,
            local: true,
            host_id: "native-host".into(),
        };
        let p = principal(&caller.caller(), &caller.host_id).unwrap();
        for scenario in [
            "coordinate",
            "drag-destination",
            "computer-use-deny",
            "consent",
            "allowed",
        ] {
            let runtime = ManagedControlRuntime {
                enforcement: consent_enforcement(),
                refresh_persisted: false,
                events: Arc::new(|_, value| {
                    cognia_companion::host_consent::resolve(
                        value["id"].as_str().unwrap(),
                        false,
                        cognia_companion::host_consent::Approver::Host,
                    )
                    .unwrap();
                }),
            };
            runtime.enforcement.gate.update(|settings| {
                settings.enabled = scenario != "computer-use-deny";
                settings.per_surface.computer_use.tier = if scenario == "consent" {
                    Tier::PerCall
                } else {
                    Tier::Whitelist
                };
            });
            if matches!(scenario, "coordinate" | "drag-destination") {
                runtime
                    .enforcement
                    .policy
                    .set(Policy {
                        forbidden_screen_regions: vec![ScreenRect {
                            x: 10,
                            y: 10,
                            width: 20,
                            height: 20,
                        }],
                        ..Default::default()
                    })
                    .unwrap();
            }
            let action = if scenario == "drag-destination" {
                NativeUiAction::Drag {
                    to: NativePoint { x: 15, y: 15 },
                    opts: NativeDragOptions::default(),
                }
            } else {
                NativeUiAction::Click {
                    button: None,
                    count: Some(1),
                }
            };
            let mut request = native_request(action);
            if scenario == "drag-destination" {
                request.input.point = Some(NativePoint { x: 1, y: 1 });
            }
            let rpc: InputArgs = decode(serde_json::json!({"desktopId":request.desktop_id,"generation":1,"token":request.lease.token,"fence":1,
                "frameId":request.input.frame_id,"point":request.input.point,"action":request.input.action})).unwrap();
            let delivered = ObservedInput(Default::default());
            let broker_result = execute_native_input_with_delivery(
                &p,
                &caller,
                Principal::local(),
                request,
                runtime.clone(),
                &delivered,
            )
            .await;
            let authority = HostAuthority {
                caller: caller.caller(),
                host_id: &caller.host_id,
                admin_check: None,
                input_policy: None,
                admission_observer: None,
            };
            let rpc_result = execute_input_pipeline(&p, &authority, rpc, runtime, &delivered).await;
            assert_eq!(
                broker_result.as_ref().err().map(|error| &error.code),
                rpc_result.as_ref().err().map(|error| &error.code),
                "{scenario}"
            );
            if scenario == "allowed" {
                broker_result.unwrap();
                rpc_result.unwrap();
                assert_eq!(delivered.0.load(std::sync::atomic::Ordering::SeqCst), 2);
            } else {
                assert!(broker_result.is_err(), "{scenario}");
                assert_eq!(
                    delivered.0.load(std::sync::atomic::Ordering::SeqCst),
                    0,
                    "{scenario}"
                );
            }
        }
        cognia_companion::host_consent::forget_device(LOCAL_DEVICE_ID);
    }
    #[tokio::test]
    async fn broker_input_rechecks_live_control_and_account_identity() {
        use cognia_remote_desktop::{frames::NativeUiAction, session::Principal};
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        host_identity::bind_local_account("native-owner-a", "native-owner-a").unwrap();
        let caller = OwnedCaller {
            device_id: LOCAL_DEVICE_ID.into(),
            tenant_id: None,
            local: true,
            host_id: "native-host".into(),
        };
        let p = principal(&caller.caller(), &caller.host_id).unwrap();
        let runtime = || ManagedControlRuntime {
            enforcement: consent_enforcement(),
            events: Arc::new(|_, _| {}),
            refresh_persisted: false,
        };
        let delivered = ObservedInput(Default::default());
        let result = execute_native_input_with_delivery(
            &p,
            &caller,
            Principal::device("revoked", Arc::new(|_| false)),
            native_request(NativeUiAction::PressKey {
                chord: "Tab".into(),
            }),
            runtime(),
            &delivered,
        )
        .await;
        assert_eq!(
            result.unwrap_err().code,
            "managed_desktop_control_admin_lease_expired"
        );
        host_identity::bind_local_account("native-owner-b", "native-owner-b").unwrap();
        let result = execute_native_input_with_delivery(
            &p,
            &caller,
            Principal::local(),
            native_request(NativeUiAction::PressKey {
                chord: "Tab".into(),
            }),
            runtime(),
            &delivered,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(delivered.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn native_first_input_uses_the_explicit_live_runtime_and_obeys_live_deny() {
        use cognia_remote_desktop::{frames::NativeUiAction, session::Principal};
        let _scope = TestScope::new();
        let (_directory, service, p) = qualification_fixture(None).await;
        let caller = OwnedCaller {
            device_id: LOCAL_DEVICE_ID.into(),
            tenant_id: None,
            local: true,
            host_id: "test-host".into(),
        };
        let runtime = ManagedControlRuntime {
            enforcement: consent_enforcement(),
            events: Arc::new(|_, _| {}),
            refresh_persisted: false,
        };
        runtime
            .enforcement
            .gate
            .update(|settings| settings.enabled = false);
        install_native_control_runtime(runtime.clone()).unwrap();
        let selected = native_control_runtime(&service).await.unwrap();
        let delivered = ObservedInput(Default::default());
        let input = || {
            native_request(NativeUiAction::PressKey {
                chord: "Tab".into(),
            })
        };
        assert!(execute_native_input_with_delivery(
            &p,
            &caller,
            Principal::local(),
            input(),
            selected,
            &delivered
        )
        .await
        .is_err());
        assert_eq!(delivered.0.load(std::sync::atomic::Ordering::SeqCst), 0);
        runtime.enforcement.gate.update(|settings| {
            settings.enabled = true;
            settings.per_surface.computer_use.tier =
                cognia_automation::automation::permission::Tier::Whitelist;
        });
        execute_native_input_with_delivery(
            &p,
            &caller,
            Principal::local(),
            input(),
            native_control_runtime(&service).await.unwrap(),
            &delivered,
        )
        .await
        .unwrap();
        assert_eq!(delivered.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    use cognia_companion::security_store::{install_security_store, test_guard, SecurityStore};

    const NOW: i64 = 1_700_000_000;
    pub(super) struct TestScope {
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl TestScope {
        pub(super) fn new() -> Self {
            let scope = Self {
                _guard: test_guard(),
            };
            shutdown();
            host_identity::unbind_local_account();
            install_security_store(None);
            scope
        }
    }
    impl Drop for TestScope {
        fn drop(&mut self) {
            shutdown();
            host_identity::unbind_local_account();
            install_security_store(None);
        }
    }
    fn register_device(store: &SecurityStore, tenant: &str, device: &str, role: &str) {
        let challenge = store.issue_challenge(tenant, NOW, 600).unwrap();
        store
            .register_oidc_device(
                tenant,
                "test-actor",
                &cognia_companion::security_store::VerifiedDevicePerson {
                    user_id: "usr_managed_test".to_string().try_into().unwrap(),
                    org_id: "org_managed_test".to_string().try_into().unwrap(),
                },
                &challenge.id,
                &challenge.nonce,
                device,
                "Test device",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                &format!("thumb-{device}"),
                role,
                NOW,
            )
            .unwrap();
    }

    #[test]
    fn principal_uses_persisted_identity_and_rejects_revoked_or_cross_tenant_devices() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding =
            host_identity::bind_local_account("acct-managed-test", "digest-test").unwrap();
        let tenant = &binding.remote_tenant_id;
        register_device(&store, tenant, "owner-device", "owner");
        register_device(&store, tenant, "member-device", "member");
        for (device, expected) in [
            ("owner-device", ManagedDesktopAuthority::Administrator),
            ("member-device", ManagedDesktopAuthority::Human),
        ] {
            let actual = principal(
                &Caller {
                    device_id: device,
                    tenant_id: Some(tenant),
                    scope: None,
                    local: false,
                },
                "test-host",
            )
            .unwrap();
            assert_eq!(actual.authority, expected);
            assert_eq!(actual.owner_principal_id, "acct-managed-test");
            assert_eq!(actual.principal_id, device);
            assert_eq!(actual.host_id, "test-host");
        }
        let other = store.bind_host_account("acct-other", None, NOW).unwrap();
        let error = principal(
            &Caller {
                device_id: "member-device",
                tenant_id: Some(&other.tenant_id),
                scope: None,
                local: false,
            },
            "test-host",
        )
        .unwrap_err();
        assert_eq!(error.code, "managed_desktop_forbidden");
        store
            .revoke_device(tenant, "owner-device", "member-device", false, NOW + 1)
            .unwrap();
        assert_eq!(
            principal(
                &Caller {
                    device_id: "member-device",
                    tenant_id: Some(tenant),
                    scope: None,
                    local: false
                },
                "test-host"
            )
            .unwrap_err()
            .code,
            "managed_desktop_forbidden"
        );
        let challenge = store.issue_challenge(tenant, NOW, 600).unwrap();
        let enrollment = store
            .create_worker_enrollment(tenant, "owner-device", NOW, 600)
            .unwrap();
        store
            .register_worker_device(
                tenant,
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "worker-device",
                "Worker",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                "thumb-worker",
                NOW,
            )
            .unwrap();
        let worker = principal(
            &Caller {
                device_id: "worker-device",
                tenant_id: Some(tenant),
                scope: None,
                local: false,
            },
            "test-host",
        )
        .unwrap();
        assert_eq!(worker.authority, ManagedDesktopAuthority::Agent);
        assert!(worker.require_human().is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dormant_install_and_shutdown_release_the_exclusive_journal() {
        let _scope = TestScope::new();
        let directory = tempfile::tempdir().unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            install(directory.path(), None, "test-host", None),
        )
        .await
        .unwrap()
        .unwrap();
        let weak = {
            let installed = INSTALLED.read();
            let installed = installed.as_ref().unwrap();
            assert_eq!(installed.host_id, "test-host");
            Arc::downgrade(&installed.service)
        };
        assert!(journal::JournalStore::open(directory.path()).is_err());
        shutdown();
        assert!(INSTALLED.read().is_none());
        tokio::time::timeout(Duration::from_secs(5), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown must release the service");
        assert!(journal::JournalStore::open(directory.path()).is_ok());
    }
    #[test]
    fn service_and_worker_cannot_inherit_human_spend_authority() {
        assert_eq!(
            authority(false, Some("service"), false, true),
            ManagedDesktopAuthority::Agent
        );
        assert_eq!(
            authority(false, Some("device"), true, true),
            ManagedDesktopAuthority::Agent
        );
        assert_eq!(
            authority(false, None, false, false),
            ManagedDesktopAuthority::Human
        );
        assert_eq!(
            authority(false, Some("unknown"), false, false),
            ManagedDesktopAuthority::Observer
        );
        assert_eq!(
            authority(true, None, false, false),
            ManagedDesktopAuthority::Administrator
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn control_authority_rechecks_device_account_and_admin_lease() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-control", "digest-control").unwrap();
        register_device(&store, &binding.remote_tenant_id, "controller", "owner");
        let caller = Caller {
            device_id: "controller",
            tenant_id: Some(&binding.remote_tenant_id),
            scope: None,
            local: false,
        };
        let expected = principal(&caller, "host").unwrap();
        let expired = HostAuthority {
            caller,
            host_id: "host",
            admin_check: Some(Arc::new(|| {
                Err(refused("managed_desktop_control_admin_lease_expired"))
            })),
            input_policy: None,
            admission_observer: None,
        };
        assert!(!(expired.input_admission(&expected))());
        assert_eq!(
            expired.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_control_admin_lease_expired"
        );
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        authority.revalidate(&expected).await.unwrap();
        let live = authority.input_admission(&expected);
        assert!(live());
        store
            .revoke_device(
                &binding.remote_tenant_id,
                "controller",
                "controller",
                true,
                NOW + 1,
            )
            .unwrap();
        assert!(!live());
        assert_eq!(
            authority.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_forbidden"
        );
        let caller = Caller {
            device_id: "local-desktop",
            tenant_id: None,
            scope: None,
            local: true,
        };
        let expected = principal(&caller, "host").unwrap();
        host_identity::bind_local_account("acct-rebound", "digest-rebound").unwrap();
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        assert_eq!(
            authority.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_forbidden"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn actual_dispatch_refuses_service_input_before_control_or_policy() {
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        let binding = host_identity::bind_local_account("acct-control", "digest-control").unwrap();
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), None, "host", None).await.unwrap();
        let result = dispatch(
            "managed_desktop_control_input",
            serde_json::json!({
                "desktopId":"desktop", "generation":1, "token":"token", "fence":1,
                "frameId":"frame", "action":{"kind":"typeText", "text":"hello"}
            }),
            Caller {
                device_id: "service",
                tenant_id: Some(&binding.remote_tenant_id),
                scope: Some("service"),
                local: false,
            },
            None,
            None,
        )
        .await;
        assert_eq!(
            result.unwrap_err().code,
            "managed_desktop_human_authorization_required"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lifecycle_dispatch_requires_a_live_admin_check_for_remote_humans() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-lifecycle", "digest-lifecycle").unwrap();
        register_device(&store, &binding.remote_tenant_id, "controller", "owner");
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), None, "host", None).await.unwrap();
        for command in ["managed_desktop_authorize", "managed_desktop_prepare_template", "managed_desktop_create", "managed_desktop_delete"] {
            let result = dispatch(command, serde_json::json!({}), Caller {
                device_id: "controller", tenant_id: Some(&binding.remote_tenant_id), scope: None, local: false,
            }, None, None).await;
            assert_eq!(result.unwrap_err().code, "managed_desktop_control_admin_lease_expired", "{command}");
        }
    }

    #[test]
    fn control_request_identity_and_policy_facts_cannot_be_supplied() {
        let input = serde_json::json!({"desktopId":"desktop", "generation":1, "token":"token", "fence":1, "frameId":"frame", "action":{"kind":"typeText","text":"hello"}});
        assert!(decode::<InputArgs>(input.clone()).is_ok());
        for field in [
            "ownerPrincipalId",
            "principalId",
            "hostId",
            "scope",
            "processName",
            "targetUrl",
            "policy",
            "confirmed",
            "adminLease",
        ] {
            let mut forged = input.clone();
            forged[field] = Value::Bool(true);
            assert!(decode::<InputArgs>(forged).is_err(), "{field}");
        }
        assert!(input_command(&UiAction::SetValue {
            value: "value".into()
        })
        .is_err());
        for action in [
            serde_json::json!({"kind":"click", "count":4}),
            serde_json::json!({"kind":"typeText", "text":"safe", "confirmed":true}),
            serde_json::json!({"kind":"pressKey", "chord":"x".repeat(257)}),
        ] {
            let mut invalid = input.clone();
            invalid["action"] = action;
            assert!(decode::<InputArgs>(invalid).is_err());
        }
        assert_eq!(
            policy_error(AutomationError::BackendError {
                message: "https://private.example/token".into()
            })
            .code,
            "managed_desktop_control_policy_denied"
        );
    }

    #[test]
    fn input_guard_rechecks_live_policy_and_does_not_treat_keys_or_text_as_reads() {
        use cognia_automation::automation::permission::{Call, CallKind, PermissionGate, Tier};
        let gate = PermissionGate::new(Default::default());
        gate.update(|settings| {
            settings.enabled = true;
            settings.per_surface.computer_use.tier = Tier::Whitelist;
        });
        let runtime = ManagedControlRuntime {
            enforcement: Enforcement {
                gate,
                audit: cognia_automation::automation::audit::AuditRing::new(),
                consent: Default::default(),
                policy: Default::default(),
                consent_event_sink: None,
            },
            events: Arc::new(|_, _| {}),
            refresh_persisted: false,
        };
        let action = UiAction::TypeText {
            text: "private content".into(),
        };
        let command = input_command(&action).unwrap();
        assert!(matches!(
            Call {
                command,
                surface: Surface::ComputerUse,
                plugin_id: None,
                target: Default::default()
            }
            .kind(),
            CallKind::Driving
        ));
        assert!(matches!(
            Call {
                command: input_command(&UiAction::PressKey {
                    chord: cognia_automation::automation::types::KeyChord("enter".into())
                })
                .unwrap(),
                surface: Surface::ComputerUse,
                plugin_id: None,
                target: Default::default()
            }
            .kind(),
            CallKind::Driving
        ));
        let guard = InputPolicyGuard::new(&runtime, command, None, &action);
        guard.check().unwrap();
        runtime
            .enforcement
            .policy
            .set(cognia_automation::automation::policy::Policy {
                allowed_url_patterns: vec![".*".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_target_unverified"
        );
        runtime.enforcement.policy.set(Default::default()).unwrap();
        runtime
            .enforcement
            .gate
            .update(|settings| settings.per_surface.computer_use.tier = Tier::PerCall);
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_consent_required"
        );
        runtime
            .enforcement
            .gate
            .update(|settings| settings.enabled = false);
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_policy_denied"
        );
    }

    fn consent_enforcement() -> Enforcement {
        let gate =
            cognia_automation::automation::permission::PermissionGate::new(Default::default());
        gate.update(|settings| {
            settings.enabled = true;
            settings.per_surface.computer_use.tier =
                cognia_automation::automation::permission::Tier::PerCall;
        });
        Enforcement {
            gate,
            audit: cognia_automation::automation::audit::AuditRing::new(),
            consent: Default::default(),
            policy: Default::default(),
            consent_event_sink: None,
        }
    }
    async fn request_bridge(enforcement: &Enforcement, timeout: u64) -> bool {
        let sink = enforcement.consent_event_sink.as_ref().unwrap().clone();
        enforcement
            .consent
            .request_with_emitter(
                cognia_automation::automation::permission::ConsentPrompt {
                    command: "type".into(),
                    surface: Surface::ComputerUse,
                    plugin_id: None,
                    process_name: None,
                    window_title: None,
                    command_detail: Some("Managed desktop desk".into()),
                    session_key: Some("same-session".into()),
                },
                timeout,
                None,
                move |event| sink(event),
            )
            .await
    }
    #[tokio::test(flavor = "current_thread")]
    async fn host_consent_bridge_is_one_shot_and_denial_or_timeout_cannot_deliver_input() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut enforcement = consent_enforcement();
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let device = format!("consent-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(move |_, value| {
                assert!(value["operations"][0]
                    .as_str()
                    .unwrap()
                    .contains("desk:generation=2:fence=3:type:"));
                let count = seen.fetch_add(1, Ordering::SeqCst);
                if count < 2 {
                    cognia_companion::host_consent::resolve(
                        value["id"].as_str().unwrap(),
                        count == 0,
                        cognia_companion::host_consent::Approver::Host,
                    )
                    .unwrap();
                }
            }),
            device.clone(),
            Some("tenant".into()),
            "desk:generation=2:fence=3".into(),
            "type",
        );
        let mut delivered = 0;
        for _ in 0..3 {
            if request_bridge(&enforcement, 25).await {
                delivered += 1;
            }
        }
        assert_eq!(
            delivered, 1,
            "approval must not establish a session grant; denial and timeout cannot execute"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        drop(tasks);
        cognia_companion::host_consent::forget_device(&device);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn approval_between_consumption_and_pending_snapshot_is_not_denied() {
        let mut enforcement = consent_enforcement();
        let broker = enforcement.consent.clone();
        let device = format!("race-test-{}", uuid::Uuid::new_v4());
        let requester = device.clone();
        enforcement.consent_event_sink = Some(Arc::new(move |event| {
            let operations = vec![format!("managed-desktop:race:{}", event.id)];
            let ask = cognia_companion::host_consent::request(&requester, None, operations.clone());
            // Deterministically place Host approval between the bridge's first
            // take_approved and its subsequent pending-state snapshot.
            assert!(!cognia_companion::host_consent::take_approved(&requester, &operations));
            cognia_companion::host_consent::resolve(&ask.id, true,
                cognia_companion::host_consent::Approver::Host).unwrap();
            assert!(!cognia_companion::host_consent::pending().iter().any(|request| request.id == ask.id));
            resolve_closed_host_consent(&broker, &event.id, &requester, &operations);
            assert!(!cognia_companion::host_consent::take_approved(&requester, &operations));
            Ok(())
        }));
        assert!(request_bridge(&enforcement, 1_000).await);
        cognia_companion::host_consent::forget_device(&device);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn explicit_host_denial_resolves_before_the_consent_timeout() {
        let mut enforcement = consent_enforcement();
        let device = format!("denied-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(|_, value| {
                cognia_companion::host_consent::resolve(
                    value["id"].as_str().unwrap(), false,
                    cognia_companion::host_consent::Approver::Host,
                ).unwrap();
            }), device.clone(), None, "desk:generation=2:fence=3".into(), "type",
        );
        let result = tokio::time::timeout(Duration::from_secs(1), request_bridge(&enforcement, 5_000)).await;
        assert_eq!(result.unwrap(), false);
        drop(tasks);
        cognia_companion::host_consent::forget_device(&device);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_consent_wait_cannot_be_replayed_by_a_late_approval() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut enforcement = consent_enforcement();
        let request_id = Arc::new(parking_lot::Mutex::new(None::<String>));
        let observed = request_id.clone();
        let device = format!("cancel-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(move |_, value| {
                *observed.lock() = Some(value["id"].as_str().unwrap().into());
            }),
            device.clone(),
            None,
            "desk:generation=2:fence=3".into(),
            "type",
        );
        let delivered = Arc::new(AtomicUsize::new(0));
        let count = delivered.clone();
        let request = tokio::spawn(async move {
            if request_bridge(&enforcement, 1000).await {
                count.fetch_add(1, Ordering::SeqCst);
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while request_id.lock().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        drop(tasks);
        let id = request_id.lock().clone().unwrap();
        cognia_companion::host_consent::resolve(
            &id,
            true,
            cognia_companion::host_consent::Approver::Host,
        )
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
        cognia_companion::host_consent::forget_device(&device);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn execute_input_rechecks_account_after_host_approval() {
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        host_identity::bind_local_account("acct-consent", "digest-consent").unwrap();
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), None, "host", None).await.unwrap();
        let service = INSTALLED.read().as_ref().unwrap().service.clone();
        let caller = Caller {
            device_id: "local-desktop",
            tenant_id: None,
            scope: None,
            local: true,
        };
        let p = principal(&caller, "host").unwrap();
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        let result = execute_input(
            &service,
            &p,
            &authority,
            InputArgs {
                desktop_id: "desk".into(),
                generation: 1,
                token: "lease".into(),
                fence: 1,
                frame_id: "frame".into(),
                point: None,
                action: UiAction::TypeText {
                    text: "private".into(),
                },
            },
            ManagedControlRuntime {
                enforcement: consent_enforcement(),
                refresh_persisted: false,
                events: Arc::new(|_, value| {
                    host_identity::unbind_local_account();
                    cognia_companion::host_consent::resolve(
                        value["id"].as_str().unwrap(),
                        true,
                        cognia_companion::host_consent::Approver::Host,
                    )
                    .unwrap();
                }),
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "managed_desktop_account_required");
        cognia_companion::host_consent::forget_device("local-desktop");
    }

    #[test]
    fn headless_policy_snapshot_change_fences_an_existing_input_guard() {
        let _scope = TestScope::new();
        let saved = {
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            let saved = (snapshot.version, snapshot.available);
            snapshot.version = 10;
            snapshot.available = true;
            saved
        };
        let runtime = ManagedControlRuntime {
            enforcement: consent_enforcement(),
            events: Arc::new(|_, _| {}),
            refresh_persisted: true,
        };
        let guard = InputPolicyGuard::new(
            &runtime,
            "type",
            None,
            &UiAction::TypeText {
                text: "text".into(),
            },
        );
        guard.check().unwrap();
        HEADLESS_POLICY_SNAPSHOT.write().version = 11;
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_policy_changed"
        );
        let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
        snapshot.version = saved.0;
        snapshot.available = saved.1;
    }
    #[test]
    fn rpc_payloads_cannot_supply_owner_principal_or_confirmation() {
        for key in [
            "ownerPrincipalId",
            "hostId",
            "confirmed",
            "userInitiated",
            "scope",
        ] {
            let mut value =
                serde_json::json!({"providerConfigId":"p","quoteId":"q","action":"create"});
            value[key] = Value::Bool(true);
            assert!(decode::<AuthorizeArgs>(value).is_err());
        }
        assert_eq!(
            COMMANDS
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            COMMANDS.len()
        );
    }

    #[tokio::test]
    async fn native_frame_viewers_map_through_the_pairing_store_and_never_input() {
        use cognia_remote_desktop::session::{Principal, SessionMode};
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-frames", "digest-frames").unwrap();
        register_device(&store, &binding.remote_tenant_id, "owner-phone", "owner");
        register_device(&store, &binding.remote_tenant_id, "member-phone", "member");
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), None, "host", None).await.unwrap();
        let view = |device: &str| Principal::device(device, Arc::new(|mode| mode == SessionMode::View));

        let local = native_frame_context(Principal::local()).await.unwrap();
        assert_eq!(local.principal.authority, ManagedDesktopAuthority::Administrator);
        assert_eq!(local.principal.principal_id, LOCAL_DEVICE_ID);
        let owner = native_frame_context(view("owner-phone")).await.unwrap();
        assert_eq!(owner.principal.principal_id, "owner-phone");
        assert_eq!(owner.principal.authority, ManagedDesktopAuthority::Administrator);
        let member = native_frame_context(view("member-phone")).await.unwrap();
        assert_eq!(member.principal.authority, ManagedDesktopAuthority::Human);
        // The owner's identity, never the viewer's claim, names the account.
        assert_eq!(member.principal.owner_principal_id, owner.principal.owner_principal_id);
        // Unknown devices and malformed principals are refused.
        assert_eq!(
            native_frame_context(view("stranger")).await.err().unwrap().code,
            "remote_desktop_forbidden"
        );
        // Observation never admits input. A revoked device keeps its cached
        // authority for at most one admission interval, then is refused.
        assert!(!(owner.authority.input_admission(&owner.principal))());
        owner.authority.revalidate(&owner.principal).await.unwrap();
        store.revoke_device(&binding.remote_tenant_id, "test-actor", "owner-phone", true, NOW).unwrap();
        owner.authority.revalidate(&owner.principal).await.unwrap();
        tokio::time::sleep(
            cognia_remote_desktop::session::ADMISSION_INTERVAL + std::time::Duration::from_millis(50),
        )
        .await;
        assert_eq!(
            owner.authority.revalidate(&owner.principal).await.unwrap_err().code,
            "managed_desktop_forbidden"
        );
    }

    #[tokio::test]
    async fn configuration_and_template_writes_need_the_admin_lease_remotely() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-config", "digest-config").unwrap();
        register_device(&store, &binding.remote_tenant_id, "controller", "owner");
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), None, "host", None).await.unwrap();
        for command in [
            "managed_desktop_config_save",
            "managed_desktop_config_delete",
            "managed_desktop_config_set_credential",
            "managed_desktop_config_rotate_credential",
            "managed_desktop_template_delete",
        ] {
            let result = dispatch(command, serde_json::json!({}), Caller {
                device_id: "controller", tenant_id: Some(&binding.remote_tenant_id), scope: None, local: false,
            }, None, None).await;
            assert_eq!(result.unwrap_err().code, "managed_desktop_control_admin_lease_expired", "{command}");
        }
        // Reads stay observe-only and never need the lease.
        for command in ["managed_desktop_release_status", "managed_desktop_template_list", "managed_desktop_monitor"] {
            let result = dispatch(command, serde_json::json!({}), Caller {
                device_id: "controller", tenant_id: Some(&binding.remote_tenant_id), scope: None, local: false,
            }, None, None).await;
            assert!(result.is_ok(), "{command}: {result:?}");
        }
    }

    #[tokio::test]
    async fn a_copied_key_comes_only_from_a_stored_e2b_code_sandbox_credential() {
        use cognia_sandbox_pool::{
            desktop::DesktopRemoteSandboxes,
            providers::{CredentialSource, ProviderConfig, ProviderKind, ProviderLimitsConfig, SandboxProvidersFile},
        };
        let _scope = TestScope::new();
        let directory = tempfile::tempdir().unwrap();
        let provider = |id: &str, credential: CredentialSource| ProviderConfig {
            id: id.into(),
            kind: ProviderKind::E2b,
            label: None,
            credential: Some(credential),
            limits: ProviderLimitsConfig::default(),
            settings: serde_json::json!({}),
        };
        DesktopRemoteSandboxes {
            version: 1,
            providers: SandboxProvidersFile {
                version: 1,
                providers: vec![
                    provider("main", CredentialSource::SecretId("remote-sandbox:main".into())),
                    provider("envkey", CredentialSource::Env("E2B_API_KEY".into())),
                    provider("empty", CredentialSource::SecretId("remote-sandbox:empty".into())),
                ],
                default_provider_id: None,
            },
            registry_allowlist: Vec::new(),
        }
        .save(directory.path())
        .unwrap();
        cognia_secrets::secret_store::set(
            cognia_companion::remote_sandboxes::SECRET_SERVICE,
            "remote-sandbox:main",
            " e2b_copied ",
        )
        .unwrap();
        let copy = |id: &str| CredentialSourceArgs::RemoteSandbox { provider_id: id.into() };
        assert_eq!(credential_value(directory.path(), copy("main")).await.unwrap().0, "e2b_copied");
        for (id, code) in [
            ("envkey", "managed_desktop_credential_source_unsupported"),
            ("empty", "managed_desktop_credential_source_empty"),
            ("missing", "managed_desktop_credential_source_not_found"),
        ] {
            assert_eq!(credential_value(directory.path(), copy(id)).await.unwrap_err().code, code, "{id}");
        }
        assert_eq!(
            credential_value(directory.path(), CredentialSourceArgs::Key { key: "two words".into() })
                .await
                .unwrap_err()
                .code,
            "managed_desktop_secret_invalid"
        );
        // The copy never left a trace under the desktop secret service.
        assert!(cognia_secrets::secret_store::get(SECRET_SERVICE, "remote-sandbox:main").unwrap().is_none());
    }

    #[tokio::test]
    async fn release_status_reports_the_bundled_manifest_without_a_path() {
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        host_identity::bind_local_account("acct-release", "digest-release").unwrap();
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), Some(&directory.path().join("absent-bundle")), "host", None)
            .await
            .unwrap();
        let status = dispatch(
            "managed_desktop_release_status",
            serde_json::json!({}),
            Caller { device_id: "local", tenant_id: None, scope: None, local: true },
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "absent");
        assert_eq!(status["source"], serde_json::Value::Null);
        assert!(dispatch(
            "managed_desktop_release_status",
            serde_json::json!({"path": "/etc"}),
            Caller { device_id: "local", tenant_id: None, scope: None, local: true },
            None,
            None,
        )
        .await
        .is_err());
    }
    struct QualificationVerifier;
    #[async_trait]
    impl ManagedDesktopImageVerifier for QualificationVerifier {
        async fn verify(&self, _: &DesktopRelease) -> Result<()> {
            Ok(())
        }
    }
    pub(super) async fn qualification_fixture(
        events: Option<HostEventSink>,
    ) -> (tempfile::TempDir, Arc<ManagedDesktopService>, ManagedDesktopPrincipal) {
        qualification_fixture_with_provider(
            events, Arc::new(E2bDesktopProvider::new(Arc::new(QualificationVerifier))),
        ).await
    }
    pub(super) async fn qualification_fixture_with_provider(
        events: Option<HostEventSink>,
        provider: Arc<dyn ManagedDesktopProvider>,
    ) -> (tempfile::TempDir, Arc<ManagedDesktopService>, ManagedDesktopPrincipal) {
        let directory = tempfile::tempdir().unwrap();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("qualification-account", "digest").unwrap();
        register_device(&store, &binding.remote_tenant_id, "owner-device", "owner");
        register_device(&store, &binding.remote_tenant_id, "member-device", "member");
        let p = principal(&Caller {
            device_id: LOCAL_DEVICE_ID,
            tenant_id: None,
            scope: None,
            local: true,
        }, "test-host").unwrap();
        let release = DesktopRelease {
            image: format!("example.test/desktop@sha256:{}", "a".repeat(64)),
            image_digest: format!("sha256:{}", "a".repeat(64)),
            architecture: "linux/amd64".into(),
            recipe_revision: "7".into(),
            protocol: "computer-server-0.3.46".into(),
            server_version: "0.3.46".into(),
            start_command: "sleep infinity".into(),
            ready_command: "test -x /usr/local/bin/cognia-desktop".into(),
        };
        let vault = Arc::new(FileManagedDesktopSecrets::open(&directory.path().join("vault")).unwrap());
        let service = Arc::new(ManagedDesktopService::open(
            directory.path(), "test-host".into(), provider, vault, Some(release),
        ).unwrap());
        let draft: ManagedDesktopConfigDraft = decode(serde_json::json!({
            "id":"e2b","expectedRevision":null,"enabled":true,"shape":{"cpuCount":2,"memoryMb":2048},
            "limits":{"maxConcurrent":2,"maxLifetimeSeconds":3600,"idleTimeoutSeconds":600},
            "plan":{"maxLifetimeSeconds":3600,"source":"operator-confirmed","namespace":"team","validForMs":600000},
            "price":{"currency":"USD","hourlyRateMicros":100000,"source":"price-sheet","validForMs":600000},
            "egress":{"mode":"off"},"isolationMinimum":"vm"
        })).unwrap();
        service.save_config(&p, draft).await.unwrap();
        install_delegation_runtime(&service, events.clone());
        let qualification = Arc::new(qualification::QualificationRuntime::new(service.clone(), events));
        *INSTALLED.write() = Some(Installed {
            directory: directory.path().to_owned(),
            service: service.clone(),
            host_id: "test-host".into(),
            release: crate::managed_desktop_release::ReleaseStatus::of(&Ok(None)),
            worker: tokio::spawn(std::future::pending()),
            qualification,
            acceptance: Arc::new(crate::managed_desktop_acceptance::AcceptanceRuntime::new(
                service.clone(),
                None,
            )),
            events: None,
            control_runtime: None,
        });
        (directory, service, p)
    }
    #[tokio::test]
    async fn operation_reads_revalidate_before_returning_content_and_keep_refusal_codes() {
        struct Revoked;
        #[async_trait]
        impl ManagedControlAuthority for Revoked {
            async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
                Err(refused("managed_desktop_forbidden"))
            }
            fn input_admission(
                &self,
                _: &ManagedDesktopPrincipal,
            ) -> Arc<dyn Fn() -> bool + Send + Sync> {
                Arc::new(|| false)
            }
        }
        let principal = ManagedDesktopPrincipal {
            owner_principal_id: "owner".into(),
            principal_id: "owner".into(),
            host_id: "host".into(),
            authority: ManagedDesktopAuthority::Administrator,
        };
        for name in [
            "managed_desktop_files_read",
            "managed_desktop_clipboard_get",
        ] {
            assert_eq!(
                finish_operation_result(
                    name,
                    &principal,
                    &Revoked,
                    Ok(serde_json::json!({"text":"private"}))
                )
                .await
                .unwrap_err()
                .code,
                "managed_desktop_forbidden"
            );
            assert_eq!(
                finish_operation_result(
                    name,
                    &principal,
                    &Revoked,
                    Err(refused("managed_desktop_operation_refused"))
                )
                .await
                .unwrap_err()
                .code,
                "managed_desktop_operation_refused"
            );
        }
        assert!(finish_operation_result(
            "managed_desktop_files_write",
            &principal,
            &Revoked,
            Ok(Value::Null)
        )
        .await
        .is_ok());
    }
    #[test]
    fn operation_rpc_shapes_are_closed_and_bounded() {
        let common =
            serde_json::json!({"desktopId":"desktop","generation":1,"token":"holder","fence":2});
        for command in OPERATION_COMMANDS {
            let mut args = common.clone();
            if command.ends_with("files_read") {
                args["path"] = serde_json::json!("/home/cua/a");
                args["offset"] = serde_json::json!(0);
                args["length"] = serde_json::json!(65536);
            }
            if command.ends_with("files_write") {
                args["path"] = serde_json::json!("/home/cua/a");
                args["offset"] = serde_json::json!(0);
                args["chunk"] = serde_json::json!([0, 255]);
                args["final"] = serde_json::json!(true);
            }
            if command.ends_with("clipboard_set") {
                args["text"] = serde_json::json!("private text");
            }
            let a: OperationArgs = decode(args.clone()).unwrap();
            a.request(command).unwrap().validate().unwrap();
            args["ownerPrincipalId"] = serde_json::json!("forged");
            assert!(decode::<OperationArgs>(args).is_err());
        }
        let mut a: OperationArgs = decode(common).unwrap();
        a.text = Some("unexpected".into());
        assert!(a.request("managed_desktop_clipboard_get").is_err());
    }
    #[tokio::test]
    async fn operation_dispatch_requires_admin_and_remote_step_up_and_audits_refusals() {
        let _scope = TestScope::new();
        let (directory, _, _) = qualification_fixture(None).await;
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        let args =
            serde_json::json!({"desktopId":"desktop","generation":1,"token":"holder","fence":2});
        for command in OPERATION_COMMANDS {
            let mut request = args.clone();
            if command.ends_with("files_read") {
                request["path"] = serde_json::json!("/home/cua/private-name");
                request["offset"] = serde_json::json!(0);
                request["length"] = serde_json::json!(1);
            }
            if command.ends_with("files_write") {
                request["path"] = serde_json::json!("/home/cua/private-name");
                request["offset"] = serde_json::json!(0);
                request["chunk"] = serde_json::json!([83, 69, 67]);
                request["final"] = serde_json::json!(true);
            }
            if command.ends_with("clipboard_set") {
                request["text"] = serde_json::json!("private text");
            }
            let caller = Caller {
                device_id: "owner-device",
                tenant_id: Some(&tenant),
                scope: Some("device"),
                local: false,
            };
            assert_eq!(
                dispatch(command, request.clone(), caller, None, None)
                    .await
                    .unwrap_err()
                    .code,
                "managed_desktop_control_admin_lease_expired"
            );
            let member = Caller {
                device_id: "member-device",
                ..caller
            };
            assert_eq!(
                dispatch(
                    command,
                    request.clone(),
                    member,
                    None,
                    Some(Arc::new(|| Ok(())))
                )
                .await
                .unwrap_err()
                .code,
                "managed_desktop_admin_required"
            );
            assert_ne!(
                dispatch(command, request, local_qualification_caller(), None, None)
                    .await
                    .unwrap_err()
                    .code,
                "managed_desktop_unknown_command"
            );
        }
        let data = std::fs::read_to_string(directory.path().join("managed-desktops-journal.json"))
            .unwrap();
        assert!(!data.contains("private-name") && !data.contains("private text"));
        assert!(
            serde_json::from_str::<Value>(&data).unwrap()["operationAudit"]
                .as_array()
                .unwrap()
                .len()
                >= 8
        );
    }

    fn local_qualification_caller() -> Caller<'static> {
        Caller {
            device_id: LOCAL_DEVICE_ID,
            tenant_id: None,
            scope: None,
            local: true,
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn qualification_rpc_pauses_with_disclosure_binds_quote_and_cancels_without_spend() {
        let _scope = TestScope::new();
        let events = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = events.clone();
        let (directory, service, p) = qualification_fixture(Some(Arc::new(move |topic, value| {
            captured.lock().push((topic.to_owned(), value));
        }))).await;
        let start = dispatch(
            "managed_desktop_qualify_start", serde_json::json!({"providerConfigId":"e2b","scope":"gui"}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(start["categories"].as_array().unwrap().len(), 4);
        let id = start["runId"].as_str().unwrap();
        let awaiting = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let run = dispatch(
                    "managed_desktop_qualify_status", serde_json::json!({"runId":id}),
                    local_qualification_caller(), None, None,
                ).await.unwrap();
                if run["state"] == "awaitingApproval" {
                    break run;
                }
                assert_eq!(run["state"], "running");
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert_eq!(awaiting["awaitingApproval"]["purpose"], "prepareTemplate");
        assert_eq!(awaiting["awaitingApproval"]["templateBuildCharges"], true);
        assert_eq!(dispatch(
            "managed_desktop_qualify_approve", serde_json::json!({"runId":id,"quoteId":"wrong"}),
            local_qualification_caller(), None, None,
        ).await.unwrap_err().code, "managed_desktop_qualification_quote_mismatch");
        assert_eq!(dispatch(
            "managed_desktop_qualify_start", serde_json::json!({"providerConfigId":"e2b","scope":"gui"}),
            local_qualification_caller(), None, None,
        ).await.unwrap_err().code, "managed_desktop_qualification_running");
        let cancelled = dispatch(
            "managed_desktop_qualify_cancel", serde_json::json!({"runId":id}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(cancelled["state"], "cancelled");
        assert!(service.list(&p).await.unwrap().is_empty());
        assert!(service.list_templates(&p).await.unwrap().is_empty());
        assert!(journal::JournalStore::open(directory.path()).is_err(), "the installed journal remains exclusively held");
        let runs = dispatch(
            "managed_desktop_qualify_list", serde_json::json!({}), local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(runs["runs"].as_array().unwrap().len(), 1);
        assert!(events.lock().iter().all(|(topic, value)| {
            topic == QUALIFICATION_CHANGED_TOPIC && *value == serde_json::json!({})
        }));
        assert!(!events.lock().is_empty());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn qualification_rpc_approval_is_separate_and_status_preserves_terminal_results() {
        let _scope = TestScope::new();
        let (_directory, service, p) = qualification_fixture(None).await;
        for terminal in [QualificationRunState::Passed, QualificationRunState::Failed] {
            let run = service.qualification_start(&p, "e2b", QualificationScope::Gui, None).await.unwrap();
            let quote = service.quote(&p, "e2b", 120).await.unwrap();
            service.qualification_await_quote(&p, &run.run_id, quote.clone(), AuthorizationPurpose::Smoke).await.unwrap();
            let approved = dispatch(
                "managed_desktop_qualify_approve", serde_json::json!({"runId":run.run_id,"quoteId":quote.id}),
                local_qualification_caller(), None, None,
            ).await.unwrap();
            assert_eq!(approved["state"], "running");
            assert!(approved["awaitingApproval"].is_null());
            assert_eq!(dispatch(
                "managed_desktop_qualify_approve", serde_json::json!({"runId":run.run_id,"quoteId":quote.id}),
                local_qualification_caller(), None, None,
            ).await.unwrap_err().code, "managed_desktop_qualification_not_awaiting");
            for category in &run.categories {
                service.qualification_category(&p, &run.run_id, category.category, QualificationCategoryState::Running).await.unwrap();
                if terminal == QualificationRunState::Failed {
                    break;
                }
                service.qualification_category(&p, &run.run_id, category.category, QualificationCategoryState::Passed).await.unwrap();
            }
            service.qualification_finish(
                &p, &run.run_id, terminal,
                (terminal == QualificationRunState::Failed).then(|| "managed_desktop_control_smoke_failed".into()),
            ).await.unwrap();
            let status = dispatch(
                "managed_desktop_qualify_status", serde_json::json!({"runId":run.run_id}),
                local_qualification_caller(), None, None,
            ).await.unwrap();
            assert_eq!(status["state"], serde_json::to_value(terminal).unwrap());
            assert!(status["finishedAt"].is_i64());
        }
        assert_eq!(dispatch(
            "managed_desktop_qualify_status", serde_json::json!({"runId":"missing"}),
            local_qualification_caller(), None, None,
        ).await.unwrap_err().code, "managed_desktop_qualification_not_found");
    }
    #[tokio::test(flavor = "current_thread")]
    async fn qualification_rpc_refuses_unknown_delivery_agents_services_members_and_missing_lease() {
        let _scope = TestScope::new();
        let (_directory, service, p) = qualification_fixture(None).await;
        let args = serde_json::json!({"providerConfigId":"e2b","scope":"acceptance","handoff":{"deliveryId":"unknown","script":"dev"}});
        assert_eq!(dispatch(
            "managed_desktop_qualify_start", args, local_qualification_caller(), None, None,
        ).await.unwrap_err().code, "managed_desktop_handoff_delivery_unknown");
        assert!(service.qualification_list(&p).await.unwrap().is_empty());
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        let store = security_store().unwrap();
        let challenge = store.issue_challenge(&tenant, NOW, 600).unwrap();
        let enrollment = store.create_worker_enrollment(&tenant, "owner-device", NOW, 600).unwrap();
        store.register_worker_device(
            &tenant, &enrollment, &challenge.id, &challenge.nonce, "worker-device", "Worker",
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----", "worker-thumb", NOW,
        ).unwrap();
        for (device, scope, error) in [
            ("worker-device", None, "managed_desktop_human_authorization_required"),
            ("service", Some("service"), "managed_desktop_human_authorization_required"),
            ("member-device", Some("device"), "managed_desktop_admin_required"),
        ] {
            let caller = Caller {
                device_id: device,
                tenant_id: Some(&tenant),
                scope,
                local: false,
            };
            assert_eq!(dispatch(
                "managed_desktop_qualify_start", serde_json::json!({"providerConfigId":"e2b","scope":"gui"}),
                caller, None, Some(Arc::new(|| Ok(()))),
            ).await.unwrap_err().code, error);
        }
        let caller = Caller {
            device_id: "owner-device",
            tenant_id: Some(&tenant),
            scope: Some("device"),
            local: false,
        };
        for command in [
            "managed_desktop_qualify_start", "managed_desktop_qualify_approve", "managed_desktop_qualify_cancel",
        ] {
            assert_eq!(dispatch(command, serde_json::json!({}), caller, None, None).await.unwrap_err().code,
                "managed_desktop_control_admin_lease_expired");
        }
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(require_qualification_admin(&agent).is_err());
        assert!(decode::<QualifyStartArgs>(serde_json::json!({"providerConfigId":"e2b","scope":"gui","confirmed":true})).is_err());
    }

    #[test]
    fn delegation_wire_contract_omits_host_owner_and_caller_identity() {
        let grant = ManagedDesktopDelegation {
            id: "grant".into(),
            account_binding_epoch: Some(host_identity::account_binding_epoch()),
            account_binding_instance_id: Some(host_identity::account_binding_instance_id().into()),
            owner_principal_id: "private-owner".into(),
            host_id: "private-host".into(),
            desktop_id: "desktop".into(),
            desktop_generation: 2,
            provider_config_id: "e2b".into(),
            grantee: ManagedDesktopGrantee::Character { character_id: "character".into() },
            mode: ManagedDesktopDelegationMode::ComputerUse,
            state: ManagedDesktopDelegationState::Live,
            end_reason: None,
            expires_at: 2000,
            revision: 1,
            created_at: 1000,
            created_by_principal_id: "private-creator".into(),
            ended_at: None,
        };
        assert_eq!(
            delegation_json(&grant),
            serde_json::json!({
                "id":"grant","desktopId":"desktop","desktopGeneration":2,"providerConfigId":"e2b",
                "grantee":{"kind":"character","characterId":"character"},"mode":"computerUse",
                "state":"live","endReason":null,"expiresAt":2000,"revision":1,"createdAt":1000,"endedAt":null,
            })
        );
        for extra in [
            "ownerPrincipalId", "hostId", "createdByPrincipalId", "mode",
            "accountBindingEpoch", "accountBindingInstanceId",
        ] {
            let mut args = serde_json::json!({
                "desktopId":"desktop","generation":2,
                "grantee":{"kind":"session","sessionKey":"session"},
            });
            args[extra] = serde_json::json!("spoofed");
            assert!(decode::<DelegateArgs>(args).is_err());
        }
        assert!(decode::<DelegateArgs>(serde_json::json!({
            "desktopId":"desktop","generation":2,
            "grantee":{"kind":"session","sessionKey":"s","characterId":"c"},
        })).is_err());
        assert!(decode::<DelegationRevokeArgs>(serde_json::json!({"delegationId":"grant"})).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delegation_rpc_requires_human_admin_and_remote_lease_but_local_needs_no_lease() {
        let _scope = TestScope::new();
        let (_directory, _service, _p) = qualification_fixture(None).await;
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        let store = security_store().unwrap();
        let challenge = store.issue_challenge(&tenant, NOW, 600).unwrap();
        let enrollment = store.create_worker_enrollment(&tenant, "owner-device", NOW, 600).unwrap();
        store.register_worker_device(
            &tenant,
            &enrollment,
            &challenge.id,
            &challenge.nonce,
            "worker-device",
            "Worker",
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            "worker-thumb",
            NOW,
        ).unwrap();
        for command in ["managed_desktop_delegate", "managed_desktop_delegation_revoke"] {
            assert_eq!(
                dispatch(command, serde_json::json!({}), local_qualification_caller(), None, None)
                    .await.unwrap_err().code,
                "managed_desktop_invalid_request"
            );
            for (device, scope, error) in [
                ("worker-device", None, "managed_desktop_human_authorization_required"),
                ("service", Some("service"), "managed_desktop_human_authorization_required"),
                ("member-device", Some("device"), "managed_desktop_admin_required"),
            ] {
                let args = if command == "managed_desktop_delegate" {
                    serde_json::json!({
                        "desktopId":"desktop","generation":1,
                        "grantee":{"kind":"session","sessionKey":"s"},
                    })
                } else {
                    serde_json::json!({"delegationId":"grant","expectedRevision":1})
                };
                let caller = Caller {
                    device_id: device,
                    tenant_id: Some(&tenant),
                    scope,
                    local: false,
                };
                assert_eq!(
                    dispatch(command, args, caller, None, Some(Arc::new(|| Ok(()))))
                        .await.unwrap_err().code,
                    error
                );
            }
        }
        let expired: AdminAuthorityCheck = Arc::new(|| {
            Err(refused("managed_desktop_control_admin_lease_expired"))
        });
        assert_eq!(
            dispatch(
                "managed_desktop_delegate",
                serde_json::json!({
                    "desktopId":"unknown","generation":1,
                    "grantee":{"kind":"session","sessionKey":"s"},
                }),
                local_qualification_caller(), None, Some(expired),
            ).await.unwrap_err().code,
            "managed_desktop_control_admin_lease_expired"
        );
        let member = Caller {
            device_id: "member-device",
            tenant_id: Some(&tenant),
            scope: Some("device"),
            local: false,
        };
        assert_eq!(
            dispatch("managed_desktop_delegation_list", serde_json::json!({}), member, None, None)
                .await.unwrap_err().code,
            "managed_desktop_admin_required"
        );
        for (device, scope) in [("worker-device", None), ("service", Some("service"))] {
            assert_eq!(dispatch("managed_desktop_delegation_list", serde_json::json!({}), Caller {
                device_id: device, tenant_id: Some(&tenant), scope, local: false,
            }, None, None).await.unwrap_err().code, "managed_desktop_admin_required");
        }
        let remote = Caller { device_id: "owner-device", tenant_id: Some(&tenant), scope: Some("device"), local: false };
        for command in ["managed_desktop_delegate", "managed_desktop_delegation_revoke"] {
            assert_eq!(dispatch(command, serde_json::json!({}), remote, None, None).await.unwrap_err().code,
                "managed_desktop_control_admin_lease_expired");
        }
    }

    #[test]
    fn delegation_refuses_multi_tenant_with_a_dedicated_deployment_code() {
        assert_eq!(delegation_deployment(cognia_companion::deployment::DeploymentMode::MultiTenant).unwrap_err().code,
            "managed_desktop_delegation_unsupported_deployment");
        delegation_deployment(cognia_companion::deployment::DeploymentMode::SingleUser).unwrap();
    }

    type DelegationTestEvents = Arc<parking_lot::Mutex<Vec<(String, Value)>>>;
    fn delegation_test_workload(desktop: Value) -> Value {
        use serde_json::json;
        let process = |boundary: &Value, pid, executable| json!({
            "pid":pid,"startTime":1,"executable":executable,"status":boundary["status"],
            "namespaces":boundary["namespaces"],"descriptors":desktop["descriptors"],
        });
        let probe = |boundary: &Value, pid| json!({
            "process":process(boundary, pid, "/usr/local/bin/cognia-desktop-guest"),
            "sockets":(["1.1.1.1","10.0.0.1","172.16.0.1","192.168.0.1","100.64.0.1","169.254.0.1",
                "169.254.169.254","2606:4700:4700::1111","fd00:ec2::254","169.254.170.2","100.100.100.200",
                "::ffff:169.254.169.254","fd00::1","fe80::1","::ffff:10.0.0.1"].into_iter().flat_map(|target| {
                    [("tcp",80),("tcp",443),("udp",443)].into_iter().map(move |(transport,port)|
                        json!({"target":target,"transport":transport,"port":port,"result":-1,"errno":101}))
                }).collect::<Vec<_>>()),
            "escapes":[{"operation":"unshareUser","result":-1,"errno":1},{"operation":"setuidRoot","result":-1,"errno":22}],
            "paths":(["/run/cognia-desktop/control.sock","/run/cognia-desktop/state.json","/run/cognia-desktop/relay.sock",
                "/run/envd.sock","/root/.e2b","/var/lib/cognia-desktop"].into_iter().map(|operation|
                    json!({"operation":operation,"result":-1,"errno":2})).collect::<Vec<_>>()),
            "hostnames":(["example.com","metadata.google.internal"].into_iter().map(|operation|
                json!({"operation":operation,"result":-3,"errno":-3})).collect::<Vec<_>>()),
            "localHelpers":(["127.0.0.1:49983","127.0.0.1:8000"].into_iter().map(|operation|
                json!({"operation":operation,"result":-1,"errno":111})).collect::<Vec<_>>()),
        });
        let mut acceptance = desktop.clone();
        acceptance["phase"] = json!("acceptanceAdmission");
        for fd in [3,4] {
            acceptance["descriptors"][fd.to_string()] = json!({"target":format!("pipe:[{fd}]"),"flags":0o2000000,"socketScope":null});
        }
        let mut importer = desktop.clone();
        importer["phase"] = json!("importerAdmission");
        importer["status"] = json!(desktop["status"].as_str().unwrap().replace("1000", "1001"));
        for ns in ["user","mnt","net","pid","ipc","uts"] {
            importer["namespaces"][ns] = json!(format!("{ns}:[3]"));
        }
        importer["descriptors"]["0"]["target"] = json!("pipe:[42]");
        let mut weak = importer.clone();
        weak["status"] = json!(importer["status"].as_str().unwrap().replace("Seccomp:2", "Seccomp:0"));
        let mut negative = process(&desktop, 30, "/usr/local/bin/cognia-desktop-guest");
        negative["namespaces"] = desktop["providerNamespaces"].clone();
        negative["status"] = json!("Uid:0 0 0 0");
        json!({
            "reportVersion":3,"boundaryGeneration":desktop["boundaryGeneration"],"negativeControl":negative,
            "operations":{
                "admission":acceptance,
                "networkClients":(["1.1.1.1","10.0.0.1","172.16.0.1","192.168.0.1","100.64.0.1","169.254.0.1",
                    "169.254.169.254","2606:4700:4700::1111","fd00:ec2::254","169.254.170.2","100.100.100.200",
                    "::ffff:169.254.169.254","fd00::1","fe80::1","::ffff:10.0.0.1"].into_iter().map(|target| json!({"target":target,"exitCode":101})).collect::<Vec<_>>()),
                "refusals":(["symlink-read","symlink-write","directory-symlink-read","directory-symlink-write",
                    "hardlink-read","hardlink-write","fifo-read","fifo-write","socket-read","socket-write",
                    "parent-read","parent-write","special-file","file-cap","chunk-read-cap","chunk-write-cap",
                    "session-read-cap","session-write-cap","clipboard-cap"].into_iter().map(|operation| json!({"operation":operation,"result":-1,"errno":1})).collect::<Vec<_>>()),
                "writtenBytes":8*1024*1024,"readBytes":8*1024*1024,"outputBytes":1024*1024,"outputTruncated":true,
                "timeoutMs":1000,"timeoutSignal":9,"clipboardBytes":1024*1024,
                "timeoutProcesses":{"10":1,"11":1},"timeoutSurvivors":{},"deathProcesses":{"70":1,"71":1}
            },
            "weakenedLaunch":{"profile":"importer-without-seccomp-v1","executable":"/usr/local/bin/cognia-desktop-guest",
                "terminatedProcesses":{"20":1,"21":2},"survivingProcesses":{},"admission":weak},
            "acceptanceAdmission":acceptance,"importerAdmission":importer,
            "desktopProbe":{"acceptance":probe(&desktop,40),"terminal":probe(&desktop,41),"detachedPid":50,
                "browser":{"process":process(&desktop,42,"/usr/lib/chromium/chromium"),"exitCode":0,
                    "localPreview":"cognia-qualified-loopback","metadataNavigationNetErrors":[-109],
                    "redirectNetErrors":[-109],"hostnameNetErrors":[-105]}},
            "importerProbe":{"importer":probe(&importer,43),"git":process(&importer,44,"/usr/bin/git"),"gitExitCode":0},
            "terminatedProcesses":{"20":1,"50":1,"60":1,"70":1,"71":1},"survivingProcesses":{},"detachedOuterPid":50,
            "supervisorPid":60,"supervisorStartTime":1,"ingressErrno":111,"desktop":desktop,
        })
    }
    fn qualify_delegation_test_journal(state: &mut journal::ManagedDesktopJournal, config: &ManagedDesktopConfig, now: i64) {
        use serde_json::json;
        let base = state.desktops["desktop"].clone();
        let template = base.template.clone();
        let digest = config.binding_digest();
        state.templates.insert("template-record".into(), TemplateRecord {
            id:"template-record".into(), authorization_id:"authorization".into(), quote_id:"quote".into(),
            config:config.clone(), binding_digest:digest.clone(), state:TemplateState::Ready, identity:Some(template.clone()),
            created_at:now, updated_at:now, error_code:None, deletion_requested_at:None, cleanup_attempts:0, next_retry_at:now,
        });
        let namespaces = |suffix| ["user","mnt","net","pid","ipc","uts"].into_iter()
            .map(|ns| (ns.to_owned(), json!(format!("{ns}:[{suffix}]")))).collect::<serde_json::Map<_,_>>();
        let observation = json!({
            "reportVersion":1,"workloadIsolationRevision":1,"phase":"desktopLive",
            "boundaryGeneration":"6a370d8e-2d69-40fb-9586-786b7424365a",
            "namespaceInitPid":20,"namespaceInitStartTime":1,"workloadPid":21,"workloadStartTime":2,
            "namespaces":namespaces(2),"providerNamespaces":namespaces(1),
            "status":"Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n",
            "networkDevices":"header\nheader\n lo: 0\n","ipv4Routes":"header\n","ipv6Routes":"",
            "descriptors":{"0":{"target":"/dev/null","flags":0,"socketScope":null},"1":{"target":"/dev/null","flags":0,"socketScope":null},"2":{"target":"/dev/null","flags":0,"socketScope":null}}
        });
        let ids: Vec<_> = (0..5).map(|index| format!("evidence-{index}")).collect();
        for id in &ids {
            let mut row = base.clone();
            row.desktop.id = id.clone();
            row.desktop.state = ManagedDesktopState::Destroyed;
            row.smoke = true;
            row.resource_id = Some(format!("resource-{id}"));
            let binding = HostBoundaryBinding {
                binding_digest:digest.clone(), owner_principal_id:config.owner_principal_id.clone(), host_id:config.host_id.clone(),
                desktop_id:id.clone(), desktop_generation:1, resource_id:row.resource_id.clone().unwrap(),
                template:template.clone(), observed_at:now, observation:serde_json::from_value(observation.clone()).unwrap(),
            };
            assert!(binding.matches_record(&row));
            state.workload_boundaries.insert(id.clone(), binding);
            state.desktops.insert(id.clone(), row);
        }
        state.lifecycle_diagnostics.insert(digest.clone(), QualificationReceipt {
            evidence_version:2, workload_evidence:None, provider_root_observation:None, binding_digest:digest.clone(),
            template:template.clone(), observed_at:now, smoke_desktop_ids:ids[..2].to_vec(), native_expiry_killed:true,
            no_auto_resume:true, ingress_denied:true, guest_auth_denied:true, decoded_frame_verified:true, protocol_verified:true,
            restart_deadline_verified:true, delete_retry_verified:true, private_egress_probe_no_response:false, egress_policy_verified:true,
        });
        let mut assertions = serde_json::to_value(
            cognia_automation::cua_sandbox::managed::service::control::ControlQualificationAssertions::default(),
        ).unwrap();
        for value in assertions.as_object_mut().unwrap().values_mut() { *value = json!(true); }
        state.control_qualifications.insert(digest.clone(), ControlQualificationReceipt {
            binding_digest:digest.clone(), template:template.clone(), smoke_desktop_id:ids[2].clone(), smoke_desktop_generation:1,
            observed_at:now, protocol_revision:1, evidence_version:2, assertions:serde_json::from_value(assertions).unwrap(),
        });
        let mut evidence = serde_json::to_value(HostAuthoritySmokeEvidence::default()).unwrap();
        for value in evidence.as_object_mut().unwrap().values_mut() {
            if value.is_boolean() { *value = json!(true); }
        }
        evidence["evidenceVersion"] = json!(1);
        evidence["smokeDesktopId"] = json!(ids[3]);
        evidence["smokeDesktopGeneration"] = json!(1);
        evidence["observedAt"] = json!(now);
        evidence["consentTimeoutMs"] = json!(5000);
        evidence["positiveAdmittedCommands"] = json!(1);
        evidence["compoundAdmittedCommands"] = json!(1);
        evidence["compoundDeniedCommands"] = json!(1);
        state.authority_diagnostics.insert(digest.clone(), NativeAuthorityDiagnostic {
            boundary:state.workload_boundaries[&ids[3]].clone(), evidence:serde_json::from_value(evidence).unwrap(), recorded_at:now,
        });
        let diagnostic: NativeWorkloadDiagnostic = serde_json::from_value(json!({
            "boundary":state.workload_boundaries[&ids[4]],"report":delegation_test_workload(observation),"recordedAt":now,
        })).unwrap();
        diagnostic.report.validate().unwrap();
        state.workload_diagnostics.insert(digest, diagnostic);
    }
    async fn delegation_rpc_fixture() -> (
        tempfile::TempDir, Arc<ManagedDesktopService>, DelegationTestEvents,
    ) {
        delegation_rpc_fixture_qualified(false).await
    }
    fn qualify_acceptance_test_journal(state: &mut journal::ManagedDesktopJournal, config: &ManagedDesktopConfig, now: i64) {
        let digest = config.binding_digest();
        let mut bindings = Vec::new();
        let mut hashes = Vec::new();
        for (index, mode) in ["commit", "bundle"].into_iter().enumerate() {
            let operation = uuid::Uuid::new_v4().to_string();
            let id = format!("handoff-evidence-{index}");
            let mut desktop = state.desktops["evidence-3"].clone();
            let mut binding = state.workload_boundaries["evidence-3"].clone();
            desktop.desktop.id = id.clone(); desktop.source_id = Some(format!("handoff:{operation}"));
            desktop.resource_id = Some(format!("resource-{id}"));
            binding.desktop_id = id.clone(); binding.resource_id = desktop.resource_id.clone().unwrap();
            let hash = index.to_string().repeat(64); hashes.push(hash.clone()); bindings.push(binding.clone());
            state.handoff_diagnostics.insert(operation.clone(), NativeHandoffDiagnostic { evidence_version:1,mode:mode.into(),operation_id:operation,
                boundary:binding.clone(),receipt_sha256:hash,source_tree_sha256:"c".repeat(64),recorded_at:now });
            state.workload_boundaries.insert(id.clone(),binding); state.desktops.insert(id,desktop);
        }
        bindings.push(state.workload_diagnostics[&digest].boundary.clone());
        bindings.push(state.authority_diagnostics[&digest].boundary.clone());
        let mut receipt = state.lifecycle_diagnostics[&digest].clone();
        receipt.workload_evidence = Some(WorkloadQualificationEvidence { workload_isolation_revision:1,enforcement:"provider-and-guest-kernel".into(),boundaries:bindings,
            launch_paths_verified:vec!["desktop".into(),"importer".into(),"acceptance".into()],workload_egress_verified:true,escape_resistance_verified:true,native_handoff_receipt_sha256:hashes });
        state.qualifications.insert(digest,receipt);
    }
    async fn delegation_rpc_fixture_qualified(qualified: bool) -> (

        tempfile::TempDir,
        Arc<ManagedDesktopService>,
        DelegationTestEvents,
    ) {
        delegation_rpc_fixture_kind(qualified, false).await
    }
    async fn delegation_rpc_fixture_kind(qualified: bool, acceptance: bool) -> (
        tempfile::TempDir, Arc<ManagedDesktopService>, DelegationTestEvents,
    ) {
        let events_seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let observed = events_seen.clone();
        let events: HostEventSink = Arc::new(move |topic, data| {
            observed.lock().push((topic.to_owned(), data));
        });
        let (directory, service, p) = if acceptance {
            qualification_fixture_with_provider(None, Arc::new(qualification::tests::FakeProvider::default())).await
        } else { qualification_fixture(None).await };
        let provider = service.diagnostic_provider();
        shutdown();
        drop(service);
        let store = journal::JournalStore::open(directory.path()).unwrap();
        let mut registry = store.registry().unwrap();
        registry.providers[0].enablement.agent_control = qualified;
        registry.providers[0].enablement.acceptance = acceptance;
        store.save_registry(&registry).unwrap();
        let config = registry.providers.remove(0);
        let now = chrono::Utc::now().timestamp_millis();
        let mut state = store.load("test-host").unwrap();
        state.desktops.insert("desktop".into(), DesktopRecord {
            desktop: ManagedDesktop {
                id: "desktop".into(),
                provider_config_id: config.id.clone(),
                generation: 1,
                state: ManagedDesktopState::Running,
                deadline_at: now + 60_000,
                idle_timeout_seconds: 600,
                created_at: now,
                updated_at: now,
                last_error_code: None,
                cleanup_attempts: 0,
                qualification: "dormant".into(),
            },
            config: config.clone(),
            template: TemplateIdentity {
                template_id: "template".into(),
                build_id: "build".into(),
                image_digest: config.release.image_digest.clone(),
                recipe_revision: config.release.recipe_revision.clone(),
                protocol: config.release.protocol.clone(),
            },
            operation_id: "operation".into(),
            authorization_id: "authorization".into(),
            quote_id: "quote".into(),
            principal_id: p.principal_id.clone(),
            source_id: None,
            resource_id: None,
            last_activity_at: now,
            next_retry_at: now,
            delete_requested: false,
            smoke: false,
            bootstrap_started: true,
            bootstrap_completed: true,
            cleanup_requested_at: None,
        });
        if qualified {
            qualify_delegation_test_journal(&mut state, &config, now);
        }
        if acceptance { qualify_acceptance_test_journal(&mut state, &config, now); }
        state.delegations.insert("grant".into(), ManagedDesktopDelegation {
            id: "grant".into(),
            account_binding_epoch: Some(host_identity::account_binding_epoch()),
            account_binding_instance_id: Some(host_identity::account_binding_instance_id().into()),
            owner_principal_id: p.owner_principal_id.clone(),
            host_id: p.host_id.clone(),
            desktop_id: "desktop".into(),
            desktop_generation: 1,
            provider_config_id: config.id.clone(),
            grantee: ManagedDesktopGrantee::Session { session_key: "session".into() },
            mode: ManagedDesktopDelegationMode::ComputerUse,
            state: ManagedDesktopDelegationState::Live,
            end_reason: None,
            expires_at: now + 60_000,
            revision: 1,
            created_at: now,
            created_by_principal_id: p.principal_id.clone(),
            ended_at: None,
        });
        store.save(&state).unwrap();
        drop(store);
        let service = Arc::new(ManagedDesktopService::open(
            directory.path(),
            "test-host".into(),
            provider,
            Arc::new(FileManagedDesktopSecrets::open(&directory.path().join("vault")).unwrap()),
            Some(config.release),
        ).unwrap());
        install_delegation_runtime(&service, Some(events.clone()));
        *INSTALLED.write() = Some(Installed {
            directory: directory.path().to_owned(),
            service: service.clone(),
            host_id: "test-host".into(),
            release: crate::managed_desktop_release::ReleaseStatus::of(&Ok(None)),
            worker: tokio::spawn(std::future::pending()),
            qualification: Arc::new(qualification::QualificationRuntime::new(
                service.clone(),
                Some(events.clone()),
            )),
            acceptance: Arc::new(crate::managed_desktop_acceptance::AcceptanceRuntime::new(
                service.clone(),
                Some(events),
            )),
            events: None,
            control_runtime: None,
        });
        (directory, service, events_seen)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_delegation_and_revoke_succeed_without_an_admin_lease() {
        let _scope = TestScope::new();
        let (_directory, _service, events) = delegation_rpc_fixture_qualified(true).await;
        let expiry = chrono::Utc::now().timestamp_millis() + 10_000;
        let args = serde_json::json!({"desktopId":"desktop","generation":1,
            "grantee":{"kind":"character","characterId":"local-character"},"expiresAt":expiry});
        let grant = dispatch("managed_desktop_delegate", args, local_qualification_caller(), None, None).await.unwrap();
        assert_eq!(grant["expiresAt"], expiry);
        assert_eq!(grant["state"], "live");
        let repeated = dispatch("managed_desktop_delegate", serde_json::json!({
            "desktopId":"desktop","generation":1,"grantee":{"kind":"character","characterId":"local-character"},
        }), local_qualification_caller(), None, None).await.unwrap();
        assert_eq!(grant, repeated);
        let revoked = dispatch("managed_desktop_delegation_revoke", serde_json::json!({
            "delegationId":grant["id"],"expectedRevision":grant["revision"],
        }), local_qualification_caller(), None, None).await.unwrap();
        assert_eq!(revoked["endReason"], "revoked");
        assert_eq!(events.lock().iter().filter(|(topic, _)| topic == DELEGATION_CHANGED_TOPIC).count(), 2);
        assert!(events.lock().iter().all(|(_, data)| *data == serde_json::json!({})));
    }

    async fn acceptance_input(directory: &Path, service: &ManagedDesktopService, p: &ManagedDesktopPrincipal) -> AcceptanceStartInput {
        use cognia_external_agent::spawn_authority::DeliverySourceDeclaration;
        use cognia_sandbox_pool::{provenance::SourceStore, delivery::{TaskDeliveryRecord, PublishState, DELIVERY_DIR}};
        let source = SourceStore::new(directory).admit(&p.owner_principal_id,&p.host_id,"task","device",
            DeliverySourceDeclaration { conversation_id:"chat".into(),origin_run_ref:"original-run".into() },
            "https://example.com/repo.git","main","branch",None).unwrap();
        let mut delivery = TaskDeliveryRecord::running("delivery".into(),"agent".into(),Some("task".into()),"provider".into(),"instance".into(),"branch".into());
        delivery.source_id = Some(source.id); delivery.revision = 1; delivery.commit = Some("a".repeat(40)); delivery.publish_state = PublishState::Pushed;
        std::fs::create_dir_all(directory.join(DELIVERY_DIR)).unwrap();
        std::fs::write(directory.join(DELIVERY_DIR).join("delivery.json"),serde_json::to_vec(&delivery).unwrap()).unwrap();
        AcceptanceStartInput { delivery_id:"delivery".into(),delivery_revision:1,mode:AcceptanceTransferMode::Commit,provider_config_id:"e2b".into(),lifetime_seconds:120,
            criteria:vec![handoff::AcceptanceCriterionInput { description:"Page loads".into(),screenshot_required:false }],acceptance_files:vec![],argv:vec![],
            quote_id:service.quote(p,"e2b",120).await.unwrap().id,idempotency_key:"acceptance-start".into() }
    }
    async fn attached_acceptance(directory: &Path, service: &ManagedDesktopService) -> (ManagedDesktopPrincipal,AcceptanceRunRecord) {
        let p = principal(&local_qualification_caller(),"test-host").unwrap();
        let input = acceptance_input(directory,service,&p).await;
        let (_,source) = crate::managed_desktop_handoff::resolve(directory,&p,&crate::managed_desktop_handoff::PrepareHandoff {
            delivery_id:input.delivery_id.clone(),delivery_revision:1,mode:input.mode,provider_config_id:"e2b".into(),lifetime_seconds:120,
            criteria:input.criteria.clone(),acceptance_files:vec![],argv:vec![],
        }).unwrap();
        let authority = HostAuthority { caller:local_qualification_caller(),host_id:"test-host",admin_check:None,input_policy:None,admission_observer:None };
        let (row,_) = service.acceptance_begin(&p,input,source.id,AcceptanceRunSource { session_id:source.conversation_id,task_id:Some(source.task_id),parent_run_id:Some(source.coding_run_id) },source.origin_run_ref,"a".repeat(40),&authority).await.unwrap();
        let registry: journal::ManagedDesktopRegistry = serde_json::from_slice(&std::fs::read(directory.join("managed-desktops.json")).unwrap()).unwrap();
        FileManagedDesktopSecrets::open(&directory.join("vault")).unwrap().set_provider_key(&registry.providers[0],"test-key").unwrap();
        let auth = service.authorize(&p,"e2b",&row.request.quote_id,AuthorizationPurpose::Create,Some(format!("acceptance:{}",row.run.acceptance_id))).await.unwrap();
        let desktop = service.create(&p,CreateManagedDesktop { provider_config_id:"e2b".into(),quote_id:row.request.quote_id.clone(),authorization_id:auth.id,idempotency_key:row.run.acceptance_id.clone() }).await.unwrap();
        assert_eq!(service.acceptance_status(&p,&row.run.acceptance_id).await.unwrap().state,AcceptanceRunState::Provisioning,"desktop: {desktop:?}");
        let binding = crate::managed_desktop_acceptance::production_binding(&row,&desktop,&"b".repeat(64)).unwrap();
        let owner = p.owner_principal_id.clone(); let host = p.host_id.clone();
        crate::managed_desktop_results::disk(directory,move |s| s.register(&owner,&host,binding)).await.unwrap();
        service.acceptance_await_session(&p,&row.run.acceptance_id,&authority).await.unwrap();
        dispatch("managed_desktop_acceptance_attach",serde_json::json!({"acceptanceId":row.run.acceptance_id,"sessionKey":"child"}),local_qualification_caller(),None,None).await.unwrap();
        let row = service.acceptance_record(&p,&row.run.acceptance_id).await.unwrap();
        (p,row)
    }
    #[tokio::test(flavor = "current_thread")]
    async fn acceptance_rpc_start_is_async_idempotent_admin_only_and_does_not_change_delivery() {
        let _scope = TestScope::new();
        let (directory,service,events) = delegation_rpc_fixture_kind(true,true).await;
        let p = principal(&local_qualification_caller(),"test-host").unwrap();
        let input = acceptance_input(directory.path(),&service,&p).await;
        let path = directory.path().join(cognia_sandbox_pool::delivery::DELIVERY_DIR).join("delivery.json");
        let original = std::fs::read(&path).unwrap();
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        let store = security_store().unwrap();
        let challenge = store.issue_challenge(&tenant,NOW,600).unwrap();
        let enrollment = store.create_worker_enrollment(&tenant,"owner-device",NOW,600).unwrap();
        store.register_worker_device(&tenant,&enrollment,&challenge.id,&challenge.nonce,"worker-device","Worker",
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----","worker-thumb",NOW).unwrap();
        for (device,scope) in [("member-device",Some("device")),("service",Some("service")),("worker-device",None)] {
            assert!(dispatch("managed_desktop_acceptance_start",serde_json::to_value(&input).unwrap(),Caller { device_id:device,tenant_id:Some(&tenant),scope,local:false },None,
                Some(Arc::new(|| Ok(())))).await.is_err());
        }
        assert!(service.acceptance_list(&p).await.unwrap().is_empty());
        for command in ["managed_desktop_acceptance_start","managed_desktop_acceptance_attach","managed_desktop_acceptance_cancel"] {
            assert_eq!(dispatch(command,serde_json::json!({}),Caller { device_id:"owner-device",tenant_id:Some(&tenant),scope:Some("device"),local:false },None,None).await.unwrap_err().code,
                "managed_desktop_control_admin_lease_expired");
        }
        let first = dispatch("managed_desktop_acceptance_start",serde_json::to_value(&input).unwrap(),local_qualification_caller(),None,None).await.unwrap();
        assert_eq!(first["state"],"provisioning");
        let second = dispatch("managed_desktop_acceptance_start",serde_json::to_value(&input).unwrap(),local_qualification_caller(),None,None).await.unwrap();
        assert_eq!(first["acceptanceId"],second["acceptanceId"]);
        dispatch("managed_desktop_acceptance_cancel",serde_json::json!({"acceptanceId":first["acceptanceId"]}),local_qualification_caller(),None,None).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(),original);
        assert!(events.lock().iter().any(|(topic,value)| topic == ACCEPTANCE_CHANGED_TOPIC && value == &serde_json::json!({})));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn acceptance_tools_require_live_attached_local_session_and_correct_agent_then_complete_destroys() {
        let _scope = TestScope::new();
        let (directory,service,_) = delegation_rpc_fixture_kind(true,true).await;
        let (p,row) = attached_acceptance(directory.path(),&service).await;
        let id = &row.run.acceptance_id;
        let status = dispatch(
            "managed_desktop_acceptance_status", serde_json::json!({"acceptanceId":id}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(status["childAttached"], true);
        assert!(status.get("childSessionKey").is_none());
        let listed = dispatch(
            "managed_desktop_acceptance_list", serde_json::json!({}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(listed["runs"][0], status);
        assert!(dispatch("managed_desktop_acceptance_attach",serde_json::json!({"acceptanceId":id,"sessionKey":"child"}),local_qualification_caller(),None,None).await.is_err());
        let checkpoint = serde_json::json!({"acceptanceId":id,"sessionKey":"child","criterionId":"criterion-0","idempotencyKey":"checkpoint"});
        let complete = serde_json::json!({"acceptanceId":id,"sessionKey":"child","idempotencyKey":"complete","outcome":"passed",
            "criteria":[{"criterionId":"criterion-0","outcome":"passed","artifactIds":[]}],"summary":"Page loads"});
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        for (command,args) in [("managed_desktop_acceptance_checkpoint",checkpoint.clone()),("managed_desktop_acceptance_complete",complete.clone())] {
            assert_eq!(dispatch(command,args.clone(),Caller { device_id:"owner-device",tenant_id:Some(&tenant),scope:Some("device"),local:false },None,None).await.unwrap_err().code,"managed_desktop_acceptance_local_only");
            let mut wrong = args; wrong["sessionKey"] = serde_json::json!("other-child");
            assert_eq!(dispatch(command,wrong,local_qualification_caller(),None,None).await.unwrap_err().code,"managed_desktop_acceptance_delegation_required");
        }
        let mut wrong = p.clone(); wrong.authority = ManagedDesktopAuthority::Agent; wrong.principal_id = "wrong-agent".into();
        assert!(!service.acceptance_session_live(&wrong,id,"child"));
        let owner = p.owner_principal_id.clone(); let host = p.host_id.clone(); let acceptance = id.clone();
        assert_eq!(crate::managed_desktop_results::disk(directory.path(),move |s| s.complete(&owner,&host,&acceptance,evidence::AgentVerdictInput {
            idempotency_key:"wrong".into(),principal_id:"wrong-agent".into(),outcome:evidence::AcceptanceOutcome::Passed,criteria:vec![],summary:"forged".into(),
        })).await.unwrap_err().code,"acceptance_agent_authority_required");
        let result = dispatch("managed_desktop_acceptance_complete",complete.clone(),local_qualification_caller(),None,None).await.unwrap();
        assert_eq!(result["agentVerdict"]["input"]["principalId"],format!("acceptance:{id}"));
        let status = service.acceptance_status(&p,id).await.unwrap(); assert_eq!(status.state,AcceptanceRunState::Completed);
        let grant = service.delegation_list(&p).await.unwrap().into_iter().find(|g| Some(&g.id) == status.delegation_id.as_ref()).unwrap();
        assert_eq!(grant.end_reason,Some(ManagedDesktopDelegationEndReason::Completed));
        assert_eq!(delegation_json(&grant)["grantee"],serde_json::json!({"kind":"acceptance","acceptanceId":id}));
        assert_eq!(service.list(&p).await.unwrap().into_iter().find(|d| Some(&d.id) == status.desktop_id.as_ref()).unwrap().state,ManagedDesktopState::Destroyed);
        for (command,args) in [("managed_desktop_acceptance_checkpoint",checkpoint),("managed_desktop_acceptance_complete",complete)] {
            assert_eq!(dispatch(command,args,local_qualification_caller(),None,None).await.unwrap_err().code,"managed_desktop_acceptance_delegation_required");
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn durable_acceptance_complete_survives_a_post_step_reconcile_error() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let _scope = TestScope::new();
        let (directory, service, _) = delegation_rpc_fixture_kind(true, true).await;
        let (p, row) = attached_acceptance(directory.path(), &service).await;
        let index = directory.path().join("managed-desktop-evidence/index.enc");
        let retained = directory.path().join("managed-desktop-evidence/index.retained");
        let unavailable = index.clone();
        let durable = retained.clone();
        let injected = Arc::new(AtomicBool::new(false));
        let failed = injected.clone();
        // Grant termination occurs after the verdict has been durably written.
        // Temporarily refuse subsequent evidence reads while retaining its bytes.
        install_delegation_runtime(&service, Some(Arc::new(move |_, _| {
            if !failed.swap(true, Ordering::SeqCst) {
                std::fs::rename(&unavailable, &durable).unwrap();
                std::fs::create_dir(&unavailable).unwrap();
            }
        })));
        let result = dispatch(
            "managed_desktop_acceptance_complete",
            serde_json::json!({
                "acceptanceId":row.run.acceptance_id,"sessionKey":"child","idempotencyKey":"complete",
                "outcome":"passed","criteria":[{"criterionId":"criterion-0","outcome":"passed","artifactIds":[]}],
                "summary":"Page loads",
            }),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert!(injected.load(Ordering::SeqCst));
        assert_eq!(result["agentVerdict"]["input"]["outcome"], "passed");
        std::fs::remove_dir(&index).unwrap();
        std::fs::rename(retained, index).unwrap();
        let owner = p.owner_principal_id.clone();
        let host = p.host_id.clone();
        let id = row.run.acceptance_id.clone();
        let persisted = crate::managed_desktop_results::disk(directory.path(), move |s| s.get(&owner, &host, &id)).await.unwrap();
        assert!(persisted.agent_verdict.is_some());
        acceptance_runtime().unwrap().reconcile(directory.path()).await.unwrap();
        assert!(!service.acceptance_record(&p, &row.run.acceptance_id).await.unwrap().cleanup_pending);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn acceptance_switch_does_not_admit_paired_worker_or_service_frames() {
        let _scope = TestScope::new();
        let (_directory, service, _) = delegation_rpc_fixture_kind(true, true).await;
        let p = principal(&local_qualification_caller(), "test-host").unwrap();
        let enabled = service.effective_enablement(&p, "e2b").await.unwrap();
        assert!(enabled.acceptance);
        assert!(!enabled.manual_gui);
        let tenant = host_identity::current().unwrap().remote_tenant_id;
        let store = security_store().unwrap();
        let challenge = store.issue_challenge(&tenant, NOW, 600).unwrap();
        let enrollment = store.create_worker_enrollment(&tenant, "owner-device", NOW, 600).unwrap();
        store.register_worker_device(
            &tenant, &enrollment, &challenge.id, &challenge.nonce, "worker-device", "Worker",
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----", "worker-thumb", NOW,
        ).unwrap();
        for (device, scope) in [("worker-device", None), ("service", Some("service"))] {
            let caller = Caller { device_id: device, tenant_id: Some(&tenant), scope, local: false };
            assert_eq!(principal(&caller, "test-host").unwrap().authority, ManagedDesktopAuthority::Agent);
            let error = dispatch(
                "managed_desktop_control_frame", serde_json::json!({"desktopId":"desktop","generation":1}),
                caller, None, None,
            ).await.unwrap_err();
            assert_eq!(error.code, "managed_desktop_control_unqualified");
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn acceptance_cancel_records_system_outcome_revokes_and_destroys() {
        let _scope = TestScope::new();
        let (directory,service,_) = delegation_rpc_fixture_kind(true,true).await;
        let (p,row) = attached_acceptance(directory.path(),&service).await;
        let result = dispatch("managed_desktop_acceptance_cancel",serde_json::json!({"acceptanceId":row.run.acceptance_id}),local_qualification_caller(),None,None).await.unwrap();
        assert_eq!(result["state"],"cancelled");
        let owner = p.owner_principal_id.clone(); let host = p.host_id.clone(); let id = row.run.acceptance_id;
        let result = crate::managed_desktop_results::disk(directory.path(),move |s| s.get(&owner,&host,&id)).await.unwrap();
        assert_eq!(result.system_outcome.unwrap().outcome,evidence::AcceptanceOutcome::Cancelled);
        assert!(!result.cleanup_pending);
        assert_eq!(service.list(&p).await.unwrap().into_iter().find(|d| Some(&d.id) == row.run.desktop_id.as_ref()).unwrap().state,ManagedDesktopState::Destroyed);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn acceptance_revoke_destroy_and_account_change_record_inconclusive_and_cleanup() {
        let _scope = TestScope::new();
        for reason in ["revoke","destroy","account"] {
            let (directory,service,_) = delegation_rpc_fixture_kind(true,true).await;
            let (p,row) = attached_acceptance(directory.path(),&service).await;
            match reason {
                "revoke" => {
                    let grant = service.delegation_list(&p).await.unwrap().into_iter().find(|g| Some(&g.id) == row.run.delegation_id.as_ref()).unwrap();
                    dispatch("managed_desktop_delegation_revoke",serde_json::json!({"delegationId":grant.id,"expectedRevision":grant.revision}),local_qualification_caller(),None,None).await.unwrap();
                }
                "destroy" => { service.delete(&p,row.run.desktop_id.as_deref().unwrap(),row.run.desktop_generation.unwrap()).await.unwrap(); }
                _ => { host_identity::bind_local_account("other-account","other-digest").unwrap(); }
            }
            acceptance_runtime().unwrap().reconcile(directory.path()).await.unwrap();
            let owner = p.owner_principal_id.clone(); let host = p.host_id.clone(); let id = row.run.acceptance_id.clone();
            let result = crate::managed_desktop_results::disk(directory.path(),move |s| s.get(&owner,&host,&id)).await.unwrap();
            assert_eq!(result.system_outcome.unwrap().outcome,evidence::AcceptanceOutcome::Inconclusive,"{reason}");
            assert!(!result.cleanup_pending,"{reason}");
            assert_eq!(service.acceptance_status(&p,&row.run.acceptance_id).await.unwrap().state,AcceptanceRunState::Failed);
            assert_eq!(service.list(&p).await.unwrap().into_iter().find(|d| Some(&d.id) == row.run.desktop_id.as_ref()).unwrap().state,ManagedDesktopState::Destroyed,"{reason}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delegation_rpc_lists_revokes_emits_data_free_events_and_refuses_unqualified_creation() {
        let _scope = TestScope::new();
        let (_directory, _service, events_seen) = delegation_rpc_fixture().await;
        let listed = dispatch(
            "managed_desktop_delegation_list", serde_json::json!({}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(listed["delegations"][0]["state"], "live");
        assert!(listed["delegations"][0].get("ownerPrincipalId").is_none());
        assert!(events_seen.lock().is_empty());
        let args = serde_json::json!({
            "desktopId":"desktop","generation":1,
            "grantee":{"kind":"session","sessionKey":"session"},
        });
        assert_eq!(
            dispatch("managed_desktop_delegate", args, local_qualification_caller(), None, None)
                .await.unwrap_err().code,
            "managed_desktop_agent_control_unqualified"
        );
        let revoked = dispatch(
            "managed_desktop_delegation_revoke",
            serde_json::json!({"delegationId":"grant","expectedRevision":1}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(revoked["state"], "ended");
        assert_eq!(revoked["endReason"], "revoked");
        assert_eq!(revoked["revision"], 2);
        assert!(revoked["endedAt"].as_i64().unwrap() >= revoked["createdAt"].as_i64().unwrap());
        assert_eq!(
            *events_seen.lock(),
            vec![(DELEGATION_CHANGED_TOPIC.to_owned(), serde_json::json!({}))]
        );
        let listed = dispatch(
            "managed_desktop_delegation_list", serde_json::json!({}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(listed["delegations"][0], revoked);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delegation_rpc_observes_account_epoch_even_after_an_unobserved_switch_back() {
        let _scope = TestScope::new();
        let (_directory, service, events) = delegation_rpc_fixture().await;
        let caller = principal(&local_qualification_caller(), "test-host").unwrap();
        let before = service.delegation_list(&caller).await.unwrap();
        let epoch = before[0].account_binding_epoch.unwrap();
        host_identity::bind_local_account("another-account", "another-digest").unwrap();
        host_identity::bind_local_account("qualification-account", "digest").unwrap();
        assert!(host_identity::account_binding_epoch() > epoch);
        let listed = dispatch(
            "managed_desktop_delegation_list", serde_json::json!({}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(listed["delegations"][0]["state"], "ended");
        assert_eq!(listed["delegations"][0]["endReason"], "accountChanged");
        assert_eq!(
            *events.lock(),
            vec![(DELEGATION_CHANGED_TOPIC.to_owned(), serde_json::json!({}))]
        );
        let listed_again = dispatch(
            "managed_desktop_delegation_list", serde_json::json!({}),
            local_qualification_caller(), None, None,
        ).await.unwrap();
        assert_eq!(listed, listed_again);
    }

}

// Kept below this module so native smoke reuses private Host authority and consent.
#[path = "managed_desktop_authority_operator.rs"]
pub mod authority_operator;

#[path = "managed_desktop_qualification.rs"]
pub mod qualification;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualifyStartArgs {
    provider_config_id: String,
    scope: QualificationScope,
    handoff: Option<QualificationHandoff>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualifyRunArgs {
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualifyApproveArgs {
    run_id: String,
    quote_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QualifyEmptyArgs {}
fn require_qualification_admin(p: &ManagedDesktopPrincipal) -> Result<()> {
    p.require_human()?;
    p.require_admin()
}
fn require_acceptance_admin(caller: &Caller<'_>, p: &ManagedDesktopPrincipal) -> Result<()> {
    if cognia_companion::jwt::is_service_scope(caller.scope) {
        return Err(refused("managed_desktop_admin_required"));
    }
    p.require_admin()
}
fn acceptance_runtime() -> Result<Arc<crate::managed_desktop_acceptance::AcceptanceRuntime>> {
    INSTALLED.read().as_ref().map(|i| i.acceptance.clone())
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))
}
fn qualification_runtime() -> Result<Arc<qualification::QualificationRuntime>> {
    INSTALLED.read().as_ref().map(|i| i.qualification.clone())
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))
}
fn qualification_principal_check(
    caller: Caller<'_>,
    host: &str,
    expected: &ManagedDesktopPrincipal,
) -> Arc<dyn Fn() -> Result<()> + Send + Sync> {
    let device = caller.device_id.to_owned();
    let tenant = caller.tenant_id.map(str::to_owned);
    let scope = caller.scope.map(str::to_owned);
    let local = caller.local;
    let host = host.to_owned();
    let expected = expected.clone();
    Arc::new(move || same_principal(&principal(&Caller {
        device_id: &device,
        tenant_id: tenant.as_deref(),
        scope: scope.as_deref(),
        local,
    }, &host)?, &expected))
}
