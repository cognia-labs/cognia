//! Request-scoped host privacy and extension boundary shared by every adapter.
//! The host owns redaction and plugin execution; native code keeps authority,
//! selector identity, bounded waits, and streaming restoration here.

use super::*;
use axum::extract::Request;
use std::collections::{BTreeMap, VecDeque};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(3);
const FRAME_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub(super) struct NotDispatched;

pub(super) fn is_internal(state: &AppState, ctx: &ReqCtx) -> bool {
    ctx.ticket
        .as_ref()
        .is_some_and(|ticket| state.tickets.is_internal_bridge(&ticket.ticket_id))
}

fn error(status: StatusCode, message: &str) -> Box<Response> {
    Box::new(
        (
            status,
            Json(error_body(
                InboundFormat::OpenAiChat,
                "gateway_runtime_error",
                message,
            )),
        )
            .into_response(),
    )
}

#[derive(Clone, Default)]
pub(super) struct PrivacyRestorer {
    replacements: Vec<(String, String)>,
}

impl PrivacyRestorer {
    pub(super) fn restore_text(&self, text: &str) -> String {
        // One pass: an original string is never interpreted as another token.
        let mut output = String::new();
        let mut remaining = text;
        loop {
            let found = self
                .replacements
                .iter()
                .filter_map(|(token, original)| {
                    remaining
                        .find(token)
                        .map(|position| (position, token, original))
                })
                .min_by_key(|(position, _, _)| *position);
            let Some((position, token, original)) = found else {
                output.push_str(remaining);
                return output;
            };
            output.push_str(&remaining[..position]);
            output.push_str(original);
            remaining = &remaining[position + token.len()..];
        }
    }

    pub(super) fn restore_json(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.restore_text(text),
            Value::Array(values) => values.iter_mut().for_each(|value| self.restore_json(value)),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| self.restore_json(value)),
            _ => {}
        }
    }

    fn partial_suffix(&self, text: &str) -> usize {
        self.replacements
            .iter()
            .flat_map(|(token, _)| {
                token
                    .char_indices()
                    .skip(1)
                    .map(|(end, _)| end)
                    .filter(|end| text.ends_with(&token[..*end]))
            })
            .max()
            .unwrap_or(0)
    }
}

pub(super) fn context(state: &AppState, ctx: &ReqCtx, model: &str) -> Value {
    let account = state.account.read();
    let mut payload = json!({
        "requestId":ctx.request_id,
        "accountGeneration":ctx.account_generation,
        "protocol": match ctx.route.as_str() {
            "/v1/messages" | "/v1/messages/count_tokens" => "anthropic",
            "/v1/responses" => "responses",
            path if path.starts_with("/v1beta/") || path.starts_with("/v1alpha/") => "google",
            path if path.starts_with("/api/") => "ollama",
            _ => "openai",
        },
        "modelAlias":model,
    });
    if let Some(owner) = account
        .owner_account_id
        .as_ref()
        .filter(|_| account.required)
    {
        payload["ownerAccountId"] = json!(owner);
    }
    if let Some(session) = ctx
        .session_id
        .as_ref()
        .or_else(|| ctx.ticket.as_ref().map(|ticket| &ticket.session_id))
    {
        payload["sessionId"] = json!(session);
    }
    payload
}

pub(super) async fn call(
    state: &AppState,
    command: &'static str,
    payload: Value,
    timeout: Duration,
) -> Result<Value, Box<Response>> {
    let result = tokio::time::timeout(timeout, state.runs.bridge().call(command, payload)).await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(crate::brain_bridge::BrainBridgeError::NotDispatched(_))) => {
            let mut response = error(
                StatusCode::SERVICE_UNAVAILABLE,
                "configured gateway runtime service is unavailable",
            );
            response.extensions_mut().insert(NotDispatched);
            Err(response)
        }
        // Never expose bridge diagnostics: plugin/provider errors can contain
        // the private prompt, original PII, credentials, or remote response.
        _ => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "configured gateway runtime service is unavailable",
        )),
    }
}

fn model_of<'a>(ctx: &'a ReqCtx, body: &'a Value) -> &'a str {
    body.get("model")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            ctx.route
                .split("/models/")
                .nth(1)
                .unwrap_or("")
                .rsplit_once(':')
                .map_or("", |(model, _)| model)
        })
}

fn unchanged_identity(before: &Value, after: &Value) -> bool {
    after.is_object()
        && ["model", "stream", "session_id", "previous_response_id"]
            .iter()
            .all(|field| before.get(*field) == after.get(*field))
}

fn introduced_text_is_safe(before: &Value, after: &Value) -> bool {
    if before == after {
        return true;
    }
    match after {
        Value::Array(values) => values
            .iter()
            .enumerate()
            .all(|(index, value)| introduced_text_is_safe(&before[index], value)),
        Value::Object(fields) => fields.iter().all(|(key, value)| {
            [
                "inlineData",
                "inline_data",
                "fileData",
                "file_data",
                "image_url",
                "input_audio",
                "audio",
                "video_url",
            ]
            .contains(&key.as_str())
                || introduced_text_is_safe(&before[key], value)
        }),
        _ => inspectable_text_is_safe(after),
    }
}

pub(super) async fn transform_body(
    state: &AppState,
    ctx: &ReqCtx,
    command: &'static str,
    body: Value,
    candidate: Option<&Candidate>,
) -> Result<Value, Box<Response>> {
    if !state.config.read().middleware_enabled || is_internal(state, ctx) {
        return Ok(body);
    }
    let mut payload = context(state, ctx, model_of(ctx, &body));
    if let Some(candidate) = candidate {
        payload["providerId"] = json!(candidate.provider.id);
        payload["modelId"] = json!(candidate.model_id);
    }
    payload["body"] = body.clone();
    let answer = call(state, command, payload, BRIDGE_TIMEOUT).await?;
    let next = answer
        .get("body")
        .filter(|body| body.is_object())
        .cloned()
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway extension returned an invalid body",
            )
        })?;
    if (command != "gateway_middleware_response" && !unchanged_identity(&body, &next))
        || (command == "gateway_middleware_response"
            && ["id", "model", "usage", "usageMetadata"]
                .iter()
                .any(|field| body.get(*field) != next.get(*field)))
    {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "gateway extension changed request authority",
        ));
    }
    if matches!(
        command,
        "gateway_middleware_request" | "gateway_middleware_provider"
    ) && !introduced_text_is_safe(&body, &next)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "gateway extension introduced recognized sensitive data",
        ));
    }
    Ok(next)
}

pub(super) async fn prepare_provider_body(
    state: &AppState,
    ctx: &ReqCtx,
    candidate: &Candidate,
    body: Value,
) -> Result<Value, Box<Response>> {
    let mut body = transform_body(
        state,
        ctx,
        "gateway_middleware_provider",
        body,
        Some(candidate),
    )
    .await?;
    let masked = state.config.read().privacy_mode == crate::types::GatewayPrivacyMode::Mask;
    let full = masked
        || ctx.route == "/v1/embeddings"
        || ["/v1/images/", "/v1/audio/", "/v1/videos", "/v1/rerank"]
            .iter()
            .any(|path| ctx.route.starts_with(path));
    let safe = if full {
        inspectable_text_is_safe(&body)
    } else {
        body_has_no_leaking_pii(&body)
    };
    if (ctx.ticket.is_some() || masked) && !safe {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "gateway provider extension introduced recognized sensitive data",
        ));
    }
    if let Some(parent) = ctx
        .ticket
        .as_ref()
        .and_then(|ticket| state.tickets.internal_bridge_reservation(&ticket.ticket_id))
    {
        let requested = request_max_output_tokens(&body, &candidate.provider.protocol);
        let allowed = state
            .tickets
            .reserve_model_output(&parent, estimate_input_tokens(&body), requested)
            .map_err(|_| {
                error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "bridge parent token budget is exhausted",
                )
            })?;
        if let Some(allowed) = allowed {
            set_request_max_output_tokens(&mut body, &candidate.provider.protocol, allowed)
                .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid bridge output limit"))?;
        }
    }
    Ok(body)
}

fn inspectable_text_is_safe(value: &Value) -> bool {
    match value {
        Value::String(_) => value_has_no_leaking_pii(value),
        Value::Array(values) => values.iter().all(inspectable_text_is_safe),
        Value::Object(fields) => {
            // These fields carry opaque image/audio bytes or references. They
            // are preserved rather than presented as text that was redacted.
            let media = fields
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    matches!(
                        kind,
                        "image"
                            | "image_url"
                            | "input_image"
                            | "input_audio"
                            | "audio"
                            | "video"
                            | "input_video"
                    )
                });
            media
                || fields.iter().all(|(key, value)| {
                    [
                        "inlineData",
                        "inline_data",
                        "fileData",
                        "file_data",
                        "image_url",
                        "input_audio",
                        "audio",
                        "video_url",
                    ]
                    .contains(&key.as_str())
                        || inspectable_text_is_safe(value)
                })
        }
        _ => true,
    }
}

pub(super) async fn prepare_gateway_body(
    state: &AppState,
    ctx: &ReqCtx,
    body: Value,
) -> Result<(Value, PrivacyRestorer), Box<Response>> {
    if ctx.body_prepared {
        return Ok((body, PrivacyRestorer::default()));
    }
    let body = transform_body(state, ctx, "gateway_middleware_request", body, None).await?;
    if state.config.read().privacy_mode != crate::types::GatewayPrivacyMode::Mask {
        return Ok((body, PrivacyRestorer::default()));
    }
    let mut payload = context(state, ctx, model_of(ctx, &body));
    payload["body"] = body.clone();
    let answer = call(state, "gateway_privacy_prepare", payload, BRIDGE_TIMEOUT).await?;
    let masked = answer
        .get("body")
        .filter(|value| unchanged_identity(&body, value))
        .cloned()
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway privacy returned an invalid body",
            )
        })?;
    let mappings = answer["replacements"]
        .as_array()
        .filter(|values| values.len() <= 100_000)
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway privacy returned invalid mappings",
            )
        })?;
    let mut replacements = Vec::with_capacity(mappings.len());
    let mut seen = std::collections::HashSet::new();
    for mapping in mappings {
        let token = mapping["placeholder"]
            .as_str()
            .filter(|token| {
                token.starts_with('<')
                    && token.ends_with('>')
                    && token.len() <= 128
                    && token.len() > 2
            })
            .ok_or_else(|| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "gateway privacy returned an invalid placeholder",
                )
            })?;
        let original = mapping["original"].as_str().ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway privacy returned an invalid replacement",
            )
        })?;
        if !seen.insert(token.to_string()) {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway privacy returned duplicate mappings",
            ));
        }
        replacements.push((token.to_string(), original.to_string()));
    }
    Ok((masked, PrivacyRestorer { replacements }))
}

fn inference_path(path: &str) -> bool {
    matches!(
        path,
        "/v1/chat/completions"
            | "/v1/messages"
            | "/v1/messages/count_tokens"
            | "/v1/embeddings"
            | "/v1/responses"
            | "/api/chat"
            | "/api/generate"
    ) || ((path.starts_with("/v1beta/models/") || path.starts_with("/v1alpha/models/"))
        && path.contains(':'))
}

pub(super) async fn request_boundary(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let enabled = {
        let cfg = state.config.read();
        cfg.privacy_mode == crate::types::GatewayPrivacyMode::Mask || cfg.middleware_enabled
    };
    if !enabled
        || request.method() != axum::http::Method::POST
        || !inference_path(request.uri().path())
    {
        return next.run(request).await;
    }
    let Some(mut ctx) = request.extensions().get::<ReqCtx>().cloned() else {
        return *error(StatusCode::UNAUTHORIZED, "gateway authority is missing");
    };
    if is_internal(&state, &ctx) {
        return next.run(request).await;
    }
    if !request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';').next().is_some_and(|v| {
                let mime = v.trim().to_ascii_lowercase();
                mime == "application/json"
                    || (mime.starts_with("application/") && mime.ends_with("+json"))
            })
        })
    {
        // Multipart adapters apply the same boundary to inspectable fields.
        return next.run(request).await;
    }
    let bytes = match axum::body::to_bytes(
        std::mem::replace(request.body_mut(), Body::empty()),
        BODY_LIMIT_BYTES,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(_) => {
            return *error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "gateway request body is too large",
            )
        }
    };
    let body: Value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(body) if body.is_object() => body,
        _ => return *error(StatusCode::BAD_REQUEST, "gateway expects a JSON object"),
    };
    let model = model_of(&ctx, &body);
    let normalized = if ctx.route.starts_with("/api/") {
        let snapshot = state.snapshot.read();
        if snapshot
            .as_ref()
            .is_some_and(|snapshot| crate::route_planner::model_is_known(snapshot, model))
        {
            model
        } else {
            model.strip_suffix(":latest").unwrap_or(model)
        }
    } else {
        model
    };
    if let Some(ticket) = &ctx.ticket {
        if ticket.resolve_model(normalized).is_none() {
            return native_error(
                &ctx,
                *error(
                    StatusCode::BAD_REQUEST,
                    "model is not bound by this route ticket",
                ),
            )
            .await;
        }
    } else {
        let config = state.config.read().clone();
        if !config.model_is_exposed(normalized) || !ctx_allows(&ctx, normalized) {
            return native_error(
                &ctx,
                *error(
                    StatusCode::FORBIDDEN,
                    "model is not permitted by this gateway key",
                ),
            )
            .await;
        }
    }
    if ctx.session_id.is_none() {
        ctx.session_id = Some(derive_session_id(
            &body,
            &ctx.remote_ip,
            &ctx.user_agent,
            ctx.key_id.as_deref().unwrap_or(""),
        ));
    }
    // The alias is still exactly the caller's at this boundary. Providers and
    // protocol adapters receive the prepared copy only after authorization.
    let (body, restorer) = match prepare_gateway_body(&state, &ctx, body).await {
        Ok(prepared) => prepared,
        Err(response) => return native_error(&ctx, *response).await,
    };
    ctx.body_prepared = true;
    request.extensions_mut().insert(ctx.clone());
    let bytes = serde_json::to_vec(&body).expect("JSON body serializes");
    request
        .headers_mut()
        .remove(axum::http::header::CONTENT_LENGTH);
    *request.body_mut() = Body::from(bytes);
    let response = next.run(request).await;
    let response = transform_response(state, ctx.clone(), restorer, response).await;
    native_error(&ctx, response).await
}

async fn native_error(ctx: &ReqCtx, response: Response) -> Response {
    if response.status().is_success() || !ctx.route.starts_with("/v1/messages") {
        return response;
    }
    let status = response.status();
    let bytes = match axum::body::to_bytes(response.into_body(), FRAME_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (
                status,
                Json(error_body(
                    InboundFormat::AnthropicMessages,
                    "gateway_runtime_error",
                    "gateway runtime failed",
                )),
            )
                .into_response()
        }
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("gateway runtime failed");
    (
        status,
        Json(error_body(
            InboundFormat::AnthropicMessages,
            "gateway_runtime_error",
            message,
        )),
    )
        .into_response()
}

async fn transform_response(
    state: AppState,
    ctx: ReqCtx,
    restorer: PrivacyRestorer,
    response: Response,
) -> Response {
    if !response.status().is_success() {
        return response;
    }
    if restorer.replacements.is_empty() && !state.config.read().middleware_enabled {
        return response;
    }
    let content_type = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stream_kind = if content_type.starts_with("text/event-stream") {
        Some(true)
    } else if content_type.contains("ndjson") {
        Some(false)
    } else {
        None
    };
    let (mut parts, body) = response.into_parts();
    if let Some(sse) = stream_kind {
        parts.headers.remove(axum::http::header::CONTENT_LENGTH);
        let input = body.into_data_stream();
        let processor = FrameProcessor::new(restorer, sse);
        let output = futures_util::stream::unfold(
            (input, processor, VecDeque::new(), false, state, ctx),
            |(mut input, mut processor, mut queue, mut ended, state, ctx)| async move {
                loop {
                    if let Some(frame) = queue.pop_front() {
                        return Some((
                            Ok::<Bytes, std::io::Error>(Bytes::from(frame)),
                            (input, processor, queue, ended, state, ctx),
                        ));
                    }
                    if ended {
                        return None;
                    }
                    match input.next().await {
                        Some(Ok(bytes)) => {
                            if processor.feed(&bytes).is_err() {
                                ended = true;
                                queue.push_back(processor.failure(&ctx));
                                continue;
                            }
                            loop {
                                let frame = match processor.take_frame(false) {
                                    Ok(Some(frame)) => frame,
                                    Ok(None) => break,
                                    Err(()) => {
                                        ended = true;
                                        queue.push_back(processor.failure(&ctx));
                                        break;
                                    }
                                };
                                match process_frame(&state, &ctx, &mut processor, frame).await {
                                    Ok(frames) => queue.extend(frames),
                                    Err(_) => {
                                        ended = true;
                                        queue.clear();
                                        queue.push_back(processor.failure(&ctx));
                                        break;
                                    }
                                }
                            }
                        }
                        Some(Err(_)) => {
                            ended = true;
                            queue.push_back(processor.failure(&ctx));
                        }
                        None => {
                            match processor.take_frame(true) {
                                Ok(Some(frame)) => {
                                    match process_frame(&state, &ctx, &mut processor, frame).await {
                                        Ok(frames) => queue.extend(frames),
                                        Err(_) => queue.push_back(processor.failure(&ctx)),
                                    }
                                }
                                Err(()) => queue.push_back(processor.failure(&ctx)),
                                Ok(None) => {}
                            }
                            queue.extend(processor.flush());
                            ended = true;
                        }
                    }
                }
            },
        );
        return Response::from_parts(parts, Body::from_stream(output));
    }
    if !content_type.starts_with("application/json") {
        return Response::from_parts(parts, body);
    }
    let bytes = match axum::body::to_bytes(body, BODY_LIMIT_BYTES * 4).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return *error(
                StatusCode::BAD_GATEWAY,
                "gateway response body is too large",
            )
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return *error(StatusCode::BAD_GATEWAY, "upstream returned invalid JSON"),
    };
    let mut value =
        match transform_body(&state, &ctx, "gateway_middleware_response", value, None).await {
            Ok(value) => value,
            Err(response) => return *response,
        };
    restorer.restore_json(&mut value);
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&value).expect("JSON response serializes")),
    )
}

struct HeldFrame {
    id: u64,
    prefix: String,
    value: Option<Value>,
    raw: String,
}
impl HeldFrame {
    fn render(self, sse: bool) -> String {
        match self.value {
            Some(value) if sse => format!(
                "{}data: {value}\n\n",
                if self.prefix.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", self.prefix)
                }
            ),
            Some(value) => format!("{value}\n"),
            None => self.raw,
        }
    }
}

struct FrameProcessor {
    restorer: PrivacyRestorer,
    sse: bool,
    bytes: Vec<u8>,
    pending: BTreeMap<String, String>,
    locations: BTreeMap<String, (u64, String)>,
    frame_id: u64,
    held: VecDeque<HeldFrame>,
    held_bytes: usize,
}

impl FrameProcessor {
    fn new(restorer: PrivacyRestorer, sse: bool) -> Self {
        Self {
            restorer,
            sse,
            bytes: Vec::new(),
            pending: BTreeMap::new(),
            locations: BTreeMap::new(),
            frame_id: 0,
            held: VecDeque::new(),
            held_bytes: 0,
        }
    }
    fn feed(&mut self, bytes: &[u8]) -> Result<(), ()> {
        if self.bytes.len().saturating_add(bytes.len()) > FRAME_LIMIT {
            return Err(());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn take_frame(&mut self, eof: bool) -> Result<Option<String>, ()> {
        let end = if self.sse {
            [
                self.bytes
                    .windows(2)
                    .position(|window| window == b"\n\n")
                    .map(|i| i + 2),
                self.bytes
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|i| i + 4),
            ]
            .into_iter()
            .flatten()
            .min()
        } else {
            self.bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|i| i + 1)
        }
        .or_else(|| (eof && !self.bytes.is_empty()).then_some(self.bytes.len()));
        let Some(end) = end else {
            return Ok(None);
        };
        let bytes: Vec<_> = self.bytes.drain(..end).collect();
        String::from_utf8(bytes).map(Some).map_err(|_| ())
    }
    fn encode(&self, event: &str, value: &Value) -> String {
        if self.sse {
            format!(
                "{}data: {}\n\n",
                if event.is_empty() {
                    String::new()
                } else {
                    format!("event: {event}\n")
                },
                value
            )
        } else {
            format!("{value}\n")
        }
    }
    fn failure(&self, ctx: &ReqCtx) -> String {
        let message = "gateway stream transform failed";
        if ctx.route.starts_with("/api/") {
            return format!("{}\n", json!({"error":message}));
        }
        let (event, value) = if ctx.route.starts_with("/v1/messages") {
            (
                "error",
                error_body(
                    InboundFormat::AnthropicMessages,
                    "gateway_runtime_error",
                    message,
                ),
            )
        } else if ctx.route.starts_with("/v1beta/") || ctx.route.starts_with("/v1alpha/") {
            (
                "",
                error_body(InboundFormat::Gemini, "gateway_runtime_error", message),
            )
        } else {
            (
                "error",
                error_body(InboundFormat::OpenAiChat, "gateway_runtime_error", message),
            )
        };
        self.encode(event, &value)
    }
    fn restore_stream(&mut self, event: &str, value: &mut Value) {
        let template = value.clone();
        let scope = json!([
            value.get("index"),
            value.get("item_id"),
            value.get("output_index"),
            value.get("content_index"),
            value.get("summary_index")
        ])
        .to_string();
        self.walk(event, &template, value, scope, String::new());
    }
    fn walk(
        &mut self,
        event: &str,
        template: &Value,
        value: &mut Value,
        path: String,
        pointer: String,
    ) {
        match value {
            Value::String(text) => {
                let combined = self.pending.remove(&path).unwrap_or_default() + text;
                let fragment = (template.get("choices").is_some()
                    && pointer.contains("/delta/")
                    && ["/content", "/reasoning_content", "/reasoning", "/arguments"]
                        .iter()
                        .any(|field| pointer.ends_with(field)))
                    || (template["type"] == "content_block_delta"
                        && ["/delta/text", "/delta/thinking", "/delta/partial_json"]
                            .contains(&pointer.as_str()))
                    || (template.get("candidates").is_some()
                        && pointer.contains("/parts/")
                        && pointer.ends_with("/text")
                        && !pointer.contains("/functionCall/")
                        && !pointer.contains("/function_call/"))
                    || ["/message/content", "/message/thinking", "/response"]
                        .contains(&pointer.as_str())
                    || (event.ends_with(".delta") && pointer == "/delta");
                let suffix = if fragment {
                    self.restorer.partial_suffix(&combined)
                } else {
                    0
                };
                let end = combined.len() - suffix;
                *text = self.restorer.restore_text(&combined[..end]);
                if suffix > 0 {
                    self.pending
                        .insert(path.clone(), combined[end..].to_string());
                    self.locations.insert(path, (self.frame_id, pointer));
                } else {
                    self.locations.remove(&path);
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter_mut().enumerate() {
                    let logical = value
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|index| format!("@{index}"))
                        .unwrap_or_else(|| index.to_string());
                    self.walk(
                        event,
                        template,
                        value,
                        format!("{path}/{logical}"),
                        format!("{pointer}/{index}"),
                    );
                }
            }
            Value::Object(values) => {
                for (key, value) in values.iter_mut() {
                    let key = key.replace('~', "~0").replace('/', "~1");
                    self.walk(
                        event,
                        template,
                        value,
                        format!("{path}/{key}"),
                        format!("{pointer}/{key}"),
                    );
                }
            }
            _ => {}
        }
    }
    fn enqueue(&mut self, frame: HeldFrame) -> Result<(), Box<Response>> {
        let size = frame
            .value
            .as_ref()
            .map(|value| value.to_string().len())
            .unwrap_or(frame.raw.len())
            .saturating_add(frame.prefix.len());
        if self.held.len() >= 1024 || self.held_bytes.saturating_add(size) > FRAME_LIMIT {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "gateway stream placeholder buffer is too large",
            ));
        }
        self.held_bytes += size;
        self.held.push_back(frame);
        Ok(())
    }
    fn drain(&mut self) -> Vec<String> {
        self.held_bytes = 0;
        self.held
            .drain(..)
            .map(|frame| frame.render(self.sse))
            .collect()
    }
    fn drain_ready(&mut self) -> Vec<String> {
        let first_pending = self
            .locations
            .values()
            .map(|(id, _)| *id)
            .min()
            .unwrap_or(u64::MAX);
        let mut out = Vec::new();
        while self
            .held
            .front()
            .is_some_and(|frame| frame.id < first_pending)
        {
            let frame = self.held.pop_front().expect("front was present");
            let size = frame
                .value
                .as_ref()
                .map(|value| value.to_string().len())
                .unwrap_or(frame.raw.len())
                .saturating_add(frame.prefix.len());
            self.held_bytes = self.held_bytes.saturating_sub(size);
            out.push(frame.render(self.sse));
        }
        out
    }
    fn flush(&mut self) -> Vec<String> {
        // Keep each original event, tool identity and sequence number exactly
        // once. A literal unfinished prefix goes back into its held event.
        for (key, text) in std::mem::take(&mut self.pending) {
            if let Some((id, pointer)) = self.locations.remove(&key) {
                if let Some(value) = self
                    .held
                    .iter_mut()
                    .find(|frame| frame.id == id)
                    .and_then(|frame| frame.value.as_mut())
                    .and_then(|value| value.pointer_mut(&pointer))
                {
                    if let Some(prefix) = value.as_str() {
                        *value = json!(format!("{prefix}{text}"));
                    }
                }
            }
        }
        self.drain()
    }
}

async fn process_frame(
    state: &AppState,
    ctx: &ReqCtx,
    processor: &mut FrameProcessor,
    frame: String,
) -> Result<Vec<String>, Box<Response>> {
    processor.frame_id = processor.frame_id.wrapping_add(1);
    let (event, data) = if processor.sse {
        let event = frame
            .lines()
            .find_map(|line| line.strip_prefix("event:"))
            .unwrap_or("")
            .trim()
            .to_string();
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        (event, data)
    } else {
        (String::new(), frame.trim().to_string())
    };
    if data == "[DONE]" {
        let mut out = processor.flush();
        out.push(frame);
        return Ok(out);
    }
    if data.is_empty() {
        if processor.held.is_empty() {
            return Ok(vec![frame]);
        }
        processor.enqueue(HeldFrame {
            id: processor.frame_id,
            prefix: String::new(),
            value: None,
            raw: frame,
        })?;
        return Ok(Vec::new());
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&data) else {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "invalid upstream stream JSON",
        ));
    };
    if state.config.read().middleware_enabled {
        let mut payload = context(state, ctx, "");
        payload["event"] = json!(event);
        payload["data"] = value.clone();
        let answer = call(
            state,
            "gateway_middleware_event",
            payload,
            Duration::from_millis(1500),
        )
        .await?;
        if answer["event"].as_str() != Some(event.as_str())
            || answer.get("data").is_none()
            || ["id", "model", "usage", "usageMetadata", "type"]
                .iter()
                .any(|field| value.get(*field) != answer["data"].get(*field))
        {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway extension returned an invalid stream event",
            ));
        }
        value = answer["data"].clone();
    }
    let terminal = value["done"].as_bool() == Some(true)
        || value["choices"].as_array().is_some_and(|choices| {
            choices
                .iter()
                .any(|choice| !choice["finish_reason"].is_null())
        })
        || value["candidates"].as_array().is_some_and(|candidates| {
            candidates
                .iter()
                .any(|candidate| candidate.get("finishReason").is_some())
        })
        || matches!(
            event.as_str(),
            "message_stop" | "response.completed" | "response.failed"
        );
    processor.restore_stream(&event, &mut value);
    let prefix = if processor.sse {
        frame
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with("data:"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    let frame = HeldFrame {
        id: processor.frame_id,
        prefix,
        value: Some(value),
        raw: String::new(),
    };
    if processor.pending.is_empty() && processor.held.is_empty() {
        return Ok(vec![frame.render(processor.sse)]);
    }
    processor.enqueue(frame)?;
    if terminal {
        Ok(processor.flush())
    } else if processor.pending.is_empty() {
        Ok(processor.drain())
    } else {
        Ok(processor.drain_ready())
    }
}

#[cfg(test)]
mod tests {
    use super::super::router_fusion_server_tests::{gateway_with, json_of, request, send, SECRET};
    use super::super::tests::ctx;
    use super::*;
    use crate::brain_bridge::{BrainBridge, BrainFuture};

    #[test]
    fn mixed_sse_line_endings_keep_the_earliest_frame() {
        let mut processor = FrameProcessor::new(restorer(), true);
        processor
            .feed(b"data: {\"text\":1}\r\n\r\ndata: {\"text\":2}\n\n")
            .unwrap();
        assert_eq!(
            processor.take_frame(false).unwrap().as_deref(),
            Some("data: {\"text\":1}\r\n\r\n")
        );
        assert_eq!(
            processor.take_frame(false).unwrap().as_deref(),
            Some("data: {\"text\":2}\n\n")
        );
    }

    #[tokio::test]
    async fn terminal_delta_completes_pending_placeholder_before_finishing() {
        let gateway = gateway_with(Arc::new(Host::default()), false, false, None);
        let mut processor = FrameProcessor::new(restorer(), true);
        let first =
            json!({"choices":[{"index":0,"delta":{"content":"<EMAIL_"},"finish_reason":null}]});
        let last =
            json!({"choices":[{"index":0,"delta":{"content":"001>"},"finish_reason":"stop"}]});
        process_frame(
            &gateway.state,
            &ctx(),
            &mut processor,
            format!("id: first\ndata: {first}\n\n"),
        )
        .await
        .unwrap();
        let frames = process_frame(
            &gateway.state,
            &ctx(),
            &mut processor,
            format!("id: last\ndata: {last}\n\n"),
        )
        .await
        .unwrap();
        assert_eq!(frames.len(), 2);
        assert!(frames[0].starts_with("id: first\n"));
        assert!(frames[1].contains("me@example.com"));
        assert!(frames[1].starts_with("id: last\n"));
        assert!(!frames.join("").contains("<EMAIL_"));
    }

    #[tokio::test]
    async fn literal_prefix_flush_never_replays_tool_identity_or_event_sequence() {
        let gateway = gateway_with(Arc::new(Host::default()), false, false, None);
        let mut processor = FrameProcessor::new(restorer(), true);
        let first = json!({"id":"reply","sequence_number":0,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\"query\":\"<EMAIL_"}}]},"finish_reason":null}]});
        let last = json!({"id":"reply","sequence_number":1,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}});
        assert!(process_frame(
            &gateway.state,
            &ctx(),
            &mut processor,
            format!("data: {first}\n\n")
        )
        .await
        .unwrap()
        .is_empty());
        let frames = process_frame(
            &gateway.state,
            &ctx(),
            &mut processor,
            format!("data: {last}\n\n"),
        )
        .await
        .unwrap();
        assert_eq!(frames.len(), 2);
        let wire = frames.join("");
        assert_eq!(wire.matches("\"name\":\"lookup\"").count(), 1);
        assert_eq!(wire.matches("\"id\":\"call-1\"").count(), 1);
        assert_eq!(wire.matches("\"completion_tokens\":2").count(), 1);
        assert!(frames[0].contains("\"sequence_number\":0"));
        assert!(frames[1].contains("\"sequence_number\":1"));
    }

    #[tokio::test]
    async fn complete_google_function_arguments_do_not_wait_for_other_calls() {
        let gateway = gateway_with(Arc::new(Host::default()), false, false, None);
        let mut processor = FrameProcessor::new(restorer(), true);
        let value = json!({"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"lookup","args":{"text":"<","email":"<EMAIL_001>"}}}]}}]});
        let frames = process_frame(
            &gateway.state,
            &ctx(),
            &mut processor,
            format!("data: {value}\n\n"),
        )
        .await
        .unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].contains("me@example.com"));
        assert!(processor.pending.is_empty());
    }

    #[test]
    fn interleaved_tool_and_content_block_fragments_never_cross_stream_identity() {
        let mut processor = FrameProcessor::new(restorer(), true);
        let tool = |index: u64, text: &str| json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":index,"function":{"arguments":text}}]}}]});
        let mut first = tool(0, "<EMAIL_");
        let mut sibling = tool(1, "001>");
        let mut last = tool(0, "001>");
        processor.restore_stream("", &mut first);
        processor.restore_stream("", &mut sibling);
        processor.restore_stream("", &mut last);
        assert_eq!(
            sibling
                .pointer("/choices/0/delta/tool_calls/0/function/arguments")
                .unwrap(),
            "001>"
        );
        assert_eq!(
            last.pointer("/choices/0/delta/tool_calls/0/function/arguments")
                .unwrap(),
            "me@example.com"
        );
        let mut first = json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<EMAIL_"}});
        let mut sibling = json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"001>"}});
        let mut last = json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"001>"}});
        processor.restore_stream("content_block_delta", &mut first);
        processor.restore_stream("content_block_delta", &mut sibling);
        processor.restore_stream("content_block_delta", &mut last);
        assert_eq!(sibling["delta"]["text"], "001>");
        assert_eq!(last["delta"]["text"], "me@example.com");
    }

    #[test]
    fn plugin_added_pii_is_blocked_even_when_masking_is_off() {
        let before = json!({"messages":[{"content":"contact me@example.com"}]});
        assert!(introduced_text_is_safe(&before, &before));
        let mut after = before.clone();
        after["metadata"] = json!({"derived":"private@example.com"});
        assert!(!introduced_text_is_safe(&before, &after));
    }

    #[derive(Default)]
    struct Host {
        calls: Arc<parking_lot::Mutex<Vec<String>>>,
    }
    impl BrainBridge for Host {
        fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
            self.calls.lock().push(command.to_string());
            Box::pin(async move {
                if command == "gateway_privacy_prepare" {
                    let mut body = payload["body"].clone();
                    fn mask(value: &mut Value) {
                        match value {
                            Value::String(text) => {
                                *text = text.replace("me@example.com", "<EMAIL_001>")
                            }
                            Value::Array(values) => values.iter_mut().for_each(mask),
                            Value::Object(values) => values.values_mut().for_each(mask),
                            _ => {}
                        }
                    }
                    mask(&mut body);
                    Ok(
                        json!({"body":body,"replacements":[{"placeholder":"<EMAIL_001>","original":"me@example.com"}]}),
                    )
                } else if command == "gateway_middleware_event" {
                    Ok(json!({"event":payload["event"],"data":payload["data"]}))
                } else if command == "gateway_middleware_usage" {
                    Ok(json!({"recorded":true}))
                } else {
                    Ok(json!({"body":payload["body"]}))
                }
            })
        }
    }

    #[tokio::test]
    async fn mounted_masking_precedes_provider_send_and_restores_reply_once() {
        let requests = Arc::new(parking_lot::Mutex::new(Vec::<Value>::new()));
        let capture = requests.clone();
        let app=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
            capture.lock().push(body);
            async move { Json(json!({"id":"echo","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"Write to <EMAIL_001>."},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        struct Abort(tokio::task::JoinHandle<()>);
        impl Drop for Abort {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _abort = Abort(task);
        let snapshot=serde_json::from_value(json!({"generatedAtMs":1,"providers":[{"id":"p","baseUrl":base,"protocol":"openai","enabled":true,"models":["m"]}]})).unwrap();
        let host = Arc::new(Host::default());
        let gateway = gateway_with(host.clone(), false, false, Some(snapshot));
        {
            let mut config = gateway.state.config.write();
            config.privacy_mode = crate::types::GatewayPrivacyMode::Mask;
            config.middleware_enabled = true;
        }
        let response = send(
            &gateway.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(SECRET),
                Some(json!({"model":"m","messages":[{"role":"user","content":"me@example.com"}]})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json_of(response).await["choices"][0]["message"]["content"],
            "Write to me@example.com."
        );
        let requests = requests.lock();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].to_string().contains("me@example.com"));
        assert!(requests[0].to_string().contains("<EMAIL_001>"));
        let calls = host.calls.lock();
        assert_eq!(
            &calls[..3],
            &[
                "gateway_middleware_request",
                "gateway_privacy_prepare",
                "gateway_middleware_provider"
            ]
        );
        assert!(calls
            .iter()
            .any(|command| command == "gateway_middleware_response"));
    }

    fn restorer() -> PrivacyRestorer {
        PrivacyRestorer {
            replacements: vec![
                ("<EMAIL_001>".into(), "me@example.com".into()),
                ("<PERSON_002>".into(), "<EMAIL_001>".into()),
            ],
        }
    }

    #[test]
    fn replacements_are_single_pass_and_preserve_literal_values() {
        let mut value =
            json!({"text":"Hello <EMAIL_001> <PERSON_002>","literal":"<EMAIL_999>","n":5});
        restorer().restore_json(&mut value);
        assert_eq!(value["text"], "Hello me@example.com <EMAIL_001>");
        assert_eq!(value["literal"], "<EMAIL_999>");
    }

    #[test]
    fn restores_every_split_of_a_placeholder_in_stream_deltas() {
        for split in 1.."<EMAIL_001>".len() {
            let mut processor = FrameProcessor::new(restorer(), true);
            let mut first = json!({"choices":[{"delta":{"content": &"<EMAIL_001>"[..split]}}]});
            let mut second = json!({"choices":[{"delta":{"content": &"<EMAIL_001>"[split..]}}]});
            processor.restore_stream("", &mut first);
            processor.restore_stream("", &mut second);
            assert_eq!(
                format!(
                    "{}{}",
                    first["choices"][0]["delta"]["content"].as_str().unwrap(),
                    second["choices"][0]["delta"]["content"].as_str().unwrap()
                ),
                "me@example.com",
                "split {split}"
            );
            assert!(processor.pending.is_empty());
        }
    }

    #[test]
    fn deframes_split_utf8_and_crlf_without_losing_bytes() {
        let mut processor = FrameProcessor::new(restorer(), true);
        let frame = "data: {\"text\":\"中文\"}\r\n\r\n";
        for byte in frame.as_bytes() {
            processor.feed(&[*byte]).unwrap();
        }
        assert_eq!(processor.take_frame(false).unwrap().as_deref(), Some(frame));
    }

    #[test]
    fn extension_cannot_change_selector_or_stream() {
        let body = json!({"model":"allowed","stream":true});
        assert!(!unchanged_identity(
            &body,
            &json!({"model":"other","stream":true})
        ));
        assert!(!unchanged_identity(
            &body,
            &json!({"model":"allowed","stream":false})
        ));
        assert!(unchanged_identity(
            &body,
            &json!({"model":"allowed","stream":true,"temperature":1})
        ));
    }
}
