//! Google GenerateContent ⇄ canonical chat IR.
//!
//! Native Gemini requests bypass this translator. Provider-owned controls that
//! have no equivalent fail explicitly on a cross-protocol route.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::errors::NotTranslatable;
use super::ir::{
    ChatIR, IrContent, IrImage, IrMessage, IrResponse, IrRole, IrStopReason, IrToolChoice,
    IrToolDef, IrUsage, TranslationLoss,
};

fn field<'a>(value: &'a Value, camel: &str, snake: &str) -> &'a Value {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .unwrap_or(&Value::Null)
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str, NotTranslatable> {
    value[name]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| NotTranslatable::new(format!("Gemini {name} must be a nonempty string")))
}

fn json_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(fields) => {
            let mut out: Map<String, Value> = fields
                .iter()
                .filter(|(name, _)| name.as_str() != "nullable")
                .map(|(name, value)| (name.clone(), json_schema(value)))
                .collect();
            if let Some(kind) = schema["type"].as_str() {
                let kind = kind.to_ascii_lowercase();
                out.insert(
                    "type".into(),
                    if schema["nullable"] == true {
                        json!([kind, "null"])
                    } else {
                        json!(kind)
                    },
                );
            }
            Value::Object(out)
        }
        Value::Array(items) => json!(items.iter().map(json_schema).collect::<Vec<_>>()),
        _ => schema.clone(),
    }
}

/// A stateless tool-call envelope keeps Google's function name, original id
/// and thought signature with the client-visible call id across history turns.
/// The hex alphabet is valid in both OpenAI and Anthropic tool identifiers.
fn call_id(call: &Value, signature: &Value) -> String {
    let id = call["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
    format!(
        "gfn_{}",
        hex::encode(
            json!({"id":id,"name":call["name"],"signature":signature})
                .to_string()
                .as_bytes()
        )
    )
}

fn call_state(id: &str) -> Option<Value> {
    let bytes = hex::decode(id.strip_prefix("gfn_")?).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    (value["id"].is_string() && value["name"].is_string()).then_some(value)
}

fn image_part(image: &IrImage) -> Value {
    match image {
        IrImage::Url(uri) => json!({"fileData":{"fileUri":uri}}),
        IrImage::Base64 { media_type, data } => {
            json!({"inlineData":{"mimeType":media_type,"data":data}})
        }
    }
}

fn parse_image(part: &Value) -> Result<Option<IrImage>, NotTranslatable> {
    let inline = field(part, "inlineData", "inline_data");
    if !inline.is_null() {
        let mime = field(inline, "mimeType", "mime_type")
            .as_str()
            .ok_or_else(|| NotTranslatable::new("Gemini inlineData requires mimeType"))?;
        if !mime.starts_with("image/") {
            return Err(NotTranslatable::new(
                "Gemini non-image inlineData requires a native Gemini upstream",
            ));
        }
        return Ok(Some(IrImage::Base64 {
            media_type: mime.into(),
            data: required(inline, "data")?.into(),
        }));
    }
    let file = field(part, "fileData", "file_data");
    if !file.is_null() {
        if field(file, "mimeType", "mime_type")
            .as_str()
            .is_some_and(|mime| !mime.starts_with("image/"))
        {
            return Err(NotTranslatable::new(
                "Gemini non-image fileData requires a native Gemini upstream",
            ));
        }
        let uri = field(file, "fileUri", "file_uri")
            .as_str()
            .filter(|uri| !uri.is_empty())
            .ok_or_else(|| NotTranslatable::new("Gemini fileData requires fileUri"))?;
        return Ok(Some(IrImage::Url(uri.into())));
    }
    Ok(None)
}

pub fn to_ir(body: &Value) -> Result<ChatIR, NotTranslatable> {
    let generation = field(body, "generationConfig", "generation_config");
    if field(generation, "candidateCount", "candidate_count")
        .as_u64()
        .unwrap_or(1)
        != 1
    {
        return Err(NotTranslatable::new(
            "Gemini candidateCount other than one requires a native Gemini upstream",
        ));
    }
    for (camel, snake) in [
        ("safetySettings", "safety_settings"),
        ("cachedContent", "cached_content"),
        ("serviceTier", "service_tier"),
        ("labels", "labels"),
        ("store", "store"),
    ] {
        if !field(body, camel, snake).is_null() {
            return Err(NotTranslatable::new(format!(
                "Gemini {camel} requires a native Gemini upstream"
            )));
        }
    }
    let mut ir = ChatIR {
        model: required(body, "model")?
            .trim_start_matches("models/")
            .into(),
        stream: body["stream"].as_bool().unwrap_or(false),
        ..Default::default()
    };
    let system = field(body, "systemInstruction", "system_instruction");
    if !system.is_null() {
        let parts = system["parts"]
            .as_array()
            .ok_or_else(|| NotTranslatable::new("Gemini systemInstruction requires text parts"))?;
        let mut text = Vec::new();
        for part in parts {
            if !field(part, "thoughtSignature", "thought_signature").is_null()
                && field(part, "functionCall", "function_call").is_null()
            {
                return Err(NotTranslatable::new(
                    "signed Gemini text history requires its native upstream",
                ));
            }
            text.push(required(part, "text")?);
        }
        ir.system = Some(text.join("\n"));
    }
    let contents = body["contents"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| NotTranslatable::new("Gemini contents must be a nonempty array"))?;
    let mut calls: HashMap<String, Vec<String>> = HashMap::new();
    for content in contents {
        let role = match content["role"].as_str().unwrap_or("user") {
            "user" => IrRole::User,
            "model" => IrRole::Assistant,
            _ => {
                return Err(NotTranslatable::new(
                    "Gemini content role must be user or model",
                ))
            }
        };
        let parts = content["parts"]
            .as_array()
            .ok_or_else(|| NotTranslatable::new("Gemini content requires parts"))?;
        let mut out = Vec::new();
        for part in parts {
            if !field(part, "thoughtSignature", "thought_signature").is_null()
                && field(part, "functionCall", "function_call").is_null()
            {
                return Err(NotTranslatable::new(
                    "signed Gemini text history requires its native upstream",
                ));
            }
            if part["thought"].as_bool() == Some(true) {
                return Err(NotTranslatable::new(
                    "Gemini thought history requires its native upstream",
                ));
            }
            if let Some(text) = part["text"].as_str() {
                out.push(IrContent::Text(text.into()));
            } else if let Some(image) = parse_image(part)? {
                out.push(IrContent::Image(image));
            } else if !field(part, "functionCall", "function_call").is_null() {
                let call = field(part, "functionCall", "function_call");
                let name = required(call, "name")?.to_owned();
                let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                if !args.is_object() {
                    return Err(NotTranslatable::new(
                        "Gemini functionCall args must be an object",
                    ));
                }
                let id = call_id(call, field(part, "thoughtSignature", "thought_signature"));
                calls.entry(name.clone()).or_default().push(id.clone());
                out.push(IrContent::ToolUse {
                    id,
                    name,
                    input: args,
                });
            } else if !field(part, "functionResponse", "function_response").is_null() {
                let result = field(part, "functionResponse", "function_response");
                let name = required(result, "name")?;
                if result.get("parts").is_some() {
                    return Err(NotTranslatable::new(
                        "Gemini multimodal functionResponse requires a native Gemini upstream",
                    ));
                }
                let ids = calls.get_mut(name).ok_or_else(|| {
                    NotTranslatable::new("Gemini functionResponse has no matching functionCall")
                })?;
                let position = if let Some(id) = result["id"].as_str() {
                    ids.iter()
                        .position(|candidate| {
                            call_state(candidate).is_some_and(|state| state["id"] == id)
                        })
                        .ok_or_else(|| {
                            NotTranslatable::new(
                                "Gemini functionResponse id does not match its functionCall",
                            )
                        })?
                } else {
                    0
                };
                if ids.is_empty() {
                    return Err(NotTranslatable::new(
                        "Gemini functionResponse is duplicated",
                    ));
                }
                let id = ids.remove(position);
                let response = result
                    .get("response")
                    .filter(|value| value.is_object())
                    .ok_or_else(|| {
                        NotTranslatable::new("Gemini functionResponse response must be an object")
                    })?;
                out.push(IrContent::ToolResult {
                    tool_use_id: id,
                    content: response.to_string(),
                    is_error: response.get("error").is_some(),
                });
            } else {
                return Err(NotTranslatable::new(
                    "Gemini part has no supported cross-protocol representation",
                ));
            }
        }
        ir.messages.push(IrMessage { role, content: out });
    }
    if let Some(groups) = body.get("tools") {
        for group in groups
            .as_array()
            .ok_or_else(|| NotTranslatable::new("Gemini tools must be an array"))?
        {
            if group.as_object().is_none_or(|object| {
                object
                    .keys()
                    .any(|key| key != "functionDeclarations" && key != "function_declarations")
            }) {
                return Err(NotTranslatable::new("Gemini hosted tools require a native Gemini upstream or an explicitly configured gateway bridge"));
            }
            for tool in field(group, "functionDeclarations", "function_declarations")
                .as_array()
                .ok_or_else(|| {
                    NotTranslatable::new("Gemini functionDeclarations must be an array")
                })?
            {
                ir.tools.push(IrToolDef {
                    name: required(tool, "name")?.into(),
                    description: tool["description"].as_str().map(str::to_owned),
                    input_schema: field(tool, "parametersJsonSchema", "parameters_json_schema")
                        .as_object()
                        .map(|_| {
                            field(tool, "parametersJsonSchema", "parameters_json_schema").clone()
                        })
                        .or_else(|| tool.get("parameters").map(json_schema))
                        .unwrap_or_else(|| json!({"type":"object","properties":{}})),
                    strict: None,
                });
            }
        }
    }
    let config = field(
        field(body, "toolConfig", "tool_config"),
        "functionCallingConfig",
        "function_calling_config",
    );
    let allowed = field(config, "allowedFunctionNames", "allowed_function_names");
    ir.tool_choice = match config["mode"].as_str() {
        None | Some("AUTO") => None,
        Some("NONE") => Some(IrToolChoice::None),
        Some("ANY") => {
            if let Some(names) = allowed.as_array() {
                if names.is_empty()
                    || names.iter().any(|name| {
                        name.as_str()
                            .is_none_or(|name| !ir.tools.iter().any(|tool| tool.name == name))
                    })
                {
                    return Err(NotTranslatable::new(
                        "Gemini allowedFunctionNames must name declared functions",
                    ));
                }
                if names.len() == 1 {
                    Some(IrToolChoice::Tool(names[0].as_str().unwrap().into()))
                } else {
                    ir.tools
                        .retain(|tool| names.iter().any(|name| name == &tool.name));
                    Some(IrToolChoice::Any)
                }
            } else {
                Some(IrToolChoice::Any)
            }
        }
        Some("VALIDATED") => {
            ir.losses.push(TranslationLoss::approximated(
                "toolConfig.functionCallingConfig.mode",
                "Gemini VALIDATED maps to schema-described automatic tools",
            ));
            Some(IrToolChoice::Auto)
        }
        _ => {
            return Err(NotTranslatable::new(
                "unsupported Gemini functionCallingConfig mode",
            ))
        }
    };
    ir.max_tokens = field(generation, "maxOutputTokens", "max_output_tokens").as_u64();
    ir.temperature = generation["temperature"].as_f64();
    ir.top_p = field(generation, "topP", "top_p").as_f64();
    if let Some(stops) = field(generation, "stopSequences", "stop_sequences").as_array() {
        for stop in stops {
            ir.stop.push(
                stop.as_str()
                    .ok_or_else(|| {
                        NotTranslatable::new("Gemini stopSequences must contain strings")
                    })?
                    .into(),
            );
        }
    }
    match field(generation, "responseMimeType", "response_mime_type").as_str() {
        None | Some("text/plain") => {}
        Some("application/json") => {
            let schema = field(generation, "responseJsonSchema", "response_json_schema");
            let schema = if schema.is_null() {
                json_schema(field(generation, "responseSchema", "response_schema"))
            } else {
                schema.clone()
            };
            ir.response_format = Some(if schema.is_null() {
                json!({"type":"json_object"})
            } else {
                json!({"type":"json_schema","json_schema":{"name":"response","schema":schema}})
            });
        }
        _ => {
            return Err(NotTranslatable::new(
                "Gemini non-text responseMimeType requires a native Gemini upstream",
            ))
        }
    }
    let thinking = field(generation, "thinkingConfig", "thinking_config");
    if let Some(modalities) =
        field(generation, "responseModalities", "response_modalities").as_array()
    {
        if modalities.iter().any(|value| value != "TEXT") {
            return Err(NotTranslatable::new(
                "Gemini media output modalities require a native Gemini upstream",
            ));
        }
    }
    if let Some(level) = field(thinking, "thinkingLevel", "thinking_level").as_str() {
        ir.reasoning_effort = Some(level.to_ascii_lowercase());
    }
    if let Some(budget) = field(thinking, "thinkingBudget", "thinking_budget").as_i64() {
        match budget {
            0 => ir.reasoning_effort = Some("none".into()),
            -1 => ir.losses.push(TranslationLoss::approximated(
                "generationConfig.thinkingConfig.thinkingBudget",
                "automatic Gemini thinking follows the destination model's default",
            )),
            _ => {
                return Err(NotTranslatable::new(
                    "explicit Gemini thinking budgets require a native Gemini upstream",
                ))
            }
        }
    }
    for (camel, snake) in [
        ("topK", "top_k"),
        ("seed", "seed"),
        ("presencePenalty", "presence_penalty"),
        ("frequencyPenalty", "frequency_penalty"),
    ] {
        if !field(generation, camel, snake).is_null() {
            return Err(NotTranslatable::new(format!(
                "Gemini generationConfig.{camel} has no canonical cross-protocol representation"
            )));
        }
    }
    ir.validate_tool_choice()?;
    Ok(ir)
}

pub fn from_ir(ir: &ChatIR) -> Result<Value, NotTranslatable> {
    if ir.parallel_tool_calls == Some(false) && !ir.tools.is_empty() {
        return Err(NotTranslatable::new(
            "Gemini cannot enforce parallel_tool_calls=false on a translated request",
        ));
    }
    if ir.tools.iter().any(|tool| tool.strict == Some(true)) {
        return Err(NotTranslatable::new(
            "Gemini function declarations cannot enforce OpenAI strict tools",
        ));
    }
    let names: HashMap<&str, &str> = ir
        .messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|part| {
            if let IrContent::ToolUse { id, name, .. } = part {
                Some((id.as_str(), name.as_str()))
            } else {
                None
            }
        })
        .collect();
    let mut contents = Vec::new();
    for message in &ir.messages {
        let mut parts = Vec::new();
        for part in &message.content {
            parts.push(match part {
                IrContent::Text(text) => json!({"text":text}),
                IrContent::Image(image) => image_part(image),
                IrContent::ToolUse { id, name, input } => {
                    if !input.is_object() { return Err(NotTranslatable::new("Gemini functionCall arguments must be an object")); }
                    let state = call_state(id);
                    if state.as_ref().is_some_and(|state| state["name"] != name.as_str()) { return Err(NotTranslatable::new("Gemini functionCall name does not match its preserved state")); }
                    let mut part = json!({"functionCall":{"id":state.as_ref().map(|state| &state["id"]).cloned().unwrap_or_else(|| json!(id)),"name":name,"args":input}});
                    if let Some(signature) = state.and_then(|state| state.get("signature").filter(|value| value.is_string()).cloned()) { part["thoughtSignature"] = signature; }
                    part
                },
                IrContent::ToolResult { tool_use_id, content, is_error } => {
                    let state = call_state(tool_use_id);
                    let name = names.get(tool_use_id.as_str()).map(|name| (*name).to_owned()).ok_or_else(|| NotTranslatable::new("Gemini functionResponse requires a matching declared functionCall"))?;
                    let response = serde_json::from_str::<Value>(content).ok().filter(Value::is_object).unwrap_or_else(|| if *is_error { json!({"error":content}) } else { json!({"output":content}) });
                    json!({"functionResponse":{"id":state.as_ref().map(|state| &state["id"]).cloned().unwrap_or_else(|| json!(tool_use_id)),"name":name,"response":response}})
                },
                IrContent::ToolResultMedia { .. } => return Err(NotTranslatable::new("multimodal tool results require a native Gemini route")),
            });
        }
        contents.push(json!({"role":if message.role == IrRole::Assistant {"model"} else {"user"},"parts":parts}));
    }
    let mut out = json!({"contents":contents});
    if let Some(system) = &ir.system {
        out["systemInstruction"] = json!({"parts":[{"text":system}]});
    }
    if !ir.tools.is_empty() {
        out["tools"] = json!([{"functionDeclarations":ir.tools.iter().map(|tool| {
            let mut declaration = json!({"name":tool.name,"parametersJsonSchema":tool.input_schema});
            if let Some(description) = &tool.description { declaration["description"] = json!(description); }
            declaration
        }).collect::<Vec<_>>()}]);
    }
    if let Some(choice) = &ir.tool_choice {
        out["toolConfig"] = json!({"functionCallingConfig":match choice {
            IrToolChoice::Auto => json!({"mode":"AUTO"}), IrToolChoice::Any => json!({"mode":"ANY"}),
            IrToolChoice::None => json!({"mode":"NONE"}), IrToolChoice::Tool(name) => json!({"mode":"ANY","allowedFunctionNames":[name]}),
        }});
    }
    let mut generation = Map::new();
    if let Some(value) = ir.max_tokens {
        generation.insert("maxOutputTokens".into(), json!(value));
    }
    if let Some(value) = ir.temperature {
        generation.insert("temperature".into(), json!(value));
    }
    if let Some(value) = ir.top_p {
        generation.insert("topP".into(), json!(value));
    }
    if !ir.stop.is_empty() {
        generation.insert("stopSequences".into(), json!(ir.stop));
    }
    if let Some(format) = &ir.response_format {
        generation.insert("responseMimeType".into(), json!("application/json"));
        if format["type"] == "json_schema" {
            generation.insert(
                "responseJsonSchema".into(),
                format["json_schema"]["schema"].clone(),
            );
        }
    }
    if let Some(effort) = &ir.reasoning_effort {
        let thinking = if ir.model.contains("gemini-2") {
            json!({"thinkingBudget":match effort.as_str() {"none"=>0,"minimal"=>128,"low"=>1024,"medium"=>8192,_=>24576},"includeThoughts":effort != "none"})
        } else if effort == "none" {
            json!({"thinkingBudget":0,"includeThoughts":false})
        } else {
            json!({"thinkingLevel":match effort.as_str() {"minimal"=>"MINIMAL","low"=>"LOW","medium"=>"MEDIUM",_=>"HIGH"},"includeThoughts":true})
        };
        generation.insert("thinkingConfig".into(), thinking);
    }
    if !generation.is_empty() {
        out["generationConfig"] = Value::Object(generation);
    }
    Ok(out)
}

pub fn usage(body: &Value) -> IrUsage {
    let usage = field(body, "usageMetadata", "usage_metadata");
    IrUsage {
        input_tokens: field(usage, "promptTokenCount", "prompt_token_count")
            .as_u64()
            .unwrap_or(0),
        output_tokens: field(usage, "candidatesTokenCount", "candidates_token_count")
            .as_u64()
            .unwrap_or(0)
            .saturating_add(
                field(usage, "thoughtsTokenCount", "thoughts_token_count")
                    .as_u64()
                    .unwrap_or(0),
            ),
        cache_read_tokens: field(
            usage,
            "cachedContentTokenCount",
            "cached_content_token_count",
        )
        .as_u64()
        .unwrap_or(0),
    }
}

fn stop_reason(reason: &str, tools: bool) -> IrStopReason {
    match reason {
        "MAX_TOKENS" => IrStopReason::MaxTokens,
        "STOP" if tools => IrStopReason::ToolUse,
        "STOP" => IrStopReason::Stop,
        _ => IrStopReason::Other,
    }
}

pub fn response_to_ir(body: &Value) -> Result<IrResponse, NotTranslatable> {
    if body["candidates"]
        .as_array()
        .is_some_and(|items| items.len() > 1)
    {
        return Err(NotTranslatable::new(
            "multiple Gemini candidates require a native Gemini client",
        ));
    }
    let candidate = body["candidates"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| {
            NotTranslatable::new(format!(
                "Gemini response has no candidate: {}",
                body["promptFeedback"]
            ))
        })?;
    let parts = candidate["content"]["parts"]
        .as_array()
        .ok_or_else(|| NotTranslatable::new("Gemini response candidate has no parts"))?;
    let mut content = Vec::new();
    let mut reasoning = String::new();
    for part in parts {
        if let Some(text) = part["text"].as_str() {
            if part["thought"].as_bool() == Some(true) {
                reasoning.push_str(text);
            } else {
                content.push(IrContent::Text(text.into()));
            }
        } else if let Some(call) = part.get("functionCall") {
            let input = call.get("args").cloned().unwrap_or_else(|| json!({}));
            if !input.is_object() {
                return Err(NotTranslatable::new(
                    "Gemini functionCall args must be an object",
                ));
            }
            content.push(IrContent::ToolUse {
                id: call_id(call, &part["thoughtSignature"]),
                name: required(call, "name")?.into(),
                input,
            });
        } else {
            return Err(NotTranslatable::new(
                "Gemini response part requires a native Gemini client",
            ));
        }
    }
    let tools = content
        .iter()
        .any(|part| matches!(part, IrContent::ToolUse { .. }));
    Ok(IrResponse {
        id: body["responseId"]
            .as_str()
            .unwrap_or("gemini-response")
            .into(),
        model: body["modelVersion"].as_str().unwrap_or("").into(),
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        stop_reason: stop_reason(candidate["finishReason"].as_str().unwrap_or("STOP"), tools),
        usage: usage(body),
    })
}

pub fn response_from_ir(response: &IrResponse) -> Value {
    let mut parts = Vec::new();
    if let Some(reasoning) = &response.reasoning {
        parts.push(json!({"text":reasoning,"thought":true}));
    }
    for part in &response.content {
        match part {
            IrContent::Text(text) => parts.push(json!({"text":text})),
            IrContent::ToolUse { id, name, input } => {
                parts.push(json!({"functionCall":{"id":id,"name":name,"args":input}}))
            }
            _ => {}
        }
    }
    json!({"responseId":response.id,"modelVersion":response.model,"candidates":[{"index":0,"content":{"role":"model","parts":parts},"finishReason":match response.stop_reason {IrStopReason::MaxTokens=>"MAX_TOKENS",IrStopReason::Other=>"OTHER",_=>"STOP"}}],"usageMetadata":{"promptTokenCount":response.usage.input_tokens,"candidatesTokenCount":response.usage.output_tokens,"cachedContentTokenCount":response.usage.cache_read_tokens,"totalTokenCount":response.usage.input_tokens.saturating_add(response.usage.output_tokens)}})
}

/// Google SSE payloads become Chat chunks, then reuse the existing destination
/// stream encoders. Tool arguments arrive as complete JSON objects in Gemini.
pub fn chat_chunks(
    body: &Value,
    model: &str,
    id: &str,
    next_tool: &mut u64,
) -> Result<Vec<Value>, NotTranslatable> {
    if body["candidates"]
        .as_array()
        .is_some_and(|items| items.len() > 1)
    {
        return Err(NotTranslatable::new(
            "multiple Gemini stream candidates require a native Gemini client",
        ));
    }
    if body.get("error").is_some() {
        return Err(NotTranslatable::new(
            body["error"]["message"]
                .as_str()
                .unwrap_or("Gemini upstream stream failed"),
        ));
    }
    let mut out = Vec::new();
    let usage = usage(body);
    if let Some(candidate) = body["candidates"]
        .as_array()
        .and_then(|items| items.first())
    {
        for part in candidate["content"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let delta = if let Some(text) = part["text"].as_str() {
                if part["thought"].as_bool() == Some(true) {
                    json!({"reasoning_content":text})
                } else {
                    json!({"content":text})
                }
            } else if let Some(call) = part.get("functionCall") {
                if call.get("args").is_some_and(|args| !args.is_object()) {
                    return Err(NotTranslatable::new(
                        "Gemini functionCall args must be an object",
                    ));
                }
                let index = *next_tool;
                *next_tool += 1;
                json!({"tool_calls":[{"index":index,"id":call_id(call,&part["thoughtSignature"]),"type":"function","function":{"name":required(call,"name")?,"arguments":call.get("args").cloned().unwrap_or_else(|| json!({})).to_string()}}]})
            } else {
                return Err(NotTranslatable::new(
                    "Gemini stream part requires a native Gemini client",
                ));
            };
            out.push(json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":delta,"finish_reason":null}]}));
        }
        if let Some(reason) = candidate["finishReason"].as_str() {
            out.push(json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":{},"finish_reason":stop_reason(reason,*next_tool > 0).to_openai()}],"usage":{"prompt_tokens":usage.input_tokens,"completion_tokens":usage.output_tokens,"prompt_tokens_details":{"cached_tokens":usage.cache_read_tokens},"total_tokens":usage.input_tokens.saturating_add(usage.output_tokens)}}));
        }
    }
    if body.get("usageMetadata").is_some() && !out.iter().any(|chunk| chunk.get("usage").is_some())
    {
        out.push(json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[],"usage":{"prompt_tokens":usage.input_tokens,"completion_tokens":usage.output_tokens,"prompt_tokens_details":{"cached_tokens":usage.cache_read_tokens},"total_tokens":usage.input_tokens.saturating_add(usage.output_tokens)}}));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_image_functions_results_and_controls() {
        let source = json!({"model":"gemini-test","systemInstruction":{"parts":[{"text":"Be precise"}]},"contents":[
            {"role":"user","parts":[{"text":"What is shown?"},{"inlineData":{"mimeType":"image/png","data":"YWJj"}}]},
            {"role":"model","parts":[{"functionCall":{"id":"original","name":"lookup","args":{"query":"x"}},"thoughtSignature":"signed-state"}]},
            {"role":"user","parts":[{"functionResponse":{"id":"original","name":"lookup","response":{"answer":42}}}]}],
            "tools":[{"functionDeclarations":[{"name":"lookup","parameters":{"type":"object"}}]}],
            "toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["lookup"]}},
            "generationConfig":{"maxOutputTokens":500,"temperature":0.2,"topP":0.9,"stopSequences":["END"],"thinkingConfig":{"thinkingLevel":"HIGH"},"responseMimeType":"application/json","responseJsonSchema":{"type":"object"}}});
        let ir = to_ir(&source).unwrap();
        assert_eq!(ir.system.as_deref(), Some("Be precise"));
        assert!(matches!(
            ir.messages[0].content[1],
            IrContent::Image(IrImage::Base64 { .. })
        ));
        assert_eq!(ir.tool_choice, Some(IrToolChoice::Tool("lookup".into())));
        let output = from_ir(&ir).unwrap();
        assert_eq!(
            output["contents"][1]["parts"][0]["thoughtSignature"],
            "signed-state"
        );
        assert_eq!(
            output["contents"][1]["parts"][0]["functionCall"]["id"],
            "original"
        );
        assert_eq!(
            output["contents"][2]["parts"][0]["functionResponse"]["id"],
            "original"
        );
        assert_eq!(
            output["contents"][2]["parts"][0]["functionResponse"]["name"],
            "lookup"
        );
        assert_eq!(
            output["generationConfig"]["responseJsonSchema"],
            json!({"type":"object"})
        );
    }

    #[test]
    fn response_keeps_reasoning_tool_signature_and_thinking_usage() {
        let response = response_to_ir(&json!({"responseId":"r1","modelVersion":"gemini-test","candidates":[{"content":{"parts":[
            {"text":"considering","thought":true},{"text":"answer"},{"functionCall":{"id":"a","name":"lookup","args":{"q":"x"}},"thoughtSignature":"signature"}]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":7}})).unwrap();
        assert_eq!(response.reasoning.as_deref(), Some("considering"));
        assert_eq!(
            response.usage,
            IrUsage {
                input_tokens: 10,
                output_tokens: 10,
                ..Default::default()
            }
        );
        assert_eq!(response.stop_reason, IrStopReason::ToolUse);
        let IrContent::ToolUse { id, .. } = &response.content[1] else {
            panic!("tool missing")
        };
        assert_eq!(call_state(id).unwrap()["signature"], "signature");
        let wire = response_from_ir(&response);
        assert_eq!(
            wire["candidates"][0]["content"]["parts"][0]["thought"],
            true
        );
    }

    #[test]
    fn refuses_native_only_controls_and_unmatched_results() {
        let base =
            json!({"model":"gemini-test","contents":[{"role":"user","parts":[{"text":"hello"}]}]});
        for (field, value) in [
            ("safetySettings", json!([])),
            ("cachedContent", json!("cachedContents/123")),
        ] {
            let mut request = base.clone();
            request[field] = value;
            assert!(to_ir(&request).is_err());
        }
        let mut request = base.clone();
        request["tools"] = json!([{"googleSearch":{}}]);
        assert!(to_ir(&request).is_err());
        request = base.clone();
        request["contents"][0]["parts"] =
            json!([{"functionResponse":{"name":"missing","response":{}}}]);
        assert!(to_ir(&request).is_err());
        request = base;
        request["generationConfig"] = json!({"candidateCount":2});
        assert!(to_ir(&request).is_err());
    }

    #[test]
    fn stream_separates_thoughts_tools_and_usage() {
        let mut index = 0;
        let chunks=chat_chunks(&json!({"candidates":[{"content":{"parts":[{"text":"think","thought":true},{"text":"hello"},{"functionCall":{"name":"lookup","args":{"q":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}),"alias","id",&mut index).unwrap();
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["reasoning_content"],
            "think"
        );
        assert_eq!(chunks[1]["choices"][0]["delta"]["content"], "hello");
        assert_eq!(
            chunks[2]["choices"][0]["delta"]["tool_calls"][0]["index"],
            0
        );
        assert_eq!(chunks[3]["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(chunks[3]["usage"]["prompt_tokens"], 4);
    }

    #[test]
    fn cross_protocol_inputs_and_outputs_never_discard_signed_parts_or_candidates() {
        assert!(to_ir(&json!({"model":"m","contents":[{"role":"model","parts":[{"text":"signed","thoughtSignature":"state"}]}]})).is_err());
        let many = json!({"candidates":[{"content":{"parts":[{"text":"first"}]},"finishReason":"STOP"},{"content":{"parts":[{"text":"second"}]},"finishReason":"STOP"}]});
        assert!(response_to_ir(&many).is_err());
        assert!(chat_chunks(&many, "m", "r", &mut 0).is_err());
        assert!(chat_chunks(&json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":[1]}}]}}]}),"m","r",&mut 0).is_err());
    }
}
