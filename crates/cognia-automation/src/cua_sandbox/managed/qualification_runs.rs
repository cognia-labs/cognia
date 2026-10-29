//! Journal-backed qualification runs. The fixed native runners own evidence;
//! this state machine owns human quote approval and diagnostic cleanup.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QualificationScope {
    Gui,
    Acceptance,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QualificationRunState {
    Running,
    AwaitingApproval,
    Passed,
    Failed,
    Cancelled,
    Interrupted,
}
impl QualificationRunState {
    pub fn active(self) -> bool {
        matches!(self, Self::Running | Self::AwaitingApproval)
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QualificationCategoryState {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationHandoff {
    pub delivery_id: String,
    pub script: String,
}
impl QualificationHandoff {
    pub fn validate(&self) -> Result<()> {
        super::super::handoff::parse_launch(&["npm".into(), "run".into(), self.script.clone()])
            .map_err(|_| refused("managed_desktop_handoff_script_invalid"))?;
        if self.delivery_id.is_empty() || self.delivery_id.len() > 128 {
            return Err(refused("managed_desktop_handoff_delivery_unknown"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationApproval {
    pub quote: ManagedDesktopQuote,
    pub purpose: AuthorizationPurpose,
    pub template_build_charges: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationCategoryResult {
    pub category: NativeQualificationKind,
    pub state: QualificationCategoryState,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopQualificationRun {
    pub run_id: String,
    pub provider_config_id: String,
    pub config_revision: u64,
    pub scope: QualificationScope,
    pub state: QualificationRunState,
    pub current_category: Option<NativeQualificationKind>,
    pub awaiting_approval: Option<QualificationApproval>,
    pub categories: Vec<QualificationCategoryResult>,
    pub handoff: Option<QualificationHandoff>,
    pub error_code: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationRunRecord {
    pub run: ManagedDesktopQualificationRun,
    pub owner_principal_id: String,
    pub host_id: String,
    pub principal_id: String,
    pub binding_digest: String,
    pub approved_quotes: BTreeSet<String>,
    pub desktop_ids: BTreeSet<String>,
    #[serde(default)]
    pub handoff_operations: BTreeSet<String>,
    /// Persist before enrollment so a process crash can revoke the device.
    pub authority_device: Option<(String, String)>,
}
pub const QUALIFICATION_CATEGORIES: [NativeQualificationKind; 6] = [
    NativeQualificationKind::Lifecycle,
    NativeQualificationKind::Control,
    NativeQualificationKind::Authority,
    NativeQualificationKind::Workload,
    NativeQualificationKind::Commit,
    NativeQualificationKind::Bundle,
];
fn row<'a>(
    s: &'a mut ManagedDesktopJournal,
    p: &ManagedDesktopPrincipal,
    id: &str,
) -> Result<&'a mut QualificationRunRecord> {
    s.qualification_runs
        .get_mut(id)
        .filter(|r| r.owner_principal_id == p.owner_principal_id && r.host_id == p.host_id)
        .ok_or_else(|| refused("managed_desktop_qualification_not_found"))
}
fn running(r: &QualificationRunRecord) -> Result<()> {
    if r.run.state != QualificationRunState::Running {
        return Err(refused("managed_desktop_qualification_not_awaiting"));
    }
    Ok(())
}
impl ManagedDesktopService {
    pub fn qualification_notifications(&self, id: &str) -> tokio::sync::watch::Receiver<u64> {
        self.qualification_changes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id.into())
            .or_insert_with(|| tokio::sync::watch::channel(0).0)
            .subscribe()
    }
    fn qualification_changed(&self, id: &str) {
        if let Some(changed) = self
            .qualification_changes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
        {
            changed.send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
    }

    pub async fn qualification_start(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        scope: QualificationScope,
        handoff: Option<QualificationHandoff>,
    ) -> Result<ManagedDesktopQualificationRun> {
        p.require_admin()?;
        self.scope(p)?;
        if let Some(handoff) = &handoff {
            handoff.validate()?;
        }
        if scope == QualificationScope::Acceptance && handoff.is_none() {
            return Err(refused("managed_desktop_handoff_delivery_unknown"));
        }
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let run = self
            .transaction(|s, now| {
                if s.qualification_runs
                    .values()
                    .any(|r| r.host_id == p.host_id && r.run.state.active())
                {
                    return Err(refused("managed_desktop_qualification_running"));
                }
                // Retain the last 20 terminal runs per owner. Active runs and any
                // record still owning cleanup are never evicted.
                let mut finished: Vec<_> = s
                    .qualification_runs
                    .values()
                    .filter(|r| {
                        r.owner_principal_id == p.owner_principal_id
                            && !r.run.state.active()
                            && r.authority_device.is_none()
                            && r.handoff_operations.is_empty()
                            && r.desktop_ids.iter().all(|id| {
                                s.desktops.get(id).is_none_or(|d| {
                                    d.desktop.state == ManagedDesktopState::Destroyed
                                })
                            })
                    })
                    .map(|r| (r.run.started_at, r.run.run_id.clone()))
                    .collect();
                finished.sort();
                let remove = finished.len().saturating_sub(19);
                for (_, id) in finished.into_iter().take(remove) {
                    s.qualification_runs.remove(&id);
                }
                let run = ManagedDesktopQualificationRun {
                    run_id: Uuid::new_v4().to_string(),
                    provider_config_id: config_id.into(),
                    config_revision: config.revision,
                    scope,
                    state: QualificationRunState::Running,
                    current_category: None,
                    awaiting_approval: None,
                    categories: QUALIFICATION_CATEGORIES
                        .iter()
                        .take(if scope == QualificationScope::Gui {
                            4
                        } else {
                            6
                        })
                        .map(|category| QualificationCategoryResult {
                            category: *category,
                            state: QualificationCategoryState::Pending,
                            error_code: None,
                        })
                        .collect(),
                    handoff,
                    error_code: None,
                    started_at: now,
                    updated_at: now,
                    finished_at: None,
                };
                s.qualification_runs.insert(
                    run.run_id.clone(),
                    QualificationRunRecord {
                        run: run.clone(),
                        owner_principal_id: p.owner_principal_id.clone(),
                        host_id: p.host_id.clone(),
                        principal_id: p.principal_id.clone(),
                        binding_digest: config.binding_digest(),
                        approved_quotes: BTreeSet::new(),
                        desktop_ids: BTreeSet::new(),
                        authority_device: None,
                        handoff_operations: BTreeSet::new(),
                    },
                );
                Ok(run)
            })
            .await?;
        let mut epochs = self
            .qualification_live
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        epochs.retain(|_, live| live.load(std::sync::atomic::Ordering::SeqCst));
        epochs.insert(
            run.run_id.clone(),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
        );
        Ok(run)
    }
    pub async fn qualification_status(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> Result<ManagedDesktopQualificationRun> {
        self.scope(p)?;
        let s = self.state.lock().await;
        s.qualification_runs
            .get(id)
            .filter(|r| r.owner_principal_id == p.owner_principal_id && r.host_id == p.host_id)
            .map(|r| r.run.clone())
            .ok_or_else(|| refused("managed_desktop_qualification_not_found"))
    }
    pub async fn qualification_list(
        &self,
        p: &ManagedDesktopPrincipal,
    ) -> Result<Vec<ManagedDesktopQualificationRun>> {
        self.scope(p)?;
        let mut runs: Vec<_> = self
            .state
            .lock()
            .await
            .qualification_runs
            .values()
            .filter(|r| r.owner_principal_id == p.owner_principal_id && r.host_id == p.host_id)
            .map(|r| r.run.clone())
            .collect();
        runs.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then(b.run_id.cmp(&a.run_id))
        });
        Ok(runs)
    }
    pub async fn qualification_category(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        kind: NativeQualificationKind,
        state: QualificationCategoryState,
    ) -> Result<()> {
        let config_id = self.qualification_status(p, id).await?.provider_config_id;
        let config = self.config(p, &config_id).await?;
        self.admission(&config, self.now().await)?;
        self.transaction(|s, now| {
            let r = row(s, p, id)?;
            running(r)?;
            if r.binding_digest != config.binding_digest() {
                return Err(refused("managed_desktop_quote_expired"));
            }
            let category = r
                .run
                .categories
                .iter_mut()
                .find(|c| c.category == kind)
                .ok_or_else(|| refused("managed_desktop_qualification_invalid"))?;
            category.state = state;
            r.run.current_category = Some(kind);
            r.run.updated_at = now;
            Ok(())
        })
        .await
    }
    pub async fn qualification_await_quote(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        quote: ManagedDesktopQuote,
        purpose: AuthorizationPurpose,
    ) -> Result<()> {
        if !matches!(
            purpose,
            AuthorizationPurpose::PrepareTemplate | AuthorizationPurpose::Smoke
        ) {
            return Err(refused("managed_desktop_qualification_invalid"));
        }
        self.transaction(|s, now| {
            let r = row(s, p, id)?;
            running(r)?;
            if quote.binding_digest != r.binding_digest
                || quote.owner_principal_id != r.owner_principal_id
                || quote.provider_config_id != r.run.provider_config_id
                || quote.expires_at <= now
            {
                return Err(refused("managed_desktop_quote_expired"));
            }
            r.run.awaiting_approval = Some(QualificationApproval {
                quote,
                template_build_charges: purpose == AuthorizationPurpose::PrepareTemplate,
                purpose,
            });
            r.run.state = QualificationRunState::AwaitingApproval;
            r.run.updated_at = now;
            Ok(())
        })
        .await
    }
    pub async fn qualification_approve(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        quote_id: &str,
    ) -> Result<ManagedDesktopQualificationRun> {
        p.require_admin()?;
        let run = self.qualification_status(p, id).await?;
        let config = self.config(p, &run.provider_config_id).await?;
        self.admission(&config, self.now().await)?;
        let result = self
            .transaction(|s, now| {
                let r = row(s, p, id)?;
                if r.run.state != QualificationRunState::AwaitingApproval {
                    return Err(refused("managed_desktop_qualification_not_awaiting"));
                }
                let approval = r
                    .run
                    .awaiting_approval
                    .as_ref()
                    .ok_or_else(|| refused("managed_desktop_qualification_not_awaiting"))?;
                if approval.quote.id != quote_id {
                    return Err(refused("managed_desktop_qualification_quote_mismatch"));
                }
                if approval.quote.expires_at <= now || config.binding_digest() != r.binding_digest {
                    return Err(refused("managed_desktop_quote_expired"));
                }
                r.approved_quotes.insert(quote_id.into());
                r.run.state = QualificationRunState::Running;
                r.run.awaiting_approval = None;
                r.run.updated_at = now;
                Ok(r.run.clone())
            })
            .await?;
        self.qualification_changed(id);
        Ok(result)
    }
    pub async fn qualification_finish(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        state: QualificationRunState,
        error: Option<String>,
    ) -> Result<ManagedDesktopQualificationRun> {
        if !matches!(
            state,
            QualificationRunState::Passed
                | QualificationRunState::Failed
                | QualificationRunState::Cancelled
        ) {
            return Err(refused("managed_desktop_qualification_invalid"));
        }
        let run = self
            .transaction(|s, now| {
                let r = row(s, p, id)?;
                if !r.run.state.active() {
                    if r.run.state == state && r.run.error_code.is_none() && error.is_some() {
                        r.run.error_code = error;
                        r.run.updated_at = now;
                    }
                    return Ok(r.run.clone());
                }
                if state == QualificationRunState::Passed
                    && r.run
                        .categories
                        .iter()
                        .any(|c| c.state != QualificationCategoryState::Passed)
                {
                    return Err(refused("managed_desktop_qualification_invalid"));
                }
                for c in &mut r.run.categories {
                    if c.state == QualificationCategoryState::Running {
                        c.state = if state == QualificationRunState::Failed {
                            QualificationCategoryState::Failed
                        } else {
                            QualificationCategoryState::Skipped
                        };
                        c.error_code = error.clone();
                    } else if c.state == QualificationCategoryState::Pending {
                        c.state = QualificationCategoryState::Skipped;
                    }
                }
                r.run.state = state;
                r.run.error_code = error;
                r.run.awaiting_approval = None;
                r.run.updated_at = now;
                r.run.finished_at = Some(now);
                let result = r.run.clone();
                let ids = r.desktop_ids.clone();
                for id in ids {
                    if let Some(desktop) = s.desktops.get_mut(&id) {
                        if desktop.desktop.state != ManagedDesktopState::Destroyed {
                            desktop.delete_requested = true;
                            desktop.next_retry_at = now;
                        }
                    }
                }
                Ok(result)
            })
            .await?;
        if let Some(epoch) = self
            .qualification_live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
        {
            epoch.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        self.qualification_changed(id);
        Ok(run)
    }
    pub async fn cleanup_diagnostic_source(
        &self,
        p: &ManagedDesktopPrincipal,
        source: &str,
    ) -> Result<()> {
        p.require_admin()?;
        let rows = self
            .state
            .lock()
            .await
            .desktops
            .values()
            .filter(|r| {
                r.smoke
                    && r.config.owner_principal_id == p.owner_principal_id
                    && r.config.host_id == p.host_id
                    && r.source_id.as_deref() == Some(source)
            })
            .map(|r| r.desktop.clone())
            .collect::<Vec<_>>();
        let mut pending = false;
        for row in rows {
            if !self
                .delete(p, &row.id, row.generation)
                .await
                .is_ok_and(|d| d.state == ManagedDesktopState::Destroyed)
            {
                pending = true;
            }
        }
        if pending {
            Err(retryable("managed_desktop_smoke_cleanup_pending"))
        } else {
            Ok(())
        }
    }
    pub async fn qualification_cleanup(&self, p: &ManagedDesktopPrincipal, id: &str) -> Result<()> {
        let desktops = {
            let mut state = self.state.lock().await;
            let ids = row(&mut state, p, id)?.desktop_ids.clone();
            ids.into_iter()
                .filter_map(|id| state.desktops.get(&id).cloned())
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for record in desktops {
            let result = match record.config.authorize(p) {
                Ok(()) => self
                    .delete(p, &record.desktop.id, record.desktop.generation)
                    .await
                    .and_then(|d| {
                        if d.state == ManagedDesktopState::Destroyed {
                            Ok(())
                        } else {
                            Err(retryable("managed_desktop_smoke_cleanup_pending"))
                        }
                    }),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub async fn qualification_device(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        device: Option<(String, String)>,
    ) -> Result<()> {
        self.transaction(|s, _| {
            let run = row(s, p, id)?;
            if device.is_some() {
                running(run)?;
            }
            run.authority_device = device;
            Ok(())
        })
        .await
    }
    pub async fn qualification_handoff_operation(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        operation: &str,
        pending: bool,
    ) -> Result<()> {
        self.transaction(|state, _| {
            let record = row(state, p, id)?;
            if pending {
                running(record)?;
                record.handoff_operations.insert(operation.into());
            } else {
                record.handoff_operations.remove(operation);
            }
            Ok(())
        })
        .await
    }
    pub async fn qualification_orphan_handoffs(
        &self,
    ) -> Vec<(String, String, ManagedDesktopPrincipal)> {
        self.state
            .lock()
            .await
            .qualification_runs
            .values()
            .filter(|r| !r.run.state.active())
            .flat_map(|r| {
                r.handoff_operations.iter().map(|operation| {
                    (
                        r.run.run_id.clone(),
                        operation.clone(),
                        ManagedDesktopPrincipal {
                            owner_principal_id: r.owner_principal_id.clone(),
                            principal_id: r.principal_id.clone(),
                            host_id: r.host_id.clone(),
                            authority: ManagedDesktopAuthority::Administrator,
                        },
                    )
                })
            })
            .collect()
    }
    pub async fn qualification_orphan_devices(
        &self,
    ) -> Vec<(String, String, String, ManagedDesktopPrincipal)> {
        self.state
            .lock()
            .await
            .qualification_runs
            .values()
            .filter(|r| !r.run.state.active())
            .filter_map(|r| {
                r.authority_device.clone().map(|(tenant, device)| {
                    (
                        r.run.run_id.clone(),
                        tenant,
                        device,
                        ManagedDesktopPrincipal {
                            owner_principal_id: r.owner_principal_id.clone(),
                            principal_id: r.principal_id.clone(),
                            host_id: r.host_id.clone(),
                            authority: ManagedDesktopAuthority::Administrator,
                        },
                    )
                })
            })
            .collect()
    }
}

pub(super) fn quote_admitted(s: &ManagedDesktopJournal, quote: &str) -> Result<()> {
    for r in s.qualification_runs.values() {
        if r.run
            .awaiting_approval
            .as_ref()
            .is_some_and(|a| a.quote.id == quote)
            || (r.approved_quotes.contains(quote) && r.run.state != QualificationRunState::Running)
        {
            return Err(refused("managed_desktop_qualification_not_awaiting"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    #[tokio::test]
    async fn run_state_machine_requires_the_exact_run_quote_and_all_categories() {
        let f = Fixture::new();
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        assert_eq!(run.state, QualificationRunState::Running);
        assert_eq!(run.categories.len(), 4);
        assert_eq!(
            f.service
                .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_running"
        );
        let quote = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        f.service
            .qualification_await_quote(
                &f.p,
                &run.run_id,
                quote.clone(),
                AuthorizationPurpose::PrepareTemplate,
            )
            .await
            .unwrap();
        let awaiting = f
            .service
            .qualification_status(&f.p, &run.run_id)
            .await
            .unwrap();
        assert_eq!(awaiting.state, QualificationRunState::AwaitingApproval);
        assert!(awaiting.awaiting_approval.unwrap().template_build_charges);
        assert_eq!(
            f.service
                .qualification_approve(&f.p, "wrong-run", &quote.id)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_not_found"
        );
        assert_eq!(
            f.service
                .qualification_approve(&f.p, &run.run_id, "wrong-quote")
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_quote_mismatch"
        );
        assert_eq!(
            f.service
                .authorize(
                    &f.p,
                    "e2b",
                    &quote.id,
                    AuthorizationPurpose::PrepareTemplate,
                    None
                )
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_not_awaiting"
        );
        assert_eq!(
            f.service
                .qualification_approve(&f.p, &run.run_id, &quote.id)
                .await
                .unwrap()
                .state,
            QualificationRunState::Running
        );
        assert_eq!(
            f.service
                .qualification_approve(&f.p, &run.run_id, &quote.id)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_not_awaiting"
        );
        assert!(f
            .service
            .qualification_finish(&f.p, &run.run_id, QualificationRunState::Passed, None)
            .await
            .is_err());
        for c in &run.categories {
            f.service
                .qualification_category(
                    &f.p,
                    &run.run_id,
                    c.category,
                    QualificationCategoryState::Running,
                )
                .await
                .unwrap();
            f.service
                .qualification_category(
                    &f.p,
                    &run.run_id,
                    c.category,
                    QualificationCategoryState::Passed,
                )
                .await
                .unwrap();
        }
        let passed = f
            .service
            .qualification_finish(&f.p, &run.run_id, QualificationRunState::Passed, None)
            .await
            .unwrap();
        assert_eq!(passed.state, QualificationRunState::Passed);
        assert!(passed.finished_at.is_some());
        assert!(
            !f.service.list_configs(&f.p).await.unwrap()[0]
                .enablement
                .manual_gui,
            "run labels are never qualification evidence"
        );
    }
    #[tokio::test]
    async fn cancellation_destroys_only_the_runs_desktops_and_fences_approved_quotes() {
        let f = Fixture::new();
        f.prepare().await;
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let quote = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        f.service
            .qualification_await_quote(
                &f.p,
                &run.run_id,
                quote.clone(),
                AuthorizationPurpose::Smoke,
            )
            .await
            .unwrap();
        f.service
            .qualification_approve(&f.p, &run.run_id, &quote.id)
            .await
            .unwrap();
        let auth = f
            .service
            .authorize(
                &f.p,
                "e2b",
                &quote.id,
                AuthorizationPurpose::Smoke,
                Some("diagnostic".into()),
            )
            .await
            .unwrap();
        let desktop = f
            .service
            .create_smoke(
                &f.p,
                CreateManagedDesktop {
                    provider_config_id: "e2b".into(),
                    quote_id: quote.id.clone(),
                    authorization_id: auth.id,
                    idempotency_key: "diagnostic".into(),
                },
            )
            .await
            .unwrap();
        let unrelated = f.smoke("unrelated").await;
        f.service
            .qualification_finish(&f.p, &run.run_id, QualificationRunState::Cancelled, None)
            .await
            .unwrap();
        f.provider
            .fail_delete
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let cleanup = f
            .service
            .qualification_cleanup(&f.p, &run.run_id)
            .await
            .unwrap_err();
        let pending = f
            .service
            .qualification_finish(
                &f.p,
                &run.run_id,
                QualificationRunState::Cancelled,
                Some(cleanup.code),
            )
            .await
            .unwrap();
        assert_eq!(pending.state, QualificationRunState::Cancelled);
        assert_eq!(
            pending.error_code.as_deref(),
            Some("managed_desktop_smoke_cleanup_pending")
        );
        f.provider
            .fail_delete
            .store(false, std::sync::atomic::Ordering::SeqCst);
        f.service
            .qualification_cleanup(&f.p, &run.run_id)
            .await
            .unwrap();
        assert_eq!(
            f.service
                .scoped(&f.p, &desktop.id, 1)
                .await
                .unwrap()
                .desktop
                .state,
            ManagedDesktopState::Destroyed
        );
        assert_eq!(
            f.service
                .scoped(&f.p, &unrelated.id, 1)
                .await
                .unwrap()
                .desktop
                .state,
            ManagedDesktopState::Running
        );
        assert!(f
            .service
            .authorize(&f.p, "e2b", &quote.id, AuthorizationPurpose::Smoke, None)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn restart_interrupts_and_journals_cleanup_instead_of_resuming() {
        let f = Fixture::new();
        f.prepare().await;
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        f.service
            .qualification_category(
                &f.p,
                &run.run_id,
                NativeQualificationKind::Lifecycle,
                QualificationCategoryState::Running,
            )
            .await
            .unwrap();
        let quote = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        f.service
            .qualification_await_quote(
                &f.p,
                &run.run_id,
                quote.clone(),
                AuthorizationPurpose::Smoke,
            )
            .await
            .unwrap();
        f.service
            .qualification_approve(&f.p, &run.run_id, &quote.id)
            .await
            .unwrap();
        let auth = f
            .service
            .authorize(&f.p, "e2b", &quote.id, AuthorizationPurpose::Smoke, None)
            .await
            .unwrap();
        let desktop = f
            .service
            .create_smoke(
                &f.p,
                CreateManagedDesktop {
                    provider_config_id: "e2b".into(),
                    quote_id: quote.id,
                    authorization_id: auth.id,
                    idempotency_key: "interrupted".into(),
                },
            )
            .await
            .unwrap();
        // Checkpoint never applies restart recovery to a running service.
        f.service.diagnostic_checkpoint().await.unwrap();
        assert_eq!(
            f.service
                .qualification_status(&f.p, &run.run_id)
                .await
                .unwrap()
                .state,
            QualificationRunState::Running
        );
        drop(f.service);
        let reopened = ManagedDesktopService::open(
            f.directory.path(),
            "host".into(),
            f.provider.clone(),
            f.secrets.clone(),
            Some(f.config.release),
        )
        .unwrap();
        let restored = reopened
            .qualification_status(&f.p, &run.run_id)
            .await
            .unwrap();
        assert_eq!(restored.state, QualificationRunState::Interrupted);
        assert_eq!(
            restored.categories[0].state,
            QualificationCategoryState::Failed
        );
        assert!(restored.awaiting_approval.is_none());
        assert!(
            reopened
                .scoped(&f.p, &desktop.id, 1)
                .await
                .unwrap()
                .delete_requested
        );
        reopened.reconcile().await.unwrap();
        assert_eq!(
            reopened
                .scoped(&f.p, &desktop.id, 1)
                .await
                .unwrap()
                .desktop
                .state,
            ManagedDesktopState::Destroyed
        );
    }
    #[tokio::test]
    async fn failure_records_the_category_and_history_is_bounded_and_owner_scoped() {
        let f = Fixture::new();
        for _ in 0..23 {
            let run = f
                .service
                .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
                .await
                .unwrap();
            f.service
                .qualification_category(
                    &f.p,
                    &run.run_id,
                    NativeQualificationKind::Control,
                    QualificationCategoryState::Running,
                )
                .await
                .unwrap();
            let failed = f
                .service
                .qualification_finish(
                    &f.p,
                    &run.run_id,
                    QualificationRunState::Failed,
                    Some("managed_desktop_control_smoke_failed".into()),
                )
                .await
                .unwrap();
            assert_eq!(
                failed.categories[1].state,
                QualificationCategoryState::Failed
            );
        }
        assert_eq!(f.service.qualification_list(&f.p).await.unwrap().len(), 20);
        let mut foreign = f.p.clone();
        foreign.owner_principal_id = "other".into();
        assert!(f
            .service
            .qualification_list(&foreign)
            .await
            .unwrap()
            .is_empty());
        for authority in [
            ManagedDesktopAuthority::Agent,
            ManagedDesktopAuthority::Human,
            ManagedDesktopAuthority::Observer,
        ] {
            let mut denied = f.p.clone();
            denied.authority = authority;
            assert!(f
                .service
                .qualification_start(&denied, "e2b", QualificationScope::Gui, None)
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn one_active_run_per_host_and_diagnostic_reconcile_is_run_scoped() {
        let f = Fixture::new();
        f.prepare().await;
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let mut registry = f.service.registry().await.unwrap();
        let mut other = f.config.clone();
        other.id = "second".into();
        registry.providers.push(other);
        f.service.save_registry(registry).await.unwrap();
        assert_eq!(
            f.service
                .qualification_start(&f.p, "second", QualificationScope::Gui, None)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_running"
        );
        let first = f.smoke("first-run").await;
        let other = f.smoke("unrelated-held").await;
        f.service
            .transaction(|s, _| {
                s.qualification_runs
                    .get_mut(&run.run_id)
                    .unwrap()
                    .desktop_ids
                    .insert(first.id.clone());
                Ok(())
            })
            .await
            .unwrap();
        f.clock
            .store(first.deadline_at + 1, std::sync::atomic::Ordering::SeqCst);
        f.service
            .diagnostic_holds
            .lock()
            .unwrap()
            .insert(other.id.clone());
        let diagnostic = f
            .service
            .qualification_handle(f.provider.clone(), &run.run_id);
        diagnostic.reconcile().await.unwrap();
        assert_eq!(
            f.service
                .scoped(&f.p, &first.id, first.generation)
                .await
                .unwrap()
                .desktop
                .state,
            ManagedDesktopState::Destroyed
        );
        assert_eq!(
            f.service
                .scoped(&f.p, &other.id, other.generation)
                .await
                .unwrap()
                .desktop
                .state,
            ManagedDesktopState::Running
        );
    }
    #[tokio::test]
    async fn cancelled_run_cannot_publish_a_new_device_and_approval_notifies_without_polling() {
        let f = Fixture::new();
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let mut changed = f.service.qualification_notifications(&run.run_id);
        let quote = f.service.quote(&f.p, "e2b", 120).await.unwrap();
        f.service
            .qualification_await_quote(
                &f.p,
                &run.run_id,
                quote.clone(),
                AuthorizationPurpose::Smoke,
            )
            .await
            .unwrap();
        assert!(!changed.has_changed().unwrap());
        f.service
            .qualification_approve(&f.p, &run.run_id, &quote.id)
            .await
            .unwrap();
        changed.changed().await.unwrap();
        assert!(!changed.has_changed().unwrap());
        f.service
            .qualification_finish(&f.p, &run.run_id, QualificationRunState::Cancelled, None)
            .await
            .unwrap();
        changed.changed().await.unwrap();
        assert_eq!(
            f.service
                .qualification_device(&f.p, &run.run_id, Some(("tenant".into(), "device".into())))
                .await
                .unwrap_err()
                .code,
            "managed_desktop_qualification_not_awaiting"
        );
        assert!(f.service.qualification_orphan_devices().await.is_empty());
    }
    #[tokio::test]
    async fn cleanup_uses_each_generation_and_attempts_all_desktops_after_an_error() {
        let f = Fixture::new();
        f.prepare().await;
        let run = f
            .service
            .qualification_start(&f.p, "e2b", QualificationScope::Gui, None)
            .await
            .unwrap();
        let first = f.smoke("cleanup-first").await;
        let second = f.smoke("cleanup-second").await;
        f.service
            .transaction(|s, _| {
                s.desktops.get_mut(&first.id).unwrap().desktop.generation = 2;
                s.desktops.get_mut(&second.id).unwrap().desktop.generation = 3;
                s.qualification_runs
                    .get_mut(&run.run_id)
                    .unwrap()
                    .desktop_ids
                    .extend([first.id.clone(), second.id.clone()]);
                Ok(())
            })
            .await
            .unwrap();
        f.provider
            .fail_delete
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(f
            .service
            .qualification_cleanup(&f.p, &run.run_id)
            .await
            .is_err());
        for (id, generation) in [(&first.id, 2), (&second.id, 3)] {
            assert!(
                f.service
                    .scoped(&f.p, id, generation)
                    .await
                    .unwrap()
                    .delete_requested
            );
        }
    }
    #[test]
    fn qualification_scripts_use_the_closed_npm_script_shape() {
        for script in [
            "dev",
            "test:e2e",
            "build.preview",
            "_private",
            ":script",
            &"a".repeat(100),
        ] {
            QualificationHandoff {
                delivery_id: "delivery".into(),
                script: script.into(),
            }
            .validate()
            .unwrap();
        }
        for script in [
            "",
            "dev && curl x",
            "../run/script",
            "two words",
            "-script",
            "--prefix",
            ".hidden",
            &"a".repeat(101),
        ] {
            assert_eq!(
                QualificationHandoff {
                    delivery_id: "delivery".into(),
                    script: script.into()
                }
                .validate()
                .unwrap_err()
                .code,
                "managed_desktop_handoff_script_invalid"
            );
        }
    }
}
