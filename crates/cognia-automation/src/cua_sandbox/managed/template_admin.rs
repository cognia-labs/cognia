//! Explicit template cleanup and the billing/cleanup monitor (ADR-0233
//! amendment A7).
//!
//! Templates are never deleted implicitly (§2). Deleting one marks the record
//! `Deleting` first; the record and the key generation that created it stay
//! until the provider reports the template absent, retried with the same
//! backoff as desktop cleanup.
use super::*;
use std::collections::BTreeMap;

impl ManagedDesktopService {
    pub async fn list_templates(
        &self,
        p: &ManagedDesktopPrincipal,
    ) -> Result<Vec<ManagedDesktopTemplateSummary>> {
        self.scope(p)?;
        let state = self.state.lock().await;
        let mut templates: Vec<_> = state
            .templates
            .values()
            .filter(|t| t.config.owner_principal_id == p.owner_principal_id)
            .map(|t| ManagedDesktopTemplateSummary {
                id: t.id.clone(),
                provider_config_id: t.config.id.clone(),
                state: t.state.clone(),
                identity: t.identity.clone(),
                desktops_in_use: template_users(&state, t),
                created_at: t.created_at,
                updated_at: t.updated_at,
                error_code: t.error_code.clone(),
                cleanup_attempts: t.cleanup_attempts,
                next_retry_at: (t.state == TemplateState::Deleting).then_some(t.next_retry_at),
            })
            .collect();
        templates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(templates)
    }

    /// Requests deletion of one template. Refused while a live desktop was
    /// created from it, or while its build outcome is still unknown. Returns
    /// `None` once the provider confirmed absence; otherwise the `Deleting`
    /// record, whose failed attempt is retried by the reconciler.
    pub async fn delete_template(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> Result<Option<ManagedDesktopTemplateSummary>> {
        p.require_admin()?;
        self.scope(p)?;
        validate_id(id)?;
        {
            let _templates = self.template_operations.lock().await;
            self.transaction(|s, now| {
                let row = s
                    .templates
                    .get(id)
                    .filter(|t| t.config.owner_principal_id == p.owner_principal_id)
                    .ok_or_else(|| refused("managed_desktop_template_not_found"))?;
                if row.state == TemplateState::Registering {
                    return Err(refused("managed_desktop_template_outcome_unknown"));
                }
                if template_users(s, row) > 0 {
                    return Err(refused("managed_desktop_template_in_use"));
                }
                let row = s.templates.get_mut(id).expect("checked above");
                if row.state != TemplateState::Deleting {
                    row.state = TemplateState::Deleting;
                    row.deletion_requested_at = Some(now);
                    row.cleanup_attempts = 0;
                    row.next_retry_at = now;
                    row.updated_at = now;
                }
                Ok(())
            })
            .await?;
        }
        // A failed first attempt is recorded on the row and retried; the
        // caller sees the pending state, not a lost request.
        if let Err(error) = self.reconcile_template_deletion(id).await {
            log::warn!("managed desktop template deletion: {}", error.code);
        }
        Ok(self
            .list_templates(p)
            .await?
            .into_iter()
            .find(|t| t.id == id))
    }

    /// Retries every due template deletion. Called from `reconcile`.
    pub(super) async fn reconcile_template_deletions(&self) -> Result<()> {
        let now = self.now().await;
        let due: Vec<String> = self
            .state
            .lock()
            .await
            .templates
            .values()
            .filter(|t| t.state == TemplateState::Deleting && t.next_retry_at <= now)
            .map(|t| t.id.clone())
            .collect();
        let mut first = None;
        for id in due {
            if let Err(error) = self.reconcile_template_deletion(&id).await {
                first.get_or_insert(error);
            }
        }
        first.map_or(Ok(()), Err)
    }

    async fn reconcile_template_deletion(&self, id: &str) -> Result<()> {
        let Some(row) = self.state.lock().await.templates.get(id).cloned() else {
            return Ok(());
        };
        if row.state != TemplateState::Deleting {
            return Ok(());
        }
        // A registration that never returned an ID created nothing to delete.
        let Some(identity) = row.identity.clone() else {
            return self.forget_template(id).await;
        };
        let outcome = match self.secrets.provider_key(&row.config).await {
            Ok(key) => {
                self.provider
                    .delete_template(&row.config, &key, &identity.template_id)
                    .await
            }
            Err(error) => Err(error),
        };
        match outcome {
            Ok(_) => self.forget_template(id).await,
            Err(error) => {
                self.transaction(|s, now| {
                    if let Some(r) = s.templates.get_mut(id) {
                        r.cleanup_attempts = r.cleanup_attempts.saturating_add(1);
                        r.error_code = Some(error.code.clone());
                        r.updated_at = now;
                        r.next_retry_at = now.saturating_add(cleanup_delay(r.cleanup_attempts));
                    }
                    Ok(())
                })
                .await?;
                Err(error)
            }
        }
    }

    /// Removes every record of the same provider template: deleting a template
    /// deletes all of its builds, so no sibling record may survive it.
    async fn forget_template(&self, id: &str) -> Result<()> {
        self.transaction(|s, _| {
            let template_id = s
                .templates
                .get(id)
                .and_then(|t| t.identity.as_ref().map(|i| i.template_id.clone()));
            s.templates.retain(|key, t| {
                key != id
                    && (template_id.is_none()
                        || t.identity.as_ref().map(|i| &i.template_id) != template_id.as_ref())
            });
            Ok(())
        })
        .await
    }

    /// Billing exposure, pending operations and §5 alerts for one owner.
    pub async fn monitor(&self, p: &ManagedDesktopPrincipal) -> Result<ManagedDesktopMonitor> {
        self.scope(p)?;
        let now = self.now().await;
        let state = self.state.lock().await;
        Ok(monitor_of(&state, &p.owner_principal_id, now))
    }

    /// Every owner's monitor; the Host worker publishes it when it changes.
    pub async fn monitors(&self) -> BTreeMap<String, ManagedDesktopMonitor> {
        let now = self.now().await;
        let state = self.state.lock().await;
        let owners: std::collections::BTreeSet<String> = state
            .desktops
            .values()
            .map(|d| d.config.owner_principal_id.clone())
            .chain(state.templates.values().map(|t| t.config.owner_principal_id.clone()))
            .collect();
        owners
            .into_iter()
            .map(|owner| {
                let monitor = monitor_of(&state, &owner, now);
                (owner, monitor)
            })
            .collect()
    }
}

/// Live desktops created from the same provider template as `template`.
fn template_users(state: &ManagedDesktopJournal, template: &TemplateRecord) -> u32 {
    let Some(identity) = template.identity.as_ref() else {
        return 0;
    };
    state
        .desktops
        .values()
        .filter(|d| {
            d.desktop.state != ManagedDesktopState::Destroyed
                && d.template.template_id == identity.template_id
        })
        .count() as u32
}

/// The desktop cleanup backoff (§5): 15 s doubling to at most 600 s.
fn cleanup_delay(attempts: u32) -> i64 {
    15_000i64
        .saturating_mul(1i64 << attempts.saturating_sub(1).min(6))
        .min(600_000)
}

fn monitor_of(state: &ManagedDesktopJournal, owner: &str, now: i64) -> ManagedDesktopMonitor {
    let mut monitor = ManagedDesktopMonitor {
        observed_at: now,
        billed_desktops: 0,
        maximum_exposure_micros: BTreeMap::new(),
        oldest_pending_create_at: None,
        oldest_pending_delete_at: None,
        alerts: Vec::new(),
    };
    let oldest = |slot: &mut Option<i64>, at: i64| *slot = Some(slot.map_or(at, |s| s.min(at)));
    for row in state.desktops.values() {
        if row.config.owner_principal_id != owner
            || row.desktop.state == ManagedDesktopState::Destroyed
        {
            continue;
        }
        monitor.billed_desktops += 1;
        // Billing runs until the provider TTL at the latest; an overdue
        // resource is still exposed by its alert, not by a negative estimate.
        let remaining_ms = u64::try_from(row.desktop.deadline_at.saturating_sub(now)).unwrap_or(0);
        let exposure = u128::from(row.config.price.hourly_rate_micros) * u128::from(remaining_ms)
            / 3_600_000;
        let total = monitor
            .maximum_exposure_micros
            .entry(row.config.price.currency.clone())
            .or_default();
        *total = total.saturating_add(u64::try_from(exposure).unwrap_or(u64::MAX));
        if row.desktop.state == ManagedDesktopState::Creating {
            oldest(&mut monitor.oldest_pending_create_at, row.desktop.created_at);
        }
        if let Some(requested) = row.cleanup_requested_at {
            oldest(&mut monitor.oldest_pending_delete_at, requested);
            if now.saturating_sub(requested) > ALERT_CLEANUP_STALLED_MS {
                monitor.alerts.push(ManagedDesktopAlert {
                    kind: ManagedDesktopAlertKind::CleanupStalled,
                    subject_id: row.desktop.id.clone(),
                    provider_config_id: row.config.id.clone(),
                    since: requested,
                });
            }
        }
        if now.saturating_sub(row.desktop.deadline_at) > ALERT_PAST_DEADLINE_MS {
            monitor.alerts.push(ManagedDesktopAlert {
                kind: ManagedDesktopAlertKind::PastDeadline,
                subject_id: row.desktop.id.clone(),
                provider_config_id: row.config.id.clone(),
                since: row.desktop.deadline_at,
            });
        }
    }
    for template in state.templates.values() {
        if template.config.owner_principal_id != owner || template.state != TemplateState::Deleting {
            continue;
        }
        let since = template.deletion_requested_at.unwrap_or(template.updated_at);
        if now.saturating_sub(since) > ALERT_CLEANUP_STALLED_MS {
            monitor.alerts.push(ManagedDesktopAlert {
                kind: ManagedDesktopAlertKind::TemplateCleanupStalled,
                subject_id: template.id.clone(),
                provider_config_id: template.config.id.clone(),
                since,
            });
        }
    }
    monitor.alerts.sort_by(|a, b| (a.kind, &a.subject_id).cmp(&(b.kind, &b.subject_id)));
    monitor
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    use std::sync::atomic::Ordering;

    async fn template_id(f: &Fixture) -> String {
        f.service.list_templates(&f.p).await.unwrap()[0].id.clone()
    }

    #[tokio::test]
    async fn deletion_waits_for_live_desktops_and_removes_after_absence() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("live").await;
        let id = template_id(&f).await;
        let listed = &f.service.list_templates(&f.p).await.unwrap()[0];
        assert_eq!(listed.desktops_in_use, 1);
        assert_eq!(listed.state, TemplateState::Ready);
        assert_eq!(
            f.service.delete_template(&f.p, &id).await.unwrap_err().code,
            "managed_desktop_template_in_use"
        );
        f.service.delete(&f.p, &desktop.id, desktop.generation).await.unwrap();
        assert_eq!(f.service.delete_template(&f.p, &id).await.unwrap(), None);
        assert!(f.service.list_templates(&f.p).await.unwrap().is_empty());
        let identity = desktop_template(&f, &desktop.id).await;
        assert!(f
            .provider
            .deleted_templates
            .lock()
            .unwrap()
            .contains(&identity.template_id));
    }

    async fn desktop_template(f: &Fixture, id: &str) -> TemplateIdentity {
        f.service.state.lock().await.desktops[id].template.clone()
    }

    #[tokio::test]
    async fn a_failed_deletion_keeps_the_record_and_retries_with_backoff() {
        let f = Fixture::new();
        f.prepare().await;
        let id = template_id(&f).await;
        f.provider.fail_template_delete.store(true, Ordering::SeqCst);
        let pending = f.service.delete_template(&f.p, &id).await.unwrap().unwrap();
        assert_eq!(pending.state, TemplateState::Deleting);
        assert_eq!(pending.cleanup_attempts, 1);
        assert_eq!(
            pending.error_code.as_deref(),
            Some("managed_desktop_template_delete_failed")
        );
        let due = pending.next_retry_at.unwrap();
        assert_eq!(due, f.service.now().await + 15_000);
        // A deleting template is never chosen for new desktops.
        let digest = f.config.binding_digest();
        assert!(latest_template(&*f.service.state.lock().await, &digest).is_none());
        // Not due yet: no further attempt.
        f.service.reconcile_template_deletions().await.unwrap();
        assert_eq!(f.service.list_templates(&f.p).await.unwrap()[0].cleanup_attempts, 1);
        f.clock.store(due, Ordering::SeqCst);
        assert!(f.service.reconcile_template_deletions().await.is_err());
        let retried = &f.service.list_templates(&f.p).await.unwrap()[0];
        assert_eq!(retried.cleanup_attempts, 2);
        assert_eq!(retried.next_retry_at, Some(due + 30_000));
        f.provider.fail_template_delete.store(false, Ordering::SeqCst);
        f.clock.store(due + 30_000, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert!(f.service.list_templates(&f.p).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_the_owning_administrator_deletes_templates() {
        let f = Fixture::new();
        f.prepare().await;
        let id = template_id(&f).await;
        let human = ManagedDesktopPrincipal {
            authority: ManagedDesktopAuthority::Human,
            ..f.p.clone()
        };
        assert_eq!(
            f.service.delete_template(&human, &id).await.unwrap_err().code,
            "managed_desktop_admin_required"
        );
        let other = ManagedDesktopPrincipal {
            owner_principal_id: "other".into(),
            ..f.p.clone()
        };
        assert!(f.service.list_templates(&other).await.unwrap().is_empty());
        assert_eq!(
            f.service.delete_template(&other, &id).await.unwrap_err().code,
            "managed_desktop_template_not_found"
        );
        assert_eq!(f.service.list_templates(&f.p).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn monitor_reports_exposure_pending_cleanup_and_threshold_alerts() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("billed").await;
        let start = f.service.now().await;
        let monitor = f.service.monitor(&f.p).await.unwrap();
        assert_eq!(monitor.billed_desktops, 1);
        let remaining = desktop.deadline_at - start;
        assert_eq!(
            monitor.maximum_exposure_micros["USD"],
            (100_000u128 * remaining as u128 / 3_600_000) as u64
        );
        assert!(monitor.alerts.is_empty());
        // Past the hard deadline by more than 60 s while still recorded.
        f.provider.fail_delete.store(true, Ordering::SeqCst);
        f.clock
            .store(desktop.deadline_at + ALERT_PAST_DEADLINE_MS + 1, Ordering::SeqCst);
        let _ = f.service.reconcile().await;
        let overdue = f.service.monitor(&f.p).await.unwrap();
        assert!(overdue.alerts.iter().any(|a| a.kind == ManagedDesktopAlertKind::PastDeadline
            && a.subject_id == desktop.id));
        let requested = overdue.oldest_pending_delete_at.expect("cleanup requested");
        assert!(!overdue
            .alerts
            .iter()
            .any(|a| a.kind == ManagedDesktopAlertKind::CleanupStalled));
        // Cleanup still unconfirmed after ten minutes.
        f.clock
            .store(requested + ALERT_CLEANUP_STALLED_MS + 1, Ordering::SeqCst);
        let stalled = f.service.monitor(&f.p).await.unwrap();
        assert!(stalled
            .alerts
            .iter()
            .any(|a| a.kind == ManagedDesktopAlertKind::CleanupStalled && a.since == requested));
        assert_eq!(stalled.billed_desktops, 1);
        // Another owner sees nothing of it.
        let other = ManagedDesktopPrincipal {
            owner_principal_id: "other".into(),
            ..f.p.clone()
        };
        assert_eq!(f.service.monitor(&other).await.unwrap().billed_desktops, 0);
        let all = f.service.monitors().await;
        assert_eq!(all.keys().collect::<Vec<_>>(), vec!["owner"]);
    }
}
