// Shared wire fixture for the real SDK on desktop and Web + Headless.
export const TOOL_TURN_MARKER = "[dual-host:tool-turn]"
export const TOOL_TURN_FINAL_TEXT = "[dual-host] tool turn complete"
export const TOOL_TURN_ID = "toolu_dual_host_1"

// sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:
// TodoWriteInput requires content, status and activeForm for every todo.
export const TOOL_TURN_INPUT = {
  todos: [
    {
      content: "Verify the dual-host tool turn",
      status: "completed",
      activeForm: "Verifying the dual-host tool turn",
    },
  ],
}

export function firstResponse(model = "claude-e2e") {
  return {
    id: "msg_dual_host_tool",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "tool_use", id: TOOL_TURN_ID, name: "TodoWrite", input: TOOL_TURN_INPUT }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 32 },
  }
}

export function followUpResponse(model = "claude-e2e") {
  return {
    id: "msg_dual_host_final",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: TOOL_TURN_FINAL_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 8 },
  }
}

/** Convert either non-streaming response into the SDK's Messages SSE wire format. */
export function streamingResponse(message) {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const block = message.content[0]
  const tool = block.type === "tool_use"
  const deltas = tool
    ? (() => {
        const input = JSON.stringify(block.input)
        const split = Math.floor(input.length / 2)
        return [input.slice(0, split), input.slice(split)].map((partial_json) => ({
          type: "input_json_delta",
          partial_json,
        }))
      })()
    : [{ type: "text_delta", text: block.text }]
  return [
    event("message_start", {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    event("content_block_start", {
      index: 0,
      content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
    }),
    ...deltas.map((delta) => event("content_block_delta", { index: 0, delta })),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }),
    event("message_stop", {}),
  ].join("")
}

/** Only the latest textual user prompt selects the scenario; tool results have no prompt. */
export function toolTurnResponse(request) {
  const messages = Array.isArray(request.messages) ? request.messages : []
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block) => block?.type === "text")
              .map((block) => block.text)
              .join("\n")
          : ""
    )
    .filter((text) => text.length > 0)
    .at(-1)
  if (!userText?.includes(TOOL_TURN_MARKER)) return null
  const hasResult = messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block?.type === "tool_result" && block.tool_use_id === TOOL_TURN_ID
      )
  )
  const message = hasResult ? followUpResponse(request.model) : firstResponse(request.model)
  return { message, sse: streamingResponse(message) }
}
