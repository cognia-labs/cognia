//! Bounded in-memory replay cache for short-lived signed assertions.
//!
//! Entries are retained until their assertion expires, so a replay cannot be
//! accepted merely because newer assertions arrived. Regular inserts do not
//! scan the cache for expired entries; the capacity checks do that work only
//! when a limit is reached, and at most once until something can have
//! expired, keeping cleanup off the request hot path. If every retained
//! assertion is still valid, the cache fails closed and rejects the new
//! assertion rather than weakening replay protection. That refusal is
//! [`Redemption::Full`] or [`Redemption::ScopeFull`], not
//! [`Redemption::Replayed`]: the assertion was never seen, so callers must not
//! report it as a replay.
//!
//! Assertions can be grouped into scopes (one per signing device), each with
//! its own quota under the shared total, so one busy or hostile scope fills
//! only its own share and refuses only its own assertions.

use parking_lot::Mutex;
use std::collections::HashMap;

const MAX_ENTRIES: usize = 4096;

pub struct ReplayCache {
    max_total: usize,
    max_per_scope: usize,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    scopes: HashMap<String, Scope>,
    total: usize,
    /// While the total is at its limit, no entry expires before this.
    full_until: i64,
}

#[derive(Default)]
struct Scope {
    entries: HashMap<String, i64>,
    /// While this scope is at its quota, none of its entries expires before this.
    full_until: i64,
}

/// What [`ReplayCache::redeem`] did with an assertion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redemption {
    /// First sighting within its validity window; now retained.
    Fresh,
    /// Already observed and still valid.
    Replayed,
    /// Never observed, but every retained assertion is still valid, so there
    /// is no room to record it. Refused without weakening replay protection;
    /// `retry_after_secs` is when the soonest retained assertion expires.
    Full { retry_after_secs: i64 },
    /// Never observed, but its scope has used its whole quota; only that
    /// scope's assertions are refused. `retry_after_secs` as for `Full`.
    ScopeFull { retry_after_secs: i64 },
}

fn soonest(expiries: impl Iterator<Item = i64>, now: i64) -> i64 {
    expiries.min().unwrap_or(now)
}

impl ReplayCache {
    /// One shared scope of 4096 assertions.
    pub fn new() -> Self {
        Self::with_limits(MAX_ENTRIES, MAX_ENTRIES)
    }

    /// At most `max_total` assertions in all, and `max_per_scope` in any one scope.
    pub fn with_limits(max_total: usize, max_per_scope: usize) -> Self {
        Self { max_total, max_per_scope: max_per_scope.min(max_total), inner: Mutex::default() }
    }

    /// Returns `true` only when `assertion_id` has not already been observed
    /// during its validity window and could be recorded.
    pub fn mark_redeemed(&self, assertion_id: &str, expires_at: i64, now: i64) -> bool {
        self.redeem(assertion_id, expires_at, now) == Redemption::Fresh
    }

    /// Record `assertion_id` until `expires_at`, telling a replay apart from a
    /// cache with no room left.
    pub fn redeem(&self, assertion_id: &str, expires_at: i64, now: i64) -> Redemption {
        self.redeem_in_scope("", assertion_id, expires_at, now)
    }

    /// [`Self::redeem`] within `scope`, which holds at most the per-scope quota.
    pub fn redeem_in_scope(&self, scope: &str, assertion_id: &str, expires_at: i64, now: i64) -> Redemption {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        if let Some(entries) = inner.scopes.get_mut(scope).map(|scope| &mut scope.entries) {
            if let Some(existing_expiry) = entries.get(assertion_id).copied() {
                if existing_expiry > now {
                    return Redemption::Replayed;
                }
                entries.remove(assertion_id);
                inner.total -= 1;
            }
        }
        // A quota equal to the total is no quota: the total answers first.
        if let Some(entries) = inner.scopes.get_mut(scope).filter(|_| self.max_per_scope < self.max_total) {
            if entries.entries.len() >= self.max_per_scope {
                if now >= entries.full_until {
                    let before = entries.entries.len();
                    entries.entries.retain(|_, expiry| *expiry > now);
                    inner.total -= before - entries.entries.len();
                    entries.full_until = soonest(entries.entries.values().copied(), now);
                }
                if entries.entries.len() >= self.max_per_scope {
                    return Redemption::ScopeFull { retry_after_secs: entries.full_until.saturating_sub(now).max(1) };
                }
            }
        }
        if inner.total >= self.max_total {
            if now >= inner.full_until {
                for scope in inner.scopes.values_mut() {
                    scope.entries.retain(|_, expiry| *expiry > now);
                }
                inner.scopes.retain(|_, scope| !scope.entries.is_empty());
                inner.total = inner.scopes.values().map(|scope| scope.entries.len()).sum();
                inner.full_until = soonest(inner.scopes.values().flat_map(|scope| scope.entries.values().copied()), now);
            }
            if inner.total >= self.max_total {
                return Redemption::Full { retry_after_secs: inner.full_until.saturating_sub(now).max(1) };
            }
        }
        inner.scopes.entry(scope.to_string()).or_default().entries.insert(assertion_id.to_string(), expires_at);
        inner.total += 1;
        Redemption::Fresh
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().total
    }
}

impl Default for ReplayCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;
    const EXPIRY: i64 = NOW + 300;

    #[test]
    fn rejects_replay_during_the_validity_window() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("assertion-1", EXPIRY, NOW));
        assert!(!cache.mark_redeemed("assertion-1", EXPIRY, NOW));
    }

    #[test]
    fn prunes_expired_entries() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("assertion-1", NOW + 1, NOW));
        assert!(cache.mark_redeemed("assertion-1", EXPIRY + 1, NOW + 2));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn regular_insert_does_not_scan_unrelated_expired_entries() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("expired", NOW + 1, NOW));
        assert!(cache.mark_redeemed("fresh", EXPIRY, NOW + 2));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn rejects_new_assertions_when_all_entries_are_still_valid() {
        let cache = ReplayCache::new();
        for index in 0..MAX_ENTRIES {
            assert!(cache.mark_redeemed(&format!("assertion-{index}"), EXPIRY, NOW));
        }
        assert!(!cache.mark_redeemed("overflow", EXPIRY, NOW));
        assert!(!cache.mark_redeemed("assertion-0", EXPIRY, NOW));
        assert_eq!(cache.len(), MAX_ENTRIES);
    }

    #[test]
    fn one_scope_fills_only_its_own_quota() {
        let cache = ReplayCache::with_limits(8, 3);
        for index in 0..3 {
            assert_eq!(cache.redeem_in_scope("noisy", &format!("n{index}"), EXPIRY, NOW), Redemption::Fresh);
        }
        assert_eq!(cache.redeem_in_scope("noisy", "n3", EXPIRY, NOW), Redemption::ScopeFull { retry_after_secs: 300 });
        // Its own replays are still replays, and other scopes are untouched.
        assert_eq!(cache.redeem_in_scope("noisy", "n0", EXPIRY, NOW), Redemption::Replayed);
        assert_eq!(cache.redeem_in_scope("quiet", "n3", EXPIRY, NOW), Redemption::Fresh);
        // The same id in another scope is another assertion.
        assert_eq!(cache.redeem_in_scope("quiet", "n0", EXPIRY, NOW), Redemption::Fresh);
        // The quota frees as its entries expire.
        assert_eq!(cache.redeem_in_scope("noisy", "n3", EXPIRY + 60, EXPIRY), Redemption::Fresh);
    }

    #[test]
    fn the_shared_total_still_bounds_many_scopes() {
        let cache = ReplayCache::with_limits(4, 3);
        for scope in ["a", "b", "c", "d"] {
            assert_eq!(cache.redeem_in_scope(scope, "x", EXPIRY, NOW), Redemption::Fresh);
        }
        assert_eq!(cache.redeem_in_scope("e", "x", EXPIRY, NOW), Redemption::Full { retry_after_secs: 300 });
        assert_eq!(cache.len(), 4);
        assert_eq!(cache.redeem_in_scope("e", "x", EXPIRY + 60, EXPIRY), Redemption::Fresh);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_full_cache_does_not_rescan_until_an_entry_can_have_expired() {
        let cache = ReplayCache::with_limits(2, 2);
        assert_eq!(cache.redeem_in_scope("a", "early", NOW + 10, NOW), Redemption::Fresh);
        assert_eq!(cache.redeem_in_scope("b", "late", NOW + 100, NOW), Redemption::Fresh);
        assert_eq!(cache.redeem_in_scope("c", "x", EXPIRY, NOW + 1), Redemption::Full { retry_after_secs: 9 });
        // Nothing can have expired yet: refused from the remembered bound.
        assert_eq!(cache.inner.lock().full_until, NOW + 10);
        assert_eq!(cache.redeem_in_scope("c", "x", EXPIRY, NOW + 5), Redemption::Full { retry_after_secs: 5 });
        // Once it can, the scan runs and frees the room.
        assert_eq!(cache.redeem_in_scope("c", "x", EXPIRY, NOW + 10), Redemption::Fresh);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn a_full_cache_is_not_reported_as_a_replay() {
        let cache = ReplayCache::new();
        for index in 0..MAX_ENTRIES {
            assert_eq!(cache.redeem(&format!("assertion-{index}"), EXPIRY, NOW), Redemption::Fresh);
        }
        assert_eq!(cache.redeem("never-seen", EXPIRY, NOW), Redemption::Full { retry_after_secs: 300 });
        assert_eq!(cache.redeem("assertion-0", EXPIRY, NOW), Redemption::Replayed);
        // Room returns once retained assertions expire.
        assert_eq!(cache.redeem("never-seen", EXPIRY + 60, EXPIRY), Redemption::Fresh);
    }

    #[test]
    fn prunes_expired_entries_at_capacity_before_accepting_a_new_assertion() {
        let cache = ReplayCache::new();
        assert!(cache.mark_redeemed("expired", NOW + 1, NOW));
        for index in 1..MAX_ENTRIES {
            assert!(cache.mark_redeemed(&format!("assertion-{index}"), EXPIRY, NOW));
        }

        assert!(cache.mark_redeemed("replacement", EXPIRY + 1, NOW + 2));
        assert_eq!(cache.len(), MAX_ENTRIES);
    }
}
