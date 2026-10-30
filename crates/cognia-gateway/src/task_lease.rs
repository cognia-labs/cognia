//! Device-owned, short-lived task delegation. Provider credentials are private
//! ticket overrides, never a global snapshot or a reusable Host API key.
use crate::{
    route_ticket::*,
    snapshot::{ProviderSnapshot, RoutingSnapshot},
    GatewayState,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const TASK_LEASE_TTL_MS: i64 = 120_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskModelPlan {
    pub additional_models: Vec<String>,
    pub model_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub bindings: BTreeMap<String, TaskModelBinding>,
    #[serde(default)]
    pub selector_deployments: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskModelBinding {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl TaskModelPlan {
    pub(crate) fn validate(&self, primary: &str) -> Result<(), String> {
        let mut models = std::collections::BTreeSet::from([primary]);
        if self.additional_models.len() > 31 || self.model_bindings.len() > 64 {
            return Err("task model plan exceeds model or binding limit".into());
        }
        for model in &self.additional_models {
            if model.is_empty()
                || model.len() > 256
                || model.chars().any(char::is_control)
                || !models.insert(model.as_str())
            {
                return Err("invalid or duplicate additional task model".into());
            }
        }
        for (selector, model) in &self.model_bindings {
            if selector.is_empty()
                || selector.len() > 128
                || !selector.bytes().all(|b| (b' '..=b'~').contains(&b))
                || (!models.contains(model.as_str()) && !self.bindings.values().any(|binding| &binding.model_id == model))
            {
                return Err("invalid task model binding or model outside the plan".into());
            }
        }
        if self.bindings.len() > 31 || self.selector_deployments.len() > 104 {
            return Err("task model plan exceeds deployment limit".into());
        }
        for (selector, binding) in &self.bindings {
            if !models.contains(selector.as_str()) || binding.provider_id.trim().is_empty()
                || binding.model_id.is_empty() || binding.model_id.len() > 256
                || binding.model_id.chars().any(char::is_control) {
                return Err("invalid task deployment binding".into());
            }
        }
        Ok(())
    }

    fn models(&self, primary: &str) -> Vec<String> {
        std::iter::once(primary.to_owned())
            .chain(self.additional_models.iter().cloned())
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskLeaseRequest {
    pub task_id: String,
    pub provider: ProviderSnapshot,
    #[serde(default)]
    pub provider_overrides: Vec<ProviderSnapshot>,
    pub model: String,
    #[serde(default)]
    pub model_plan: Option<TaskModelPlan>,
    pub ingress_protocol: String,
    /// Optional consumption ceiling for the task (a Bot run's remaining
    /// token allowance). Only the `max_*` members are honoured.
    #[serde(default)]
    pub budget: Option<TicketBudget>,
    #[serde(skip)]
    pub upstream_client: Option<reqwest::Client>,
    #[serde(skip)]
    pub authority: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLease {
    pub ticket_id: String,
    pub secret: String,
    pub account_generation: u64,
    pub owner_account_id: Option<String>,
    pub expires_at_ms: i64,
}

pub(crate) fn empty_snapshot() -> RoutingSnapshot {
    RoutingSnapshot {
        aliases: vec![],
        providers: vec![],
        generated_at_ms: chrono::Utc::now().timestamp_millis(),
        routing_policy: None,
        profile_version: None,
        authority: None,
        router_fusion: None,
        subscription_rotation_providers: Vec::new(),
    }
}

fn scope(tenant: &str, device: &str, task: &str) -> Result<String, String> {
    if tenant.is_empty()
        || device.is_empty()
        || task.is_empty()
        || task.len() > 128
        || !task
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid gateway task identity".into());
    }
    Ok(serde_json::to_string(&("remote-task", tenant, device, task)).expect("strings serialize"))
}

/// A desktop-local URL would resolve against the runner's network. Refuse it
/// before accepting credentials; the request-scoped provider is HTTPS only.
pub async fn validate_public_upstream(value: &str) -> Result<reqwest::Client, String> {
    validate_public_upstreams(&[value.to_owned()]).await
}

/// Pin every delegated deployment in one redirect-free HTTPS client. One task
/// may use several providers; each host is checked before any credential is accepted.
pub async fn validate_public_upstreams(values: &[String]) -> Result<reqwest::Client, String> {
    if values.is_empty() || values.len() > 32 { return Err("invalid task upstream count".into()); }
    cognia_net::proxy_config::ensure_crypto_provider();
    let mut builder = reqwest::Client::builder().no_proxy().https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15));
    for value in values {
        let url = reqwest::Url::parse(value).map_err(|_| "invalid task upstream URL")?;
        let host = url.host_str().ok_or("task upstream requires a host")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
            || url.fragment().is_some() || !host.contains('.') || host.ends_with(".localhost")
            || host.ends_with(".local") || host.ends_with(".internal") {
            return Err("remote tasks require a public HTTPS upstream; local providers need a service bridge".into());
        }
        let addresses: Vec<_> = tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await.map_err(|_| "task upstream DNS resolution failed")?.collect();
        if addresses.is_empty() || addresses.iter().any(|address| cognia_net::egress::is_forbidden_dest_ip(&address.ip())) {
            return Err("remote tasks cannot use private or loopback upstreams".into());
        }
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder.build().map_err(|_| "task upstream client initialization failed".into())
}

/// The one ticket shape a gateway task runs under, whoever supplied the
/// provider: private deployments with exact model/account bindings (or the legacy
/// primary selectors), no failover, `gateway-required`, and inference/models/
/// count-tokens only.
#[allow(clippy::too_many_arguments)]
fn task_mint_request(
    session: String,
    fingerprint: String,
    deployment: String,
    provider: ProviderSnapshot,
    extra_providers: Vec<ProviderSnapshot>,
    model: String,
    ingress_protocol: &str,
    budget: Option<TicketBudget>,
    model_plan: Option<TaskModelPlan>,
) -> MintRequest {
    let mut bindings: BTreeMap<_, _> = [
        model.as_str(),
        "primary",
        "fast",
        "powerful",
        "sonnet",
        "haiku",
        "opus",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), model.clone()))
    .collect();
    if let Some(plan) = &model_plan {
        bindings.extend(plan.model_bindings.clone());
        bindings.extend(plan.models(&model).into_iter().map(|id| (id.clone(), id)));
    }
    let mut selector_deployments = model_plan.as_ref().map(|plan| plan.selector_deployments.clone()).unwrap_or_default();
    let mut providers = vec![provider];
    providers.extend(extra_providers);
    let candidates = providers.iter().map(|provider| TicketCandidate {
        deployment_id: provider.deployment_id.clone().unwrap_or_else(|| provider.id.clone()),
        model_id: provider.models.first().cloned().unwrap_or_else(|| model.clone()),
    }).collect();
    if !selector_deployments.is_empty() {
        for selector in ["primary", "fast", "powerful", "sonnet", "haiku", "opus"] {
            selector_deployments.entry(selector.into()).or_insert_with(|| deployment.clone());
        }
        for (selector, binding) in model_plan.as_ref().into_iter().flat_map(|plan| &plan.bindings) {
            bindings.insert(selector.clone(), binding.model_id.clone());
        }
    }
    if !selector_deployments.is_empty() {
        for (selector, model) in &bindings {
            if selector_deployments.contains_key(selector) { continue; }
            let deployments: std::collections::BTreeSet<_> = providers.iter().filter(|provider| provider.models.contains(model))
                .map(|provider| provider.deployment_id.clone().unwrap_or_else(|| provider.id.clone())).collect();
            if deployments.len() == 1 { selector_deployments.insert(selector.clone(), deployments.into_iter().next().unwrap()); }
        }
    }
    MintRequest {
        provider_overrides: providers,
        session_id: session,
        parent_session_id: None,
        execution_fingerprint: fingerprint,
        candidates,
        model_bindings: bindings,
        selector_deployments,
        strict_selectors: model_plan.is_some(),
        credential_affinity: TicketAffinity::SessionSticky,
        allow_auth_failover: false,
        route_policy: "gateway-required".into(),
        ttl_ms: Some(TASK_LEASE_TTL_MS),
        model: Some(model),
        operations: Some(vec![
            if ingress_protocol == "openai-responses" {
                TicketOperation::Responses
            } else {
                TicketOperation::Chat
            },
            TicketOperation::Models,
            TicketOperation::CountTokens,
        ]),
        // Counters always start at zero: a caller names ceilings, never spend.
        budget: budget.map(|budget| TicketBudget {
            max_tokens: budget.max_tokens,
            max_requests: budget.max_requests,
            max_requests_per_min: budget.max_requests_per_min,
            ..TicketBudget::default()
        }),
    }
}

impl GatewayState {
    /// P6d admission fixtures: publish listener facts without binding a port.
    /// This exercises lease/spawn validation only, never network acceptance.
    #[cfg(any(test, feature = "test-support"))]
    pub fn person_test_listener(&self, port: u16) {
        let mut inner = self.inner.lock();
        inner.status.running = port != 0;
        inner.status.bound_port = (port != 0).then_some(port);
    }
    /// P6d: a partition-owned task uses the same frozen brokered task shape,
    /// with member billing. The Host supplies the org override under its
    /// credential fence. Keep the provider id so credential rotation can
    /// revoke this lease through the P6c registry path.
    #[allow(clippy::too_many_arguments)]
    pub fn person_mint_task_lease(&self, owner: &str, member: MemberBinding, runtime: &str,
        task: &str, expected_generation: u64, provider: ProviderSnapshot, model: String,
        ingress: &str) -> Result<TaskLease, String> {
        let session = scope(owner, "person-brain", task)?;
        let account = self.account.read();
        if account.generation != expected_generation { return Err("gateway account changed".into()); }
        if !provider.enabled || provider.api_key.as_deref().is_none_or(str::is_empty)
            || !provider.api_keys.is_empty() || provider.rotation_enabled
            || !provider.models.contains(&model) {
            return Err("invalid person task provider".into());
        }
        let deployment = provider.deployment_id.clone().unwrap_or_else(|| provider.id.clone());
        let mut request = task_mint_request(session.clone(), session.clone(), deployment,
            provider, Vec::new(), model, ingress, None, None);
        request.route_policy = format!("person_p6d:{runtime}");
        self.tickets.revoke_session(&session);
        let minted = self.tickets.person_mint_owned(request, Some(&empty_snapshot()),
            chrono::Utc::now().timestamp_millis(), Some(owner.into()), Some(member))
            .map_err(|e| e.to_string())?;
        Ok(TaskLease { ticket_id: minted.ticket.ticket_id, secret: minted.secret,
            account_generation: account.generation, owner_account_id: Some(owner.into()),
            expires_at_ms: minted.ticket.expires_at_ms })
    }

    pub fn person_validate_task_secret(&self, owner: &str, member: &MemberBinding,
        runtime: &str, task: &str, secret: &str) -> Result<(), String> {
        let session = scope(owner, "person-brain", task)?;
        let ticket = self.tickets.validate(secret, chrono::Utc::now().timestamp_millis())
            .map_err(|_| "credential_delivery_refused")?;
        // A caller omitting sessionId addresses the fresh task by ticketId,
        // already present in the standard TaskLease response. A named session
        // may keep its native task home across remints.
        if ticket.owner_account_id.as_deref() != Some(owner) || ticket.member.as_ref() != Some(member)
            || (ticket.session_id != session && ticket.ticket_id != task)
            || ticket.route_policy != format!("person_p6d:{runtime}") {
            return Err("credential_delivery_refused".into());
        }
        Ok(())
    }

    pub fn mint_task_lease(
        &self,
        tenant: &str,
        device: &str,
        expected_generation: u64,
        mut input: TaskLeaseRequest,
    ) -> Result<TaskLease, String> {
        let session = scope(tenant, device, &input.task_id)?;
        let upstream_client = input
            .upstream_client
            .take()
            .ok_or("task upstream must be validated and pinned")?;
        let authority = input
            .authority
            .take()
            .ok_or("task device authority is required")?;
        if !authority() {
            return Err("task device was revoked".into());
        }
        let account = self.account.read();
        if account.generation != expected_generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed or is locked".into());
        }
        if input.model.trim().is_empty() || input.model.len() > 256
            || !["openai-chat", "openai-responses", "anthropic"].contains(&input.ingress_protocol.as_str())
            || input.provider_overrides.len() > 31 {
            return Err("invalid task model or ingress protocol".into());
        }
        if let Some(plan) = &input.model_plan { plan.validate(&input.model)?; }
        let selectors = input.model_plan.as_ref().map_or_else(|| vec![input.model.clone()], |plan| plan.models(&input.model));
        let primary_original = input.provider.deployment_id.clone().unwrap_or_else(|| input.provider.id.clone());
        let mut providers = vec![input.provider];
        providers.append(&mut input.provider_overrides);
        let mut remap = BTreeMap::new();
        for provider in &mut providers {
            if !crate::execute::is_executable_protocol(&provider.protocol) || !provider.enabled
                || provider.api_key.as_deref().is_none_or(str::is_empty) || !provider.api_keys.is_empty()
                || provider.rotation_enabled {
                return Err("a task must delegate one selected credential for each provider".into());
            }
            let original = provider.deployment_id.clone().unwrap_or_else(|| provider.id.clone());
            let deployment = format!("task-{}-{}", input.task_id, original);
            if remap.insert(original.clone(), deployment.clone()).is_some() {
                return Err("duplicate task deployment".into());
            }
            let models: Vec<String> = selectors.iter().filter_map(|selector| {
                let selected = input.model_plan.as_ref().and_then(|plan| plan.selector_deployments.get(selector)).unwrap_or(&primary_original);
                if selected != &original { return None; }
                Some(input.model_plan.as_ref().and_then(|plan| plan.bindings.get(selector).map(|binding| binding.model_id.clone()).or_else(|| plan.model_bindings.get(selector).cloned())).unwrap_or_else(|| selector.clone()))
            }).collect();
            if models.is_empty() || (!provider.models.is_empty() && models.iter().any(|model| !provider.models.contains(model))) {
                return Err("the selected task model is unavailable on its deployment".into());
            }
            if provider.source_provider_id.is_none() { provider.source_provider_id = Some(provider.id.clone()); }
            provider.id = deployment.clone(); provider.deployment_id = Some(deployment);
            provider.models = models;
            provider.model_metadata.retain(|model| provider.models.contains(&model.id));
        }
        let deployment = remap.get(&primary_original).ok_or("missing primary task deployment")?.clone();
        if let Some(plan) = &mut input.model_plan {
            for selected in plan.selector_deployments.values_mut() {
                *selected = remap.get(selected).ok_or("task selector names an undelegated deployment")?.clone();
            }
        }
        input.provider = providers.remove(0);
        input.provider_overrides = providers;
        // Replace any live lease for this exact device/task; no sibling device
        // can revoke it, and re-mint cannot retain two spending authorities.
        self.tickets.revoke_session(&session);
        let model = input.model.clone();
        let minted = self
            .tickets
            .mint_owned(
                task_mint_request(
                    session.clone(),
                    session,
                    deployment,
                    input.provider,
                    input.provider_overrides,
                    model,
                    &input.ingress_protocol,
                    input.budget,
                    input.model_plan,
                ),
                Some(&empty_snapshot()),
                chrono::Utc::now().timestamp_millis(),
                account.owner_account_id.clone(),
            )
            .map_err(|e| e.to_string())?;
        self.tickets
            .set_task_authority(&minted.ticket.ticket_id, authority);
        self.tickets
            .set_task_client(&minted.ticket.ticket_id, upstream_client);
        Ok(TaskLease {
            ticket_id: minted.ticket.ticket_id,
            secret: minted.secret,
            expires_at_ms: minted.ticket.expires_at_ms,
            account_generation: account.generation,
            owner_account_id: account.owner_account_id.clone(),
        })
    }

    pub fn control_task_lease(
        &self,
        tenant: &str,
        device: &str,
        task: &str,
        ticket_id: &str,
        generation: u64,
        renew: bool,
    ) -> Result<bool, String> {
        let session = scope(tenant, device, task)?;
        let account = self.account.read();
        if account.generation != generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed".into());
        }
        if !self.tickets.list().iter().any(|t| {
            t.ticket_id == ticket_id
                && t.session_id == session
                && t.owner_account_id == account.owner_account_id
        }) {
            return Err("gateway lease belongs to another task or device".into());
        }
        Ok(if renew {
            self.tickets.renew(
                ticket_id,
                chrono::Utc::now().timestamp_millis(),
                TASK_LEASE_TTL_MS,
            )
        } else {
            self.tickets.revoke(ticket_id)
        })
    }

    /// Desktop tickets use the task session directly, unlike paired-device
    /// delegation. The account generation prevents an unlock/lock/unlock ABA.
    pub fn validate_local_task_secret(
        &self,
        task: &str,
        owner: Option<&str>,
        generation: u64,
        port: u16,
        secret: &str,
    ) -> Result<(), String> {
        if task.is_empty()
            || task.len() > 128
            || !task
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || port == 0
        {
            return Err("Invalid local gateway task identity".into());
        }
        let account = self.account.read();
        if account.generation != generation
            || account.owner_account_id.as_deref() != owner
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("Local gateway account authority changed".into());
        }
        let inner = self.inner.lock();
        if !inner.status.running || inner.status.bound_port != Some(port) {
            return Err("Local gateway listener is unavailable or changed".into());
        }
        let now = chrono::Utc::now().timestamp_millis();
        if self.tickets.list().iter().any(|ticket| {
            ticket.session_id == task
                && ticket.owner_account_id == account.owner_account_id
                && self.tickets.is_live(&ticket.ticket_id, now)
                && self
                    .tickets
                    .secret_matches_ticket(&ticket.ticket_id, secret)
        }) {
            Ok(())
        } else {
            Err("Local gateway lease is expired or belongs to another task/account".into())
        }
    }

    pub fn validate_task_secret(
        &self,
        tenant: &str,
        device: &str,
        task: &str,
        secret: &str,
    ) -> Result<(), String> {
        let session = scope(tenant, device, task)?;
        let account = self.account.read();
        let now = chrono::Utc::now().timestamp_millis();
        if self.tickets.list().iter().any(|t| {
            t.session_id == session
                && t.owner_account_id == account.owner_account_id
                && self.tickets.is_live(&t.ticket_id, now)
                && self.tickets.secret_matches_ticket(&t.ticket_id, secret)
        }) {
            Ok(())
        } else {
            Err("gateway lease is expired or belongs to another task/device".into())
        }
    }
}

/// A Host-run task (ADR-0090, 2026-10-02 amendment): the Host's own process
/// asks for a lease on a provider the Host already holds. Unlike
/// [`TaskLeaseRequest`] it carries no provider and no credential — both are
/// read from the routing snapshot this gateway already serves (on
/// `cognia-server`, the Provider Profile Store projection), so an upstream key
/// never crosses a process boundary, let alone reaches the paired device the
/// turn runs for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostTaskLeaseRequest {
    pub task_id: String,
    /// The snapshot provider id (on a headless Host, the profile deployment id).
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub model_plan: Option<TaskModelPlan>,
    pub ingress_protocol: String,
    /// The paired device the Host runs the turn for. Part of the lease scope,
    /// so one device can neither renew nor reuse another device's task.
    #[serde(default)]
    pub origin_device_id: Option<String>,
    /// Optional consumption ceiling for the task, as on [`TaskLeaseRequest`].
    #[serde(default)]
    pub budget: Option<TicketBudget>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTaskLease {
    pub ticket_id: String,
    pub secret: String,
    pub account_generation: u64,
    pub owner_account_id: Option<String>,
    pub expires_at_ms: i64,
    /// Capability facts the snapshot carries for the model, when it has any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_metadata: Option<crate::snapshot::ModelMetadata>,
    pub model_metadata_by_id: BTreeMap<String, crate::snapshot::ModelMetadata>,
}

fn host_scope(origin: Option<&str>, task: &str) -> Result<String, String> {
    let origin = origin.unwrap_or("");
    if task.is_empty()
        || task.len() > 128
        || !task
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || origin.len() > 256
    {
        return Err("invalid gateway task identity".into());
    }
    Ok(serde_json::to_string(&("host-task", origin, task)).expect("strings serialize"))
}

impl GatewayState {
    /// Mint a renewable, task-private lease on one Host provider and model.
    ///
    /// The provider is copied out of the CURRENT snapshot into a private
    /// deployment the ticket alone can reach, with exactly one credential, so a
    /// later snapshot change cannot widen the task and the task cannot reach
    /// any other provider. The ticket shape is the device lease's
    /// ([`task_mint_request`]): `gateway-required`, session-sticky, no
    /// failover, inference/models/count-tokens only, two-minute TTL.
    pub fn mint_host_task_lease(
        &self,
        expected_generation: u64,
        input: HostTaskLeaseRequest,
        authority: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<HostTaskLease, String> {
        let session = host_scope(input.origin_device_id.as_deref(), &input.task_id)?;
        if authority.as_ref().is_some_and(|check| !check()) {
            return Err("task device was revoked".into());
        }
        if input.model.trim().is_empty()
            || input.model.len() > 512
            || input.provider_id.trim().is_empty()
            || !["openai-chat", "openai-responses", "anthropic"]
                .contains(&input.ingress_protocol.as_str())
        {
            return Err("invalid gateway task request".into());
        }
        let account = self.account.read();
        if account.generation != expected_generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed or is locked".into());
        }
        let mut model_plan = input.model_plan;
        let bridge_config = self.config.read().clone();
        if bridge_config.bridge_models.search.is_some() || bridge_config.bridge_models.vision.is_some() {
            let mut bridge_selectors=std::collections::HashSet::new();
            for selector in [bridge_config.bridge_models.search, bridge_config.bridge_models.vision].into_iter().flatten() {
                if selector.trim().is_empty() { continue; }
                if !bridge_selectors.insert(selector.clone()) { continue; }
                let selected = self.with_snapshot(|snapshot| {
                    let snapshot = snapshot?;
                    crate::route_planner::candidates_for_model(snapshot, &selector).into_iter().find_map(|candidate| {
                        let provider = snapshot.provider_by_deployment(&candidate.deployment_id).or_else(|| snapshot.provider(&candidate.deployment_id))?;
                        (provider.enabled && provider.models.contains(&candidate.model_id)).then_some(TaskModelBinding { provider_id:provider.id.clone(), model_id:candidate.model_id, account_id:None })
                    })
                }).ok_or("the configured gateway bridge model is unavailable")?;
                let plan = model_plan.get_or_insert_with(TaskModelPlan::default);
                if selector == input.model || plan.additional_models.contains(&selector) { return Err("gateway bridge selector conflicts with a task model".into()); }
                plan.additional_models.push(selector.clone());
                plan.model_bindings.insert(selector.clone(), selected.model_id.clone());
                plan.bindings.insert(selector, selected);
            }
        }
        if let Some(plan) = &model_plan { plan.validate(&input.model)?; }
        if model_plan.as_ref().is_some_and(|plan| !plan.selector_deployments.is_empty()) {
            return Err("Host task deployment mappings are resolved by the Host".into());
        }
        let selectors = model_plan.as_ref().map_or_else(|| vec![input.model.clone()], |plan| plan.models(&input.model));
        let deployment = format!("host-task-{}", input.task_id);
        let mut providers: BTreeMap<String, ProviderSnapshot> = BTreeMap::new();
        let mut model_metadata_by_id = BTreeMap::new();
        let mut selector_deployments = BTreeMap::new();
        for selector in &selectors {
            let selected = model_plan.as_ref().and_then(|plan| plan.bindings.get(selector));
            if selected.is_some_and(|binding| binding.account_id.is_some()) {
                return Err("this Host's providers have no selectable accounts".into());
            }
            let provider_id = selected.map(|binding| binding.provider_id.as_str()).unwrap_or(&input.provider_id);
            let model = selected.map(|binding| binding.model_id.as_str()).unwrap_or(selector);
            let provider = self.with_snapshot(|snapshot| snapshot.and_then(|snapshot| snapshot.provider(provider_id).or_else(|| snapshot.provider_by_deployment(provider_id))).cloned())
                .ok_or("the selected provider is not configured on this Host")?;
            if !provider.enabled || !crate::execute::is_executable_protocol(&provider.protocol) {
                return Err("the selected provider protocol cannot serve a gateway task".into());
            }
            if !provider.models.iter().any(|id| id == model) {
                return Err("the selected model is not configured for this provider".into());
            }
            let credential = provider.api_key.clone().filter(|key| !key.trim().is_empty())
                .or_else(|| provider.api_keys.iter().find(|key| !key.trim().is_empty()).cloned())
                .ok_or("the selected provider has no usable credential on this Host")?;
            let selected_deployment = if provider_id == input.provider_id { deployment.clone() } else { format!("{deployment}-{provider_id}") };
            selector_deployments.insert(selector.clone(), selected_deployment.clone());
            let metadata = provider.model_metadata.iter().find(|metadata| metadata.id == model).cloned()
                .unwrap_or_else(|| crate::snapshot::ModelMetadata { id: model.into(), fields: BTreeMap::new() });
            if metadata.fields.get("supportsTools") == Some(&serde_json::Value::Bool(false))
                || metadata.fields.get("supportsStreaming") == Some(&serde_json::Value::Bool(false)) {
                return Err("the selected model lacks tools or streaming required by the task".into());
            }
            let mut client_metadata = metadata.clone(); client_metadata.id = selector.clone();
            model_metadata_by_id.insert(selector.clone(), client_metadata);
            let private = providers.entry(selected_deployment.clone()).or_insert_with(|| {
                let mut provider = provider;
                if provider.source_provider_id.is_none() { provider.source_provider_id = Some(provider.id.clone()); }
                provider.id = selected_deployment.clone(); provider.deployment_id = Some(selected_deployment);
                provider.api_key = Some(credential); provider.api_keys.clear(); provider.rotation_enabled = false;
                provider.rotation_strategy = None; provider.models.clear(); provider.model_metadata.clear(); provider
            });
            if !private.models.iter().any(|id| id == model) { private.models.push(model.into()); private.model_metadata.push(metadata); }
        }
        let provider = providers.remove(&deployment).ok_or("missing primary task deployment")?;
        let model_metadata = model_metadata_by_id.get(&input.model).cloned();
        if let Some(plan) = &mut model_plan {
            plan.selector_deployments = selector_deployments;
            for (selector, binding) in &plan.bindings { plan.model_bindings.insert(selector.clone(), binding.model_id.clone()); }
        }
        // One live lease per task: a rebind or retry replaces the previous one.
        self.tickets.revoke_session(&session);
        let minted = self
            .tickets
            .mint_owned(
                task_mint_request(
                    session.clone(),
                    // The complete selection defines the frozen authority; repeats
                    // keep their existing shared spending counters.
                    format!("host-task:{}", hex::encode(<sha2::Sha256 as sha2::Digest>::digest(serde_json::to_vec(&(&session, &input.provider_id, &input.model, &model_plan)).expect("model plan serializes")))),
                    deployment,
                    provider,
                    providers.into_values().collect(),
                    input.model,
                    &input.ingress_protocol,
                    input.budget,
                    model_plan,
                ),
                Some(&empty_snapshot()),
                chrono::Utc::now().timestamp_millis(),
                account.owner_account_id.clone(),
            )
            .map_err(|e| e.to_string())?;
        if let Some(authority) = authority {
            self.tickets
                .set_task_authority(&minted.ticket.ticket_id, authority);
        }
        Ok(HostTaskLease {
            ticket_id: minted.ticket.ticket_id,
            secret: minted.secret,
            expires_at_ms: minted.ticket.expires_at_ms,
            account_generation: account.generation,
            owner_account_id: account.owner_account_id.clone(),
            model_metadata,
            model_metadata_by_id,
        })
    }

    /// Renew (`true`) or revoke (`false`) a Host task lease. Scoped to the
    /// task, its origin device and the account generation it was minted under.
    pub fn control_host_task_lease(
        &self,
        origin: Option<&str>,
        task: &str,
        ticket_id: &str,
        generation: u64,
        renew: bool,
    ) -> Result<bool, String> {
        let session = host_scope(origin, task)?;
        let account = self.account.read();
        if account.generation != generation
            || (account.required && account.owner_account_id.is_none())
        {
            return Err("gateway account changed".into());
        }
        if !self.tickets.list().iter().any(|t| {
            t.ticket_id == ticket_id
                && t.session_id == session
                && t.owner_account_id == account.owner_account_id
        }) {
            return Err("gateway lease belongs to another task or device".into());
        }
        Ok(if renew {
            self.tickets.renew(
                ticket_id,
                chrono::Utc::now().timestamp_millis(),
                TASK_LEASE_TTL_MS,
            )
        } else {
            self.tickets.revoke(ticket_id)
        })
    }

    /// The launch-time check for a Host task: the secret the process is about
    /// to receive belongs to a live lease for exactly this task and device.
    pub fn validate_host_task_secret(
        &self,
        origin: Option<&str>,
        task: &str,
        secret: &str,
    ) -> Result<(), String> {
        let session = host_scope(origin, task)?;
        let account = self.account.read();
        let now = chrono::Utc::now().timestamp_millis();
        if self.tickets.list().iter().any(|t| {
            t.session_id == session
                && t.owner_account_id == account.owner_account_id
                && self.tickets.is_live(&t.ticket_id, now)
                && self.tickets.secret_matches_ticket(&t.ticket_id, secret)
        }) {
            Ok(())
        } else {
            Err("gateway lease is expired or belongs to another task/device".into())
        }
    }
}

/// Validate renderer-supplied files, environment and arguments before any
/// trusted sandbox endpoint rewriting. Shared by local and remote spawns.
pub fn validate_task_endpoints(
    env: &std::collections::HashMap<String, String>,
    args: &[String],
    payload: &serde_json::Value,
    endpoint: &str,
) -> Result<(), String> {
    fn check(value: &serde_json::Value, endpoint: &str) -> Result<(), String> {
        match value {
            serde_json::Value::Object(values) => {
                for (key, value) in values {
                    if ["baseURL", "baseUrl", "base_url"].contains(&key.as_str())
                        && value.as_str() != Some(endpoint)
                    {
                        return Err(
                            "gateway task configuration must use this Host's lease endpoint".into(),
                        );
                    }
                    check(value, endpoint)?;
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    check(value, endpoint)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    for (key, expected) in [
        ("OPENAI_BASE_URL", endpoint),
        ("ANTHROPIC_BASE_URL", endpoint.trim_end_matches("/v1")),
        // Kimi Code's env model, Copilot BYOK and Goose's OpenAI host.
        ("KIMI_MODEL_BASE_URL", endpoint),
        ("COPILOT_PROVIDER_BASE_URL", endpoint),
        ("OPENAI_HOST", endpoint.trim_end_matches("/v1")),
    ] {
        if env.get(key).is_some_and(|value| value != expected) {
            return Err("gateway task endpoint belongs to another Host".into());
        }
    }
    for key in [
        "CODEX_CONFIG",
        "COGNIA_DSH_GATEWAY_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
    ] {
        if let Some(raw) = env.get(key) {
            let value: serde_json::Value =
                serde_json::from_str(raw).map_err(|_| "invalid gateway task configuration")?;
            check(&value, endpoint)?;
        }
    }
    if let Some(files) = payload.get("files").and_then(serde_json::Value::as_object) {
        for (name, raw) in files {
            let raw = raw.as_str().ok_or("invalid gateway task file")?;
            let value: serde_json::Value = if name.ends_with(".toml") {
                toml_edit::de::from_str(raw).map_err(|_| "invalid gateway task TOML")?
            } else {
                serde_json::from_str(raw).map_err(|_| "invalid gateway task JSON")?
            };
            check(&value, endpoint)?;
        }
    }
    for (index, argument) in args.iter().enumerate() {
        // Qwen's `--openai-base-url`, Aider's `--openai-api-base`.
        if (argument == "--openai-base-url" || argument == "--openai-api-base")
            && args.get(index + 1).map(String::as_str) != Some(endpoint)
        {
            return Err("gateway task argument endpoint belongs to another Host".into());
        }
        if argument.starts_with("model_providers.cognia.base_url") {
            let value: serde_json::Value = toml_edit::de::from_str(argument)
                .map_err(|_| "invalid gateway endpoint override")?;
            check(&value, endpoint)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[test]
    fn p6d_task_shape_and_partition_owner_survive_registry_mint() {
        let gateway = GatewayState::new();
        let member = MemberBinding { org_id:"org_p6d_gateway".into(),user_id:"usr_p6d_gateway".into() };
        let provider = serde_json::from_value(serde_json::json!({"id":"p6d-provider","protocol":"openai","enabled":true,
            "apiKey":"p6d-private-org-key","baseUrl":"https://fixture.invalid/v1","models":["model"]})).unwrap();
        let lease = gateway.person_mint_task_lease("pb_p6d",member.clone(),"codex-acp","p6d-task",gateway.status().account_generation,
            provider,"model".into(),"openai-responses").unwrap();
        let ticket = gateway.tickets.validate(&lease.secret,chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(ticket.member,Some(member.clone())); assert_eq!(ticket.owner_account_id.as_deref(),Some("pb_p6d"));
        assert_eq!(ticket.operations,vec![TicketOperation::Responses,TicketOperation::Models,TicketOperation::CountTokens]);
        assert_eq!(ticket.expires_at_ms-ticket.issued_at_ms,TASK_LEASE_TTL_MS);
        assert!(!serde_json::to_string(&lease).unwrap().contains("p6d-private-org-key"));
        assert!(gateway.person_validate_task_secret("pb_foreign",&member,"codex-acp","p6d-task",&lease.secret).is_err());
        gateway.person_test_listener(19384); assert_eq!(gateway.status().bound_port,Some(19384));
        gateway.person_test_listener(0); assert!(!gateway.status().running);
    }

    fn request() -> TaskLeaseRequest {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut value: TaskLeaseRequest = serde_json::from_value(serde_json::json!({
            "taskId": "task-a", "model": "model-a", "ingressProtocol": "openai-chat",
            "provider": {"id":"selected","protocol":"openai","enabled":true,"baseUrl":"https://api.example.com/v1","apiKey":"fake-selected-key"}
        })).unwrap();
        value.upstream_client = Some(reqwest::Client::new());
        value.authority = Some(Arc::new(|| true));
        value
    }
    fn plan() -> TaskModelPlan {
        TaskModelPlan {
            additional_models: vec!["model-b".into()],
            model_bindings: BTreeMap::from([("haiku".into(), "model-b".into())]),
            bindings: BTreeMap::new(), selector_deployments: BTreeMap::new(),
        }
    }

    #[test]
    fn model_plan_validation_rejects_invalid_models_and_bindings() {
        for models in [
            vec![""],
            vec!["model-a"],
            vec!["model-b", "model-b"],
            vec!["bad\n"],
        ] {
            let mut value = plan();
            value.additional_models = models.into_iter().map(str::to_owned).collect();
            assert!(value.validate("model-a").is_err());
        }
        for key in ["", "bad\n", "非ASCII"] {
            let mut value = plan();
            value.model_bindings.insert(key.into(), "model-a".into());
            assert!(value.validate("model-a").is_err());
        }
        let mut value = plan();
        value
            .model_bindings
            .insert("other".into(), "outside".into());
        assert!(value.validate("model-a").is_err());
        let mut value = plan();
        value.additional_models = (0..32).map(|n| format!("m{n}")).collect();
        assert!(value.validate("model-a").is_err());
        let mut value = plan();
        value.additional_models = vec!["x".repeat(257)];
        assert!(value.validate("model-a").is_err());
        let mut value = plan();
        value.model_bindings = (0..65)
            .map(|n| (format!("s{n}"), "model-a".into()))
            .collect();
        assert!(value.validate("model-a").is_err());
        let mut value = plan();
        value
            .model_bindings
            .insert("s".repeat(129), "model-a".into());
        assert!(value.validate("model-a").is_err());
    }

    #[test]
    fn device_plan_freezes_exact_models_and_one_shared_request_budget() {
        let state = GatewayState::new();
        let mut input = request();
        input.model_plan = Some(plan());
        input.budget = Some(TicketBudget {
            max_requests: Some(2),
            ..Default::default()
        });
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let ticket = state
            .tickets
            .validate(&lease.secret, chrono::Utc::now().timestamp_millis())
            .unwrap();
        assert!(ticket.strict_selectors);
        assert_eq!(ticket.candidates.len(), 1);
        for (index, model) in ["model-a", "model-b"].into_iter().enumerate() {
            assert_eq!(ticket.resolve_model(model).as_deref(), Some(model));
            let request_id = format!("plan-{index}");
            state
                .tickets
                .validate_and_reserve(
                    &lease.secret,
                    chrono::Utc::now().timestamp_millis(),
                    TicketOperation::Chat,
                    &request_id,
                    0,
                )
                .unwrap();
            state.tickets.settle_reservation(&request_id, 0);
        }
        assert_eq!(
            state.tickets.validate_and_reserve(
                &lease.secret,
                chrono::Utc::now().timestamp_millis(),
                TicketOperation::Chat,
                "third",
                0
            ),
            Err(TicketReject::BudgetExhausted)
        );
        assert_eq!(
            state.tickets.list()[0]
                .budget
                .as_ref()
                .unwrap()
                .spent_requests,
            2
        );
    }

    #[test]
    fn lease_refuses_binding_outside_plan_before_mint() {
        let state = GatewayState::new();
        let mut input = request();
        let mut value = plan();
        value
            .model_bindings
            .insert("haiku".into(), "outside".into());
        input.model_plan = Some(value);
        assert!(state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input
            )
            .err()
            .unwrap()
            .contains("outside the plan"));
        assert!(state.tickets.list().is_empty());
    }

    #[test]
    fn host_plan_copies_each_models_metadata_and_keeps_one_candidate() {
        let state = host_state("https://api.example.com/v1");
        let mut snapshot = state.with_snapshot(|s| s.unwrap().clone());
        snapshot.providers[0]
            .model_metadata
            .push(crate::snapshot::ModelMetadata {
                id: "model-b".into(),
                fields: BTreeMap::from([("contextLength".into(), serde_json::json!(32000))]),
            });
        state.set_snapshot(snapshot);
        let mut input = host_request("task-plan", None);
        input.model_plan = Some(plan());
        let lease = state
            .mint_host_task_lease(state.status().account_generation, input, None)
            .unwrap();
        assert_eq!(
            lease.model_metadata_by_id["model-a"].fields["contextLength"],
            64000
        );
        assert_eq!(
            lease.model_metadata_by_id["model-b"].fields["contextLength"],
            32000
        );
        let ticket = state.tickets.list().pop().unwrap();
        assert_eq!(ticket.candidates.len(), 1);
        assert_eq!(ticket.resolve_model("model-b").as_deref(), Some("model-b"));
        assert!(!ticket.allow_auth_failover);
    }

    #[test]
    fn plan_limits_exclude_generated_identities_and_defaults() {
        let state = GatewayState::new();
        let mut input = request();
        let primary = input.model.clone();
        let long_id = "m".repeat(256);
        let mut models: Vec<String> = (0..30).map(|n| format!("child-{n}")).collect();
        models.push(long_id.clone());
        input.model_plan = Some(TaskModelPlan {
            additional_models: models,
            model_bindings: (0..64)
                .map(|n| (format!("selector-{n}"), primary.clone()))
                .collect(),
            bindings: BTreeMap::new(), selector_deployments: BTreeMap::new(),
        });
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let ticket = state.tickets.list().pop().unwrap();
        assert_eq!(ticket.ticket_id, lease.ticket_id);
        assert_eq!(ticket.resolve_model(&long_id), Some(long_id));
        assert_eq!(ticket.resolve_model("selector-63"), Some(primary));
    }

    #[test]
    fn host_plan_refuses_model_not_configured() {
        let state = host_state("https://api.example.com/v1");
        let mut input = host_request("task-plan", None);
        input.model_plan = Some(TaskModelPlan {
            additional_models: vec!["not-configured".into()],
            model_bindings: BTreeMap::new(),
            bindings: BTreeMap::new(), selector_deployments: BTreeMap::new(),
        });
        assert!(state
            .mint_host_task_lease(state.status().account_generation, input, None)
            .err()
            .unwrap()
            .contains("not configured"));
        assert!(state.tickets.list().is_empty());
    }

    #[test]
    fn host_roles_freeze_separate_credentials_for_identical_model_ids_and_one_budget() {
        let state = host_state("https://api.example.com/v1");
        let mut sibling = state.snapshot.read().as_ref().unwrap().providers[0].clone();
        sibling.id = "secondary".into(); sibling.api_key = Some("secondary-only-key".into()); sibling.deployment_id = None;
        state.snapshot.write().as_mut().unwrap().providers.push(sibling);
        let mut input = host_request("multi-provider",None);
        input.model_plan = Some(serde_json::from_value(serde_json::json!({"additionalModels":["review"],"modelBindings":{"review":"model-a"},"bindings":{"review":{"providerId":"secondary","modelId":"model-a"}}})).unwrap());
        input.budget = Some(TicketBudget { max_requests:Some(1), ..Default::default() });
        let lease = state.mint_host_task_lease(state.status().account_generation,input,None).unwrap();
        let ticket = state.tickets.validate(&lease.secret,chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(ticket.candidates.len(),2);
        assert_ne!(ticket.selector_deployments["model-a"],ticket.selector_deployments["review"]);
        let overrides = state.tickets.provider_overrides(&ticket.ticket_id);
        assert_eq!(overrides.iter().find(|provider| provider.id == ticket.selector_deployments["review"]).unwrap().api_key.as_deref(),Some("secondary-only-key"));
        state.tickets.validate_and_reserve(&lease.secret,chrono::Utc::now().timestamp_millis(),TicketOperation::Chat,"primary-turn",1).unwrap();
        assert_eq!(state.tickets.reserve_continuation(&ticket.ticket_id,chrono::Utc::now().timestamp_millis(),"review-turn",1),Err(TicketReject::BudgetExhausted));
        for (provider,model) in [("keyless","model-a"),("secondary","missing-model")] {
            let mut input=host_request("denied-secondary",None);
            input.model_plan=Some(serde_json::from_value(serde_json::json!({"additionalModels":["review"],"modelBindings":{"review":model},"bindings":{"review":{"providerId":provider,"modelId":model}}})).unwrap());
            assert!(state.mint_host_task_lease(state.status().account_generation,input,None).is_err());
        }
    }

    #[test]
    fn remote_roles_keep_each_delegated_deployment_and_reject_undelegated_selectors() {
        let state = GatewayState::new();
        let mut input = request();
        input.provider.models = vec!["model-a".into()];
        let mut other = input.provider.clone(); other.id = "secondary".into(); other.api_key = Some("secondary-secret".into());
        input.provider_overrides.push(other);
        input.model_plan = Some(serde_json::from_value(serde_json::json!({"additionalModels":["review"],"modelBindings":{"review":"model-a"},"bindings":{"review":{"providerId":"secondary","modelId":"model-a","accountId":"secondary-account"}},"selectorDeployments":{"model-a":"selected","review":"secondary"}})).unwrap());
        let lease=state.mint_task_lease("owner","device",state.status().account_generation,input).unwrap();
        let ticket=state.tickets.validate(&lease.secret,chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(ticket.candidates.len(),2);
        assert_ne!(ticket.selector_deployments["model-a"],ticket.selector_deployments["review"]);
        assert_eq!(state.tickets.provider_overrides(&ticket.ticket_id).iter().find(|provider| provider.id == ticket.selector_deployments["review"]).unwrap().api_key.as_deref(),Some("secondary-secret"));
        let mut input=request();
        input.model_plan=Some(serde_json::from_value(serde_json::json!({"additionalModels":["review"],"modelBindings":{"review":"model-a"},"bindings":{"review":{"providerId":"secondary","modelId":"model-a"}},"selectorDeployments":{"model-a":"selected","review":"not-delegated"}})).unwrap());
        assert!(state.mint_task_lease("owner","device",state.status().account_generation,input).is_err());
    }

    #[test]
    fn local_task_authority_binds_task_secret_account_generation_and_listener() {
        let state = GatewayState::new();
        state.activate_account("account-a");
        let snapshot:RoutingSnapshot=serde_json::from_value(serde_json::json!({"providers":[{"id":"p","deploymentId":"p","protocol":"openai","baseUrl":"https://example.test/v1","apiKey":"synthetic","enabled":true,"models":["model"]}],"generatedAtMs":1})).unwrap();
        let generation = state.status().account_generation;
        state
            .try_set_account_snapshot(snapshot, Some("account-a"), Some(generation))
            .unwrap();
        let request:MintRequest=serde_json::from_value(serde_json::json!({"sessionId":"local-task","executionFingerprint":"fingerprint","candidates":[],"model":"model","credentialAffinity":"session-sticky","routePolicy":"gateway-required"})).unwrap();
        let ticket = state.mint_route_ticket(request).unwrap();
        state.inner.lock().status.running = true;
        state.inner.lock().status.bound_port = Some(32123);
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_ok());
        for (task, owner, revision, port, secret) in [
            (
                "another-task",
                Some("account-a"),
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-b"),
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                None,
                generation,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation + 1,
                32123,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation,
                32124,
                ticket.secret.as_str(),
            ),
            (
                "local-task",
                Some("account-a"),
                generation,
                32123,
                "wrong-secret",
            ),
        ] {
            assert!(state
                .validate_local_task_secret(task, owner, revision, port, secret)
                .is_err());
        }
        state.inner.lock().status.running = false;
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_err());
        state.inner.lock().status.running = true;
        state.revoke_route_ticket(&ticket.ticket.ticket_id);
        assert!(state
            .validate_local_task_secret(
                "local-task",
                Some("account-a"),
                generation,
                32123,
                &ticket.secret
            )
            .is_err());
    }
    #[test]
    fn local_task_authority_refuses_account_lock_and_aba_generation() {
        let state = GatewayState::new();
        state.activate_account("account-a");
        let initial = state.status().account_generation;
        state.inner.lock().status.running = true;
        state.inner.lock().status.bound_port = Some(32123);
        state.lock_account();
        assert!(state
            .validate_local_task_secret("task", Some("account-a"), initial, 32123, "secret")
            .unwrap_err()
            .contains("account authority"));
        state.activate_account("account-a");
        assert!(state
            .validate_local_task_secret("task", Some("account-a"), initial, 32123, "secret")
            .unwrap_err()
            .contains("account authority"));
    }
    #[test]
    fn shared_task_endpoint_validation_rejects_foreign_env_files_and_arguments() {
        let endpoint = "http://127.0.0.1:32123/v1";
        let mut env =
            std::collections::HashMap::from([("OPENAI_BASE_URL".into(), endpoint.into())]);
        let payload = serde_json::json!({"files":{"codex/config.toml":format!("[model_providers.cognia]\nbase_url = \"{endpoint}\"")}});
        assert!(validate_task_endpoints(&env, &[], &payload, endpoint).is_ok());
        env.insert("OPENAI_BASE_URL".into(), "http://127.0.0.1:1/v1".into());
        assert!(validate_task_endpoints(&env, &[], &payload, endpoint).is_err());
        env.clear();
        assert!(validate_task_endpoints(
            &env,
            &["--openai-base-url".into(), "http://evil.test/v1".into()],
            &payload,
            endpoint
        )
        .is_err());
        assert!(validate_task_endpoints(
            &env,
            &[],
            &serde_json::json!({"files":{"pi/models.json":"{\"baseUrl\":\"http://evil.test\"}"}}),
            endpoint
        )
        .is_err());
        assert!(validate_task_endpoints(
            &env,
            &["--openai-api-base".into(), endpoint.into()],
            &payload,
            endpoint
        )
        .is_ok());
        assert!(validate_task_endpoints(
            &env,
            &["--openai-api-base".into(), "http://evil.test/v1".into()],
            &payload,
            endpoint
        )
        .is_err());
        for (key, own) in [
            ("KIMI_MODEL_BASE_URL", endpoint),
            ("COPILOT_PROVIDER_BASE_URL", endpoint),
            ("OPENAI_HOST", "http://127.0.0.1:32123"),
        ] {
            let mut env = std::collections::HashMap::from([(key.to_string(), own.to_string())]);
            assert!(
                validate_task_endpoints(&env, &[], &payload, endpoint).is_ok(),
                "{key}"
            );
            env.insert(key.into(), "http://evil.test/v1".into());
            assert!(
                validate_task_endpoints(&env, &[], &payload, endpoint).is_err(),
                "{key}"
            );
        }
    }
    #[test]
    fn task_credentials_are_private_and_control_is_device_account_scoped() {
        let state = GatewayState::new();
        let generation = state.status().account_generation;
        let lease = state
            .mint_task_lease("tenant", "device-a", generation, request())
            .unwrap();
        assert!(state.with_snapshot(|value| value.is_none()));
        assert_eq!(state.status().snapshot_provider_count, 0);
        assert!(state
            .validate_task_secret("tenant", "device-a", "task-a", &lease.secret)
            .is_ok());
        assert!(state
            .validate_task_secret("tenant", "device-b", "task-a", &lease.secret)
            .is_err());
        assert!(state
            .control_task_lease(
                "tenant",
                "device-b",
                "task-a",
                &lease.ticket_id,
                generation,
                false
            )
            .is_err());
        assert!(state
            .control_task_lease(
                "tenant",
                "device-a",
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .unwrap());
        state.activate_account("different-host-owner");
        assert!(state
            .control_task_lease(
                "tenant",
                "device-a",
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .is_err());
        assert!(state
            .validate_task_secret("tenant", "device-a", "task-a", &lease.secret)
            .is_err());
    }
    #[test]
    fn task_requires_pinned_upstream_and_cannot_change_model_on_resume() {
        let state = GatewayState::new();
        let generation = state.status().account_generation;
        let mut unpinned = request();
        unpinned.upstream_client = None;
        assert!(state
            .mint_task_lease("tenant", "device-a", generation, unpinned)
            .is_err());
        state
            .mint_task_lease("tenant", "device-a", generation, request())
            .unwrap();
        let mut changed = request();
        changed.model = "model-b".into();
        assert!(state
            .mint_task_lease("tenant", "device-a", generation, changed)
            .is_err());
    }
    #[test]
    fn device_revocation_denies_bearer_requests_renewal_and_stream_liveness() {
        let state = GatewayState::new();
        let live = Arc::new(AtomicBool::new(true));
        let mut input = request();
        let check = Arc::clone(&live);
        input.authority = Some(Arc::new(move || check.load(Ordering::SeqCst)));
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        assert!(state.tickets.validate(&lease.secret, now).is_ok());
        live.store(false, Ordering::SeqCst);
        assert!(matches!(
            state.tickets.validate(&lease.secret, now),
            Err(TicketReject::Revoked)
        ));
        assert!(!state.tickets.is_live(&lease.ticket_id, now));
        assert!(!state
            .tickets
            .renew(&lease.ticket_id, now, TASK_LEASE_TTL_MS));
    }
    fn host_state(base_url: &str) -> GatewayState {
        let state = GatewayState::new();
        state.set_snapshot(
            serde_json::from_value(serde_json::json!({
                "providers": [
                    {"id":"host-openai","deploymentId":"host-openai","protocol":"openai","baseUrl":base_url,
                     "apiKey":"host-only-key","enabled":true,"models":["model-a","model-b"],
                     "modelMetadata":[{"id":"model-a","contextLength":64000,"supportsTools":true}]},
                    {"id":"keyless","protocol":"openai","baseUrl":base_url,"enabled":true,"models":["model-a"]},
                    {"id":"unsupported","protocol":"cohere","baseUrl":base_url,"apiKey":"k","enabled":true,"models":["model-a"]},
                    {"id":"disabled","protocol":"openai","baseUrl":base_url,"apiKey":"k","enabled":false,"models":["model-a"]}
                ],
                "generatedAtMs": 1
            }))
            .unwrap(),
        );
        state
    }
    fn host_request(task: &str, origin: Option<&str>) -> HostTaskLeaseRequest {
        serde_json::from_value(serde_json::json!({
            "taskId": task, "providerId": "host-openai", "model": "model-a",
            "ingressProtocol": "openai-chat", "originDeviceId": origin,
        }))
        .unwrap()
    }
    #[test]
    fn host_task_lease_carries_a_requested_ceiling_with_zeroed_spend() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let request: HostTaskLeaseRequest = serde_json::from_value(serde_json::json!({
            "taskId": "task-budget", "providerId": "host-openai", "model": "model-a",
            "ingressProtocol": "openai-chat",
            "budget": {"maxTokens": 5000, "spentTokens": 4999, "maxRequests": 7}
        }))
        .unwrap();
        let lease = state
            .mint_host_task_lease(generation, request, None)
            .unwrap();
        let ticket = state
            .list_route_tickets()
            .into_iter()
            .find(|ticket| ticket.ticket_id == lease.ticket_id)
            .unwrap();
        let budget = ticket.budget.expect("ceiling recorded");
        assert_eq!(budget.max_tokens, Some(5000));
        assert_eq!(budget.max_requests, Some(7));
        // A caller cannot pre-load spend; the registry owns the counters.
        assert_eq!(budget.spent_tokens, 0);
    }

    #[test]
    fn host_bridge_alias_can_serve_search_and_vision_once() {
        let state=host_state("https://api.example.com/v1");
        state.with_snapshot(|snapshot|assert!(snapshot.is_some()));
        let mut snapshot=state.snapshot.read().clone().unwrap();
        snapshot.aliases=serde_json::from_value(serde_json::json!([{"alias":"helper","entries":[{"providerId":"host-openai","modelId":"model-b"}]}])).unwrap();
        state.set_snapshot(snapshot);
        { let mut config=state.config.write();config.bridge_models.search=Some("helper".into());config.bridge_models.vision=Some("helper".into()); }
        let lease=state.mint_host_task_lease(state.status().account_generation,host_request("shared-helper",None),None).unwrap();
        let ticket=state.tickets.validate(&lease.secret,chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(ticket.resolve_model("helper").as_deref(),Some("model-b"));
        assert!(ticket.selector_deployments.contains_key("helper"));
    }

    #[test]
    fn host_task_lease_without_a_ceiling_stays_unmetered() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let lease = state
            .mint_host_task_lease(generation, host_request("task-free", None), None)
            .unwrap();
        let ticket = state
            .list_route_tickets()
            .into_iter()
            .find(|ticket| ticket.ticket_id == lease.ticket_id)
            .unwrap();
        assert!(ticket.budget.is_none());
    }

    #[test]
    fn host_task_lease_copies_one_host_provider_into_a_private_scoped_ticket() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let lease = state
            .mint_host_task_lease(generation, host_request("task-a", Some("phone-a")), None)
            .unwrap();
        // The shared snapshot is untouched; the task deployment is ticket-private.
        assert!(state.with_snapshot(|snapshot| snapshot
            .unwrap()
            .providers
            .iter()
            .all(|provider| !provider.id.starts_with("host-task-"))));
        let ticket = state
            .list_route_tickets()
            .into_iter()
            .find(|ticket| ticket.ticket_id == lease.ticket_id)
            .unwrap();
        assert_eq!(ticket.route_policy, "gateway-required");
        assert!(!ticket.allow_auth_failover);
        assert_eq!(
            ticket.candidates,
            vec![TicketCandidate {
                deployment_id: "host-task-task-a".into(),
                model_id: "model-a".into()
            }]
        );
        assert_eq!(
            ticket.operations,
            vec![
                TicketOperation::Chat,
                TicketOperation::Models,
                TicketOperation::CountTokens
            ]
        );
        assert!(ticket
            .model_bindings
            .values()
            .all(|model| model == "model-a"));
        assert!(lease.expires_at_ms - chrono::Utc::now().timestamp_millis() <= TASK_LEASE_TTL_MS);
        assert_eq!(
            lease.model_metadata.as_ref().unwrap().fields["contextLength"],
            64000
        );
        // The wire shape never names the credential.
        let wire = serde_json::to_string(&lease).unwrap();
        assert!(!wire.contains("host-only-key"));

        assert!(state
            .validate_host_task_secret(Some("phone-a"), "task-a", &lease.secret)
            .is_ok());
        for (origin, task, secret) in [
            (Some("phone-b"), "task-a", lease.secret.as_str()),
            (None, "task-a", lease.secret.as_str()),
            (Some("phone-a"), "task-b", lease.secret.as_str()),
            (Some("phone-a"), "task-a", "sk-cognia-rt-wrong"),
        ] {
            assert!(state
                .validate_host_task_secret(origin, task, secret)
                .is_err());
        }
        assert!(state
            .control_host_task_lease(
                Some("phone-b"),
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .is_err());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation + 1,
                true
            )
            .is_err());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation,
                true
            )
            .unwrap());
        assert!(state
            .control_host_task_lease(
                Some("phone-a"),
                "task-a",
                &lease.ticket_id,
                generation,
                false
            )
            .unwrap());
        assert!(state
            .validate_host_task_secret(Some("phone-a"), "task-a", &lease.secret)
            .is_err());
    }
    #[test]
    fn host_task_lease_refuses_what_the_host_cannot_serve() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let mint = |provider: &str, model: &str, ingress: &str| {
            state.mint_host_task_lease(
                generation,
                serde_json::from_value(serde_json::json!({
                    "taskId": "task", "providerId": provider, "model": model,
                    "ingressProtocol": ingress,
                }))
                .unwrap(),
                None,
            )
        };
        assert!(mint("host-openai", "model-a", "openai-chat").is_ok());
        assert!(mint("host-openai", "model-b", "openai-responses").is_ok());
        for (provider, model, ingress) in [
            ("missing", "model-a", "openai-chat"),
            ("host-openai", "model-z", "openai-chat"),
            ("keyless", "model-a", "openai-chat"),
            ("unsupported", "model-a", "openai-chat"),
            ("disabled", "model-a", "openai-chat"),
            ("host-openai", "model-a", "gemini"),
            ("host-openai", " ", "openai-chat"),
        ] {
            assert!(
                mint(provider, model, ingress).is_err(),
                "{provider} {model} {ingress}"
            );
        }
        // A caller cannot smuggle a provider or a credential in.
        assert!(
            serde_json::from_value::<HostTaskLeaseRequest>(serde_json::json!({
                "taskId": "task", "providerId": "host-openai", "model": "model-a",
                "ingressProtocol": "openai-chat", "provider": {"apiKey": "x"}
            }))
            .is_err()
        );
        assert!(state
            .mint_host_task_lease(generation + 1, host_request("task", None), None)
            .is_err());
        assert!(state
            .mint_host_task_lease(generation, host_request("../task", None), None)
            .is_err());
        assert!(state
            .mint_host_task_lease(
                generation,
                host_request("task", None),
                Some(Arc::new(|| false))
            )
            .is_err());
    }
    #[test]
    fn a_host_task_holds_one_live_lease_and_follows_device_revocation() {
        let state = host_state("https://api.example.com/v1");
        let generation = state.status().account_generation;
        let first = state
            .mint_host_task_lease(generation, host_request("task", Some("phone")), None)
            .unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let check = Arc::clone(&live);
        let second = state
            .mint_host_task_lease(
                generation,
                host_request("task", Some("phone")),
                Some(Arc::new(move || check.load(Ordering::SeqCst))),
            )
            .unwrap();
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &first.secret)
            .is_err());
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &second.secret)
            .is_ok());
        live.store(false, Ordering::SeqCst);
        assert!(state
            .validate_host_task_secret(Some("phone"), "task", &second.secret)
            .is_err());
    }
    /// The whole Host path over real sockets: a stub upstream, the task-only
    /// listener, and a request carrying nothing but the lease secret.
    #[tokio::test]
    async fn host_task_lease_reaches_the_host_provider_through_the_task_listener() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let seen = Arc::new(parking_lot::Mutex::new(
            Vec::<(String, serde_json::Value)>::new(),
        ));
        let record = Arc::clone(&seen);
        let upstream = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(
                move |headers: axum::http::HeaderMap,
                      axum::Json(body): axum::Json<serde_json::Value>| {
                    let record = Arc::clone(&record);
                    async move {
                        record.lock().push((
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or_default()
                                .to_string(),
                            body,
                        ));
                        axum::Json(serde_json::json!({
                            "id": "chatcmpl-stub", "object": "chat.completion", "created": 1,
                            "model": "model-a",
                            "choices": [{"index": 0, "finish_reason": "stop",
                                "message": {"role": "assistant", "content": "stub reply"}}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
                        }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });
        let state = host_state(&format!("http://{upstream_addr}/v1"));
        state.keys.write().clear();
        state.config.write().port = 0;
        let lease = state
            .mint_host_task_lease(
                state.status().account_generation,
                host_request("task-e2e", Some("phone")),
                None,
            )
            .unwrap();
        let host = Arc::new(crate::host::NoopGatewayHost);
        state.start_for_task(host, &lease.ticket_id).await.unwrap();
        let base = format!("http://127.0.0.1:{}/v1", state.status().bound_port.unwrap());
        let client = reqwest::Client::new();
        let reply: serde_json::Value = client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&lease.secret)
            .json(&serde_json::json!({
                "model": "model-a",
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["choices"][0]["message"]["content"], "stub reply");
        {
            let seen = seen.lock();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].0, "Bearer host-only-key");
            assert_eq!(seen[0].1["model"], "model-a");
        }
        // Embeddings are outside the ticket's operations.
        assert_ne!(
            client
                .post(format!("{base}/embeddings"))
                .bearer_auth(&lease.secret)
                .json(&serde_json::json!({"model": "model-a", "input": "x"}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        state.stop().unwrap();
    }
    #[tokio::test]
    async fn private_and_ambiguous_upstreams_are_refused_before_mint() {
        for url in [
            "http://public.example/v1",
            "https://127.0.0.1/v1",
            "https://10.0.0.1/v1",
            "https://[::1]/v1",
            "https://service.local/v1",
            "https://user:password@api.example.com/v1",
        ] {
            assert!(validate_public_upstream(url).await.is_err(), "{url}");
        }
    }
    #[tokio::test]
    async fn task_only_listener_uses_private_snapshot_and_rejects_revoked_device() {
        let state = GatewayState::new();
        state.keys.write().clear();
        state.config.write().port = 0;
        let live = Arc::new(AtomicBool::new(true));
        let check = Arc::clone(&live);
        let mut input = request();
        input.authority = Some(Arc::new(move || check.load(Ordering::SeqCst)));
        let lease = state
            .mint_task_lease(
                "tenant",
                "device-a",
                state.status().account_generation,
                input,
            )
            .unwrap();
        let host = Arc::new(crate::host::NoopGatewayHost);
        assert!(state.start(host.clone()).await.is_err());
        state.start_for_task(host, &lease.ticket_id).await.unwrap();
        let endpoint = format!(
            "http://127.0.0.1:{}/v1/models",
            state.status().bound_port.unwrap()
        );
        let client = reqwest::Client::new();
        assert_eq!(client.get(&endpoint).send().await.unwrap().status(), 401);
        let response = client
            .get(&endpoint)
            .bearer_auth(&lease.secret)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(body["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "model-a"));
        live.store(false, Ordering::SeqCst);
        assert_eq!(
            client
                .get(&endpoint)
                .bearer_auth(&lease.secret)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        state.stop().unwrap();
    }
}
