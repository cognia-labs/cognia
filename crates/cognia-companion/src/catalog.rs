//! Runtime discovery of the command contract (ADR-0175).
//!
//! `GET /api/catalog` (device plane) and `GET /internal/catalog` (service
//! plane) list the commands the caller may dispatch, as the contract describes
//! them. Devices used to ship all 1,325 descriptors and guess. The device list
//! is filtered with the same predicate dispatch uses
//! (`remote_execution::command_admitted`), so the catalog can never advertise
//! what dispatch would refuse, and a command a device cannot find here is one
//! it would be refused.
//!
//! The strong ETag is the catalog hash. On the device plane it is suffixed
//! with a fingerprint of the admitted set, because two devices with different
//! grants see different lists under the same contract, and a grant change must
//! never answer 304 with a stale list.
//!
//! A device reached only through its relay room reads the same document as
//! `catalog-get` control frames (`signaling::dispatch`), filtered for the
//! WebRTC transport and cut into pages ([`relay_catalog_page`]): the relay
//! carries at most one MiB per message, and the whole document is larger.

// Handlers here answer failures as `cognia_problem::Problem`, the one RFC 9457
// document every companion plane returns (ADR-0175), by value, the way
// `remote_execution` does. Boxing it would change every signature on the
// plane for an allocation on the error path only.
#![allow(clippy::result_large_err)]

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use cognia_problem::Problem;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::command_manifest::{self, CommandDescriptor, CATALOG_HASH, CONTRACT_VERSION};
use super::middleware::DeviceContext;
use super::remote_execution::{command_admitted, ExecutionTransport};

/// The document both planes answer with. Mirrors `CommandCatalog` in the
/// generated specifications.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub contract_version: u32,
    pub catalog_hash: &'static str,
    pub plane: &'static str,
    pub commands: Vec<&'static CommandDescriptor>,
    pub schemas: serde_json::Value,
}

/// `GET /api/catalog`. Authenticated by `require_device_access`, like `whoami`.
pub(crate) async fn device_catalog_handler(
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
) -> Response {
    respond(
        &headers,
        "device",
        admitted_commands(&context, ExecutionTransport::Http),
    )
}

/// `GET /internal/catalog`. Authenticated by `require_service_jwt`.
pub(crate) async fn internal_catalog_handler(
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
) -> Response {
    respond(
        &headers,
        "service",
        admitted_commands(&context, ExecutionTransport::Internal),
    )
}

/// The remote commands this principal may dispatch over `transport`, in
/// contract order. One request id covers the whole walk so a store failure
/// mid-list answers as one problem.
pub(super) fn admitted_commands(
    principal: &DeviceContext,
    transport: ExecutionTransport,
) -> Result<Vec<&'static CommandDescriptor>, Problem> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut commands = Vec::new();
    for name in command_manifest::remote_command_names() {
        let descriptor = command_manifest::descriptor(name)
            .expect("remote command names resolve to descriptors");
        if command_admitted(principal, transport, descriptor, &request_id)? {
            commands.push(descriptor);
        }
    }
    Ok(commands)
}

/// The strong validator for one answer.
fn etag(plane: &str, commands: &[&CommandDescriptor]) -> String {
    if crate::jwt::is_service_scope(Some(plane.as_ref())) {
        return format!("\"{CATALOG_HASH}\"");
    }
    let mut digest = Sha256::new();
    for command in commands {
        digest.update(command.name.as_bytes());
        digest.update(b"\n");
    }
    let fingerprint = hex::encode(digest.finalize());
    format!("\"{CATALOG_HASH}.{}\"", &fingerprint[..16])
}

/// The validators an `If-None-Match` header presents. Weak markers are
/// stripped: the catalog is byte-for-byte a function of the tag, so a weak
/// match is as good as a strong one here.
fn presented_etags(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.strip_prefix("W/").unwrap_or(tag).to_string())
        .collect()
}

/// The control method a `catalog-get` frame names. Not a command: an older
/// Host dispatches it as one and answers `unknown_command`, which is how a
/// client tells that Host apart.
pub const RELAY_CATALOG_METHOD: &str = "host.catalog.get";

/// Bytes one relay catalog page may carry. Well under the framing's one MiB
/// message limit, so a page never fails to send for its size.
pub const RELAY_CATALOG_PAGE_BYTES: usize = 384 * 1024;

/// One page of the catalog read over the relay. The pages together are the
/// `GET /api/catalog` document for the WebRTC transport: same commands in the
/// same order, same schemas. `etag` is the admitted-set tag; a client that
/// sees it change between pages started reading a different list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCatalogPage {
    pub contract_version: u32,
    pub catalog_hash: &'static str,
    pub plane: &'static str,
    pub etag: String,
    pub commands: Vec<&'static CommandDescriptor>,
    pub schemas: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<usize>,
}

/// Answer one `catalog-get` frame: `params.cursor` (default 0) is the index
/// of the first command, and the page ends before the command that would
/// take it past [`RELAY_CATALOG_PAGE_BYTES`] (one command at least).
pub(crate) fn relay_catalog_page(
    principal: &DeviceContext,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Problem> {
    if method != RELAY_CATALOG_METHOD {
        return Err(Problem::new(
            400,
            "invalid_catalog_request",
            "catalog-get names the host.catalog.get method",
        ));
    }
    let cursor = match params.get("cursor") {
        None | Some(serde_json::Value::Null) => 0,
        Some(value) => value
            .as_u64()
            .and_then(|cursor| usize::try_from(cursor).ok())
            .ok_or_else(|| {
                Problem::new(400, "invalid_catalog_request", "cursor is a command index")
            })?,
    };
    let commands = admitted_commands(principal, ExecutionTransport::WebRtc)?;
    if cursor > commands.len() {
        return Err(Problem::new(
            400,
            "invalid_catalog_request",
            "cursor is past the end of the catalog",
        ));
    }
    let tag = etag("device", &commands);
    let schemas = discovery_schemas(&commands[cursor..], "device")?;
    let mut page = Vec::new();
    let mut page_schemas = serde_json::Map::new();
    let mut bytes = 0usize;
    for command in &commands[cursor..] {
        let schema = schemas
            .get(command.name.as_str())
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let size = serde_json::to_vec(command).map(|v| v.len()).unwrap_or(0)
            + serde_json::to_vec(&schema).map(|v| v.len()).unwrap_or(0)
            + command.name.len()
            + 8;
        if !page.is_empty() && bytes + size > RELAY_CATALOG_PAGE_BYTES {
            break;
        }
        bytes += size;
        page.push(*command);
        if !schema.is_null() {
            page_schemas.insert(command.name.to_string(), schema);
        }
    }
    let end = cursor + page.len();
    let document = RelayCatalogPage {
        contract_version: CONTRACT_VERSION,
        catalog_hash: CATALOG_HASH,
        plane: "device",
        etag: tag,
        commands: page,
        schemas: serde_json::Value::Object(page_schemas),
        next_cursor: (end < commands.len()).then_some(end),
    };
    serde_json::to_value(document)
        .map_err(|_| Problem::new(500, "catalog_unavailable", "catalog page did not serialize"))
}

fn discovery_schemas(commands: &[&CommandDescriptor], plane: &str) -> Result<serde_json::Value, Problem> {
    use serde_json::{json, Value};
    let catalog: Value = serde_json::from_slice(cognia_headless_contract::EMBEDDED_CATALOG_BYTES)
        .map_err(|_| Problem::new(500, "catalog_unavailable", "host contract is unavailable"))?;
    let overrides: Value = serde_json::from_slice(cognia_headless_contract::EMBEDDED_DEVICE_PLANE_OVERRIDES_BYTES)
        .map_err(|_| Problem::new(500, "catalog_unavailable", "device contract is unavailable"))?;
    let wanted: std::collections::HashSet<&str> = commands.iter().map(|command| command.name.as_str()).collect();
    let mut schemas = serde_json::Map::new();
    for command in catalog.get("commands").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = command.get("name").and_then(Value::as_str).filter(|name| wanted.contains(name)) else { continue; };
        let input = if plane == "device" { overrides.get("commands").and_then(|all| all.get(name)).and_then(|row| row.get("inputSchema")).unwrap_or(&command["inputSchema"]) } else { &command["inputSchema"] };
        schemas.insert(name.to_string(), json!({"input":input,"output":command["outputSchema"]}));
    }
    Ok(Value::Object(schemas))
}

fn respond(
    headers: &HeaderMap,
    plane: &'static str,
    commands: Result<Vec<&'static CommandDescriptor>, Problem>,
) -> Response {
    let commands = match commands {
        Ok(commands) => commands,
        Err(problem) => return problem.into_response(),
    };
    let tag = etag(plane, &commands);
    let cache_headers = [
        (header::ETAG, tag.clone()),
        (header::CACHE_CONTROL, "private, no-cache".to_string()),
        (
            header::VARY,
            format!("authorization, {}", header::IF_NONE_MATCH),
        ),
    ];
    if presented_etags(headers)
        .iter()
        .any(|presented| presented == &tag || presented == "*")
    {
        return (StatusCode::NOT_MODIFIED, cache_headers).into_response();
    }
    let schemas = match discovery_schemas(&commands, plane) {
        Ok(schemas) => schemas,
        Err(problem) => return problem.into_response(),
    };
    let document = CommandCatalog {
        contract_version: CONTRACT_VERSION,
        catalog_hash: CATALOG_HASH,
        plane,
        commands,
        schemas,
    };
    (StatusCode::OK, cache_headers, Json(document)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_manifest::{CommandTarget, CommandTransport};
    use axum::http::HeaderValue;
    use serde_json::Value;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn principal(scope: &str, capabilities: Option<Vec<&str>>) -> DeviceContext {
        DeviceContext {
            device_id: "device-a".to_string(),
            tenant_id: ACCOUNT_ID.to_string(),
            scope: scope.to_string(),
            granted_scopes: Vec::new(),
            authorization_capabilities: capabilities
                .map(|list| list.into_iter().map(str::to_owned).collect()),
        }
    }

    fn test_state() -> crate::SharedState {
        use crate::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
        };
        std::sync::Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(SECRET.to_vec()),
            deny_list: std::sync::Arc::new(DenyList::new()),
            renderer: None,
            runtime: crate::runtime::unwired(),
            idempotency: std::sync::Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: crate::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: crate::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::push::PushTokenRegistry::new(),
        })
    }

    async fn get(
        router: &axum::Router,
        path: &str,
        bearer: Option<&str>,
        if_none_match: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = axum::http::Request::builder().method("GET").uri(path);
        if let Some(bearer) = bearer {
            builder = builder.header("authorization", format!("Bearer {bearer}"));
        }
        if let Some(tag) = if_none_match {
            builder = builder.header("if-none-match", tag);
        }
        let mut request = builder.body(axum::body::Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                34567,
            ))));
        router.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The service principal on the internal transport is the whole remote
    /// set, in contract order. This is the list the Brain validates against.
    #[test]
    fn service_principal_sees_every_remote_command_in_contract_order() {
        let commands = admitted_commands(&principal("service", None), ExecutionTransport::Internal)
            .expect("no store is consulted for the service principal");
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, command_manifest::remote_command_names());
    }

    /// A device sees only what dispatch would admit for it: execution and
    /// host-admin targets with the HTTP transport, and only those whose
    /// capability its authorization snapshot grants. Service-target commands
    /// never appear, and neither does a granted command on a transport the
    /// contract does not list.
    #[test]
    fn device_catalog_equals_what_dispatch_admits() {
        let granted = ["sessions.read", "host.observe"];
        let device = principal("device", Some(granted.to_vec()));
        let commands = admitted_commands(&device, ExecutionTransport::Http)
            .expect("an authorization snapshot needs no store");
        assert!(!commands.is_empty());
        for command in &commands {
            assert!(
                matches!(
                    command.target,
                    CommandTarget::Execution | CommandTarget::HostAdmin
                ),
                "{} target",
                command.name
            );
            assert!(
                command.transports.contains(&CommandTransport::Http),
                "{} transport",
                command.name
            );
            assert!(
                granted.contains(&command.capability.as_str()),
                "{} capability {}",
                command.name,
                command.capability
            );
        }
        let expected = command_manifest::commands()
            .iter()
            .filter(|c| {
                matches!(
                    c.target,
                    CommandTarget::Execution | CommandTarget::HostAdmin
                )
            })
            .filter(|c| c.transports.contains(&CommandTransport::Http))
            .filter(|c| granted.contains(&c.capability.as_str()))
            .count();
        assert_eq!(commands.len(), expected);

        // No grants, no commands. The predicate is the dispatch predicate, so
        // an empty snapshot is authoritative rather than a fallback to the store.
        let none = admitted_commands(
            &principal("device", Some(Vec::new())),
            ExecutionTransport::Http,
        )
        .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn etag_is_the_catalog_hash_and_the_device_suffix_tracks_the_admitted_set() {
        assert_eq!(etag("service", &[]), format!("\"{CATALOG_HASH}\""));
        let all =
            admitted_commands(&principal("service", None), ExecutionTransport::Internal).unwrap();
        let some = &all[..all.len() / 2];
        let full = etag("device", &all);
        let half = etag("device", some);
        assert!(full.starts_with(&format!("\"{CATALOG_HASH}.")));
        assert_ne!(full, half);
        assert_eq!(etag("device", &all), full, "deterministic");
    }

    /// The relay pages, read in turn, are the WebRTC catalog: every admitted
    /// command once, in order, with its schema, under one tag, and every page
    /// small enough for the relay's one MiB message limit.
    #[test]
    fn relay_catalog_pages_reassemble_the_webrtc_catalog() {
        let granted = ["sessions.read", "host.observe", "workspace.write", "sessions.write"];
        let device = principal("device", Some(granted.to_vec()));
        let expected = admitted_commands(&device, ExecutionTransport::WebRtc).unwrap();
        assert!(!expected.is_empty());
        let mut names = Vec::new();
        let mut tags = std::collections::HashSet::new();
        let mut cursor: Option<u64> = Some(0);
        let mut pages = 0;
        while let Some(at) = cursor {
            let page =
                relay_catalog_page(&device, RELAY_CATALOG_METHOD, &serde_json::json!({ "cursor": at }))
                    .unwrap();
            pages += 1;
            assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
            assert_eq!(page["contractVersion"], CONTRACT_VERSION);
            assert_eq!(page["catalogHash"], CATALOG_HASH);
            assert_eq!(page["plane"], "device");
            tags.insert(page["etag"].as_str().unwrap().to_string());
            for command in page["commands"].as_array().unwrap() {
                let name = command["name"].as_str().unwrap().to_string();
                assert!(page["schemas"].get(&name).is_some(), "{name} has its schemas");
                names.push(name);
            }
            cursor = page["nextCursor"].as_u64();
        }
        let wanted: Vec<String> = expected.iter().map(|c| c.name.to_string()).collect();
        assert_eq!(names, wanted);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags.into_iter().next().unwrap(), etag("device", &expected));

        // A device with every capability needs several pages.
        let all = principal(
            "device",
            Some(
                command_manifest::commands()
                    .iter()
                    .map(|c| c.capability.as_str())
                    .collect(),
            ),
        );
        let first =
            relay_catalog_page(&all, RELAY_CATALOG_METHOD, &serde_json::json!({})).unwrap();
        assert!(first["nextCursor"].as_u64().is_some(), "the full catalog spans pages");
        assert!(pages >= 1);
    }

    #[test]
    fn relay_catalog_page_refuses_a_bad_method_or_cursor() {
        let device = principal("device", Some(vec!["host.observe"]));
        for (method, params) in [
            ("host.operation.get", serde_json::json!({})),
            (RELAY_CATALOG_METHOD, serde_json::json!({ "cursor": "one" })),
            (RELAY_CATALOG_METHOD, serde_json::json!({ "cursor": 1_000_000 })),
        ] {
            let problem = relay_catalog_page(&device, method, &params).unwrap_err();
            assert_eq!(problem.code, "invalid_catalog_request", "{method} {params}");
        }
        let empty = relay_catalog_page(
            &principal("device", Some(Vec::new())),
            RELAY_CATALOG_METHOD,
            &serde_json::json!({ "cursor": 0 }),
        )
        .unwrap();
        assert_eq!(empty["commands"], serde_json::json!([]));
        assert!(empty.get("nextCursor").is_none());
    }

    #[test]
    fn presented_etags_split_lists_and_strip_weak_markers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("W/\"a\", \"b\" ,, *"),
        );
        assert_eq!(presented_etags(&headers), vec!["\"a\"", "\"b\"", "*"]);
        assert!(presented_etags(&HeaderMap::new()).is_empty());
    }

    /// The assembled router: a service token gets the whole catalog with the
    /// catalog hash as a strong ETag, sending it back answers 304 with no body,
    /// a missing bearer is a problem document, and the device route is
    /// mounted behind device authentication.
    #[tokio::test]
    async fn internal_catalog_roundtrips_its_etag_and_refuses_without_a_token() {
        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        crate::runtime::test_support::clear_headless();
        let router = crate::server::build_router(test_state());
        let (service, _) = crate::jwt::issue_service_jwt(SECRET, ACCOUNT_ID).expect("service jwt");

        let response = get(&router, "/internal/catalog", Some(&service), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let tag = response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .expect("etag");
        assert_eq!(tag, format!("\"{CATALOG_HASH}\""));
        let document = body_json(response).await;
        assert_eq!(document["contractVersion"], CONTRACT_VERSION);
        assert_eq!(document["catalogHash"], CATALOG_HASH);
        assert_eq!(document["plane"], "service");
        let commands = document["commands"].as_array().expect("commands");
        assert_eq!(
            commands.len(),
            command_manifest::remote_command_names().len()
        );
        assert_eq!(
            commands[0]["name"],
            command_manifest::remote_command_names()[0]
        );
        // The descriptor is serialized as the contract wrote it.
        for field in [
            "resource",
            "verb",
            "arm",
            "target",
            "operation",
            "capability",
            "risk",
            "approval",
            "idempotency",
            "transports",
            "pagination",
            "longRunning",
            "inputSchema",
            "outputSchema",
        ] {
            assert!(commands[0].get(field).is_some(), "descriptor field {field}");
        }

        let response = get(&router, "/internal/catalog", Some(&service), Some(&tag)).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response
                .headers()
                .get(header::ETAG)
                .unwrap()
                .to_str()
                .unwrap(),
            tag
        );
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(bytes.is_empty(), "304 carries no body");

        let response = get(&router, "/internal/catalog", None, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE)
        );

        let response = get(&router, "/api/catalog", None, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE)
        );
    }

    #[test]
    fn discovery_schema_is_filtered_and_plane_specific() {
        let descriptor = command_manifest::descriptor("git_status").expect("git status");
        let value = discovery_schemas(&[descriptor], "device").expect("schema");
        assert_eq!(value["git_status"]["input"]["required"], serde_json::json!(["workspaceId"]));
        assert_eq!(value.as_object().unwrap().len(), 1);
    }
}
