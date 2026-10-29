//! Host-owned configuration and provider credentials (ADR-0233 amendment A1).
//!
//! The caller supplies only the editable draft. Owner and Host come from the
//! authenticated principal, the release from the Host's trusted manifest, and
//! revision and credential generation from the registry. Credentials are
//! write-only: nothing here returns a stored key.
use super::*;

impl ManagedDesktopService {
    /// Creates or replaces one configuration of the caller's account.
    pub async fn save_config(
        &self,
        p: &ManagedDesktopPrincipal,
        draft: ManagedDesktopConfigDraft,
    ) -> Result<ManagedDesktopConfigSummary> {
        p.require_admin()?;
        self.scope(p)?;
        validate_id(&draft.id)?;
        // Only egress Off has a qualified enforcement path (amendment A10).
        if draft.egress != DesktopEgress::Off {
            return Err(refused("managed_desktop_egress_smoke_unsupported"));
        }
        let release = self
            .trusted_release
            .clone()
            .ok_or_else(|| refused("managed_desktop_release_unavailable"))?;
        let id = draft.id.clone();
        {
            let _registry = self.config_operations.lock().await;
            let mut registry = self.registry().await?;
            let existing = registry.providers.iter().position(|c| {
                c.id == draft.id
                    && c.owner_principal_id == p.owner_principal_id
                    && c.host_id == self.host_id
            });
            let (revision, credential_generation) = match (existing, draft.expected_revision) {
                (None, None) => (1, 1),
                (Some(_), None) => return Err(refused("managed_desktop_config_exists")),
                (None, Some(_)) => return Err(refused("managed_desktop_config_not_found")),
                (Some(index), Some(expected)) => {
                    let current = &registry.providers[index];
                    if current.revision != expected {
                        return Err(refused("managed_desktop_config_revision_conflict"));
                    }
                    (expected.saturating_add(1), current.credential_generation)
                }
            };
            let now = self.now().await;
            let config = ManagedDesktopConfig {
                id: draft.id,
                owner_principal_id: p.owner_principal_id.clone(),
                host_id: self.host_id.clone(),
                revision,
                enabled: draft.enabled,
                credential_generation,
                region: None,
                shape: draft.shape,
                limits: draft.limits,
                plan: draft.plan.confirm(now),
                price: draft.price.confirm(now),
                release,
                egress: draft.egress,
                isolation_minimum: draft.isolation_minimum,
            };
            config.validate(now)?;
            match existing {
                Some(index) => registry.providers[index] = config,
                None => registry.providers.push(config),
            }
            self.save_registry(registry).await?;
        }
        self.config_summary(p, &id).await
    }

    /// Deletes a configuration that no longer owns any provider resource.
    /// Keys of every generation are removed before the registry row, so a
    /// failed removal leaves the configuration in place to retry.
    pub async fn delete_config(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        expected_revision: u64,
    ) -> Result<()> {
        p.require_admin()?;
        self.scope(p)?;
        validate_id(id)?;
        let _registry = self.config_operations.lock().await;
        let mut registry = self.registry().await?;
        let index = registry
            .providers
            .iter()
            .position(|c| {
                c.id == id && c.owner_principal_id == p.owner_principal_id && c.host_id == self.host_id
            })
            .ok_or_else(|| refused("managed_desktop_config_not_found"))?;
        let config = registry.providers[index].clone();
        if config.revision != expected_revision {
            return Err(refused("managed_desktop_config_revision_conflict"));
        }
        if self.config_in_use(&config).await {
            return Err(refused("managed_desktop_config_in_use"));
        }
        for generation in 1..=config.credential_generation {
            self.secrets
                .remove_provider_key(&RetiredCredential {
                    owner_principal_id: config.owner_principal_id.clone(),
                    config_id: config.id.clone(),
                    generation,
                })
                .await?;
        }
        registry.providers.remove(index);
        self.save_registry(registry).await?;
        // Generations retired earlier are gone with the configuration.
        self.transaction(|s, _| {
            s.retired_credentials.retain(|retired| {
                retired.owner_principal_id != config.owner_principal_id
                    || retired.config_id != config.id
            });
            Ok(())
        })
        .await
    }

    /// Stores the first provider key of a configuration's generation. A
    /// generation that already has a key changes only through rotation, which
    /// keeps the old key's cleanup authority over resources created with it.
    pub async fn set_credential(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        expected_revision: u64,
        key: ProviderSecret,
    ) -> Result<ManagedDesktopConfigSummary> {
        p.require_admin()?;
        {
            let _registry = self.config_operations.lock().await;
            let config = self.config(p, id).await?;
            if config.revision != expected_revision {
                return Err(refused("managed_desktop_config_revision_conflict"));
            }
            if self.secrets.has_provider_key(&config).await? {
                return Err(refused("managed_desktop_credential_rotate_required"));
            }
            self.secrets.put_provider_key(&config, &key).await?;
        }
        self.config_summary(p, id).await
    }

    /// Replaces the provider key under a new generation. New work refuses the
    /// old generation at once; its key stays until every resource created with
    /// it is confirmed absent (`reconcile_retired_credentials`).
    pub async fn rotate_credential(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        expected_revision: u64,
        key: ProviderSecret,
    ) -> Result<ManagedDesktopConfigSummary> {
        p.require_admin()?;
        {
            let _registry = self.config_operations.lock().await;
            let mut registry = self.registry().await?;
            self.scope(p)?;
            validate_id(id)?;
            let index = registry
                .providers
                .iter()
                .position(|c| {
                    c.id == id
                        && c.owner_principal_id == p.owner_principal_id
                        && c.host_id == self.host_id
                })
                .ok_or_else(|| refused("managed_desktop_config_not_found"))?;
            let current = registry.providers[index].clone();
            if current.revision != expected_revision {
                return Err(refused("managed_desktop_config_revision_conflict"));
            }
            let retired = current.credential();
            let mut next = current;
            next.credential_generation = next.credential_generation.saturating_add(1);
            next.revision = next.revision.saturating_add(1);
            // Record the retirement before the registry names the new
            // generation: a crash in between leaves a retired key that the
            // reconciler removes, never a forgotten one.
            self.transaction(|s, _| {
                s.retired_credentials.insert(retired);
                Ok(())
            })
            .await?;
            self.secrets.put_provider_key(&next, &key).await?;
            registry.providers[index] = next.clone();
            if let Err(error) = self.save_registry(registry).await {
                // The registry still names the old generation; the new key is
                // unreferenced. Best effort, retried by nothing else.
                let _ = self.secrets.remove_provider_key(&next.credential()).await;
                return Err(error);
            }
        }
        self.config_summary(p, id).await
    }

    /// Removes retired key generations that no live desktop or template uses.
    /// Runs on every reconcile tick; a removal failure keeps the record.
    pub(super) async fn reconcile_retired_credentials(&self) -> Result<()> {
        let (retired, current): (Vec<RetiredCredential>, Vec<RetiredCredential>) = {
            let registry = self.registry().await?;
            let state = self.state.lock().await;
            (
                state.retired_credentials.iter().cloned().collect(),
                registry
                    .providers
                    .iter()
                    .filter(|c| c.host_id == self.host_id)
                    .map(ManagedDesktopConfig::credential)
                    .collect(),
            )
        };
        for credential in retired {
            if current.contains(&credential) || self.credential_in_use(&credential).await {
                continue;
            }
            self.secrets.remove_provider_key(&credential).await?;
            self.transaction(|s, _| {
                s.retired_credentials.remove(&credential);
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    async fn config_in_use(&self, config: &ManagedDesktopConfig) -> bool {
        let state = self.state.lock().await;
        let owns = |row: &ManagedDesktopConfig| {
            row.id == config.id && row.owner_principal_id == config.owner_principal_id
        };
        state
            .desktops
            .values()
            .any(|d| owns(&d.config) && d.desktop.state != ManagedDesktopState::Destroyed)
            || state.templates.values().any(|t| owns(&t.config))
    }

    async fn credential_in_use(&self, credential: &RetiredCredential) -> bool {
        let state = self.state.lock().await;
        let uses = |row: &ManagedDesktopConfig| row.credential() == *credential;
        state
            .desktops
            .values()
            .any(|d| uses(&d.config) && d.desktop.state != ManagedDesktopState::Destroyed)
            || state.templates.values().any(|t| uses(&t.config))
    }

    async fn save_registry(&self, registry: super::super::journal::ManagedDesktopRegistry) -> Result<()> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.save_registry(&registry))
            .await
            .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
    }

    async fn config_summary(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
    ) -> Result<ManagedDesktopConfigSummary> {
        self.list_configs(p)
            .await?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| refused("managed_desktop_config_not_found"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;

    fn draft(f: &Fixture, expected_revision: Option<u64>) -> ManagedDesktopConfigDraft {
        ManagedDesktopConfigDraft {
            id: f.config.id.clone(),
            expected_revision,
            enabled: true,
            shape: DesktopShape {
                cpu_count: 4,
                memory_mb: 8192,
            },
            limits: DesktopLimits {
                max_concurrent: 1,
                max_lifetime_seconds: 1800,
                idle_timeout_seconds: 300,
            },
            plan: AccountPlanDraft {
                max_lifetime_seconds: 3600,
                source: "operator-confirmed".into(),
                namespace: "team".into(),
                valid_for_ms: 7 * 24 * 60 * 60 * 1000,
            },
            price: DesktopPriceDraft {
                currency: "USD".into(),
                hourly_rate_micros: 165_600,
                source: "e2b-pricing-page".into(),
                valid_for_ms: 7 * 24 * 60 * 60 * 1000,
            },
            egress: DesktopEgress::Off,
            isolation_minimum: IsolationTier::Vm,
        }
    }

    fn principal(f: &Fixture, authority: ManagedDesktopAuthority) -> ManagedDesktopPrincipal {
        ManagedDesktopPrincipal {
            authority,
            ..f.p.clone()
        }
    }

    fn key(value: &str) -> ProviderSecret {
        ProviderSecret::parse(value).unwrap()
    }

    #[tokio::test]
    async fn save_derives_owner_host_release_and_bumps_the_revision() {
        let f = Fixture::new();
        let saved = f.service.save_config(&f.p, draft(&f, Some(1))).await.unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!((saved.cpu_count, saved.memory_mb), (4, 8192));
        assert_eq!(saved.max_concurrent, 1);
        assert_eq!(saved.credential_generation, 1);
        assert!(saved.credential_present);
        let stored = f.service.config(&f.p, "e2b").await.unwrap();
        assert_eq!(stored.owner_principal_id, "owner");
        assert_eq!(stored.host_id, "host");
        assert_eq!(Some(&stored.release), f.service.trusted_release.as_ref());
        assert_eq!(stored.region, None);
        // The Host, not the caller, dates the confirmation.
        let now = f.service.now().await;
        assert_eq!(stored.plan.observed_at, now);
        assert_eq!(stored.price.observed_at, now);
        assert_eq!(stored.price.expires_at, now + 7 * 24 * 60 * 60 * 1000);
        // A saved change alters the binding digest, so old quotes and receipts
        // no longer match this configuration.
        assert_ne!(stored.binding_digest(), f.config.binding_digest());
    }

    #[tokio::test]
    async fn save_creates_new_configs_and_refuses_lost_updates() {
        let f = Fixture::new();
        let mut fresh = draft(&f, None);
        fresh.id = "second".into();
        let created = f.service.save_config(&f.p, fresh.clone()).await.unwrap();
        assert_eq!((created.revision, created.credential_generation), (1, 1));
        assert!(!created.credential_present);
        assert_eq!(
            f.service.save_config(&f.p, fresh).await.unwrap_err().code,
            "managed_desktop_config_exists"
        );
        assert_eq!(
            f.service
                .save_config(&f.p, draft(&f, Some(7)))
                .await
                .unwrap_err()
                .code,
            "managed_desktop_config_revision_conflict"
        );
        let mut missing = draft(&f, Some(1));
        missing.id = "missing".into();
        assert_eq!(
            f.service.save_config(&f.p, missing).await.unwrap_err().code,
            "managed_desktop_config_not_found"
        );
    }

    #[tokio::test]
    async fn only_an_administrator_of_this_host_writes_configuration() {
        let f = Fixture::new();
        for authority in [
            ManagedDesktopAuthority::Human,
            ManagedDesktopAuthority::Agent,
            ManagedDesktopAuthority::Observer,
        ] {
            let p = principal(&f, authority);
            assert_eq!(
                f.service.save_config(&p, draft(&f, Some(1))).await.unwrap_err().code,
                "managed_desktop_admin_required"
            );
            assert_eq!(
                f.service
                    .rotate_credential(&p, "e2b", 1, key("next"))
                    .await
                    .unwrap_err()
                    .code,
                "managed_desktop_admin_required"
            );
            assert_eq!(
                f.service.delete_config(&p, "e2b", 1).await.unwrap_err().code,
                "managed_desktop_admin_required"
            );
        }
        let foreign_host = ManagedDesktopPrincipal {
            host_id: "other-host".into(),
            ..f.p.clone()
        };
        assert_eq!(
            f.service
                .save_config(&foreign_host, draft(&f, Some(1)))
                .await
                .unwrap_err()
                .code,
            "managed_desktop_forbidden"
        );
        // Another account sees no configuration to replace.
        let other_owner = ManagedDesktopPrincipal {
            owner_principal_id: "other".into(),
            ..f.p.clone()
        };
        assert_eq!(
            f.service
                .save_config(&other_owner, draft(&f, Some(1)))
                .await
                .unwrap_err()
                .code,
            "managed_desktop_config_not_found"
        );
        assert_eq!(f.service.config(&f.p, "e2b").await.unwrap(), f.config);
    }

    #[tokio::test]
    async fn save_refuses_raised_limits_unsupported_egress_and_missing_release() {
        let f = Fixture::new();
        let mut raised = draft(&f, Some(1));
        raised.limits.max_lifetime_seconds = 3601;
        assert_eq!(
            f.service.save_config(&f.p, raised).await.unwrap_err().code,
            "managed_desktop_policy_limit"
        );
        let mut egress = draft(&f, Some(1));
        egress.egress = DesktopEgress::On;
        assert_eq!(
            f.service.save_config(&f.p, egress).await.unwrap_err().code,
            "managed_desktop_egress_smoke_unsupported"
        );
        let mut too_long = draft(&f, Some(1));
        too_long.price.valid_for_ms = BINDING_MAX_AGE_MS + 1;
        assert_eq!(
            f.service.save_config(&f.p, too_long).await.unwrap_err().code,
            "managed_desktop_price_unknown"
        );
        let mut expired_plan = draft(&f, Some(1));
        expired_plan.plan.valid_for_ms = 0;
        assert_eq!(
            f.service.save_config(&f.p, expired_plan).await.unwrap_err().code,
            "managed_desktop_entitlement_unknown"
        );
        // A Host without a trusted release cannot name the release a
        // configuration is bound to, so it refuses before reading the registry.
        let dormant_dir = tempfile::tempdir().unwrap();
        let dormant = ManagedDesktopService::open(
            dormant_dir.path(),
            "host".into(),
            f.provider.clone(),
            f.service.secrets.clone(),
            None,
        )
        .unwrap();
        assert_eq!(
            dormant.save_config(&f.p, draft(&f, None)).await.unwrap_err().code,
            "managed_desktop_release_unavailable"
        );
        assert!(dormant.list_configs(&f.p).await.unwrap().is_empty());
        assert_eq!(f.service.config(&f.p, "e2b").await.unwrap(), f.config);
    }

    #[tokio::test]
    async fn the_first_key_is_set_once_and_later_keys_rotate() {
        let f = Fixture::new();
        let mut fresh = draft(&f, None);
        fresh.id = "second".into();
        f.service.save_config(&f.p, fresh).await.unwrap();
        let set = f
            .service
            .set_credential(&f.p, "second", 1, key("first-key"))
            .await
            .unwrap();
        assert!(set.credential_present);
        assert_eq!(
            f.service
                .set_credential(&f.p, "second", 1, key("other-key"))
                .await
                .unwrap_err()
                .code,
            "managed_desktop_credential_rotate_required"
        );
        let config = f.service.config(&f.p, "second").await.unwrap();
        assert_eq!(
            f.service.secrets.provider_key(&config).await.unwrap().0,
            "first-key"
        );
        assert!(ProviderSecret::parse("two words").is_err());
        assert!(ProviderSecret::parse("").is_err());
    }

    #[tokio::test]
    async fn rotation_keeps_cleanup_authority_until_old_resources_are_gone() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("create").await;
        let rotated = f
            .service
            .rotate_credential(&f.p, "e2b", 1, key("rotated-key"))
            .await
            .unwrap();
        assert_eq!((rotated.credential_generation, rotated.revision), (2, 2));
        let old = f.config.credential();
        assert!(f.service.state.lock().await.retired_credentials.contains(&old));
        // The live desktop and its template still name generation 1.
        f.service.reconcile_retired_credentials().await.unwrap();
        assert_eq!(
            f.service.secrets.provider_key(&f.config).await.unwrap().0,
            "provider-secret"
        );
        f.service.delete(&f.p, &desktop.id, desktop.generation).await.unwrap();
        f.service.reconcile_retired_credentials().await.unwrap();
        assert!(f.service.state.lock().await.retired_credentials.contains(&old));
        // Once no template uses it either, the next reconcile tick removes it.
        f.service.state.lock().await.templates.clear();
        f.service.reconcile().await.unwrap();
        assert!(!f.service.state.lock().await.retired_credentials.contains(&old));
        assert_eq!(
            f.service.secrets.provider_key(&f.config).await.unwrap_err().code,
            "managed_desktop_missing_credentials"
        );
        let current = f.service.config(&f.p, "e2b").await.unwrap();
        assert_eq!(
            f.service.secrets.provider_key(&current).await.unwrap().0,
            "rotated-key"
        );
    }

    #[tokio::test]
    async fn delete_refuses_while_resources_remain() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("create").await;
        assert_eq!(
            f.service.delete_config(&f.p, "e2b", 1).await.unwrap_err().code,
            "managed_desktop_config_in_use"
        );
        f.service.delete(&f.p, &desktop.id, desktop.generation).await.unwrap();
        // The template still lives in the provider account.
        assert_eq!(
            f.service.delete_config(&f.p, "e2b", 1).await.unwrap_err().code,
            "managed_desktop_config_in_use"
        );
        assert_eq!(f.service.list_configs(&f.p).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_removes_every_key_generation_and_its_retirements() {
        let f = Fixture::new();
        f.service
            .rotate_credential(&f.p, "e2b", 1, key("rotated-key"))
            .await
            .unwrap();
        assert_eq!(
            f.service.delete_config(&f.p, "e2b", 1).await.unwrap_err().code,
            "managed_desktop_config_revision_conflict"
        );
        f.service.delete_config(&f.p, "e2b", 2).await.unwrap();
        assert!(f.service.list_configs(&f.p).await.unwrap().is_empty());
        for generation in [1, 2] {
            let config = ManagedDesktopConfig {
                credential_generation: generation,
                ..f.config.clone()
            };
            assert!(!f.service.secrets.has_provider_key(&config).await.unwrap());
        }
        assert!(f.service.state.lock().await.retired_credentials.is_empty());
    }
}
