//! Routing + credential snapshot pushed by the renderer.
//!
//! The routing ENGINE (alias mappings, strategy scoring, health/circuit
//! telemetry) lives renderer-side; the gateway consumes its OUTPUT: per-alias
//! pre-ordered deployment lists plus the provider credentials needed to
//! execute upstream calls in Rust. Pushed on boot + on settings changes +
//! periodically (`gateway_push_snapshot`), so the gateway keeps serving with
//! the last-known snapshot when the window is closed.
//!
//! API keys live in this struct in memory only — never logged, never
//! persisted, never echoed back to the renderer.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default)]
    pub weight: Option<u32>,
    #[serde(default)]
    pub deployment_id: Option<String>,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub locality: Option<String>,
    #[serde(default)]
    pub capabilities: Option<CandidateCapabilities>,
    #[serde(default)]
    pub pricing_per_1_m: Option<f64>,
    #[serde(default)]
    pub latency_ms: Option<f64>,
    #[serde(default)]
    pub success_rate: Option<f64>,
    #[serde(default)]
    pub conditions: Option<EntryConditions>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCapabilities {
    #[serde(default)]
    pub tools: Option<bool>,
    #[serde(default)]
    pub vision: Option<bool>,
    #[serde(default)]
    pub structured_output: Option<bool>,
    #[serde(default)]
    pub streaming: Option<bool>,
    #[serde(default)]
    pub context_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryConditions {
    #[serde(default)]
    pub max_cost_per_1_m: Option<f64>,
    #[serde(default)]
    pub max_latency_ms: Option<f64>,
}

fn default_distribution() -> String {
    "priority".to_string()
}

/// Wire/auth behavior for a provider entry (ADR-0090 Phase 2). Projected from
/// the Provider Profile Store's TransportProfile; validated at snapshot ingest
/// by the shared header policy. Absent ⇒ the legacy protocol defaults
/// (anthropic → x-api-key + pinned version header, else Bearer).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    /// "x-api-key" | "bearer" | "custom-header".
    pub auth_scheme: String,
    /// Custom auth header name (only for `auth_scheme == "custom-header"`).
    #[serde(default)]
    pub auth_header_name: Option<String>,
    /// Extra static headers, policy-validated at ingest AND at send time.
    #[serde(default)]
    pub static_headers: Vec<(String, String)>,
    /// Additional inbound semantic headers forwarded on same-protocol routes.
    #[serde(default)]
    pub forwarded_semantic_headers: Vec<String>,
}

/// Who produced a snapshot — the CAS authority axis (R3). Same-version pushes
/// from DIFFERENT authorities are rejected; last-writer-wins is forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotAuthority {
    Renderer,
    ProfileStore,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasSnapshot {
    pub alias: String,
    #[serde(default = "default_distribution")]
    pub distribution: String,
    /// Pre-ordered by the renderer's routing engine: primary first, then the
    /// fallback chain. The gateway walks it in order.
    pub entries: Vec<SnapshotEntry>,
    #[serde(default)]
    pub parameter_defaults: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRoutingPolicy {
    pub model_id: String,
    pub strategy: String,
    #[serde(default)]
    pub candidate_aliases: Vec<String>,
    #[serde(default)]
    pub thresholds: Option<AutoRoutingThresholds>,
    #[serde(default)]
    pub strategy_unavailable: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AutoRoutingThresholds {
    pub balanced: f64,
    pub powerful: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingPolicySnapshotV2 {
    pub schema_version: u32,
    pub policy_revision: String,
    pub auto: AutoRoutingPolicy,
    pub max_fallback_attempts: u32,
    #[serde(default)]
    pub tier_aliases: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub provider_constraints: Vec<ProviderConstraintSnapshot>,
    #[serde(default)]
    pub circuit_breaker: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConstraintSnapshot {
    pub provider_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub max_requests_per_minute: Option<u64>,
    #[serde(default)]
    pub max_tokens_per_minute: Option<u64>,
    #[serde(default)]
    pub daily_cost_budget: Option<f64>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub current_requests_per_minute: Option<u64>,
    #[serde(default)]
    pub current_tokens_per_minute: Option<u64>,
    #[serde(default)]
    pub current_daily_cost: Option<f64>,
    #[serde(default)]
    pub circuit_open: bool,
}

/// Optional facts from the selected account's model catalog. Unknown is absent.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadata {
    pub id: String,
    #[serde(flatten)]
    pub fields: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionWindow {
    pub id: String,
    pub used_pct: f64,
    #[serde(default)]
    pub reset_at_ms: Option<i64>,
    #[serde(default)]
    pub model_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAccountSnapshot {
    pub account_id: String,
    pub api_key: String,
    pub base_url: String,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub api_flavor: Option<String>,
    #[serde(default)]
    pub transport: Option<TransportSnapshot>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
    #[serde(default)]
    pub last_used_at_ms: i64,
    #[serde(default)]
    pub quota_observed_at_ms: Option<i64>,
    #[serde(default)]
    pub windows: Vec<SubscriptionWindow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPoolSnapshot {
    pub strategy: String,
    pub quota_freshness_ms: u32,
    pub accounts: Vec<SubscriptionAccountSnapshot>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRotationProvider {
    pub provider_id: String,
    pub account_count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub id: String,
    #[serde(default)]
    pub source_provider_id: Option<String>,
    /// Wire protocol: "openai" | "anthropic" (others are not yet executable
    /// by the gateway and are skipped by the fallback walk).
    pub protocol: String,
    pub base_url: String,
    #[serde(default)]
    pub api_flavor: Option<String>,
    #[serde(default)]
    pub model_metadata: Vec<ModelMetadata>,
    /// The primary / single credential. Always the fallback when no rotation
    /// pool is configured (or rotation is disabled).
    #[serde(default)]
    pub api_key: Option<String>,
    /// Upstream multi-account pool. Mirrors the app's per-provider
    /// `UserProviderSettings.apiKeys[]` so the gateway rotates / fails over
    /// across the same accounts the chat pipeline does. Empty = single-key.
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// Rotation strategy for the pool: "round-robin" | "random" | "least-used".
    /// `None` defaults to round-robin. Only consulted when `rotation_enabled`
    /// and `api_keys` is non-empty.
    #[serde(default)]
    pub rotation_strategy: Option<String>,
    /// Whether the pool actually rotates. Mirrors
    /// `UserProviderSettings.apiKeyRotationEnabled`; when false the gateway
    /// uses `api_key` alone (matching the app's single-key send path).
    #[serde(default)]
    pub rotation_enabled: bool,
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    /// The Provider Profile Store deployment this entry projects (Phase 2).
    #[serde(default)]
    pub deployment_id: Option<String>,
    /// Transport behavior override; absent ⇒ legacy protocol defaults.
    #[serde(default)]
    pub transport: Option<TransportSnapshot>,
    #[serde(default)]
    pub subscription_pool: Option<SubscriptionPoolSnapshot>,
    #[serde(default)]
    pub selected_subscription_account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSnapshot {
    #[serde(default)]
    pub subscription_rotation_providers: Vec<SubscriptionRotationProvider>,
    #[serde(default)]
    pub aliases: Vec<AliasSnapshot>,
    #[serde(default)]
    pub providers: Vec<ProviderSnapshot>,
    pub generated_at_ms: i64,
    #[serde(default)]
    pub routing_policy: Option<RoutingPolicySnapshotV2>,
    /// Provider Profile Store CAS version this snapshot projects. Legacy
    /// (pre-Phase-2) publishers omit it.
    #[serde(default)]
    pub profile_version: Option<u64>,
    /// Which publisher produced it. Required alongside `profile_version`.
    #[serde(default)]
    pub authority: Option<SnapshotAuthority>,
    /// The Router + Fusion surfaces this host has switched on (ADR-0188 D36).
    /// Absent — every snapshot written before B2 — means both off, which is the
    /// default and leaves every endpoint exactly as it was.
    #[serde(default)]
    pub router_fusion: Option<crate::runs::RouterFusionGatewaySwitches>,
}

impl RoutingSnapshot {
    pub fn find_alias(&self, alias: &str) -> Option<&AliasSnapshot> {
        let needle = alias.to_lowercase();
        self.aliases
            .iter()
            .find(|a| a.alias.to_lowercase() == needle)
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderSnapshot> {
        self.providers.iter().find(|p| p.id == id && p.enabled)
    }

    /// Provider entry projecting a given Profile Store deployment (ticket
    /// candidates address deployments, not live provider ids).
    pub fn provider_by_deployment(&self, deployment_id: &str) -> Option<&ProviderSnapshot> {
        self.providers
            .iter()
            .find(|p| p.enabled && p.deployment_id.as_deref() == Some(deployment_id))
    }

    /// Fail-closed ingest validation: every transport's static headers and
    /// custom auth-header name must pass the shared header policy, and a
    /// versioned snapshot must name its authority. An invalid snapshot is
    /// rejected WHOLE — the gateway keeps serving the previous one.
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_version.is_some() && self.authority.is_none() {
            return Err("versioned snapshot must declare its authority".into());
        }
        let mut provider_ids = std::collections::HashSet::new();
        let mut deployment_ids = std::collections::HashSet::new();
        for provider in &self.providers {
            let provider_id = provider.id.trim().to_ascii_lowercase();
            if provider_id.is_empty() || !provider_ids.insert(provider_id) {
                return Err(format!("duplicate provider '{}'", provider.id));
            }
            if [
                &provider.source_provider_id,
                &provider.selected_subscription_account_id,
            ]
            .into_iter()
            .flatten()
            .any(|id| id.trim().is_empty() || id.len() > 256)
            {
                return Err(format!(
                    "provider {}: invalid source/account identity",
                    provider.id
                ));
            }
            if let Some(deployment_id) = provider.deployment_id.as_deref() {
                let deployment_id = deployment_id.trim().to_ascii_lowercase();
                if deployment_id.is_empty() || !deployment_ids.insert(deployment_id) {
                    return Err(format!(
                        "duplicate deployment '{}'",
                        provider.deployment_id.as_deref().unwrap_or_default()
                    ));
                }
            }
            if let Some(strategy) = provider.rotation_strategy.as_deref() {
                if !matches!(strategy, "round-robin" | "random" | "least-used") {
                    return Err(format!(
                        "provider {}: unknown rotation strategy '{strategy}'",
                        provider.id
                    ));
                }
            }
            if let Some(pool) = &provider.subscription_pool {
                if pool.strategy != "allowance-reset"
                    || pool.quota_freshness_ms == 0
                    || pool.quota_freshness_ms > 300_000
                    || pool.accounts.is_empty()
                    || pool.accounts.len() > 128
                {
                    return Err(format!(
                        "provider {}: invalid subscription pool limits",
                        provider.id
                    ));
                }
                let mut accounts = std::collections::HashSet::new();
                for account in &pool.accounts {
                    let base = reqwest::Url::parse(&account.base_url).map_err(|_| {
                        format!("provider {}: invalid subscription endpoint", provider.id)
                    })?;
                    if account.account_id.trim().is_empty()
                        || account.account_id.len() > 256
                        || !accounts.insert(&account.account_id)
                        || account.api_key.trim().is_empty()
                        || account.api_key.len() > 65_536
                        || account.base_url.len() > 8192
                        || !matches!(base.scheme(), "http" | "https")
                        || base.host_str().is_none()
                        || !base.username().is_empty()
                        || base.password().is_some()
                        || account.last_used_at_ms < 0
                        || account.expires_at_ms.is_some_and(|time| time < 0)
                        || account.quota_observed_at_ms.is_some_and(|time| time < 0)
                        || account.windows.len() > 64
                        || account.protocol.as_ref().is_some_and(|protocol| {
                            !matches!(
                                protocol.as_str(),
                                "openai" | "responses" | "anthropic" | "google" | "gemini"
                            )
                        })
                        || account
                            .api_flavor
                            .as_ref()
                            .is_some_and(|flavor| !matches!(flavor.as_str(), "chat" | "responses"))
                    {
                        return Err(format!(
                            "provider {}: invalid subscription account",
                            provider.id
                        ));
                    }
                    let mut windows = std::collections::HashSet::new();
                    for window in &account.windows {
                        if window.id.trim().is_empty()
                            || window.id.len() > 256
                            || !windows.insert(&window.id)
                            || !window.used_pct.is_finite()
                            || !(0.0..=10_000.0).contains(&window.used_pct)
                            || window.reset_at_ms.is_some_and(|time| time < 0)
                            || window.model_ids.len() > 128
                            || window
                                .model_ids
                                .iter()
                                .any(|model| model.trim().is_empty() || model.len() > 1024)
                        {
                            return Err(format!(
                                "provider {}: invalid subscription allowance window",
                                provider.id
                            ));
                        }
                    }
                }
                if provider
                    .selected_subscription_account_id
                    .as_ref()
                    .is_some_and(|selected| {
                        !pool
                            .accounts
                            .iter()
                            .any(|account| &account.account_id == selected)
                    })
                {
                    return Err(format!(
                        "provider {}: selected subscription account is absent",
                        provider.id
                    ));
                }
            }
        }

        let mut inventory = std::collections::HashSet::new();
        if self.subscription_rotation_providers.len() > 256
            || self.subscription_rotation_providers.iter().any(|provider| {
                provider.provider_id.trim().is_empty() || !inventory.insert(&provider.provider_id)
            })
        {
            return Err("invalid subscription rotation inventory".into());
        }

        let mut aliases = std::collections::HashSet::new();
        for alias in &self.aliases {
            let normalized = alias.alias.trim().to_ascii_lowercase();
            if normalized.is_empty() || !aliases.insert(normalized) {
                return Err(format!("duplicate alias '{}'", alias.alias));
            }
            if !matches!(
                alias.distribution.as_str(),
                "priority" | "weighted" | "round-robin"
            ) {
                return Err(format!(
                    "alias {}: unknown distribution '{}'",
                    alias.alias, alias.distribution
                ));
            }
            if alias.entries.is_empty() {
                return Err(format!("alias {}: no candidates", alias.alias));
            }
            let mut entries = std::collections::HashSet::new();
            for entry in &alias.entries {
                if entry.provider_id.trim().is_empty() || entry.model_id.trim().is_empty() {
                    return Err(format!("alias {}: blank deployment entry", alias.alias));
                }
                let identity = format!(
                    "{}:{}",
                    entry.provider_id.to_ascii_lowercase(),
                    entry.model_id.to_ascii_lowercase()
                );
                if !entries.insert(identity) {
                    return Err(format!("alias {}: duplicate deployment entry", alias.alias));
                }
                if entry
                    .locality
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "local" | "remote"))
                {
                    return Err(format!("alias {}: invalid locality", alias.alias));
                }
                if [entry.pricing_per_1_m, entry.latency_ms, entry.success_rate]
                    .into_iter()
                    .flatten()
                    .any(|value| !value.is_finite() || value < 0.0)
                    || entry.success_rate.is_some_and(|value| value > 1.0)
                {
                    return Err(format!("alias {}: invalid routing metric", alias.alias));
                }
            }
            // Availability belongs to request-time candidate resolution. A
            // disabled provider or locked credential vault must not prevent a
            // valid snapshot from replacing stale routing/credential state.
            if alias.distribution == "weighted"
                && alias
                    .entries
                    .iter()
                    .any(|entry| entry.weight.unwrap_or(1) == 0)
            {
                return Err(format!("alias {}: weights must be positive", alias.alias));
            }
        }
        if let Some(policy) = &self.routing_policy {
            if policy.schema_version != 2 {
                return Err(format!(
                    "unsupported routing policy schema {}",
                    policy.schema_version
                ));
            }
            if policy.policy_revision.trim().is_empty() {
                return Err("routing policy revision must not be blank".into());
            }
            if policy.auto.model_id != "auto" {
                return Err("routing policy virtual model must be 'auto'".into());
            }
            if !matches!(
                policy.auto.strategy.as_str(),
                "reliability"
                    | "quality"
                    | "cost"
                    | "speed"
                    | "balanced"
                    | "adaptive"
                    | "least-busy"
                    | "difficulty"
            ) {
                return Err(format!(
                    "unknown built-in routing strategy '{}'",
                    policy.auto.strategy
                ));
            }
            if policy.max_fallback_attempts == 0 {
                return Err("maxFallbackAttempts must be positive".into());
            }
            if policy.auto.candidate_aliases.is_empty()
                || policy
                    .auto
                    .candidate_aliases
                    .iter()
                    .any(|candidate| !aliases.contains(&candidate.to_ascii_lowercase()))
            {
                return Err("auto policy references an unknown or empty candidate alias".into());
            }
            if let Some(thresholds) = &policy.auto.thresholds {
                if !(0.0..=1.0).contains(&thresholds.balanced)
                    || !(0.0..=1.0).contains(&thresholds.powerful)
                    || thresholds.balanced > thresholds.powerful
                {
                    return Err("auto difficulty thresholds are invalid".into());
                }
            }
            for constraint in &policy.provider_constraints {
                if !provider_ids.contains(&constraint.provider_id.to_ascii_lowercase()) {
                    return Err(format!(
                        "provider constraint references unknown provider '{}'",
                        constraint.provider_id
                    ));
                }
                if constraint
                    .daily_cost_budget
                    .is_some_and(|value| !value.is_finite() || value < 0.0)
                    || constraint
                        .current_daily_cost
                        .is_some_and(|value| !value.is_finite() || value < 0.0)
                {
                    return Err(format!(
                        "provider {}: invalid budget metric",
                        constraint.provider_id
                    ));
                }
            }
            if aliases.contains(&policy.auto.model_id.to_ascii_lowercase()) {
                return Err(format!(
                    "auto model '{}' collides with an alias",
                    policy.auto.model_id
                ));
            }
        }
        for provider in &self.providers {
            if provider
                .api_flavor
                .as_deref()
                .is_some_and(|flavor| !matches!(flavor, "chat" | "responses"))
            {
                return Err(format!("provider {}: invalid apiFlavor", provider.id));
            }
            for metadata in &provider.model_metadata {
                if metadata.id.is_empty() {
                    return Err("model metadata id is required".into());
                }
                for (field, value) in &metadata.fields {
                    let valid = match field.as_str() {
                        "name" => value.is_string(),
                        "contextLength" | "maxInputTokens" | "maxOutputTokens" => {
                            value.as_u64().is_some_and(|v| v > 0)
                        }
                        "supportsTools"
                        | "supportsReasoning"
                        | "supportsVision"
                        | "supportsAudio"
                        | "supportsVideo"
                        | "supportsStreaming"
                        | "supportsStructuredOutput" => value.is_boolean(),
                        _ => false,
                    };
                    if !valid {
                        return Err(format!(
                            "model {}: invalid metadata field {field}",
                            metadata.id
                        ));
                    }
                }
            }
            for transport in std::iter::once(provider.transport.as_ref())
                .chain(provider.subscription_pool.iter().flat_map(|pool| {
                    pool.accounts
                        .iter()
                        .map(|account| account.transport.as_ref())
                }))
                .flatten()
            {
                match transport.auth_scheme.as_str() {
                    "x-api-key" | "bearer" => {}
                    "custom-header" => {
                        let name = transport.auth_header_name.as_deref().unwrap_or("");
                        // The auth header itself may be a normally-blocked name
                        // ONLY if it is a well-formed token that is not hop-by-hop
                        // or internal; re-use the policy but allow the dedicated
                        // auth classification (a custom auth header IS an auth
                        // header by design — e.g. `x-goog-api-key`).
                        let verdict = crate::header_policy::check_header(
                            name,
                            Some("x"),
                            crate::header_policy::HeaderContext::Static,
                        );
                        let acceptable = verdict.allowed
                            || verdict.reason
                                == crate::header_policy::HeaderPolicyReason::AuthHeader;
                        if !acceptable {
                            return Err(format!(
                                "provider {}: invalid custom auth header name '{name}' ({})",
                                provider.id,
                                verdict.reason.code()
                            ));
                        }
                    }
                    other => {
                        return Err(format!(
                            "provider {}: unknown auth scheme '{other}'",
                            provider.id
                        ));
                    }
                }
                let violations = crate::header_policy::validate_static_headers(
                    transport
                        .static_headers
                        .iter()
                        .map(|(k, v)| (k.as_str(), v.as_str())),
                );
                if let Some((name, reason)) = violations.first() {
                    return Err(format!(
                        "provider {}: blocked static header '{name}' ({reason})",
                        provider.id
                    ));
                }
                for name in &transport.forwarded_semantic_headers {
                    let verdict = crate::header_policy::check_header(
                        name,
                        None,
                        crate::header_policy::HeaderContext::Forward,
                    );
                    if !verdict.allowed {
                        return Err(format!(
                            "provider {}: blocked forwarded header '{name}' ({})",
                            provider.id,
                            verdict.reason.code()
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "Fast", "entries": [
                    { "providerId": "groq", "modelId": "llama-3.3-70b" },
                    { "providerId": "openai", "modelId": "gpt-4o-mini" }
                ]}
            ],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "openai", "protocol": "openai", "baseUrl": "https://api.openai.com/v1",
                  "apiKey": "sk-o", "enabled": false }
            ],
            "generatedAtMs": 1750000000000i64
        }))
        .unwrap()
    }

    #[test]
    fn deserializes_camel_case_and_defaults() {
        let s = snapshot();
        assert_eq!(s.aliases[0].entries[0].provider_id, "groq");
        assert_eq!(s.providers[0].base_url, "https://api.groq.com/openai/v1");
        assert_eq!(s.providers[1].models.len(), 0); // defaulted
    }

    #[test]
    fn subscription_pool_validates_identities_allowance_bounds_and_transport_policy() {
        let account = serde_json::json!({"accountId":"account","apiKey":"credential","baseUrl":"https://account.invalid/v1","lastUsedAtMs":0,"windows":[{"id":"session","usedPct":25,"resetAtMs":10000}],"transport":{"authScheme":"custom-header","authHeaderName":"x-goog-api-key","staticHeaders":[["x-tenant","tenant"]]}});
        let value = serde_json::json!({"providers":[{"id":"provider","protocol":"google","baseUrl":"https://default.invalid/v1beta","enabled":true,"subscriptionPool":{"strategy":"allowance-reset","quotaFreshnessMs":300000,"accounts":[account]}}],"generatedAtMs":1});
        let valid: RoutingSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(valid.validate().is_ok());
        for (path, replacement) in [
            (
                "/providers/0/subscriptionPool/quotaFreshnessMs",
                serde_json::json!(300001),
            ),
            (
                "/providers/0/subscriptionPool/accounts/0/baseUrl",
                serde_json::json!("file:///private/data"),
            ),
            (
                "/providers/0/subscriptionPool/accounts/0/windows/0/usedPct",
                serde_json::json!(-1),
            ),
            (
                "/providers/0/subscriptionPool/accounts/0/transport/staticHeaders",
                serde_json::json!([["authorization", "secret"]]),
            ),
        ] {
            let mut invalid = value.clone();
            *invalid.pointer_mut(path).unwrap() = replacement;
            assert!(
                serde_json::from_value::<RoutingSnapshot>(invalid)
                    .unwrap()
                    .validate()
                    .is_err(),
                "{path}"
            );
        }
        let mut duplicate = value;
        duplicate["providers"][0]["subscriptionPool"]["accounts"]
            .as_array_mut()
            .unwrap()
            .push(account);
        assert!(serde_json::from_value::<RoutingSnapshot>(duplicate)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn alias_lookup_is_case_insensitive() {
        let s = snapshot();
        assert!(s.find_alias("fast").is_some());
        assert!(s.find_alias("FAST").is_some());
        assert!(s.find_alias("ghost").is_none());
    }

    #[test]
    fn provider_lookup_skips_disabled() {
        let s = snapshot();
        assert!(s.provider("groq").is_some());
        assert!(s.provider("openai").is_none()); // disabled
        assert!(s.provider("ghost").is_none());
    }

    #[test]
    fn unavailable_alias_does_not_reject_other_routes_or_credential_revocation() {
        let mut s = snapshot();
        s.providers[0].enabled = false;
        assert!(s.validate().is_ok());
        assert!(crate::execute::resolve_candidates(&s, "fast").is_empty());
        s.providers[1].enabled = true;
        assert!(s.validate().is_ok());
        assert!(!crate::execute::resolve_candidates(&s, "openai:gpt-4o").is_empty());
    }

    #[test]
    fn provider_pool_fields_deserialize_with_defaults() {
        // Pool fields absent → single-key defaults.
        let single: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "p", "protocol": "openai", "baseUrl": "u", "apiKey": "sk-1", "enabled": true
        }))
        .unwrap();
        assert!(single.api_keys.is_empty());
        assert!(!single.rotation_enabled);
        assert!(single.rotation_strategy.is_none());

        // Pool fields present → carried through.
        let pooled: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "p", "protocol": "openai", "baseUrl": "u", "enabled": true,
            "apiKeys": ["sk-a", "sk-b"], "rotationEnabled": true,
            "rotationStrategy": "least-used"
        }))
        .unwrap();
        assert_eq!(
            pooled.api_keys,
            vec!["sk-a".to_string(), "sk-b".to_string()]
        );
        assert!(pooled.rotation_enabled);
        assert_eq!(pooled.rotation_strategy.as_deref(), Some("least-used"));
    }

    #[test]
    fn validates_v2_policy_and_alias_distribution() {
        let value = serde_json::json!({
            "aliases": [{
                "alias": "fast",
                "distribution": "round-robin",
                "entries": [
                    { "providerId": "groq", "modelId": "llama", "weight": 1 },
                    { "providerId": "anthropic", "modelId": "claude", "weight": 1 }
                ]
            }],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://g/v1", "enabled": true },
                { "id": "anthropic", "protocol": "anthropic", "baseUrl": "https://a/v1", "enabled": true }
            ],
            "routingPolicy": {
                "schemaVersion": 2,
                "policyRevision": "7",
                "auto": { "modelId": "auto", "strategy": "reliability", "candidateAliases": ["fast"] },
                "maxFallbackAttempts": 3
            },
            "generatedAtMs": 7
        });
        let snapshot: RoutingSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(snapshot.aliases[0].distribution.as_str(), "round-robin");
        assert_eq!(snapshot.routing_policy.as_ref().unwrap().schema_version, 2);
        assert!(snapshot.validate().is_ok());
    }

    #[test]
    fn rejects_duplicate_aliases_and_auto_model_collisions() {
        let value = serde_json::json!({
          "aliases": [
            { "alias": "auto", "entries": [{ "providerId": "groq", "modelId": "m" }] },
            { "alias": "AUTO", "entries": [{ "providerId": "groq", "modelId": "m" }] }
          ],
          "providers": [{ "id": "groq", "protocol": "openai", "baseUrl": "https://g/v1", "enabled": true }],
          "routingPolicy": {
            "schemaVersion": 2,
            "policyRevision": "1",
            "auto": { "modelId": "auto", "strategy": "reliability", "candidateAliases": [] },
            "maxFallbackAttempts": 3
          },
          "generatedAtMs": 1
        });
        let snapshot: RoutingSnapshot = serde_json::from_value(value).unwrap();
        assert!(snapshot.validate().unwrap_err().contains("duplicate alias"));
    }

    #[test]
    fn rejects_unknown_strategies_and_missing_auto_aliases() {
        let mut value = serde_json::json!({
          "aliases": [{ "alias": "fast", "entries": [{ "providerId": "groq", "modelId": "m" }] }],
          "providers": [{ "id": "groq", "protocol": "openai", "baseUrl": "https://g/v1", "enabled": true }],
          "routingPolicy": {
            "schemaVersion": 2,
            "policyRevision": "1",
            "auto": { "modelId": "auto", "strategy": "plugin:x", "candidateAliases": ["fast"] },
            "maxFallbackAttempts": 3
          },
          "generatedAtMs": 1
        });
        let snapshot: RoutingSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(snapshot
            .validate()
            .unwrap_err()
            .contains("unknown built-in"));

        value["routingPolicy"]["auto"]["strategy"] = serde_json::json!("reliability");
        value["routingPolicy"]["auto"]["candidateAliases"] = serde_json::json!(["missing"]);
        let snapshot: RoutingSnapshot = serde_json::from_value(value).unwrap();
        assert!(snapshot
            .validate()
            .unwrap_err()
            .contains("unknown or empty"));
    }
}
