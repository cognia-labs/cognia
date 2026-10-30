//! Native P4 composition. Every fact is collected by a fixed runner and bound
//! to the same Host journal; no RPC accepts a qualification receipt.
use super::*;
use crate::cua_sandbox::managed::handoff::{self, InstalledHandoff, PreparedHandoff};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn invalid() -> ManagedDesktopError {
    refused("managed_desktop_qualification_invalid")
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn destroyed_binding(
    s: &ManagedDesktopJournal,
    binding: &HostBoundaryBinding,
    digest: &str,
    template: &TemplateIdentity,
) -> bool {
    s.desktops.get(&binding.desktop_id).is_some_and(|row| {
        row.smoke
            && row.desktop.state == ManagedDesktopState::Destroyed
            && row.config.binding_digest() == digest
            && row.template == *template
            && binding.matches_record(row)
            && s.workload_boundaries
                .get(&binding.desktop_id)
                .is_some_and(|pinned| pinned.same_generation(binding))
    })
}
fn handoff_valid(
    s: &ManagedDesktopJournal,
    record: &NativeHandoffDiagnostic,
    digest: &str,
    template: &TemplateIdentity,
) -> bool {
    record.evidence_version == 1
        && matches!(record.mode.as_str(), "commit" | "bundle")
        && uuid::Uuid::parse_str(&record.operation_id)
            .is_ok_and(|id| id.to_string() == record.operation_id)
        && digest_valid(&record.receipt_sha256)
        && digest_valid(&record.source_tree_sha256)
        && destroyed_binding(s, &record.boundary, digest, template)
        && s.desktops
            .get(&record.boundary.desktop_id)
            .is_some_and(|row| {
                row.source_id.as_deref()
                    == Some(format!("handoff:{}", record.operation_id).as_str())
            })
}
/// Re-derive the complete workload projection from native records every time
/// qualification is queried. Hash-looking strings alone are never authority.
pub(super) fn derive_evidence(
    s: &ManagedDesktopJournal,
    digest: &str,
    template: &TemplateIdentity,
) -> Option<WorkloadQualificationEvidence> {
    control_current(s, digest, template)?;
    workload_current(s, digest, template)?;
    authority_current(s, digest, template)?;
    let control = s.control_qualifications.get(digest)?;
    let workload = s.workload_diagnostics.get(digest)?;
    let authority = s.authority_diagnostics.get(digest)?;
    let commit = s
        .handoff_diagnostics
        .values()
        .filter(|r| r.mode == "commit" && handoff_valid(s, r, digest, template))
        .max_by_key(|r| r.recorded_at)?;
    let bundle = s
        .handoff_diagnostics
        .values()
        .filter(|r| r.mode == "bundle" && handoff_valid(s, r, digest, template))
        .max_by_key(|r| r.recorded_at)?;
    if commit.operation_id == bundle.operation_id
        || commit.receipt_sha256 == bundle.receipt_sha256
        || commit.source_tree_sha256 != bundle.source_tree_sha256
    {
        return None;
    }
    let boundaries = vec![
        commit.boundary.clone(),
        bundle.boundary.clone(),
        workload.boundary.clone(),
        authority.boundary.clone(),
    ];
    if boundaries
        .iter()
        .map(|b| &b.desktop_id)
        .collect::<BTreeSet<_>>()
        .len()
        != 4
        || boundaries
            .iter()
            .any(|b| b.desktop_id == control.smoke_desktop_id)
    {
        return None;
    }
    Some(WorkloadQualificationEvidence {
        workload_isolation_revision: 1,
        enforcement: "provider-and-guest-kernel".into(),
        boundaries,
        launch_paths_verified: vec!["desktop".into(), "importer".into(), "acceptance".into()],
        workload_egress_verified: true,
        escape_resistance_verified: true,
        native_handoff_receipt_sha256: vec![
            commit.receipt_sha256.clone(),
            bundle.receipt_sha256.clone(),
        ],
    })
}

impl ManagedDesktopService {
    /// A newly authorized diagnostic supersedes prior evidence even if it
    /// subsequently fails. Keep independent categories and cleanup history.
    pub async fn invalidate_native_qualification(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        kind: NativeQualificationKind,
    ) -> Result<()> {
        p.require_admin()?;
        let digest = self.config(p, config_id).await?.binding_digest();
        self.transaction(move |s, _| {
            s.qualifications.remove(&digest);
            match kind {
                NativeQualificationKind::Lifecycle => { s.lifecycle_diagnostics.remove(&digest); }
                NativeQualificationKind::Control => { s.control_qualifications.remove(&digest); }
                NativeQualificationKind::Authority => { s.authority_diagnostics.remove(&digest); }
                NativeQualificationKind::Workload => { s.workload_diagnostics.remove(&digest); }
                NativeQualificationKind::Commit | NativeQualificationKind::Bundle => {
                    let mode = if matches!(kind, NativeQualificationKind::Commit) { "commit" } else { "bundle" };
                    s.handoff_diagnostics.retain(|_, record| {
                        record.mode != mode || record.boundary.binding_digest != digest
                    });
                }
            }
            Ok(())
        }).await
    }

    /// Called after native install, journal reopen and private checkpoint. This
    /// method accepts no file/path or success flags and revalidates live identity.
    pub async fn record_native_handoff_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop,
        prepared: &PreparedHandoff,
        installed: &InstalledHandoff,
    ) -> Result<()> {
        p.require_admin()?;
        let mode = prepared.mode();
        prepared.validate_installed(installed, &installed.operation_id).map_err(|_| invalid())?;
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if !row.smoke
            || row.source_id.as_deref()
                != Some(format!("handoff:{}", installed.operation_id).as_str())
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await)
            || installed.receipt_version != 3
            || !installed.launched
        {
            return Err(invalid());
        }
        let boundary = self.validate_live_boundary(p, desktop).await?;
        handoff::validate_installed_boundary(installed, &boundary.observation)
            .map_err(|_| invalid())?;
        let record = NativeHandoffDiagnostic {
            evidence_version: 1,
            mode: mode.into(),
            operation_id: installed.operation_id.clone(),
            boundary,
            receipt_sha256: hex::encode(Sha256::digest(
                serde_json::to_vec(installed).map_err(|_| invalid())?,
            )),
            source_tree_sha256: installed.source_tree_sha256.clone(),
            recorded_at: self.now().await,
        };
        self.transaction(move |s, _| {
            s.handoff_diagnostics
                .insert(record.operation_id.clone(), record);
            Ok(())
        })
        .await
    }
    /// The actual Host-authority runner returns this evidence only after real
    /// native assertions and deletion. It is not an IPC or RPC operation.
    pub async fn record_authority_qualification_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        evidence: HostAuthoritySmokeEvidence,
        _permit: ExplicitPaidSmokeAuthorization,
    ) -> Result<()> {
        p.require_admin()?;
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let digest = config.binding_digest();
        self.transaction(move |s, now| {
            let boundary = s
                .workload_boundaries
                .get(&evidence.smoke_desktop_id)
                .cloned()
                .ok_or_else(invalid)?;
            if !evidence.has_complete_evidence()
                || evidence.smoke_desktop_generation != boundary.desktop_generation
                || evidence.observed_at > now
                || now.saturating_sub(evidence.observed_at) > QUOTE_TTL_MS
                || !destroyed_binding(s, &boundary, &digest, &boundary.template)
            {
                return Err(invalid());
            }
            s.authority_diagnostics.insert(
                digest,
                NativeAuthorityDiagnostic {
                    boundary,
                    evidence,
                    recorded_at: now,
                },
            );
            Ok(())
        })
        .await
    }
    /// Recompose from this Host's persisted native evidence. No caller can
    /// supply booleans, receipt paths or a prior image's diagnostics.
    pub async fn complete_native_qualification(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        _permit: ExplicitPaidSmokeAuthorization,
    ) -> Result<QualificationReceipt> {
        p.require_admin()?;
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let digest = config.binding_digest();
        self.transaction(move |s, now| {
            let template = latest_template(s, &digest)
                .filter(|t| t.state == TemplateState::Ready)
                .and_then(|t| t.identity.clone())
                .ok_or_else(invalid)?;
            let mut receipt = s
                .lifecycle_diagnostics
                .get(&digest)
                .cloned()
                .ok_or_else(invalid)?;
            if !lifecycle_receipt_valid(s, &receipt, &digest, &template) {
                return Err(invalid());
            }
            receipt.workload_evidence =
                Some(derive_evidence(s, &digest, &template).ok_or_else(invalid)?);
            receipt.observed_at = now;
            s.qualifications.insert(digest, receipt.clone());
            Ok(receipt)
        })
        .await
    }
}

/// A new paid desktop is explicitly quoted because the destructive probe kills
/// its supervisor. Existing application desktops are never diagnostic targets.
pub async fn run_workload_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<NativeWorkloadDiagnostic> {
    p.require_admin()?;
    let service = host.open(host.provider())?;
    let config = service.config(p, config_id).await?;
    let digest = config.binding_digest();
    {
        let state = service.state.lock().await;
        let identity = latest_template(&state, &digest)
            .and_then(|t| t.identity.as_ref())
            .ok_or_else(invalid)?;
        if !lifecycle_diagnostic_valid(&state, &digest, identity) {
            return Err(invalid());
        }
    }
    let source = format!("workload-smoke:{}", Uuid::new_v4());
    let quote = service.quote(p, config_id, 240).await?;
    host.approve_quote(&quote, AuthorizationPurpose::Smoke)
        .await?;
    let auth = service
        .authorize(
            p,
            config_id,
            &quote.id,
            AuthorizationPurpose::Smoke,
            Some(source.clone()),
        )
        .await?;
    let request = CreateManagedDesktop {
        provider_config_id: config_id.into(),
        quote_id: quote.id,
        authorization_id: auth.id,
        idempotency_key: Uuid::new_v4().to_string(),
    };
    service.invalidate_native_qualification(p, config_id, NativeQualificationKind::Workload).await?;
    let outcome = async {
        let desktop = service.create_smoke(p, request).await?;
        let desktop = smoke::wait_ready(&service, p, desktop, &smoke::RealWait).await?;
        let boundary = service.validate_live_boundary(p, &desktop).await?;
        let row = service.scoped(p, &desktop.id, desktop.generation).await?;
        let secrets = service.secrets.desktop(&desktop.id).await?;
        let report = service.provider.qualify_workload(&row, &secrets).await?;
        report.validate().map_err(refused)?;
        if !boundary.observation.same_boundary(&report.desktop) {
            return Err(invalid());
        }
        Ok(NativeWorkloadDiagnostic {
            boundary,
            report,
            recorded_at: service.now().await,
        })
    }
    .await;
    let rows = service
        .state
        .lock()
        .await
        .desktops
        .values()
        .filter(|r| r.source_id.as_deref() == Some(source.as_str()))
        .map(|r| r.desktop.clone())
        .collect::<Vec<_>>();
    let mut cleaned = true;
    for row in rows {
        if !service
            .delete(p, &row.id, row.generation)
            .await
            .is_ok_and(|r| r.state == ManagedDesktopState::Destroyed)
        {
            cleaned = false;
        }
    }
    if !cleaned {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let record: NativeWorkloadDiagnostic = outcome?;
    let saved = record.clone();
    service
        .transaction(move |s, _| {
            if !destroyed_binding(s, &saved.boundary, &digest, &saved.boundary.template) {
                return Err(invalid());
            }
            s.workload_diagnostics.insert(digest, saved);
            Ok(())
        })
        .await?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authorized_retry_durably_removes_old_category_and_composed_receipt() {
        let f = super::super::tests::Fixture::new();
        f.prepare().await;
        let digest = f.config.binding_digest();
        let key = digest.clone();
        f.service.transaction(move |s, _| {
            let template = latest_template(s, &key).unwrap().identity.clone().unwrap();
            let receipt = QualificationReceipt {
                evidence_version: 2, workload_evidence: None, provider_root_observation: None,
                binding_digest: key.clone(), template: template.clone(), observed_at: 1,
                smoke_desktop_ids: vec![], native_expiry_killed: true, no_auto_resume: true,
                ingress_denied: true, guest_auth_denied: true, decoded_frame_verified: true,
                protocol_verified: true, restart_deadline_verified: true,
                delete_retry_verified: true, private_egress_probe_no_response: false,
                egress_policy_verified: true,
            };
            s.lifecycle_diagnostics.insert(key.clone(), receipt.clone());
            s.qualifications.insert(key.clone(), receipt);
            s.control_qualifications.insert(key.clone(), control::ControlQualificationReceipt {
                binding_digest: key, template, smoke_desktop_id: "old".into(),
                smoke_desktop_generation: 1, observed_at: 1, protocol_revision: 1,
                evidence_version: 2, assertions: Default::default(),
            });
            Ok(())
        }).await.unwrap();
        let mut agent = f.p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(f.service.invalidate_native_qualification(&agent, "e2b", NativeQualificationKind::Control).await.is_err());
        assert!(f.service.state.lock().await.qualifications.contains_key(&digest));
        f.service.invalidate_native_qualification(&f.p, "e2b", NativeQualificationKind::Control).await.unwrap();
        let state = f.service.state.lock().await;
        assert!(!state.qualifications.contains_key(&digest));
        assert!(!state.control_qualifications.contains_key(&digest));
        assert!(state.lifecycle_diagnostics.contains_key(&digest));
        assert!(derive_evidence(&state, &digest, &state.lifecycle_diagnostics[&digest].template).is_none());
        drop(state);
        f.service.invalidate_native_qualification(&f.p, "e2b", NativeQualificationKind::Lifecycle).await.unwrap();
        assert!(!f.service.state.lock().await.lifecycle_diagnostics.contains_key(&digest));
    }

    #[test]
    fn missing_native_records_cannot_qualify_from_hashes_or_labels() {
        let state = ManagedDesktopJournal::default();
        let template = TemplateIdentity {
            template_id: "t".into(),
            build_id: "b".into(),
            image_digest: "sha256:x".into(),
            recipe_revision: "7".into(),
            protocol: "p".into(),
        };
        assert!(derive_evidence(&state, "binding", &template).is_none());
        for value in ["", "A", &"A".repeat(64), &"g".repeat(64)] {
            assert!(!digest_valid(value));
        }
        assert!(digest_valid(&"a".repeat(64)));
    }
    #[tokio::test]
    async fn completion_requires_collected_native_evidence_and_admin() {
        let f = super::super::tests::Fixture::new();
        let permit = || {
            ExplicitPaidSmokeAuthorization::for_in_app_run()
        };
        assert!(f
            .service
            .complete_native_qualification(&f.p, "e2b", permit())
            .await
            .is_err());
        let mut agent = f.p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert_eq!(
            f.service
                .complete_native_qualification(&agent, "e2b", permit())
                .await
                .unwrap_err()
                .code,
            "managed_desktop_admin_required"
        );
    }
}

fn control_current(s: &ManagedDesktopJournal, digest: &str, template: &TemplateIdentity) -> Option<i64> {
    let control = s.control_qualifications.get(digest)?;
    if !control.has_complete_evidence()
        || control.binding_digest != digest
        || control.template != *template
        || !s
            .desktops
            .get(&control.smoke_desktop_id)
            .is_some_and(|row| {
                row.smoke
                    && row.desktop.state == ManagedDesktopState::Destroyed
                    && row.desktop.generation == control.smoke_desktop_generation
                    && row.config.binding_digest() == digest
                    && row.template == *template
            })
    {
        return None;
    }
    Some(control.observed_at)
}
fn workload_current(s: &ManagedDesktopJournal, digest: &str, template: &TemplateIdentity) -> Option<i64> {
    let workload = s.workload_diagnostics.get(digest)?;
    if workload.report.validate().is_err()
        || !workload
            .boundary
            .observation
            .same_boundary(&workload.report.desktop)
        || !destroyed_binding(s, &workload.boundary, digest, template)
    {
        return None;
    }
    Some(workload.recorded_at)
}
fn authority_current(s: &ManagedDesktopJournal, digest: &str, template: &TemplateIdentity) -> Option<i64> {
    let authority = s.authority_diagnostics.get(digest)?;
    if !authority.evidence.has_complete_evidence()
        || authority.evidence.smoke_desktop_id != authority.boundary.desktop_id
        || authority.evidence.smoke_desktop_generation != authority.boundary.desktop_generation
        || !destroyed_binding(s, &authority.boundary, digest, template)
    {
        return None;
    }
    Some(authority.recorded_at)
}

pub(super) fn category_statuses(
    s: &ManagedDesktopJournal,
    config: &ManagedDesktopConfig,
    now: i64,
) -> Vec<ManagedDesktopQualificationCategory> {
    let digest = config.binding_digest();
    let template = latest_template(s, &digest)
        .filter(|t| t.state == TemplateState::Ready)
        .and_then(|t| t.identity.as_ref());
    qualification_runs::QUALIFICATION_CATEGORIES.iter().map(|kind| {
        let observed = template.and_then(|t| match kind {
            NativeQualificationKind::Lifecycle => s.lifecycle_diagnostics.get(&digest)
                .filter(|q| lifecycle_receipt_valid(s, q, &digest, t))
                .map(|q| q.observed_at),
            NativeQualificationKind::Control => control_current(s, &digest, t),
            NativeQualificationKind::Authority => authority_current(s, &digest, t),
            NativeQualificationKind::Workload => workload_current(s, &digest, t),
            NativeQualificationKind::Commit | NativeQualificationKind::Bundle => {
                let mode = if *kind == NativeQualificationKind::Commit {
                    "commit"
                } else {
                    "bundle"
                };
                s.handoff_diagnostics.values()
                    .filter(|r| r.mode == mode && handoff_valid(s, r, &digest, t))
                    .map(|r| r.recorded_at)
                    .max()
            }
        });
        ManagedDesktopQualificationCategory {
            category: *kind,
            current: config.validate(now).is_ok() && config.egress == DesktopEgress::Off
                && observed.is_some_and(|at| at <= now),
            observed_at: observed,
        }
    }).collect()
}
pub(super) fn gui_current(s: &ManagedDesktopJournal, config: &ManagedDesktopConfig, now: i64) -> bool {
    let categories = category_statuses(s, config, now);
    if !categories.iter().take(4).all(|c| c.current) {
        return false;
    }
    let digest = config.binding_digest();
    let (Some(control), Some(authority), Some(workload)) = (
        s.control_qualifications.get(&digest),
        s.authority_diagnostics.get(&digest),
        s.workload_diagnostics.get(&digest),
    ) else {
        return false;
    };
    let ids = [
        control.smoke_desktop_id.as_str(),
        authority.boundary.desktop_id.as_str(),
        workload.boundary.desktop_id.as_str(),
    ];
    ids.into_iter().collect::<BTreeSet<_>>().len() == 3
}
/// Recipe-7 GUI receipts cannot authorize recipe-8 operations. Re-derive
/// current configuration/template/native evidence, never trust a stored flag.
pub(super) fn operations_current(
    s: &ManagedDesktopJournal,
    config: &ManagedDesktopConfig,
    now: i64,
) -> bool {
    config.release.recipe_revision == "8"
        && gui_current(s, config, now)
        && s.workload_diagnostics
            .get(&config.binding_digest())
            .is_some_and(|q| q.report.operations.is_some() && q.report.validate().is_ok())
}

pub(super) fn effective_enablement(
    s: &ManagedDesktopJournal,
    config: &ManagedDesktopConfig,
    now: i64,
) -> ManagedDesktopEnablement {
    let gui = gui_current(s, config, now);
    let acceptance = gui && latest_template(s, &config.binding_digest())
        .filter(|t| t.state == TemplateState::Ready)
        .and_then(|t| t.identity.as_ref())
        .is_some_and(|t| qualified(s, &config.binding_digest(), t));
    ManagedDesktopEnablement {
        manual_gui: config.enablement.manual_gui && gui,
        agent_control: config.enablement.agent_control && gui,
        acceptance: config.enablement.acceptance && acceptance,
    }
}
impl ManagedDesktopService {
    pub async fn effective_enablement(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
    ) -> Result<ManagedDesktopEnablement> {
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let now = self.now().await;
        Ok(effective_enablement(&*self.state.lock().await, &config, now))
    }
    pub async fn desktop_enablement(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedDesktopEnablement> {
        let row = self.scoped(p, id, generation).await?;
        let config = self.config(p, &row.config.id).await?;
        if config.binding_digest() != row.config.binding_digest() {
            return Ok(ManagedDesktopEnablement::default());
        }
        self.admission(&config, self.now().await)?;
        let now = self.now().await;
        let state = self.state.lock().await;
        if latest_template(&state, &config.binding_digest()).and_then(|t| t.identity.as_ref()) != Some(&row.template) {
            return Ok(ManagedDesktopEnablement::default());
        }
        Ok(effective_enablement(&state, &config, now))
    }
    pub async fn quote_enablement(
        &self,
        p: &ManagedDesktopPrincipal,
        quote: &ManagedDesktopQuote,
    ) -> Result<ManagedDesktopEnablement> {
        let config = self.config(p, &quote.provider_config_id).await?;
        self.admission(&config, self.now().await)?;
        if config.binding_digest() != quote.binding_digest {
            return Ok(ManagedDesktopEnablement::default());
        }
        let now = self.now().await;
        let state = self.state.lock().await;
        Ok(effective_enablement(&state, &config, now))
    }
    /// Cache the durable verdict for the same re-admission interval as native
    /// frames. Changes to qualification inputs bump the epoch, fencing a pump
    /// immediately; the time bound also detects out-of-process file changes.
    pub async fn runtime_admission(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        gate: ManagedDesktopRuntimeGate,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Arc<dyn Fn() -> bool + Send + Sync>> {
        let row = self.scoped(p, id, generation).await?;
        Ok(self.runtime_admission_for_record(&row, gate, live))
    }
    pub(super) fn runtime_admission_for_record(
        &self,
        row: &DesktopRecord,
        gate: ManagedDesktopRuntimeGate,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Arc<dyn Fn() -> bool + Send + Sync> {
        if matches!(gate, ManagedDesktopRuntimeGate::AgentControl | ManagedDesktopRuntimeGate::Acceptance) {
            let service = self.clone();
            let row = row.clone();
            return Arc::new(move || live() && service.agent_enabled(&row, gate));
        }
        let row = row.clone();
        let store = self.store.clone();
        let clock = self.clock.clone();
        let release = self.trusted_release.clone();
        let epoch = self.enablement_epoch.clone();
        #[cfg(test)]
        let reads = self.admission_registry_reads.clone();
        let cached = std::sync::Mutex::new(None::<(u64, bool, std::time::Instant)>);
        Arc::new(move || {
            if !live() {
                return false;
            }
            let mut cached = cached.lock().unwrap_or_else(|e| e.into_inner());
            let version = epoch.load(std::sync::atomic::Ordering::SeqCst);
            if let Some((checked_epoch, verdict, checked_at)) = *cached {
                if version == checked_epoch
                    && checked_at.elapsed() < cognia_remote_desktop::session::ADMISSION_INTERVAL
                {
                    return verdict;
                }
            }
            let verdict = (|| {
                #[cfg(test)]
                reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Ok(registry) = store.registry() else {
                    return false;
                };
                let Some(current) = registry.providers.iter().find(|c| {
                    c.id == row.config.id
                        && c.owner_principal_id == row.config.owner_principal_id
                        && c.host_id == row.config.host_id
                }) else {
                    return false;
                };
                if !current.enabled || release.as_ref() != Some(&current.release)
                    || current.binding_digest() != row.config.binding_digest()
                {
                    return false;
                }
                let Ok(state) = store.load_checkpoint(&row.config.host_id) else {
                    return false;
                };
                if !state.desktops.get(&row.desktop.id).is_some_and(|d| {
                    d.desktop.generation == row.desktop.generation
                        && d.config.binding_digest() == current.binding_digest()
                        && d.template == row.template
                }) || latest_template(&state, &current.binding_digest())
                    .and_then(|t| t.identity.as_ref()) != Some(&row.template)
                {
                    return false;
                }
                let enabled = effective_enablement(&state, current, clock().max(state.last_observed_at));
                match gate {
                    ManagedDesktopRuntimeGate::ManualGui => enabled.manual_gui,
                    ManagedDesktopRuntimeGate::AgentControl => enabled.agent_control,
                    ManagedDesktopRuntimeGate::Acceptance => enabled.acceptance,
                }
            })();
            if epoch.load(std::sync::atomic::Ordering::SeqCst) != version {
                *cached = None;
                return false;
            }
            *cached = Some((version, verdict, std::time::Instant::now()));
            verdict
        })
    }
}

#[cfg(test)]
pub(super) mod enablement_tests {
    use super::*;
    use cognia_desktop_guest::{
        observation::{DescriptorObservation, ObservationPhase, NAMESPACES},
        qualification::*,
    };

    fn workload_report(desktop: cognia_desktop_guest::observation::ProcessBoundaryReport) -> WorkloadQualificationReport {
        let process = |boundary: &cognia_desktop_guest::observation::ProcessBoundaryReport, pid, executable: &str| ProcessSnapshot {
            pid,
            start_time: 1,
            executable: executable.into(),
            status: boundary.status.clone(),
            namespaces: boundary.namespaces.clone(),
            descriptors: desktop.descriptors.clone(),
        };
        let probe = |boundary: &cognia_desktop_guest::observation::ProcessBoundaryReport, pid| ProbeRun {
            process: process(boundary, pid, "/usr/local/bin/cognia-desktop-guest"),
            sockets: TARGETS.into_iter().flat_map(|target| {
                [("tcp", 80), ("tcp", 443), ("udp", 443)].into_iter().map(move |(transport, port)| SocketAttempt {
                    target: target.into(),
                    transport: transport.into(),
                    port,
                    result: -1,
                    errno: 101,
                })
            }).collect(),
            escapes: vec![
                ErrorObservation {
                    operation: "unshareUser".into(),
                    result: -1,
                    errno: 1,
                },
                ErrorObservation {
                    operation: "setuidRoot".into(),
                    result: -1,
                    errno: 22,
                },
            ],
            paths: HIDDEN_PATHS.into_iter().map(|operation| ErrorObservation {
                operation: operation.into(),
                result: -1,
                errno: 2,
            }).collect(),
            hostnames: ["example.com", "metadata.google.internal"].into_iter().map(|operation| ErrorObservation {
                operation: operation.into(),
                result: -3,
                errno: -3,
            }).collect(),
            local_helpers: ["127.0.0.1:49983", "127.0.0.1:8000"].into_iter().map(|operation| ErrorObservation {
                operation: operation.into(),
                result: -1,
                errno: 111,
            }).collect(),
        };
        let mut acceptance = desktop.clone();
        acceptance.phase = ObservationPhase::AcceptanceAdmission;
        for fd in [3, 4] {
            acceptance.descriptors.insert(fd, DescriptorObservation {
                target: format!("pipe:[{fd}]"),
                flags: 0o2000000,
                socket_scope: None,
            });
        }
        let mut importer = desktop.clone();
        importer.phase = ObservationPhase::ImporterAdmission;
        importer.status = importer.status.replace("1000", "1001");
        importer.namespaces = NAMESPACES.into_iter().map(|n| (n.into(), format!("{n}:[3]"))).collect();
        importer.descriptors.get_mut(&0).unwrap().target = "pipe:[42]".into();
        let mut weak = importer.clone();
        weak.status = weak.status.replace("Seccomp:2", "Seccomp:0");
        let mut negative = process(&desktop, 30, "/usr/local/bin/cognia-desktop-guest");
        negative.namespaces = desktop.provider_namespaces.clone();
        negative.status = "Uid:0 0 0 0".into();
        let operations = OperationProbe {
            admission: acceptance.clone(),
            network_clients: TARGETS.into_iter().map(|target| OperationNetworkClient { target: target.into(), exit_code: 101 }).collect(),
            refusals: OPERATION_REFUSALS.into_iter().map(|operation| ErrorObservation { operation: operation.into(), result: -1, errno: 1 }).collect(),
            written_bytes: 8 * 1024 * 1024, read_bytes: 8 * 1024 * 1024,
            output_bytes: 1024 * 1024, output_truncated: true,
            timeout_ms: 1000, timeout_signal: 9, clipboard_bytes: 1024 * 1024,
            timeout_processes: [(10, 1), (11, 1)].into(), timeout_survivors: Default::default(),
            death_processes: [(70, 1), (71, 1)].into(),
        };
        let report = WorkloadQualificationReport {
            report_version: PROBE_VERSION,
            boundary_generation: desktop.boundary_generation.clone(),
            negative_control: negative,
            weakened_launch: WeakenedLaunchEvidence {
                profile: "importer-without-seccomp-v1".into(),
                executable: "/usr/local/bin/cognia-desktop-guest".into(),
                terminated_processes: [(weak.namespace_init_pid, weak.namespace_init_start_time), (weak.workload_pid, weak.workload_start_time)].into(),
                surviving_processes: Default::default(),
                admission: weak,
            },
            acceptance_admission: acceptance,
            importer_admission: importer.clone(),
            desktop_probe: DesktopProbe {
                acceptance: probe(&desktop, 40),
                terminal: probe(&desktop, 41),
                detached_pid: 50,
                browser: BrowserRun {
                    process: process(&desktop, 42, "/usr/lib/chromium/chromium"),
                    exit_code: 0,
                    local_preview: "cognia-qualified-loopback".into(),
                    metadata_navigation_net_errors: vec![-109],
                    redirect_net_errors: vec![-109],
                    hostname_net_errors: vec![-105],
                },
            },
            importer_probe: ImporterProbe {
                importer: probe(&importer, 43),
                git: process(&importer, 44, "/usr/bin/git"),
                git_exit_code: 0,
            },
            terminated_processes: [(desktop.namespace_init_pid, desktop.namespace_init_start_time), (50, 1), (60, 1), (70, 1), (71, 1)].into(),
            surviving_processes: Default::default(),
            detached_outer_pid: 50,
            supervisor_pid: 60,
            supervisor_start_time: 1,
            ingress_errno: 111,
            operations: Some(operations),
            desktop,
        };
        report.validate().unwrap();
        report
    }
    pub(in crate::cua_sandbox::managed::service) async fn install_gui_evidence(
        f: &super::super::tests::Fixture,
    ) -> Vec<ManagedDesktop> {
        f.prepare().await;
        let mut rows = Vec::new();
        for index in 0..5 {
            let d = f.smoke(&format!("evidence-{index}")).await;
            f.service.delete(&f.p, &d.id, d.generation).await.unwrap();
            rows.push(d);
        }
        let digest = f.config.binding_digest();
        f.service.transaction(|s, now| {
            let template = latest_template(s, &digest).unwrap().identity.clone().unwrap();
            s.lifecycle_diagnostics.insert(digest.clone(), QualificationReceipt {
                evidence_version: 2,
                workload_evidence: None,
                provider_root_observation: None,
                private_egress_probe_no_response: false,
                binding_digest: digest.clone(),
                template: template.clone(),
                observed_at: now,
                smoke_desktop_ids: rows[..2].iter().map(|d| d.id.clone()).collect(),
                native_expiry_killed: true,
                no_auto_resume: true,
                ingress_denied: true,
                guest_auth_denied: true,
                decoded_frame_verified: true,
                protocol_verified: true,
                restart_deadline_verified: true,
                delete_retry_verified: true,
                egress_policy_verified: true,
            });
            let mut assertions = serde_json::to_value(control::ControlQualificationAssertions::default()).unwrap();
            for v in assertions.as_object_mut().unwrap().values_mut() {
                *v = serde_json::json!(true);
            }
            s.control_qualifications.insert(digest.clone(), control::ControlQualificationReceipt {
                binding_digest: digest.clone(),
                template,
                smoke_desktop_id: rows[2].id.clone(),
                smoke_desktop_generation: 1,
                observed_at: now,
                protocol_revision: 1,
                evidence_version: 2,
                assertions: serde_json::from_value(assertions).unwrap(),
            });
            let mut evidence = serde_json::to_value(HostAuthoritySmokeEvidence::default()).unwrap();
            for v in evidence.as_object_mut().unwrap().values_mut() {
                if v.is_boolean() {
                    *v = serde_json::json!(true);
                }
            }
            evidence["evidenceVersion"] = serde_json::json!(1);
            evidence["smokeDesktopId"] = serde_json::json!(rows[3].id);
            evidence["smokeDesktopGeneration"] = serde_json::json!(1);
            evidence["observedAt"] = serde_json::json!(now);
            evidence["consentTimeoutMs"] = serde_json::json!(5000);
            evidence["positiveAdmittedCommands"] = serde_json::json!(1);
            evidence["compoundAdmittedCommands"] = serde_json::json!(1);
            evidence["compoundDeniedCommands"] = serde_json::json!(1);
            s.authority_diagnostics.insert(digest.clone(), NativeAuthorityDiagnostic {
                boundary: s.workload_boundaries[&rows[3].id].clone(),
                evidence: serde_json::from_value(evidence).unwrap(),
                recorded_at: now,
            });
            let boundary = s.workload_boundaries[&rows[4].id].clone();
            let report = workload_report(boundary.observation.clone());
            s.workload_diagnostics.insert(digest.clone(), NativeWorkloadDiagnostic {
                boundary,
                report,
                recorded_at: now,
            });
            Ok(())
        }).await.unwrap();
        rows
    }

    #[tokio::test]
    async fn recipe_7_receipts_are_stale_under_a_recipe_8_trusted_release() {
        let mut f = super::super::tests::Fixture::new();
        f.config.release.recipe_revision = "7".into();
        f.service.trusted_release = Some(f.config.release.clone());
        f.service.store.save_registry(&super::super::super::journal::ManagedDesktopRegistry {
            version: 1, providers: vec![f.config.clone()],
        }).unwrap();
        install_gui_evidence(&f).await;
        let now = f.service.now().await;
        {
            let state = f.service.state.lock().await;
            assert!(gui_current(&state, &f.config, now), "positive recipe-7 evidence qualifies its own release");
            let receipt = &state.lifecycle_diagnostics[&f.config.binding_digest()];
            assert_eq!(receipt.template.recipe_revision, "7");
            let bytes = serde_json::to_vec(receipt).unwrap();
            let readable: QualificationReceipt = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(readable.template.recipe_revision, "7");
            let report = &state.workload_diagnostics[&f.config.binding_digest()].report;
            assert!(
                report.operations.is_some(),
                "fixture includes the operations report"
            );
            assert!(
                !operations_current(&state, &f.config, now),
                "recipe 7 cannot qualify operations even with a report"
            );
            let mut legacy = serde_json::to_value(report).unwrap();
            legacy["reportVersion"] = 2.into();
            legacy.as_object_mut().unwrap().remove("operations");
            let readable: WorkloadQualificationReport = serde_json::from_value(legacy).unwrap();
            assert!(readable.operations.is_none());
            assert!(readable.validate().is_err(), "old reports remain readable but cannot qualify recipe 8");
        }
        let mut release8 = f.config.release.clone();
        release8.recipe_revision = "8".into();
        f.service.trusted_release = Some(release8.clone());
        assert!(f.service.release(&f.config).is_err(), "a recipe-7 config cannot use the recipe-8 trusted release");
        let mut config8 = f.config.clone();
        config8.release = release8;
        f.service.release(&config8).unwrap();
        assert_ne!(config8.binding_digest(), f.config.binding_digest());
        let mut state = f.service.state.lock().await;
        let old = latest_template(&state, &f.config.binding_digest()).unwrap().identity.clone().unwrap();
        let mut template8 = old.clone();
        template8.recipe_revision = "8".into();
        assert!(!lifecycle_receipt_valid(&state, &state.lifecycle_diagnostics[&f.config.binding_digest()], &config8.binding_digest(), &template8));
        assert!(!gui_current(&state, &config8, now));
        assert!(category_statuses(&state, &config8, now).iter().all(|status| !status.current));
        assert_eq!(effective_enablement(&state, &config8, now), ManagedDesktopEnablement::default());
        // Even relabelling the binding key cannot migrate a template-bound receipt.
        let mut old_receipt = state.lifecycle_diagnostics[&f.config.binding_digest()].clone();
        old_receipt.binding_digest = config8.binding_digest();
        assert_eq!(old_receipt.template.recipe_revision, "7");
        state.lifecycle_diagnostics.insert(config8.binding_digest(), old_receipt.clone());
        assert!(!lifecycle_receipt_valid(&state, &old_receipt, &config8.binding_digest(), &template8));
    }
    #[tokio::test]
    async fn gui_switches_need_four_categories_acceptance_needs_handoff_and_edits_invalidate_both() {
        let f = super::super::tests::Fixture::new();
        let rows = install_gui_evidence(&f).await;
        let draft = |enablement: ManagedDesktopEnablement| ManagedDesktopConfigDraft {
            id: f.config.id.clone(),
            expected_revision: Some(1),
            enabled: true,
            enablement,
            shape: f.config.shape.clone(),
            limits: f.config.limits.clone(),
            egress: f.config.egress.clone(),
            isolation_minimum: f.config.isolation_minimum,
            plan: AccountPlanDraft {
                max_lifetime_seconds: f.config.plan.max_lifetime_seconds,
                source: f.config.plan.source.clone(),
                namespace: f.config.plan.namespace.clone(),
                valid_for_ms: f.config.plan.expires_at - f.config.plan.observed_at,
            },
            price: DesktopPriceDraft {
                currency: f.config.price.currency.clone(),
                hourly_rate_micros: f.config.price.hourly_rate_micros,
                source: f.config.price.source.clone(),
                valid_for_ms: f.config.price.expires_at - f.config.price.observed_at,
            },
        };
        let gui = ManagedDesktopEnablement {
            manual_gui: true,
            agent_control: true,
            acceptance: false,
        };
        let summary = f.service.save_config(&f.p, draft(gui)).await.unwrap();
        assert_eq!(summary.revision, 1, "switch-only saves preserve the evidence binding");
        assert_eq!(summary.enablement, gui);
        assert!(summary.can_create && summary.gui_qualified);
        assert_eq!(summary.qualification, "qualified");
        assert_eq!(summary.qualification_categories.len(), 6);
        assert!(summary.qualification_categories[..4].iter().all(|c| c.current));
        assert!(summary.qualification_categories[4..].iter().all(|c| !c.current));
        let send = f.service.runtime_admission(
            &f.p, &rows[2].id, 1, ManagedDesktopRuntimeGate::ManualGui, Arc::new(|| true),
        ).await.unwrap();
        assert!(send());
        let reads = f.service.admission_registry_reads.load(std::sync::atomic::Ordering::SeqCst);
        for _ in 0..100 {
            assert!(send());
        }
        assert_eq!(f.service.admission_registry_reads.load(std::sync::atomic::Ordering::SeqCst), reads);
        assert_eq!(reads, 1);
        assert!(
            !f.service.control_status(&f.p, &rows[2].id, 1).await.unwrap().agent_control_dormant,
            "WP8 consumes the effective agent-control switch"
        );
        let quoted = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        assert!(f.service.quote_enablement(&f.p, &quoted).await.unwrap().manual_gui);
        f.service.save_config(&f.p, draft(ManagedDesktopEnablement::default())).await.unwrap();
        assert!(!send(), "turning a switch off fences a previously admitted send");
        assert!(!f.service.list_configs(&f.p).await.unwrap()[0].can_create);
        let quote = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        let auth = f.service.authorize(&f.p, "e2b", &quote.id, AuthorizationPurpose::Create, None).await.unwrap();
        assert_eq!(f.service.create(&f.p, CreateManagedDesktop {
            provider_config_id: "e2b".into(),
            quote_id: quote.id,
            authorization_id: auth.id,
            idempotency_key: "off-switch".into(),
        }).await.unwrap_err().code, "managed_desktop_unqualified");
        f.service.save_config(&f.p, draft(gui)).await.unwrap();
        assert!(send());
        assert_eq!(f.service.save_config(&f.p, draft(ManagedDesktopEnablement {
            acceptance: true,
            ..gui
        })).await.unwrap_err().code, "managed_desktop_enablement_unqualified");
        // Out-of-process registry edits are detected within the shared period.
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].shape.cpu_count += 1;
        registry.providers[0].revision += 1;
        registry.providers[0].enablement.acceptance = true;
        f.service.store.save_registry(&registry).unwrap();
        assert!(send(), "out-of-process changes are bounded by the admission interval");
        tokio::time::sleep(cognia_remote_desktop::session::ADMISSION_INTERVAL + std::time::Duration::from_millis(10)).await;
        let summary = f.service.list_configs(&f.p).await.unwrap().remove(0);
        assert_eq!(summary.enablement, ManagedDesktopEnablement::default());
        assert!(!send());
        assert!(!f.service.quote_enablement(&f.p, &quoted).await.unwrap().manual_gui);
        assert!(summary.qualification_categories.iter().all(|c| !c.current));
        let mut changed = draft(gui);
        changed.expected_revision = Some(2);
        changed.shape.cpu_count += 1;
        assert_eq!(f.service.save_config(&f.p, changed).await.unwrap_err().code, "managed_desktop_enablement_unqualified");
    }
}
