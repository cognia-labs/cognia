//! Shared diagnostic of the real Host consent/admin-lease/input pipeline.
//! The stopped-Host operator supplies an isolated identity; the in-app path
//! enrolls and always revokes/forgets a temporary device in the real store.
use super::*;
use cognia_companion::security_store::{install_security_store, SecurityStore};
use cognia_companion::{admin_lease, host_consent};
use std::sync::atomic::{AtomicU64, Ordering};

const OPERATION: &str = "managed_desktop_control_input";
const FAILED: &str = "managed_desktop_authority_smoke_failed";

// A cancelled spawn_blocking enrollment can finish after its async caller is
// dropped. Reconciliation must wait for that exact enrollment before clearing
// the durable device pointer; otherwise it could forget an as-yet absent row.
static ENROLLMENTS: once_cell::sync::Lazy<
    parking_lot::Mutex<std::collections::BTreeMap<String, Arc<tokio::sync::Semaphore>>>,
> = once_cell::sync::Lazy::new(Default::default);
pub(super) struct EnrollmentScope {
    device: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for EnrollmentScope {
    fn drop(&mut self) {
        ENROLLMENTS.lock().remove(&self.device);
    }
}
pub(super) async fn wait_for_enrollment(device: &str) -> Result<()> {
    let gate = ENROLLMENTS.lock().get(device).cloned();
    if let Some(gate) = gate {
        let _permit = gate.acquire_owned().await.map_err(|_| refused(FAILED))?;
    }
    Ok(())
}
struct IdentityScope {
    device: String,
    tenant: String,
    store: Arc<SecurityStore>,
    isolated: bool,
    armed: bool,
}
pub(super) fn clean_device(store: &SecurityStore, tenant: &str, device: &str) -> Result<()> {
    admin_lease::revoke_device(device);
    host_consent::forget_device(device);
    let now = chrono::Utc::now().timestamp();
    if store.device_state(tenant, device).map_err(|_| refused(FAILED))?.is_none() {
        return Ok(());
    }
    // Revocation is idempotent here: the diagnostic's final assertion may
    // already have revoked it. Forget still requires a revoked device.
    let _ = store.revoke_device(tenant, "local-trust-root", device, true, now);
    match store.forget_revoked_device(tenant, "local-trust-root", device, now) {
        Ok(()) => Ok(()),
        Err(_) if store.device_state(tenant, device).is_ok_and(|state| state.is_none()) => Ok(()),
        Err(_) => Err(refused(FAILED)),
    }
}
impl IdentityScope {
    async fn finish(&mut self) -> Result<()> {
        let store = self.store.clone();
        let tenant = self.tenant.clone();
        let device = self.device.clone();
        tokio::task::spawn_blocking(move || clean_device(&store, &tenant, &device))
            .await.map_err(|_| refused(FAILED))??;
        self.armed = false;
        if self.isolated {
            host_identity::unbind_local_account();
            install_security_store(None);
        }
        Ok(())
    }
}
impl Drop for IdentityScope {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let store = self.store.clone();
        let tenant = self.tenant.clone();
        let device = self.device.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn_blocking(move || {
                let _ = clean_device(&store, &tenant, &device);
            });
        } else {
            let _ = clean_device(&store, &tenant, &device);
        }
        if self.isolated {
            host_identity::unbind_local_account();
            install_security_store(None);
        }
    }
}
pub(super) fn enroll(store: &SecurityStore, tenant: &str, device: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let challenge = store.issue_challenge(tenant, now, 600).map_err(|_| refused(FAILED))?;
    let invitation = store.create_owner_invitation(tenant, "local-trust-root", now, 600)
        .map_err(|_| refused(FAILED))?;
    store.register_owner_device(
        tenant,
        &invitation,
        &challenge.id,
        &challenge.nonce,
        device,
        "Qualification device",
        "-----BEGIN PUBLIC KEY-----\nnative-smoke\n-----END PUBLIC KEY-----",
        &format!("native-{device}"),
        now,
    ).map_err(|_| refused(FAILED))
}
fn check(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(refused(FAILED))
    }
}
fn issued_lease(device: &str, tenant: &str, ttl: u64) -> Result<String> {
    let operations = vec![OPERATION.to_owned()];
    let request = host_consent::request(device, Some(tenant), operations.clone());
    host_consent::resolve(&request.id, true, host_consent::Approver::Host)
        .map_err(|_| refused(FAILED))?;
    check(host_consent::take_approved(device, &operations))?;
    let store = security_store().ok_or_else(|| refused(FAILED))?;
    let owner = store
        .is_owner_device(tenant, device)
        .map_err(|_| refused(FAILED))?;
    admin_lease::issue(device, operations, Some(ttl), owner)
        .map(|lease| lease.token)
        .map_err(|_| refused(FAILED))
}
fn admin_check(device: &str, token: &str) -> AdminAuthorityCheck {
    let device = device.to_owned();
    let token = token.to_owned();
    Arc::new(move || {
        admin_lease::validate(&device, OPERATION, Some(&token))
            .map_err(|_| refused("managed_desktop_control_admin_lease_expired"))
    })
}
fn runtime(events: HostEventSink) -> ManagedControlRuntime {
    let gate = cognia_automation::automation::permission::PermissionGate::new(Default::default());
    gate.update(|settings| {
        settings.enabled = true;
        settings.consent_timeout_ms =
            cognia_automation::automation::permission::MIN_CONSENT_TIMEOUT_MS;
        settings.per_surface.computer_use.tier =
            cognia_automation::automation::permission::Tier::PerCall;
    });
    ManagedControlRuntime {
        enforcement: Enforcement {
            gate,
            audit: Default::default(),
            consent: Default::default(),
            policy: Default::default(),
            consent_event_sink: None,
        },
        events,
        refresh_persisted: false,
    }
}
fn approve_event(_: &str, value: Value) {
    if let Some(id) = value["id"].as_str() {
        let _ = host_consent::resolve(id, true, host_consent::Approver::Host);
    }
}
fn input(
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    frame: &ManagedControlFrame,
    compound: bool,
) -> InputArgs {
    InputArgs {
        desktop_id: desktop.id.clone(),
        generation: desktop.generation,
        token: lease.token.clone(),
        fence: lease.fence,
        frame_id: frame.frame_id.clone(),
        point: compound.then_some(Point { x: 20, y: 20 }),
        action: if compound {
            UiAction::Scroll {
                opts: cognia_automation::automation::types::ScrollOpts { dx: 0, dy: 1 },
            }
        } else {
            UiAction::TypeText {
                text: String::from("p4-authority"),
            }
        },
    }
}
// Each independent case receives its own fresh frame budget. Do not silently
// reacquire expired authority: renewal must still pass the live Host gate.
async fn renewed_frame(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    authority: &HostAuthority<'_>,
    permit: &ExplicitPaidSmokeAuthorization,
) -> Result<(ManagedControlLease, ManagedControlFrame)> {
    let lease = service
        .control_renew_smoke(p, &desktop.id, desktop.generation, cognia_automation::cua_sandbox::managed::ManagedControlLeaseRef { token: &lease.token, fence: lease.fence }, authority, permit)
        .await?;
    let frame = service
        .control_frame_smoke(p, &desktop.id, desktop.generation, authority, permit)
        .await?;
    Ok((lease, frame))
}
fn diagnostic_error_code(code: &str) -> &str {
    if code.starts_with("managed_desktop_")
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        code
    } else {
        "unexpected_error_code"
    }
}

fn observer(count: &Arc<AtomicU64>) -> Arc<dyn Fn(bool) + Send + Sync> {
    let count = count.clone();
    Arc::new(move |admitted| {
        if admitted {
            count.fetch_add(1, Ordering::SeqCst);
        }
    })
}

/// Fresh private operator processes only. The directory is part of the existing
/// SmokeHost; this routine never opens another Host's account or security data.
pub async fn run(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    _directory: &Path,
    config_id: &str,
    permit: ExplicitPaidSmokeAuthorization,
) -> Result<HostAuthoritySmokeEvidence> {
    p.require_admin()?;
    // Installing this fixture in a live Host would replace real authority state.
    check(security_store().is_none() && host_identity::current().is_err())?;
    let store = SecurityStore::in_memory().map_err(|_| refused(FAILED))?;
    let device = format!("native-authority-{}", uuid::Uuid::new_v4());
    install_security_store(Some(store.clone()));
    let binding = match host_identity::bind_local_account_from_operator(&p.owner_principal_id) {
        Ok(binding) => binding,
        Err(_) => {
            install_security_store(None);
            return Err(refused(FAILED));
        }
    };
    let tenant = binding.remote_tenant_id;
    let mut identity = IdentityScope {
        device: device.clone(),
        tenant: tenant.clone(),
        store: store.clone(),
        isolated: true,
        armed: true,
    };
    enroll(&store, &tenant, &device)?;
    let outcome = run_with_device(host, p, config_id, permit, store, tenant, device).await;
    identity.finish().await?;
    outcome
}

pub(super) async fn enrollment_scope(device: &str) -> Result<EnrollmentScope> {
    let gate = Arc::new(tokio::sync::Semaphore::new(1));
    let enrollment = EnrollmentScope {
        device: device.into(),
        _permit: gate.clone().acquire_owned().await.map_err(|_| refused(FAILED))?,
    };
    ENROLLMENTS.lock().insert(device.into(), gate);
    Ok(enrollment)
}

/// The running Host keeps its real security store and local account binding.
/// The durable device pointer is written before enrollment, so even process
/// death before the guard can run is repaired by the Host reconciler.
pub async fn run_installed(
    host: &dyn ManagedDesktopSmokeHost,
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    run_id: &str,
    permit: ExplicitPaidSmokeAuthorization,
) -> Result<HostAuthoritySmokeEvidence> {
    p.require_admin()?;
    let store = security_store().ok_or_else(|| refused(FAILED))?;
    let tenant = host_identity::current().map_err(|_| refused(FAILED))?.remote_tenant_id;
    check(host_identity::namespace_for_tenant(&tenant).as_deref() == Some(p.owner_principal_id.as_str()))?;
    let device = format!("qualification-{}", uuid::Uuid::new_v4());
    let identity = IdentityScope {
        device: device.clone(),
        tenant: tenant.clone(),
        store: store.clone(),
        isolated: false,
        armed: true,
    };
    let enrollment_store = store.clone();
    let enrollment_tenant = tenant.clone();
    let enrollment_device = device.clone();
    // Register before publishing the durable pointer. Reconciliation must wait
    // for this enrollment even if cancellation finishes the run at that await.
    let enrollment = enrollment_scope(&device).await?;
    service.qualification_device(p, run_id, Some((tenant.clone(), device.clone()))).await?;
    let mut identity = tokio::task::spawn_blocking(move || {
        let _enrollment = enrollment;
        enroll(&enrollment_store, &enrollment_tenant, &enrollment_device)?;
        Ok::<_, ManagedDesktopError>(identity)
    }).await.map_err(|_| refused(FAILED))??;
    let outcome = run_with_device(host, p, config_id, permit, store, tenant, device).await;
    identity.finish().await?;
    service.qualification_device(p, run_id, None).await?;
    outcome
}

async fn run_with_device(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    permit: ExplicitPaidSmokeAuthorization,
    store: Arc<SecurityStore>,
    tenant: String,
    device: String,
) -> Result<HostAuthoritySmokeEvidence> {
    let caller = Caller {
        device_id: &device,
        tenant_id: Some(&tenant),
        scope: Some("device"),
        local: false,
    };
    let paired = principal(&caller, &p.host_id)?;
    check(paired.owner_principal_id == p.owner_principal_id && paired.require_admin().is_ok())?;
    let mut evidence = HostAuthoritySmokeEvidence {
        evidence_version: 1,
        paired_owner_resolved: true,
        observed_at: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };

    let operations = vec![OPERATION.to_owned()];
    let request = host_consent::request(&device, Some(&tenant), operations.clone());
    evidence.self_approval_rejected =
        host_consent::resolve(&request.id, true, host_consent::Approver::Device(&device)).is_err();
    host_consent::resolve(&request.id, true, host_consent::Approver::Host)
        .map_err(|_| refused(FAILED))?;
    evidence.consent_wrong_device_rejected =
        !host_consent::take_approved("wrong-device", &operations);
    evidence.consent_wrong_operation_rejected =
        !host_consent::take_approved(&device, &["wrong-operation".into()]);
    check(host_consent::take_approved(&device, &operations))?;
    evidence.consent_one_shot = !host_consent::take_approved(&device, &operations);
    let short = issued_lease(&device, &tenant, 1)?;
    evidence.admin_wrong_device_rejected =
        admin_lease::validate("wrong-device", OPERATION, Some(&short)).is_err();
    evidence.admin_wrong_operation_rejected =
        admin_lease::validate(&device, "wrong-operation", Some(&short)).is_err();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    evidence.admin_expiry_rejected =
        admin_lease::validate(&device, OPERATION, Some(&short)).is_err();
    let revoked = issued_lease(&device, &tenant, 60)?;
    admin_lease::revoke_device(&device);
    evidence.admin_revocation_rejected =
        admin_lease::validate(&device, OPERATION, Some(&revoked)).is_err();

    check(
        evidence.self_approval_rejected
            && evidence.consent_wrong_device_rejected
            && evidence.consent_wrong_operation_rejected
            && evidence.consent_one_shot
            && evidence.admin_wrong_device_rejected
            && evidence.admin_wrong_operation_rejected
            && evidence.admin_expiry_rejected
            && evidence.admin_revocation_rejected,
    )?;

    let service = host.open(host.provider())?;
    let operation = uuid::Uuid::new_v4().to_string();
    let source = format!("authority:{operation}");
    let diagnostic_started = tokio::time::Instant::now();
    let mut stage = "quote_and_authorization";
    let result: Result<()> = async {
        let quote = service.quote(p, config_id, 120).await?;
        host.approve_quote(&quote, AuthorizationPurpose::Smoke)
            .await?;
        let authorization = service
            .authorize(
                p,
                config_id,
                &quote.id,
                AuthorizationPurpose::Smoke,
                Some(source.clone()),
            )
            .await?;
        stage = "invalidate_previous_qualification";
        service
            .invalidate_native_qualification(p, config_id, NativeQualificationKind::Authority)
            .await?;
        stage = "create_and_readiness";
        let mut desktop = service
            .create_smoke(
                p,
                CreateManagedDesktop {
                    provider_config_id: config_id.into(),
                    quote_id: quote.id,
                    authorization_id: authorization.id,
                    idempotency_key: operation,
                },
            )
            .await?;
        evidence.smoke_desktop_id = desktop.id.clone();
        evidence.smoke_desktop_generation = desktop.generation;
        while desktop.state == ManagedDesktopState::Creating {
            check(chrono::Utc::now().timestamp_millis() < desktop.deadline_at)?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            desktop = service.connect(p, &desktop.id, desktop.generation).await?;
        }
        check(desktop.state == ManagedDesktopState::Running)?;
        let token = issued_lease(&device, &tenant, 120)?;
        let positive = Arc::new(AtomicU64::new(0));
        let mut authority = HostAuthority {
            caller,
            host_id: &p.host_id,
            admin_check: Some(admin_check(&device, &token)),
            input_policy: None,
            admission_observer: Some(observer(&positive)),
        };
        stage = "acquire_and_positive_input";
        let lease = service
            .control_acquire_smoke(
                &paired,
                &desktop.id,
                desktop.generation,
                true,
                &authority,
                &permit,
            )
            .await?;
        let frame = service
            .control_frame_smoke(
                &paired,
                &desktop.id,
                desktop.generation,
                &authority,
                &permit,
            )
            .await?;
        execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(approve_event)),
            Some(&permit),
        )
        .await?;
        evidence.positive_input_acknowledged = true;
        evidence.positive_admitted_commands = positive.load(Ordering::SeqCst);

        let denied = Arc::new(AtomicU64::new(0));
        authority.admission_observer = Some(observer(&denied));
        stage = "host_denial";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let denial_observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rejected = denial_observed.clone();
        let denied_result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |_, value| {
                if let Some(id) = value["id"].as_str() {
                    rejected.store(
                        host_consent::resolve(id, false, host_consent::Approver::Host).is_ok(),
                        Ordering::SeqCst,
                    );
                }
            })),
            Some(&permit),
        )
        .await;
        evidence.host_denial_not_delivered = denial_observed.load(Ordering::SeqCst)
            && denied_result
                .is_err_and(|error| error.code == "managed_desktop_control_consent_denied")
            && denied.load(Ordering::SeqCst) == 0;

        stage = "real_consent_timeout";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let prompt_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = prompt_seen.clone();
        let started = tokio::time::Instant::now();
        let timed_out = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |_, _| {
                seen.store(true, Ordering::SeqCst);
            })),
            Some(&permit),
        )
        .await;
        evidence.consent_timeout_ms =
            cognia_automation::automation::permission::MIN_CONSENT_TIMEOUT_MS;
        evidence.consent_timeout_not_delivered = prompt_seen.load(Ordering::SeqCst)
            && started.elapsed() >= Duration::from_millis(evidence.consent_timeout_ms)
            && timed_out.is_err_and(|error| error.code == "managed_desktop_control_consent_denied")
            && denied.load(Ordering::SeqCst) == 0;
        host_consent::forget_device(&device);

        stage = "policy_disabled_during_consent";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let mut disabled_runtime = runtime(Arc::new(|_, _| {}));
        let gate = disabled_runtime.enforcement.gate.clone();
        let policy_prompt_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = policy_prompt_seen.clone();
        disabled_runtime.events = Arc::new(move |event, value| {
            seen.store(true, Ordering::SeqCst);
            gate.update(|settings| settings.enabled = false);
            approve_event(event, value);
        });
        let policy_denied = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            disabled_runtime,
            Some(&permit),
        )
        .await;
        evidence.policy_disabled_while_waiting_not_delivered = policy_prompt_seen
            .load(Ordering::SeqCst)
            && policy_denied
                .is_err_and(|error| error.code == "managed_desktop_control_policy_denied")
            && denied.load(Ordering::SeqCst) == 0;

        stage = "cancelled_consent_and_late_approval";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let pending = Arc::new(parking_lot::Mutex::new(None::<Value>));
        let captured = pending.clone();
        let outcome = tokio::time::timeout(
            Duration::from_millis(250),
            execute_input_inner(
                &service,
                &paired,
                &authority,
                input(&desktop, &lease, &frame, false),
                runtime(Arc::new(move |_, value| {
                    *captured.lock() = Some(value);
                })),
                Some(&permit),
            ),
        )
        .await;
        check(outcome.is_err())?;
        let value = pending.lock().clone().ok_or_else(|| refused(FAILED))?;
        evidence.cancelled_consent_not_delivered = denied.load(Ordering::SeqCst) == 0;
        host_consent::resolve(
            value["id"].as_str().ok_or_else(|| refused(FAILED))?,
            true,
            host_consent::Approver::Host,
        )
        .map_err(|_| refused(FAILED))?;
        // The cancelled bridge is dropped. Its unique consent ID cannot approve
        // the next input, even when desktop/generation/fence are identical.
        let next_pending = Arc::new(parking_lot::Mutex::new(None::<Value>));
        let captured = next_pending.clone();
        let next = tokio::time::timeout(
            Duration::from_millis(250),
            execute_input_inner(
                &service,
                &paired,
                &authority,
                input(&desktop, &lease, &frame, false),
                runtime(Arc::new(move |_, value| {
                    *captured.lock() = Some(value);
                })),
                Some(&permit),
            ),
        )
        .await;
        evidence.late_approval_not_replayed = next.is_err()
            && next_pending
                .lock()
                .as_ref()
                .is_some_and(|next| next["id"] != value["id"])
            && denied.load(Ordering::SeqCst) == 0;
        host_consent::forget_device(&device);

        stage = "admin_revoked_during_consent";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let revoke = device.clone();
        let denied_result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, false),
            runtime(Arc::new(move |event, value| {
                admin_lease::revoke_device(&revoke);
                approve_event(event, value);
            })),
            Some(&permit),
        )
        .await;
        evidence.admin_revoked_after_consent_not_delivered = denied_result
            .is_err_and(|error| error.code == "managed_desktop_control_admin_lease_expired")
            && denied.load(Ordering::SeqCst) == 0;
        evidence.denied_admitted_commands = denied.load(Ordering::SeqCst);

        let token = issued_lease(&device, &tenant, 120)?;
        authority.admin_check = Some(admin_check(&device, &token));
        let compound = Arc::new(AtomicU64::new(0));
        let counted = compound.clone();
        let compound_denied = Arc::new(AtomicU64::new(0));
        let denied_command = compound_denied.clone();
        let revoke = device.clone();
        authority.admission_observer = Some(Arc::new(move |admitted| {
            if admitted && counted.fetch_add(1, Ordering::SeqCst) == 0 {
                admin_lease::revoke_device(&revoke);
            }
            if !admitted {
                denied_command.fetch_add(1, Ordering::SeqCst);
            }
        }));
        stage = "compound_admission_revocation";
        let (lease, frame) =
            renewed_frame(&service, &paired, &desktop, &lease, &authority, &permit).await?;
        let compound_started = tokio::time::Instant::now();
        let compound_started_at = chrono::Utc::now().timestamp_millis();
        let frame_budget_ms = frame.expires_at.saturating_sub(compound_started_at);
        let lease_budget_ms = lease.expires_at.saturating_sub(compound_started_at);
        let desktop_budget_ms = desktop.deadline_at.saturating_sub(compound_started_at);
        let result = execute_input_inner(
            &service,
            &paired,
            &authority,
            input(&desktop, &lease, &frame, true),
            runtime(Arc::new(approve_event)),
            Some(&permit),
        )
        .await;
        evidence.compound_admitted_commands = compound.load(Ordering::SeqCst);
        evidence.compound_denied_commands = compound_denied.load(Ordering::SeqCst);
        let compound_result_code = result.as_ref().err()
            .map(|error| diagnostic_error_code(&error.code)).unwrap_or("success");
        eprintln!("Native authority compound result: code={compound_result_code} elapsed_ms={} frame_budget_ms={frame_budget_ms} lease_budget_ms={lease_budget_ms} desktop_budget_ms={desktop_budget_ms} admitted_commands={} denied_commands={}",
            compound_started.elapsed().as_millis(), evidence.compound_admitted_commands,
            evidence.compound_denied_commands);
        evidence.compound_revocation_second_send_blocked = result
            .is_err_and(|error| error.code == "managed_desktop_control_quarantined")
            && evidence.compound_admitted_commands == 1
            && evidence.compound_denied_commands == 1;

        let token = issued_lease(&device, &tenant, 120)?;
        authority.admin_check = Some(admin_check(&device, &token));
        authority.admission_observer = None;
        stage = "paired_device_revocation";
        store
            .revoke_device(
                &tenant,
                "native-operator",
                &device,
                true,
                chrono::Utc::now().timestamp(),
            )
            .map_err(|_| refused(FAILED))?;
        evidence.paired_device_revocation_rejected = authority
            .revalidate(&paired)
            .await
            .is_err_and(|error| error.code == "managed_desktop_forbidden")
            && !(authority.input_admission(&paired))();
        stage = "complete_authority_evidence";
        if !evidence.has_complete_evidence() {
            eprintln!("Native authority diagnostic assertions: {evidence:?}");
        }
        check(evidence.has_complete_evidence())
    }
    .await;
    if let Err(error) = &result {
        eprintln!(
            "Native authority smoke failed: stage={stage} code={} elapsed_ms={}",
            diagnostic_error_code(&error.code),
            diagnostic_started.elapsed().as_millis()
        );
    }
    // The exclusively opened private journal cannot admit another operator.
    // Include a row persisted before create returned an error, not only its ID.
    let cleanup: Result<()> = async {
        service.cleanup_diagnostic_source(p,&source).await?;
        Ok(())
    }
    .await;
    if let Err(error) = &cleanup {
        eprintln!(
            "Native authority smoke failed: stage=cleanup code={} elapsed_ms={}",
            diagnostic_error_code(&error.code),
            diagnostic_started.elapsed().as_millis()
        );
    }
    result?;
    cleanup?;
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "current_thread")]
    async fn installed_authority_guard_revokes_and_forgets_without_replacing_store_or_binding() {
        let _scope = super::super::tests::TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("qualification-owner", "digest").unwrap();
        let tenant = binding.remote_tenant_id.clone();
        enroll(&store, &tenant, "existing-owner").unwrap();
        let before = store.list_devices(&tenant).unwrap().into_iter()
            .map(|d| (d.device_id, d.status)).collect::<Vec<_>>();
        for exit in ["normal", "cancelled", "panic"] {
            let device = format!("temporary-{exit}");
            enroll(&store, &tenant, &device).unwrap();
            assert!(store.is_owner_device(&tenant, &device).unwrap());
            let guard = IdentityScope {
                device: device.clone(),
                tenant: tenant.clone(),
                store: store.clone(),
                isolated: false,
                armed: true,
            };
            if exit == "normal" {
                let mut guard = guard;
                guard.finish().await.unwrap();
            } else {
                let task = tokio::spawn(async move {
                    let _guard = guard;
                    if exit == "panic" {
                        panic!("diagnostic panic");
                    }
                    std::future::pending::<()>().await;
                });
                tokio::task::yield_now().await;
                if exit == "cancelled" {
                    task.abort();
                }
                assert!(task.await.is_err());
            }
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let copied = store.clone();
                    let tenant = tenant.clone();
                    let device = device.clone();
                    if tokio::task::spawn_blocking(move || {
                        copied.device_state(&tenant, &device).unwrap().is_none()
                    }).await.unwrap() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }).await.unwrap();
            assert!(Arc::ptr_eq(&security_store().unwrap(), &store));
            assert_eq!(host_identity::current().unwrap(), binding);
            assert_eq!(store.list_devices(&tenant).unwrap().into_iter()
                .map(|d| (d.device_id, d.status)).collect::<Vec<_>>(), before);
            assert!(enroll(&store, &tenant, &device).is_err(), "revocation tombstone prevents reenrollment");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_blocking_enrollment_finishes_before_orphan_cleanup() {
        let _scope = super::super::tests::TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("enrollment-owner", "digest").unwrap();
        let tenant = binding.remote_tenant_id.clone();
        let device = "cancelled-enrollment".to_owned();
        let identity = IdentityScope {
            device: device.clone(),
            tenant: tenant.clone(),
            store: store.clone(),
            isolated: false,
            armed: true,
        };
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let enrollment = EnrollmentScope {
            device: device.clone(),
            _permit: gate.clone().acquire_owned().await.unwrap(),
        };
        ENROLLMENTS.lock().insert(device.clone(), gate);
        let (release, wait) = std::sync::mpsc::channel();
        let entered = Arc::new(tokio::sync::Notify::new());
        let notify = entered.clone();
        let enrolling = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _enrollment = enrollment;
                notify.notify_one();
                wait.recv().unwrap();
                enroll(&identity.store, &identity.tenant, &identity.device).unwrap();
                identity
            }).await.unwrap()
        });
        entered.notified().await;
        enrolling.abort();
        assert!(enrolling.await.is_err());
        let copied = store.clone();
        let t = tenant.clone();
        let d = device.clone();
        let cleanup = tokio::spawn(async move {
            wait_for_enrollment(&d).await.unwrap();
            tokio::task::spawn_blocking(move || clean_device(&copied, &t, &d)).await.unwrap().unwrap();
        });
        tokio::task::yield_now().await;
        assert!(!cleanup.is_finished());
        release.send(()).unwrap();
        cleanup.await.unwrap();
        assert!(store.device_state(&tenant, &device).unwrap().is_none());
        assert_eq!(host_identity::current().unwrap(), binding);
    }

    #[test]
    fn native_scroll_and_typing_share_the_real_consent_policy() {
        for (action, point) in [
            (
                UiAction::TypeText {
                    text: "fixture".into(),
                },
                None,
            ),
            (
                UiAction::Scroll {
                    opts: Default::default(),
                },
                Some(Point { x: 20, y: 20 }),
            ),
        ] {
            let runtime = runtime(Arc::new(|_, _| {}));
            let command = input_command(&action).unwrap();
            let guard = InputPolicyGuard::new(&runtime, command, point, &action);
            assert!(guard.required_consent);
            guard.check().unwrap();
            runtime
                .enforcement
                .gate
                .update(|settings| settings.enabled = false);
            assert_eq!(
                guard.check().unwrap_err().code,
                "managed_desktop_control_policy_denied"
            );
        }
    }

    #[test]
    fn diagnostic_codes_exclude_secrets_and_unbounded_messages() {
        assert_eq!(
            diagnostic_error_code("managed_desktop_control_lease_expired"),
            "managed_desktop_control_lease_expired"
        );
        for code in [
            "token-secret",
            "https://provider.invalid/?key=secret",
            "managed_desktop_failure\nsecret",
        ] {
            assert_eq!(diagnostic_error_code(code), "unexpected_error_code");
        }
        assert_eq!(
            diagnostic_error_code(&format!("managed_desktop_{}", "x".repeat(128))),
            "unexpected_error_code"
        );
    }

    #[test]
    fn native_admission_observation_cannot_turn_denial_into_permission() {
        let count = Arc::new(AtomicU64::new(0));
        let observe = observer(&count);
        observe(false);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        observe(true);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn missing_native_checks_and_nonzero_denied_admission_never_qualify() {
        let mut evidence = HostAuthoritySmokeEvidence::default();
        assert!(!evidence.has_complete_evidence());
        evidence.evidence_version = 1;
        evidence.smoke_desktop_id = "desktop".into();
        evidence.denied_admitted_commands = 1;
        assert!(!evidence.has_complete_evidence());
    }
}
