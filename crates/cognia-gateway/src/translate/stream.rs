//! Streaming protocol transcoder — converts upstream SSE chunks into the
//! inbound format's wire events AS THEY ARRIVE (new-api `HandleStreamFormat`
//! analog). A pull state machine: the executor de-frames upstream SSE,
//! feeds each data payload to `push`, writes the returned frames to the
//! client, and calls `finish` when the upstream ends.
//!
//! Directions (same-format pairs bypass the transcoder entirely):
//!   - OpenAiToAnthropic: openai-protocol upstream → Anthropic client
//!     (the Claude-Code-CLI-on-any-provider path)
//!   - AnthropicToOpenAi: anthropic-protocol upstream → OpenAI client
//!
//! The hard part is fragmented tool calls: OpenAI streams `arguments` as
//! string fragments on indexed `tool_calls` deltas; Anthropic streams
//! `input_json_delta.partial_json` on indexed content blocks. Both sides
//! accumulate per-index state here.

use serde_json::{json, Value};

use super::ir::{IrStopReason, IrUsage};

/// One outbound SSE frame. Anthropic frames carry an `event:` name; OpenAI
/// frames are data-only (the terminal frame is the literal `[DONE]`).
#[derive(Debug, Clone, PartialEq)]
pub struct SseOut {
    pub event: Option<String>,
    pub data: String,
}

impl SseOut {
    fn json(event: Option<&str>, data: Value) -> Self {
        Self {
            event: event.map(|e| e.to_string()),
            data: data.to_string(),
        }
    }

    pub fn done() -> Self {
        Self {
            event: None,
            data: "[DONE]".to_string(),
        }
    }

    /// Serialize to wire bytes (`event:` line when named, then `data:`).
    pub fn to_frame(&self) -> String {
        match &self.event {
            Some(event) => format!("event: {event}\ndata: {}\n\n", self.data),
            None => format!("data: {}\n\n", self.data),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    OpenAiToAnthropic,
    AnthropicToOpenAi,
    ResponsesToOpenAi,
    ResponsesToAnthropic,
    GeminiToOpenAi,
    GeminiToAnthropic,
    GeminiToResponses,
    OpenAiToGemini,
    AnthropicToGemini,
    ResponsesToGemini,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum OpenBlock {
    None,
    Text { index: u64 },
    Tool { index: u64 },
    Thinking { index: u64 },
}

pub struct StreamTranscoder {
    direction: Direction,
    /// Model id reported to the client (the one the CLIENT asked for).
    client_model: String,
    started: bool,
    finished: bool,
    open_block: OpenBlock,
    next_block_index: u64,
    /// openai tool_calls index → anthropic content-block index.
    tool_block_index: std::collections::HashMap<u64, u64>,
    /// anthropic content-block index → openai tool_calls index.
    openai_tool_index: std::collections::HashMap<u64, u64>,
    next_openai_tool_index: u64,
    stop_reason: Option<IrStopReason>,
    usage: IrUsage,
    message_id: String,
    gemini_tool_index: u64,
    gemini_tool_parts: std::collections::BTreeMap<u64, Value>,
    responses: Option<super::responses::ResponsesStream>,
}

impl StreamTranscoder {
    pub fn new(
        direction: Direction,
        client_model: impl Into<String>,
        message_id: impl Into<String>,
    ) -> Self {
        let client_model = client_model.into();
        let responses = (direction == Direction::GeminiToResponses)
            .then(|| super::responses::ResponsesStream::new(&client_model, Vec::new()));
        Self {
            direction,
            client_model,
            started: false,
            finished: false,
            open_block: OpenBlock::None,
            next_block_index: 0,
            tool_block_index: std::collections::HashMap::new(),
            openai_tool_index: std::collections::HashMap::new(),
            next_openai_tool_index: 0,
            stop_reason: None,
            usage: IrUsage::default(),
            message_id: message_id.into(),
            gemini_tool_index: 0,
            gemini_tool_parts: Default::default(),
            responses,
        }
    }

    /// Token usage harvested from the stream (for telemetry, post-finish).
    pub fn usage(&self) -> IrUsage {
        self.usage
    }

    /// Feed one upstream data payload (already de-framed, JSON-parsed).
    pub fn push(&mut self, data: &Value) -> Vec<SseOut> {
        if self.finished {
            return Vec::new();
        }
        match self.direction {
            Direction::OpenAiToAnthropic => self.push_openai_chunk(data),
            Direction::AnthropicToOpenAi => self.push_anthropic_event(data),
            Direction::ResponsesToOpenAi
            | Direction::ResponsesToAnthropic
            | Direction::ResponsesToGemini => self.push_responses_event(data),
            Direction::GeminiToOpenAi
            | Direction::GeminiToAnthropic
            | Direction::GeminiToResponses => self.push_gemini(data),
            Direction::OpenAiToGemini => self.push_chat_to_gemini(data),
            Direction::AnthropicToGemini => {
                let chat = self.push_anthropic_event(data);
                let mut out = Vec::new();
                for frame in chat {
                    if let Ok(chunk) = serde_json::from_str(&frame.data) {
                        out.extend(self.push_chat_to_gemini(&chunk));
                    }
                }
                out
            }
        }
    }

    /// Upstream ended — emit the trailing frames for the inbound format.
    pub fn finish(&mut self) -> Vec<SseOut> {
        if self.finished {
            return Vec::new();
        }
        if self.direction == Direction::GeminiToResponses {
            let frames = if let Some(stop) = self.stop_reason {
                let chunk = self.terminal_chat_chunk(stop);
                let responses = self
                    .responses
                    .as_mut()
                    .expect("Responses destination initialized");
                let mut frames = responses.push(&chunk.to_string());
                frames.extend(responses.push("[DONE]"));
                frames
            } else {
                self.responses
                    .as_mut()
                    .expect("Responses destination initialized")
                    .fail("Gemini stream ended without a finish reason")
            };
            self.finished = true;
            return Self::from_wire_frames(frames);
        }
        if matches!(
            self.direction,
            Direction::OpenAiToGemini | Direction::AnthropicToGemini | Direction::ResponsesToGemini
        ) {
            if self.stop_reason.is_none() {
                self.finished = true;
                return vec![Self::gemini_error(
                    "upstream stream ended without a finish reason",
                )];
            }
            let mut out = self.flush_gemini_tools();
            if self.finished {
                return out;
            }
            out.push(SseOut::json(None, json!({"responseId":self.message_id,"modelVersion":self.client_model,
                "candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":match self.stop_reason {Some(IrStopReason::MaxTokens)=>"MAX_TOKENS",Some(IrStopReason::Other)=>"OTHER",_=>"STOP"}}],
                "usageMetadata":{"promptTokenCount":self.usage.input_tokens,"candidatesTokenCount":self.usage.output_tokens,"cachedContentTokenCount":self.usage.cache_read_tokens,"totalTokenCount":self.usage.input_tokens.saturating_add(self.usage.output_tokens)}})));
            self.finished = true;
            return out;
        }
        if matches!(
            self.direction,
            Direction::GeminiToOpenAi | Direction::GeminiToAnthropic
        ) && self.stop_reason.is_none()
        {
            self.finished = true;
            return vec![SseOut::json(
                Some("error"),
                json!({"error":{"type":"api_error","message":"Gemini stream ended without a finish reason"}}),
            )];
        }
        self.finished = true;
        let mut out = Vec::new();
        match self.direction {
            Direction::OpenAiToAnthropic
            | Direction::ResponsesToAnthropic
            | Direction::GeminiToAnthropic => {
                self.ensure_started_anthropic(&mut out);
                self.close_open_block(&mut out);
                let stop = self.stop_reason.unwrap_or(IrStopReason::Stop);
                out.push(SseOut::json(
                    Some("message_delta"),
                    json!({
                        "type": "message_delta",
                        "delta": { "stop_reason": stop.to_anthropic(), "stop_sequence": null },
                        "usage": { "output_tokens": self.usage.output_tokens },
                    }),
                ));
                out.push(SseOut::json(
                    Some("message_stop"),
                    json!({ "type": "message_stop" }),
                ));
            }
            Direction::AnthropicToOpenAi
            | Direction::ResponsesToOpenAi
            | Direction::GeminiToOpenAi => {
                let stop = self.stop_reason.unwrap_or(IrStopReason::Stop);
                out.push(SseOut::json(
                    None,
                    json!({
                        "id": self.message_id,
                        "object": "chat.completion.chunk",
                        "model": self.client_model,
                        "choices": [{ "index": 0, "delta": {}, "finish_reason": stop.to_openai() }],
                        "usage": {
                            "prompt_tokens": self.usage.input_tokens,
                            "completion_tokens": self.usage.output_tokens,
                            "total_tokens": self.usage.input_tokens + self.usage.output_tokens,
                            "prompt_tokens_details":{"cached_tokens":self.usage.cache_read_tokens},
                        }
                    }),
                ));
                out.push(SseOut::done());
            }
            _ => unreachable!("Gemini destination handled before legacy trailers"),
        }
        out
    }

    fn terminal_chat_chunk(&self, stop: IrStopReason) -> Value {
        json!({"id":self.message_id,"object":"chat.completion.chunk","model":self.client_model,
            "choices":[{"index":0,"delta":{},"finish_reason":stop.to_openai()}],
            "usage":{"prompt_tokens":self.usage.input_tokens,"completion_tokens":self.usage.output_tokens,
                "total_tokens":self.usage.input_tokens.saturating_add(self.usage.output_tokens),
                "prompt_tokens_details":{"cached_tokens":self.usage.cache_read_tokens}}})
    }

    fn from_wire_frames(frames: Vec<String>) -> Vec<SseOut> {
        frames
            .into_iter()
            .map(|frame| {
                let event = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("event: ").map(str::to_owned));
                let data = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data: "))
                    .collect::<Vec<_>>()
                    .join("\n");
                SseOut { event, data }
            })
            .collect()
    }

    fn gemini_error(message: &str) -> SseOut {
        SseOut::json(
            None,
            json!({"error":{"code":502,"status":"UNKNOWN","message":message}}),
        )
    }

    fn push_gemini(&mut self, data: &Value) -> Vec<SseOut> {
        if data.get("usageMetadata").is_some() || data.get("usage_metadata").is_some() {
            self.usage = super::gemini::usage(data);
        }
        let chunks = match super::gemini::chat_chunks(
            data,
            &self.client_model,
            &self.message_id,
            &mut self.gemini_tool_index,
        ) {
            Ok(chunks) => chunks,
            Err(error) => {
                self.finished = true;
                return if let Some(responses) = &mut self.responses {
                    Self::from_wire_frames(responses.fail(&error.reason))
                } else {
                    vec![SseOut::json(
                        Some("error"),
                        json!({"error":{"type":"api_error","message":error.reason}}),
                    )]
                };
            }
        };
        let mut out = Vec::new();
        for mut chunk in chunks {
            if let Some(reason) = chunk["choices"][0]["finish_reason"].as_str() {
                self.stop_reason = Some(IrStopReason::from_openai(reason));
                // Gemini may send a separate usage trailer after its terminal
                // candidate; wait for EOF before closing the destination.
                chunk["choices"][0]["finish_reason"] = Value::Null;
            }
            match self.direction {
                Direction::GeminiToAnthropic => out.extend(self.push_openai_chunk(&chunk)),
                Direction::GeminiToResponses => out.extend(Self::from_wire_frames(
                    self.responses
                        .as_mut()
                        .expect("Responses destination initialized")
                        .push(&chunk.to_string()),
                )),
                _ => out.push(SseOut::json(None, chunk)),
            }
        }
        out
    }

    fn push_chat_to_gemini(&mut self, chunk: &Value) -> Vec<SseOut> {
        if let Some(value) = chunk["usage"]["prompt_tokens"].as_u64() {
            self.usage.input_tokens = value;
        }
        if let Some(value) = chunk["usage"]["completion_tokens"].as_u64() {
            self.usage.output_tokens = value;
        }
        if let Some(value) = chunk["usage"]["prompt_tokens_details"]["cached_tokens"].as_u64() {
            self.usage.cache_read_tokens = value;
        }
        let Some(choice) = chunk["choices"].as_array().and_then(|items| items.first()) else {
            return Vec::new();
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop_reason = Some(IrStopReason::from_openai(reason));
        }
        let mut parts = Vec::new();
        let delta = &choice["delta"];
        if let Some(text) = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
        {
            if !text.is_empty() {
                parts.push(json!({"text":text,"thought":true}));
            }
        }
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                parts.push(json!({"text":text}));
            }
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = call["index"].as_u64().unwrap_or(0);
            let state = self
                .gemini_tool_parts
                .entry(index)
                .or_insert_with(|| json!({"id":"","name":"","arguments":""}));
            if let Some(id) = call["id"].as_str() {
                state["id"] = json!(id);
            }
            if let Some(name) = call["function"]["name"].as_str() {
                state["name"] = json!(name);
            }
            if let Some(fragment) = call["function"]["arguments"].as_str() {
                let mut args = state["arguments"].as_str().unwrap_or("").to_owned();
                args.push_str(fragment);
                state["arguments"] = json!(args);
            }
        }
        let mut out = if parts.is_empty() {
            Vec::new()
        } else {
            vec![SseOut::json(
                None,
                json!({"responseId":self.message_id,"modelVersion":self.client_model,"candidates":[{"index":0,"content":{"role":"model","parts":parts}}]}),
            )]
        };
        if choice["finish_reason"].is_string() {
            out.extend(self.flush_gemini_tools());
        }
        out
    }

    fn flush_gemini_tools(&mut self) -> Vec<SseOut> {
        if self.gemini_tool_parts.is_empty() {
            return Vec::new();
        }
        let mut parts = Vec::new();
        for (_, state) in std::mem::take(&mut self.gemini_tool_parts) {
            let args = state["arguments"]
                .as_str()
                .filter(|value| !value.is_empty())
                .unwrap_or("{}");
            let Ok(args) = serde_json::from_str::<Value>(args) else {
                self.finished = true;
                return vec![Self::gemini_error(
                    "upstream function arguments are not valid JSON",
                )];
            };
            if !args.is_object() || state["name"].as_str().is_none_or(|name| name.is_empty()) {
                self.finished = true;
                return vec![Self::gemini_error(
                    "upstream function call requires a name and object arguments",
                )];
            }
            parts.push(json!({"functionCall":{"id":state["id"],"name":state["name"],"args":args}}));
        }
        vec![SseOut::json(
            None,
            json!({"responseId":self.message_id,"modelVersion":self.client_model,"candidates":[{"index":0,"content":{"role":"model","parts":parts}}]}),
        )]
    }

    fn push_responses_event(&mut self, data: &Value) -> Vec<SseOut> {
        if self.finished {
            return Vec::new();
        }
        let mut delta = json!({});
        let mut stop: Option<&str> = None;
        match data["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => delta["content"] = data["delta"].clone(),
            "response.reasoning_summary_text.delta" => {
                delta["reasoning_content"] = data["delta"].clone()
            }
            "response.output_item.added" if data["item"]["type"] == "function_call" => {
                delta["tool_calls"] = json!([{"index":data["output_index"],"id":data["item"]["call_id"],"type":"function","function":{"name":data["item"]["name"],"arguments":""}}]);
            }
            "response.function_call_arguments.delta" => {
                delta["tool_calls"] =
                    json!([{"index":data["output_index"],"function":{"arguments":data["delta"]}}]);
            }
            "response.completed" | "response.incomplete" => {
                self.usage.input_tokens = data["response"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                self.usage.output_tokens = data["response"]["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                self.usage.cache_read_tokens = data["response"]["usage"]["input_tokens_details"]
                    ["cached_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                stop = Some(if data["type"] == "response.incomplete" {
                    "length"
                } else if data["response"]["output"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["type"] == "function_call"))
                {
                    "tool_calls"
                } else {
                    "stop"
                });
                self.stop_reason = stop.map(IrStopReason::from_openai);
            }
            "response.failed" | "error" => {
                self.finished = true;
                if self.direction == Direction::ResponsesToGemini {
                    return vec![Self::gemini_error("upstream Responses stream failed")];
                }
                return vec![SseOut::json(
                    Some("error"),
                    json!({"error":{"type":"api_error","message":"upstream Responses stream failed"}}),
                )];
            }
            _ => return Vec::new(),
        }
        let chat = json!({"id":self.message_id,"object":"chat.completion.chunk","model":self.client_model,
            "choices":[{"index":0,"delta":delta,"finish_reason":stop}],
            "usage":{"prompt_tokens":self.usage.input_tokens,"completion_tokens":self.usage.output_tokens}});
        if self.direction == Direction::ResponsesToGemini {
            self.push_chat_to_gemini(&chat)
        } else if self.direction == Direction::ResponsesToAnthropic {
            self.push_openai_chunk(&chat)
        } else {
            let mut out = vec![SseOut::json(None, chat)];
            if stop.is_some() {
                self.finished = true;
                out.push(SseOut::done());
            }
            out
        }
    }

    // ---- openai upstream → anthropic client --------------------------------

    fn ensure_started_anthropic(&mut self, out: &mut Vec<SseOut>) {
        if self.started {
            return;
        }
        self.started = true;
        out.push(SseOut::json(
            Some("message_start"),
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.client_model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": self.usage.input_tokens.saturating_sub(self.usage.cache_read_tokens), "cache_read_input_tokens":self.usage.cache_read_tokens, "output_tokens": 0 },
                }
            }),
        ));
    }

    fn close_open_block(&mut self, out: &mut Vec<SseOut>) {
        let index = match self.open_block {
            OpenBlock::None => return,
            OpenBlock::Text { index }
            | OpenBlock::Tool { index }
            | OpenBlock::Thinking { index } => index,
        };
        out.push(SseOut::json(
            Some("content_block_stop"),
            json!({ "type": "content_block_stop", "index": index }),
        ));
        self.open_block = OpenBlock::None;
    }

    fn push_openai_chunk(&mut self, chunk: &Value) -> Vec<SseOut> {
        let mut out = Vec::new();

        // The include_usage trailer (and some providers' final chunk) carries
        // usage — harvest whenever present.
        if let Some(usage) = chunk.get("usage").filter(|u| !u.is_null()) {
            if let Some(p) = usage["prompt_tokens"].as_u64() {
                self.usage.input_tokens = p;
            }
            if let Some(c) = usage["completion_tokens"].as_u64() {
                self.usage.output_tokens = c;
            }
            if let Some(cached) = usage["prompt_tokens_details"]["cached_tokens"].as_u64() {
                self.usage.cache_read_tokens = cached;
            }
        }

        let Some(choice) = chunk["choices"].as_array().and_then(|c| c.first()) else {
            return out;
        };
        self.ensure_started_anthropic(&mut out);

        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop_reason = Some(IrStopReason::from_openai(reason));
        }

        let delta = &choice["delta"];

        if let Some(thinking) = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
        {
            if !thinking.is_empty() {
                if !matches!(self.open_block, OpenBlock::Thinking { .. }) {
                    self.close_open_block(&mut out);
                    let index = self.next_block_index;
                    self.next_block_index += 1;
                    self.open_block = OpenBlock::Thinking { index };
                    out.push(SseOut::json(Some("content_block_start"), json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":"","signature":"cognia-advisory"}})));
                }
                if let OpenBlock::Thinking { index } = self.open_block {
                    out.push(SseOut::json(Some("content_block_delta"), json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":thinking}})));
                }
            }
        }

        // Text deltas.
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                if !matches!(self.open_block, OpenBlock::Text { .. }) {
                    self.close_open_block(&mut out);
                    let index = self.next_block_index;
                    self.next_block_index += 1;
                    self.open_block = OpenBlock::Text { index };
                    out.push(SseOut::json(
                        Some("content_block_start"),
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": { "type": "text", "text": "" },
                        }),
                    ));
                }
                if let OpenBlock::Text { index } = self.open_block {
                    out.push(SseOut::json(
                        Some("content_block_delta"),
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "text_delta", "text": text },
                        }),
                    ));
                }
            }
        }

        // Fragmented tool calls.
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let oa_index = call["index"].as_u64().unwrap_or(0);
                let is_new =
                    call["id"].as_str().is_some() || call["function"]["name"].as_str().is_some();
                if is_new && !self.tool_block_index.contains_key(&oa_index) {
                    self.close_open_block(&mut out);
                    let index = self.next_block_index;
                    self.next_block_index += 1;
                    self.tool_block_index.insert(oa_index, index);
                    self.open_block = OpenBlock::Tool { index };
                    out.push(SseOut::json(
                        Some("content_block_start"),
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {
                                "type": "tool_use",
                                "id": call["id"].as_str().unwrap_or(""),
                                "name": call["function"]["name"].as_str().unwrap_or(""),
                                "input": {},
                            },
                        }),
                    ));
                }
                if let Some(fragment) = call["function"]["arguments"].as_str() {
                    if !fragment.is_empty() {
                        if let Some(&index) = self.tool_block_index.get(&oa_index) {
                            out.push(SseOut::json(
                                Some("content_block_delta"),
                                json!({
                                    "type": "content_block_delta",
                                    "index": index,
                                    "delta": { "type": "input_json_delta", "partial_json": fragment },
                                }),
                            ));
                        }
                    }
                }
            }
        }

        out
    }

    // ---- anthropic upstream → openai client --------------------------------

    fn push_anthropic_event(&mut self, event: &Value) -> Vec<SseOut> {
        let mut out = Vec::new();
        match event["type"].as_str() {
            Some("message_start") => {
                if let Some(p) = event["message"]["usage"]["input_tokens"].as_u64() {
                    self.usage.cache_read_tokens = event["message"]["usage"]
                        ["cache_read_input_tokens"]
                        .as_u64()
                        .unwrap_or(0);
                    self.usage.input_tokens = p
                        .saturating_add(self.usage.cache_read_tokens)
                        .saturating_add(
                            event["message"]["usage"]["cache_creation_input_tokens"]
                                .as_u64()
                                .unwrap_or(0),
                        );
                }
                if !self.started {
                    self.started = true;
                    out.push(
                        self.openai_chunk(json!({ "role": "assistant", "content": "" }), None),
                    );
                }
            }
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block["type"].as_str() == Some("tool_use") {
                    let an_index = event["index"].as_u64().unwrap_or(0);
                    let oa_index = self.next_openai_tool_index;
                    self.next_openai_tool_index += 1;
                    self.openai_tool_index.insert(an_index, oa_index);
                    out.push(self.openai_chunk(
                        json!({ "tool_calls": [{
                            "index": oa_index,
                            "id": block["id"].as_str().unwrap_or(""),
                            "type": "function",
                            "function": {
                                "name": block["name"].as_str().unwrap_or(""),
                                "arguments": "",
                            },
                        }]}),
                        None,
                    ));
                }
            }
            Some("content_block_delta") => match event["delta"]["type"].as_str() {
                Some("thinking_delta") => {
                    if let Some(text) = event["delta"]["thinking"].as_str() {
                        out.push(self.openai_chunk(json!({"reasoning_content":text}), None));
                    }
                }
                Some("text_delta") => {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        out.push(self.openai_chunk(json!({ "content": text }), None));
                    }
                }
                Some("input_json_delta") => {
                    let an_index = event["index"].as_u64().unwrap_or(0);
                    if let Some(&oa_index) = self.openai_tool_index.get(&an_index) {
                        let fragment = event["delta"]["partial_json"].as_str().unwrap_or("");
                        out.push(self.openai_chunk(
                            json!({ "tool_calls": [{
                                "index": oa_index,
                                "function": { "arguments": fragment },
                            }]}),
                            None,
                        ));
                    }
                }
                _ => {}
            },
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(IrStopReason::from_anthropic(reason));
                }
                if let Some(c) = event["usage"]["output_tokens"].as_u64() {
                    self.usage.output_tokens = c;
                }
            }
            // ping / content_block_stop / message_stop carry nothing the
            // openai shape needs mid-stream; finish() emits the trailer.
            _ => {}
        }
        out
    }

    fn openai_chunk(&self, delta: Value, finish_reason: Option<&str>) -> SseOut {
        SseOut::json(
            None,
            json!({
                "id": self.message_id,
                "object": "chat.completion.chunk",
                "model": self.client_model,
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_stream_reaches_chat_messages_and_responses_with_tools_reasoning_and_cache() {
        for direction in [
            Direction::GeminiToOpenAi,
            Direction::GeminiToAnthropic,
            Direction::GeminiToResponses,
        ] {
            let mut transcoder = StreamTranscoder::new(direction, "alias", "message");
            let mut frames = transcoder.push(&json!({"candidates":[{"content":{"parts":[
                {"text":"consider","thought":true},{"text":"answer"},
                {"functionCall":{"id":"call-one","name":"lookup","args":{"q":"value"}},"thoughtSignature":"signature"}
            ]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":6}}));
            frames.extend(transcoder.finish());
            let wire = frames.iter().map(SseOut::to_frame).collect::<String>();
            assert!(wire.contains("consider"), "{direction:?}: {wire}");
            assert!(wire.contains("answer"), "{direction:?}: {wire}");
            assert!(wire.contains("lookup"), "{direction:?}: {wire}");
            assert_eq!(
                transcoder.usage(),
                IrUsage {
                    input_tokens: 8,
                    output_tokens: 5,
                    cache_read_tokens: 6
                }
            );
            match direction {
                Direction::GeminiToOpenAi => {
                    assert!(wire.contains("reasoning_content"));
                    assert_eq!(frames.last().unwrap().data, "[DONE]");
                }
                Direction::GeminiToAnthropic => {
                    assert!(wire.contains("thinking_delta"));
                    assert!(wire.contains("input_json_delta"));
                    assert_eq!(
                        frames.last().unwrap().event.as_deref(),
                        Some("message_stop")
                    );
                }
                Direction::GeminiToResponses => {
                    assert!(wire.contains("response.reasoning_summary_text.delta"));
                    assert!(wire.contains("response.completed"));
                    assert!(wire.contains("cached_tokens"));
                }
                _ => unreachable!(),
            }
            assert!(transcoder.finish().is_empty());
        }
    }

    #[test]
    fn chat_stream_to_gemini_buffers_fragmented_function_arguments() {
        let mut transcoder = StreamTranscoder::new(Direction::OpenAiToGemini, "alias", "message");
        let mut frames = transcoder.push(&json!({"choices":[{"delta":{"reasoning_content":"think","content":"hello","tool_calls":[{"index":0,"id":"call-a","function":{"name":"lookup","arguments":"{\"q\":"}}]}}]}));
        assert!(frames
            .iter()
            .all(|frame| !frame.data.contains("functionCall")));
        frames.extend(transcoder.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"value\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":6,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}})));
        frames.extend(transcoder.finish());
        let values: Vec<Value> = frames.iter().map(parse).collect();
        let parts: Vec<&Value> = values
            .iter()
            .flat_map(|value| {
                value["candidates"][0]["content"]["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .collect();
        assert!(parts
            .iter()
            .any(|part| part["thought"] == true && part["text"] == "think"));
        assert!(parts
            .iter()
            .any(|part| part["functionCall"]["args"] == json!({"q":"value"})));
        assert_eq!(
            values.last().unwrap()["usageMetadata"]["cachedContentTokenCount"],
            3
        );
        assert_eq!(
            values.last().unwrap()["candidates"][0]["finishReason"],
            "STOP"
        );
        assert!(frames.iter().all(|frame| frame.data != "[DONE]"));
    }

    #[test]
    fn messages_and_responses_streams_reach_gemini_without_losing_usage() {
        let mut messages = StreamTranscoder::new(Direction::AnthropicToGemini, "alias", "message");
        let mut frames = messages.push(&json!({"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":2}}}));
        frames.extend(messages.push(&json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}})));
        frames.extend(messages.push(&json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}})));
        frames.extend(messages.push(&json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}})));
        frames.extend(messages.finish());
        assert_eq!(
            parse(frames.last().unwrap())["candidates"][0]["finishReason"],
            "MAX_TOKENS"
        );
        assert_eq!(
            messages.usage(),
            IrUsage {
                input_tokens: 6,
                output_tokens: 3,
                cache_read_tokens: 2
            }
        );

        let mut responses = StreamTranscoder::new(Direction::ResponsesToGemini, "alias", "message");
        let mut frames =
            responses.push(&json!({"type":"response.output_text.delta","delta":"hello"}));
        frames.extend(
            responses
                .push(&json!({"type":"response.reasoning_summary_text.delta","delta":"think"})),
        );
        frames.extend(responses.push(&json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call-a","name":"lookup"}})));
        frames.extend(responses.push(&json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"q\":1}"})));
        frames.extend(responses.push(&json!({"type":"response.completed","response":{"output":[{"type":"function_call"}],"usage":{"input_tokens":9,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}})));
        frames.extend(responses.finish());
        let wire = frames.iter().map(SseOut::to_frame).collect::<String>();
        assert!(wire.contains("functionCall"));
        assert!(wire.contains("lookup"));
        assert!(wire.contains("think"));
        assert_eq!(
            responses.usage(),
            IrUsage {
                input_tokens: 9,
                output_tokens: 4,
                cache_read_tokens: 2
            }
        );
    }

    #[test]
    fn gemini_streams_do_not_turn_truncation_or_invalid_tools_into_success() {
        for direction in [
            Direction::GeminiToOpenAi,
            Direction::GeminiToAnthropic,
            Direction::GeminiToResponses,
            Direction::OpenAiToGemini,
            Direction::AnthropicToGemini,
            Direction::ResponsesToGemini,
        ] {
            let mut transcoder = StreamTranscoder::new(direction, "alias", "id");
            let frames = transcoder.finish();
            let wire = frames.iter().map(SseOut::to_frame).collect::<String>();
            assert!(
                wire.contains("error") || wire.contains("response.failed"),
                "{direction:?}: {wire}"
            );
            assert!(!wire.contains("response.completed"));
            assert!(!wire.contains("\"finishReason\":\"STOP\""));
        }
        let mut transcoder = StreamTranscoder::new(Direction::OpenAiToGemini, "alias", "id");
        transcoder.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"id","function":{"name":"lookup","arguments":"{"}}]}}]}));
        let frames =
            transcoder.push(&json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}));
        assert_eq!(parse(&frames[0])["error"]["code"], 502);
        assert!(transcoder.finish().is_empty());
    }

    fn parse(out: &SseOut) -> Value {
        serde_json::from_str(&out.data).unwrap()
    }

    fn events(outs: &[SseOut]) -> Vec<String> {
        outs.iter()
            .map(|o| {
                o.event
                    .clone()
                    .unwrap_or_else(|| parse_type(o).unwrap_or_else(|| "data".into()))
            })
            .collect()
    }

    fn parse_type(out: &SseOut) -> Option<String> {
        serde_json::from_str::<Value>(&out.data)
            .ok()
            .and_then(|v| v["type"].as_str().map(|s| s.to_string()))
    }

    #[test]
    fn openai_to_anthropic_golden_text_sequence() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "alias-model", "msg_1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "Hel" } }] })));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "lo" } }] })));
        all.extend(t.push(&json!({
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 9, "completion_tokens": 2 }
        })));
        all.extend(t.finish());

        assert_eq!(
            events(&all),
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        // Deltas carry the text.
        assert_eq!(parse(&all[2])["delta"]["text"], "Hel");
        assert_eq!(parse(&all[3])["delta"]["text"], "lo");
        // Trailer carries stop reason + output tokens.
        assert_eq!(parse(&all[5])["delta"]["stop_reason"], "end_turn");
        assert_eq!(parse(&all[5])["usage"]["output_tokens"], 2);
        assert_eq!(
            t.usage(),
            IrUsage {
                input_tokens: 9,
                output_tokens: 2,
                ..Default::default()
            }
        );
        // SSE framing includes the event name line.
        assert!(all[0]
            .to_frame()
            .starts_with("event: message_start\ndata: "));
    }

    #[test]
    fn openai_to_anthropic_fragmented_tool_call() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "m", "msg_1");
        let mut all = Vec::new();
        all.extend(
            t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "checking" } }] })),
        );
        all.extend(t.push(
            &json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
                "index": 0, "id": "call_1", "type": "function",
                "function": { "name": "get_weather", "arguments": "" }
            }]}}]}),
        ));
        all.extend(t.push(
            &json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "{\"ci" }
            }]}}]}),
        ));
        all.extend(t.push(
            &json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "ty\":\"SF\"}" }
            }]}}]}),
        ));
        all.extend(t.push(
            &json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] }),
        ));
        all.extend(t.finish());

        let names = events(&all);
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start", // text
                "content_block_delta", // "checking"
                "content_block_stop",  // text closed by tool start
                "content_block_start", // tool_use
                "content_block_delta", // partial 1
                "content_block_delta", // partial 2
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        // Tool block carries id/name; deltas accumulate the SAME index.
        let start = parse(&all[4]);
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(start["content_block"]["id"], "call_1");
        assert_eq!(start["content_block"]["name"], "get_weather");
        let d1 = parse(&all[5]);
        let d2 = parse(&all[6]);
        assert_eq!(d1["index"], start["index"]);
        assert_eq!(d1["delta"]["type"], "input_json_delta");
        let joined = format!(
            "{}{}",
            d1["delta"]["partial_json"].as_str().unwrap(),
            d2["delta"]["partial_json"].as_str().unwrap()
        );
        assert_eq!(joined, "{\"city\":\"SF\"}");
        assert_eq!(parse(&all[8])["delta"]["stop_reason"], "tool_use");
    }

    #[test]
    fn anthropic_to_openai_golden_sequence() {
        let mut t = StreamTranscoder::new(Direction::AnthropicToOpenAi, "claude-x", "chatcmpl-1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "type": "message_start", "message": {
            "id": "msg_1", "usage": { "input_tokens": 11, "output_tokens": 0 } } })));
        all.extend(t.push(&json!({ "type": "ping" })));
        all.extend(t.push(&json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "text", "text": "" } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" } })));
        all.extend(t.push(&json!({ "type": "content_block_stop", "index": 0 })));
        all.extend(t.push(&json!({ "type": "message_delta",
            "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 4 } })));
        all.extend(t.push(&json!({ "type": "message_stop" })));
        all.extend(t.finish());

        // role chunk, text chunk, final chunk, [DONE]
        assert_eq!(all.len(), 4);
        assert_eq!(parse(&all[0])["choices"][0]["delta"]["role"], "assistant");
        assert_eq!(parse(&all[1])["choices"][0]["delta"]["content"], "Hi");
        let last = parse(&all[2]);
        assert_eq!(last["choices"][0]["finish_reason"], "stop");
        assert_eq!(last["usage"]["prompt_tokens"], 11);
        assert_eq!(last["usage"]["completion_tokens"], 4);
        assert_eq!(all[3], SseOut::done());
        assert!(all[3].to_frame().ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn anthropic_to_openai_fragmented_tool_call() {
        let mut t = StreamTranscoder::new(Direction::AnthropicToOpenAi, "m", "chatcmpl-1");
        let mut all = Vec::new();
        all.extend(t.push(
            &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 1 } } }),
        ));
        all.extend(t.push(&json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "tool_use", "id": "tu_1", "name": "t", "input": {} } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": "{\"a\"" } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": ":1}" } })));
        all.extend(t.push(&json!({ "type": "message_delta",
            "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 2 } })));
        all.extend(t.finish());

        let tool_start = parse(&all[1]);
        let calls = &tool_start["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(calls["id"], "tu_1");
        assert_eq!(calls["function"]["name"], "t");
        let f1 = parse(&all[2])["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_string();
        let f2 = parse(&all[3])["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(format!("{f1}{f2}"), "{\"a\":1}");
        assert_eq!(parse(&all[4])["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn finish_is_idempotent_and_defaults_stop() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "m", "msg_1");
        let first = t.finish();
        // Even with zero chunks the anthropic client gets a valid envelope.
        assert_eq!(
            events(&first),
            vec!["message_start", "message_delta", "message_stop"]
        );
        assert!(t.finish().is_empty());
    }
}
