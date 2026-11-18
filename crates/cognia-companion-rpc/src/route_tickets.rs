//! Gateway route tickets for the desktop CLI bridge (ADR-0163).
//!
//! `cognia-agent x` launches an agent against the desktop's LLM gateway, and
//! the gateway accepts a session-scoped route ticket, never an upstream
//! provider key. The bridge's `/api/dev/gateway/route-ticket` route mints one
//! here, and the gateway management plane (`rpc/gateway_plane.rs`) shares the
//! same mint.
//!
//! Provider management is not on the bridge: `cognia-agent provider` asks the
//! Host it selected over the Companion API, like every other Host command.

use axum::http::StatusCode;
use cognia_gateway::route_ticket::{
    MintRequest, MintedTicket, TicketAffinity, TicketBudget, TicketOperation,
};
use cognia_gateway::GatewayState;
use serde::Deserialize;
use serde_json::{json, Value};

// ---- route tickets -----------------------------------------------------------------

/// `POST /api/dev/gateway/route-ticket` body. Candidates and bindings are
/// derived Rust-side from `model` (`route_planner::candidates_for_model` and
/// `default_model_bindings`), so the CLI only names the model it wants.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTicketRequest {
    pub model: String,
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub execution_fingerprint: String,
    pub route_policy: String,
    #[serde(default)]
    pub ttl_ms: Option<i64>,
    #[serde(default)]
    pub operations: Option<Vec<TicketOperation>>,
    #[serde(default)]
    pub budget: Option<TicketBudget>,
}

/// Mint against the desktop gateway's CURRENT snapshot. Not gated on the
/// renderer's `gatewayAgentRouteTickets` execution-spec flag: that flag
/// describes the renderer's own send path, and the CLI may have no renderer
/// at all. Gating here would silently reproduce the 401 this leg exists to
/// fix.
pub fn mint_bridge_ticket(
    gateway: &GatewayState,
    request: BridgeTicketRequest,
) -> Result<MintedTicket, (StatusCode, String)> {
    let candidates = match gateway.ticket_candidates_for_model(&request.model) {
        Ok(candidates) => candidates,
        Err(_) => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway has no routing snapshot yet — open the Cognia window once so it can publish providers".to_string(),
            ));
        }
    };
    if candidates.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "model \"{}\" matches no alias, provider:model, or enabled provider model",
                request.model
            ),
        ));
    }
    // More than one candidate means failover is possible, so the ticket must
    // permit moving off the first credential. Same rule as the renderer's
    // `mintSessionRouteTicket`.
    let failover = candidates.len() > 1;
    let mint = MintRequest {
        provider_overrides: Vec::new(),
        session_id: request.session_id,
        parent_session_id: request.parent_session_id,
        execution_fingerprint: request.execution_fingerprint,
        candidates,
        model_bindings: Default::default(),
        selector_deployments: Default::default(),
        strict_selectors: false,
        credential_affinity: if failover {
            TicketAffinity::StickyWithFailover
        } else {
            TicketAffinity::SessionSticky
        },
        allow_auth_failover: failover,
        route_policy: request.route_policy,
        ttl_ms: request.ttl_ms,
        model: Some(request.model),
        operations: request.operations,
        budget: request.budget,
    };
    gateway.mint_route_ticket(mint).map_err(|error| {
        let status = match error {
            cognia_gateway::route_ticket::TicketError::WidenedRemint { .. } => StatusCode::CONFLICT,
            cognia_gateway::route_ticket::TicketError::NoSnapshot => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            _ => StatusCode::BAD_REQUEST,
        };
        (status, error.to_string())
    })
}

/// The wire shape the CLI consumes. The secret appears ONCE.
pub fn bridge_ticket_payload(minted: &MintedTicket, gateway_port: u16) -> Value {
    json!({
        "ok": true,
        "endpoint": format!("http://127.0.0.1:{gateway_port}/v1"),
        "ticket": minted.ticket,
        "secret": minted.secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket_request(model: &str) -> BridgeTicketRequest {
        serde_json::from_value(json!({
            "model": model,
            "sessionId": "s-bridge",
            "executionFingerprint": "aexf1-bridge",
            "routePolicy": "gateway-required",
        }))
        .unwrap()
    }

    #[test]
    fn gateway_route_ticket_without_snapshot_is_503() {
        let gateway = GatewayState::new();
        let (status, message) =
            mint_bridge_ticket(&gateway, ticket_request("glm-4.6")).unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(message.contains("no routing snapshot"), "{message}");
    }

    #[test]
    fn gateway_route_ticket_derives_candidates_and_family_bindings() {
        let gateway = GatewayState::new();
        let snapshot: cognia_gateway::snapshot::RoutingSnapshot = serde_json::from_value(json!({
            "aliases": [],
            "providers": [{
                "id": "dep-a", "protocol": "anthropic", "baseUrl": "http://127.0.0.1:1/v1",
                "apiKey": "sk-up", "enabled": true,
                "models": ["claude-opus-5", "claude-haiku-4-5-20251001"],
                "deploymentId": "dep-a"
            }],
            "generatedAtMs": 1, "profileVersion": 1, "authority": "renderer"
        }))
        .unwrap();
        gateway.try_set_snapshot(snapshot).unwrap();

        let unknown = mint_bridge_ticket(&gateway, ticket_request("gpt-nope")).unwrap_err();
        assert_eq!(unknown.0, StatusCode::NOT_FOUND);

        let minted = mint_bridge_ticket(&gateway, ticket_request("claude-opus-5")).unwrap();
        assert_eq!(minted.ticket.candidates.len(), 1);
        assert_eq!(
            minted.ticket.resolve_model("haiku").as_deref(),
            Some("claude-haiku-4-5-20251001")
        );
        assert_eq!(minted.ticket.resolve_model("ungranted-model"), None);
        assert_eq!(
            minted.ticket.model_bindings["haiku"],
            "claude-haiku-4-5-20251001"
        );
        assert_eq!(
            minted.ticket.credential_affinity,
            TicketAffinity::SessionSticky
        );
        assert!(!minted.ticket.allow_auth_failover);
        assert_eq!(
            minted.ticket.operations,
            cognia_gateway::route_ticket::default_ticket_operations()
        );

        let payload = bridge_ticket_payload(&minted, 47823);
        assert_eq!(payload["endpoint"], "http://127.0.0.1:47823/v1");
        assert_eq!(payload["secret"], minted.secret);
        assert_eq!(payload["ticket"]["ticketId"], minted.ticket.ticket_id);
    }
}
