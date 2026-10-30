//! Journal-backed, owner-scoped grants. Session and character tags have the
//! renderer's CallContext trust level; they never confer lifecycle authority.
//! Delegation requires a single-user account binding. Multi-tenant Hosts refuse
//! it with `managed_desktop_delegation_unsupported_deployment`.
use super::control::ManagedControlAuthority;
use super::*;
use crate::cua_sandbox::managed::journal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ManagedDesktopGrantee {
    Session {
        #[serde(rename = "sessionKey")]
        session_key: String,
    },
    Character {
        #[serde(rename = "characterId")]
        character_id: String,
    },
    Acceptance {
        #[serde(rename = "acceptanceId")]
        acceptance_id: String,
        /// Host-only attachment. RPC projections omit this persisted field.
        #[serde(rename = "childSessionKey", default)]
        child_session_key: Option<String>,
    },
}
impl ManagedDesktopGrantee {
    fn validate(&self) -> Result<()> {
        let value = match self {
            Self::Session { session_key } => session_key,
            Self::Character { character_id } => character_id,
            Self::Acceptance { acceptance_id, .. } => acceptance_id,
        };
        if value.trim().is_empty() || value.len() > 512 {
            return Err(refused("managed_desktop_invalid_request"));
        }
        Ok(())
    }
    pub(crate) fn matches(&self, session: Option<&str>, character: Option<&str>) -> bool {
        match self {
            Self::Session { session_key } => session == Some(session_key.as_str()),
            Self::Character { character_id } => character == Some(character_id.as_str()),
            Self::Acceptance { child_session_key, .. } => child_session_key.as_deref().is_some_and(|key| Some(key) == session),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedDesktopDelegationMode {
    ComputerUse,
    Acceptance,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedDesktopDelegationState {
    Live,
    Ended,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedDesktopDelegationEndReason {
    Completed,
    Revoked,
    Expired,
    Destroyed,
    GenerationChanged,
    AccountChanged,
}
/// Account-bound Host authority. Multi-tenant deployments refuse delegation
/// with `managed_desktop_delegation_unsupported_deployment` because they do not
/// have the single local account binding this record fences.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopDelegation {
    pub id: String,
    /// The owner's local account namespace, never a renderer-supplied tag.
    pub owner_principal_id: String,
    /// Missing legacy bindings fail closed when the Host runtime is installed.
    #[serde(default)]
    pub account_binding_epoch: Option<u64>,
    /// A new Host process must not reuse an old process's epoch counter.
    #[serde(default)]
    pub account_binding_instance_id: Option<String>,
    pub host_id: String,
    pub desktop_id: String,
    pub desktop_generation: u64,
    pub provider_config_id: String,
    pub grantee: ManagedDesktopGrantee,
    pub mode: ManagedDesktopDelegationMode,
    pub state: ManagedDesktopDelegationState,
    pub end_reason: Option<ManagedDesktopDelegationEndReason>,
    pub expires_at: i64,
    pub revision: u64,
    pub created_at: i64,
    pub created_by_principal_id: String,
    pub ended_at: Option<i64>,
}
impl ManagedDesktopDelegation {
    pub(super) fn end(&mut self, reason: ManagedDesktopDelegationEndReason, now: i64) {
        if self.state == ManagedDesktopDelegationState::Live {
            self.state = ManagedDesktopDelegationState::Ended;
            self.end_reason = Some(reason);
            self.ended_at = Some(now);
            self.revision = self.revision.saturating_add(1);
        }
    }
    pub(super) fn matches(&self, session: Option<&str>, character: Option<&str>) -> bool {
        match &self.grantee {
            ManagedDesktopGrantee::Acceptance { .. } => self.mode == ManagedDesktopDelegationMode::Acceptance
                && self.grantee.matches(session, character),
            _ => self.mode == ManagedDesktopDelegationMode::ComputerUse && self.grantee.matches(session, character),
        }
    }
}

pub type ManagedDesktopOwnerCheck = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type ManagedDesktopAccountBindingEpoch = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type ManagedDesktopDelegationEvents = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub(super) struct DelegationRuntime {
    owner: ManagedDesktopOwnerCheck,
    epoch: ManagedDesktopAccountBindingEpoch,
    instance_id: String,
    pub(super) events: ManagedDesktopDelegationEvents,
    bindings: Arc<parking_lot::Mutex<(u64, std::collections::BTreeMap<String, bool>)>>,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct DelegationBinding {
    pub(super) epoch: u64,
    pub(super) instance_id: String,
}
impl DelegationRuntime {
    /// Called only by blocking transaction/snapshot preparation. The epoch is
    /// the exact account fence, including A -> B -> A without an intervening call.
    pub(super) fn prepare<'a>(&self, owners: impl Iterator<Item = &'a str>) {
        let epoch = (self.epoch)();
        let missing: std::collections::BTreeSet<String> = {
            let mut cache = self.bindings.lock();
            if cache.0 != epoch {
                *cache = (epoch, Default::default());
            }
            owners
                .filter(|owner| !cache.1.contains_key(*owner))
                .map(str::to_owned)
                .collect()
        };
        // The owner callback can consult SQLite. Never hold the send-side
        // cache lock while it runs, and discard a raced account result.
        let checked: Vec<_> = missing
            .into_iter()
            .map(|owner| {
                let allowed = (self.owner)(&owner);
                (owner, allowed)
            })
            .collect();
        let mut cache = self.bindings.lock();
        if cache.0 == epoch && (self.epoch)() == epoch {
            cache.1.extend(checked);
        }
    }
    pub(super) fn binding(&self, owner: &str) -> Option<DelegationBinding> {
        let epoch = (self.epoch)();
        let cache = self.bindings.lock();
        (cache.0 == epoch && cache.1.get(owner) == Some(&true)).then(|| DelegationBinding {
            epoch,
            instance_id: self.instance_id.clone(),
        })
    }
}

/// Run in every journal transaction, including cleanup and generation changes.
pub(super) fn settle(
    state: &mut journal::ManagedDesktopJournal,
    now: i64,
    runtime: Option<&DelegationRuntime>,
) {
    use ManagedDesktopDelegationEndReason::*;
    for grant in state
        .delegations
        .values_mut()
        .filter(|g| g.state == ManagedDesktopDelegationState::Live)
    {
        let reason = if runtime.is_some_and(|runtime| {
            grant.account_binding_epoch.is_none()
                || !runtime
                    .binding(&grant.owner_principal_id)
                    .is_some_and(|binding| {
                        grant.account_binding_epoch == Some(binding.epoch)
                            && grant.account_binding_instance_id.as_deref()
                                == Some(binding.instance_id.as_str())
                    })
        }) {
            Some(AccountChanged)
        } else if let Some(row) = state.desktops.get(&grant.desktop_id) {
            if row.desktop.generation != grant.desktop_generation {
                Some(GenerationChanged)
            } else if row.delete_requested || row.desktop.state == ManagedDesktopState::Destroyed {
                Some(Destroyed)
            } else if now >= grant.expires_at || row.expired(now) {
                Some(Expired)
            } else {
                None
            }
        } else {
            Some(Destroyed)
        };
        if let Some(reason) = reason {
            grant.end(reason, now);
        }
    }
    let mut ended: Vec<_> = state
        .delegations
        .values()
        .filter_map(|g| {
            g.ended_at
                .map(|at| (g.owner_principal_id.clone(), at, g.id.clone()))
        })
        .collect();
    ended.sort_by(|a, b| b.cmp(a));
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for (owner, at, id) in ended {
        let count = counts.entry(owner).or_default();
        *count += 1;
        if *count > 64 || now.saturating_sub(at) >= 86_400_000 {
            state.delegations.remove(&id);
        }
    }
}

impl ManagedDesktopService {
    /// Installed by the Host, never by renderer data. No strong service cycle.
    pub fn set_delegation_runtime(
        &self,
        owner: ManagedDesktopOwnerCheck,
        epoch: ManagedDesktopAccountBindingEpoch,
        instance_id: String,
        events: ManagedDesktopDelegationEvents,
    ) {
        *self.delegation_runtime.write() = Some(DelegationRuntime {
            owner,
            epoch,
            instance_id,
            events,
            bindings: Default::default(),
        });
    }
    pub(super) fn delegation_binding(&self, owner: &str) -> Option<DelegationBinding> {
        let runtime = self.delegation_runtime.read().clone()?;
        runtime.binding(owner)
    }
    pub async fn reconcile_delegations(&self) -> Result<()> {
        self.transaction(|_, _| Ok(())).await
    }
    pub async fn delegate(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        grantee: ManagedDesktopGrantee,
        expires_at: Option<i64>,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedDesktopDelegation> {
        p.require_admin()?;
        grantee.validate()?;
        if matches!(grantee, ManagedDesktopGrantee::Acceptance { .. }) {
            return Err(refused("managed_desktop_invalid_request"));
        }
        self.delegate_inner(p, id, generation, grantee, expires_at, authority).await
    }
    pub(super) async fn delegate_acceptance(&self, p: &ManagedDesktopPrincipal, id: &str, generation: u64,
        acceptance: &str, authority: &dyn ManagedControlAuthority) -> Result<ManagedDesktopDelegation> {
        p.require_admin()?;
        self.delegate_inner(p,id,generation,ManagedDesktopGrantee::Acceptance { acceptance_id:acceptance.into(), child_session_key:None },None,authority).await
    }
    async fn delegate_inner(&self, p: &ManagedDesktopPrincipal, id: &str, generation: u64,
        grantee: ManagedDesktopGrantee, expires_at: Option<i64>, authority: &dyn ManagedControlAuthority) -> Result<ManagedDesktopDelegation> {
        let acceptance = matches!(grantee, ManagedDesktopGrantee::Acceptance { .. });
        let mode = if acceptance { ManagedDesktopDelegationMode::Acceptance } else { ManagedDesktopDelegationMode::ComputerUse };
        let gate = if acceptance { ManagedDesktopRuntimeGate::Acceptance } else { ManagedDesktopRuntimeGate::AgentControl };
        authority.revalidate(p).await?;
        self.reconcile_delegations().await?;
        let row = self.scoped(p, id, generation).await?;
        if row
            .source_id
            .as_deref()
            .is_some_and(|source| source.starts_with("acceptance:"))
            && !matches!(&grantee, ManagedDesktopGrantee::Acceptance { .. })
        {
            return Err(refused("managed_desktop_acceptance_desktop"));
        }
        let binding = self
            .delegation_binding(&p.owner_principal_id)
            .ok_or_else(|| refused("managed_desktop_forbidden"))?;
        if row.delete_requested
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await)
        {
            return Err(refused("managed_desktop_control_unavailable"));
        }
        let service = self.clone();
        let owner = p.owner_principal_id.clone();
        let authority = authority.input_admission(p);
        let expected = binding.clone();
        let live = Arc::new(move || {
            authority() && service.delegation_binding(&owner) == Some(expected.clone())
        });
        let admission =
            self.runtime_admission_for_record(&row, gate, live);
        if !admission() {
            return Err(refused("managed_desktop_agent_control_unqualified"));
        }
        self.transaction_admitted(
            Arc::new(move || {
                if admission() {
                    Ok(())
                } else {
                    Err(refused("managed_desktop_agent_control_unqualified"))
                }
            }),
            |s, now| {
                if let ManagedDesktopGrantee::Acceptance { acceptance_id, .. } = &grantee {
                    let expected = format!("acceptance:{acceptance_id}");
                    if !s.acceptance_runs.get(acceptance_id).is_some_and(|r| r.owner_principal_id == p.owner_principal_id
                        && r.host_id == p.host_id && r.run.state == acceptance::AcceptanceRunState::Provisioning
                        && r.run.desktop_id.as_deref() == Some(id))
                        || !s.desktops.get(id).is_some_and(|r| !r.smoke && r.source_id.as_deref() == Some(expected.as_str())) {
                        return Err(refused("managed_desktop_acceptance_delegation_required"));
                    }
                }
                let row = s
                    .desktops
                    .get(id)
                    .ok_or_else(|| refused("managed_desktop_not_found"))?;
                row.config.authorize(p)?;
                if row
                    .source_id
                    .as_deref()
                    .is_some_and(|source| source.starts_with("acceptance:"))
                    && !matches!(&grantee, ManagedDesktopGrantee::Acceptance { .. })
                {
                    return Err(refused("managed_desktop_acceptance_desktop"));
                }
                if row.desktop.generation != generation
                    || row.delete_requested
                    || row.desktop.state != ManagedDesktopState::Running
                    || row.expired(now)
                    || self.delegation_binding(&p.owner_principal_id) != Some(binding.clone())
                {
                    return Err(refused("managed_desktop_control_unavailable"));
                }
                let expiry = expires_at
                    .unwrap_or(row.desktop.deadline_at)
                    .min(row.desktop.deadline_at);
                if expiry <= now {
                    return Err(refused("managed_desktop_invalid_request"));
                }
                if let Some(grant) = s.delegations.values_mut().find(|g| {
                    g.owner_principal_id == p.owner_principal_id
                        && g.host_id == p.host_id
                        && g.desktop_id == id
                        && g.desktop_generation == generation
                        && g.grantee == grantee
                        && g.account_binding_epoch == Some(binding.epoch)
                        && g.account_binding_instance_id.as_deref()
                            == Some(binding.instance_id.as_str())
                        && g.mode == mode
                        && g.state == ManagedDesktopDelegationState::Live
                        && g.expires_at > now
                }) {
                    let expiry = expires_at
                        .map(|at| at.min(row.desktop.deadline_at))
                        .unwrap_or(grant.expires_at);
                    if grant.expires_at != expiry {
                        grant.expires_at = expiry;
                        grant.revision = grant.revision.saturating_add(1);
                    }
                    return Ok(grant.clone());
                }
                let grant = ManagedDesktopDelegation {
                    id: Uuid::new_v4().to_string(),
                    owner_principal_id: p.owner_principal_id.clone(),
                    account_binding_epoch: Some(binding.epoch),
                    account_binding_instance_id: Some(binding.instance_id.clone()),
                    host_id: p.host_id.clone(),
                    desktop_id: id.into(),
                    desktop_generation: generation,
                    provider_config_id: row.config.id.clone(),
                    grantee,
                    mode,
                    state: ManagedDesktopDelegationState::Live,
                    end_reason: None,
                    expires_at: expiry,
                    revision: 1,
                    created_at: now,
                    created_by_principal_id: p.principal_id.clone(),
                    ended_at: None,
                };
                s.delegations.insert(grant.id.clone(), grant.clone());
                Ok(grant)
            },
        )
        .await
    }
    pub async fn delegation_revoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        expected_revision: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedDesktopDelegation> {
        p.require_admin()?;
        self.scope(p)?;
        authority.revalidate(p).await?;
        self.reconcile_delegations().await?;
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
                let grant = s
                    .delegations
                    .get_mut(id)
                    .filter(|g| {
                        g.owner_principal_id == p.owner_principal_id && g.host_id == p.host_id
                    })
                    .ok_or_else(|| refused("managed_desktop_not_found"))?;
                if grant.revision != expected_revision {
                    return Err(refused("managed_desktop_revision_conflict"));
                }
                grant.end(ManagedDesktopDelegationEndReason::Revoked, now);
                Ok(grant.clone())
            },
        )
        .await
    }
    pub async fn delegation_list(
        &self,
        p: &ManagedDesktopPrincipal,
    ) -> Result<Vec<ManagedDesktopDelegation>> {
        p.require_admin()?;
        self.scope(p)?;
        self.reconcile_delegations().await?;
        let mut rows: Vec<_> = self
            .state
            .lock()
            .await
            .delegations
            .values()
            .filter(|g| g.owner_principal_id == p.owner_principal_id && g.host_id == p.host_id)
            .cloned()
            .collect();
        rows.sort_by_key(|g| {
            (
                g.state != ManagedDesktopDelegationState::Live,
                std::cmp::Reverse(g.created_at),
                g.id.clone(),
            )
        });
        Ok(rows)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::automation::types::{Action, ActionOutput, ButtonTransition, MouseButton};
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(super) struct Authority;
    #[async_trait::async_trait]
    impl ManagedControlAuthority for Authority {
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
    fn session(value: &str) -> ManagedDesktopGrantee {
        ManagedDesktopGrantee::Session {
            session_key: value.into(),
        }
    }
    pub(in crate::cua_sandbox::managed) async fn fixture() -> (
        super::super::tests::Fixture,
        ManagedDesktop,
        Arc<AtomicU64>,
    ) {
        let f = super::super::tests::Fixture::new();
        super::super::qualification::enablement_tests::install_gui_evidence(&f).await;
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement = ManagedDesktopEnablement {
            manual_gui: true,
            agent_control: true,
            acceptance: false,
        };
        f.service.save_registry(registry.clone()).await.unwrap();
        f.service.set_delegation_runtime(
            Arc::new(|owner| owner == "owner"),
            Arc::new(|| 1),
            "test-process".into(),
            Arc::new(|| {}),
        );
        let row = f.smoke("agent-desktop").await;
        let calls = Arc::new(AtomicU64::new(0));
        let observed = calls.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |_, _| {
                let calls = observed.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(serde_json::json!({"x":1,"y":2}))
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        (f, row, calls)
    }
    pub(crate) async fn identity_fixture() -> (
        tempfile::TempDir,
        Arc<ManagedDesktopService>,
        ManagedDesktop,
        Arc<AtomicU64>,
    ) {
        let (f, row, calls) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                ManagedDesktopGrantee::Character {
                    character_id: "character".into(),
                },
                None,
                &Authority,
            )
            .await
            .unwrap();
        (f.directory, Arc::new(f.service), row, calls)
    }
    async fn cursor(
        f: &super::super::tests::Fixture,
        row: &ManagedDesktop,
        session: &str,
        character: Option<&str>,
    ) -> crate::automation::types::Result<ActionOutput> {
        f.service
            .agent_operation(
                &row.id,
                row.generation,
                Some(session.into()),
                character.map(str::to_owned),
                Action::CursorPosition,
            )
            .await
    }
    #[tokio::test]
    async fn acceptance_desktop_refuses_session_and_character_grants() {
        let (f, row, _) = fixture().await;
        f.service
            .transaction(|s, _| {
                s.desktops.get_mut(&row.id).unwrap().source_id = Some("acceptance:private".into());
                Ok(())
            })
            .await
            .unwrap();
        for grantee in [
            session("chat"),
            ManagedDesktopGrantee::Character { character_id: "character".into() },
        ] {
            assert_eq!(
                f.service.delegate(&f.p, &row.id, row.generation, grantee, None, &Authority)
                    .await.unwrap_err().code,
                "managed_desktop_acceptance_desktop"
            );
        }
        assert!(f.service.delegation_list(&f.p).await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn grants_are_idempotent_capped_owner_scoped_and_admin_only() {
        let (f, row, _) = fixture().await;
        for authority in [
            ManagedDesktopAuthority::Agent,
            ManagedDesktopAuthority::Human,
            ManagedDesktopAuthority::Observer,
        ] {
            let mut p = f.p.clone();
            p.authority = authority;
            assert!(f
                .service
                .delegate(
                    &p,
                    &row.id,
                    row.generation,
                    session("chat"),
                    None,
                    &Authority
                )
                .await
                .is_err());
            assert!(f.service.delegation_list(&p).await.is_err());
            assert!(f
                .service
                .delegation_revoke(&p, "unknown", 1, &Authority)
                .await
                .is_err());
        }
        let first = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                Some(i64::MAX),
                &Authority,
            )
            .await
            .unwrap();
        assert_eq!(first.expires_at, row.deadline_at);
        let second = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert_eq!(first, second);
        let refreshed = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                Some(1020),
                &Authority,
            )
            .await
            .unwrap();
        assert_eq!(refreshed.id, first.id);
        assert_eq!(refreshed.revision, first.revision + 1);
        assert_eq!(refreshed.expires_at, 1020);
        assert_eq!(
            f.service
                .delegate(
                    &f.p,
                    &row.id,
                    row.generation,
                    session("chat"),
                    None,
                    &Authority
                )
                .await
                .unwrap(),
            refreshed
        );
        let first = refreshed;
        assert_eq!(f.service.delegation_list(&f.p).await.unwrap().len(), 1);
        let mut other = f.p.clone();
        other.owner_principal_id = "other".into();
        assert!(f.service.delegation_list(&other).await.unwrap().is_empty());
        assert!(f
            .service
            .delegation_revoke(&other, &first.id, first.revision, &Authority)
            .await
            .is_err());
        assert!(f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                ManagedDesktopGrantee::Acceptance {
                    acceptance_id: "run".into(),
                    child_session_key: None,
                },
                None,
                &Authority
            )
            .await
            .is_err());
        assert!(f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation + 1,
                session("chat"),
                None,
                &Authority
            )
            .await
            .is_err());
        assert!(f
            .service
            .delegation_revoke(&f.p, &first.id, 999, &Authority)
            .await
            .is_err());
        let ended = f
            .service
            .delegation_revoke(&f.p, &first.id, first.revision, &Authority)
            .await
            .unwrap();
        assert_eq!(
            ended.end_reason,
            Some(ManagedDesktopDelegationEndReason::Revoked)
        );
        let renewed = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert_ne!(renewed.id, first.id);
        assert_eq!(
            f.service.delegation_list(&f.p).await.unwrap()[0].id,
            renewed.id
        );
    }
    #[tokio::test]
    async fn every_agent_call_checks_grant_identity_revocation_and_activity() {
        let (f, row, calls) = fixture().await;
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert!(cursor(&f, &row, "other", None).await.is_err());
        f.clock.fetch_add(10, Ordering::SeqCst);
        assert!(cursor(&f, &row, "chat", None).await.is_ok());
        assert_eq!(
            f.service.state.lock().await.desktops[&row.id].last_activity_at,
            1010
        );
        assert_eq!(
            f.service.state.lock().await.desktops[&row.id]
                .desktop
                .deadline_at,
            row.deadline_at
        );
        f.service
            .delegation_revoke(&f.p, &grant.id, grant.revision, &Authority)
            .await
            .unwrap();
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                ManagedDesktopGrantee::Character {
                    character_id: "character".into(),
                },
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert!(cursor(&f, &row, "other", Some("wrong")).await.is_err());
        assert!(cursor(&f, &row, "other", Some("character")).await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // Acceptance records can be stored by the future runner, but cannot
        // authorize ordinary session/character traffic.
        f.service
            .transaction(|s, _| {
                for g in s.delegations.values_mut() {
                    g.mode = ManagedDesktopDelegationMode::Acceptance;
                }
                Ok(())
            })
            .await
            .unwrap();
        assert!(cursor(&f, &row, "other", Some("character")).await.is_err());
    }

    #[tokio::test]
    async fn returning_to_the_same_account_requires_a_new_delegation() {
        let (f, row, _) = fixture().await;
        let epoch = Arc::new(AtomicU64::new(1));
        let current = epoch.clone();
        f.service.set_delegation_runtime(
            Arc::new(|owner| owner == "owner"),
            Arc::new(move || current.load(Ordering::SeqCst)),
            "test-process".into(),
            Arc::new(|| {}),
        );
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert_eq!(grant.account_binding_epoch, Some(1));
        // A -> B -> A, with no service call or reconcile in between.
        epoch.fetch_add(1, Ordering::SeqCst);
        epoch.fetch_add(1, Ordering::SeqCst);
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        let grants = f.service.delegation_list(&f.p).await.unwrap();
        assert_eq!(grants[0].state, ManagedDesktopDelegationState::Ended);
        assert_eq!(
            grants[0].end_reason,
            Some(ManagedDesktopDelegationEndReason::AccountChanged)
        );
        let replacement = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert_ne!(replacement.id, grant.id);
        assert_eq!(replacement.account_binding_epoch, Some(3));
        assert!(cursor(&f, &row, "chat", None).await.is_ok());
    }

    #[tokio::test]
    async fn reopening_under_a_new_process_cannot_reuse_an_old_epoch() {
        let (f, row, _) = fixture().await;
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        drop(f.service);
        let mut reopened = ManagedDesktopService::open(
            f.directory.path(),
            f.p.host_id.clone(),
            f.provider.clone(),
            f.secrets.clone(),
            Some(f.config.release.clone()),
        )
        .unwrap();
        let clock = f.clock.clone();
        reopened.clock = Arc::new(move || clock.load(Ordering::SeqCst));
        reopened.set_delegation_runtime(
            Arc::new(|owner| owner == "owner"),
            Arc::new(|| 1),
            "another-process".into(),
            Arc::new(|| {}),
        );
        assert!(reopened
            .agent_operation(
                &row.id,
                row.generation,
                Some("chat".into()),
                None,
                Action::CursorPosition
            )
            .await
            .is_err());
        let grants = reopened.delegation_list(&f.p).await.unwrap();
        assert_eq!(
            grants[0].end_reason,
            Some(ManagedDesktopDelegationEndReason::AccountChanged)
        );
        let replacement = reopened
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        assert_ne!(replacement.id, grant.id);
        assert_eq!(
            replacement.account_binding_epoch,
            grant.account_binding_epoch
        );
        assert_ne!(
            replacement.account_binding_instance_id,
            grant.account_binding_instance_id
        );
    }

    #[tokio::test]
    async fn acknowledged_held_input_is_quarantined_after_reopen_until_destroyed() {
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        f.service
            .agent_operation(
                &row.id,
                row.generation,
                Some("chat".into()),
                None,
                Action::MouseButton {
                    button: MouseButton::Left,
                    transition: ButtonTransition::Down,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            f.service.state.lock().await.agent_held_inputs[&row.id],
            row.generation
        );
        drop(f.service);
        let mut reopened = ManagedDesktopService::open(
            f.directory.path(),
            f.p.host_id.clone(),
            f.provider.clone(),
            f.secrets.clone(),
            Some(f.config.release.clone()),
        )
        .unwrap();
        let clock = f.clock.clone();
        reopened.clock = Arc::new(move || clock.load(Ordering::SeqCst));
        assert_eq!(
            reopened
                .control_status(&f.p, &row.id, row.generation)
                .await
                .unwrap()
                .state,
            "quarantined"
        );
        assert_eq!(
            reopened
                .control_acquire(&f.p, &row.id, row.generation, true, &Authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_quarantined"
        );
        reopened
            .delete(&f.p, &row.id, row.generation)
            .await
            .unwrap();
        assert!(!reopened
            .state
            .lock()
            .await
            .agent_held_inputs
            .contains_key(&row.id));
    }

    #[tokio::test]
    async fn account_switch_between_compound_sends_ends_the_grant_before_returning() {
        let (f, row, _) = fixture().await;
        let epoch = Arc::new(AtomicU64::new(1));
        let current = epoch.clone();
        f.service.set_delegation_runtime(
            Arc::new(|owner| owner == "owner"),
            Arc::new(move || current.load(Ordering::SeqCst)),
            "test-process".into(),
            Arc::new(|| {}),
        );
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let sent = Arc::new(AtomicU64::new(0));
        let observed = sent.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |_, _| {
                let epoch = epoch.clone();
                let sent = observed.clone();
                Box::pin(async move {
                    sent.fetch_add(1, Ordering::SeqCst);
                    epoch.fetch_add(2, Ordering::SeqCst);
                    Ok(serde_json::json!({"success":true}))
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        let result = f
            .service
            .agent_operation(
                &row.id,
                row.generation,
                Some("chat".into()),
                None,
                Action::Scroll {
                    target: crate::automation::types::ScrollTarget::Point { x: 1, y: 1 },
                    opts: Default::default(),
                },
            )
            .await;
        assert!(matches!(
            result,
            Err(crate::automation::types::AutomationError::PreemptedBeforeSend)
        ));
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        let state = f.service.state.lock().await;
        assert_eq!(
            state.delegations[&grant.id].end_reason,
            Some(ManagedDesktopDelegationEndReason::AccountChanged)
        );
        assert!(!state.control_quarantines.contains(&row.id));
    }
    #[tokio::test]
    async fn expiry_generation_destroy_account_switch_end_grants_and_history_is_bounded() {
        for reason in [
            ManagedDesktopDelegationEndReason::Expired,
            ManagedDesktopDelegationEndReason::GenerationChanged,
            ManagedDesktopDelegationEndReason::Destroyed,
            ManagedDesktopDelegationEndReason::AccountChanged,
        ] {
            let (f, row, _) = fixture().await;
            let grant = f
                .service
                .delegate(
                    &f.p,
                    &row.id,
                    row.generation,
                    session("chat"),
                    Some(1020),
                    &Authority,
                )
                .await
                .unwrap();
            match reason {
                ManagedDesktopDelegationEndReason::Expired => {
                    f.clock.store(1020, Ordering::SeqCst);
                }
                ManagedDesktopDelegationEndReason::GenerationChanged => {
                    f.service
                        .transaction(|s, _| {
                            s.desktops.get_mut(&row.id).unwrap().desktop.generation += 1;
                            Ok(())
                        })
                        .await
                        .unwrap();
                }
                ManagedDesktopDelegationEndReason::Destroyed => {
                    f.service
                        .delete(&f.p, &row.id, row.generation)
                        .await
                        .unwrap();
                }
                ManagedDesktopDelegationEndReason::AccountChanged => {
                    f.service.set_delegation_runtime(
                        Arc::new(|_| false),
                        Arc::new(|| 1),
                        "test-process".into(),
                        Arc::new(|| {}),
                    );
                }
                _ => unreachable!(),
            }
            assert!(cursor(&f, &row, "chat", None).await.is_err());
            let grants = f.service.delegation_list(&f.p).await.unwrap();
            assert_eq!(grants[0].id, grant.id);
            assert_eq!(grants[0].end_reason, Some(reason));
            f.clock.store(86_402_000, Ordering::SeqCst);
            assert!(f.service.delegation_list(&f.p).await.unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn human_and_pending_takeover_exclude_agent_and_switch_and_stale_receipts_refuse() {
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let slot = f.service.control_slot(&row.id, row.generation).await;
        slot.lock().await.core.issue("human", 1000, row.deadline_at);
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        slot.lock().await.core.invalidate();
        let pending = crate::cua_sandbox::desktop_session::PendingTakeover::begin(
            f.service.control_agent_preemption(&row.id).await,
        )
        .unwrap();
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        drop(pending);
        let mut registry = f.service.registry().await.unwrap();
        registry.providers[0].enablement.agent_control = false;
        f.service.save_registry(registry.clone()).await.unwrap();
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        assert_eq!(
            f.service
                .delegate(
                    &f.p,
                    &row.id,
                    row.generation,
                    session("second"),
                    None,
                    &Authority
                )
                .await
                .unwrap_err()
                .code,
            "managed_desktop_agent_control_unqualified"
        );
        registry.providers[0].enablement.agent_control = true;
        f.service.save_registry(registry.clone()).await.unwrap();
        f.service
            .transaction(|s, _| {
                s.control_qualifications.clear();
                Ok(())
            })
            .await
            .unwrap();
        assert!(cursor(&f, &row, "chat", None).await.is_err());
    }

    #[tokio::test]
    async fn unsupported_or_invalid_actions_do_not_quarantine_and_compound_sends_revalidate() {
        let (f, row, calls) = fixture().await;
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        for action in [
            Action::Capabilities,
            Action::Wait { duration_ms: 1 },
            Action::Keys {
                chord: crate::automation::types::KeyChord("".into()),
            },
        ] {
            assert!(f
                .service
                .agent_operation(&row.id, row.generation, Some("chat".into()), None, action)
                .await
                .is_err());
            assert!(!f
                .service
                .state
                .lock()
                .await
                .control_quarantines
                .contains(&row.id));
        }
        assert!(cursor(&f, &row, "chat", None).await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let service = f.service.clone();
        let p = f.p.clone();
        let id = grant.id.clone();
        let sent = Arc::new(AtomicU64::new(0));
        let count = sent.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |_, _| {
                let service = service.clone();
                let p = p.clone();
                let id = id.clone();
                let count = count.clone();
                Box::pin(async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    service
                        .delegation_revoke(&p, &id, 1, &Authority)
                        .await
                        .unwrap();
                    Ok(serde_json::json!({"success":true}))
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        assert!(matches!(
            f.service
                .agent_operation(
                    &row.id,
                    row.generation,
                    Some("chat".into()),
                    None,
                    Action::Scroll {
                        target: crate::automation::types::ScrollTarget::Point { x: 1, y: 1 },
                        opts: Default::default()
                    }
                )
                .await,
            Err(crate::automation::types::AutomationError::PreemptedBeforeSend)
        ));
        assert_eq!(
            sent.load(Ordering::SeqCst),
            1,
            "revoked between move and scroll"
        );
        assert!(!f
            .service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
    }

    #[tokio::test]
    async fn takeover_preempts_inflight_hold_and_releases_keys_and_buttons() {
        use base64::Engine as _;
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let commands = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let key_down = Arc::new(tokio::sync::Notify::new());
        let observed = commands.clone();
        let started = key_down.clone();
        let mut png = std::io::Cursor::new(Vec::new());
        xcap::image::RgbaImage::new(20, 20)
            .write_to(&mut png, xcap::image::ImageFormat::Png)
            .unwrap();
        let image = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |req, _| {
                let commands = observed.clone();
                let started = started.clone();
                let image = image.clone();
                Box::pin(async move {
                    commands.lock().push(req.command.clone());
                    if req.command == "key_down" {
                        started.notify_one();
                    }
                    Ok(if req.command == "screenshot" {
                        serde_json::json!({"status":"success","image_data":image})
                    } else {
                        serde_json::json!({"success":true})
                    })
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        f.service
            .agent_operation(
                &row.id,
                row.generation,
                Some("chat".into()),
                None,
                Action::MouseButton {
                    button: MouseButton::Left,
                    transition: ButtonTransition::Down,
                },
            )
            .await
            .unwrap();
        let service = f.service.clone();
        let id = row.id.clone();
        let generation = row.generation;
        let agent = tokio::spawn(async move {
            service
                .agent_operation(
                    &id,
                    generation,
                    Some("chat".into()),
                    None,
                    Action::HoldKey {
                        chord: crate::automation::types::KeyChord("Control".into()),
                        duration_ms: 30_000,
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), key_down.notified())
            .await
            .unwrap();
        let takeover = f
            .service
            .control_acquire(&f.p, &row.id, row.generation, true, &Authority);
        let lease = tokio::time::timeout(std::time::Duration::from_secs(3), takeover)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            agent.await.unwrap(),
            Err(crate::automation::types::AutomationError::PreemptedBeforeSend)
        ));
        let commands = commands.lock();
        assert!(commands.iter().any(|c| c == "key_up"));
        assert!(commands.iter().any(|c| c == "mouse_up"));
        assert!(lease.fence > 0);
        drop(commands);
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        assert!(!f
            .service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
    }

    #[tokio::test]
    async fn uncertain_takeover_cleanup_quarantines_and_refuses_further_agent_input() {
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            |request, _| {
                Box::pin(async move {
                    if request.command == "mouse_up" {
                        Err(crate::automation::types::AutomationError::BackendError {
                            message: "lost release acknowledgement".into(),
                        })
                    } else {
                        Ok(serde_json::json!({"success":true}))
                    }
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        f.service
            .agent_operation(
                &row.id,
                row.generation,
                Some("chat".into()),
                None,
                Action::MouseButton {
                    button: MouseButton::Left,
                    transition: ButtonTransition::Down,
                },
            )
            .await
            .unwrap();
        assert!(f
            .service
            .control_acquire(&f.p, &row.id, row.generation, true, &Authority)
            .await
            .is_err());
        assert!(f
            .service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        assert_eq!(
            f.service
                .control_status(&f.p, &row.id, row.generation)
                .await
                .unwrap()
                .state,
            "quarantined"
        );
    }

    #[tokio::test]
    async fn held_keys_are_released_promptly_after_revoke_expiry_or_account_switch() {
        for reason in [
            ManagedDesktopDelegationEndReason::Revoked,
            ManagedDesktopDelegationEndReason::Expired,
            ManagedDesktopDelegationEndReason::AccountChanged,
        ] {
            let (f, row, _) = fixture().await;
            let epoch = Arc::new(AtomicU64::new(1));
            let current = epoch.clone();
            f.service.set_delegation_runtime(
                Arc::new(|owner| owner == "owner"),
                Arc::new(move || current.load(Ordering::SeqCst)),
                "test-process".into(),
                Arc::new(|| {}),
            );
            let grant = f
                .service
                .delegate(
                    &f.p,
                    &row.id,
                    row.generation,
                    session("chat"),
                    Some(1020),
                    &Authority,
                )
                .await
                .unwrap();
            let down = Arc::new(tokio::sync::Notify::new());
            let started = down.clone();
            let ups = Arc::new(AtomicU64::new(0));
            let released = ups.clone();
            let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(
                Arc::new(move |request, _| {
                    let started = started.clone();
                    let released = released.clone();
                    Box::pin(async move {
                        if request.command == "key_down" {
                            started.notify_one();
                        }
                        if request.command == "key_up" {
                            released.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(serde_json::json!({"success":true}))
                    })
                }),
            );
            f.service
                .control_slot(&row.id, row.generation)
                .await
                .lock()
                .await
                .client = Some(client);
            let service = f.service.clone();
            let id = row.id.clone();
            let generation = row.generation;
            let agent = tokio::spawn(async move {
                service
                    .agent_operation(
                        &id,
                        generation,
                        Some("chat".into()),
                        None,
                        Action::HoldKey {
                            chord: crate::automation::types::KeyChord("Control".into()),
                            duration_ms: 30_000,
                        },
                    )
                    .await
            });
            tokio::time::timeout(std::time::Duration::from_secs(3), down.notified())
                .await
                .unwrap();
            let status = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                f.service.control_status(&f.p, &row.id, row.generation),
            )
            .await
            .expect("human status must not wait for HoldKey")
            .unwrap();
            assert!(
                status.can_acquire,
                "a healthy agent hold must keep human takeover available"
            );
            tokio::time::timeout(
                std::time::Duration::from_millis(500),
                f.service
                    .native_frame_admission(&f.p, &row.id, row.generation, &Authority),
            )
            .await
            .expect("stream admission must not wait for HoldKey")
            .unwrap();
            let frame = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                f.service
                    .native_stream_frame(&f.p, &row.id, row.generation, &Authority),
            )
            .await
            .expect("stream capture must skip an occupied agent slot");
            assert_eq!(frame.unwrap_err().code, "managed_desktop_frame_busy");
            match reason {
                ManagedDesktopDelegationEndReason::Revoked => {
                    f.service
                        .delegation_revoke(&f.p, &grant.id, grant.revision, &Authority)
                        .await
                        .unwrap();
                }
                ManagedDesktopDelegationEndReason::Expired => {
                    f.clock.store(1020, Ordering::SeqCst);
                }
                ManagedDesktopDelegationEndReason::AccountChanged => {
                    epoch.fetch_add(2, Ordering::SeqCst);
                }
                _ => unreachable!(),
            }
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), agent)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                outcome,
                Err(crate::automation::types::AutomationError::PreemptedBeforeSend)
            ));
            assert_eq!(ups.load(Ordering::SeqCst), 1);
            assert_eq!(
                f.service.state.lock().await.delegations[&grant.id].end_reason,
                Some(reason)
            );
            assert!(!f
                .service
                .state
                .lock()
                .await
                .control_quarantines
                .contains(&row.id));
        }
    }

    #[tokio::test]
    async fn revoked_held_key_with_uncertain_release_remains_quarantined() {
        let (f, row, _) = fixture().await;
        let grant = f
            .service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let down = Arc::new(tokio::sync::Notify::new());
        let started = down.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |request, _| {
                let started = started.clone();
                Box::pin(async move {
                    if request.command == "key_down" {
                        started.notify_one();
                    }
                    if request.command == "key_up" {
                        Err(crate::automation::types::AutomationError::BackendError {
                            message: "lost key release acknowledgement".into(),
                        })
                    } else {
                        Ok(serde_json::json!({"success":true}))
                    }
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        let service = f.service.clone();
        let id = row.id.clone();
        let generation = row.generation;
        let agent = tokio::spawn(async move {
            service
                .agent_operation(
                    &id,
                    generation,
                    Some("chat".into()),
                    None,
                    Action::HoldKey {
                        chord: crate::automation::types::KeyChord("Control".into()),
                        duration_ms: 30_000,
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), down.notified())
            .await
            .unwrap();
        f.service
            .delegation_revoke(&f.p, &grant.id, grant.revision, &Authority)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), agent)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(f
            .service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        assert_eq!(
            f.service
                .control_status(&f.p, &row.id, row.generation)
                .await
                .unwrap()
                .state,
            "quarantined"
        );
    }

    #[tokio::test]
    async fn disabling_the_switch_or_invalidating_receipts_between_sends_fences_the_pump() {
        for stale_receipt in [false, true] {
            let (f, row, _) = fixture().await;
            f.service
                .delegate(
                    &f.p,
                    &row.id,
                    row.generation,
                    session("chat"),
                    None,
                    &Authority,
                )
                .await
                .unwrap();
            let service = f.service.clone();
            let sent = Arc::new(AtomicU64::new(0));
            let observed = sent.clone();
            let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(
                Arc::new(move |_, _| {
                    let service = service.clone();
                    let sent = observed.clone();
                    Box::pin(async move {
                        sent.fetch_add(1, Ordering::SeqCst);
                        if !stale_receipt {
                            let mut registry = service.registry().await.unwrap();
                            registry.providers[0].enablement.agent_control = false;
                            service.save_registry(registry).await.unwrap();
                        }
                        service
                            .transaction(|state, _| {
                                if stale_receipt {
                                    state.control_qualifications.clear();
                                }
                                Ok(())
                            })
                            .await
                            .unwrap();
                        Ok(serde_json::json!({"success":true}))
                    })
                }),
            );
            f.service
                .control_slot(&row.id, row.generation)
                .await
                .lock()
                .await
                .client = Some(client);
            assert!(matches!(
                f.service
                    .agent_operation(
                        &row.id,
                        row.generation,
                        Some("chat".into()),
                        None,
                        Action::Scroll {
                            target: crate::automation::types::ScrollTarget::Point { x: 1, y: 1 },
                            opts: Default::default()
                        }
                    )
                    .await,
                Err(crate::automation::types::AutomationError::PreemptedBeforeSend)
            ));
            assert_eq!(sent.load(Ordering::SeqCst), 1);
        }
    }
    #[tokio::test]
    async fn journal_lock_contention_does_not_refuse_a_fenced_send() {
        use crate::automation::types::{ScrollOpts, ScrollTarget};
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let held = Arc::new(parking_lot::Mutex::new(None));
        let blocker = held.clone();
        let second = Arc::new(tokio::sync::Notify::new());
        let sent = second.clone();
        let service = f.service.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |request, _| {
                let service = service.clone();
                let blocker = blocker.clone();
                let sent = sent.clone();
                Box::pin(async move {
                    if request.command == "move_cursor" {
                        *blocker.lock() = Some(service.state.clone().lock_owned().await);
                    } else {
                        assert!(
                            service.state.try_lock().is_err(),
                            "journal is deliberately busy"
                        );
                        sent.notify_one();
                    }
                    Ok(serde_json::json!({"success":true}))
                })
            },
        ));
        f.service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        let service = f.service.clone();
        let id = row.id.clone();
        let operation = tokio::spawn(async move {
            service
                .agent_operation(
                    &id,
                    1,
                    Some("chat".into()),
                    None,
                    Action::Scroll {
                        target: ScrollTarget::Point { x: 1, y: 2 },
                        opts: ScrollOpts::default(),
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), second.notified())
            .await
            .unwrap();
        drop(held.lock().take());
        operation.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn read_operations_coalesce_activity_and_unchanged_transactions_do_not_save() {
        use base64::Engine;
        let (f, row, _) = fixture().await;
        f.service
            .delegate(
                &f.p,
                &row.id,
                row.generation,
                session("chat"),
                None,
                &Authority,
            )
            .await
            .unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let image = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |_, _| {
                let image = image.clone();
                Box::pin(async move { Ok(serde_json::json!({"image_data":image})) })
            },
        ));
        f.service.control_slot(&row.id, 1).await.lock().await.client = Some(client);
        let before = f.service.store.saves.load(Ordering::SeqCst);
        let epoch = f.service.enablement_epoch.load(Ordering::SeqCst);
        f.clock.store(31_000, Ordering::SeqCst);
        f.service
            .agent_operation(
                &row.id,
                1,
                Some("chat".into()),
                None,
                Action::Screenshot {
                    opts: Default::default(),
                },
            )
            .await
            .unwrap();
        assert!(f.service.store.saves.load(Ordering::SeqCst) - before <= 1);
        let checkpoint = f.service.store.saves.load(Ordering::SeqCst);
        for now in [31_001, 32_000, 40_000] {
            f.clock.store(now, Ordering::SeqCst);
            f.service
                .agent_operation(
                    &row.id,
                    1,
                    Some("chat".into()),
                    None,
                    Action::Screenshot {
                        opts: Default::default(),
                    },
                )
                .await
                .unwrap();
        }
        assert_eq!(f.service.store.saves.load(Ordering::SeqCst), checkpoint);
        assert_eq!(f.service.enablement_epoch.load(Ordering::SeqCst), epoch);
        assert_eq!(
            f.service.state.lock().await.desktops[&row.id].last_activity_at,
            40_000
        );
        f.service.diagnostic_checkpoint().await.unwrap();
        assert!(f
            .service
            .agent_operation(
                "unknown",
                1,
                Some("chat".into()),
                None,
                Action::CursorPosition
            )
            .await
            .is_err());
        assert_eq!(f.service.store.saves.load(Ordering::SeqCst), checkpoint);
    }

    #[tokio::test]
    async fn acknowledged_input_stays_successful_after_revocation_and_checkpoint_failure() {
        for fail_checkpoint in [false, true] {
            let (f, row, _) = fixture().await;
            let epoch = Arc::new(AtomicU64::new(1));
            let reader = epoch.clone();
            f.service.set_delegation_runtime(
                Arc::new(|owner| owner == "owner"),
                Arc::new(move || reader.load(Ordering::SeqCst)),
                "test-process".into(),
                Arc::new(|| {}),
            );
            f.service
                .delegate(&f.p, &row.id, 1, session("chat"), None, &Authority)
                .await
                .unwrap();
            let path = f.directory.path().to_owned();
            let clock = f.clock.clone();
            let calls = Arc::new(AtomicU64::new(0));
            let sent = calls.clone();
            let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(
                Arc::new(move |_, _| {
                    let epoch = epoch.clone();
                    let sent = sent.clone();
                    let path = path.clone();
                    let clock = clock.clone();
                    Box::pin(async move {
                        sent.fetch_add(1, Ordering::SeqCst);
                        epoch.fetch_add(1, Ordering::SeqCst);
                        clock.store(31_000, Ordering::SeqCst);
                        if fail_checkpoint {
                            // Only this fixture's temporary journal is made unwritable.
                            std::fs::remove_file(path.join("managed-desktops-journal.json"))
                                .unwrap();
                            std::fs::create_dir(path.join("managed-desktops-journal.json"))
                                .unwrap();
                        }
                        Ok(serde_json::json!({"success":true}))
                    })
                }),
            );
            f.service.control_slot(&row.id, 1).await.lock().await.client = Some(client);
            f.service
                .agent_operation(
                    &row.id,
                    1,
                    Some("chat".into()),
                    None,
                    Action::Keys {
                        chord: crate::automation::types::KeyChord("a".into()),
                    },
                )
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                f.service.state.lock().await.desktops[&row.id].last_activity_at,
                31_000
            );
        }
    }

    #[tokio::test]
    async fn held_buttons_are_released_when_the_grant_ends_and_uncertain_cleanup_quarantines() {
        for reason in [
            ManagedDesktopDelegationEndReason::Completed,
            ManagedDesktopDelegationEndReason::Revoked,
            ManagedDesktopDelegationEndReason::Expired,
            ManagedDesktopDelegationEndReason::AccountChanged,
            ManagedDesktopDelegationEndReason::Destroyed,
            ManagedDesktopDelegationEndReason::GenerationChanged,
        ] {
            for uncertain in [false, true] {
                let (f, row, _) = fixture().await;
                let epoch = Arc::new(AtomicU64::new(1));
                let reader = epoch.clone();
                f.service.set_delegation_runtime(
                    Arc::new(|owner| owner == "owner"),
                    Arc::new(move || reader.load(Ordering::SeqCst)),
                    "test-process".into(),
                    Arc::new(|| {}),
                );
                let grant = f
                    .service
                    .delegate(&f.p, &row.id, 1, session("chat"), Some(1020), &Authority)
                    .await
                    .unwrap();
                let ups = Arc::new(AtomicU64::new(0));
                let released = ups.clone();
                let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(
                    Arc::new(move |request, _| {
                        let released = released.clone();
                        Box::pin(async move {
                            if request.command == "mouse_up" {
                                released.fetch_add(1, Ordering::SeqCst);
                                if uncertain {
                                    return Err(
                                        crate::automation::types::AutomationError::BackendError {
                                            message: "uncertain release".into(),
                                        },
                                    );
                                }
                            }
                            Ok(serde_json::json!({"success":true}))
                        })
                    }),
                );
                f.service.control_slot(&row.id, 1).await.lock().await.client = Some(client);
                f.service
                    .agent_operation(
                        &row.id,
                        1,
                        Some("chat".into()),
                        None,
                        Action::MouseButton {
                            button: MouseButton::Left,
                            transition: ButtonTransition::Down,
                        },
                    )
                    .await
                    .unwrap();
                match reason {
                    ManagedDesktopDelegationEndReason::Completed => {
                        f.service.transaction(|s, now| {
                            s.delegations.get_mut(&grant.id).unwrap().end(reason, now);
                            Ok(())
                        }).await.unwrap();
                    }
                    ManagedDesktopDelegationEndReason::Revoked => {
                        f.service
                            .delegation_revoke(&f.p, &grant.id, grant.revision, &Authority)
                            .await
                            .unwrap();
                    }
                    ManagedDesktopDelegationEndReason::Expired => {
                        f.clock.store(1020, Ordering::SeqCst);
                    }
                    ManagedDesktopDelegationEndReason::AccountChanged => {
                        epoch.fetch_add(2, Ordering::SeqCst);
                    }
                    ManagedDesktopDelegationEndReason::Destroyed => {
                        f.service.delete(&f.p, &row.id, 1).await.unwrap();
                    }
                    ManagedDesktopDelegationEndReason::GenerationChanged => {
                        f.service
                            .transaction(|s, _| {
                                s.desktops.get_mut(&row.id).unwrap().desktop.generation += 1;
                                Ok(())
                            })
                            .await
                            .unwrap();
                    }
                }
                f.service.reconcile_delegations().await.unwrap();
                assert_eq!(ups.load(Ordering::SeqCst), 1, "{reason:?}");
                let slot = f.service.controls.lock().await[&row.id].clone();
                assert_eq!(
                    slot.lock().await.desktop.held_mouse_buttons.is_empty(),
                    !uncertain
                );
                assert_eq!(
                    f.service
                        .state
                        .lock()
                        .await
                        .control_quarantines
                        .contains(&row.id),
                    uncertain
                );
                if matches!(
                    reason,
                    ManagedDesktopDelegationEndReason::Destroyed
                        | ManagedDesktopDelegationEndReason::GenerationChanged
                ) {
                    assert!(!f
                        .service
                        .agent_preemptions
                        .lock()
                        .await
                        .contains_key(&row.id));
                }
            }
        }
    }

    #[tokio::test]
    async fn binding_checks_are_cached_by_epoch_and_ended_history_is_per_owner() {
        let (f, row, _) = fixture().await;
        let checks = Arc::new(AtomicU64::new(0));
        let observed = checks.clone();
        let epoch = Arc::new(AtomicU64::new(1));
        let reader = epoch.clone();
        f.service.set_delegation_runtime(
            Arc::new(move |owner| {
                observed.fetch_add(1, Ordering::SeqCst);
                owner == "owner"
            }),
            Arc::new(move || reader.load(Ordering::SeqCst)),
            "test-process".into(),
            Arc::new(|| {}),
        );
        let grant = f
            .service
            .delegate(&f.p, &row.id, 1, session("chat"), None, &Authority)
            .await
            .unwrap();
        for _ in 0..3 {
            cursor(&f, &row, "chat", None).await.unwrap();
        }
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        f.service
            .transaction(|state, now| {
                for owner in ["owner", "second-owner"] {
                    for index in 0..70 {
                        let mut ended = grant.clone();
                        ended.id = format!("history-{owner}-{index:02}");
                        ended.owner_principal_id = owner.into();
                        ended.end(ManagedDesktopDelegationEndReason::Revoked, now);
                        state.delegations.insert(ended.id.clone(), ended);
                    }
                }
                Ok(())
            })
            .await
            .unwrap();
        let state = f.service.state.lock().await;
        for owner in ["owner", "second-owner"] {
            assert_eq!(
                state
                    .delegations
                    .values()
                    .filter(|g| g.owner_principal_id == owner
                        && g.state == ManagedDesktopDelegationState::Ended)
                    .count(),
                64
            );
        }
        drop(state);
        assert_eq!(
            checks.load(Ordering::SeqCst),
            1,
            "ended grants never trigger owner lookups"
        );
        epoch.fetch_add(2, Ordering::SeqCst);
        assert!(cursor(&f, &row, "chat", None).await.is_err());
        assert_eq!(checks.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn another_live_grant_cannot_send_until_ended_grant_input_is_released() {
        let (f, row, _) = fixture().await;
        let old = f
            .service
            .delegate(&f.p, &row.id, 1, session("old"), None, &Authority)
            .await
            .unwrap();
        f.service
            .delegate(&f.p, &row.id, 1, session("new"), None, &Authority)
            .await
            .unwrap();
        let ups = Arc::new(AtomicU64::new(0));
        let released = ups.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |request, _| {
                let released = released.clone();
                Box::pin(async move {
                    if request.command == "mouse_up" {
                        released.fetch_add(1, Ordering::SeqCst);
                    }
                    if request.command == crate::cua_sandbox::protocol::CURSOR_POSITION {
                        assert_eq!(released.load(Ordering::SeqCst), 1);
                    }
                    Ok(serde_json::json!({"x":1,"y":2}))
                })
            },
        ));
        let slot = f.service.control_slot(&row.id, 1).await;
        slot.lock().await.client = Some(client);
        f.service
            .agent_operation(
                &row.id,
                1,
                Some("old".into()),
                None,
                Action::MouseButton {
                    button: MouseButton::Left,
                    transition: ButtonTransition::Down,
                },
            )
            .await
            .unwrap();
        let control = slot.lock().await;
        assert!(f.service.agent_live(&row.id, 1, Some("new"), None));
        f.service
            .delegation_revoke(&f.p, &old.id, old.revision, &Authority)
            .await
            .unwrap();
        assert_eq!(
            ups.load(Ordering::SeqCst),
            0,
            "cleanup yields to an occupied slot"
        );
        assert!(
            !f.service.agent_live(&row.id, 1, Some("new"), None),
            "even a previously admitted live grant must wait for cleanup"
        );
        drop(control);
        cursor(&f, &row, "new", None).await.unwrap();
        assert_eq!(ups.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancelling_an_active_agent_keeps_uncertain_input_quarantined() {
        let (f, row, _) = fixture().await;
        f.service
            .delegate(&f.p, &row.id, 1, session("chat"), None, &Authority)
            .await
            .unwrap();
        let down = Arc::new(tokio::sync::Notify::new());
        let started = down.clone();
        let client = crate::cua_sandbox::remote_client::CuaRemoteClient::from_handler(Arc::new(
            move |request, _| {
                let started = started.clone();
                Box::pin(async move {
                    if request.command == "key_down" {
                        started.notify_one();
                    }
                    Ok(serde_json::json!({"success":true}))
                })
            },
        ));
        f.service.control_slot(&row.id, 1).await.lock().await.client = Some(client);
        let service = f.service.clone();
        let id = row.id.clone();
        let agent = tokio::spawn(async move {
            service
                .agent_operation(
                    &id,
                    1,
                    Some("chat".into()),
                    None,
                    Action::HoldKey {
                        chord: crate::automation::types::KeyChord("Control".into()),
                        duration_ms: 30_000,
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), down.notified())
            .await
            .unwrap();
        assert!(
            f.service
                .control_status(&f.p, &row.id, 1)
                .await
                .unwrap()
                .can_acquire
        );
        agent.abort();
        assert!(agent.await.unwrap_err().is_cancelled());
        let status = f.service.control_status(&f.p, &row.id, 1).await.unwrap();
        assert_eq!(status.state, "quarantined");
        assert!(!status.can_acquire);
    }
}
