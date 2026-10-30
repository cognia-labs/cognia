//! Ollama wire adapters over the gateway's existing inference path.
//!
//! The gateway does not own model weights or an Ollama residency process.
//! Unknown weight metadata is omitted, and residency/template controls fail
//! explicitly instead of being accepted without effect.

use super::*;
use std::collections::{BTreeMap, VecDeque};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/version", get(version))
        .route("/api/tags", get(tags))
        .route("/api/show", post(show))
        .route("/api/chat", post(chat))
        .route("/api/generate", post(generate))
}

/// Keep failures emitted by the outer shared auth/body/rate middleware in the
/// same wire shape as failures emitted by these handlers.
pub(super) async fn error_envelope(request: axum::extract::Request, next: Next) -> Response {
    let ollama = request.uri().path().starts_with("/api/");
    let response = next.run(request).await;
    if ollama && (response.status().is_client_error() || response.status().is_server_error()) {
        ollama_error_response(response).await
    } else {
        response
    }
}

async fn version() -> Json<Value> {
    Json(json!({ "version": env!("CARGO_PKG_VERSION"), "server": "cognia-gateway" }))
}

async fn catalog(
    state: AppState,
    ctx: ReqCtx,
    actor: Option<Extension<crate::runs::RunActor>>,
) -> Result<Vec<Value>, Box<Response>> {
    let response = list_models(State(state), Extension(ctx), actor).await;
    if !response.status().is_success() {
        return Err(Box::new(ollama_error_response(response).await));
    }
    let bytes = axum::body::to_bytes(response.into_body(), BODY_LIMIT_BYTES)
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "could not read the model catalog"))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "invalid model catalog"))?;
    body["data"]
        .as_array()
        .cloned()
        .ok_or_else(|| Box::new(error(StatusCode::BAD_GATEWAY, "invalid model catalog")))
}

async fn tags(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
) -> Response {
    match catalog(state, ctx, actor).await {
        Ok(models) => {
            Json(json!({ "models": models.iter().map(tag_document).collect::<Vec<_>>() }))
                .into_response()
        }
        Err(response) => *response,
    }
}

fn tag_document(model: &Value) -> Value {
    let mut document = json!({ "name": model["id"], "model": model["id"] });
    for field in ["modified_at", "size", "digest", "details"] {
        if let Some(value) = model.get(field) {
            document[field] = value.clone();
        }
    }
    document
}

async fn show(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(name) = body["model"].as_str().or_else(|| body["name"].as_str()) else {
        return error(StatusCode::BAD_REQUEST, "model is required");
    };
    let models = match catalog(state, ctx, actor).await {
        Ok(models) => models,
        Err(response) => return *response,
    };
    let found = models.iter().find(|model| model["id"] == name).or_else(|| {
        name.strip_suffix(":latest")
            .and_then(|bare| models.iter().find(|model| model["id"] == bare))
    });
    match found {
        Some(model) => Json(show_document(model)).into_response(),
        None => error(
            StatusCode::NOT_FOUND,
            "model is not available to this caller",
        ),
    }
}

fn show_document(model: &Value) -> Value {
    let mut capabilities = Vec::new();
    if model["kind"] == "embedding" {
        capabilities.push("embedding");
    } else {
        capabilities.push("completion");
    }
    for (field, capability) in [
        ("supportsTools", "tools"),
        ("supportsVision", "vision"),
        ("supportsReasoning", "thinking"),
    ] {
        if model[field] == true {
            capabilities.push(capability);
        }
    }
    let mut info = model["model_info"].as_object().cloned().unwrap_or_default();
    if let Some(context) = model["context_length"]
        .as_u64()
        .or_else(|| model["contextLength"].as_u64())
    {
        info.insert("context_length".into(), json!(context));
        if let Some(architecture) = info
            .get("general.architecture")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            info.insert(format!("{architecture}.context_length"), json!(context));
        }
    }
    let mut result = json!({ "capabilities": capabilities, "model_info": info });
    for field in [
        "details",
        "license",
        "parameters",
        "template",
        "system",
        "thinking",
    ] {
        if let Some(value) = model.get(field) {
            result[field] = value.clone();
        }
    }
    if let Some(levels) = model
        .get("supportedReasoningEfforts")
        .or_else(|| model.get("reasoning_levels"))
    {
        result["thinking"] = json!({ "supported": levels });
    }
    result
}

async fn chat(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    inference(state, ctx, actor, headers, body, false).await
}

async fn generate(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    inference(state, ctx, actor, headers, body, true).await
}

async fn inference(
    state: AppState,
    ctx: ReqCtx,
    actor: Option<Extension<crate::runs::RunActor>>,
    headers: HeaderMap,
    mut body: Value,
    generate: bool,
) -> Response {
    if let Some(bare) = body["model"]
        .as_str()
        .and_then(|name| name.strip_suffix(":latest"))
        .map(str::to_string)
    {
        match catalog(state.clone(), ctx.clone(), actor.clone()).await {
            Ok(models) => {
                if !models.iter().any(|model| model["id"] == body["model"])
                    && models.iter().any(|model| model["id"] == bare)
                {
                    body["model"] = json!(bare);
                }
            }
            Err(response) => return *response,
        }
    }
    let converted = match request_to_chat(&body, generate) {
        Ok(converted) => converted,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    let stream = converted["stream"] == true;
    let model = converted["model"].as_str().unwrap_or_default().to_string();
    let started = Instant::now();
    let response = openai_chat(
        State(state),
        Extension(ctx),
        actor,
        headers,
        Json(converted),
    )
    .await;
    if !response.status().is_success() {
        return ollama_error_response(response).await;
    }
    if stream {
        return stream_response(response, model, generate, started);
    }
    let (mut parts, response_body) = response.into_parts();
    let bytes = match axum::body::to_bytes(response_body, BODY_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "could not read upstream response"),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "upstream returned invalid JSON"),
    };
    let value = match response_from_chat(&value, &model, generate, started.elapsed()) {
        Ok(value) => value,
        Err(message) => return error(StatusCode::BAD_GATEWAY, &message),
    };
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    parts.headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(value.to_string()))
}

fn request_to_chat(body: &Value, generate: bool) -> Result<Value, String> {
    let model = body["model"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .ok_or("model is required")?;
    if !body.is_object() {
        return Err("request must be an object".into());
    }
    for unsupported in ["keep_alive", "template", "context", "suffix"] {
        if body.get(unsupported).is_some_and(|value| !value.is_null()) {
            return Err(format!("{unsupported} controls an Ollama model process and cannot be applied by this gateway"));
        }
    }
    if body["raw"] == true {
        return Err("raw prompt templating requires a native Ollama upstream".into());
    }
    let stream = match body.get("stream") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(value)) => *value,
        _ => return Err("stream must be a boolean".into()),
    };
    let mut messages = if generate {
        let prompt = body
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or("prompt must be a string")?;
        let mut messages = Vec::new();
        if let Some(system) = body.get("system") {
            let system = system.as_str().ok_or("system must be a string")?;
            messages.push(json!({ "role": "system", "content": system }));
        }
        messages.push(json!({ "role": "user", "content": prompt, "images": body.get("images").cloned().unwrap_or(Value::Null) }));
        messages
    } else {
        body["messages"]
            .as_array()
            .cloned()
            .ok_or("messages must be an array")?
    };
    let mut pending_tools: VecDeque<(String, String)> = VecDeque::new();
    for message in &mut messages {
        let role = message["role"]
            .as_str()
            .ok_or("each message requires a role")?
            .to_string();
        if !matches!(
            role.as_str(),
            "system" | "user" | "assistant" | "tool" | "developer"
        ) {
            return Err(format!("unsupported message role {role}"));
        }
        let content = match message.get("content") {
            Some(Value::String(content)) => content.clone(),
            None | Some(Value::Null) if role == "assistant" => String::new(),
            _ => return Err("message content must be a string".into()),
        };
        message["content"] = json!(content);
        if let Some(images) = message.get("images").filter(|images| !images.is_null()) {
            let images = images.as_array().ok_or("images must be an array")?;
            let mut parts = vec![json!({ "type": "text", "text": content })];
            for image in images {
                let image = image.as_str().ok_or("images must contain base64 strings")?;
                let url = if image.starts_with("data:image/") {
                    image.to_string()
                } else {
                    format!("data:{};base64,{image}", image_mime(image)?)
                };
                parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
            }
            message["content"] = json!(parts);
        }
        if let Some(object) = message.as_object_mut() {
            object.remove("images");
            if let Some(thinking) = object.remove("thinking") {
                if !thinking.is_string() {
                    return Err("thinking must be a string".into());
                }
                object.insert("reasoning_content".into(), thinking);
            }
        }
        if role == "assistant" {
            if let Some(calls) = message.get_mut("tool_calls") {
                let calls = calls.as_array_mut().ok_or("tool_calls must be an array")?;
                for call in calls {
                    let name = call["function"]["name"]
                        .as_str()
                        .ok_or("tool call requires function.name")?
                        .to_string();
                    let arguments = call["function"]
                        .get("arguments")
                        .cloned()
                        .unwrap_or(json!({}));
                    if !arguments.is_object() {
                        return Err("tool arguments must be an object".into());
                    }
                    let id = call["id"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
                    pending_tools.push_back((id.clone(), name.clone()));
                    *call = json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments.to_string() } });
                }
            }
        } else if role == "tool" {
            let id = message["tool_call_id"].as_str().map(str::to_string);
            let name = message["tool_name"].as_str();
            let index = pending_tools
                .iter()
                .position(|(candidate, tool)| {
                    id.as_ref().is_some_and(|id| id == candidate)
                        || (id.is_none() && name.is_some_and(|name| name == tool))
                })
                .or_else(|| {
                    (id.is_none() && name.is_none() && !pending_tools.is_empty()).then_some(0)
                })
                .ok_or("tool result has no matching tool call")?;
            let (id, _) = pending_tools
                .remove(index)
                .expect("position names an existing pending call");
            message["tool_call_id"] = json!(id);
            message.as_object_mut().unwrap().remove("tool_name");
        }
    }
    let mut result = json!({ "model": model, "messages": messages, "stream": stream });
    if stream {
        result["stream_options"] = json!({ "include_usage": true });
    }
    for field in ["tools", "logprobs", "top_logprobs"] {
        if let Some(value) = body.get(field) {
            result[field] = value.clone();
        }
    }
    if let Some(format) = body.get("format").filter(|format| !format.is_null()) {
        result["response_format"] = if format == "json" {
            json!({ "type": "json_object" })
        } else if format.is_object() {
            json!({ "type": "json_schema", "json_schema": { "name": "ollama_response", "schema": format } })
        } else {
            return Err("format must be json or a JSON schema".into());
        };
    }
    if let Some(think) = body.get("think").filter(|think| !think.is_null()) {
        result["reasoning_effort"] = match think {
            Value::Bool(true) => json!("medium"),
            Value::Bool(false) => json!("none"),
            Value::String(level) => json!(level),
            _ => return Err("think must be a boolean or reasoning level".into()),
        };
    }
    if let Some(options) = body.get("options").filter(|options| !options.is_null()) {
        let options = options.as_object().ok_or("options must be an object")?;
        for (name, value) in options {
            let destination = match name.as_str() {
                "num_predict" => "max_tokens",
                "temperature" | "top_p" | "seed" | "stop" | "frequency_penalty"
                | "presence_penalty" => name,
                _ => {
                    return Err(format!(
                        "Ollama option {name} has no supported upstream equivalent"
                    ))
                }
            };
            if name == "num_predict" && value.as_i64().is_some_and(|number| number <= 0) {
                return Err("num_predict must be positive for a gateway model".into());
            }
            result[destination] = value.clone();
        }
    }
    Ok(result)
}

fn image_mime(encoded: &str) -> Result<&'static str, String> {
    if encoded.starts_with("iVBOR") {
        Ok("image/png")
    } else if encoded.starts_with("/9j/") {
        Ok("image/jpeg")
    } else if encoded.starts_with("R0lGOD") {
        Ok("image/gif")
    } else if encoded.starts_with("UklGR") {
        Ok("image/webp")
    } else {
        Err("image has no recognized PNG, JPEG, GIF or WebP signature".into())
    }
}

fn response_from_chat(
    body: &Value,
    model: &str,
    generate: bool,
    elapsed: Duration,
) -> Result<Value, String> {
    if let Some(message) = body["error"]["message"].as_str() {
        return Err(message.into());
    }
    let choice = body["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .ok_or("upstream returned no completion choice")?;
    let mut message = choice["message"].clone();
    if !message.is_object() {
        return Err("upstream returned no assistant message".into());
    }
    convert_response_message(&mut message)?;
    let mut result = base_response(model, generate, true, elapsed);
    put_message(&mut result, &message, generate);
    result["done_reason"] = choice
        .get("finish_reason")
        .cloned()
        .unwrap_or(json!("stop"));
    copy_usage(&mut result, &body["usage"]);
    copy_logprobs(&mut result, choice);
    Ok(result)
}

fn copy_logprobs(result: &mut Value, choice: &Value) {
    if let Some(logprobs) = choice.pointer("/logprobs/content") {
        result["logprobs"] = logprobs.clone();
    }
}

fn convert_response_message(message: &mut Value) -> Result<(), String> {
    let object = message.as_object_mut().ok_or("invalid assistant message")?;
    let thinking = object
        .remove("reasoning_content")
        .or_else(|| object.remove("reasoning"));
    if let Some(thinking) = thinking {
        object.insert("thinking".into(), thinking);
    }
    if object.get("content").is_none_or(Value::is_null) {
        object.insert("content".into(), json!(""));
    }
    if let Some(calls) = object.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for call in calls {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                let arguments: Value = serde_json::from_str(arguments)
                    .map_err(|_| "upstream returned invalid tool arguments")?;
                if !arguments.is_object() {
                    return Err("upstream tool arguments must be an object".into());
                }
                call["function"]["arguments"] = arguments;
            }
        }
    }
    Ok(())
}

fn base_response(model: &str, generate: bool, done: bool, elapsed: Duration) -> Value {
    let mut result =
        json!({ "model": model, "created_at": chrono::Utc::now().to_rfc3339(), "done": done });
    if generate {
        result["response"] = json!("");
    } else {
        result["message"] = json!({ "role": "assistant", "content": "" });
    }
    if done {
        result["total_duration"] = json!(u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX));
    }
    result
}

fn put_message(result: &mut Value, message: &Value, generate: bool) {
    if generate {
        result["response"] = message.get("content").cloned().unwrap_or(json!(""));
        if let Some(thinking) = message.get("thinking") {
            result["thinking"] = thinking.clone();
        }
        if let Some(calls) = message.get("tool_calls") {
            result["tool_calls"] = calls.clone();
        }
    } else {
        result["message"] = message.clone();
    }
}

fn copy_usage(result: &mut Value, usage: &Value) {
    if let Some(value) = usage.get("prompt_tokens") {
        result["prompt_eval_count"] = value.clone();
    }
    if let Some(value) = usage.get("completion_tokens") {
        result["eval_count"] = value.clone();
    }
    if let Some(value) = usage.pointer("/prompt_tokens_details/cached_tokens") {
        result["prompt_eval_cached_count"] = value.clone();
    }
}

#[derive(Default)]
struct PendingTool {
    id: String,
    name: String,
    arguments: String,
}

struct Encoder {
    model: String,
    generate: bool,
    started: Instant,
    tools: BTreeMap<u64, PendingTool>,
    finish_reason: Option<Value>,
    usage: Value,
    done: bool,
}

impl Encoder {
    fn new(model: String, generate: bool, started: Instant) -> Self {
        Self {
            model,
            generate,
            started,
            tools: BTreeMap::new(),
            finish_reason: None,
            usage: Value::Null,
            done: false,
        }
    }

    fn push(&mut self, data: &str) -> Result<Vec<Value>, String> {
        if self.done {
            return Ok(Vec::new());
        }
        if data.trim() == "[DONE]" {
            return self.finish();
        }
        let value: Value =
            serde_json::from_str(data).map_err(|_| "upstream emitted invalid SSE JSON")?;
        if value.get("error").is_some() {
            return Err(value["error"]["message"]
                .as_str()
                .unwrap_or("upstream stream failed")
                .into());
        }
        if value["usage"].is_object() {
            self.usage = value["usage"].clone();
        }
        let Some(choice) = value["choices"]
            .as_array()
            .and_then(|choices| choices.first())
        else {
            return Ok(Vec::new());
        };
        if choice
            .get("finish_reason")
            .is_some_and(|reason| !reason.is_null())
        {
            self.finish_reason = Some(choice["finish_reason"].clone());
        }
        let delta = &choice["delta"];
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let entry = self
                .tools
                .entry(call["index"].as_u64().unwrap_or(0))
                .or_default();
            if let Some(id) = call["id"].as_str() {
                entry.id = id.into();
            }
            if let Some(name) = call["function"]["name"].as_str() {
                entry.name.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                entry.arguments.push_str(arguments);
            }
        }
        let mut message =
            json!({ "role": "assistant", "content": delta["content"].as_str().unwrap_or("") });
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
        {
            message["thinking"] = reasoning.clone();
        }
        if self.finish_reason.is_some() && !self.tools.is_empty() {
            message["tool_calls"] = self.take_tools()?;
        }
        if message["content"] == ""
            && message.get("thinking").is_none()
            && message.get("tool_calls").is_none()
        {
            return Ok(Vec::new());
        }
        let mut result = base_response(&self.model, self.generate, false, self.started.elapsed());
        put_message(&mut result, &message, self.generate);
        copy_logprobs(&mut result, choice);
        Ok(vec![result])
    }

    fn finish(&mut self) -> Result<Vec<Value>, String> {
        if self.done {
            return Ok(Vec::new());
        }
        self.done = true;
        let reason = self
            .finish_reason
            .take()
            .ok_or("upstream stream ended without a completion marker")?;
        let mut message = json!({ "role": "assistant", "content": "" });
        if !self.tools.is_empty() {
            message["tool_calls"] = self.take_tools()?;
        }
        let mut result = base_response(&self.model, self.generate, true, self.started.elapsed());
        put_message(&mut result, &message, self.generate);
        result["done_reason"] = reason;
        copy_usage(&mut result, &self.usage);
        Ok(vec![result])
    }

    fn take_tools(&mut self) -> Result<Value, String> {
        let mut calls = Vec::new();
        for (_, tool) in std::mem::take(&mut self.tools) {
            let arguments: Value = serde_json::from_str(&tool.arguments)
                .map_err(|_| "upstream returned incomplete tool arguments")?;
            if !arguments.is_object() {
                return Err("tool arguments must be an object".into());
            }
            calls.push(
                json!({ "id": tool.id, "function": { "name": tool.name, "arguments": arguments } }),
            );
        }
        Ok(json!(calls))
    }
}

fn stream_response(
    response: Response,
    model: String,
    generate: bool,
    started: Instant,
) -> Response {
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    parts.headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    let stream = futures_util::stream::unfold(
        (
            body.into_data_stream(),
            SseDeframer::default(),
            Encoder::new(model, generate, started),
            VecDeque::<Bytes>::new(),
            false,
        ),
        |(mut upstream, mut framing, mut encoder, mut pending, mut ended)| async move {
            loop {
                if let Some(line) = pending.pop_front() {
                    return Some((
                        Ok::<_, std::io::Error>(line),
                        (upstream, framing, encoder, pending, ended),
                    ));
                }
                if ended {
                    return None;
                }
                let mut outputs = Vec::new();
                let parsed = match upstream.next().await {
                    Some(Ok(bytes)) => {
                        let mut result = Ok(());
                        for data in framing.push(&bytes) {
                            match encoder.push(&data) {
                                Ok(values) => outputs.extend(values),
                                Err(error) => {
                                    result = Err(error);
                                    break;
                                }
                            }
                        }
                        result
                    }
                    Some(Err(_)) => Err("upstream response body failed".into()),
                    None => {
                        ended = true;
                        let mut result = Ok(());
                        if let Some(data) = framing.finish() {
                            match encoder.push(&data) {
                                Ok(values) => outputs.extend(values),
                                Err(error) => result = Err(error),
                            }
                        }
                        if result.is_ok() {
                            match encoder.finish() {
                                Ok(values) => outputs.extend(values),
                                Err(error) => result = Err(error),
                            }
                        }
                        result
                    }
                };
                if let Err(message) = parsed {
                    outputs.push(json!({ "error": message }));
                    ended = true;
                }
                pending.extend(
                    outputs
                        .into_iter()
                        .map(|value| Bytes::from(format!("{value}\n"))),
                );
            }
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn ollama_error_response(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, BODY_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return error(parts.status, "gateway request failed"),
    };
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let message = parsed["error"]["message"]
        .as_str()
        .or_else(|| parsed["error"].as_str())
        .unwrap_or("gateway request failed");
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    parts.headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(json!({ "error": message }).to_string()))
}

#[cfg(test)]
mod tests {
    use super::super::router_fusion_server_tests as fixture;
    use super::*;

    struct Upstream {
        address: SocketAddr,
        seen: Arc<parking_lot::Mutex<Vec<Value>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream() -> Upstream {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = seen.clone();
        let app = Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().push(body.clone());
                if body["stream"] == true {
                    return Response::builder().header("content-type", "text/event-stream").body(Body::from(concat!(
                        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"check\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n",
                        "data: [DONE]\n\n"
                    ))).unwrap();
                }
                Json(json!({"id":"mock","object":"chat.completion","model":body["model"],"choices":[{"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}})).into_response()
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

    fn gateway(upstream: &Upstream) -> fixture::Gateway {
        let snapshot = serde_json::from_value(json!({
            "providers":[{"id":"up","protocol":"openai","baseUrl":format!("http://{}/v1",upstream.address),"apiKey":"upstream-secret","enabled":true,"models":["visible","hidden"],"modelMetadata":[{"id":"visible","contextLength":8192,"supportsVision":true,"supportsTools":true}]}],
            "aliases":[],"generatedAtMs":1
        })).unwrap();
        fixture::gateway_with(
            Arc::new(crate::brain_bridge::RecordingBrainBridge::new()),
            false,
            false,
            Some(snapshot),
        )
    }

    #[tokio::test]
    async fn mounted_catalog_and_inference_keep_key_visibility_and_translate_latest_alias() {
        let upstream = upstream().await;
        let gateway = gateway(&upstream);
        gateway
            .state
            .keys
            .write()
            .iter_mut()
            .find(|key| key.secret == fixture::SECRET)
            .unwrap()
            .model_allowlist = vec!["visible".into()];
        let response = fixture::send(
            &gateway.app,
            fixture::request("GET", "/api/tags", Some(fixture::SECRET), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let listed = fixture::json_of(response).await;
        assert_eq!(listed["models"].as_array().unwrap().len(), 1);
        assert_eq!(listed["models"][0]["name"], "visible");
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/api/show",
                Some(fixture::SECRET),
                Some(json!({"model":"hidden"})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/api/generate",
                Some(fixture::SECRET),
                Some(json!({"model":"visible:latest","prompt":"hello","stream":false})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = fixture::json_of(response).await;
        assert_eq!(body["response"], "answer");
        assert_eq!(upstream.seen.lock()[0]["model"], "visible");
        let response = fixture::send(&gateway.app, fixture::request("POST", "/api/chat", Some(fixture::SECRET), Some(json!({"model":"hidden","stream":false,"messages":[{"role":"user","content":"hello"}]})))).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(upstream.seen.lock().len(), 1);
    }

    #[tokio::test]
    async fn mounted_chat_stream_is_ndjson_with_thinking_answer_and_final_usage() {
        let upstream = upstream().await;
        let gateway = gateway(&upstream);
        let response = fixture::send(
            &gateway.app,
            fixture::request(
                "POST",
                "/api/chat",
                Some(fixture::SECRET),
                Some(json!({"model":"visible","messages":[{"role":"user","content":"hello"}]})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/x-ndjson");
        let bytes = axum::body::to_bytes(response.into_body(), BODY_LIMIT_BYTES)
            .await
            .unwrap();
        let rows: Vec<Value> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(rows.iter().any(|row| row["message"]["thinking"] == "check"));
        assert!(rows.iter().any(|row| row["message"]["content"] == "answer"));
        assert_eq!(rows.last().unwrap()["done"], true);
        assert_eq!(rows.last().unwrap()["prompt_eval_count"], 4);
        assert_eq!(rows.last().unwrap()["eval_count"], 2);
        assert!(
            rows.iter().all(|row| row.get("error").is_none()),
            "{rows:?}"
        );
    }

    #[tokio::test]
    async fn mounted_auth_failures_use_the_ollama_error_shape() {
        let upstream = upstream().await;
        let gateway = gateway(&upstream);
        let response = fixture::send(
            &gateway.app,
            fixture::request("GET", "/api/tags", None, None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(fixture::json_of(response).await["error"].is_string());
        assert!(upstream.seen.lock().is_empty());
    }

    #[tokio::test]
    async fn mounted_subscription_pool_requires_consent_honors_allowance_and_keeps_exact_account() {
        let first = upstream().await;
        let second = upstream().await;
        let now = chrono::Utc::now().timestamp_millis();
        let snapshot = serde_json::from_value(json!({
            "providers":[{"id":"up","protocol":"openai","baseUrl":format!("http://{}/v1",first.address),"enabled":true,"models":["visible"],"subscriptionPool":{"strategy":"allowance-reset","quotaFreshnessMs":300000,"accounts":[
                {"accountId":"one","apiKey":"first","baseUrl":format!("http://{}/v1",first.address),"lastUsedAtMs":0,"quotaObservedAtMs":now,"windows":[{"id":"session","usedPct":20,"resetAtMs":now+30000}]},
                {"accountId":"two","apiKey":"second","baseUrl":format!("http://{}/v1",second.address),"lastUsedAtMs":0,"quotaObservedAtMs":now,"windows":[{"id":"session","usedPct":10,"resetAtMs":now+60000}]}
            ]}}],"aliases":[{"alias":"pool-alias","entries":[{"providerId":"up","modelId":"visible"}]}],"generatedAtMs":now
        })).unwrap();
        let gateway = fixture::gateway_with(
            Arc::new(crate::brain_bridge::RecordingBrainBridge::new()),
            false,
            false,
            Some(snapshot),
        );
        let request = || {
            fixture::request(
                "POST",
                "/v1/chat/completions",
                Some(fixture::SECRET),
                Some(
                    json!({"model":"pool-alias","stream":false,"messages":[{"role":"user","content":"hello"}],"metadata":{"user_id":"one-conversation"}}),
                ),
            )
        };
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "headless pool metadata never grants rotation consent"
        );
        assert!(first.seen.lock().is_empty() && second.seen.lock().is_empty());
        gateway
            .state
            .config
            .write()
            .subscription_rotation_provider_ids = vec!["up".into()];
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(first.seen.lock().len(), 1);
        assert!(second.seen.lock().is_empty());
        {
            let mut snapshot = gateway.state.snapshot.write();
            let snapshot = snapshot.as_mut().unwrap();
            snapshot.generated_at_ms += 1;
            snapshot.providers[0]
                .subscription_pool
                .as_mut()
                .unwrap()
                .accounts[0]
                .windows[0]
                .used_pct = 100.0;
        }
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            second.seen.lock().len(),
            1,
            "spent account releases its affinity before dispatch"
        );
        gateway.state.snapshot.write().as_mut().unwrap().providers[0]
            .selected_subscription_account_id = Some("one".into());
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "explicit spent account cannot borrow a sibling"
        );
        assert_eq!(second.seen.lock().len(), 1);
        gateway.state.snapshot.write().as_mut().unwrap().providers[0]
            .selected_subscription_account_id = Some("two".into());
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(second.seen.lock().len(), 2);
        gateway
            .state
            .config
            .write()
            .subscription_rotation_provider_ids
            .clear();
        let response = fixture::send(&gateway.app, request()).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "live opt-out closes a pool-only source before republishing"
        );
        assert_eq!(first.seen.lock().len(), 1);
        assert_eq!(second.seen.lock().len(), 2);
    }

    #[test]
    fn converts_messages_images_thinking_and_tool_result_identity() {
        let body = json!({"model":"alias","stream":false,"messages":[
            {"role":"user","content":"read this","images":["iVBORw0KGgo="]},
            {"role":"assistant","content":"","thinking":"check","tool_calls":[{"function":{"name":"lookup","arguments":{"q":"x"}}}]},
            {"role":"tool","tool_name":"lookup","content":"found"}
        ]});
        let converted = request_to_chat(&body, false).unwrap();
        assert_eq!(
            converted["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert_eq!(converted["messages"][1]["reasoning_content"], "check");
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["id"],
            converted["messages"][2]["tool_call_id"]
        );
        assert!(converted["messages"][1]["tool_calls"][0]["function"]["arguments"].is_string());
    }

    #[test]
    fn generate_preserves_system_structured_output_and_options() {
        let converted = request_to_chat(&json!({"model":"route","prompt":"hi","system":"brief","format":{"type":"object"},"think":"high","options":{"num_predict":20,"temperature":0.3}}), true).unwrap();
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(converted["response_format"]["type"], "json_schema");
        assert_eq!(converted["reasoning_effort"], "high");
        assert_eq!(converted["max_tokens"], 20);
        assert_eq!(converted["stream"], true);
    }

    #[test]
    fn refuses_controls_that_cannot_be_honored_and_orphan_tool_results() {
        for body in [
            json!({"model":"m","prompt":"hi","raw":true}),
            json!({"model":"m","prompt":"hi","keep_alive":0}),
            json!({"model":"m","prompt":"hi","options":{"num_ctx":4096}}),
        ] {
            assert!(request_to_chat(&body, true).is_err());
        }
        assert!(request_to_chat(
            &json!({"model":"m","messages":[{"role":"tool","content":"orphan"}]}),
            false
        )
        .is_err());
    }

    #[test]
    fn response_keeps_reasoning_tool_arguments_and_real_usage() {
        let result = response_from_chat(&json!({"choices":[{"message":{"role":"assistant","content":null,"reasoning_content":"checking","tool_calls":[{"id":"a","type":"function","function":{"name":"read","arguments":"{\"path\":\"x\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}), "alias", false, Duration::from_millis(5)).unwrap();
        assert_eq!(result["message"]["thinking"], "checking");
        assert_eq!(
            result["message"]["tool_calls"][0]["function"]["arguments"]["path"],
            "x"
        );
        assert_eq!(result["prompt_eval_count"], 10);
        assert_eq!(result["eval_count"], 2);
        assert!(result.get("load_duration").is_none());
    }

    #[test]
    fn requested_logprobs_survive_both_response_modes() {
        let logprobs =
            json!([{"token":"bird","logprob":-0.1,"bytes":[98,105,114,100],"top_logprobs":[]}]);
        let result = response_from_chat(&json!({"choices":[{"message":{"role":"assistant","content":"bird"},"finish_reason":"stop","logprobs":{"content":logprobs}}]}), "alias", false, Duration::ZERO).unwrap();
        assert_eq!(result["logprobs"], logprobs);
        let mut encoder = Encoder::new("alias".into(), false, Instant::now());
        let rows = encoder
            .push(
                &json!({"choices":[{"delta":{"content":"bird"},"logprobs":{"content":logprobs}}]})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(rows[0]["logprobs"], logprobs);
    }

    #[test]
    fn streaming_waits_for_usage_and_combines_tool_fragments() {
        let mut encoder = Encoder::new("alias".into(), false, Instant::now());
        assert!(encoder.push(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\"path\":"}}]}}]}"#).unwrap().is_empty());
        let tools = encoder.push(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]},"finish_reason":"tool_calls"}]}"#).unwrap();
        assert_eq!(
            tools.len(),
            1,
            "Ollama streams tool calls before its final usage row"
        );
        assert_eq!(tools[0]["done"], false);
        assert_eq!(
            tools[0]["message"]["tool_calls"][0]["function"]["arguments"]["path"],
            "x"
        );
        encoder
            .push(r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#)
            .unwrap();
        let rows = encoder.push("[DONE]").unwrap();
        assert!(rows[0]["message"].get("tool_calls").is_none());
        assert_eq!(rows[0]["prompt_eval_count"], 7);
        assert_eq!(rows[0]["done"], true);
        assert!(encoder.finish().unwrap().is_empty());
    }

    #[test]
    fn truncated_stream_is_an_error_instead_of_a_successful_done() {
        let mut encoder = Encoder::new("m".into(), true, Instant::now());
        assert_eq!(
            encoder
                .push(r#"{"choices":[{"delta":{"content":"part"}}]}"#)
                .unwrap()[0]["response"],
            "part"
        );
        assert!(encoder.finish().is_err());
    }

    #[test]
    fn catalog_omits_unknown_weight_facts_and_only_claims_known_capabilities() {
        let model =
            json!({"id":"alias","supportsTools":true,"supportsVision":false,"contextLength":32768});
        let tag = tag_document(&model);
        assert!(tag.get("digest").is_none());
        assert!(tag.get("size").is_none());
        let shown = show_document(&model);
        assert_eq!(shown["capabilities"], json!(["completion", "tools"]));
        assert_eq!(shown["model_info"]["context_length"], 32768);
        assert!(shown["model_info"].get("general.architecture").is_none());
    }
}
