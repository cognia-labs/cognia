//! OpenAI-shaped media and retrieval routes.
//!
//! These adapters route to upstreams that actually implement the corresponding
//! API. They do not claim that a text model can draw, transcribe, or make video.
//! Video follow-up IDs are caller-scoped, expire after 24 hours, and are lost
//! when this gateway process restarts. The registry never stores credentials.

use super::*;
use axum::extract::{FromRequest, Multipart, OriginalUri, Path, Request};
use std::collections::HashMap;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;
const VIDEO_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const VIDEO_CAPACITY: usize = 1024;

pub(super) struct MediaState {
    jobs: parking_lot::Mutex<HashMap<String, VideoJob>>,
    slots: Arc<Semaphore>,
}

impl Default for MediaState {
    fn default() -> Self {
        Self {
            jobs: parking_lot::Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(VIDEO_CAPACITY)),
        }
    }
}

#[derive(Clone)]
struct VideoRoute {
    key_id: String,
    account_generation: u64,
    selector: String,
    provider_id: String,
    deployment_id: Option<String>,
    model_id: String,
    account_id: Option<String>,
    credential_identity: String,
    upstream_id: String,
    created: Instant,
    restorer: PrivacyRestorer,
}

struct VideoJob {
    route: VideoRoute,
    _slot: OwnedSemaphorePermit,
}

impl MediaState {
    pub(super) fn clear(&self) {
        self.jobs.lock().clear();
    }

    fn reserve(&self, generation: u64) -> Result<OwnedSemaphorePermit, ()> {
        self.jobs.lock().retain(|_, job| {
            job.route.created.elapsed() < VIDEO_TTL && job.route.account_generation == generation
        });
        self.slots.clone().try_acquire_owned().map_err(|_| ())
    }

    fn insert(&self, route: VideoRoute, slot: OwnedSemaphorePermit) -> String {
        let id = format!("cognia_video_{}", uuid::Uuid::new_v4().simple());
        self.jobs
            .lock()
            .insert(id.clone(), VideoJob { route, _slot: slot });
        id
    }

    fn get(&self, id: &str, ctx: &ReqCtx) -> Option<VideoRoute> {
        let mut jobs = self.jobs.lock();
        jobs.retain(|_, job| {
            job.route.created.elapsed() < VIDEO_TTL
                && job.route.account_generation == ctx.account_generation
        });
        let job = jobs.get(id)?;
        (ctx.key_id.as_deref() == Some(job.route.key_id.as_str())
            && ctx.account_generation == job.route.account_generation)
            .then(|| job.route.clone())
    }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/images/generations", post(create))
        .route("/v1/images/edits", post(create))
        .route("/v1/audio/transcriptions", post(create))
        .route("/v1/audio/translations", post(create))
        .route("/v1/audio/speech", post(create))
        .route("/v1/rerank", post(create))
        .route("/v1/videos", post(create))
        .route("/v1/videos/{id}", get(video_get))
        .route("/v1/videos/{id}/content", get(video_content))
        .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT_BYTES))
}

#[derive(Clone)]
struct FormField {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
    bytes: Bytes,
}

impl FormField {
    fn is_binary(&self) -> bool {
        self.filename.is_some()
            || matches!(
                self.name.as_str(),
                "file" | "image" | "image[]" | "mask" | "video" | "input_reference"
            )
    }
}

#[derive(Clone)]
enum Payload {
    Json(Value),
    Form { fields: Vec<FormField>, text: Value },
}

impl Payload {
    fn text(&self) -> &Value {
        match self {
            Self::Json(body) => body,
            Self::Form { text, .. } => text,
        }
    }

    fn request(
        &self,
        client: &UpstreamClients,
        url: &str,
        model: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        match self {
            Self::Json(body) => Ok(client.post(url).json(&rewrite_model(body, model))),
            Self::Form { fields, text } => {
                let mut form = reqwest::multipart::Form::new();
                let mut indexes = HashMap::<&str, usize>::new();
                for field in fields {
                    let mut part = if field.is_binary() {
                        reqwest::multipart::Part::bytes(field.bytes.to_vec())
                    } else {
                        let value = if field.name == "model" {
                            model.to_string()
                        } else {
                            let index = indexes.entry(field.name.as_str()).or_default();
                            let value = match &text[&field.name] {
                                Value::String(value) => value.clone(),
                                Value::Array(values) => values
                                    .get(*index)
                                    .and_then(Value::as_str)
                                    .ok_or("invalid prepared multipart field")?
                                    .to_string(),
                                _ => return Err("prepared multipart field is missing".into()),
                            };
                            *index += 1;
                            value
                        };
                        reqwest::multipart::Part::text(value)
                    };
                    if let Some(filename) = &field.filename {
                        part = part.file_name(filename.clone());
                    }
                    if let Some(content_type) = &field.content_type {
                        part = part
                            .mime_str(content_type)
                            .map_err(|_| "invalid multipart content type")?;
                    }
                    form = form.part(field.name.clone(), part);
                }
                Ok(client.post(url).multipart(form))
            }
        }
    }
}

async fn parse_payload(request: Request, state: &AppState) -> Result<Payload, Box<Response>> {
    let content_type = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        let mut form = Multipart::from_request(request, state)
            .await
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid multipart form"))?;
        let mut fields = Vec::new();
        let mut text = serde_json::Map::new();
        let mut total = 0usize;
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid multipart field"))?
        {
            let name = field
                .name()
                .ok_or_else(|| error(StatusCode::BAD_REQUEST, "multipart field requires a name"))?
                .to_string();
            let filename = field.file_name().map(str::to_string);
            let content_type = field.content_type().map(str::to_string);
            let bytes = field
                .bytes()
                .await
                .map_err(|_| error(StatusCode::BAD_REQUEST, "could not read multipart field"))?;
            total = total.saturating_add(bytes.len());
            if total > BODY_LIMIT_BYTES {
                return Err(Box::new(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "multipart form exceeds the request limit",
                )));
            }
            let field = FormField {
                name,
                filename,
                content_type,
                bytes,
            };
            if !field.is_binary() {
                let name = &field.name;
                let bytes = &field.bytes;
                let value = std::str::from_utf8(bytes).map_err(|_| {
                    error(
                        StatusCode::BAD_REQUEST,
                        "textual multipart fields must be UTF-8",
                    )
                })?;
                if name == "model" && text.contains_key("model") {
                    return Err(Box::new(error(
                        StatusCode::BAD_REQUEST,
                        "model must occur once",
                    )));
                }
                match text.get_mut(name) {
                    None => {
                        text.insert(name.clone(), json!(value));
                    }
                    Some(Value::Array(values)) => values.push(json!(value)),
                    Some(previous) => {
                        *previous = json!([previous.clone(), value]);
                    }
                }
            }
            fields.push(field);
        }
        Ok(Payload::Form {
            fields,
            text: Value::Object(text),
        })
    } else if content_type
        .split(';')
        .next()
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
    {
        let bytes = axum::body::to_bytes(request.into_body(), BODY_LIMIT_BYTES)
            .await
            .map_err(|_| {
                error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request body exceeds the limit",
                )
            })?;
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid JSON request"))?;
        if !body.is_object() {
            return Err(Box::new(error(
                StatusCode::BAD_REQUEST,
                "request must be a JSON object",
            )));
        }
        Ok(Payload::Json(body))
    } else {
        Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "use application/json or multipart/form-data",
        )))
    }
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Response {
    let state = state.for_request(&ctx);
    if ctx.ticket.is_some() {
        return error(
            StatusCode::FORBIDDEN,
            "route tickets do not grant media operations",
        );
    }
    let operation = match uri.path() {
        "/v1/images/generations" => "/images/generations",
        "/v1/images/edits" => "/images/edits",
        "/v1/audio/transcriptions" => "/audio/transcriptions",
        "/v1/audio/translations" => "/audio/translations",
        "/v1/audio/speech" => "/audio/speech",
        "/v1/rerank" => "/rerank",
        "/v1/videos" => "/videos",
        _ => return error(StatusCode::NOT_FOUND, "unknown media operation"),
    };
    let mut payload = match parse_payload(request, &state).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let selector = match payload.text()["model"]
        .as_str()
        .filter(|model| !model.is_empty())
    {
        Some(model) => model.to_string(),
        None => return error(StatusCode::BAD_REQUEST, "model is required"),
    };
    if payload.text()["stream"] == true {
        return error(
            StatusCode::BAD_REQUEST,
            "this media route does not support streaming generation",
        );
    }
    if payload.text()["stream_format"] == "sse" {
        return error(StatusCode::BAD_REQUEST, "this media route supports a complete audio response; SSE speech events require a native upstream connection");
    }
    let (prepared, restorer) =
        match prepare_gateway_body(&state, &ctx, payload.text().clone()).await {
            Ok(prepared) => prepared,
            Err(response) => return *response,
        };
    match &mut payload {
        Payload::Json(body) => *body = prepared,
        Payload::Form { text, .. } => *text = prepared,
    }
    let cfg = state.config.read().clone();
    if let Some(response) = exposure_guard(&state, &ctx, InboundFormat::OpenAiChat, &cfg, &selector)
    {
        return response;
    }
    let snapshot = match state.snapshot.read().clone() {
        Some(snapshot) => snapshot,
        None => return no_snapshot_error(InboundFormat::OpenAiChat),
    };
    let wait = Duration::from_millis(u64::from(cfg.concurrency_wait_ms));
    let _gateway_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => {
            return concurrency_rejected(&state, &ctx, InboundFormat::OpenAiChat, Some(&selector))
        }
    };
    let base = route_candidates(
        &state,
        &snapshot,
        &cfg,
        &selector,
        payload.text(),
        "gateway-media",
    )
    .await
    .into_iter()
    .filter(|candidate| matches!(candidate.provider.protocol.as_str(), "openai" | "responses"))
    .collect();
    let now = chrono::Utc::now().timestamp_millis();
    let candidates = expand_gateway_pools(&state, &cfg, base, now, ctx.session_id.as_deref());
    if candidates.is_empty() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no enabled OpenAI-compatible media provider serves this model",
        );
    }
    let video_slot = if operation == "/videos" {
        match state.media.reserve(ctx.account_generation) {
            Ok(slot) => Some(slot),
            Err(()) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "video follow-up registry is full; wait for existing IDs to expire",
                )
            }
        }
    } else {
        None
    };
    dispatch_create(
        &state, &ctx, &cfg, &selector, operation, &payload, restorer, candidates, video_slot,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_create(
    state: &AppState,
    ctx: &ReqCtx,
    cfg: &GatewayConfig,
    selector: &str,
    operation: &str,
    payload: &Payload,
    restorer: PrivacyRestorer,
    candidates: Vec<Candidate>,
    mut video_slot: Option<OwnedSemaphorePermit>,
) -> Response {
    let mut failures = Vec::new();
    let attempts = route_attempt_limit(
        cfg,
        &state
            .snapshot
            .read()
            .clone()
            .unwrap_or_else(crate::task_lease::empty_snapshot),
        candidates.len(),
    );
    let mut remaining_wait = cfg.max_retry_wait_ms;
    for (index, candidate) in candidates.iter().take(attempts).enumerate() {
        let started = Instant::now();
        let _upstream_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                Duration::from_millis(u64::from(cfg.concurrency_wait_ms)),
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push("upstream concurrency limit reached".into());
                continue;
            }
        };
        let _flight = state.in_flight.enter(&candidate.provider.id);
        let url = match media_url(&candidate.provider.base_url, operation, None) {
            Ok(url) => url,
            Err(message) => return error(StatusCode::BAD_REQUEST, &message),
        };
        let provider_body = match privacy::prepare_provider_body(
            state,
            ctx,
            candidate,
            rewrite_model(payload.text(), &candidate.model_id),
        )
        .await
        {
            Ok(body) => body,
            Err(response) => return *response,
        };
        let mut outgoing = payload.clone();
        match &mut outgoing {
            Payload::Json(body) => *body = provider_body,
            Payload::Form { text, .. } => *text = provider_body,
        }
        let request = match outgoing.request(&state.http, &url, &candidate.model_id) {
            Ok(request) => request,
            Err(message) => return error(StatusCode::BAD_REQUEST, &message),
        };
        let request = authorize(request, candidate, ctx, matches!(payload, Payload::Json(_)));
        let response = match apply_timeout(request, cfg).send().await {
            Ok(response) => response,
            Err(_) => {
                let message = "media upstream connection failed; request delivery is unknown";
                emit_outcome(
                    state.host.as_ref(),
                    candidate,
                    false,
                    started,
                    None,
                    Some(message),
                    None,
                    None,
                );
                // Creating media may have succeeded before the connection died.
                // Never duplicate a billable job after an ambiguous delivery.
                return logged_error(
                    state,
                    ctx,
                    InboundFormat::OpenAiChat,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    message,
                    Some(selector),
                );
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        let content_type = headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = match limited_bytes(
            response,
            if status.is_success() {
                RESPONSE_LIMIT
            } else {
                16 * 1024
            },
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(message) => {
                emit_outcome(
                    state.host.as_ref(),
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                return logged_error(
                    state,
                    ctx,
                    InboundFormat::OpenAiChat,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    &message,
                    Some(selector),
                );
            }
        };
        if !status.is_success() {
            let upstream_message = String::from_utf8_lossy(&bytes);
            let message = format!("media upstream returned HTTP {}", status.as_u16());
            let retry_after = headers
                .get("retry-after")
                .and_then(|value| value.to_str().ok());
            let cooldown = record_upstream_cooldown(
                state,
                cfg,
                candidate,
                status.as_u16(),
                retry_after,
                None,
                &upstream_message,
                chrono::Utc::now().timestamp_millis(),
            );
            emit_outcome(
                state.host.as_ref(),
                candidate,
                false,
                started,
                None,
                Some(&message),
                cooldown,
                None,
            );
            // Only a definite refusal is safe to move to another media account.
            let safe_to_retry = matches!(status.as_u16(), 404 | 405 | 429);
            if safe_to_retry && index + 1 < attempts {
                wait_before_retry(cfg, index, cooldown, &mut remaining_wait, true).await;
                failures.push(format!(
                    "{}: HTTP {}",
                    candidate.provider.id,
                    status.as_u16()
                ));
                continue;
            }
            emit_request_log_ctx(
                state.host.as_ref(),
                ctx,
                Some(selector),
                Some(&candidate.provider.id),
                status.as_u16(),
                started.elapsed().as_millis() as u64,
                None,
                None,
                Some(&message),
                false,
                Some(candidate),
            );
            return upstream_response(
                status,
                &headers,
                &content_type,
                restore_bytes(bytes, &content_type, &restorer),
            );
        }
        let json_content = content_type
            .split(';')
            .next()
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"));
        let (body, usage) = if json_content {
            let mut value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    return failed_response(
                        state,
                        ctx,
                        candidate,
                        selector,
                        started,
                        "media upstream returned invalid JSON",
                    )
                }
            };
            let usage = media_usage(&value, operation);
            let upstream_video_id = if operation == "/videos" {
                match value["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 1024)
                {
                    Some(id) => Some(id.to_string()),
                    None => {
                        return failed_response(
                            state,
                            ctx,
                            candidate,
                            selector,
                            started,
                            "video upstream returned no usable job ID",
                        )
                    }
                }
            } else {
                None
            };
            value = match privacy::transform_body(
                state,
                ctx,
                "gateway_middleware_response",
                value,
                Some(candidate),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return *response,
            };
            restorer.restore_json(&mut value);
            if operation == "/videos" {
                let upstream_id =
                    upstream_video_id.expect("video ID validated before extension hooks");
                let slot = video_slot
                    .take()
                    .expect("video creation reserved a follow-up slot");
                let id = state.media.insert(
                    VideoRoute {
                        key_id: ctx.key_id.clone().unwrap_or_default(),
                        account_generation: ctx.account_generation,
                        selector: selector.into(),
                        provider_id: candidate.provider.id.clone(),
                        deployment_id: candidate.provider.deployment_id.clone(),
                        model_id: candidate.model_id.clone(),
                        account_id: candidate.provider.selected_subscription_account_id.clone(),
                        credential_identity: video_credential_identity(candidate),
                        upstream_id,
                        created: Instant::now(),
                        restorer: restorer.clone(),
                    },
                    slot,
                );
                value["id"] = json!(id);
                value["model"] = json!(selector);
                value["gateway_expires_in_seconds"] = json!(VIDEO_TTL.as_secs());
            }
            (Bytes::from(value.to_string()), usage)
        } else {
            if operation == "/videos" {
                return failed_response(
                    state,
                    ctx,
                    candidate,
                    selector,
                    started,
                    "video creation requires a JSON job response",
                );
            }
            // ASR text/subtitles contain ordinary text; generated media remains binary.
            let bytes = restore_bytes(bytes, &content_type, &restorer);
            (bytes, (None, None))
        };
        emit_outcome(
            state.host.as_ref(),
            candidate,
            true,
            started,
            Some(usage),
            None,
            None,
            None,
        );
        log_success_status(
            state,
            ctx,
            selector,
            candidate,
            started.elapsed().as_millis() as u64,
            usage.0,
            usage.1,
            false,
            status.as_u16(),
        );
        return upstream_response(status, &headers, &content_type, body);
    }
    all_failed(state, ctx, InboundFormat::OpenAiChat, selector, &failures)
}

fn authorize(
    mut request: reqwest::RequestBuilder,
    candidate: &Candidate,
    ctx: &ReqCtx,
    json_body: bool,
) -> reqwest::RequestBuilder {
    for (name, value) in super::super::execute::upstream_headers_for(
        "openai",
        candidate.provider.transport.as_ref(),
        candidate.provider.api_key.as_deref(),
        None,
    ) {
        if name != "content-type" || json_body {
            request = request.header(name, value);
        }
    }
    for (name, value) in &ctx.inbound_headers {
        let transport = candidate.provider.transport.as_ref();
        let declared = transport.is_some_and(|transport| {
            transport
                .forwarded_semantic_headers
                .iter()
                .any(|extra| extra.eq_ignore_ascii_case(name))
        });
        let owned = transport.is_some_and(|transport| {
            transport
                .auth_header_name
                .as_deref()
                .is_some_and(|auth| auth.eq_ignore_ascii_case(name))
                || transport
                    .static_headers
                    .iter()
                    .any(|(header, _)| header.eq_ignore_ascii_case(name))
        });
        if !owned && (crate::header_policy::is_forwardable_semantic_header(name) || declared) {
            request = request.header(name, value);
        }
    }
    request
}

fn media_url(base: &str, operation: &str, id: Option<&str>) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "invalid media provider base URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("media upstream requires HTTP or HTTPS".into());
    }
    let path = format!("{}{}", url.path().trim_end_matches('/'), operation);
    url.set_path(&path);
    if let Some(id) = id {
        url.path_segments_mut()
            .map_err(|_| "invalid media provider path")?
            .push(id);
    }
    Ok(url.to_string())
}

fn media_usage(body: &Value, operation: &str) -> (Option<u64>, Option<u64>) {
    let usage = &body["usage"];
    let input = usage["input_tokens"]
        .as_u64()
        .or_else(|| usage["prompt_tokens"].as_u64())
        .or_else(|| {
            (operation == "/rerank")
                .then(|| usage["total_tokens"].as_u64())
                .flatten()
        });
    let output = usage["output_tokens"]
        .as_u64()
        .or_else(|| usage["completion_tokens"].as_u64())
        .or_else(|| (operation == "/rerank" && input.is_some()).then_some(0));
    (input, output)
}

fn restore_bytes(bytes: Bytes, content_type: &str, restorer: &PrivacyRestorer) -> Bytes {
    if content_type
        .split(';')
        .next()
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
    {
        if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
            restorer.restore_json(&mut value);
            return Bytes::from(value.to_string());
        }
    } else if content_type.starts_with("text/") || content_type.starts_with("application/x-subrip")
    {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            return Bytes::from(restorer.restore_text(text));
        }
    }
    bytes
}

fn failed_response(
    state: &AppState,
    ctx: &ReqCtx,
    candidate: &Candidate,
    selector: &str,
    started: Instant,
    message: &str,
) -> Response {
    emit_outcome(
        state.host.as_ref(),
        candidate,
        false,
        started,
        None,
        Some(message),
        None,
        None,
    );
    logged_error(
        state,
        ctx,
        InboundFormat::OpenAiChat,
        StatusCode::BAD_GATEWAY,
        "api_error",
        message,
        Some(selector),
    )
}

async fn limited_bytes(response: reqwest::Response, limit: usize) -> Result<Bytes, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = bytes::BytesMut::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "media response body failed")?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("media response exceeds the buffering limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.freeze())
}

fn upstream_response(
    status: StatusCode,
    headers: &HeaderMap,
    content_type: &str,
    bytes: Bytes,
) -> Response {
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    if let Ok(content_type) = HeaderValue::from_str(content_type) {
        response
            .headers_mut()
            .insert(axum::http::header::CONTENT_TYPE, content_type);
    }
    for (name, value) in safe_upstream_response_headers(headers) {
        if let (Ok(name), Ok(value)) = (
            axum::http::header::HeaderName::try_from(name),
            HeaderValue::try_from(value),
        ) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

async fn video_get(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Path(id): Path<String>,
) -> Response {
    video_followup(state, ctx, id, false, None).await
}

async fn video_content(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Path(id): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let variant = match video_variant(uri.query()) {
        Ok(variant) => variant,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    video_followup(state, ctx, id, true, variant).await
}

fn video_variant(query: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(query) = query else { return Ok(None) };
    let url = reqwest::Url::parse(&format!("http://gateway.invalid/?{query}"))
        .map_err(|_| "invalid video content query")?;
    let mut variant = None;
    for (name, value) in url.query_pairs() {
        if name != "variant" || variant.is_some() {
            return Err("video content accepts one variant parameter");
        }
        if !matches!(value.as_ref(), "video" | "thumbnail" | "spritesheet") {
            return Err("variant must be video, thumbnail or spritesheet");
        }
        variant = Some(value.into_owned());
    }
    Ok(variant)
}

async fn video_followup(
    state: AppState,
    ctx: ReqCtx,
    id: String,
    content: bool,
    variant: Option<String>,
) -> Response {
    let state = state.for_request(&ctx);
    if ctx.ticket.is_some() {
        return error(
            StatusCode::FORBIDDEN,
            "route tickets do not grant media operations",
        );
    }
    let route = match state.media.get(&id, &ctx) {
        Some(route) => route,
        None => {
            return error(
                StatusCode::NOT_FOUND,
                "video ID is unknown, expired, or belongs to another caller",
            )
        }
    };
    let cfg = state.config.read().clone();
    if let Some(response) = exposure_guard(
        &state,
        &ctx,
        InboundFormat::OpenAiChat,
        &cfg,
        &route.selector,
    ) {
        return response;
    }
    let snapshot = match state.snapshot.read().clone() {
        Some(snapshot) => snapshot,
        None => return no_snapshot_error(InboundFormat::OpenAiChat),
    };
    if !resolve_candidates(&snapshot, &route.selector)
        .iter()
        .any(|candidate| {
            candidate.provider.id == route.provider_id
                && candidate.provider.deployment_id == route.deployment_id
                && candidate.model_id == route.model_id
        })
    {
        return error(
            StatusCode::FORBIDDEN,
            "the video's original model route is no longer authorized",
        );
    }
    let provider = match snapshot.providers.iter().find(|provider| {
        provider.enabled
            && provider.id == route.provider_id
            && provider.deployment_id == route.deployment_id
            && matches!(provider.protocol.as_str(), "openai" | "responses")
    }) {
        Some(provider) => provider,
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "the video's original provider is unavailable",
            )
        }
    };
    let candidate = match video_original_candidate(provider, &route, &cfg) {
        Some(candidate) => candidate,
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "the video's original credential is unavailable",
            )
        }
    };
    let mut url = match media_url(
        &candidate.provider.base_url,
        "/videos",
        Some(&route.upstream_id),
    ) {
        Ok(url) => url,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    if content {
        let mut parsed = reqwest::Url::parse(&url).expect("media_url returned a parsed URL");
        parsed
            .path_segments_mut()
            .expect("HTTP URL has path segments")
            .push("content");
        if let Some(variant) = variant {
            parsed.query_pairs_mut().append_pair("variant", &variant);
        }
        url = parsed.to_string();
    }
    let wait = Duration::from_millis(u64::from(cfg.concurrency_wait_ms));
    let gateway_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => {
            return concurrency_rejected(
                &state,
                &ctx,
                InboundFormat::OpenAiChat,
                Some(&route.selector),
            )
        }
    };
    let upstream_slot = match state
        .concurrency
        .acquire(
            &up_gate_key(&candidate),
            cfg.max_concurrent_per_upstream_key,
            wait,
        )
        .await
    {
        Ok(slot) => slot,
        Err(()) => {
            return concurrency_rejected(
                &state,
                &ctx,
                InboundFormat::OpenAiChat,
                Some(&route.selector),
            )
        }
    };
    let flight = state.in_flight.enter(&candidate.provider.id);
    let started = Instant::now();
    let response = match apply_timeout(
        authorize(
            state.http.client_for(&url).get(&url),
            &candidate,
            &ctx,
            false,
        ),
        &cfg,
    )
    .send()
    .await
    {
        Ok(response) => response,
        Err(_) => {
            return failed_response(
                &state,
                &ctx,
                &candidate,
                &route.selector,
                started,
                "video follow-up upstream failed",
            )
        }
    };
    let status = response.status();
    let headers = response.headers().clone();
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    if content && status.is_success() {
        let log = VideoDownloadLog {
            state: state.clone(),
            ctx: ctx.clone(),
            candidate: candidate.clone(),
            selector: route.selector.clone(),
            started,
            status: status.as_u16(),
            finished: false,
        };
        let stream = futures_util::stream::unfold(
            Some((
                response.bytes_stream(),
                (gateway_slot, upstream_slot, flight),
                log,
            )),
            |state| async move {
                let (mut stream, guards, mut log) = state?;
                match stream.next().await {
                    Some(Ok(chunk)) => Some((Ok(chunk), Some((stream, guards, log)))),
                    Some(Err(error)) => {
                        log.finish(Some("video download response body failed"));
                        Some((Err(error), None))
                    }
                    None => {
                        log.finish(None);
                        None
                    }
                }
            },
        );
        let mut result = Response::new(Body::from_stream(stream));
        *result.status_mut() = status;
        if let Ok(value) = HeaderValue::from_str(&content_type) {
            result
                .headers_mut()
                .insert(axum::http::header::CONTENT_TYPE, value);
        }
        for (name, value) in safe_upstream_response_headers(&headers) {
            if let (Ok(name), Ok(value)) = (
                axum::http::header::HeaderName::try_from(name),
                HeaderValue::try_from(value),
            ) {
                result.headers_mut().insert(name, value);
            }
        }
        return result;
    }
    let bytes = match limited_bytes(response, RESPONSE_LIMIT).await {
        Ok(bytes) => bytes,
        Err(message) => {
            return failed_response(&state, &ctx, &candidate, &route.selector, started, &message)
        }
    };
    if !status.is_success() {
        video_followup_terminal(
            &state,
            &ctx,
            &candidate,
            &route.selector,
            started,
            status.as_u16(),
            Some("video follow-up upstream rejected the request"),
            content,
        );
        return upstream_response(
            status,
            &headers,
            &content_type,
            restore_bytes(bytes, &content_type, &route.restorer),
        );
    }
    let mut value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return failed_response(
                &state,
                &ctx,
                &candidate,
                &route.selector,
                started,
                "video upstream returned invalid JSON",
            )
        }
    };
    value = match privacy::transform_body(
        &state,
        &ctx,
        "gateway_middleware_response",
        value,
        Some(&candidate),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    route.restorer.restore_json(&mut value);
    if value.get("id").is_some() {
        value["id"] = json!(id);
    }
    if value.get("model").is_some() {
        value["model"] = json!(&route.selector);
    }
    video_followup_terminal(
        &state,
        &ctx,
        &candidate,
        &route.selector,
        started,
        status.as_u16(),
        None,
        false,
    );
    upstream_response(
        status,
        &headers,
        &content_type,
        Bytes::from(value.to_string()),
    )
}

fn video_credential_identity(candidate: &Candidate) -> String {
    let transport = candidate.provider.transport.as_ref();
    crate::credentials::lease_identity_of(
        &json!({
            "credential":crate::execute::candidate_credential_identity(candidate),
            "base":candidate.provider.base_url,"protocol":candidate.provider.protocol,
            "auth":transport.map(|transport|(&transport.auth_scheme,&transport.auth_header_name)),
            "headers":transport.map(|transport|&transport.static_headers),
        })
        .to_string(),
    )
}

fn video_original_candidate(
    provider: &crate::snapshot::ProviderSnapshot,
    route: &VideoRoute,
    cfg: &GatewayConfig,
) -> Option<Candidate> {
    let candidates = if let Some(account_id) = &route.account_id {
        if let Some(pool) = &provider.subscription_pool {
            let source = provider
                .source_provider_id
                .as_deref()
                .unwrap_or(&provider.id);
            if !cfg
                .subscription_rotation_provider_ids
                .iter()
                .any(|id| id == source)
            {
                return None;
            }
            pool.accounts
                .iter()
                .filter(|account| {
                    &account.account_id == account_id
                        && account
                            .expires_at_ms
                            .is_none_or(|expiry| expiry > chrono::Utc::now().timestamp_millis())
                })
                .map(|account| {
                    crate::execute::subscription_account_candidate(
                        provider,
                        account,
                        &route.model_id,
                    )
                })
                .collect::<Vec<_>>()
        } else if provider.selected_subscription_account_id.as_ref() == Some(account_id) {
            vec![Candidate::new(provider, &route.model_id)]
        } else {
            Vec::new()
        }
    } else {
        let credentials = if provider.rotation_enabled && !provider.api_keys.is_empty() {
            provider.api_keys.clone()
        } else {
            vec![provider.api_key.clone().unwrap_or_default()]
        };
        credentials
            .into_iter()
            .map(|credential| {
                let mut candidate = Candidate::new(provider, &route.model_id);
                candidate.provider.api_key = (!credential.is_empty()).then_some(credential);
                candidate
            })
            .collect()
    };
    candidates
        .into_iter()
        .find(|candidate| video_credential_identity(candidate) == route.credential_identity)
}

#[allow(clippy::too_many_arguments)]
fn video_followup_terminal(
    state: &AppState,
    ctx: &ReqCtx,
    candidate: &Candidate,
    selector: &str,
    started: Instant,
    status: u16,
    error: Option<&str>,
    stream: bool,
) {
    emit_outcome(
        state.host.as_ref(),
        candidate,
        error.is_none(),
        started,
        None,
        error,
        None,
        None,
    );
    emit_request_log_ctx(
        state.host.as_ref(),
        ctx,
        Some(selector),
        Some(&candidate.provider.id),
        status,
        started.elapsed().as_millis() as u64,
        None,
        None,
        error,
        stream,
        Some(candidate),
    );
}

struct VideoDownloadLog {
    state: AppState,
    ctx: ReqCtx,
    candidate: Candidate,
    selector: String,
    started: Instant,
    status: u16,
    finished: bool,
}

impl VideoDownloadLog {
    fn finish(&mut self, error: Option<&str>) {
        if !self.finished {
            self.finished = true;
            video_followup_terminal(
                &self.state,
                &self.ctx,
                &self.candidate,
                &self.selector,
                self.started,
                self.status,
                error,
                true,
            );
        }
    }
}

impl Drop for VideoDownloadLog {
    fn drop(&mut self) {
        self.finish(Some(
            "video download ended before the response body completed",
        ));
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(error_body(
            InboundFormat::OpenAiChat,
            "invalid_request_error",
            message,
        )),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::super::router_fusion_server_tests as fixture;
    use super::*;
    use crate::brain_bridge::{BrainBridge, BrainFuture};

    struct PiiInjectingProvider {
        field: &'static str,
        provider_inputs: Arc<parking_lot::Mutex<Vec<Value>>>,
    }

    impl BrainBridge for PiiInjectingProvider {
        fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
            let field = self.field;
            let inputs = self.provider_inputs.clone();
            Box::pin(async move {
                let mut body = payload["body"].clone();
                if command == "gateway_privacy_prepare" {
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
                } else {
                    if command == "gateway_middleware_provider" {
                        inputs.lock().push(body.clone());
                        body[field] = if field == "documents" {
                            json!(["me@example.com"])
                        } else {
                            json!("me@example.com")
                        };
                    }
                    Ok(json!({"body":body}))
                }
            })
        }
    }

    #[tokio::test]
    async fn mounted_media_provider_cannot_reintroduce_pii_after_request_masking() {
        let upstream = upstream(StatusCode::OK).await;
        for (field, path, body) in [
            (
                "prompt",
                "/v1/images/generations",
                json!({"model":"image-route","prompt":"me@example.com"}),
            ),
            (
                "query",
                "/v1/rerank",
                json!({"model":"rerank-route","query":"me@example.com","documents":["safe"]}),
            ),
            (
                "documents",
                "/v1/rerank",
                json!({"model":"rerank-route","query":"safe","documents":["me@example.com"]}),
            ),
        ] {
            let inputs = Arc::new(parking_lot::Mutex::new(Vec::new()));
            let mut gateway = gateway(&[&upstream]);
            gateway.state.runs = crate::runs::RunsState::new(Arc::new(PiiInjectingProvider {
                field,
                provider_inputs: inputs.clone(),
            }));
            {
                let mut config = gateway.state.config.write();
                config.privacy_mode = crate::types::GatewayPrivacyMode::Mask;
                config.middleware_enabled = true;
            }
            gateway.app = app_router(gateway.state.clone());
            let response = fixture::send(
                &gateway.app,
                fixture::request("POST", path, Some(fixture::SECRET), Some(body)),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "provider field {field} must be checked after masking"
            );
            assert!(fixture::json_of(response).await["error"]["message"]
                .as_str()
                .unwrap()
                .contains("sensitive data"));
            let inputs = inputs.lock();
            assert_eq!(
                inputs.len(),
                1,
                "provider extension must run after the mask stage"
            );
            assert!(inputs[0].to_string().contains("<EMAIL_001>"));
            assert!(!inputs[0].to_string().contains("me@example.com"));
            assert!(
                upstream.seen.lock().is_empty(),
                "provider extension must never leak {field} upstream"
            );
        }
    }

    struct TestUpstream {
        address: SocketAddr,
        seen: Arc<parking_lot::Mutex<Vec<Value>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestUpstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream(image_status: StatusCode) -> TestUpstream {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let images_seen = seen.clone();
        let videos_seen = seen.clone();
        let audio_seen = seen.clone();
        let rerank_seen = seen.clone();
        let speech_seen = seen.clone();
        let app = Router::new()
            .route("/v1/images/generations", post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let captured = images_seen.clone();
                async move {
                    captured.lock().push(json!({"kind":"image","body":body,"auth":headers.get("x-provider-auth").and_then(|value|value.to_str().ok()),"tenant":headers.get("x-tenant-id").and_then(|value|value.to_str().ok()),"cookie":headers.get("cookie").and_then(|value|value.to_str().ok())}));
                    (image_status, Json(if image_status.is_success() { json!({"data":[{"b64_json":"aW1hZ2U="}],"usage":{"input_tokens":3,"output_tokens":2}}) } else { json!({"error":{"message":"upstream rejected"}}) }))
                }
            }))
            .route("/v1/videos", post(move |Json(body): Json<Value>| {
                let captured = videos_seen.clone();
                async move { captured.lock().push(json!({"kind":"video","body":body})); (StatusCode::ACCEPTED, Json(json!({"id":"vendor-job","model":"video-native","status":"queued"}))) }
            }))
            .route("/v1/videos/vendor-job", get(|| async { Json(json!({"id":"vendor-job","model":"video-native","status":"completed"})) }))
            .route("/v1/videos/vendor-job/content", get(|| async { ([(axum::http::header::CONTENT_TYPE, "video/mp4")], Bytes::from_static(&[0,1,255,3])) }))
            .route("/v1/rerank", post(move |Json(body): Json<Value>| {
                let captured = rerank_seen.clone();
                async move { captured.lock().push(json!({"kind":"rerank","body":body})); Json(json!({"results":[{"index":1,"relevance_score":0.9}],"usage":{"total_tokens":7}})) }
            }))
            .route("/v1/audio/speech", post(move |Json(body): Json<Value>| {
                let captured = speech_seen.clone();
                async move { captured.lock().push(json!({"kind":"speech","body":body})); ([(axum::http::header::CONTENT_TYPE,"audio/mpeg")],Bytes::from_static(&[0,255,1,3])) }
            }))
            .route("/v1/audio/transcriptions", post(move |mut form: Multipart| {
                let captured = audio_seen.clone();
                async move {
                    let mut values = Vec::new();
                    while let Some(field) = form.next_field().await.unwrap() {
                        let name = field.name().unwrap().to_string();
                        let filename = field.file_name().map(str::to_string);
                        let content_type = field.content_type().map(str::to_string);
                        let bytes = field.bytes().await.unwrap();
                        values.push(json!({"name":name,"filename":filename,"contentType":content_type,"bytes":bytes.to_vec()}));
                    }
                    captured.lock().push(json!({"kind":"audio","fields":values}));
                    Json(json!({"text":"transcribed"}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        TestUpstream {
            address,
            seen,
            task,
        }
    }

    fn gateway(upstreams: &[&TestUpstream]) -> fixture::Gateway {
        let providers: Vec<Value> = upstreams.iter().enumerate().map(|(index,upstream)| json!({
            "id":format!("media-{index}"),"protocol":"openai","enabled":true,"baseUrl":format!("http://{}/v1",upstream.address),"apiKey":"media-secret",
            "models":["image-native","video-native","audio-native","rerank-native"],"transport":{"authScheme":"custom-header","authHeaderName":"x-provider-auth","staticHeaders":[["x-tenant-id","chosen-tenant"]]}
        })).collect();
        let aliases: Vec<Value> = [("image-route","image-native"),("video-route","video-native"),("audio-route","audio-native"),("rerank-route","rerank-native")].iter().map(|(alias,model)| json!({"alias":alias,"entries":(0..upstreams.len()).map(|index|json!({"providerId":format!("media-{index}"),"modelId":model})).collect::<Vec<_>>()})).collect();
        let snapshot = serde_json::from_value(
            json!({"providers":providers,"aliases":aliases,"generatedAtMs":1}),
        )
        .unwrap();
        fixture::gateway_with(
            Arc::new(crate::brain_bridge::RecordingBrainBridge::new()),
            false,
            false,
            Some(snapshot),
        )
    }

    #[tokio::test]
    async fn mounted_image_route_rewrites_model_and_preserves_authorized_transport() {
        let upstream = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&upstream]);
        let mut incoming = fixture::request(
            "POST",
            "/v1/images/generations",
            Some(fixture::SECRET),
            Some(json!({"model":"image-route","prompt":"a bird"})),
        );
        incoming
            .headers_mut()
            .insert("cookie", "session=caller".parse().unwrap());
        let response = fixture::send(&gateway.app, incoming).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fixture::json_of(response).await["data"][0]["b64_json"],
            "aW1hZ2U="
        );
        let seen = upstream.seen.lock();
        assert_eq!(seen[0]["body"]["model"], "image-native");
        assert_eq!(seen[0]["auth"], "media-secret");
        assert_eq!(seen[0]["tenant"], "chosen-tenant");
        assert!(seen[0]["cookie"].is_null());
        assert_eq!(
            gateway
                .state
                .keys
                .read()
                .iter()
                .find(|key| key.secret == fixture::SECRET)
                .unwrap()
                .quota_used_tokens,
            5
        );
    }

    #[tokio::test]
    async fn mounted_media_telemetry_stays_bound_to_the_authenticated_account() {
        let upstream = upstream(StatusCode::OK).await;
        let mut gateway = gateway(&[&upstream]);
        let host = Arc::new(crate::host::RecordingGatewayHost::new(false));
        gateway.state.host = host.clone();
        *gateway.state.account.write() = crate::GatewayAccountContext {
            owner_account_id: Some("signed-in-account".into()),
            generation: 0,
            required: true,
        };
        for key in gateway.state.keys.write().iter_mut() {
            key.owner_account_id = Some("signed-in-account".into());
        }
        gateway.app = app_router(gateway.state.clone());
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/v1/images/generations",
                Some(fixture::SECRET),
                Some(json!({"model":"image-route","prompt":"bird"})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let events = host.events.lock();
        let telemetry: Vec<&Value> = events
            .iter()
            .filter(|(name, _)| name == REQUEST_LOG_EVENT || name == REQUEST_OUTCOME_EVENT)
            .map(|(_, value)| value)
            .collect();
        assert_eq!(telemetry.len(), 2);
        for event in telemetry {
            assert_eq!(event["ownerAccountId"], "signed-in-account");
            assert_eq!(event["accountGeneration"], 0);
        }
    }

    #[tokio::test]
    async fn mounted_media_routes_require_auth_and_block_disallowed_models_before_dispatch() {
        let upstream = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&upstream]);
        for (method, path) in [
            ("POST", "/v1/images/generations"),
            ("POST", "/v1/images/edits"),
            ("POST", "/v1/audio/transcriptions"),
            ("POST", "/v1/audio/translations"),
            ("POST", "/v1/audio/speech"),
            ("POST", "/v1/rerank"),
            ("POST", "/v1/videos"),
            ("GET", "/v1/videos/unknown"),
            ("GET", "/v1/videos/unknown/content"),
        ] {
            let response =
                fixture::send(&gateway.app, fixture::request(method, path, None, None)).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
        gateway
            .state
            .keys
            .write()
            .iter_mut()
            .find(|key| key.secret == fixture::SECRET)
            .unwrap()
            .model_allowlist = vec!["some-other-model".into()];
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/v1/images/generations",
                Some(fixture::SECRET),
                Some(json!({"model":"image-route","prompt":"bird"})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(upstream.seen.lock().is_empty());
    }

    #[tokio::test]
    async fn mounted_rerank_preserves_documents_and_accounts_reported_input_usage() {
        let upstream = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&upstream]);
        let response = fixture::send(&gateway.app, fixture::request("POST", "/v1/rerank", Some(fixture::SECRET), Some(json!({"model":"rerank-route","query":"bird","documents":["dog","bird"],"top_n":1})))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(fixture::json_of(response).await["results"][0]["index"], 1);
        let seen = upstream.seen.lock();
        assert_eq!(seen[0]["body"]["model"], "rerank-native");
        assert_eq!(seen[0]["body"]["documents"], json!(["dog", "bird"]));
        assert_eq!(seen[0]["body"]["top_n"], 1);
        assert_eq!(
            gateway
                .state
                .keys
                .read()
                .iter()
                .find(|key| key.secret == fixture::SECRET)
                .unwrap()
                .quota_used_tokens,
            7
        );
    }

    #[tokio::test]
    async fn mounted_speech_preserves_audio_bytes_and_speech_parameters() {
        let upstream = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&upstream]);
        let response = fixture::send(&gateway.app, fixture::request("POST", "/v1/audio/speech", Some(fixture::SECRET), Some(json!({"model":"audio-route","input":"hello","voice":"alloy","speed":1.2,"response_format":"mp3"})))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "audio/mpeg");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .as_ref(),
            &[0, 255, 1, 3]
        );
        let seen = upstream.seen.lock();
        assert_eq!(seen[0]["body"]["model"], "audio-native");
        assert_eq!(seen[0]["body"]["input"], "hello");
        assert_eq!(seen[0]["body"]["voice"], "alloy");
        assert_eq!(seen[0]["body"]["speed"], 1.2);
        assert_eq!(seen[0]["body"]["response_format"], "mp3");
    }

    #[tokio::test]
    async fn mounted_media_does_not_retry_ambiguous_server_failures() {
        let first = upstream(StatusCode::INTERNAL_SERVER_ERROR).await;
        let second = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&first, &second]);
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/v1/images/generations",
                Some(fixture::SECRET),
                Some(json!({"model":"image-route","prompt":"a bird"})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(first.seen.lock().len(), 1);
        assert!(second.seen.lock().is_empty());
    }

    #[tokio::test]
    async fn mounted_video_ids_support_poll_download_and_reject_other_callers_or_changed_routes() {
        let upstream = upstream(StatusCode::OK).await;
        let mut gateway = gateway(&[&upstream]);
        let host = Arc::new(crate::host::RecordingGatewayHost::new(false));
        gateway.state.host = host.clone();
        gateway.app = app_router(gateway.state.clone());
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/v1/videos",
                Some(fixture::SECRET),
                Some(json!({"model":"video-route","prompt":"a bird"})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = fixture::json_of(response).await;
        let id = body["id"].as_str().unwrap();
        assert!(id.starts_with("cognia_video_"));
        let path = format!("/v1/videos/{id}");
        let response = fixture::send(
            &gateway.app,
            fixture::request("GET", &path, Some(fixture::SECRET), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(fixture::json_of(response).await["id"], id);
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "GET",
                &format!("{path}/content"),
                Some(fixture::SECRET),
                None,
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .as_ref(),
            &[0, 1, 255, 3]
        );
        {
            let events = host.events.lock();
            let logs: Vec<&Value> = events
                .iter()
                .filter(|(event, _)| event == REQUEST_LOG_EVENT)
                .map(|(_, payload)| payload)
                .collect();
            assert_eq!(logs.len(), 3);
            assert_eq!(logs[0]["status"], 202);
            assert!(logs
                .iter()
                .all(|log| log["inputTokens"].is_null() && log["outputTokens"].is_null()));
            let outcomes: Vec<&Value> = events
                .iter()
                .filter(|(event, _)| event == REQUEST_OUTCOME_EVENT)
                .map(|(_, payload)| payload)
                .collect();
            assert_eq!(outcomes.len(), 3);
            assert!(outcomes.iter().all(|outcome| outcome["ok"] == true));
        }
        let other = {
            gateway
                .state
                .keys
                .read()
                .iter()
                .find(|key| {
                    key.secret != fixture::SECRET
                        && key.model_allowlist.is_empty()
                        && key.quota_tokens.is_none()
                })
                .unwrap()
                .secret
                .clone()
        };
        let response = fixture::send(
            &gateway.app,
            fixture::request("GET", &path, Some(&other), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        gateway
            .state
            .snapshot
            .write()
            .as_mut()
            .unwrap()
            .aliases
            .iter_mut()
            .find(|alias| alias.alias == "video-route")
            .unwrap()
            .entries
            .clear();
        let response = fixture::send(
            &gateway.app,
            fixture::request("GET", &path, Some(fixture::SECRET), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn mounted_audio_route_keeps_file_bytes_name_type_and_model() {
        let upstream = upstream(StatusCode::OK).await;
        let gateway = gateway(&[&upstream]);
        for filename in [Some("voice.wav"), None] {
            let filename_header = filename
                .map(|name| format!("; filename=\"{name}\""))
                .unwrap_or_default();
            let mut bytes = format!("--test-boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\naudio-route\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"file\"{filename_header}\r\nContent-Type: audio/wav\r\n\r\n").into_bytes();
            bytes.extend_from_slice(&[0, 1, 255, 3]);
            bytes.extend_from_slice(b"\r\n--test-boundary--\r\n");
            let mut incoming = fixture::request(
                "POST",
                "/v1/audio/transcriptions",
                Some(fixture::SECRET),
                None,
            );
            incoming.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                "multipart/form-data; boundary=test-boundary"
                    .parse()
                    .unwrap(),
            );
            *incoming.body_mut() = Body::from(bytes);
            let response = fixture::send(&gateway.app, incoming).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(fixture::json_of(response).await["text"], "transcribed");
        }
        let seen = upstream.seen.lock();
        assert_eq!(seen.len(), 2);
        for (index, request) in seen.iter().enumerate() {
            let fields = request["fields"].as_array().unwrap();
            let file = fields.iter().find(|field| field["name"] == "file").unwrap();
            assert_eq!(
                file["filename"],
                if index == 0 {
                    json!("voice.wav")
                } else {
                    Value::Null
                }
            );
            assert_eq!(file["contentType"], "audio/wav");
            assert_eq!(file["bytes"], json!([0, 1, 255, 3]));
            let model = fields
                .iter()
                .find(|field| field["name"] == "model")
                .unwrap();
            assert_eq!(model["bytes"], json!("audio-native".as_bytes()));
        }
    }

    fn context(key: &str, generation: u64) -> ReqCtx {
        ReqCtx {
            account_generation: generation,
            request_id: "request".into(),
            route: "/v1/videos".into(),
            remote_ip: "127.0.0.1".into(),
            key_id: Some(key.into()),
            key_model_allowlist: Vec::new(),
            user_agent: "test".into(),
            session_id: None,
            body_prepared: false,
            gateway_slot: None,
            ticket: None,
            inbound_headers: Vec::new(),
        }
    }

    fn video_route() -> VideoRoute {
        VideoRoute {
            key_id: "owner".into(),
            account_generation: 3,
            selector: "video-alias".into(),
            provider_id: "provider".into(),
            deployment_id: Some("deployment".into()),
            model_id: "video-model".into(),
            account_id: None,
            credential_identity: "opaque".into(),
            upstream_id: "vendor-job".into(),
            created: Instant::now(),
            restorer: PrivacyRestorer::default(),
        }
    }

    #[test]
    fn video_ids_are_caller_and_account_generation_scoped() {
        let state = MediaState::default();
        let id = state.insert(video_route(), state.reserve(3).unwrap());
        assert!(state.get(&id, &context("owner", 3)).is_some());
        assert!(state.get(&id, &context("other", 3)).is_none());
        assert!(state.get(&id, &context("owner", 4)).is_none());
        assert!(MediaState::default()
            .get(&id, &context("owner", 3))
            .is_none());
    }

    #[test]
    fn expired_video_ids_release_capacity() {
        let state = MediaState::default();
        let mut route = video_route();
        route.created = Instant::now() - VIDEO_TTL - Duration::from_secs(1);
        let id = state.insert(route, state.reserve(3).unwrap());
        assert!(state.get(&id, &context("owner", 3)).is_none());
        assert_eq!(state.slots.available_permits(), VIDEO_CAPACITY);
    }

    #[test]
    fn video_ids_cannot_replace_the_upstream_authority_or_path() {
        let url = media_url(
            "https://provider.invalid/v1",
            "/videos",
            Some("https://evil.invalid/a?b=1"),
        )
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("provider.invalid"));
        assert!(parsed.path().starts_with("/v1/videos/https:"));
        assert!(parsed.path().contains("%2F"));
        assert!(parsed.query().is_none());
    }

    #[test]
    fn video_content_variants_are_preserved_and_unknown_or_duplicate_controls_fail() {
        assert_eq!(
            video_variant(Some("variant=thumbnail")).unwrap(),
            Some("thumbnail".into())
        );
        assert_eq!(video_variant(None).unwrap(), None);
        assert!(video_variant(Some("variant=video&variant=thumbnail")).is_err());
        assert!(video_variant(Some("variant=secret")).is_err());
        assert!(video_variant(Some("unknown=true")).is_err());
    }

    #[test]
    fn usage_preserves_unknown_values_and_rerank_has_no_generated_tokens() {
        assert_eq!(media_usage(&json!({}), "/images/generations"), (None, None));
        assert_eq!(
            media_usage(
                &json!({"usage":{"input_tokens":5,"output_tokens":2}}),
                "/images/generations"
            ),
            (Some(5), Some(2))
        );
        assert_eq!(
            media_usage(&json!({"usage":{"total_tokens":7}}), "/rerank"),
            (Some(7), Some(0))
        );
    }

    #[tokio::test]
    async fn multipart_preserves_binary_bytes_filename_type_and_prepared_text() {
        let fields = vec![
            FormField {
                name: "model".into(),
                filename: None,
                content_type: None,
                bytes: Bytes::from_static(b"alias"),
            },
            FormField {
                name: "prompt".into(),
                filename: None,
                content_type: None,
                bytes: Bytes::from_static(b"private"),
            },
            FormField {
                name: "file".into(),
                filename: Some("voice.wav".into()),
                content_type: Some("audio/wav".into()),
                bytes: Bytes::from_static(&[0, 1, 255, 3]),
            },
        ];
        let payload = Payload::Form {
            fields,
            text: json!({"model":"alias","prompt":"<EMAIL_001>"}),
        };
        let clients = UpstreamClients::new(Duration::from_secs(1));
        let request = payload
            .request(
                &clients,
                "http://127.0.0.1/v1/audio/transcriptions",
                "whisper-model",
            )
            .unwrap()
            .build()
            .unwrap();
        let body = request.body().unwrap();
        assert!(
            body.as_bytes().is_none(),
            "multipart is streamed rather than decoded as UTF-8"
        );
        assert!(request.headers()[axum::http::header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
    }
}
