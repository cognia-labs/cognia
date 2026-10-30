//! Host-owned human and delegated agent control. Live frames and leases are
//! never persisted. Both paths share preemption and uncertainty quarantine.
use super::*;
use crate::automation::{
    session::UiAction,
    types::{Action, ActionOutput, AutomationError, Point, Result as AutomationResult, Screenshot},
};
use crate::cua_sandbox::{
    desktop_session::{self, RemoteDesktop},
    remote_client::CuaRemoteClient,
};
use async_trait::async_trait;
use cognia_remote_desktop::{
    audit,
    control::{ControlError, ControlLeaseCore},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

const LEASE_MS: i64 = cognia_remote_desktop::control::LEASE_MS;
const FRAME_MS: i64 = cognia_remote_desktop::control::FRAME_MS;

fn retain_native_refusal(enabled: bool, error: &ManagedDesktopError) -> bool {
    enabled && !cognia_remote_desktop::frames::NativeInputError::managed(&error.code).fatal
}

/// A lease proof is always checked as a token/fence pair.
pub struct ManagedControlLeaseRef<'a> {
    pub token: &'a str,
    pub fence: u64,
}

/// Input remains bound to the observed frame and the lease that produced it.
pub struct ManagedControlInput<'a> {
    pub token: &'a str,
    pub fence: u64,
    pub frame_id: &'a str,
    pub point: Option<Point>,
    pub action: UiAction,
}

/// Implemented by the authenticated Host, checking its live device/owner
/// authority store. A captured request context alone is not a revocation check.
#[async_trait]
pub trait ManagedControlAuthority: Send + Sync {
    async fn revalidate(&self, principal: &ManagedDesktopPrincipal) -> Result<()>;
    /// An owned live check used by the shared command pump immediately before
    /// each send, including the second command of a compound operation.
    fn input_admission(
        &self,
        principal: &ManagedDesktopPrincipal,
    ) -> Arc<dyn Fn() -> bool + Send + Sync>;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlLease {
    pub token: String,
    pub fence: u64,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlFrame {
    pub frame_id: String,
    pub fence: u64,
    pub expires_at: i64,
    pub screenshot: Screenshot,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlStatus {
    pub qualified: bool,
    pub state: String,
    pub controller_kind: Option<String>,
    pub controller_is_self: bool,
    pub lease_expires_at: Option<i64>,
    pub fence: u64,
    pub can_acquire: bool,
    pub agent_control_dormant: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlQualificationReceipt {
    pub binding_digest: String,
    pub template: TemplateIdentity,
    pub smoke_desktop_id: String,
    #[serde(default)]
    pub smoke_desktop_generation: u64,
    pub observed_at: i64,
    pub protocol_revision: u32,
    /// Absent legacy receipts remain readable but cannot qualify control.
    #[serde(default)]
    pub evidence_version: u32,
    #[serde(default)]
    pub assertions: ControlQualificationAssertions,
}

/// Native diagnostics exercise the production driver and fencing with two
/// synthetic administrator identities. They do not grant agent delegation or
/// prove external device authentication, consent or administrator lease wiring.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlQualificationAssertions {
    pub authenticated_websocket_and_decoded_frame: bool,
    pub explicit_takeover_required: bool,
    pub exclusive_controller: bool,
    pub human_release_transfer: bool,
    pub old_token_and_frame_rejected: bool,
    pub single_use_frame: bool,
    pub expired_frame_rejected: bool,
    pub expired_lease_rejected: bool,
    pub principal_revocation_rejected: bool,
    pub live_authority_revocation_rejected: bool,
    pub compound_send_revocation: bool,
    pub service_reopen_invalidates_tokens: bool,
    pub quarantine_survives_reopen: bool,
    pub agent_delegation_refused: bool,
}
impl ControlQualificationReceipt {
    pub fn has_complete_evidence(&self) -> bool {
        let a = &self.assertions;
        self.evidence_version == 2
            && self.protocol_revision == 1
            && self.smoke_desktop_generation > 0
            && a.authenticated_websocket_and_decoded_frame
            && a.explicit_takeover_required
            && a.exclusive_controller
            && a.human_release_transfer
            && a.old_token_and_frame_rejected
            && a.single_use_frame
            && a.expired_frame_rejected
            && a.expired_lease_rejected
            && a.principal_revocation_rejected
            && a.live_authority_revocation_rejected
            && a.compound_send_revocation
            && a.service_reopen_invalidates_tokens
            && a.quarantine_survives_reopen
            && a.agent_delegation_refused
    }
}
/// Last published slot state; readers never wait behind agent input.
#[derive(Clone, Default)]
pub(super) struct ControlProjection {
    generation: u64,
    principal: Option<String>,
    expires_at: Option<i64>,
    fence: u64,
    uncertain: bool,
    agent_active: Arc<AtomicBool>,
}
struct AgentOperationStatus(Arc<AtomicBool>);
impl AgentOperationStatus {
    fn begin(active: Arc<AtomicBool>) -> Self {
        active.store(true, Ordering::SeqCst);
        Self(active)
    }
}
impl Drop for AgentOperationStatus {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
/// The lease, fence, revocation epoch and frame proofs are the shared
/// ADR-0234 core; this wrapper adds the computer-server desktop and client.
/// Field access (`lease`, `frames`, `fence`, `revoked`) derefs to the core,
/// while the inherent methods below keep the managed refusal codes.
pub(super) struct ManagedControl {
    agent_active: Arc<AtomicBool>,
    projections: Arc<parking_lot::RwLock<std::collections::BTreeMap<String, ControlProjection>>>,
    pub(super) desktop: RemoteDesktop,
    pub(super) client: Option<Arc<CuaRemoteClient>>,
    pub(super) core: ControlLeaseCore,
    generation: u64,
    target_id: String,
}
impl std::ops::Deref for ManagedControl {
    type Target = ControlLeaseCore;
    fn deref(&self) -> &ControlLeaseCore {
        &self.core
    }
}
impl std::ops::DerefMut for ManagedControl {
    fn deref_mut(&mut self) -> &mut ControlLeaseCore {
        &mut self.core
    }
}
impl ManagedControl {
    fn new(target_id: &str, generation: u64) -> Self {
        Self {
            agent_active: Default::default(),
            projections: Default::default(),
            desktop: RemoteDesktop::for_target(target_id.into(), Default::default()),
            client: None,
            core: ControlLeaseCore::with_frame_limit(
                cognia_remote_desktop::frames::FRAME_PROOFS_PER_PRINCIPAL
            ),
            generation,
            target_id: target_id.into(),
        }
    }
    fn audit(&self, kind: &str, principal: &str, decision: &str, fields: serde_json::Value) {
        self.publish();
        audit::record_background(
            kind,
            "managed-desktop",
            &self.target_id,
            principal,
            decision,
            self.core.fence,
            fields,
        );
    }
    fn publish(&self) {
        self.projections.write().insert(self.target_id.clone(), ControlProjection {
            generation: self.generation,
            principal: self.lease.as_ref().map(|lease| lease.principal.clone()),
            expires_at: self.lease.as_ref().map(|lease| lease.dto.expires_at),
            fence: self.fence,
            uncertain: self.desktop.require_quiescent().is_err(),
            agent_active: self.agent_active.clone(),
        });
    }
    fn invalidate(&mut self) {
        self.core.invalidate();
        self.desktop.invalidate();
        self.publish();
    }
    fn expire(&mut self) {
        if let Some(lease) = self.core.expire() {
            self.desktop.invalidate();
            audit::record_background(
                "remote_desktop.lease.expire",
                "managed-desktop",
                &self.target_id,
                &lease.principal,
                "expired",
                lease.dto.fence,
                serde_json::json!({}),
            );
        }
        self.publish();
    }
    fn require_lease(
        &mut self,
        p: &ManagedDesktopPrincipal,
        token: &str,
        fence: u64,
    ) -> Result<()> {
        p.require_human()?;
        self.expire();
        self.desktop.require_quiescent().map_err(control_error)?;
        self.core
            .require_lease(&p.principal_id, token, fence)
            .map_err(|_| refused("managed_desktop_control_lease_expired"))
    }
    fn issue(
        &mut self,
        p: &ManagedDesktopPrincipal,
        now: i64,
        desktop_deadline: i64,
    ) -> ManagedControlLease {
        // `ControlLeaseCore::issue` bumps the fence once; only the desktop
        // half of `invalidate` is needed here.
        self.desktop.invalidate();
        let lease = self.core.issue(&p.principal_id, now, desktop_deadline);
        ManagedControlLease {
            token: lease.token,
            fence: lease.fence,
            expires_at: lease.expires_at,
        }
    }
}
fn core_frame_error(error: ControlError) -> ManagedDesktopError {
    match error {
        ControlError::ObserverLimit => refused("managed_desktop_control_observer_limit"),
        ControlError::FrameLimit => refused("managed_desktop_control_frame_limit"),
        ControlError::StaleFrame => refused("managed_desktop_control_stale_frame"),
        ControlError::LeaseExpired => refused("managed_desktop_control_lease_expired"),
    }
}
fn control_error(_: crate::automation::types::AutomationError) -> ManagedDesktopError {
    refused("managed_desktop_control_unavailable")
}

// Fixed diagnostic categories only: a server error may contain project text,
// URLs or credentials and must never be copied into the native smoke log.
fn smoke_driver_failure(error: &crate::automation::types::AutomationError) -> &'static str {
    use crate::automation::types::AutomationError;
    match error {
        AutomationError::PermissionDenied { reason } if reason == "sandbox input fence expired" => {
            "send_fence_denied"
        }
        AutomationError::PermissionDenied { .. } => "driver_permission_denied",
        AutomationError::BackendError { message } => {
            if message.starts_with("cua send:") {
                "transport_send"
            } else if message.starts_with("cua recv:") || message == "cua connection closed" {
                "transport_receive_or_closed"
            } else if message.starts_with("cua decode:") {
                "response_decode"
            } else if message.starts_with("cua call timed out") {
                "driver_call_timeout"
            } else if message == "cua client channel closed"
                || message == "cua reply channel dropped"
            {
                "driver_channel_closed"
            } else if message == "computer-server reported success=false" {
                "server_negative_acknowledgement"
            } else {
                "driver_backend_error"
            }
        }
        AutomationError::Internal { .. } => "driver_internal_error",
        _ => "driver_other_error",
    }
}

/// Native operator entry, deliberately absent from all RPC/agent registries.
/// Creates one explicitly quoted 240s resource and measures the control path.
/// The receipt cannot be installed from caller-provided success booleans.
pub async fn run_control_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<ControlQualificationReceipt> {
    p.require_admin()?;
    let source = format!("control-smoke:{}", Uuid::new_v4());
    let result = control_smoke_steps(host, p, config_id, &source).await;
    // Always reopen and inspect the source binding, including uncertain create
    // failures before a desktop ID was returned. Delete persists retry state.
    let service = host.open(host.provider())?;
    let rows = service
        .state
        .lock()
        .await
        .desktops
        .values()
        .filter(|row| row.source_id.as_deref() == Some(source.as_str()))
        .map(|row| row.desktop.clone())
        .collect::<Vec<_>>();
    let mut cleanup_pending = false;
    for row in rows {
        match service.delete(p, &row.id, row.generation).await {
            Ok(row) if row.state == ManagedDesktopState::Destroyed => {}
            _ => cleanup_pending = true,
        }
    }
    if cleanup_pending {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let receipt = result?;
    if !receipt.has_complete_evidence() {
        return Err(refused("managed_desktop_control_smoke_failed"));
    }
    service
        .transaction(|s, _| {
            s.control_qualifications
                .insert(receipt.binding_digest.clone(), receipt.clone());
            Ok(())
        })
        .await?;
    Ok(receipt)
}

fn require_smoke_error<T>(result: Result<T>, code: &str) -> Result<()> {
    match result {
        Err(error) if error.code == code => Ok(()),
        other => {
            let actual = other
                .as_ref()
                .err()
                .map(|e| smoke_error_label(&e.code))
                .unwrap_or("unexpected_success");
            eprintln!(
                "Native control smoke expected={} actual={actual}",
                smoke_error_label(code)
            );
            Err(refused("managed_desktop_control_smoke_failed"))
        }
    }
}

async fn smoke_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    frame: &ManagedControlFrame,
    authority: &NativeSmokeAuthority,
) -> Result<()> {
    // Actual two-command driver operation, with no click or content mutation.
    service
        .control_input_inner(
            p,
            &desktop.id,
            desktop.generation,
            ManagedControlInput {
                token: &lease.token,
                fence: lease.fence,
                frame_id: &frame.frame_id,
                point: Some(Point { x: 0, y: 0 }),
                action: UiAction::Scroll {
                    opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 },
                },
            },
            authority,
            true,
        )
        .await
}

// Positive probes must not borrow frame lifetime from unrelated negative
// checks. Renewal precedes capture, so its provider reads consume no frame TTL.
async fn fresh_smoke_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    authority: &NativeSmokeAuthority,
) -> Result<(ManagedControlLease, ManagedControlFrame)> {
    let lease = service
        .control_renew_inner(
            p,
            &desktop.id,
            desktop.generation,
            ManagedControlLeaseRef {
                token: &lease.token,
                fence: lease.fence,
            },
            authority,
            true,
        )
        .await?;
    let frame = service
        .control_frame_inner(p, &desktop.id, desktop.generation, authority, true)
        .await?;
    smoke_input(service, p, desktop, &lease, &frame, authority).await?;
    Ok((lease, frame))
}

fn smoke_error_label(code: &str) -> &str {
    if code.starts_with("managed_desktop_")
        && code.len() <= 128
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        code
    } else {
        "unexpected_error_code"
    }
}

// Revocation and restart probes must not accidentally pass because the lease
// naturally expired. Keep its original monotonic deadline across the negative
// operation; never refresh or modify it after the event being tested.
async fn smoke_live_lease_deadline(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
) -> Result<Instant> {
    let slot = service.control_slot(&desktop.id, desktop.generation).await;
    let mut control = slot.lock().await;
    control.require_lease(p, &lease.token, lease.fence)?;
    Ok(control.lease.as_ref().expect("validated lease").deadline)
}

fn require_smoke_before_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(refused(
            "managed_desktop_control_smoke_lease_expiry_confounded",
        ));
    }
    Ok(())
}

async fn control_smoke_steps(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    source: &str,
) -> Result<ControlQualificationReceipt> {
    let started = Instant::now();
    let mut stage = "admission";
    let outcome: Result<ControlQualificationReceipt> = async {
        let service = host.open(host.provider())?;
        let config = service.config(p, config_id).await?;
        let digest = config.binding_digest();
        {
            let state = service.state.lock().await;
            if !latest_template(&state, &digest)
                .and_then(|t| t.identity.as_ref())
                .is_some_and(|t| lifecycle_diagnostic_valid(&state, &digest, t))
            {
                return Err(refused("managed_desktop_unqualified"));
            }
        }
        // Native smoke reached the transfer checks at 87s, before its remaining
        // real 15s lease-expiry wait, reconnect and compound-input checks. Quote
        // four minutes for this diagnostic only; frame/lease TTLs are unchanged.
        let request = smoke::authorized_request_with_lifetime(
            host,
            &service,
            p,
            config_id,
            AuthorizationPurpose::Smoke,
            source,
            240,
        )
        .await?;
        stage = "invalidate_previous_qualification";
        service
            .invalidate_native_qualification(p, config_id, NativeQualificationKind::Control)
            .await?;
        stage = "create_and_readiness";
        let desktop = service.create_smoke(p, request).await?;
        let desktop = smoke::wait_ready(&service, p, desktop, &smoke::RealWait).await?;
        let authority = NativeSmokeAuthority::new(p);
        let mut assertions = ControlQualificationAssertions::default();
        stage = "explicit_takeover";
        require_smoke_error(
            service
                .control_acquire_inner(p, &desktop.id, desktop.generation, false, &authority, true)
                .await,
            "managed_desktop_control_takeover_required",
        )?;
        assertions.explicit_takeover_required = true;
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        stage = "exclusive_controller";
        let mut second = p.clone();
        second.principal_id = format!("smoke-second-{}", Uuid::new_v4());
        require_smoke_error(
            service
                .control_acquire_inner(
                    &second,
                    &desktop.id,
                    desktop.generation,
                    true,
                    &authority,
                    true,
                )
                .await,
            "managed_desktop_control_busy",
        )?;
        assertions.exclusive_controller = true;
        stage = "authenticated_frame";
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        if frame.screenshot.width == 0
            || frame.screenshot.height == 0
            || frame.screenshot.bytes.is_empty()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        // connect_managed independently challenges both missing ingress and guest
        // authentication before opening the authenticated WebSocket.
        assertions.authenticated_websocket_and_decoded_frame = true;
        stage = "wrong_fence_and_agent_denials";
        let mut wrong_fence = lease.clone();
        wrong_fence.fence = wrong_fence.fence.saturating_add(1);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &wrong_fence, &frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        require_smoke_error(
            smoke_input(&service, &agent, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_human_authorization_required",
        )?;
        assertions.agent_delegation_refused = true;
        stage = "first_positive_fresh_input";
        let (lease, frame) = fresh_smoke_input(&service, p, &desktop, &lease, &authority).await?;
        stage = "single_use_frame";
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_stale_frame",
        )?;
        assertions.single_use_frame = true;
        stage = "frame_expiry";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                ManagedControlLeaseRef {
                    token: &lease.token,
                    fence: lease.fence,
                },
                &authority,
                true,
            )
            .await?;
        let stale = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        stage = "frame_expiry_renew_after_capture";
        // Capture itself may take several seconds. Renew the existing lease
        // after it, preserving the frame's original five-second deadline, so
        // this probe isolates frame expiry from unrelated lease expiry.
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                ManagedControlLeaseRef {
                    token: &lease.token,
                    fence: lease.fence,
                },
                &authority,
                true,
            )
            .await?;
        let sent = authority.admitted.load(Ordering::SeqCst);
        stage = "frame_expiry_wait";
        tokio::time::sleep(Duration::from_millis(FRAME_MS as u64 + 100)).await;
        stage = "frame_expiry_active_lease";
        service
            .control_slot(&desktop.id, desktop.generation)
            .await
            .lock()
            .await
            .require_lease(p, &lease.token, lease.fence)?;
        stage = "frame_expiry_denial";
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &stale, &authority).await,
            "managed_desktop_control_stale_frame",
        )?;
        authority.require_no_sends_since(sent)?;
        assertions.expired_frame_rejected = true;
        stage = "human_release_transfer_renew";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                ManagedControlLeaseRef {
                    token: &lease.token,
                    fence: lease.fence,
                },
                &authority,
                true,
            )
            .await?;
        stage = "human_release_transfer_capture";
        let transfer_frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let released_deadline = smoke_live_lease_deadline(&service, p, &desktop, &lease).await?;
        let transfer_slot = service.control_slot(&desktop.id, desktop.generation).await;
        let transfer_frame_deadline = transfer_slot
            .lock()
            .await
            .frames
            .get(&p.principal_id)
            .and_then(|frames| frames.iter().find(|f| f.id == transfer_frame.frame_id))
            .ok_or_else(|| refused("managed_desktop_control_smoke_failed"))?
            .deadline;
        let sent_before_release = authority.admitted.load(Ordering::SeqCst);
        stage = "human_release_transfer_release";
        service
            .control_release(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &authority,
            )
            .await?;
        stage = "released_fresh_frame_invalidated";
        {
            let control = transfer_slot.lock().await;
            // Prove release invalidated an unexpired frame before remote
            // acquisition consumes time. The next acquire performs two live
            // boundary observations and need not fit the old frame's TTL.
            if Instant::now() >= transfer_frame_deadline
                || control.lease.is_some()
                || !control.frames.is_empty()
                || control.fence <= lease.fence
            {
                return Err(refused("managed_desktop_control_smoke_failed"));
            }
        }
        stage = "released_live_token_denial";
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &transfer_frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        require_smoke_before_deadline(released_deadline)?;
        authority.require_no_sends_since(sent_before_release)?;
        stage = "human_release_transfer_acquire";
        let second_lease = service
            .control_acquire_inner(
                &second,
                &desktop.id,
                desktop.generation,
                true,
                &authority,
                true,
            )
            .await?;
        stage = "human_release_transfer_fence";
        if second_lease.fence <= lease.fence || second_lease.token == lease.token {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        stage = "transferred_old_frame_unbound";
        {
            let mut control = transfer_slot.lock().await;
            control.require_lease(&second, &second_lease.token, second_lease.fence)?;
            if control
                .frames
                .values()
                .flatten()
                .any(|frame| frame.id == transfer_frame.frame_id)
            {
                return Err(refused("managed_desktop_control_smoke_failed"));
            }
        }
        stage = "transferred_old_frame_denial";
        require_smoke_error(
            smoke_input(
                &service,
                &second,
                &desktop,
                &second_lease,
                &transfer_frame,
                &authority,
            )
            .await,
            "managed_desktop_control_stale_frame",
        )?;
        smoke_live_lease_deadline(&service, &second, &desktop, &second_lease).await?;
        authority.require_no_sends_since(sent_before_release)?;
        drop(transfer_slot); // Do not retain the client across the later service-reopen probe.
        assertions.old_token_and_frame_rejected = true;
        stage = "transferred_positive_fresh_input";
        let (second_lease, _) =
            fresh_smoke_input(&service, &second, &desktop, &second_lease, &authority).await?;
        assertions.human_release_transfer = true;
        stage = "principal_revocation_renew";
        let second_lease = service
            .control_renew_inner(
                &second,
                &desktop.id,
                desktop.generation,
                ManagedControlLeaseRef {
                    token: &second_lease.token,
                    fence: second_lease.fence,
                },
                &authority,
                true,
            )
            .await?;
        stage = "principal_revocation_capture";
        // A fresh frame and live lease distinguish epoch revocation from expiry.
        let second_frame = service
            .control_frame_inner(&second, &desktop.id, desktop.generation, &authority, true)
            .await?;
        stage = "principal_revocation_active_lease";
        let revoked_deadline =
            smoke_live_lease_deadline(&service, &second, &desktop, &second_lease).await?;
        let sent = authority.admitted.load(Ordering::SeqCst);
        stage = "principal_revocation_denial";
        service.revoke_control_principal(&second.principal_id).await;
        require_smoke_error(
            smoke_input(
                &service,
                &second,
                &desktop,
                &second_lease,
                &second_frame,
                &authority,
            )
            .await,
            "managed_desktop_control_lease_expired",
        )?;
        require_smoke_before_deadline(revoked_deadline)?;
        authority.require_no_sends_since(sent)?;
        assertions.principal_revocation_rejected = true;
        stage = "live_authority_revocation";
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let authority_deadline = smoke_live_lease_deadline(&service, p, &desktop, &lease).await?;
        authority.active.store(false, Ordering::SeqCst);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_forbidden",
        )?;
        require_smoke_before_deadline(authority_deadline)?;
        authority.require_no_sends_since(sent)?;
        assertions.live_authority_revocation_rejected = true;
        stage = "lease_expiry";
        authority.active.store(true, Ordering::SeqCst);
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        // Real monotonic expiry, not a modified test clock or fabricated deadline.
        tokio::time::sleep(Duration::from_millis(LEASE_MS as u64 + 100)).await;
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        authority.require_no_sends_since(sent)?;
        assertions.expired_lease_rejected = true;
        stage = "service_reopen_old_token";
        let old_lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        let old_frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let reopened_deadline =
            smoke_live_lease_deadline(&service, p, &desktop, &old_lease).await?;
        // Closing the service drops its actual WebSocket senders and journal lock.
        // This is a service reopen, not an operating-system/process restart claim.
        let service = host.checkpoint(service, host.provider(), &[desktop.id.clone()]).await?;
        require_smoke_error(
            smoke_input(&service, p, &desktop, &old_lease, &old_frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        require_smoke_before_deadline(reopened_deadline)?;
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        if lease.token == old_lease.token {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        stage = "reopened_positive_fresh_input";
        let (lease, _) = fresh_smoke_input(&service, p, &desktop, &lease, &authority).await?;
        assertions.service_reopen_invalidates_tokens = true;
        stage = "compound_send_revocation";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                ManagedControlLeaseRef {
                    token: &lease.token,
                    fence: lease.fence,
                },
                &authority,
                true,
            )
            .await?;
        // Revoke after the first admitted command. The driver must acknowledge the
        // pointer move, then reject the second send without emitting a scroll.
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let sent = authority.admitted.load(Ordering::SeqCst);
        authority.revoke_at.store(sent + 1, Ordering::SeqCst);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_quarantined",
        )?;
        if authority.admitted.load(Ordering::SeqCst) != sent + 1
            || authority.denied.load(Ordering::SeqCst) != 1
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        assertions.compound_send_revocation = true;
        stage = "quarantine_survives_reopen";
        authority.active.store(true, Ordering::SeqCst);
        let service = host.checkpoint(service, host.provider(), &[desktop.id.clone()]).await?;
        require_smoke_error(
            service
                .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
                .await,
            "managed_desktop_control_quarantined",
        )?;
        assertions.quarantine_survives_reopen = true;
        let row = service.scoped(p, &desktop.id, desktop.generation).await?;
        Ok(ControlQualificationReceipt {
            binding_digest: digest,
            template: row.template,
            smoke_desktop_id: desktop.id,
            smoke_desktop_generation: desktop.generation,
            observed_at: service.now().await,
            protocol_revision: 1,
            evidence_version: 2,
            assertions,
        })
    }
    .await;
    if let Err(error) = &outcome {
        eprintln!(
            "Native control smoke failed: stage={stage} code={} elapsed_ms={}",
            smoke_error_label(&error.code),
            started.elapsed().as_millis()
        );
    }
    outcome
}

/// Only constructed inside the explicitly authorized native smoke process.
struct NativeSmokeAuthority {
    owner: String,
    host: String,
    active: Arc<AtomicBool>,
    admitted: Arc<AtomicU64>,
    denied: Arc<AtomicU64>,
    revoke_at: Arc<AtomicU64>,
}
impl NativeSmokeAuthority {
    fn new(p: &ManagedDesktopPrincipal) -> Self {
        Self {
            owner: p.owner_principal_id.clone(),
            host: p.host_id.clone(),
            active: Arc::new(AtomicBool::new(true)),
            admitted: Arc::new(AtomicU64::new(0)),
            denied: Arc::new(AtomicU64::new(0)),
            revoke_at: Arc::new(AtomicU64::new(u64::MAX)),
        }
    }
    fn require_no_sends_since(&self, expected: u64) -> Result<()> {
        if self.admitted.load(Ordering::SeqCst) == expected {
            Ok(())
        } else {
            Err(refused("managed_desktop_control_smoke_failed"))
        }
    }
}
#[async_trait]
impl ManagedControlAuthority for NativeSmokeAuthority {
    fn input_admission(&self, p: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let scoped = p.owner_principal_id == self.owner
            && p.host_id == self.host
            && p.require_admin().is_ok();
        let (active, admitted, denied, revoke_at) = (
            self.active.clone(),
            self.admitted.clone(),
            self.denied.clone(),
            self.revoke_at.clone(),
        );
        Arc::new(move || {
            if !scoped || !active.load(Ordering::SeqCst) {
                denied.fetch_add(1, Ordering::SeqCst);
                return false;
            }
            let sequence = admitted.fetch_add(1, Ordering::SeqCst) + 1;
            if sequence == revoke_at.load(Ordering::SeqCst) {
                active.store(false, Ordering::SeqCst);
            }
            true
        })
    }
    async fn revalidate(&self, p: &ManagedDesktopPrincipal) -> Result<()> {
        if p.owner_principal_id != self.owner
            || p.host_id != self.host
            || p.require_admin().is_err()
            || !self.active.load(Ordering::SeqCst)
        {
            return Err(refused("managed_desktop_forbidden"));
        }
        Ok(())
    }
}

fn validate_agent_action(action: &Action) -> AutomationResult<()> {
    use crate::automation::types::*;
    match action {
        Action::Screenshot { .. }
        | Action::CursorPosition
        | Action::ReadTree { root: None, .. }
        | Action::MouseMove { .. }
        | Action::MouseButton { .. } => Ok(()),
        Action::Click {
            target: ClickTarget::Point { x, y },
            opts,
        } => desktop_session::validate_action(
            Some(Point { x: *x, y: *y }),
            &UiAction::Click {
                button: opts.button,
                count: Some(opts.count.unwrap_or(if opts.double == Some(true) { 2 } else { 1 })),
            },
        ),
        Action::Drag { from, to, opts } => desktop_session::validate_action(
            Some(*from),
            &UiAction::Drag {
                to: *to,
                opts: opts.clone(),
            },
        ),
        Action::Scroll {
            target: ScrollTarget::Point { x, y },
            opts,
        } => desktop_session::validate_action(
            Some(Point { x: *x, y: *y }),
            &UiAction::Scroll { opts: opts.clone() },
        ),
        Action::Type { text, opts }
            if opts.target.is_none() && !opts.delay_ms.is_some_and(|delay| delay > 0) =>
        {
            desktop_session::validate_action(None, &UiAction::TypeText { text: text.clone() })
        }
        Action::Keys { chord } | Action::HoldKey { chord, .. } => {
            desktop_session::validate_action(None, &UiAction::PressKey { chord: chord.clone() })
        }
        _ => Err(AutomationError::UnsupportedPlatform),
    }
}

async fn agent_deliver(
    desktop: &mut RemoteDesktop,
    client: &CuaRemoteClient,
    action: Action,
    live: Arc<dyn Fn() -> bool + Send + Sync>,
) -> AutomationResult<ActionOutput> {
    use crate::automation::types::*;
    use crate::cua_sandbox::protocol;
    use serde_json::json;
    match action {
        Action::Screenshot { .. } => {
            return Ok(ActionOutput::Screenshot(desktop_session::capture(client).await?));
        }
        Action::CursorPosition => {
            let value = client.call_simple(protocol::CURSOR_POSITION, json!({})).await?;
            let value = value.get("position").unwrap_or(&value);
            return Ok(ActionOutput::Cursor(Point {
                x: value.get("x").and_then(|v| v.as_i64()).unwrap_or(0)
                    .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                y: value.get("y").and_then(|v| v.as_i64()).unwrap_or(0)
                    .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            }));
        }
        Action::ReadTree { root: None, .. } => {
            let value = client.call_simple(protocol::ACCESSIBILITY_TREE, json!({})).await?;
            let root = value.get("tree").or_else(|| value.get("nodes")).unwrap_or(&value);
            return Ok(ActionOutput::Tree(crate::automation::cua_route::flatten_a11y(root, 0)));
        }
        Action::Click {
            target: ClickTarget::Point { x, y },
            opts,
        } => {
            let action = UiAction::Click {
                button: opts.button,
                count: Some(opts.count.unwrap_or(if opts.double == Some(true) { 2 } else { 1 })),
            };
            desktop_session::deliver(client, Some(Point { x, y }), &action).await?;
        }
        Action::MouseMove { point } => {
            client.call(protocol::move_request(point)).await?;
        }
        Action::Drag { from, to, opts } => {
            client.call(protocol::drag_request(
                from,
                to,
                opts.button.unwrap_or(MouseButton::Left),
                opts.duration_ms.unwrap_or(150) as f64 / 1000.0,
            )).await?;
        }
        Action::Scroll {
            target: ScrollTarget::Point { x, y },
            opts,
        } => {
            client.call(protocol::move_request(Point { x, y })).await?;
            client.call(protocol::scroll_request(&opts)).await?;
        }
        Action::Type { text, opts }
            if opts.target.is_none() && !opts.delay_ms.is_some_and(|delay| delay > 0) =>
        {
            client.call(protocol::type_text_request(&text)).await?;
        }
        Action::Keys { chord } => {
            client.call(protocol::keys_request(&chord)).await?;
        }
        Action::HoldKey { chord, duration_ms } => {
            crate::automation::cua_route::hold_remote_keys(
                desktop, client, chord, duration_ms, Some(live),
            )
            .await?;
        }
        Action::MouseButton { button, transition } => {
            // Record before sending: cancellation must retain cleanup duty.
            let added = transition == ButtonTransition::Down && !desktop.held_mouse_buttons.contains(&button);
            if added {
                desktop.held_mouse_buttons.push(button);
            }
            let command = if transition == ButtonTransition::Down { "mouse_down" } else { "mouse_up" };
            let result = client.call_simple(
                command,
                json!({"button":desktop_session::button_name(button)}),
            ).await;
            if (result.is_ok() && transition == ButtonTransition::Up)
                || (added && matches!(result, Err(AutomationError::PreemptedBeforeSend)))
            {
                desktop.held_mouse_buttons.retain(|held| *held != button);
            }
            result?;
        }
        _ => return Err(AutomationError::UnsupportedPlatform),
    }
    Ok(ActionOutput::Void)
}

fn update_agent_activity(
    state: &mut ManagedDesktopJournal,
    id: &str,
    generation: u64,
    now: i64,
) -> Option<i64> {
    let row = state.desktops.get_mut(id)?;
    if row.desktop.generation != generation || row.delete_requested || row.expired(now) {
        return None;
    }
    row.last_activity_at = now;
    Some(
        row.desktop
            .deadline_at
            .min(now.saturating_add(row.desktop.idle_timeout_seconds as i64 * 1_000)),
    )
}

impl ManagedDesktopService {
    /// A committed end fences the pump immediately. Busy operations perform
    /// their own key cleanup and this queue is retried after their slot drops.
    pub(super) async fn release_ended_agent_inputs(&self) {
        let pending: Vec<_> = self.pending_agent_cleanup.lock().iter().cloned().collect();
        for id in pending {
            let slot = self.controls.lock().await.get(&id).cloned();
            let Some(slot) = slot else {
                self.pending_agent_cleanup.lock().remove(&id);
                continue;
            };
            let Ok(mut control) = slot.try_lock() else {
                continue;
            };
            self.pending_agent_cleanup.lock().remove(&id);
            let keys = control.desktop.held_keys.clone();
            let buttons = control.desktop.held_mouse_buttons.clone();
            if keys.is_empty() && buttons.is_empty() {
                continue;
            }
            if let Err(error) = self
                .transaction(|state, _| {
                    state.control_quarantines.insert(id.clone());
                    Ok(())
                })
                .await
            {
                control.desktop.begin_mutation();
                control.publish();
                log::warn!(
                    "managed desktop ended-grant cleanup checkpoint: {}",
                    error.code
                );
                continue;
            }
            control.desktop.begin_mutation();
            let result = if let Some(client) = control.client.as_ref().map(|c| c.unfenced()) {
                async {
                    for key in keys.iter().rev() {
                        client
                            .call_simple("key_up", serde_json::json!({"key":key}))
                            .await?;
                    }
                    for button in buttons {
                        client
                            .call_simple(
                                "mouse_up",
                                serde_json::json!({
                                    "button": desktop_session::button_name(button),
                                }),
                            )
                            .await?;
                    }
                    Ok(())
                }
                .await
            } else {
                Err(AutomationError::PreemptedBeforeSend)
            };
            // Missing transport cannot confirm release, even though no send
            // happened in this attempt. Retain durable and resident quarantine.
            if result.is_ok() {
                control.desktop.finish_mutation(&result);
                control.desktop.held_keys.clear();
                control.desktop.held_mouse_buttons.clear();
                if let Err(error) = self
                    .transaction(|state, _| {
                        state.agent_held_inputs.remove(&id);
                        state.control_quarantines.remove(&id);
                        Ok(())
                    })
                    .await
                {
                    control.desktop.begin_mutation();
                    log::warn!(
                        "managed desktop cleanup acknowledgement checkpoint: {}",
                        error.code
                    );
                }
            } else {
                log::warn!("managed desktop ended-grant input release is uncertain");
            }
            control.publish();
        }
    }

    pub(super) async fn control_agent_preemption(
        &self,
        id: &str,
    ) -> Arc<desktop_session::DesktopPreemption> {
        self.agent_preemptions.lock().await.entry(id.into()).or_default().clone()
    }

    /// No lease is minted for an agent. The journal grant, owner binding,
    /// running generation and effective switch are checked on every call/send.
    pub(crate) async fn agent_operation(
        &self,
        id: &str,
        generation: u64,
        session: Option<String>,
        character: Option<String>,
        action: Action,
    ) -> AutomationResult<ActionOutput> {
        {
            let state = self.state.lock().await;
            let error = match state.desktops.get(id) {
                None => Some("managed_desktop_not_found"),
                Some(row) if row.desktop.generation != generation => {
                    Some("managed_desktop_stale_generation")
                }
                _ => None,
            };
            if let Some(code) = error {
                return Err(AutomationError::PermissionDenied {
                    reason: code.into(),
                });
            }
        }
        let outcome = self
            .agent_operation_inner(id, generation, session, character, action)
            .await;
        // A send fence is synchronous; settle its observed account change before
        // returning even when the driver refused or an operation was preempted.
        if let Err(error) = self.reconcile_delegations().await {
            log::warn!("managed desktop post-operation reconciliation: {}", error.code);
        }
        self.release_ended_agent_inputs().await;
        outcome
    }
    async fn agent_operation_inner(
        &self,
        id: &str,
        generation: u64,
        session: Option<String>,
        character: Option<String>,
        action: Action,
    ) -> AutomationResult<ActionOutput> {
        validate_agent_action(&action)?;
        let deny = |error: ManagedDesktopError| AutomationError::PermissionDenied { reason: error.code };
        self.reconcile_delegations().await.map_err(deny)?;
        self.refresh_agent_admission().await.map_err(deny)?;
        let row = self
            .state
            .lock()
            .await
            .desktops
            .get(id)
            .cloned()
            .ok_or_else(|| deny(refused("managed_desktop_not_found")))?;
        let service = self.clone();
        let target = id.to_owned();
        let gate = self.agent_gate(id, generation, session.as_deref());
        let live = Arc::new(move || {
            service.agent_live(&target, generation, session.as_deref(), character.as_deref())
        });
        if !live() {
            return Err(deny(refused("managed_desktop_delegation_required")));
        }
        let admission =
            self.runtime_admission_for_record(&row, gate, live);
        if !admission() {
            return Err(deny(refused("managed_desktop_agent_control_unqualified")));
        }
        let slot = self.control_slot(id, generation).await;
        let preempt = self.control_agent_preemption(id).await;
        let mut c = slot.lock().await;
        c.expire();
        c.desktop.preempt = preempt.clone();
        c.desktop.agent_epoch = preempt.epoch.load(Ordering::SeqCst);
        c.desktop.require_agent()?;
        if c.lease.is_some() {
            return Err(deny(refused("managed_desktop_control_busy")));
        }
        if self.state.lock().await.control_quarantines.contains(id) {
            return Err(deny(refused("managed_desktop_control_quarantined")));
        }
        if !admission() {
            return Err(AutomationError::PreemptedBeforeSend);
        }
        let principal = ManagedDesktopPrincipal {
            owner_principal_id: row.config.owner_principal_id.clone(),
            host_id: self.host_id.clone(),
            principal_id: "delegated-agent".into(),
            authority: ManagedDesktopAuthority::Agent,
        };
        self.validate_live_boundary(&principal, &row.desktop)
            .await
            .map_err(deny)?;
        let raw = self.control_client(&row, &mut c).await.map_err(deny)?;
        let epoch = c.desktop.agent_epoch;
        let send = admission.clone();
        let live: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            !preempt.pending.load(Ordering::SeqCst)
                && preempt.epoch.load(Ordering::SeqCst) == epoch
                && send()
        });
        let client = raw.fenced_preemptible(live.clone());
        let mutation = !matches!(
            action,
            Action::Screenshot { .. } | Action::CursorPosition | Action::ReadTree { .. }
        );
        let _active = AgentOperationStatus::begin(c.agent_active.clone());
        if mutation {
            self.transaction(|s, _| {
                s.control_quarantines.insert(id.into());
                Ok(())
            })
            .await
            .map_err(deny)?;
            c.desktop.begin_mutation();
        }
        c.publish();
        // Refresh durable registry changes away from the send pump. This future
        // is scoped to the operation and is cancelled with it (no detached task).
        let refresh = async {
            loop {
                tokio::time::sleep(cognia_remote_desktop::session::ADMISSION_INTERVAL).await;
                if let Err(error) = self.refresh_agent_admission().await {
                    *self.agent_admission.write() = Default::default();
                    log::warn!("managed desktop admission refresh: {}", error.code);
                }
            }
        };
        let result = tokio::select! {
            result = agent_deliver(&mut c.desktop, &client, action, live) => result,
            _ = refresh => unreachable!("admission refresh runs until delivery completes"),
        };
        let mut activity_failed = false;
        if mutation {
            c.desktop.finish_mutation(&result);
            if result.is_ok() || matches!(result, Err(AutomationError::PreemptedBeforeSend)) {
                let held = !c.desktop.held_keys.is_empty() || !c.desktop.held_mouse_buttons.is_empty();
                let delivered = result.is_ok();
                let checkpoint = self
                    .transaction(|s, now| {
                        if held {
                            s.agent_held_inputs.insert(id.into(), generation);
                        } else {
                            s.agent_held_inputs.remove(id);
                        }
                        s.control_quarantines.remove(id);
                        if delivered {
                            update_agent_activity(s, id, generation, now);
                        }
                        Ok(())
                    })
                    .await;
                if let Err(error) = checkpoint {
                    activity_failed = delivered;
                    // The input may already be delivered. Keep quarantine and
                    // report the durable cleanup failure without inviting retry.
                    c.desktop.begin_mutation();
                    log::warn!("managed desktop delivered-input checkpoint: {}", error.code);
                }
            }
        }
        if result.is_ok() {
            if !mutation {
                let activity = self
                    .transaction(|s, now| {
                        update_agent_activity(s, id, generation, now);
                        Ok(())
                    })
                    .await;
                if let Err(error) = activity {
                    activity_failed = true;
                    log::warn!("managed desktop delivered-input activity: {}", error.code);
                }
            }
            if activity_failed {
                // Activity remains current in memory if its checkpoint fails.
                // Other journal changes are still uncommitted and quarantined.
                let mut state = self.state.lock().await;
                let now = (self.clock)().max(state.last_observed_at);
                if let Some(deadline) = update_agent_activity(&mut state, id, generation, now) {
                    if let Some(current) = self.agent_admission.write().desktops.get_mut(id) {
                        if current.generation == generation {
                            current.deadline = deadline;
                        }
                    }
                }
            }
            if !admission() {
                log::debug!("managed desktop delegation ended after acknowledged delivery");
            }
        }
        c.publish();
        result
    }
    /// Fast fencing does not wait for a screenshot/input mutex. An in-flight
    /// operation remains quarantined until its acknowledgement is observed.
    pub async fn revoke_control_principal(&self, principal_id: &str) {
        if let Some(epoch) = self.control_principal_epochs.lock().await.get(principal_id) {
            epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    pub(super) async fn revoke_control_desktop(&self, id: &str) {
        if let Some(epoch) = self.control_desktop_epochs.lock().await.get(id) {
            epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    pub(super) async fn control_slot(&self, id: &str, generation: u64) -> Arc<Mutex<ManagedControl>> {
        self.controls
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| {
                let mut control = ManagedControl::new(id, generation);
                control.projections = self.control_projections.clone();
                control.publish();
                Arc::new(Mutex::new(control))
            })
            .clone()
    }
    pub(super) async fn control_qualified(&self, row: &DesktopRecord) -> bool {
        let state = self.state.lock().await;
        let now = (self.clock)();
        latest_template(&state, &row.config.binding_digest()).and_then(|t| t.identity.as_ref()) == Some(&row.template)
            && qualification::gui_current(&state, &row.config, now)
    }
    async fn control_check(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<DesktopRecord> {
        let row = self
            .control_check_local(p, id, generation, authority, smoke)
            .await?;
        // Boundary identity is a live admission check, including reused clients.
        self.validate_live_boundary(p, &row.desktop).await?;
        authority.revalidate(p).await?;
        Ok(row)
    }
    async fn control_check_local(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<DesktopRecord> {
        authority.revalidate(p).await?;
        let row = self.scoped(p, id, generation).await?;
        let current = self.config(p, &row.config.id).await?;
        self.admission(&current, self.now().await)?;
        if current.binding_digest() != row.config.binding_digest()
            || row.delete_requested
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await)
        {
            return Err(refused("managed_desktop_control_unavailable"));
        }
        if !(smoke && row.smoke && p.authority == ManagedDesktopAuthority::Administrator) {
            let enabled = self.effective_enablement(p, &current.id).await?;
            let qualified = if self.acceptance_frame_live(p, id, generation) {
                enabled.acceptance
            } else {
                enabled.manual_gui
            };
            if !qualified || !self.control_qualified(&row).await {
                return Err(refused("managed_desktop_control_unqualified"));
            }
        }
        let agent_active = self.control_projections.read().get(id).is_some_and(|status| {
            status.generation == generation && status.agent_active.load(Ordering::SeqCst)
        });
        if !agent_active && self.state.lock().await.control_quarantines.contains(id) {
            return Err(refused("managed_desktop_control_quarantined"));
        }
        // Recheck authentication after asynchronous configuration/storage work.
        authority.revalidate(p).await?;
        Ok(row)
    }
    async fn control_client(
        &self,
        row: &DesktopRecord,
        control: &mut ManagedControl,
    ) -> Result<Arc<CuaRemoteClient>> {
        if control.generation != row.desktop.generation {
            control.invalidate();
            return Err(refused("managed_desktop_stale_generation"));
        }
        if let Some(client) = &control.client {
            if !client.is_closed() {
                return Ok(client.clone());
            }
            control.invalidate();
            control.client = None;
            return Err(refused("managed_desktop_control_disconnected"));
        }
        let secrets = self.secrets.desktop(&row.desktop.id).await?;
        let mut url = desktop_endpoint(
            row.resource_id
                .as_deref()
                .ok_or_else(|| refused("managed_desktop_not_connected"))?,
            secrets.domain.as_deref(),
        )?;
        url.set_scheme("wss")
            .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
        url.set_path("/ws");
        let client = CuaRemoteClient::connect_managed(
            url.to_string(),
            &secrets.guest_token,
            secrets
                .traffic_token
                .as_deref()
                .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?,
        )
        .await
        .map_err(control_error)?;
        control.client = Some(client.clone());
        Ok(client)
    }
    pub async fn control_status(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedControlStatus> {
        let row = self.scoped(p, id, generation).await?;
        let enablement = self.desktop_enablement(p, id, generation).await.unwrap_or_default();
        let qualified = enablement.manual_gui && self.control_qualified(&row).await
            && self.config(p, &row.config.id).await.is_ok_and(|current| {
                current.binding_digest() == row.config.binding_digest()
                    && self.admission(&current, (self.clock)()).is_ok()
            });
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut locked = slot.try_lock().ok();
        if let Some(c) = &mut locked {
            c.expire();
        }
        let unavailable = row.delete_requested
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await);
        let projection = self.control_projections.read().get(id).cloned().unwrap_or_default();
        // The durable marker also covers a healthy in-flight agent mutation.
        // A human can take it over; cancellation drops the active flag and
        // exposes the same marker as uncertain cleanup immediately.
        let active = projection.generation == generation
            && projection.agent_active.load(Ordering::SeqCst);
        let quarantined = !active
            && (self.state.lock().await.control_quarantines.contains(id)
                || (projection.generation == generation && projection.uncertain));
        if unavailable || !qualified || quarantined {
            if let Some(c) = &mut locked {
                c.invalidate();
            }
        }
        let projection = self.control_projections.read().get(id).cloned().unwrap_or_default();
        let principal = projection.principal.as_ref().filter(|_| {
            projection.generation == generation
                && projection.expires_at.is_some_and(|at| at > (self.clock)())
        });
        let state = if unavailable {
            "unavailable"
        } else if !qualified {
            "dormant"
        } else if quarantined {
            "quarantined"
        } else if principal.is_some() {
            "controlled"
        } else {
            "observer"
        };
        Ok(ManagedControlStatus {
            qualified,
            state: state.into(),
            controller_kind: principal.map(|_| "human".into()),
            controller_is_self: principal.is_some_and(|id| id == &p.principal_id),
            lease_expires_at: principal.and(projection.expires_at),
            fence: projection.fence,
            can_acquire: state == "observer" && p.require_human().is_ok(),
            // Delegated agent admission consumes the effective WP4 switch.
            agent_control_dormant: !enablement.agent_control,
        })
    }
    /// Explicit native handoff diagnostic only. The same source/generation and
    /// smoke authority fences used by transfer apply to retained checkpoints.
    pub async fn capture_handoff_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop,
        operation_id: &str,
    ) -> Result<Screenshot> {
        p.require_admin()?;
        let expected = format!("handoff:{operation_id}");
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if !row.smoke || row.source_id.as_deref() != Some(expected.as_str()) {
            return Err(refused("managed_desktop_handoff_desktop_not_authorized"));
        }
        let authority = NativeSmokeAuthority::new(p);
        Ok(self
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?
            .screenshot)
    }

    /// Explicit native diagnostic seam. The native-only paid-smoke permit
    /// and persisted smoke row prevent RPC callers from bypassing qualification.
    pub async fn control_frame_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlFrame> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_frame_inner(p, id, generation, authority, true)
            .await
    }
    pub async fn control_acquire_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlLease> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_acquire_inner(p, id, generation, takeover, authority, true)
            .await
    }
    pub async fn control_renew_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        lease: ManagedControlLeaseRef<'_>,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlLease> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_renew_inner(p, id, generation, lease, authority, true)
            .await
    }
    pub async fn control_input_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: ManagedControlInput<'_>,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<()> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_input_inner(p, id, generation, input, authority, true)
            .await
    }
    async fn require_control_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<()> {
        p.require_admin()?;
        if !self.scoped(p, id, generation).await?.smoke {
            return Err(refused("managed_desktop_control_smoke_required"));
        }
        Ok(())
    }

    pub async fn control_frame(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlFrame> {
        self.control_frame_inner(p, id, generation, authority, false)
            .await
    }
    /// Memory-only publication fence: a takeover during capture or evidence
    /// persistence must discard the agent's sample, even after the lease ends.
    pub async fn acceptance_capture_admission(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<Arc<dyn Fn() -> bool + Send + Sync>> {
        self.scoped(p, id, generation).await?;
        let preempt = self.control_agent_preemption(id).await;
        let epoch = preempt.epoch.load(Ordering::SeqCst);
        let slot = self.control_slot(id, generation).await;
        let mut control = slot.lock().await;
        control.expire();
        if control.lease.is_some()
            || preempt.pending.load(Ordering::SeqCst)
            || preempt.epoch.load(Ordering::SeqCst) != epoch
        {
            return Err(refused("managed_desktop_acceptance_human_control"));
        }
        Ok(Arc::new(move || {
            !preempt.pending.load(Ordering::SeqCst)
                && preempt.epoch.load(Ordering::SeqCst) == epoch
        }))
    }
    async fn control_frame_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlFrame> {
        self.capture_frame_inner(p, id, generation, authority, smoke, false)
            .await
    }
    /// Read through the owner's live record. Never adds a remote target record.
    pub(crate) async fn native_frame_generation(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        authority: &dyn ManagedControlAuthority
    ) -> Result<u64> {
        let generation = self
            .state
            .lock()
            .await
            .desktops
            .get(id)
            .map(|row| row.desktop.generation)
            .ok_or_else(|| refused("managed_desktop_not_found"))?;
        self.control_check(p, id, generation, authority, false)
            .await?;
        Ok(generation)
    }
    /// Per-viewer admission performs no screenshot or provider request.
    pub(crate) async fn native_frame_admission(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority
    ) -> Result<()> {
        self.control_check_local(p, id, generation, authority, false)
            .await
            .map(|_| ())
    }
    pub(crate) async fn native_stream_frame(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority
    ) -> Result<(ManagedControlFrame, bool)> {
        let frame = self
            .capture_frame_inner(p, id, generation, authority, false, true)
            .await?;
        let human = self.control_projections.read().get(id).is_some_and(|status| {
            status.generation == generation && status.principal.is_some()
                && status.expires_at.is_some_and(|at| at > (self.clock)())
        });
        Ok((frame, human))
    }
    async fn capture_frame_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
        stream: bool,
    ) -> Result<ManagedControlFrame> {
        self.scoped(p, id, generation).await?;
        let human_admission = if p.authority == ManagedDesktopAuthority::Agent
            && p.principal_id.starts_with("acceptance:")
        {
            Some(self.acceptance_capture_admission(p, id, generation).await?)
        } else {
            None
        };
        let slot = self.control_slot(id, generation).await;
        // Input has priority over the stream: a stream capture never queues
        // control input behind a network screenshot, it skips the tick.
        let mut c = if stream {
            slot.try_lock()
                .map_err(|_| retryable("managed_desktop_frame_busy"))?
        } else {
            slot.lock().await
        };
        let row = self
            .control_check(p, id, generation, authority, smoke)
            .await?;
        c.expire();
        if human_admission.as_ref().is_some_and(|live| !live())
            || (human_admission.is_some() && c.lease.is_some())
        {
            return Err(refused("managed_desktop_acceptance_human_control"));
        }
        let client = self.control_client(&row, &mut c).await?;
        let screenshot = desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            // A stream capture runs on one viewer's authority while another
            // principal may hold the lease: that viewer losing access drops
            // the pixels and never cancels the controller's lease or proofs.
            if !stream {
                c.invalidate();
            }
            return Err(e);
        }
        c.expire();
        if human_admission.as_ref().is_some_and(|live| !live())
            || (human_admission.is_some() && c.lease.is_some())
        {
            return Err(refused("managed_desktop_acceptance_human_control"));
        }
        let now = self.now().await;
        // A newer poll may arrive at the Host before its pixels reach the
        // viewer. The core retains prior unexpired proofs so the visible frame
        // remains usable throughout its five-second validity window, and
        // refuses excess polling instead of evicting a still-visible proof.
        let proof_principal = if stream {
            c.core
                .status()
                .lease
                .map(|lease| lease.principal.clone())
                .unwrap_or_else(|| p.principal_id.clone())
        } else {
            p.principal_id.clone()
        };
        let proof = c
            .core
            .register_frame(
                &proof_principal,
                now,
                row.desktop.deadline_at,
                screenshot.width,
                screenshot.height,
            )
            .map_err(core_frame_error)?;
        Ok(ManagedControlFrame {
            frame_id: proof.frame_id,
            fence: proof.fence,
            expires_at: proof.expires_at,
            screenshot,
        })
    }
    pub async fn control_acquire(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlLease> {
        self.control_acquire_inner(p, id, generation, takeover, authority, false)
            .await
    }
    async fn control_acquire_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlLease> {
        p.require_human()?;
        if !takeover {
            return Err(refused("managed_desktop_control_takeover_required"));
        }
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let preempt = self.control_agent_preemption(id).await;
        let _pending = desktop_session::PendingTakeover::begin(preempt).map_err(control_error)?;
        let mut c = slot.lock().await;
        let row = self
            .control_check(p, id, generation, authority, smoke)
            .await?;
        c.expire();
        if c.lease.is_some() {
            return Err(refused("managed_desktop_control_busy"));
        }
        c.desktop.require_quiescent().map_err(control_error)?;
        let client = self.control_client(&row, &mut c).await?;
        let held = c.desktop.held_mouse_buttons.clone();
        let keys = c.desktop.held_keys.clone();
        if !held.is_empty() || !keys.is_empty() {
            self.transaction(|s, _| {
                s.control_quarantines.insert(id.into());
                Ok(())
            })
            .await?;
            c.desktop
                .run_mutation(async {
                    for key in keys.iter().rev() {
                        client.call_simple("key_up", serde_json::json!({"key":key})).await?;
                    }
                    for button in held {
                        client
                            .call_simple(
                                "mouse_up",
                                serde_json::json!({"button":desktop_session::button_name(button)}),
                            )
                            .await?;
                    }
                    Ok(())
                })
                .await
                .map_err(control_error)?;
            c.desktop.held_mouse_buttons.clear();
            c.desktop.held_keys.clear();
            self.transaction(|s, _| {
                s.agent_held_inputs.remove(id);
                s.control_quarantines.remove(id);
                Ok(())
            })
            .await?;
        }
        desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.revoked = self
            .control_principal_epochs
            .lock()
            .await
            .entry(p.principal_id.clone())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        let lease = c.issue(p, self.now().await, row.desktop.deadline_at);
        c.audit(
            "remote_desktop.lease.acquire",
            &p.principal_id,
            "allowed",
            serde_json::json!({ "expires_at": lease.expires_at }),
        );
        Ok(lease)
    }
    pub async fn control_renew(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlLease> {
        self.control_renew_inner(
            p,
            id,
            generation,
            ManagedControlLeaseRef { token, fence },
            authority,
            false,
        )
        .await
    }
    async fn control_renew_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        lease: ManagedControlLeaseRef<'_>,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlLease> {
        let ManagedControlLeaseRef { token, fence } = lease;
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        let row = self.scoped(p, id, generation).await?;
        let now = self.now().await;
        let lease = c
            .core
            .renew(&p.principal_id, token, fence, now, row.desktop.deadline_at)
            .map_err(|_| refused("managed_desktop_control_lease_expired"))?;
        c.audit(
            "remote_desktop.lease.renew",
            &p.principal_id,
            "allowed",
            serde_json::json!({ "expires_at": lease.expires_at }),
        );
        Ok(ManagedControlLease {
            token: lease.token,
            fence: lease.fence,
            expires_at: lease.expires_at,
        })
    }
    pub async fn control_release(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        p.require_human()?;
        authority.revalidate(p).await?;
        self.scoped(p, id, generation).await?;
        self.native_control_release(p, id, generation, token, fence)
            .await
    }
    /// Broker cleanup must release its exact existing lease even after device
    /// revocation. Scope and token/fence checks still prevent releasing another
    /// principal's lease. Interactive RPC admission above remains unchanged.
    pub(crate) async fn native_control_release(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
    ) -> Result<()> {
        p.require_human()?;
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        c.require_lease(p, token, fence)?;
        c.audit(
            "remote_desktop.lease.release",
            &p.principal_id,
            "allowed",
            serde_json::json!({}),
        );
        c.invalidate();
        Ok(())
    }
    pub async fn control_input(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: ManagedControlInput<'_>,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        self.control_input_inner(p, id, generation, input, authority, false)
            .await
    }
    /// Broker delivery shares the human input core. A refusal before sending
    /// input retains the lease so the next fresh frame/action can be tried.
    pub async fn native_control_input(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: ManagedControlInput<'_>,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        self.control_input_impl(p, id, generation, input, authority, false, true)
            .await
    }
    /// Read-only broker precheck gives malformed input a per-input refusal
    /// without changing the public control core's error or mutation semantics.
    pub(crate) async fn native_input_check(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: &ManagedControlInput<'_>,
    ) -> Result<()> {
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut control = slot.lock().await;
        control.require_lease(p, input.token, input.fence)?;
        let frame = control
            .core
            .frame(&p.principal_id, input.frame_id, input.fence)
            .map_err(|_| refused("managed_desktop_control_stale_frame"))?;
        if let Some(point) = input.point {
            desktop_session::validate_point(point, frame.width, frame.height)
                .map_err(|_| refused("managed_desktop_control_input_limit"))?;
        }
        if let UiAction::Drag { to, .. } = &input.action {
            desktop_session::validate_point(*to, frame.width, frame.height)
                .map_err(|_| refused("managed_desktop_control_input_limit"))?;
        }
        desktop_session::validate_action(input.point, &input.action)
            .map_err(|_| refused("managed_desktop_control_input_limit"))
    }
    async fn control_input_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: ManagedControlInput<'_>,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<()> {
        self.control_input_impl(p, id, generation, input, authority, smoke, false)
            .await
    }
    async fn control_input_impl(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        input: ManagedControlInput<'_>,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
        retain_refusals: bool,
    ) -> Result<()> {
        let ManagedControlInput {
            token,
            fence,
            frame_id,
            point,
            action,
        } = input;
        let input_started = Instant::now();
        p.require_human()?;
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        // Admit the non-mutating screenshot locally. The full live boundary
        // check below still runs after capture and before every mutation. A
        // second remote observation here consumed most of the frame's fixed
        // five-second lifetime without strengthening that final send check.
        if let Err(e) = self
            .control_check_local(p, id, generation, authority, smoke)
            .await
        {
            if !retain_native_refusal(retain_refusals, &e) {
                c.invalidate();
            }
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        let f = c
            .frames
            .get(&p.principal_id)
            .and_then(|frames| {
                frames
                    .iter()
                    .find(|f| f.id == frame_id && f.fence == fence && Instant::now() < f.deadline)
            })
            .ok_or_else(|| refused("managed_desktop_control_stale_frame"))?;
        if let Some(point) = point {
            desktop_session::validate_point(point, f.width, f.height).map_err(control_error)?;
        }
        if let UiAction::Drag { to, opts } = &action {
            desktop_session::validate_point(*to, f.width, f.height).map_err(control_error)?;
            if opts.duration_ms.unwrap_or(150) > 2_000 || opts.steps.unwrap_or(12) > 60 {
                return Err(refused("managed_desktop_control_input_limit"));
            }
        }
        if matches!(&action, UiAction::PressKey { chord } if chord.0.len() > 256) {
            return Err(refused("managed_desktop_control_input_limit"));
        }
        if matches!(&action, UiAction::TypeText { text } if text.len() > 4096) {
            return Err(refused("managed_desktop_control_input_limit"));
        }
        desktop_session::validate_action(point, &action).map_err(control_error)?;
        let client = c
            .client
            .clone()
            .ok_or_else(|| refused("managed_desktop_control_disconnected"))?;
        let deadline = c.lease.as_ref().unwrap().deadline.min(f.deadline);
        let observed_size = (f.width, f.height);
        let current = desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if (current.width, current.height) != observed_size || Instant::now() >= deadline {
            c.frames.clear();
            return Err(refused("managed_desktop_control_stale_frame"));
        }
        if let Err(error) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            if !retain_native_refusal(retain_refusals, &error) {
                c.invalidate();
            }
            return Err(error);
        }
        c.require_lease(p, token, fence)?;
        c.frames.clear(); // A coordinate frame is single-use even on uncertainty.
        self.transaction(|s, _| {
            s.control_quarantines.insert(id.into());
            Ok(())
        })
        .await?;
        // The durable pending flag intentionally makes cancellation/restart
        // quarantine the desktop; only successful acknowledgement clears it.
        if let Err(error) = authority.revalidate(p).await {
            if retain_native_refusal(retain_refusals, &error) {
                self.transaction(|s, _| {
                    s.control_quarantines.remove(id);
                    Ok(())
                })
                .await?;
            }
            return Err(error);
        }
        c.require_lease(p, token, fence)?;
        let row = self.scoped(p, id, generation).await?;
        if row.delete_requested || row.expired(self.now().await) {
            c.invalidate();
            return Err(refused("managed_desktop_control_unavailable"));
        }
        if Instant::now() >= deadline {
            if retain_refusals {
                self.transaction(|s, _| {
                    s.control_quarantines.remove(id);
                    Ok(())
                })
                .await?;
            } else {
                c.invalidate();
            }
            return Err(refused("managed_desktop_control_stale_frame"));
        }
        let principal_epoch = c.revoked.clone();
        let expected_principal_epoch = c.lease.as_ref().expect("validated lease").epoch;
        let desktop_epoch = self
            .control_desktop_epochs
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        let expected_desktop_epoch = desktop_epoch.load(Ordering::SeqCst);
        // Re-read deletion after installing the shared epoch: a delete cannot
        // race the first insertion and evade the pump's final send check.
        let row = self.scoped(p, id, generation).await?;
        if row.delete_requested || row.expired(self.now().await) {
            c.invalidate();
            return Err(refused("managed_desktop_control_unavailable"));
        }
        let live_authority = if smoke {
            authority.input_admission(p)
        } else {
            self.runtime_admission_for_record(
                &row,
                ManagedDesktopRuntimeGate::ManualGui,
                authority.input_admission(p),
            )
        };
        let send_counts =
            (smoke || retain_refusals).then(|| Arc::new((AtomicU64::new(0), AtomicU64::new(0))));
        let observed_sends = send_counts.clone();
        let client = client.fenced(Arc::new(move || {
            let admitted = live_authority()
                && Instant::now() < deadline
                && principal_epoch.load(Ordering::SeqCst) == expected_principal_epoch
                && desktop_epoch.load(Ordering::SeqCst) == expected_desktop_epoch;
            if let Some(counts) = &observed_sends {
                if admitted {
                    counts.0.fetch_add(1, Ordering::SeqCst);
                } else {
                    counts.1.fetch_add(1, Ordering::SeqCst);
                }
            }
            admitted
        }));
        let send_started = Instant::now();
        let send_budget_ms = deadline.saturating_duration_since(send_started).as_millis();
        let outcome = tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline),
            c.desktop
                .run_mutation(desktop_session::deliver(&client, point, &action)),
        )
        .await;
        if !matches!(outcome, Ok(Ok(()))) {
            // The pump is the only place this fence is evaluated. Zero
            // admitted commands plus a fence refusal proves no mutation was
            // sent; a partial/uncertain send must retain quarantine below.
            let unsent = retain_refusals
                && matches!(&outcome, Ok(Err(AutomationError::PermissionDenied { .. })))
                && send_counts.as_ref().is_some_and(|counts| {
                    counts.0.load(Ordering::SeqCst) == 0 && counts.1.load(Ordering::SeqCst) > 0
                });
            if unsent {
                let refusal = authority.revalidate(p).await.err().or_else(|| {
                    (Instant::now() >= deadline)
                        .then(|| refused("managed_desktop_control_stale_frame"))
                });
                if let Some(error) = refusal.filter(|error| retain_native_refusal(true, error)) {
                    // The wrapper's quiescence check still sees this proven
                    // unsent mutation as pending. Validate only its exact
                    // lease proof before clearing that pending marker.
                    c.core
                        .require_lease(&p.principal_id, token, fence)
                        .map_err(|_| refused("managed_desktop_control_lease_expired"))?;
                    self.transaction(|s, _| {
                        s.control_quarantines.remove(id);
                        Ok(())
                    })
                    .await?;
                    c.desktop.finish_mutation(&Ok::<(), AutomationError>(()));
                    c.publish();
                    return Err(error);
                }
            }
            if let Some(counts) = send_counts {
                if smoke {
                    let cause = match &outcome {
                        Err(_) => "input_deadline_elapsed",
                        Ok(Err(error)) => smoke_driver_failure(error),
                        Ok(Ok(())) => "unexpected_success",
                    };
                    eprintln!("Native control mutation quarantined: cause={cause} input_elapsed_ms={} send_elapsed_ms={} send_budget_ms={send_budget_ms} admitted_commands={} denied_commands={}",
                        input_started.elapsed().as_millis(), send_started.elapsed().as_millis(),
                        counts.0.load(Ordering::SeqCst), counts.1.load(Ordering::SeqCst));
                }
            }
            let (action_kind, count) = desktop_session::input_audit_fields(&action);
            c.audit(
                "remote_desktop.input.quarantined",
                &p.principal_id,
                "quarantined",
                serde_json::json!({ "action_kind": action_kind, "count": count }),
            );
            c.invalidate();
            return Err(refused("managed_desktop_control_quarantined"));
        }
        self.transaction(|s, now| {
            s.control_quarantines.remove(id);
            let row = s
                .desktops
                .get_mut(id)
                .ok_or_else(|| refused("managed_desktop_not_found"))?;
            if row.desktop.generation == generation && !row.delete_requested && !row.expired(now) {
                row.last_activity_at = now;
            }
            Ok(())
        })
        .await?;
        let (action_kind, count) = desktop_session::input_audit_fields(&action);
        c.audit(
            "remote_desktop.input",
            &p.principal_id,
            "allowed",
            serde_json::json!({ "action_kind": action_kind, "count": count }),
        );
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            if !retain_native_refusal(retain_refusals, &e) {
                c.invalidate();
            }
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) async fn native_test_fixture() -> (
    tempfile::TempDir,
    Arc<ManagedDesktopService>,
    ManagedDesktopPrincipal,
    ManagedDesktop,
    Arc<AtomicU64>,
) {
    native_test_fixture_with_capture(Arc::new(|| {})).await
}
#[cfg(test)]
pub(crate) async fn native_test_fixture_with_capture(
    captured: Arc<dyn Fn() + Send + Sync>,
) -> (
    tempfile::TempDir,
    Arc<ManagedDesktopService>,
    ManagedDesktopPrincipal,
    ManagedDesktop,
    Arc<AtomicU64>,
) {
    use base64::Engine as _;
    let (fixture, row, _) = super::delegation::tests::fixture().await;
    let inputs = Arc::new(AtomicU64::new(0));
    let observed = inputs.clone();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(20, 20)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let pixels = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    let client = CuaRemoteClient::from_handler(Arc::new(move |request, _| {
        let pixels = pixels.clone();
        let observed = observed.clone();
        let captured = captured.clone();
        Box::pin(async move {
            if request.command == "screenshot" {
                captured();
                Ok(serde_json::json!({"status":"success","image_data":pixels}))
            } else {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(serde_json::json!({"status":"success"}))
            }
        })
    }));
    fixture
        .service
        .control_slot(&row.id, row.generation)
        .await
        .lock()
        .await
        .client = Some(client);
    (
        fixture.directory,
        Arc::new(fixture.service),
        fixture.p,
        row,
        inputs,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_provider_lists_only_owner_desktops_and_refuses_observer_control() {
        use crate::cua_sandbox::managed::frame_source::{
            ManagedFrameContext, ManagedNativeFrameProvider,
        };
        use cognia_remote_desktop::{
            frames::NativeFrameProvider,
            session::{Principal, SessionMode},
        };
        let domain = super::super::tests::Fixture::new();
        domain.prepare().await;
        let row = domain.smoke("native-list").await;
        let p = domain.p.clone();
        let service = Arc::new(domain.service);
        let provider = ManagedNativeFrameProvider::new(
            service,
            Arc::new(move |viewer| {
                let mut principal = p.clone();
                if viewer.id() == "device:foreign" {
                    principal.owner_principal_id = "foreign-owner".into();
                }
                Box::pin(async move {
                    Ok(ManagedFrameContext {
                        principal,
                        authority: Arc::new(Authority(Arc::new(AtomicBool::new(true)))),
                        input_executor: Arc::new(|_| {
                            Box::pin(async {
                                Err(cognia_remote_desktop::frames::NativeInputError::fatal(
                                    cognia_remote_desktop::error::RemoteDesktopError::new(
                                        "remote_desktop_forbidden",
                                    ),
                                ))
                            })
                        }),
                    })
                })
            }),
        );
        let observer = Principal::device("observer", Arc::new(|mode| mode == SessionMode::View));
        let listed = provider.list(observer.clone()).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);
        assert_eq!(
            listed[0].provider,
            cognia_remote_desktop::frames::NativeProviderKind::E2b
        );
        assert!(provider
            .list(Principal::device("foreign", Arc::new(|_| true)))
            .await
            .unwrap()
            .is_empty());
        assert!(provider
            .acquire_input(row.id, observer, true)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn native_cleanup_releases_exact_lease_after_revocation_and_never_releases_a_takeover() {
        let domain = super::super::tests::Fixture::new();
        domain.prepare().await;
        let row = domain.smoke("native-cleanup").await;
        let p = &domain.p;
        let service = &domain.service;
        let slot = service.control_slot(&row.id, row.generation).await;
        let lease = slot.lock().await.issue(p, 1000, row.deadline_at);
        let revoked = Authority(Arc::new(AtomicBool::new(false)));
        assert!(service
            .control_release(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &revoked
            )
            .await
            .is_err());
        service
            .native_control_release(p, &row.id, row.generation, &lease.token, lease.fence)
            .await
            .unwrap();
        let next = slot.lock().await.issue(p, 1000, row.deadline_at);
        assert!(service
            .native_control_release(p, &row.id, row.generation, &lease.token, lease.fence)
            .await
            .is_err());
        assert_eq!(
            slot.lock().await.core.status().lease.unwrap().dto.token,
            next.token
        );
        service
            .native_control_release(p, &row.id, row.generation, &next.token, next.fence)
            .await
            .unwrap();
    }
    struct Authority(Arc<AtomicBool>);
    #[async_trait]
    impl ManagedControlAuthority for Authority {
        fn input_admission(
            &self,
            _: &ManagedDesktopPrincipal,
        ) -> Arc<dyn Fn() -> bool + Send + Sync> {
            let active = self.0.clone();
            Arc::new(move || active.load(Ordering::SeqCst))
        }
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
            if self.0.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(refused("managed_desktop_forbidden"))
            }
        }
    }
    struct WireFixture {
        domain: super::super::tests::Fixture,
        row: ManagedDesktop,
        server: tokio::task::JoinHandle<()>,
        pause_frame: Arc<AtomicBool>,
        frame_started: Arc<tokio::sync::Notify>,
        frame_continue: Arc<tokio::sync::Notify>,
        input_count: Arc<AtomicU64>,
        pause_input: Arc<AtomicBool>,
    }
    impl Drop for WireFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }
    async fn wire_fixture() -> WireFixture {
        use base64::Engine as _;
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let domain = super::super::tests::Fixture::new();
        domain.prepare().await;
        let row = domain.smoke("control").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pause_frame = Arc::new(AtomicBool::new(false));
        let frame_started = Arc::new(tokio::sync::Notify::new());
        let frame_continue = Arc::new(tokio::sync::Notify::new());
        let input_count = Arc::new(AtomicU64::new(0));
        let pause_input = Arc::new(AtomicBool::new(false));
        let block_input = pause_input.clone();
        let (pause, started, resume, inputs) = (
            pause_frame.clone(),
            frame_started.clone(),
            frame_continue.clone(),
            input_count.clone(),
        );
        let server = tokio::spawn(async move {
            let mut ws = crate::cua_sandbox::remote_client::accept_test_client(&listener).await;
            let image = xcap::image::RgbaImage::new(20, 20);
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, xcap::image::ImageFormat::Png)
                .unwrap();
            let image_data = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                let response = if command["command"] == "screenshot" {
                    if pause.load(Ordering::SeqCst) {
                        started.notify_one();
                        resume.notified().await;
                    }
                    serde_json::json!({"status":"success","image_data":image_data})
                } else {
                    inputs.fetch_add(1, Ordering::SeqCst);
                    if block_input.load(Ordering::SeqCst) {
                        started.notify_one();
                        resume.notified().await;
                    }
                    serde_json::json!({"status":"success"})
                };
                if ws
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = CuaRemoteClient::connect(
            "127.0.0.1",
            port,
            crate::cua_sandbox::remote_client::TEST_AUTH_TOKEN,
        )
        .await
        .unwrap();
        domain
            .service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        WireFixture {
            domain,
            row,
            server,
            pause_frame,
            frame_started,
            frame_continue,
            input_count,
            pause_input,
        }
    }

    #[test]
    fn legacy_partial_and_unknown_control_evidence_cannot_qualify() {
        let mut receipt = ControlQualificationReceipt {
            binding_digest: "binding".into(),
            template: TemplateIdentity {
                template_id: "template".into(),
                build_id: "build".into(),
                image_digest: "digest".into(),
                recipe_revision: "6".into(),
                protocol: "computer-server".into(),
            },
            smoke_desktop_id: "desktop".into(),
            smoke_desktop_generation: 1,
            observed_at: 1,
            protocol_revision: 1,
            evidence_version: 2,
            assertions: ControlQualificationAssertions::default(),
        };
        assert!(!receipt.has_complete_evidence());
        let mut checks = serde_json::to_value(&receipt.assertions).unwrap();
        for value in checks.as_object_mut().unwrap().values_mut() {
            *value = serde_json::json!(true);
        }
        receipt.assertions = serde_json::from_value(checks).unwrap();
        assert!(receipt.has_complete_evidence());
        let complete = serde_json::to_value(&receipt).unwrap();
        for field in complete["assertions"].as_object().unwrap().keys() {
            let mut partial = complete.clone();
            partial["assertions"][field] = serde_json::json!(false);
            assert!(
                !serde_json::from_value::<ControlQualificationReceipt>(partial)
                    .unwrap()
                    .has_complete_evidence()
            );
        }
        let mut legacy = complete.clone();
        legacy.as_object_mut().unwrap().remove("assertions");
        legacy.as_object_mut().unwrap().remove("evidenceVersion");
        assert!(
            !serde_json::from_value::<ControlQualificationReceipt>(legacy)
                .unwrap()
                .has_complete_evidence()
        );
        receipt.evidence_version = 3;
        assert!(!receipt.has_complete_evidence());
        receipt.evidence_version = 2;
        receipt.protocol_revision = 2;
        assert!(!receipt.has_complete_evidence());
    }

    #[test]
    fn smoke_quarantine_diagnostics_classify_errors_without_logging_their_payloads() {
        use crate::automation::types::AutomationError;
        assert_eq!(
            smoke_driver_failure(&AutomationError::PermissionDenied {
                reason: "sandbox input fence expired".into()
            }),
            "send_fence_denied"
        );
        assert_eq!(
            smoke_driver_failure(&AutomationError::BackendError {
                message: "cua call timed out; connection discarded".into()
            }),
            "driver_call_timeout"
        );
        assert_eq!(
            smoke_driver_failure(&AutomationError::BackendError {
                message: "cua recv: https://private.invalid/?key=secret".into()
            }),
            "transport_receive_or_closed"
        );
        assert_eq!(
            smoke_driver_failure(&AutomationError::BackendError {
                message: "project secret contents".into()
            }),
            "driver_backend_error"
        );
        assert_eq!(
            smoke_driver_failure(&AutomationError::Internal {
                message: "private text".into()
            }),
            "driver_internal_error"
        );
    }

    #[test]
    fn control_smoke_never_counts_unrelated_failures_as_a_pass() {
        assert!(require_smoke_error::<()>(
            Err(refused("managed_desktop_control_stale_frame")),
            "managed_desktop_control_lease_expired"
        )
        .is_err());
        assert!(require_smoke_error(Ok(()), "managed_desktop_control_lease_expired").is_err());
    }

    #[tokio::test]
    async fn diagnostic_control_seams_require_native_permit_admin_and_smoke_row() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        assert!(ExplicitPaidSmokeAuthorization::from_operator_flag("confirmed").is_err());
        let permit =
            ExplicitPaidSmokeAuthorization::from_operator_flag("--authorize-paid-smoke").unwrap();
        let mut human = p.clone();
        human.authority = ManagedDesktopAuthority::Human;
        assert_eq!(
            service
                .control_frame_smoke(&human, &row.id, row.generation, &authority, &permit)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_admin_required"
        );
        service
            .transaction(|s, _| {
                s.desktops.get_mut(&row.id).unwrap().smoke = false;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            service
                .control_acquire_smoke(p, &row.id, row.generation, true, &authority, &permit)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_smoke_required"
        );
        assert_eq!(
            service
                .control_input_smoke(
                    p,
                    &row.id,
                    row.generation,
                    ManagedControlInput {
                        token: "token",
                        fence: 1,
                        frame_id: "frame",
                        point: Some(Point { x: 0, y: 0 }),
                        action: UiAction::Scroll {
                            opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 }
                        }
                    },
                    &authority,
                    &permit
                )
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_smoke_required"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn principal_revocation_rejects_input_before_original_lease_deadline() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        let deadline = smoke_live_lease_deadline(service, p, row, &lease)
            .await
            .unwrap();
        service.revoke_control_principal(&p.principal_id).await;
        assert_eq!(
            smoke_input(service, p, row, &lease, &frame, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_lease_expired"
        );
        require_smoke_before_deadline(deadline).unwrap();
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert_eq!(
            require_smoke_before_deadline(Instant::now() - Duration::from_millis(1))
                .unwrap_err()
                .code,
            "managed_desktop_control_smoke_lease_expiry_confounded"
        );
    }

    #[tokio::test]
    async fn renewal_preserves_frame_expiry_and_keeps_lease_valid_for_stale_frame_denial() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        let slot = service.control_slot(&row.id, row.generation).await;
        let frame_deadline = slot.lock().await.frames[&p.principal_id][0].deadline;
        let renewed = service
            .control_renew_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlLeaseRef {
                    token: &lease.token,
                    fence: lease.fence,
                },
                &authority,
                true,
            )
            .await
            .unwrap();
        {
            let mut control = slot.lock().await;
            assert_eq!(control.frames[&p.principal_id][0].deadline, frame_deadline);
            assert_eq!(renewed.token, lease.token);
            assert_eq!(renewed.fence, lease.fence);
            control
                .require_lease(p, &renewed.token, renewed.fence)
                .unwrap();
            // Simulate only the frame elapsing; the smoke uses a real 5.1s wait.
            control.frames.get_mut(&p.principal_id).unwrap()[0].deadline =
                Instant::now() - Duration::from_millis(1);
        }
        assert_eq!(
            smoke_input(service, p, row, &renewed, &frame, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_stale_frame"
        );
        slot.lock()
            .await
            .require_lease(p, &renewed.token, renewed.fence)
            .unwrap();
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert_eq!(FRAME_MS, 5_000);
        assert_eq!(LEASE_MS, 15_000);
    }

    #[tokio::test]
    async fn positive_smoke_recaptures_after_negative_checks_expire_the_prior_frame() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let previous = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        // Model time consumed by remote negative checks without sleeping the
        // test or changing the production five-second frame deadline.
        service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .frames
            .get_mut(&p.principal_id)
            .unwrap()[0]
            .deadline = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            smoke_input(service, p, row, &lease, &previous, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_stale_frame"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        let (renewed, fresh) = fresh_smoke_input(service, p, row, &lease, &authority)
            .await
            .unwrap();
        assert_ne!(fresh.frame_id, previous.frame_id);
        assert_eq!(renewed.token, lease.token);
        assert_eq!(renewed.fence, lease.fence);
        assert_eq!(f.input_count.load(Ordering::SeqCst), 2);
        assert_eq!(FRAME_MS, 5_000);
    }

    #[test]
    fn smoke_stage_error_labels_cannot_include_secrets_or_unbounded_provider_text() {
        assert_eq!(
            smoke_error_label("managed_desktop_control_stale_frame"),
            "managed_desktop_control_stale_frame"
        );
        for value in [
            "secret",
            "https://provider.invalid/?token=secret",
            "managed_desktop_error\nsecret",
        ] {
            assert_eq!(smoke_error_label(value), "unexpected_error_code");
        }
        assert_eq!(
            smoke_error_label(&format!("managed_desktop_{}", "x".repeat(128))),
            "unexpected_error_code"
        );
    }

    #[tokio::test]
    async fn native_smoke_authority_revokes_between_actual_compound_sends() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        authority.revoke_at.store(1, Ordering::SeqCst);
        assert_eq!(
            smoke_input(service, p, row, &lease, &frame, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_quarantined"
        );
        assert_eq!(authority.admitted.load(Ordering::SeqCst), 1);
        assert_eq!(authority.denied.load(Ordering::SeqCst), 1);
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        assert!(!authority.active.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn release_invalidates_live_frame_before_slow_takeover_and_rejects_replay() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let first = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let old = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        let slot = service.control_slot(&row.id, row.generation).await;
        let frame_deadline = slot.lock().await.frames[&p.principal_id][0].deadline;
        let lease_deadline = smoke_live_lease_deadline(service, p, row, &first)
            .await
            .unwrap();
        service
            .control_release(
                p,
                &row.id,
                row.generation,
                &first.token,
                first.fence,
                &authority,
            )
            .await
            .unwrap();
        {
            let control = slot.lock().await;
            assert!(Instant::now() < frame_deadline);
            assert!(control.frames.is_empty());
            assert!(control.lease.is_none());
            assert!(control.fence > first.fence);
        }
        assert_eq!(
            smoke_input(service, p, row, &first, &old, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_lease_expired"
        );
        require_smoke_before_deadline(lease_deadline).unwrap();
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        // Model remote takeover exceeding the original frame's lifetime using
        // real elapsed time, without changing clocks or production deadlines.
        tokio::time::sleep(Duration::from_millis(FRAME_MS as u64 + 100)).await;
        let mut other = p.clone();
        other.principal_id = "second".into();
        let next = service
            .control_acquire_inner(&other, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        assert!(next.fence > first.fence);
        assert_ne!(next.token, first.token);
        {
            let mut control = slot.lock().await;
            control
                .require_lease(&other, &next.token, next.fence)
                .unwrap();
            assert!(control
                .frames
                .values()
                .flatten()
                .all(|frame| frame.id != old.frame_id));
        }
        assert_eq!(
            smoke_input(service, p, row, &first, &old, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_lease_expired"
        );
        assert_eq!(
            smoke_input(service, &other, row, &next, &old, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_stale_frame"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        smoke_live_lease_deadline(service, &other, row, &next)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(&other, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        smoke_input(service, &other, row, &next, &frame, &authority)
            .await
            .unwrap();
        assert_eq!(f.input_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn native_smoke_authority_revalidates_current_scope_and_state() {
        let mut p = principal("owner-device");
        p.authority = ManagedDesktopAuthority::Administrator;
        let authority = NativeSmokeAuthority::new(&p);
        let admission = authority.input_admission(&p);
        assert!(admission());
        authority.active.store(false, Ordering::SeqCst);
        assert!(!admission());
        assert!(authority.revalidate(&p).await.is_err());
        authority.active.store(true, Ordering::SeqCst);
        p.host_id = "other".into();
        assert!(!authority.input_admission(&p)());
        assert!(authority.revalidate(&p).await.is_err());
    }

    #[tokio::test]
    async fn retained_checkpoint_requires_exact_handoff_source_generation_and_admin() {
        let f = wire_fixture().await;
        let service = &f.domain.service;
        let p = &f.domain.p;
        assert_eq!(
            service
                .capture_handoff_smoke(p, &f.row, "acceptance")
                .await
                .unwrap_err()
                .code,
            "managed_desktop_handoff_desktop_not_authorized"
        );
        service
            .transaction(|state, _| {
                state.desktops.get_mut(&f.row.id).unwrap().source_id =
                    Some("handoff:acceptance".into());
                Ok(())
            })
            .await
            .unwrap();
        let mut stale = f.row.clone();
        stale.generation += 1;
        assert!(service
            .capture_handoff_smoke(p, &stale, "acceptance")
            .await
            .is_err());
        let mut human = p.clone();
        human.authority = ManagedDesktopAuthority::Human;
        assert!(service
            .capture_handoff_smoke(&human, &f.row, "acceptance")
            .await
            .is_err());
        assert!(service
            .capture_handoff_smoke(p, &f.row, "different")
            .await
            .is_err());
        let frame = service
            .capture_handoff_smoke(p, &f.row, "acceptance")
            .await
            .unwrap();
        assert!(!frame.bytes.is_empty());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unqualified_gui_and_agent_bypass_are_refused_before_remote_input() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        assert!(
            !service
                .control_status(p, &row.id, row.generation)
                .await
                .unwrap()
                .qualified
        );
        assert_eq!(
            service
                .control_acquire(p, &row.id, row.generation, true, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_unqualified"
        );
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(service
            .control_acquire_inner(&agent, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert!(!service.list_configs(p).await.unwrap()[0].gui_qualified);
    }

    #[tokio::test]
    async fn human_input_requires_fresh_single_use_frame_and_excludes_second_controller() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let mut other = p.clone();
        other.principal_id = "second-human".into();
        assert_eq!(
            service
                .control_acquire_inner(&other, &row.id, row.generation, true, &authority, true)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_busy"
        );
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        let click = || UiAction::Click {
            button: None,
            count: None,
        };
        // The second capture has reached the Host while the first frame is
        // still displayed. Both proofs must survive until mutation/expiry.
        let later_frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: lease.fence,
                    frame_id: &frame.frame_id,
                    point: Some(Point { x: 20, y: 1 }),
                    action: click()
                },
                &authority,
                true
            )
            .await
            .is_err());
        service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: lease.fence,
                    frame_id: &frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: click(),
                },
                &authority,
                true,
            )
            .await
            .unwrap();
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: lease.fence,
                    frame_id: &frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: click()
                },
                &authority,
                true
            )
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: lease.fence,
                    frame_id: &later_frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: click()
                },
                &authority,
                true
            )
            .await
            .is_err());
        service
            .control_release(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &authority,
            )
            .await
            .unwrap();
        assert!(service
            .control_release(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &authority
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn input_observes_boundary_after_capture_and_blocks_unbound_generation() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        // An old frame/client cannot replace the live, generation-bound proof.
        // Removing it before input also proves we do not spend another remote
        // observation before the harmless screenshot: capture must still start.
        service
            .state
            .lock()
            .await
            .workload_boundaries
            .remove(&row.id);
        f.pause_frame.store(true, Ordering::SeqCst);
        let input = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            ManagedControlInput {
                token: &lease.token,
                fence: lease.fence,
                frame_id: &frame.frame_id,
                point: Some(Point { x: 1, y: 1 }),
                action: UiAction::Click {
                    button: None,
                    count: None,
                },
            },
            &authority,
            true,
        );
        let capture = async {
            let started = tokio::time::timeout(Duration::from_secs(1), f.frame_started.notified())
                .await
                .is_ok();
            f.frame_continue.notify_one();
            started
        };
        let (result, captured) = tokio::join!(input, capture);
        assert!(
            captured,
            "input must defer its remote boundary check until after capture"
        );
        assert_eq!(
            result.unwrap_err().code,
            "managed_desktop_boundary_generation_mismatch"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert!(service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .lease
            .is_none());
        assert_eq!(FRAME_MS, 5_000);
        assert_eq!(LEASE_MS, 15_000);
    }

    #[tokio::test]
    async fn capture_await_revalidates_auth_and_delete_without_delivering_input() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_frame.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            ManagedControlInput {
                token: &lease.token,
                fence: lease.fence,
                frame_id: &frame.frame_id,
                point: Some(Point { x: 1, y: 1 }),
                action: UiAction::Click {
                    button: None,
                    count: None,
                },
            },
            &authority,
            true,
        );
        let revoke = async {
            f.frame_started.notified().await;
            authority.0.store(false, Ordering::SeqCst);
            service.revoke_control_principal(&p.principal_id).await;
            service
                .mark_cleanup(&row.id, &refused("test_delete"))
                .await
                .unwrap();
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, revoke);
        assert!(result.is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert!(service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .lease
            .is_none());
    }

    #[tokio::test]
    async fn uncertain_input_quarantine_is_durable_and_status_poll_does_not_extend_idle() {
        let f = wire_fixture().await;
        let service = &f.domain.service;
        let row = &f.row;
        let p = &f.domain.p;
        let original = service
            .scoped(p, &row.id, row.generation)
            .await
            .unwrap()
            .last_activity_at;
        service
            .transaction(|s, _| {
                s.control_quarantines.insert(row.id.clone());
                Ok(())
            })
            .await
            .unwrap();
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        assert!(service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        service
            .control_status(p, &row.id, row.generation)
            .await
            .unwrap();
        assert_eq!(
            service
                .scoped(p, &row.id, row.generation)
                .await
                .unwrap()
                .last_activity_at,
            original
        );
    }
    fn principal(id: &str) -> ManagedDesktopPrincipal {
        ManagedDesktopPrincipal {
            owner_principal_id: "owner".into(),
            principal_id: id.into(),
            host_id: "host".into(),
            authority: ManagedDesktopAuthority::Human,
        }
    }
    #[tokio::test]
    async fn input_size_and_click_limits_apply_without_rpc_schema_validation() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        for action in [
            UiAction::Click {
                button: None,
                count: Some(0),
            },
            UiAction::Click {
                button: None,
                count: Some(4),
            },
            UiAction::PressKey {
                chord: crate::automation::types::KeyChord("a".repeat(257)),
            },
            UiAction::TypeText {
                text: "a".repeat(4097),
            },
            UiAction::Drag {
                to: Point { x: 2, y: 2 },
                opts: crate::automation::types::DragOpts {
                    duration_ms: Some(2001),
                    ..Default::default()
                },
            },
        ] {
            assert!(service
                .control_input_inner(
                    p,
                    &row.id,
                    row.generation,
                    ManagedControlInput {
                        token: &lease.token,
                        fence: lease.fence,
                        frame_id: &frame.frame_id,
                        point: Some(Point { x: 1, y: 1 }),
                        action
                    },
                    &authority,
                    true
                )
                .await
                .is_err());
        }
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn live_authority_revocation_preempts_compound_input_without_explicit_epoch_call() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            ManagedControlInput {
                token: &lease.token,
                fence: lease.fence,
                frame_id: &frame.frame_id,
                point: Some(Point { x: 1, y: 1 }),
                action: UiAction::Click {
                    button: Some(crate::automation::types::MouseButton::Middle),
                    count: Some(2),
                },
            },
            &authority,
            true,
        );
        let revoke = async {
            f.frame_started.notified().await;
            authority.0.store(false, Ordering::SeqCst);
            f.pause_input.store(false, Ordering::SeqCst);
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, revoke);
        assert!(result.is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancellation_after_send_keeps_quarantine_across_late_acknowledgement() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        {
            let action = service.control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: lease.fence,
                    frame_id: &frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: UiAction::Click {
                        button: None,
                        count: None,
                    },
                },
                &authority,
                true,
            );
            tokio::pin!(action);
            tokio::select! {
                _ = &mut action => panic!("input completed before cancellation"),
                _ = f.frame_started.notified() => {},
            }
        }
        f.frame_continue.notify_one();
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        assert!(service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn destroy_preempts_remaining_commands_of_a_compound_input() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            ManagedControlInput {
                token: &lease.token,
                fence: lease.fence,
                frame_id: &frame.frame_id,
                point: Some(Point { x: 1, y: 1 }),
                action: UiAction::Click {
                    button: Some(crate::automation::types::MouseButton::Middle),
                    count: Some(2),
                },
            },
            &authority,
            true,
        );
        let destroy = async {
            f.frame_started.notified().await;
            service
                .mark_cleanup(&row.id, &refused("test_delete"))
                .await
                .unwrap();
            f.pause_input.store(false, Ordering::SeqCst);
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, destroy);
        assert!(result.is_err());
        // Only pointer movement was sent; no subsequent mouse-down or up.
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
    }
    #[test]
    fn lease_is_principal_and_fence_bound_and_expiry_never_resumes_agent() {
        let mut c = ManagedControl::new("desktop", 1);
        let p = principal("first");
        let first = c.issue(&p, 1_000, 60_000);
        assert_eq!(first.expires_at, 16_000);
        assert!(c
            .require_lease(&principal("second"), &first.token, first.fence)
            .is_err());
        assert!(c.require_lease(&p, &first.token, first.fence + 1).is_err());
        c.lease.as_mut().unwrap().deadline = Instant::now();
        assert!(c.require_lease(&p, &first.token, first.fence).is_err());
        let next = c.issue(&p, 2_000, 60_000);
        assert!(next.fence > first.fence);
        assert!(c.require_lease(&p, &first.token, first.fence).is_err());
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(c.require_lease(&agent, &next.token, next.fence).is_err());
    }
    #[test]
    fn lease_is_capped_at_resource_deadline_and_invalidation_drops_frames() {
        let mut c = ManagedControl::new("desktop", 1);
        let p = principal("human");
        let lease = c.issue(&p, 1_000, 2_000);
        assert_eq!(lease.expires_at, 2_000);
        c.frames.insert(
            p.principal_id.clone(),
            vec![cognia_remote_desktop::control::Frame {
                id: "frame".into(),
                fence: lease.fence,
                deadline: Instant::now() + Duration::from_secs(5),
                width: 100,
                height: 80,
            }],
        );
        c.invalidate();
        assert!(c.frames.is_empty());
        assert!(c.lease.is_none());
    }
    /// Passes the first `allow` revalidations, then refuses.
    struct FailAfter {
        calls: std::sync::atomic::AtomicUsize,
        allow: usize,
    }
    #[async_trait]
    impl ManagedControlAuthority for FailAfter {
        fn input_admission(
            &self,
            _: &ManagedDesktopPrincipal,
        ) -> Arc<dyn Fn() -> bool + Send + Sync> {
            Arc::new(|| true)
        }
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
            if self.calls.fetch_add(1, Ordering::SeqCst) < self.allow {
                Ok(())
            } else {
                Err(refused("managed_desktop_forbidden"))
            }
        }
    }

    #[tokio::test]
    async fn an_observer_losing_access_mid_stream_never_cancels_the_controllers_lease() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let controller_frame = service
            .capture_frame_inner(p, &row.id, row.generation, &authority, true, false)
            .await
            .unwrap();
        // How many revalidations the pre-capture check performs.
        let counting = FailAfter {
            calls: Default::default(),
            allow: usize::MAX,
        };
        service
            .control_check(p, &row.id, row.generation, &counting, true)
            .await
            .unwrap();
        let before_capture = counting.calls.load(Ordering::SeqCst);
        let mut observer = p.clone();
        observer.principal_id = "observer".into();
        let failing = FailAfter {
            calls: Default::default(),
            allow: before_capture,
        };
        assert_eq!(
            service
                .capture_frame_inner(&observer, &row.id, row.generation, &failing, true, true)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_forbidden"
        );
        // The controller's lease and its earlier proof survive.
        service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: controller_frame.fence,
                    frame_id: &controller_frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: UiAction::Scroll {
                        opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 },
                    },
                },
                &authority,
                true,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_stream_capture_yields_to_input_holding_the_desktop() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let slot = service.control_slot(&row.id, row.generation).await;
        let held = slot.lock().await;
        // The fixture's desktop is a smoke desktop (no production control
        // qualification), so drive the shared capture path directly.
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            service.capture_frame_inner(p, &row.id, row.generation, &authority, true, true),
        )
        .await
        .expect("a stream capture must not wait behind input");
        assert_eq!(result.unwrap_err().code, "managed_desktop_frame_busy");
        drop(held);
        service
            .capture_frame_inner(p, &row.id, row.generation, &authority, true, true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn native_frames_capture_preserves_idle_and_lease_and_registers_controller_proof() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let before = service
            .scoped(p, &row.id, row.generation)
            .await
            .unwrap()
            .last_activity_at;
        let mut observer = p.clone();
        observer.principal_id = "another-observer".into();
        let frame = service
            .capture_frame_inner(&observer, &row.id, row.generation, &authority, true, true)
            .await
            .unwrap();
        assert_eq!(
            service
                .scoped(p, &row.id, row.generation)
                .await
                .unwrap()
                .last_activity_at,
            before
        );
        let slot = service.control_slot(&row.id, row.generation).await;
        let control = slot.lock().await;
        assert_eq!(control.core.status().lease.unwrap().dto.token, lease.token);
        assert_eq!(
            control.core.status().lease.unwrap().dto.expires_at,
            lease.expires_at
        );
        assert!(control
            .core
            .frame(&p.principal_id, &frame.frame_id, frame.fence)
            .is_ok());
        assert!(control
            .core
            .frame(&observer.principal_id, &frame.frame_id, frame.fence)
            .is_err());
        drop(control);
        // The production input RPC owner accepts the streamed proof unchanged.
        service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                ManagedControlInput {
                    token: &lease.token,
                    fence: frame.fence,
                    frame_id: &frame.frame_id,
                    point: Some(Point { x: 1, y: 1 }),
                    action: UiAction::Scroll {
                        opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 },
                    },
                },
                &authority,
                true
            )
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn unsent_mouse_down_does_not_create_a_held_button() {
        let raw = CuaRemoteClient::from_handler(Arc::new(|_, _| Box::pin(async {
            panic!("a refused send must never reach the driver")
        })));
        let client = raw.fenced_preemptible(Arc::new(|| false));
        let mut desktop = RemoteDesktop::for_target("managed-test".into(), Default::default());
        let result = agent_deliver(&mut desktop, &client, Action::MouseButton {
            button: crate::automation::types::MouseButton::Left,
            transition: crate::automation::types::ButtonTransition::Down,
        }, Arc::new(|| false)).await;
        assert!(matches!(result, Err(AutomationError::PreemptedBeforeSend)));
        assert!(desktop.held_mouse_buttons.is_empty());
    }

    #[tokio::test]
    async fn generic_agent_frames_keep_the_manual_gui_gate() {
        let (f, row, _) = super::super::delegation::tests::fixture().await;
        use base64::Engine;
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let image = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let client = CuaRemoteClient::from_handler(Arc::new(move |_, _| {
            let image = image.clone();
            Box::pin(async move { Ok(serde_json::json!({"image_data":image})) })
        }));
        f.service.control_slot(&row.id, 1).await.lock().await.client = Some(client);
        let p = ManagedDesktopPrincipal {
            authority: ManagedDesktopAuthority::Agent,
            principal_id: "worker:paired".into(),
            ..f.p.clone()
        };
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        f.service.control_frame(&p, &row.id, 1, &authority).await.unwrap();
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement.manual_gui = false;
        f.service.save_registry(registry).await.unwrap();
        assert_eq!(f.service.control_frame(&p, &row.id, 1, &authority).await.unwrap_err().code,
            "managed_desktop_control_unqualified");
    }
}
