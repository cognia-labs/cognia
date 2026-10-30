//! Candidate resolution + upstream request plumbing.
//!
//! The renderer's routing engine already ordered each alias's deployments;
//! the gateway's job is the simple part: map the requested model onto that
//! pre-ordered list (or a direct provider/model) and walk it, advancing on
//! transient failures. Strategy scoring stays renderer-side by design.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;

use super::cooldown::{usable_pool, KeyCooldownMap};
use super::snapshot::{
    ProviderSnapshot, RoutingSnapshot, SnapshotEntry, SubscriptionAccountSnapshot,
};

/// One executable route: a provider snapshot (credentials + protocol) and
/// the concrete upstream model id.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub provider: ProviderSnapshot,
    pub model_id: String,
}

impl Candidate {
    pub(crate) fn new(provider: &ProviderSnapshot, model_id: &str) -> Self {
        let mut provider = provider.clone();
        if provider
            .source_provider_id
            .as_deref()
            .unwrap_or(&provider.id)
            == "commandcode"
        {
            // CommandCode exposes Claude only through Anthropic Messages.
            provider.protocol = if model_id.split('/').any(|part| part.starts_with("claude-")) {
                "anthropic"
            } else {
                "openai"
            }
            .into();
        }
        if provider.protocol == "openai" && provider.api_flavor.as_deref() == Some("responses") {
            provider.protocol = "responses".into();
        }
        Self {
            provider,
            model_id: model_id.into(),
        }
    }
}

/// In-memory rotation state for one provider's upstream key pool. Process-local
/// and reset on restart — a fresh cursor after restart is harmless.
#[derive(Default)]
pub struct ProviderKeyRotation {
    /// Round-robin cursor: the pool index handed out by the next reservation.
    next_index: usize,
    /// Per-key cumulative successful-use counts (drives `least-used` + the
    /// per-account usage surface).
    use_counts: HashMap<String, u64>,
    /// Attempt reservations, advanced while holding the map lock so concurrent
    /// least-used requests cannot all observe the same unused credential.
    reservation_counts: HashMap<String, u64>,
    /// Ordered usable-pool identity. Cursor changes never carry across a pool
    /// replacement, preventing removed credentials from influencing selection.
    pool_fingerprint: String,
    subscription_reservations: HashMap<String, u64>,
    subscription_affinity: HashMap<String, (String, i64)>,
}

/// Rotation cursors keyed by provider id. Lives on `GatewayState`, shared with
/// the running server so the same cursor advances across requests.
pub type KeyRotationMap = Mutex<HashMap<String, ProviderKeyRotation>>;

/// An opaque account/transport identity. Legacy API-key leases keep their old identity.
pub fn candidate_credential_identity(candidate: &Candidate) -> String {
    let Some(account) = candidate
        .provider
        .selected_subscription_account_id
        .as_deref()
    else {
        return crate::credentials::lease_identity_of(
            candidate.provider.api_key.as_deref().unwrap_or(""),
        );
    };
    let transport = candidate.provider.transport.as_ref();
    crate::credentials::lease_identity_of(
        &serde_json::json!({
            "account":account,"key":candidate.provider.api_key,"base":candidate.provider.base_url,
            "protocol":candidate.provider.protocol,"flavor":candidate.provider.api_flavor,
            "auth":transport.map(|value|(&value.auth_scheme,&value.auth_header_name)),
            "headers":transport.map(|value|&value.static_headers),
        })
        .to_string(),
    )
}

/// Cooldowns remain owned by the source provider, with isolated account identities.
pub fn candidate_cooldown_key(candidate: &Candidate) -> String {
    if candidate
        .provider
        .selected_subscription_account_id
        .is_some()
    {
        candidate_credential_identity(candidate)
    } else {
        candidate.provider.api_key.clone().unwrap_or_default()
    }
}

pub fn subscription_account_candidate(
    provider: &ProviderSnapshot,
    account: &SubscriptionAccountSnapshot,
    model: &str,
) -> Candidate {
    let mut provider = provider.clone();
    provider.api_key = Some(account.api_key.clone());
    provider.base_url = account.base_url.clone();
    if let Some(protocol) = &account.protocol {
        provider.protocol = protocol.clone();
    }
    if let Some(flavor) = &account.api_flavor {
        provider.api_flavor = Some(flavor.clone());
    }
    if let Some(transport) = &account.transport {
        provider.transport = Some(transport.clone());
    }
    provider.api_keys.clear();
    provider.rotation_enabled = false;
    provider.subscription_pool = None;
    provider.selected_subscription_account_id = Some(account.account_id.clone());
    Candidate::new(&provider, model)
}

fn expand_subscription_pool(
    candidate: Candidate,
    rotation: &KeyRotationMap,
    cooldown: &KeyCooldownMap,
    now_ms: i64,
    affinity_scope: Option<&str>,
) -> Vec<Candidate> {
    let pool = candidate
        .provider
        .subscription_pool
        .as_ref()
        .expect("caller checked subscription pool");
    let mut eligible = Vec::new();
    for account in &pool.accounts {
        if candidate
            .provider
            .selected_subscription_account_id
            .as_ref()
            .is_some_and(|selected| selected != &account.account_id)
            || account.expires_at_ms.is_some_and(|expiry| expiry <= now_ms)
        {
            continue;
        }
        let fresh = account.quota_observed_at_ms.is_some_and(|observed| {
            observed <= now_ms && now_ms - observed <= i64::from(pool.quota_freshness_ms)
        });
        let windows: Vec<_> = account
            .windows
            .iter()
            .filter(|window| {
                fresh
                    && (window.model_ids.is_empty()
                        || window.model_ids.contains(&candidate.model_id))
                    && window.reset_at_ms.is_none_or(|reset| reset > now_ms)
            })
            .collect();
        if windows.iter().any(|window| window.used_pct >= 100.0) {
            continue;
        }
        let selected =
            subscription_account_candidate(&candidate.provider, account, &candidate.model_id);
        let identity = candidate_credential_identity(&selected);
        if cooldown
            .lock()
            .get(&(candidate.provider.id.clone(), identity.clone()))
            .is_some_and(|entry| entry.permanent || entry.until_ms > now_ms)
        {
            continue;
        }
        let deadline = windows
            .iter()
            .filter_map(|window| window.reset_at_ms)
            .min()
            .unwrap_or(i64::MAX);
        let utilization = windows
            .iter()
            .map(|window| window.used_pct)
            .reduce(f64::max);
        eligible.push((
            selected,
            identity,
            deadline,
            utilization,
            account.last_used_at_ms,
            account.expires_at_ms,
        ));
    }
    let rotation_key = format!(
        "{}|{}",
        candidate.provider.id,
        candidate
            .provider
            .deployment_id
            .as_deref()
            .unwrap_or(&candidate.provider.id)
    );
    let mut rotations = rotation.lock();
    let state = rotations.entry(rotation_key).or_default();
    state
        .subscription_reservations
        .retain(|identity, _| eligible.iter().any(|account| &account.1 == identity));
    state.subscription_affinity.retain(|_, (identity, until)| {
        *until > now_ms && eligible.iter().any(|account| &account.1 == identity)
    });
    let affinity = affinity_scope
        .and_then(|scope| state.subscription_affinity.get(scope))
        .map(|(identity, _)| identity.clone());
    eligible.sort_by(|left, right| {
        let left_pinned = affinity
            .as_ref()
            .is_some_and(|identity| identity == &left.1);
        let right_pinned = affinity
            .as_ref()
            .is_some_and(|identity| identity == &right.1);
        right_pinned
            .cmp(&left_pinned)
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.3.is_none().cmp(&right.3.is_none()))
            .then_with(|| match (left.3, right.3) {
                (Some(left), Some(right)) => left.total_cmp(&right),
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| {
                state
                    .subscription_reservations
                    .get(&left.1)
                    .copied()
                    .unwrap_or(0)
                    .cmp(
                        &state
                            .subscription_reservations
                            .get(&right.1)
                            .copied()
                            .unwrap_or(0),
                    )
            })
            .then_with(|| left.4.cmp(&right.4))
            .then_with(|| {
                left.0
                    .provider
                    .selected_subscription_account_id
                    .cmp(&right.0.provider.selected_subscription_account_id)
            })
    });
    if let Some(first) = eligible.first() {
        *state
            .subscription_reservations
            .entry(first.1.clone())
            .or_default() += 1;
        if let Some(scope) = affinity_scope {
            if state.subscription_affinity.len() >= 1024 {
                state.subscription_affinity.clear();
            }
            let until = now_ms
                .saturating_add(300_000)
                .min(first.2)
                .min(first.5.unwrap_or(i64::MAX));
            state
                .subscription_affinity
                .insert(scope.to_string(), (first.1.clone(), until));
        }
    }
    eligible.into_iter().map(|account| account.0).collect()
}

/// Pick the pool index the walk should START at, given the strategy. For
/// round-robin this advances (and persists) the per-provider cursor; random
/// picks a fresh start; least-used picks the account with the fewest recorded
/// successes.
fn rotation_start(
    strategy: &str,
    pool: &[String],
    raw_pool_fingerprint: &str,
    st: &mut ProviderKeyRotation,
) -> usize {
    let pool_fingerprint = raw_pool_fingerprint.to_string();
    if st.pool_fingerprint != pool_fingerprint {
        st.pool_fingerprint = pool_fingerprint;
        st.next_index = 0;
        st.use_counts.retain(|key, _| pool.contains(key));
        st.reservation_counts.retain(|key, _| pool.contains(key));
    }
    match strategy {
        "random" => rand::random_range(0..pool.len()),
        "least-used" => {
            let mut best = 0usize;
            let mut best_count = u64::MAX;
            for (i, key) in pool.iter().enumerate() {
                // A reserved-and-successful attempt appears in both maps but
                // is one use, not two. `max` also lets in-flight reservations
                // influence selection before their outcome is known.
                let count = st
                    .use_counts
                    .get(key)
                    .copied()
                    .unwrap_or(0)
                    .max(st.reservation_counts.get(key).copied().unwrap_or(0));
                if count < best_count {
                    best_count = count;
                    best = i;
                }
            }
            *st.reservation_counts.entry(pool[best].clone()).or_insert(0) += 1;
            best
        }
        // round-robin (default): hand out the next slot and remember it.
        _ => {
            let selected = st.next_index % pool.len();
            st.next_index = (selected + 1) % pool.len();
            selected
        }
    }
}

/// Expand each candidate whose provider carries a rotation-enabled key pool
/// into one candidate per pooled key, ordered by the provider's rotation
/// strategy. The existing failover walk then tries each account in turn, so a
/// rate-limited / erroring key (any status in `retry_status_codes`, which
/// includes 429 + 5xx) rolls over to the next account of the SAME provider
/// before moving on. Candidates without a usable pool pass through unchanged
/// (single `api_key` — the app's single-key send path).
///
/// Keys the upstream just parked (429/529 cooldown) or that are permanently
/// disabled (401 / quota exhausted — W1.1 + W3.1) are skipped via
/// [`usable_pool`], so the walk stops re-selecting a key the upstream is
/// refusing. A fully-cooling pool keeps its earliest-recovering key instead of
/// collapsing to zero candidates.
pub fn expand_key_pools(
    candidates: Vec<Candidate>,
    rotation: &KeyRotationMap,
    cooldown: &KeyCooldownMap,
    now_ms: i64,
) -> Vec<Candidate> {
    expand_key_pools_with_affinity(candidates, rotation, cooldown, now_ms, None)
}

pub fn expand_key_pools_with_affinity(
    candidates: Vec<Candidate>,
    rotation: &KeyRotationMap,
    cooldown: &KeyCooldownMap,
    now_ms: i64,
    affinity_scope: Option<&str>,
) -> Vec<Candidate> {
    let mut out = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if candidate.provider.subscription_pool.is_some() {
            out.extend(expand_subscription_pool(
                candidate,
                rotation,
                cooldown,
                now_ms,
                affinity_scope,
            ));
            continue;
        }
        let raw_pool: Vec<String> = if candidate.provider.rotation_enabled {
            let mut seen = std::collections::HashSet::new();
            candidate
                .provider
                .api_keys
                .iter()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty() && seen.insert(k.clone()))
                .collect()
        } else {
            Vec::new()
        };
        if raw_pool.is_empty() {
            // No rotation pool — keep the provider's single `api_key` (the
            // single-key send path has no alternative account to fail over to).
            out.push(candidate);
            continue;
        }
        let pool = usable_pool(cooldown, &candidate.provider.id, &raw_pool, now_ms);
        if pool.is_empty() {
            // Every pooled key is permanently disabled → no usable candidate.
            continue;
        }
        let start = if pool.len() >= 2 {
            let strategy = candidate
                .provider
                .rotation_strategy
                .as_deref()
                .unwrap_or("round-robin");
            let mut guard = rotation.lock();
            let rotation_key = format!(
                "{}|{}",
                candidate.provider.id,
                candidate
                    .provider
                    .deployment_id
                    .as_deref()
                    .unwrap_or(&candidate.provider.id)
            );
            let st = guard.entry(rotation_key).or_default();
            rotation_start(strategy, &pool, &raw_pool.join("\u{1f}"), st)
        } else {
            0
        };
        for offset in 0..pool.len() {
            let key = pool[(start + offset) % pool.len()].clone();
            let mut provider = candidate.provider.clone();
            provider.api_key = Some(key);
            out.push(Candidate {
                provider,
                model_id: candidate.model_id.clone(),
            });
        }
    }
    out
}

/// Record a successful upstream call against a pooled key so `least-used`
/// rotation and the per-account usage surface reflect real traffic. A no-op
/// for keyless providers.
pub fn record_key_success(rotation: &KeyRotationMap, candidate: &Candidate) {
    let provider_id = &candidate.provider.id;
    let api_key = candidate.provider.api_key.as_deref();
    let Some(key) = api_key else { return };
    let key = if candidate
        .provider
        .selected_subscription_account_id
        .is_some()
    {
        candidate_credential_identity(candidate)
    } else {
        key.to_string()
    };
    let mut guard = rotation.lock();
    let rotation_key = format!(
        "{}|{}",
        provider_id,
        candidate
            .provider
            .deployment_id
            .as_deref()
            .unwrap_or(provider_id)
    );
    let st = guard.entry(rotation_key).or_default();
    *st.use_counts.entry(key).or_insert(0) += 1;
}

/// Protocols the gateway can execute today.
pub fn is_executable_protocol(protocol: &str) -> bool {
    matches!(
        protocol,
        "openai" | "anthropic" | "responses" | "google" | "gemini"
    )
}

/// A provider the gateway can actually dial: an executable protocol AND a
/// base URL. `upstream_url` with an empty base yields a bare path
/// (`/chat/completions`), so such a provider is never a usable candidate.
/// Snapshot validation no longer rejects unavailable aliases (availability is
/// a request-time concern), so every candidate/listing path applies this
/// predicate instead of trusting the snapshot to have filtered it.
pub fn is_executable_provider(provider: &ProviderSnapshot) -> bool {
    is_executable_protocol(&provider.protocol) && !provider.base_url.trim().is_empty()
}

/// Resolve the inbound `model` field into an ordered candidate list:
///   1. an alias from the snapshot → its pre-ordered entries,
///   2. `provider:model` literal,
///   3. a model id owned by exactly one enabled provider.
///
/// Disabled providers, non-executable protocols and providers without a base
/// URL are skipped.
pub fn resolve_candidates(snapshot: &RoutingSnapshot, model: &str) -> Vec<Candidate> {
    let mut out = Vec::new();

    if let Some(alias) = snapshot.find_alias(model) {
        for entry in &alias.entries {
            if let Some(provider) = snapshot.provider(&entry.provider_id) {
                if is_executable_provider(provider) {
                    out.push(Candidate::new(provider, &entry.model_id));
                }
            }
        }
        return out;
    }

    if let Some((provider_id, model_id)) = model.split_once(':') {
        if let Some(provider) = snapshot.provider(provider_id) {
            if is_executable_provider(provider) && !model_id.is_empty() {
                out.push(Candidate::new(provider, model_id));
                return out;
            }
        }
    }

    for provider in &snapshot.providers {
        if provider.enabled
            && is_executable_provider(provider)
            && provider.models.iter().any(|m| m == model)
        {
            out.push(Candidate::new(provider, model));
        }
    }
    out
}

/// Map an explicit, pre-ordered entry list (from the renderer's live routing
/// decision) onto executable candidates, resolving each against the
/// snapshot's providers. Disabled providers / non-executable protocols /
/// providers without a base URL are skipped, preserving order.
pub fn candidates_from_entries(
    snapshot: &RoutingSnapshot,
    entries: &[SnapshotEntry],
) -> Vec<Candidate> {
    let mut out = Vec::new();
    for entry in entries {
        if let Some(provider) = snapshot.provider(&entry.provider_id) {
            if is_executable_provider(provider) {
                out.push(Candidate::new(provider, &entry.model_id));
            }
        }
    }
    out
}

/// Upstream endpoint for a protocol. Base URLs follow the catalog
/// convention of INCLUDING `/v1` (e.g. `https://api.openai.com/v1`,
/// `https://api.anthropic.com/v1`).
pub fn upstream_url(protocol: &str, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match protocol {
        "anthropic" => format!("{base}/messages"),
        "responses" => format!("{base}/responses"),
        _ => format!("{base}/chat/completions"),
    }
}

/// Gemini names its model and operation in the URL, not in the request body.
/// Appending one escaped path segment prevents a model selector from changing
/// the configured upstream host, query or versioned base path.
pub fn upstream_url_for(protocol: &str, base_url: &str, model: &str, stream: bool) -> String {
    if !matches!(protocol, "google" | "gemini") {
        return upstream_url(protocol, base_url);
    }
    let operation = if stream {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    let model = model.strip_prefix("models/").unwrap_or(model);
    let Ok(mut url) = reqwest::Url::parse(base_url) else {
        return String::new();
    };
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty();
        segments.push("models");
        segments.push(&format!("{model}:{operation}"));
    } else {
        return String::new();
    }
    if stream {
        url.query_pairs_mut().append_pair("alt", "sse");
    }
    url.into()
}

/// Upstream embeddings endpoint. OpenAI-compatible only (the catalog base URL
/// already includes `/v1`, matching [`upstream_url`]); Anthropic exposes no
/// embeddings endpoint in this protocol.
pub fn embeddings_url(base_url: &str) -> String {
    format!("{}/embeddings", base_url.trim_end_matches('/'))
}

/// Upstream Anthropic token-count endpoint. Sibling of [`upstream_url`]'s
/// `/messages` leg: the catalog base URL already carries `/v1`.
pub fn count_tokens_url(base_url: &str) -> String {
    format!("{}/messages/count_tokens", base_url.trim_end_matches('/'))
}

/// Auth + protocol headers for an upstream request. Never logged.
pub fn upstream_headers(protocol: &str, api_key: Option<&str>) -> Vec<(&'static str, String)> {
    let mut headers = vec![("content-type", "application/json".to_string())];
    match protocol {
        "google" | "gemini" => {
            if let Some(key) = api_key {
                headers.push(("x-goog-api-key", key.to_string()));
            }
        }
        "anthropic" => {
            if let Some(key) = api_key {
                headers.push(("x-api-key", key.to_string()));
            }
            headers.push(("anthropic-version", "2023-06-01".to_string()));
        }
        _ => {
            if let Some(key) = api_key {
                headers.push(("authorization", format!("Bearer {key}")));
            }
        }
    }
    headers
}

/// Transport-profile-driven upstream headers (ADR-0090 Phase 2). Supersedes
/// [`upstream_headers`] for providers that carry a `TransportSnapshot`:
/// - auth scheme comes from the transport (x-api-key / bearer / custom name,
///   the custom name defense-in-depth re-checked against the header policy);
/// - policy-clean static headers are stamped;
/// - `anthropic-version` is defaulted ONLY when the client did not send one
///   (`inbound_version`), fixing the R2 override-the-client bug;
/// - never logged.
pub fn upstream_headers_for(
    protocol: &str,
    transport: Option<&crate::snapshot::TransportSnapshot>,
    api_key: Option<&str>,
    inbound_version: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> =
        vec![("content-type".into(), "application/json".into())];

    let scheme = transport
        .map(|t| t.auth_scheme.as_str())
        .unwrap_or(match protocol {
            "anthropic" => "x-api-key",
            "google" | "gemini" => "google-api-key",
            _ => "bearer",
        });
    if let Some(key) = api_key {
        match scheme {
            "google-api-key" => headers.push(("x-goog-api-key".into(), key.to_string())),
            "x-api-key" => headers.push(("x-api-key".into(), key.to_string())),
            "custom-header" => {
                let name = transport
                    .and_then(|t| t.auth_header_name.as_deref())
                    .unwrap_or("x-api-key");
                let verdict = crate::header_policy::check_header(
                    name,
                    Some(key),
                    crate::header_policy::HeaderContext::Static,
                );
                let acceptable = verdict.allowed
                    || verdict.reason == crate::header_policy::HeaderPolicyReason::AuthHeader;
                if acceptable {
                    headers.push((name.to_ascii_lowercase(), key.to_string()));
                } else {
                    // Fail safe: an invalid custom name falls back to the
                    // protocol default rather than dropping auth entirely.
                    headers.push(("x-api-key".into(), key.to_string()));
                }
            }
            _ => headers.push(("authorization".into(), format!("Bearer {key}"))),
        }
    }

    if protocol == "anthropic" {
        headers.push((
            "anthropic-version".into(),
            inbound_version.unwrap_or("2023-06-01").to_string(),
        ));
    }

    if let Some(transport) = transport {
        for (name, value) in &transport.static_headers {
            let verdict = crate::header_policy::check_header(
                name,
                Some(value),
                crate::header_policy::HeaderContext::Static,
            );
            if verdict.allowed && !name.eq_ignore_ascii_case("anthropic-version") {
                headers.push((name.to_ascii_lowercase(), value.clone()));
            }
        }
    }

    headers
}

/// Multiple explicitly authorized deployments keep independent sticky leases.
/// Legacy tickets retain the original session scope.
pub fn ticket_lease_scope(
    ticket: &crate::route_ticket::RouteTicket,
    deployment_id: &str,
) -> String {
    if ticket.selector_deployments.is_empty() {
        ticket.session_id.clone()
    } else {
        serde_json::to_string(&(ticket.session_id.as_str(), deployment_id))
            .expect("strings serialize")
    }
}


/// Ticket-scoped candidate expansion (ADR-0090 Phase 2, R4). The base
/// candidates are the ticket's FROZEN, ordered walk; affinity narrows or
/// reorders it:
/// - `per-request`: today's rotation across the whole walk;
/// - `session-sticky`: the leased deployment only (first candidate
///   establishes the lease when none exists) — no alternate accounts, ever;
/// - `sticky-with-failover`: the leased deployment first, remaining
///   candidates appended as the pre-first-byte failover chain.
pub fn expand_for_ticket(
    base: Vec<Candidate>,
    affinity: crate::route_ticket::TicketAffinity,
    leases: &crate::lease::CredentialLeaseMap,
    session_id: &str,
    rotation: &KeyRotationMap,
    cooldown: &crate::cooldown::KeyCooldownMap,
    now_ms: i64,
) -> Vec<Candidate> {
    use crate::route_ticket::TicketAffinity;

    let expanded = expand_key_pools(base, rotation, cooldown, now_ms);
    if expanded.is_empty() {
        return expanded;
    }

    let deployment_of = |c: &Candidate| -> String {
        c.provider
            .deployment_id
            .clone()
            .unwrap_or_else(|| c.provider.id.clone())
    };
    let identity_of = |c: &Candidate| -> String { candidate_credential_identity(c) };

    match affinity {
        TicketAffinity::PerRequest => expanded,
        TicketAffinity::SessionSticky => {
            let first = &expanded[0];
            let lease = leases.claim(
                session_id,
                &deployment_of(first),
                &identity_of(first),
                now_ms,
            );
            // A strict session claims before dispatch. Concurrent initial
            // requests observe the same identity; a parked/removed credential
            // fails closed rather than switching accounts.
            expanded
                .into_iter()
                .filter(|candidate| {
                    deployment_of(candidate) == lease.deployment_id
                        && identity_of(candidate) == lease.credential_identity
                })
                .collect()
        }
        TicketAffinity::StickyWithFailover => {
            if let Some(lease) = leases.get(session_id) {
                let (mut leased, rest): (Vec<Candidate>, Vec<Candidate>) =
                    expanded.into_iter().partition(|c| {
                        deployment_of(c) == lease.deployment_id
                            && identity_of(c) == lease.credential_identity
                    });
                leased.extend(rest);
                leased
            } else {
                expanded
            }
        }
    }
}

/// Incremental SSE de-framer: feed raw bytes, get back complete `data:`
/// payloads. `event:` lines are dropped — every payload the gateway cares
/// about carries a `type` discriminator in the JSON itself.
#[derive(Default)]
pub struct SseDeframer {
    buf: Vec<u8>,
}

impl SseDeframer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut consumed = 0;
        while let Some(relative) = self.buf[consumed..].iter().position(|byte| *byte == b'\n') {
            let newline = consumed + relative;
            let mut line = &self.buf[consumed..newline];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if let Some(data) = Self::data_payload(line, false) {
                out.push(data);
            }
            consumed = newline + 1;
        }
        if consumed > 0 {
            let remaining = self.buf.len() - consumed;
            self.buf.copy_within(consumed.., 0);
            self.buf.truncate(remaining);
        }
        out
    }

    pub fn finish(&mut self) -> Option<String> {
        let data = Self::data_payload(&self.buf, true);
        self.buf.clear();
        data
    }

    fn data_payload(line: &[u8], trim_line: bool) -> Option<String> {
        let line = String::from_utf8_lossy(line);
        let line = if trim_line {
            line.trim()
        } else {
            line.as_ref()
        };
        line.strip_prefix("data:")
            .map(|data| data.trim().to_string())
    }
}

/// Replace the model field on a passthrough body (alias → concrete model)
/// without touching anything else.
pub fn rewrite_model(body: &Value, model_id: &str) -> Value {
    let mut out = body.clone();
    out["model"] = Value::String(model_id.to_string());
    out
}

/// Strip client-supplied request fields that must not be forwarded upstream
/// (W3.2): billing / privacy / behaviour toggles like `service_tier`, `store`,
/// `safety_identifier`, `stream_options.include_obfuscation`. Applies to BOTH
/// the passthrough body and the translated body (passthrough bypasses
/// `translate/`, so stripping must live at the send boundary, not in the
/// translator). A field re-permitted for this provider via an
/// `"providerId:field"` entry in `allow` is left intact. Each `field` is a
/// dotted path; a nested leaf is removed without disturbing its siblings.
pub fn strip_request_fields(
    body: &mut Value,
    provider_id: &str,
    fields: &[String],
    allow: &[String],
) {
    for field in fields {
        let field = field.trim();
        if field.is_empty() {
            continue;
        }
        // Never turn a client's explicit no-retention request into the
        // Responses API's default store=true by stripping the false value.
        if field == "store" && body["store"] == false {
            continue;
        }
        let permitted = {
            let scoped = format!("{provider_id}:{field}");
            allow.iter().any(|a| a.trim() == scoped)
        };
        if permitted {
            continue;
        }
        remove_path(body, field);
    }
}

/// Remove a dotted-path leaf from a JSON object, leaving siblings intact.
fn remove_path(value: &mut Value, path: &str) {
    match path.split_once('.') {
        None => {
            if let Some(obj) = value.as_object_mut() {
                obj.remove(path);
            }
        }
        Some((head, rest)) => {
            if let Some(child) = value.as_object_mut().and_then(|o| o.get_mut(head)) {
                remove_path(child, rest);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscription_account(id: &str, used: Option<f64>, reset: Option<i64>) -> Value {
        serde_json::json!({"accountId":id,"apiKey":"same-token","baseUrl":format!("https://{id}.invalid/v1"),"lastUsedAtMs":0,"quotaObservedAtMs":1000,"transport":{"authScheme":"bearer","staticHeaders":[["chatgpt-account-id",id]]},"windows":used.map(|used|vec![serde_json::json!({"id":"session","usedPct":used,"resetAtMs":reset})]).unwrap_or_default()})
    }

    fn subscription_candidate(accounts: Vec<Value>) -> Candidate {
        let provider: ProviderSnapshot = serde_json::from_value(serde_json::json!({"id":"subscription","protocol":"openai","baseUrl":"https://default.invalid/v1","enabled":true,"models":["model"],"subscriptionPool":{"strategy":"allowance-reset","quotaFreshnessMs":300000,"accounts":accounts}})).unwrap();
        Candidate::new(&provider, "model")
    }

    fn subscription_ids(candidates: &[Candidate]) -> Vec<&str> {
        candidates
            .iter()
            .map(|candidate| {
                candidate
                    .provider
                    .selected_subscription_account_id
                    .as_deref()
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn subscription_allowance_orders_reset_deadlines_and_excludes_known_exhaustion() {
        let candidate = subscription_candidate(vec![
            subscription_account("spent", Some(100.0), Some(9000)),
            subscription_account("later", Some(10.0), Some(8000)),
            subscription_account("soon", Some(80.0), Some(4000)),
            subscription_account("unknown", None, None),
        ]);
        let result = expand_key_pools(
            vec![candidate],
            &KeyRotationMap::default(),
            &KeyCooldownMap::default(),
            2000,
        );
        assert_eq!(subscription_ids(&result), vec!["soon", "later", "unknown"]);
        assert_eq!(result[0].provider.id, "subscription");
        assert_eq!(result[0].provider.base_url, "https://soon.invalid/v1");
        assert!(result[0].provider.subscription_pool.is_none());
    }

    #[test]
    fn subscription_stale_reset_and_unrelated_model_windows_become_unknown_not_free_or_spent() {
        let mut stale = subscription_account("stale", Some(100.0), Some(900000));
        stale["quotaObservedAtMs"] = serde_json::json!(0);
        let reset = subscription_account("reset", Some(100.0), Some(2000));
        let mut scoped = subscription_account("scoped", Some(100.0), Some(900000));
        scoped["windows"][0]["modelIds"] = serde_json::json!(["other-model"]);
        let mut expired = subscription_account("expired", None, None);
        expired["expiresAtMs"] = serde_json::json!(300001);
        let result = expand_key_pools(
            vec![subscription_candidate(vec![stale, reset, scoped, expired])],
            &KeyRotationMap::default(),
            &KeyCooldownMap::default(),
            300002,
        );
        let ids = subscription_ids(&result);
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"stale") && ids.contains(&"reset") && ids.contains(&"scoped"));
    }

    #[test]
    fn subscription_reservations_spread_initial_requests_and_affinity_stays_per_session() {
        let candidate = subscription_candidate(vec![
            subscription_account("one", None, None),
            subscription_account("two", None, None),
        ]);
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let first = expand_key_pools_with_affinity(
            vec![candidate.clone()],
            &rotation,
            &cooldown,
            2000,
            Some("session-one"),
        );
        let same = expand_key_pools_with_affinity(
            vec![candidate.clone()],
            &rotation,
            &cooldown,
            2001,
            Some("session-one"),
        );
        let other = expand_key_pools_with_affinity(
            vec![candidate],
            &rotation,
            &cooldown,
            2002,
            Some("session-two"),
        );
        assert_eq!(subscription_ids(&first)[0], "one");
        assert_eq!(subscription_ids(&same)[0], "one");
        assert_eq!(subscription_ids(&other)[0], "two");
    }

    #[test]
    fn subscription_identity_cooldown_and_explicit_selection_are_account_scoped() {
        let candidate = subscription_candidate(vec![
            subscription_account("one", None, None),
            subscription_account("two", None, None),
        ]);
        let cooldown = KeyCooldownMap::default();
        let expanded = expand_key_pools(
            vec![candidate.clone()],
            &KeyRotationMap::default(),
            &cooldown,
            2000,
        );
        assert_ne!(
            candidate_credential_identity(&expanded[0]),
            candidate_credential_identity(&expanded[1])
        );
        crate::cooldown::record_permanent(
            &cooldown,
            "subscription",
            &candidate_cooldown_key(&expanded[0]),
            "unauthorized",
        );
        let result = expand_key_pools(
            vec![candidate.clone()],
            &KeyRotationMap::default(),
            &cooldown,
            2001,
        );
        assert_eq!(subscription_ids(&result), vec!["two"]);
        let mut selected = candidate;
        selected.provider.selected_subscription_account_id = Some("one".into());
        assert!(
            expand_key_pools(vec![selected], &KeyRotationMap::default(), &cooldown, 2001)
                .is_empty()
        );
    }

    #[test]
    fn commandcode_routes_each_model_family_across_all_candidate_sources() {
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "providers": [{
                "id": "commandcode", "protocol": "openai", "enabled": true,
                "baseUrl": "https://api.commandcode.ai/provider/v1", "apiKey": "test-key",
                "models": ["claude-sonnet-5", "deepseek/deepseek-v4-flash"]
            }],
            "aliases": [{ "alias": "smart", "entries": [
                { "providerId": "commandcode", "modelId": "claude-sonnet-5" }
            ]}],
            "generatedAtMs": 1
        }))
        .unwrap();
        for model in [
            "smart",
            "claude-sonnet-5",
            "commandcode:anthropic/claude-sonnet-5",
        ] {
            let candidates = resolve_candidates(&snapshot, model);
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].provider.protocol, "anthropic");
            assert_eq!(
                upstream_url(
                    &candidates[0].provider.protocol,
                    &candidates[0].provider.base_url
                ),
                "https://api.commandcode.ai/provider/v1/messages"
            );
        }
        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "commandcode", "modelId": "claude-sonnet-5" },
            { "providerId": "commandcode", "modelId": "deepseek/deepseek-v4-flash" }
        ]))
        .unwrap();
        let candidates = candidates_from_entries(&snapshot, &entries);
        assert_eq!(candidates[0].provider.protocol, "anthropic");
        assert_eq!(candidates[1].provider.protocol, "openai");
        assert_eq!(
            resolve_candidates(&snapshot, "deepseek/deepseek-v4-flash")[0]
                .provider
                .protocol,
            "openai"
        );
        assert_eq!(snapshot.providers[0].protocol, "openai");
    }

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [
                { "providerId": "groq", "modelId": "llama-3.3-70b" },
                { "providerId": "disabled-one", "modelId": "x" },
                { "providerId": "anthropic", "modelId": "claude-haiku" },
                { "providerId": "weird", "modelId": "y" }
            ]}],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "anthropic", "protocol": "anthropic", "baseUrl": "https://api.anthropic.com/v1",
                  "apiKey": "sk-a", "enabled": true, "models": ["claude-haiku"] },
                { "id": "disabled-one", "protocol": "openai", "baseUrl": "https://x", "enabled": false },
                { "id": "weird", "protocol": "cohere", "baseUrl": "https://g", "enabled": true }
            ],
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    #[test]
    fn providers_without_a_base_url_are_never_candidates() {
        // Snapshot validation no longer rejects an alias whose only providers
        // are unusable, so every resolution path must skip a blank base URL
        // itself instead of dialing a bare `/chat/completions` path.
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [
                { "providerId": "blank", "modelId": "m1" },
                { "providerId": "groq", "modelId": "llama-3.3-70b" }
            ]}, { "alias": "only-blank", "entries": [
                { "providerId": "blank", "modelId": "m1" }
            ]}],
            "providers": [
                { "id": "blank", "protocol": "openai", "baseUrl": "   ",
                  "apiKey": "sk-b", "enabled": true, "models": ["m1"] },
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] }
            ],
            "generatedAtMs": 1
        }))
        .unwrap();
        assert!(snapshot.validate().is_ok());

        let alias = resolve_candidates(&snapshot, "fast");
        assert_eq!(alias.len(), 1);
        assert_eq!(alias[0].provider.id, "groq");
        assert!(resolve_candidates(&snapshot, "only-blank").is_empty());
        assert!(resolve_candidates(&snapshot, "blank:m1").is_empty());
        assert!(resolve_candidates(&snapshot, "m1").is_empty());

        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "blank", "modelId": "m1" },
            { "providerId": "groq", "modelId": "llama-3.3-70b" }
        ]))
        .unwrap();
        let from_entries = candidates_from_entries(&snapshot, &entries);
        assert_eq!(from_entries.len(), 1);
        assert_eq!(from_entries[0].provider.id, "groq");

        assert!(!is_executable_provider(&snapshot.providers[0]));
        assert!(is_executable_provider(&snapshot.providers[1]));
    }

    #[test]
    fn alias_resolves_to_ordered_executable_candidates() {
        let candidates = resolve_candidates(&snapshot(), "fast");
        // disabled + non-executable protocols skipped, order preserved.
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider.id, "groq");
        assert_eq!(candidates[1].provider.id, "anthropic");
        assert_eq!(candidates[1].model_id, "claude-haiku");
    }

    #[test]
    fn provider_colon_model_literal_resolves() {
        let candidates = resolve_candidates(&snapshot(), "groq:whatever-model");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].model_id, "whatever-model");
        assert!(resolve_candidates(&snapshot(), "ghost:m").is_empty());
        assert!(resolve_candidates(&snapshot(), "groq:").is_empty());
    }

    #[test]
    fn bare_model_id_finds_its_owner() {
        let candidates = resolve_candidates(&snapshot(), "claude-haiku");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].provider.id, "anthropic");
        assert!(resolve_candidates(&snapshot(), "unknown-model").is_empty());
    }

    #[test]
    fn candidates_from_explicit_entries_resolve_and_skip() {
        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "anthropic", "modelId": "claude-haiku" },
            { "providerId": "disabled-one", "modelId": "x" },
            { "providerId": "weird", "modelId": "y" },
            { "providerId": "groq", "modelId": "llama-3.3-70b" }
        ]))
        .unwrap();
        let candidates = candidates_from_entries(&snapshot(), &entries);
        // Disabled and unsupported protocols are skipped; order preserved.
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["anthropic", "groq"]
        );
        assert_eq!(candidates[0].model_id, "claude-haiku");
    }

    #[test]
    fn urls_and_headers_per_protocol() {
        assert_eq!(
            upstream_url("openai", "https://api.groq.com/openai/v1/"),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        assert_eq!(
            upstream_url("anthropic", "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        let oa = upstream_headers("openai", Some("k"));
        assert!(oa
            .iter()
            .any(|(n, v)| *n == "authorization" && v == "Bearer k"));
        let an = upstream_headers("anthropic", Some("k"));
        assert!(an.iter().any(|(n, v)| *n == "x-api-key" && v == "k"));
        assert!(an.iter().any(|(n, _)| *n == "anthropic-version"));
        // Keyless local providers get no auth header but keep content-type.
        assert_eq!(upstream_headers("openai", None).len(), 1);
    }

    #[test]
    fn gemini_urls_keep_the_configured_base_and_escape_model_selectors() {
        assert_eq!(
            upstream_url_for(
                "google",
                "https://generativelanguage.googleapis.com/v1beta/",
                "models/gemini-test",
                false
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
        );
        let url = reqwest::Url::parse(&upstream_url_for(
            "gemini",
            "https://proxy.test/google/v1beta?tenant=one",
            "gemini/../x?key=other#fragment",
            true,
        ))
        .unwrap();
        assert_eq!(url.host_str(), Some("proxy.test"));
        assert_eq!(
            url.path(),
            "/google/v1beta/models/gemini%2F..%2Fx%3Fkey=other%23fragment:streamGenerateContent"
        );
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![
                ("tenant".into(), "one".into()),
                ("alt".into(), "sse".into())
            ]
        );
        assert_eq!(url.fragment(), None);
        assert_eq!(upstream_url_for("google", "not a URL", "m", false), "");
        assert_eq!(
            upstream_url_for("responses", "https://proxy.test/v1", "m", true),
            "https://proxy.test/v1/responses"
        );
    }

    #[test]
    fn gemini_defaults_to_google_api_key_auth() {
        for protocol in ["google", "gemini"] {
            assert_eq!(
                upstream_headers(protocol, None),
                vec![("content-type", "application/json".into())]
            );
            let legacy = upstream_headers(protocol, Some("fixture-key"));
            assert!(legacy
                .iter()
                .any(|(name, value)| *name == "x-goog-api-key" && value == "fixture-key"));
            assert!(!legacy.iter().any(|(name, _)| *name == "authorization"));
            let profile = upstream_headers_for(protocol, None, Some("fixture-key"), None);
            assert!(profile
                .iter()
                .any(|(name, value)| name == "x-goog-api-key" && value == "fixture-key"));
            assert!(!profile.iter().any(|(name, _)| name == "authorization"));
        }
    }

    #[test]
    fn sse_deframer_handles_split_chunks_and_crlf() {
        let mut d = SseDeframer::default();
        let mut out = d.push(b"data: {\"a\":");
        assert!(out.is_empty());
        out.extend(d.push(b"1}\r\nevent: ping\ndata: [DONE]\n"));
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
        assert_eq!(d.finish(), None);

        let mut d2 = SseDeframer::default();
        d2.push(b"data: tail-no-newline");
        assert_eq!(d2.finish(), Some("tail-no-newline".to_string()));
    }

    #[test]
    fn sse_deframer_preserves_unicode_across_arbitrary_byte_splits() {
        let wire = "data: {\"text\":\"你好🙂\"}\r\ndata: [DONE]\r\n";
        let mut deframer = SseDeframer::default();
        let mut payloads = Vec::new();
        for byte in wire.as_bytes() {
            payloads.extend(deframer.push(std::slice::from_ref(byte)));
        }

        assert_eq!(
            payloads,
            vec!["{\"text\":\"你好🙂\"}".to_string(), "[DONE]".to_string()]
        );
        assert_eq!(deframer.finish(), None);
    }

    #[test]
    fn sse_deframer_handles_multiple_frames_and_malformed_utf8() {
        let mut deframer = SseDeframer::default();
        let payloads = deframer.push(b"event: ping\ndata: one\n\ndata: two\r\ndata: \xff\n");

        assert_eq!(payloads, vec!["one", "two", "�"]);
        assert_eq!(deframer.finish(), None);
    }

    #[test]
    fn embeddings_url_appends_path() {
        assert_eq!(
            embeddings_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/embeddings"
        );
        // Trailing slash trimmed.
        assert_eq!(
            embeddings_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/embeddings"
        );
    }

    #[test]
    fn rewrite_model_only_touches_model() {
        let body = serde_json::json!({ "model": "fast", "messages": [1], "stream": true });
        let out = rewrite_model(&body, "concrete");
        assert_eq!(out["model"], "concrete");
        assert_eq!(out["stream"], true);
    }

    fn pooled_candidate(keys: &[&str], enabled: bool, strategy: Option<&str>) -> Candidate {
        let provider: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "groq", "protocol": "openai", "baseUrl": "u",
            "apiKey": "sk-single", "enabled": true, "models": ["m"],
            "apiKeys": keys, "rotationEnabled": enabled,
            "rotationStrategy": strategy,
        }))
        .unwrap();
        Candidate {
            provider,
            model_id: "m".into(),
        }
    }

    #[test]
    fn expand_passes_through_without_a_pool() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        // rotation disabled → single key preserved, one candidate.
        let out = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b"], false, None)],
            &rotation,
            &cooldown,
            0,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-single"));
    }

    #[test]
    fn expand_produces_one_candidate_per_pooled_key() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let out = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b", "sk-c"],
                true,
                Some("round-robin"),
            )],
            &rotation,
            &cooldown,
            0,
        );
        assert_eq!(out.len(), 3);
        let keys: Vec<&str> = out
            .iter()
            .filter_map(|c| c.provider.api_key.as_deref())
            .collect();
        // Every pool key appears exactly once (the failover fallback chain).
        assert!(keys.contains(&"sk-a") && keys.contains(&"sk-b") && keys.contains(&"sk-c"));
    }

    #[test]
    fn round_robin_advances_the_starting_key_each_call() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let first = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        let second = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        // Consecutive requests start at different pool slots.
        assert_ne!(
            first[0].provider.api_key.as_deref(),
            second[0].provider.api_key.as_deref()
        );
        assert_eq!(first[0].provider.api_key.as_deref(), Some("sk-a"));
    }

    #[test]
    fn pool_changes_reset_round_robin_without_removed_keys() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let _ = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b"], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        let changed = expand_key_pools(
            vec![pooled_candidate(&["sk-x", "sk-y"], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        assert_eq!(changed[0].provider.api_key.as_deref(), Some("sk-x"));
        assert!(changed.iter().all(|candidate| !matches!(
            candidate.provider.api_key.as_deref(),
            Some("sk-a" | "sk-b")
        )));
    }

    #[test]
    fn least_used_reservations_avoid_concurrent_stampedes() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let first = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b"],
                true,
                Some("least-used"),
            )],
            &rotation,
            &cooldown,
            0,
        );
        let second = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b"],
                true,
                Some("least-used"),
            )],
            &rotation,
            &cooldown,
            0,
        );
        assert_ne!(
            first[0].provider.api_key.as_deref(),
            second[0].provider.api_key.as_deref()
        );
    }

    #[test]
    fn least_used_prefers_the_key_with_fewest_successes() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        // sk-a used twice, sk-b once → least-used should start at sk-c (zero).
        for key in ["sk-a", "sk-a", "sk-b"] {
            let mut candidate = pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None);
            candidate.provider.api_key = Some(key.to_string());
            record_key_success(&rotation, &candidate);
        }
        let out = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b", "sk-c"],
                true,
                Some("least-used"),
            )],
            &rotation,
            &cooldown,
            0,
        );
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-c"));
    }

    #[test]
    fn expand_skips_blank_pool_keys() {
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        let out = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "  ", ""], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        // Only the one non-blank key survives.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-a"));
    }

    #[test]
    fn expand_skips_cooling_and_disabled_pool_keys() {
        use super::super::cooldown::{record_cooldown, record_permanent};
        let rotation = KeyRotationMap::default();
        let cooldown = KeyCooldownMap::default();
        // sk-a cooling until 100, sk-b permanently disabled → only sk-c usable.
        record_cooldown(&cooldown, "groq", "sk-a", 100, "HTTP 429");
        record_permanent(&cooldown, "groq", "sk-b", "quota");
        let out = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
            &cooldown,
            0,
        );
        let keys: Vec<&str> = out
            .iter()
            .filter_map(|c| c.provider.api_key.as_deref())
            .collect();
        assert_eq!(keys, vec!["sk-c"]);

        // Once the cooldown expires, sk-a returns but the disabled sk-b stays out.
        let out2 = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
            &cooldown,
            200,
        );
        let keys2: Vec<&str> = out2
            .iter()
            .filter_map(|c| c.provider.api_key.as_deref())
            .collect();
        assert!(keys2.contains(&"sk-a") && keys2.contains(&"sk-c") && !keys2.contains(&"sk-b"));
    }

    #[test]
    fn stripping_retention_toggles_preserves_an_explicit_store_false() {
        let mut body = serde_json::json!({"store":false});
        strip_request_fields(&mut body, "fixture", &["store".into()], &[]);
        assert_eq!(body["store"], false);
    }

    #[test]
    fn strip_request_fields_removes_toggles_and_honours_allowlist() {
        let fields = vec![
            "service_tier".to_string(),
            "store".to_string(),
            "safety_identifier".to_string(),
            "stream_options.include_obfuscation".to_string(),
        ];
        let mut body = serde_json::json!({
            "model": "m",
            "service_tier": "flex",
            "store": true,
            "safety_identifier": "user-123",
            "stream_options": { "include_usage": true, "include_obfuscation": true },
            "messages": [1]
        });
        strip_request_fields(&mut body, "openai", &fields, &[]);
        assert!(body.get("service_tier").is_none());
        assert!(body.get("store").is_none());
        assert!(body.get("safety_identifier").is_none());
        // Nested leaf removed; sibling preserved.
        assert!(body["stream_options"].get("include_obfuscation").is_none());
        assert_eq!(body["stream_options"]["include_usage"], true);
        // Untouched fields survive.
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"], serde_json::json!([1]));

        // Per-provider allowlist re-permits a field for that provider only.
        let mut body2 = serde_json::json!({ "service_tier": "flex" });
        strip_request_fields(
            &mut body2,
            "openai",
            &fields,
            &["openai:service_tier".to_string()],
        );
        assert_eq!(body2["service_tier"], "flex");
        // A different provider is unaffected by that allowlist entry.
        let mut body3 = serde_json::json!({ "service_tier": "flex" });
        strip_request_fields(
            &mut body3,
            "groq",
            &fields,
            &["openai:service_tier".to_string()],
        );
        assert!(body3.get("service_tier").is_none());
    }
}
