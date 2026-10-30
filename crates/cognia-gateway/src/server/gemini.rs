//! Native Google wire endpoints reuse the shared inference, ticket and privacy
//! boundaries. A separate adapter is needed because Google puts model and
//! operation in the URL and uses a different model-catalog/error shape.

use super::*;
use axum::extract::Path;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1beta/models", get(models))
        .route("/v1beta/models/{*model}", get(show).post(operation))
        .route("/v1alpha/models", get(models))
        .route("/v1alpha/models/{*model}", get(show).post(operation))
}

pub(super) fn is_native_path(path: &str) -> bool {
    path.starts_with("/v1beta/models") || path.starts_with("/v1alpha/models")
}

pub(super) async fn error_envelope(request: axum::extract::Request, next: Next) -> Response {
    let native = is_native_path(request.uri().path());
    let response = next.run(request).await;
    if native && (response.status().is_client_error() || response.status().is_server_error()) {
        normalize_error(response).await
    } else {
        response
    }
}

fn status_name(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 | 413 | 422 => "INVALID_ARGUMENT",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        429 => "RESOURCE_EXHAUSTED",
        500 => "INTERNAL",
        503 => "UNAVAILABLE",
        504 => "DEADLINE_EXCEEDED",
        _ => "UNKNOWN",
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":{"code":status.as_u16(),"message":message,"status":status_name(status)}}))).into_response()
}

async fn normalize_error(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, BODY_LIMIT_BYTES)
        .await
        .unwrap_or_default();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let message = parsed["error"]["message"]
        .as_str()
        .or_else(|| parsed["error"].as_str())
        .unwrap_or("gateway request failed");
    let mut native = parsed["error"].as_object().cloned().unwrap_or_default();
    native.insert("code".into(), json!(parts.status.as_u16()));
    native.insert("message".into(), json!(message));
    native
        .entry("status")
        .or_insert_with(|| json!(status_name(parts.status)));
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    parts.headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(json!({"error":native}).to_string()))
}

async fn catalog(
    state: AppState,
    ctx: ReqCtx,
    actor: Option<Extension<crate::runs::RunActor>>,
) -> Result<Vec<Value>, Box<Response>> {
    let response = list_models(State(state), Extension(ctx), actor).await;
    if !response.status().is_success() {
        return Err(Box::new(response));
    }
    let bytes = axum::body::to_bytes(response.into_body(), BODY_LIMIT_BYTES)
        .await
        .map_err(|_| Box::new(error(StatusCode::BAD_GATEWAY, "could not read the model catalog")))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Box::new(error(StatusCode::BAD_GATEWAY, "invalid model catalog")))?;
    body["data"]
        .as_array()
        .cloned()
        .ok_or_else(|| Box::new(error(StatusCode::BAD_GATEWAY, "invalid model catalog")))
}

fn document(model: &Value) -> Value {
    let id = model["id"].as_str().unwrap_or("");
    let mut out = json!({"name":format!("models/{id}"),"baseModelId":id,"displayName":model["displayName"].as_str().or_else(|| model["name"].as_str()).unwrap_or(id),"supportedGenerationMethods":["generateContent","streamGenerateContent","countTokens"]});
    if let Some(limit) = model["maxInputTokens"]
        .as_u64()
        .or_else(|| model["contextLength"].as_u64())
    {
        out["inputTokenLimit"] = json!(limit);
    }
    if let Some(limit) = model["maxOutputTokens"].as_u64() {
        out["outputTokenLimit"] = json!(limit);
    }
    for key in ["description", "version"] {
        if let Some(value) = model.get(key) {
            out[key] = value.clone();
        }
    }
    out
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    page_size: Option<usize>,
    page_token: Option<String>,
}

async fn models(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    axum::extract::Query(params): axum::extract::Query<ListParams>,
) -> Response {
    let size = params.page_size.unwrap_or(50);
    let offset = match params.page_token.as_deref().unwrap_or("0").parse::<usize>() {
        Ok(offset) => offset,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid pageToken"),
    };
    if size == 0 || size > 1000 {
        return error(
            StatusCode::BAD_REQUEST,
            "pageSize must be between 1 and 1000",
        );
    }
    let listed = match catalog(state, ctx, actor).await {
        Ok(models) => models,
        Err(response) => return *response,
    };
    let mut out =
        json!({"models":listed.iter().skip(offset).take(size).map(document).collect::<Vec<_>>()});
    let next = offset.saturating_add(size);
    if next < listed.len() {
        out["nextPageToken"] = json!(next.to_string());
    }
    Json(out).into_response()
}

async fn show(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Path(model): Path<String>,
    actor: Option<Extension<crate::runs::RunActor>>,
) -> Response {
    match catalog(state, ctx, actor).await {
        Ok(models) => models
            .iter()
            .find(|entry| entry["id"] == model)
            .map(|entry| Json(document(entry)).into_response())
            .unwrap_or_else(|| {
                error(
                    StatusCode::NOT_FOUND,
                    "model is not available to this caller",
                )
            }),
        Err(response) => *response,
    }
}

async fn operation(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Path(resource): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let Some((model, operation)) = resource.rsplit_once(':') else {
        return error(StatusCode::NOT_FOUND, "unknown model operation");
    };
    if model.trim().is_empty() || !body.is_object() {
        return error(
            StatusCode::BAD_REQUEST,
            "a model and JSON request object are required",
        );
    }
    body["model"] = json!(model);
    match operation {
        "generateContent" | "streamGenerateContent" => {
            body["stream"] = json!(operation == "streamGenerateContent");
            handle_chat(state, ctx, InboundFormat::Gemini, body).await
        }
        "countTokens" => count(state, ctx, body).await,
        _ => error(StatusCode::NOT_FOUND, "unknown model operation"),
    }
}

async fn count(state: AppState, ctx: ReqCtx, body: Value) -> Response {
    let state = state.for_request(&ctx);
    let model = body["model"]
        .as_str()
        .expect("path model inserted")
        .to_owned();
    let payload = body
        .get("generateContentRequest")
        .or_else(|| body.get("generate_content_request"))
        .unwrap_or(&body);
    if ctx.ticket.is_some() && !body_has_no_leaking_pii(payload) {
        return error(
            StatusCode::BAD_REQUEST,
            "recognized sensitive data must be redacted before sending this task to the model",
        );
    }
    let cfg = state.config.read().clone();
    let Some(snapshot) = state.snapshot.read().clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no routing snapshot is available",
        );
    };
    if ctx.ticket.is_none() {
        if let Some(response) = exposure_guard(&state, &ctx, InboundFormat::Gemini, &cfg, &model) {
            return response;
        }
    }
    let mut candidates = if let Some(ticket) = &ctx.ticket {
        let Some(resolved) = ticket.resolve_model(&model) else {
            return error(
                StatusCode::BAD_REQUEST,
                "model is not bound by this route ticket",
            );
        };
        ticket_base_candidates(&snapshot, ticket, Some(&resolved), Some(&model))
    } else {
        let session = derive_session_id(
            &body,
            &ctx.remote_ip,
            &ctx.user_agent,
            ctx.key_id.as_deref().unwrap_or(""),
        );
        route_candidates(&state, &snapshot, &cfg, &model, &body, &session).await
    };
    if ctx.ticket.is_none() {
        candidates=expand_gateway_pools(&state,&cfg,candidates,chrono::Utc::now().timestamp_millis(),None);
    }
    if candidates.is_empty() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no model candidate is available",
        );
    }
    let synthesized = || {
        let mut response =
            Json(json!({"totalTokens":estimate_input_tokens(payload)})).into_response();
        response.headers_mut().insert(
            "x-cognia-token-count",
            HeaderValue::from_static("estimated"),
        );
        response
    };
    let Some(candidate) = candidates
        .iter()
        .find(|candidate| matches!(candidate.provider.protocol.as_str(), "google" | "gemini"))
    else {
        return synthesized();
    };
    let mut upstream_body = body.clone();
    upstream_body.as_object_mut().unwrap().remove("model");
    for key in ["generateContentRequest", "generate_content_request"] {
        if let Some(request) = upstream_body.get_mut(key) {
            request["model"] = json!(format!("models/{}", candidate.model_id));
        }
    }
    upstream_body =
        match privacy::prepare_provider_body(&state, &ctx, candidate, upstream_body).await {
            Ok(body) => body,
            Err(response) => return *response,
        };
    let raw = super::super::execute::upstream_url_for(
        &candidate.provider.protocol,
        &candidate.provider.base_url,
        &candidate.model_id,
        false,
    );
    let Ok(mut url) = reqwest::Url::parse(&raw) else {
        return error(StatusCode::BAD_GATEWAY, "invalid countTokens upstream");
    };
    let path = format!(
        "{}:countTokens",
        url.path()
            .strip_suffix(":generateContent")
            .unwrap_or(url.path())
    );
    url.set_path(&path);
    let mut request = apply_timeout(state.http.post(url.as_str()).json(&upstream_body), &cfg);
    for (name, value) in super::super::execute::upstream_headers_for(
        &candidate.provider.protocol,
        candidate.provider.transport.as_ref(),
        candidate.provider.api_key.as_deref(),
        None,
    ) {
        request = request.header(name, value);
    }
    let started = Instant::now();
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "countTokens upstream request failed",
            )
        }
    };
    if matches!(response.status().as_u16(), 404 | 405 | 501) {
        return synthesized();
    }
    let status = response.status();
    let headers = response.headers().clone();
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "countTokens upstream body failed"),
    };
    let tokens = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| body["totalTokens"].as_u64());
    emit_request_log_ctx(
        state.host.as_ref(),
        &ctx,
        Some(&model),
        Some(&candidate.provider.id),
        status.as_u16(),
        started.elapsed().as_millis() as u64,
        tokens,
        None,
        None,
        false,
        Some(candidate),
    );
    let mut response = Response::builder()
        .status(status)
        .header("content-type", "application/json");
    for (name, value) in safe_upstream_response_headers(&headers) {
        response = response.header(name, value);
    }
    response.body(Body::from(text)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::super::router_fusion_server_tests as fixture;
    use super::*;

    struct Upstream {
        address: SocketAddr,
        seen: Arc<parking_lot::Mutex<Vec<(String, Value)>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream(protocol: &str) -> Upstream {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = seen.clone();
        let native = protocol == "google";
        let app = Router::new().route("/{*path}",post(move |Path(path):Path<String>, headers:HeaderMap, Json(body):Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().push((path.clone(),body.clone()));
                if native {
                    assert_eq!(headers.get("x-goog-api-key").unwrap(),"upstream-secret");
                    if path.ends_with(":countTokens") { return Json(json!({"totalTokens":17,"cachedContentTokenCount":3})).into_response(); }
                    assert!(body.get("model").is_none()); assert!(body.get("stream").is_none());
                    let payload = json!({"responseId":"native","modelVersion":"visible","candidates":[{"content":{"role":"model","parts":[{"text":"answer","thoughtSignature":"opaque-signature"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":3},"vendorField":{"kept":true}});
                    if path.ends_with(":streamGenerateContent") { return Response::builder().header("content-type","text/event-stream").body(Body::from(format!("data: {payload}\n\n"))).unwrap(); }
                    return Json(payload).into_response();
                }
                assert_eq!(body["messages"][0]["content"],"hello");
                if body["stream"] == true {
                    return Response::builder().header("content-type","text/event-stream").body(Body::from(concat!(
                        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"consider\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                        "data: [DONE]\n\n"))).unwrap();
                }
                Json(json!({"id":"chat","model":"visible","choices":[{"message":{"role":"assistant","content":"answer","reasoning_content":"consider"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Upstream {
            address,
            seen,
            task,
        }
    }

    fn gateway(upstream: &Upstream, protocol: &str) -> fixture::Gateway {
        let snapshot=serde_json::from_value(json!({"providers":[{"id":"up","protocol":protocol,"baseUrl":format!("http://{}/v1beta",upstream.address),"apiKey":"upstream-secret","enabled":true,"models":["visible","hidden"],"modelMetadata":[{"id":"visible","contextLength":8192,"maxOutputTokens":1024}]}],"generatedAtMs":1})).unwrap();
        fixture::gateway_with(
            Arc::new(crate::brain_bridge::RecordingBrainBridge::new()),
            false,
            false,
            Some(snapshot),
        )
    }

    fn request(method: &str, path: &str, body: Option<Value>) -> axum::http::Request<Body> {
        let mut request = fixture::request(method, path, None, body);
        request
            .headers_mut()
            .insert("x-goog-api-key", HeaderValue::from_static(fixture::SECRET));
        request
    }

    #[tokio::test]
    async fn google_output_limits_metadata_and_ticket_budget_reach_the_native_nested_field() {
        let upstream = upstream("google").await;
        let gateway = gateway(&upstream, "google");
        for (container, field) in [
            ("generationConfig", "maxOutputTokens"),
            ("generation_config", "max_output_tokens"),
        ] {
            let mut body = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}]});
            body[container] = json!({});
            body[container][field] = json!(4096);
            let response = fixture::send(
                &gateway.app,
                request("POST", "/v1beta/models/visible:generateContent", Some(body)),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let seen = upstream.seen.lock();
            let body = &seen.last().unwrap().1;
            assert_eq!(body[container][field], 1024);
            assert!(body.get("max_tokens").is_none());
            assert!(body.get("max_output_tokens").is_none());
        }
        let request = serde_json::from_value(json!({
            "sessionId":"google-budget","executionFingerprint":"google-budget","strictSelectors":true,
            "candidates":[{"deploymentId":"up","modelId":"visible"}],"modelBindings":{"visible":"visible"},
            "credentialAffinity":"session-sticky","routePolicy":"gateway-required","budget":{"maxTokens":40},"operations":["chat"]
        })).unwrap();
        let minted = gateway
            .state
            .tickets
            .mint(
                request,
                gateway.state.snapshot.read().as_ref(),
                chrono::Utc::now().timestamp_millis(),
            )
            .unwrap();
        let body = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generation_config":{"max_output_tokens":4096}});
        let expected_output = 40 - estimate_input_tokens(&body);
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/v1beta/models/visible:generateContent",
                Some(&minted.secret),
                Some(body),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let seen = upstream.seen.lock();
        let body = &seen.last().unwrap().1;
        assert_eq!(
            body["generation_config"]["max_output_tokens"],
            expected_output
        );
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("max_output_tokens").is_none());
    }

    #[tokio::test]
    async fn mounted_google_catalog_pagination_visibility_and_auth_errors() {
        let upstream = upstream("google").await;
        let gateway = gateway(&upstream, "google");
        let denied = fixture::send(
            &gateway.app,
            fixture::request("GET", "/v1beta/models", None, None),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let denied = fixture::json_of(denied).await;
        assert_eq!(denied["error"]["code"], 401);
        assert_eq!(denied["error"]["status"], "UNAUTHENTICATED");
        let first = fixture::json_of(
            fixture::send(
                &gateway.app,
                request("GET", "/v1beta/models?pageSize=1", None),
            )
            .await,
        )
        .await;
        assert_eq!(first["models"].as_array().unwrap().len(), 1);
        assert_eq!(first["nextPageToken"], "1");
        gateway
            .state
            .keys
            .write()
            .iter_mut()
            .find(|key| key.secret == fixture::SECRET)
            .unwrap()
            .model_allowlist = vec!["visible".into()];
        let listed = fixture::json_of(
            fixture::send(&gateway.app, request("GET", "/v1beta/models", None)).await,
        )
        .await;
        assert_eq!(listed["models"].as_array().unwrap().len(), 1);
        assert_eq!(listed["models"][0]["name"], "models/visible");
        assert_eq!(listed["models"][0]["inputTokenLimit"], 8192);
        let hidden =
            fixture::send(&gateway.app, request("GET", "/v1alpha/models/hidden", None)).await;
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
        assert!(upstream.seen.lock().is_empty());
    }

    #[tokio::test]
    async fn native_google_passthrough_preserves_vendor_fields_streams_and_count_tokens() {
        let upstream = upstream("google").await;
        let gateway = gateway(&upstream, "gemini");
        let body = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"safetySettings":[{"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_NONE"}]});
        let response = fixture::send(
            &gateway.app,
            request(
                "POST",
                "/v1beta/models/visible:generateContent",
                Some(body.clone()),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = fixture::json_of(response).await;
        assert_eq!(response["vendorField"]["kept"], true);
        assert_eq!(
            upstream.seen.lock()[0].1["safetySettings"],
            body["safetySettings"]
        );
        let stream = fixture::send(
            &gateway.app,
            request(
                "POST",
                "/v1beta/models/visible:streamGenerateContent?alt=sse",
                Some(body),
            ),
        )
        .await;
        assert_eq!(stream.status(), StatusCode::OK);
        let wire = axum::body::to_bytes(stream.into_body(), BODY_LIMIT_BYTES)
            .await
            .unwrap();
        let wire = String::from_utf8(wire.to_vec()).unwrap();
        assert!(wire.contains("opaque-signature"), "{wire}");
        assert!(wire.contains("vendorField"));
        let count = fixture::send(
            &gateway.app,
            request(
                "POST",
                "/v1beta/models/visible:countTokens",
                Some(json!({"contents":[{"parts":[{"text":"hello"}]}]})),
            ),
        )
        .await;
        assert_eq!(count.status(), StatusCode::OK);
        assert_eq!(fixture::json_of(count).await["totalTokens"], 17);
    }

    #[tokio::test]
    async fn google_client_reaches_chat_upstream_including_streams_and_estimated_count() {
        let upstream = upstream("openai").await;
        let gateway = gateway(&upstream, "openai");
        let body = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}]});
        let response = fixture::send(
            &gateway.app,
            request(
                "POST",
                "/v1beta/models/visible:generateContent",
                Some(body.clone()),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = fixture::json_of(response).await;
        assert_eq!(
            response["candidates"][0]["content"]["parts"][0]["thought"],
            true
        );
        let stream = fixture::send(
            &gateway.app,
            request(
                "POST",
                "/v1beta/models/visible:streamGenerateContent",
                Some(body.clone()),
            ),
        )
        .await;
        assert_eq!(stream.status(), StatusCode::OK);
        let wire = String::from_utf8(
            axum::body::to_bytes(stream.into_body(), BODY_LIMIT_BYTES)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(wire.contains("consider"));
        assert!(wire.contains("answer"));
        assert!(wire.contains("finishReason"));
        assert!(!wire.contains("[DONE]"));
        let count = fixture::send(
            &gateway.app,
            request("POST", "/v1beta/models/visible:countTokens", Some(body)),
        )
        .await;
        assert_eq!(count.status(), StatusCode::OK);
        assert_eq!(count.headers()["x-cognia-token-count"], "estimated");
        assert!(
            fixture::json_of(count).await["totalTokens"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
}
