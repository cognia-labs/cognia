//! Which long-lived process owners still run on an older proxy policy.
//!
//! Native HTTP and WebSocket clients read the live policy per request, so a
//! settings change reaches their next connection. A child process cannot be
//! reconfigured that way: the policy is baked into its environment when it is
//! spawned (`child_network_env`, the sidecar's managed proxy variables) and
//! stays there until the process is replaced. Without a record of which
//! revision each such process was started on, "the proxy setting was saved"
//! and "every component now uses it" read as the same fact, and they are not.
//!
//! An owner registers the revision it spawned its child with and keeps the
//! [`OwnerRegistration`] for as long as that child lives; dropping it removes
//! the entry. [`applications`] is the read model the settings UI shows.
//! Nothing here restarts anything: the owner decides when replacing its
//! process is safe. The sidecar is offered each new policy once, right after
//! `proxy_apply` publishes it, and replaces itself only if no turn is in
//! flight; otherwise it stays `restart-pending` until it is restarted.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use super::{policy_ready, policy_revision, policy_revision_label};

/// A kind of process that carries the policy in its environment. A closed
/// set, so the UI can name each one and nobody files free-text owners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerKind {
    /// The Node/Bun agent sidecar and everything it spawns.
    AgentRuntime,
}

impl OwnerKind {
    /// How a new policy reaches this owner.
    pub fn update(self) -> OwnerUpdate {
        match self {
            Self::AgentRuntime => OwnerUpdate::ProcessRestart,
        }
    }
}

/// How a new revision reaches an owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerUpdate {
    /// Only a replacement process sees it.
    ProcessRestart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerApplicationState {
    /// Running on the published revision.
    Current,
    /// Running on an older revision; its next replacement picks up the
    /// current one.
    RestartPending,
}

/// One live owner as the settings UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerApplication {
    pub owner: OwnerKind,
    pub update: OwnerUpdate,
    pub applied_revision: String,
    pub state: OwnerApplicationState,
}

struct Entry {
    kind: OwnerKind,
    revision: u64,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static OWNERS: Mutex<BTreeMap<u64, Entry>> = Mutex::new(BTreeMap::new());

/// Proof that a live child was started on `revision`. Dropping it — when the
/// child is reaped or replaced — removes the owner from [`applications`].
#[derive(Debug)]
pub struct OwnerRegistration {
    id: u64,
    revision: u64,
}

impl OwnerRegistration {
    /// The revision the child was spawned with.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Whether the published policy has moved on since the child was spawned.
    pub fn is_stale(&self) -> bool {
        self.revision != policy_revision()
    }

    /// Whether replacing the child now would hand it a newer, usable policy.
    /// A Blocked or uninitialized policy cannot spawn a replacement at all, so
    /// tearing the old child down would only turn "old proxy" into "no agent".
    pub fn replacement_would_apply(&self) -> bool {
        self.is_stale() && policy_ready()
    }
}

impl Drop for OwnerRegistration {
    fn drop(&mut self) {
        owners().remove(&self.id);
    }
}

fn owners() -> std::sync::MutexGuard<'static, BTreeMap<u64, Entry>> {
    OWNERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record that `kind` just spawned a child with the policy read at `revision`
/// (take it from [`super::current_with_revision`], in the same read as the
/// config the child was given).
pub fn register(kind: OwnerKind, revision: u64) -> OwnerRegistration {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    owners().insert(id, Entry { kind, revision });
    OwnerRegistration { id, revision }
}

/// Every live owner, oldest registration first.
pub fn applications() -> Vec<OwnerApplication> {
    let current = policy_revision();
    owners()
        .values()
        .map(|entry| OwnerApplication {
            owner: entry.kind,
            update: entry.kind.update(),
            applied_revision: policy_revision_label(entry.revision),
            state: if entry.revision == current {
                OwnerApplicationState::Current
            } else {
                OwnerApplicationState::RestartPending
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_config::{
        apply_current, block_current, current_with_revision, ProxyConfig, ProxyError,
        ProxyErrorCode, ProxyMode, NETWORK_ENV_TEST,
    };

    fn manual(port: u16) -> ProxyConfig {
        ProxyConfig {
            mode: ProxyMode::Manual,
            host: "127.0.0.1".into(),
            port,
            ..ProxyConfig::default()
        }
    }

    fn agent_runtime_rows() -> Vec<OwnerApplication> {
        applications()
            .into_iter()
            .filter(|row| row.owner == OwnerKind::AgentRuntime)
            .collect()
    }

    #[tokio::test]
    async fn an_identical_reapply_keeps_the_revision_and_a_change_advances_it() {
        let _guard = NETWORK_ENV_TEST.lock().await;
        apply_current(manual(7890)).unwrap();
        let first = policy_revision();
        apply_current(manual(7890)).unwrap();
        assert_eq!(policy_revision(), first, "same policy, same revision");

        apply_current(manual(7891)).unwrap();
        let second = policy_revision();
        assert!(second > first);

        // A new credential is a new policy even though nothing visible changed.
        let mut credentialed = manual(7891);
        credentialed.username = Some("user".into());
        credentialed.password = Some("one".into());
        apply_current(credentialed.clone()).unwrap();
        let third = policy_revision();
        assert!(third > second);
        credentialed.password = Some("two".into());
        apply_current(credentialed).unwrap();
        assert!(policy_revision() > third);
    }

    #[tokio::test]
    async fn config_and_revision_are_read_together() {
        let _guard = NETWORK_ENV_TEST.lock().await;
        apply_current(manual(7001)).unwrap();
        let (config, revision) = current_with_revision();
        assert_eq!(config.unwrap().port, 7001);
        assert_eq!(revision, policy_revision());

        let error = ProxyError::new(ProxyErrorCode::ProxyInvalidConfig, "bad");
        block_current(error.clone());
        let (blocked, blocked_revision) = current_with_revision();
        assert_eq!(blocked.unwrap_err(), error);
        assert!(blocked_revision > revision);
        assert!(!policy_ready());
    }

    #[tokio::test]
    async fn the_label_is_opaque_and_bound_to_this_process() {
        let label = policy_revision_label(7);
        let (epoch, revision) = label.rsplit_once('-').unwrap();
        assert_eq!(revision, "7");
        assert!(!epoch.is_empty());
        assert_eq!(policy_revision_label(7), label, "stable within a process");
    }

    #[tokio::test]
    async fn an_owner_goes_pending_after_a_change_and_disappears_when_dropped() {
        let _guard = NETWORK_ENV_TEST.lock().await;
        apply_current(manual(7100)).unwrap();
        let registration = register(OwnerKind::AgentRuntime, policy_revision());
        assert!(!registration.is_stale());
        assert_eq!(
            agent_runtime_rows()
                .iter()
                .map(|row| row.state)
                .collect::<Vec<_>>(),
            vec![OwnerApplicationState::Current]
        );

        apply_current(manual(7101)).unwrap();
        assert!(registration.is_stale());
        assert!(registration.replacement_would_apply());
        let rows = agent_runtime_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, OwnerApplicationState::RestartPending);
        assert_eq!(rows[0].update, OwnerUpdate::ProcessRestart);
        assert_eq!(
            rows[0].applied_revision,
            policy_revision_label(registration.revision())
        );

        drop(registration);
        assert!(agent_runtime_rows().is_empty());
    }

    #[tokio::test]
    async fn a_blocked_policy_is_stale_but_not_worth_a_replacement() {
        let _guard = NETWORK_ENV_TEST.lock().await;
        apply_current(manual(7200)).unwrap();
        let registration = register(OwnerKind::AgentRuntime, policy_revision());
        block_current(ProxyError::new(
            ProxyErrorCode::ProxyCredentialUnavailable,
            "keyring",
        ));
        assert!(registration.is_stale());
        assert!(!registration.replacement_would_apply());
    }

    #[test]
    fn the_wire_shape_is_camel_case_with_kebab_enums() {
        let row = OwnerApplication {
            owner: OwnerKind::AgentRuntime,
            update: OwnerUpdate::ProcessRestart,
            applied_revision: "a-1".into(),
            state: OwnerApplicationState::RestartPending,
        };
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::json!({
                "owner": "agent-runtime",
                "update": "process-restart",
                "appliedRevision": "a-1",
                "state": "restart-pending",
            })
        );
    }
}
