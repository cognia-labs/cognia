use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::types::AdapterRegistration;

const RUNTIME_LEASE_MIN_TTL_MS: u64 = 5_000;
const RUNTIME_LEASE_MAX_TTL_MS: u64 = 60_000;
const RUNTIME_LEASE_MAX_OWNER_BYTES: usize = 128;

/// Which kind of process holds (or wants) the runtime lease.
///
/// Encoded as the owner-id prefix the callers already use (`brain:<uuid>` /
/// `desktop:<uuid>`) so no separate field has to travel the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeOwnerClass {
    /// A desktop webview runtime. Intermittent by nature — the machine sleeps,
    /// the window closes — so it yields to an always-on brain.
    Desktop,
    /// A `cognia-agent serve` brain process, local or in the cloud.
    Brain,
}

/// Classify an owner id. Anything unprefixed is treated as `Desktop`, the
/// lower-priority class: an unrecognised owner must never be able to evict a
/// brain by accident.
pub fn runtime_owner_class(owner_id: &str) -> RuntimeOwnerClass {
    if owner_id.starts_with("brain:") {
        RuntimeOwnerClass::Brain
    } else {
        RuntimeOwnerClass::Desktop
    }
}

#[derive(Debug, Clone)]
struct ConnectorRuntimeLease {
    owner_id: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct ConnectorsStateInner {
    pub registered_adapters: HashMap<String, AdapterRegistration>,
    pub server_running: bool,
    pub bound_addr: Option<String>,
    runtime_lease: Option<ConnectorRuntimeLease>,
}

#[derive(Clone, Default)]
pub struct ConnectorsState {
    pub inner: Arc<Mutex<ConnectorsStateInner>>,
}

impl ConnectorsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a clone of self — used when the lifecycle needs to pass state
    /// into the axum server without consuming the managed copy.
    pub fn inner_state(&self) -> Self {
        self.clone()
    }

    /// Acquire or refresh the host-scoped connector-runtime lease.
    ///
    /// The lease lives in the Rust host rather than the renderer, so multiple
    /// Node brain processes and desktop webviews cannot each boot the same
    /// connector transports. An expired lease may be taken over by a new owner.
    ///
    /// A live lease is also preemptible **upward by class**: a `brain:` owner
    /// takes over from a `desktop:` one immediately rather than waiting out
    /// the TTL. Without that, closing a laptop lid would strand the bots for
    /// up to a full TTL, and a desktop that happened to boot first would keep
    /// the always-on process shut out indefinitely. The reverse is refused —
    /// a desktop never evicts a running brain.
    pub fn acquire_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.acquire_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Renew an unexpired lease held by `owner_id`.
    pub fn renew_runtime_lease(&self, owner_id: &str, ttl_ms: u64) -> Result<bool, String> {
        self.renew_runtime_lease_at(owner_id, ttl_ms, Instant::now())
    }

    /// Release the lease only when it belongs to `owner_id`.
    pub fn release_runtime_lease(&self, owner_id: &str) -> Result<bool, String> {
        validate_runtime_lease_owner(owner_id)?;
        let mut inner = self.inner.lock();
        if inner
            .runtime_lease
            .as_ref()
            .is_some_and(|lease| lease.owner_id == owner_id)
        {
            inner.runtime_lease = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn acquire_runtime_lease_at(
        &self,
        owner_id: &str,
        ttl_ms: u64,
        now: Instant,
    ) -> Result<bool, String> {
        validate_runtime_lease(owner_id, ttl_ms)?;
        let expires_at = lease_expiry(now, ttl_ms)?;
        let want = runtime_owner_class(owner_id);
        let mut inner = self.inner.lock();
        if inner.runtime_lease.as_ref().is_some_and(|lease| {
            lease.expires_at > now
                && lease.owner_id != owner_id
                && want <= runtime_owner_class(&lease.owner_id)
        }) {
            return Ok(false);
        }
        inner.runtime_lease = Some(ConnectorRuntimeLease {
            owner_id: owner_id.to_string(),
            expires_at,
        });
        Ok(true)
    }

    fn renew_runtime_lease_at(
        &self,
        owner_id: &str,
        ttl_ms: u64,
        now: Instant,
    ) -> Result<bool, String> {
        validate_runtime_lease(owner_id, ttl_ms)?;
        let expires_at = lease_expiry(now, ttl_ms)?;
        let mut inner = self.inner.lock();
        let Some(lease) = inner.runtime_lease.as_mut() else {
            return Ok(false);
        };
        // A preempted owner learns it lost here: renew answers false and the
        // caller tears its transports down, exactly as on TTL loss.
        if lease.expires_at <= now {
            inner.runtime_lease = None;
            return Ok(false);
        }
        if lease.owner_id != owner_id {
            return Ok(false);
        }
        lease.expires_at = expires_at;
        Ok(true)
    }
}

fn validate_runtime_lease(owner_id: &str, ttl_ms: u64) -> Result<(), String> {
    validate_runtime_lease_owner(owner_id)?;
    if !(RUNTIME_LEASE_MIN_TTL_MS..=RUNTIME_LEASE_MAX_TTL_MS).contains(&ttl_ms) {
        return Err(format!(
            "connector runtime lease TTL must be between {RUNTIME_LEASE_MIN_TTL_MS} and {RUNTIME_LEASE_MAX_TTL_MS} ms"
        ));
    }
    Ok(())
}

fn validate_runtime_lease_owner(owner_id: &str) -> Result<(), String> {
    if owner_id.trim().is_empty() || owner_id.len() > RUNTIME_LEASE_MAX_OWNER_BYTES {
        return Err(format!(
            "connector runtime lease owner must be 1-{RUNTIME_LEASE_MAX_OWNER_BYTES} bytes"
        ));
    }
    Ok(())
}

fn lease_expiry(now: Instant, ttl_ms: u64) -> Result<Instant, String> {
    now.checked_add(Duration::from_millis(ttl_ms))
        .ok_or_else(|| "connector runtime lease expiry overflow".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdapterRegistration;

    #[test]
    fn registers_and_unregisters() {
        let s = ConnectorsState::new();
        s.inner.lock().registered_adapters.insert(
            "a".into(),
            AdapterRegistration {
                adapter_id: "a".into(),
                adapter_type: "telegram".into(),
                webhook_path: None,
            },
        );
        assert_eq!(s.inner.lock().registered_adapters.len(), 1);
        s.inner.lock().registered_adapters.remove("a");
        assert_eq!(s.inner.lock().registered_adapters.len(), 0);
    }

    #[test]
    fn runtime_lease_allows_one_owner_until_expiry() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start)
            .unwrap());
        assert!(!state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1))
            .unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start + Duration::from_millis(2))
            .unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(15_003))
            .unwrap());
    }

    #[test]
    fn runtime_lease_renew_and_release_are_owner_bound() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain-a", 15_000, start)
            .unwrap());

        assert!(!state
            .renew_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1_000))
            .unwrap());
        assert!(state
            .renew_runtime_lease_at("brain-a", 15_000, start + Duration::from_millis(1_000))
            .unwrap());
        assert!(!state.release_runtime_lease("brain-b").unwrap());
        assert!(state.release_runtime_lease("brain-a").unwrap());
        assert!(state
            .acquire_runtime_lease_at("brain-b", 15_000, start + Duration::from_millis(1_001))
            .unwrap());
    }

    #[test]
    fn owner_class_is_read_off_the_id_prefix_and_defaults_to_desktop() {
        assert_eq!(runtime_owner_class("brain:abc"), RuntimeOwnerClass::Brain);
        assert_eq!(
            runtime_owner_class("desktop:abc"),
            RuntimeOwnerClass::Desktop
        );
        // Anything unrecognised is the LOWER class — an owner id we cannot
        // classify must never be able to evict a running brain by accident.
        for unknown in ["brain-a", "", "Brain:abc", "cli:abc"] {
            assert_eq!(runtime_owner_class(unknown), RuntimeOwnerClass::Desktop);
        }
        assert!(RuntimeOwnerClass::Brain > RuntimeOwnerClass::Desktop);
    }

    #[test]
    fn a_brain_preempts_a_live_desktop_lease_but_not_the_reverse() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        // Desktop boots first and holds a live lease.
        assert!(state
            .acquire_runtime_lease_at("desktop:one", 15_000, start)
            .unwrap());
        // The always-on process takes over immediately rather than waiting out
        // the TTL — otherwise a desktop that happened to boot first would keep
        // the bots off the brain indefinitely.
        assert!(state
            .acquire_runtime_lease_at("brain:one", 15_000, start + Duration::from_millis(1))
            .unwrap());
        // The evicted desktop learns it lost on its next renew.
        assert!(!state
            .renew_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(2))
            .unwrap());
        // ...and cannot take it back while the brain's lease is live.
        assert!(!state
            .acquire_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(3))
            .unwrap());
        // Nor can it release someone else's lease out from under them.
        assert!(!state.release_runtime_lease("desktop:one").unwrap());
    }

    #[test]
    fn a_desktop_takes_over_once_the_brain_lease_expires() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain:one", 15_000, start)
            .unwrap());
        // Priority only applies to a LIVE lease; a brain that stopped
        // renewing must not strand the bots forever.
        assert!(state
            .acquire_runtime_lease_at("desktop:one", 15_000, start + Duration::from_millis(15_001))
            .unwrap());
    }

    #[test]
    fn two_brains_still_contend_first_come_first_served() {
        let state = ConnectorsState::new();
        let start = Instant::now();
        assert!(state
            .acquire_runtime_lease_at("brain:one", 15_000, start)
            .unwrap());
        // Same class → no preemption, or two cloud replicas would flap the
        // lease between them on every renew interval.
        assert!(!state
            .acquire_runtime_lease_at("brain:two", 15_000, start + Duration::from_millis(1))
            .unwrap());
    }

    #[test]
    fn runtime_lease_rejects_invalid_owner_and_ttl() {
        let state = ConnectorsState::new();
        let start = Instant::now();

        assert!(state.acquire_runtime_lease_at("", 15_000, start).is_err());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 1_000, start)
            .is_err());
        assert!(state
            .acquire_runtime_lease_at("brain-a", 120_000, start)
            .is_err());
    }
}
