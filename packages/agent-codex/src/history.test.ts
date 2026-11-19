import {
  CODEX_HISTORY_FORMAT,
  detectCodexRollouts,
  isCodexRolloutFileName,
  parseCodexRollout,
  summarizeCodexRollout,
} from "./history"

const host = { redactText: (text: string) => text.replace(/alice@example\.com/g, "[email]") }
const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n")

const ROLLOUT = jsonl([
  {
    timestamp: "2025-01-03T12:00:00Z",
    type: "session_meta",
    payload: { id: "cx-1", cwd: "/work", model: "gpt-5", cli_version: "0.150.1" },
  },
  {
    timestamp: "2025-01-03T12:00:01Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "fix the bug" }],
    },
  },
  {
    timestamp: "2025-01-03T12:00:02Z",
    type: "response_item",
    payload: { type: "reasoning", summary: "thinking about it" },
  },
  {
    timestamp: "2025-01-03T12:00:03Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" },
  },
  {
    timestamp: "2025-01-03T12:00:04Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: "a.txt\nb.txt" },
  },
  {
    timestamp: "2025-01-03T12:00:05Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  },
  { timestamp: "2025-01-03T12:00:06Z", type: "response_item", payload: { type: "ghost_snapshot" } },
])

describe("parseCodexRollout", () => {
  it("updates cumulative fallback baselines even when a last-usage block is present", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "response_item", payload: { type: "message", role: "assistant", content: "one" } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 100 },
              total_token_usage: { input_tokens: 100 },
            },
          },
        },
        { type: "response_item", payload: { type: "message", role: "assistant", content: "two" } },
        {
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150 } } },
        },
      ]),
      "r",
      host
    )
    expect(parsed.messages.map((message) => message.usage?.inputTokens)).toEqual([100, 50])
  })

  it("keeps late canonical receipts on their original model and resets usage on context-only turns", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "turn_context", payload: { turn_id: "a", model: "model-a" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: "one" } },
        { type: "turn_context", payload: { turn_id: "b", model: "model-b" } },
        {
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500 } } },
        },
        {
          type: "token_usage_record",
          timestamp: "2026-11-11T10:00:01Z",
          payload: {
            turn_id: "a",
            response_id: "r1",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        { type: "response_item", payload: { type: "message", role: "assistant", content: "two" } },
      ]),
      "r",
      host
    )
    expect(parsed.messages[0].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
    })
    expect(parsed.messages[0].usageModel).toBe("model-a")
    expect(parsed.messages[1].usage).toBeUndefined()
    const contextOnly = parseCodexRollout(
      jsonl([
        { type: "turn_context", payload: { turn_id: "a" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: "one" } },
        { type: "turn_context", payload: { turn_id: "b" } },
        {
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500 } } },
        },
      ]),
      "r",
      host
    )
    expect(contextOnly.messages[0].usage).toBeUndefined()
  })

  it("preserves system/developer roles and assistant phases without using them as the title", () => {
    const rows = ["developer", "system", "user", "assistant"].map((role) => ({
      type: "response_item",
      payload: { type: "message", role, channel: "analysis", content: role },
    }))
    const parsed = parseCodexRollout(jsonl(rows), "r", host)
    expect(parsed.title).toBe("user")
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
    ])
    expect(parsed.messages[0].annotations).toEqual({ codexMessage: { role: "developer" } })
    expect(parsed.messages[3].annotations).toEqual({ codexMessage: { phase: "analysis" } })
    const spaced = rows.map((row) => JSON.stringify(row).replace(/:/g, ": ")).join("\n")
    expect(summarizeCodexRollout(spaced, "r")?.title).toBe("user")
    expect(summarizeCodexRollout(jsonl(rows), "r")?.title).toBe("user")
  })

  it("recognizes desktop task lifecycle and isolates canonical per-response usage", () => {
    const row = (type: string, payload: Record<string, unknown>, second: number) => ({
      type,
      payload,
      timestamp: `2026-11-11T10:00:${String(second).padStart(2, "0")}Z`,
    })
    const assistant = (text: string, second: number) =>
      row(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: text,
        },
        second
      )
    const usage = (responseId: string, input: number, second: number, threadId = "session") =>
      row(
        "token_usage_record",
        {
          thread_id: threadId,
          turn_id: "a",
          response_id: responseId,
          usage: { input_tokens: input, output_tokens: 2, cached_input_tokens: 1 },
          turn_token_usage: { input_tokens: 9999 },
        },
        second
      )
    const parsed = parseCodexRollout(
      jsonl([
        row("session_meta", { id: "session" }, 0),
        row("event_msg", { type: "task_started", turn_id: "a" }, 1),
        row("turn_context", { turn_id: "a", model: "model-a" }, 1),
        assistant("progress", 2),
        row(
          "event_msg",
          { type: "token_count", info: { last_token_usage: { input_tokens: 500 } } },
          3
        ),
        usage("r1", 10, 4),
        usage("r1", 20, 5),
        usage("r1", 15, 4),
        usage("r2", 30, 6),
        usage("foreign", 5000, 6, "other"),
        assistant("done", 7),
        row("event_msg", { type: "task_complete", turn_id: "a" }, 8),
        row("event_msg", { type: "task_started", turn_id: "b" }, 9),
        row("turn_context", { turn_id: "b", model: "model-b" }, 9),
        assistant("second", 10),
        row(
          "event_msg",
          { type: "token_count", info: { last_token_usage: { input_tokens: 7 } } },
          11
        ),
        row("event_msg", { type: "task_complete", turn_id: "b" }, 12),
      ]),
      "r",
      host
    )
    expect(parsed.lifecycle).toMatchObject({ status: "completed", endedAt: "2026-11-11T10:00:12Z" })
    expect(parsed.messages.map((message) => message.usage)).toEqual([
      undefined,
      { inputTokens: 50, outputTokens: 4, cacheReadInputTokens: 2 },
      { inputTokens: 7, outputTokens: 0, cacheReadInputTokens: 0 },
    ])
    expect(parsed.messages.map((message) => message.usageModel)).toEqual([
      undefined,
      "model-a",
      "model-b",
    ])
    expect(parsed.losses).toEqual([])
    expect(
      parsed.recordedEvents
        .filter((event) => event.event.kind === "lifecycle")
        .map((event) => event.turnId)
    ).toEqual(["a", "a", "b", "b"])
  })

  it("rebuilds the transcript as neutral parts", () => {
    const parsed = parseCodexRollout(ROLLOUT, "rollout.jsonl", host)
    expect(parsed).toMatchObject({
      sourceId: "codex",
      originalSessionId: "cx-1",
      cwd: "/work",
      model: "gpt-5",
      title: "fix the bug",
      sourceVersion: "0.150.1",
      createdAt: Date.parse("2025-01-03T12:00:00Z"),
      updatedAt: Date.parse("2025-01-03T12:00:06Z"),
    })
    expect(parsed.messages.map((message) => [message.role, message.parts[0]])).toEqual([
      ["user", { type: "text", text: "fix the bug" }],
      ["assistant", { type: "reasoning", text: "thinking about it" }],
      [
        "assistant",
        {
          type: "tool",
          name: "shell",
          toolCallId: "c1",
          input: { cmd: "ls" },
          result: { ok: true, output: "a.txt\nb.txt" },
        },
      ],
      ["assistant", { type: "text", text: "done" }],
    ])
    expect(parsed.losses).toEqual([
      expect.objectContaining({ path: "response_item.ghost_snapshot", kind: "approximated" }),
    ])
  })

  it("falls back to the locator when the rollout records no session id", () => {
    const parsed = parseCodexRollout(
      jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }]),
      "/x/rollout.jsonl",
      host
    )
    expect(parsed.originalSessionId).toBe("/x/rollout.jsonl")
  })

  it("records a failed tool result as an error with the recorded text", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1" } },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c1",
            output: { output: "nope", metadata: { exit_code: 1 } },
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages[0].parts[0]).toMatchObject({
      type: "tool",
      result: { ok: false, errorText: "nope" },
    })
  })

  it("keeps commentary separate from the final answer", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: {
            id: "c-1",
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [
              { type: "output_text", text: "Checking" },
              { type: "output_text", text: "Next" },
            ],
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages[0].parts).toEqual([
      { type: "commentary", text: "Checking\nNext", messageId: "c-1", source: "codex" },
    ])
  })

  it("attaches per-turn usage, deriving deltas from cumulative totals", () => {
    const assistant = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    })
    const total = (input: number, output: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    })
    const parsed = parseCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "cx", model: "gpt-5" } },
        assistant("one"),
        total(100, 30),
        assistant("two"),
        total(250, 70),
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages.map((message) => [message.usage, message.usageModel])).toEqual([
      [{ inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 0 }, "gpt-5"],
      [{ inputTokens: 150, outputTokens: 40, cacheReadInputTokens: 0 }, "gpt-5"],
    ])
  })

  it("maps current shell, search, image and tool-search items with their statuses", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: { type: "local_shell_call", call_id: "s1", action: { command: ["pwd"] } },
        },
        {
          type: "response_item",
          payload: { id: "w1", type: "web_search_call", status: "completed", action: { q: "x" } },
        },
        {
          type: "response_item",
          payload: { id: "i1", type: "image_generation_call", status: "failed", result: "YWJj" },
        },
        {
          type: "response_item",
          payload: { type: "tool_search_call", call_id: "t1", arguments: { query: "cal" } },
        },
        {
          type: "response_item",
          payload: { type: "tool_search_output", call_id: "t1", status: "completed", tools: [1] },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages.map((message) => message.parts[0])).toEqual([
      {
        type: "tool",
        name: "local_shell",
        toolCallId: "s1",
        input: { command: ["pwd"] },
        status: "running",
      },
      {
        type: "tool",
        name: "web_search",
        toolCallId: "w1",
        input: { q: "x" },
        result: { ok: true, output: { status: "completed" } },
        status: "completed",
      },
      {
        type: "tool",
        name: "image_generation",
        toolCallId: "i1",
        input: { revisedPrompt: undefined },
        result: { ok: false, errorText: '{"base64":"YWJj","status":"failed"}' },
        status: "failed",
      },
      {
        type: "tool",
        name: "tool_search",
        toolCallId: "t1",
        input: { query: "cal" },
        result: { ok: true, output: [1] },
        status: "completed",
      },
    ])
  })

  it("routes inter-agent messages and keeps their routing as annotations", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: {
            id: "m1",
            type: "agent_message",
            author: "root",
            recipient: "child",
            content: [{ type: "input_text", text: "continue" }],
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.interAgentMessages).toEqual([
      {
        messageId: "m1",
        fromSessionId: "root",
        toSessionId: "child",
        text: "continue",
        at: undefined,
      },
    ])
    expect(parsed.messages[0]).toMatchObject({
      role: "system",
      annotations: { codexAgentMessage: { author: "root", recipient: "child" } },
    })
  })

  it("records fork and subagent lineage from the session meta", () => {
    const fork = parseCodexRollout(
      jsonl([{ type: "session_meta", payload: { id: "b", forked_from_id: "a" } }]),
      "r",
      host
    )
    expect(fork).toMatchObject({ relationKind: "fork", parentNativeSessionId: "a" })
    const child = parseCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "c", source: { x: { parent_thread_id: "a" } } } },
      ]),
      "r",
      host
    )
    expect(child).toMatchObject({ relationKind: "subagent", parentNativeSessionId: "a" })
  })

  it("passes every retained diagnostic string through the host redactor", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "event_msg", payload: { type: "brand_new_event", note: "mail alice@example.com" } },
      ]),
      "r.jsonl",
      host
    )
    expect(JSON.stringify(parsed.recordedEvents)).not.toContain("alice@example.com")
    expect(JSON.stringify(parsed.recordedEvents)).toContain("[email]")
    expect(parsed.losses).toEqual([
      expect.objectContaining({ path: "event_msg.brand_new_event", kind: "approximated" }),
    ])
  })

  it("reports unparseable lines as dropped instead of failing", () => {
    const parsed = parseCodexRollout(`${ROLLOUT}\n{oops`, "r.jsonl", host)
    expect(parsed.messages.length).toBe(4)
    expect(parsed.losses).toContainEqual(expect.objectContaining({ kind: "dropped" }))
  })

  it("tracks lifecycle, plans, goals, compaction and rollback", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { timestamp: "2025-01-01T00:00:00Z", type: "event_msg", payload: { type: "turn_started" } },
        {
          type: "event_msg",
          payload: {
            type: "plan_update",
            plan: [
              { step: "inspect", status: "completed" },
              { step: "patch", status: "pending" },
            ],
          },
        },
        { type: "event_msg", payload: { type: "goal_update", goal: "ship", status: "done" } },
        { type: "event_msg", payload: { type: "context_compacted" } },
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 2 } },
        {
          timestamp: "2025-01-01T00:01:00Z",
          type: "event_msg",
          payload: { type: "turn_complete" },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.lifecycle).toMatchObject({ status: "completed" })
    expect(parsed.plans[0]).toMatchObject({ status: "active", steps: ["inspect", "patch"] })
    expect(parsed.goals[0]).toMatchObject({ description: "ship", status: "completed" })
    expect(parsed.history.map((event) => event.kind)).toEqual(["compaction", "rollback"])
  })
})

describe("summarizeCodexRollout", () => {
  it("summarises without a full parse", () => {
    expect(summarizeCodexRollout(ROLLOUT, "rollout.jsonl")).toEqual({
      sourceId: "codex",
      originalSessionId: "cx-1",
      title: "fix the bug",
      messageCount: 4,
      updatedAt: Date.parse("2025-01-03T12:00:06Z"),
      cwd: "/work",
      sourceVersion: "0.150.1",
      relationKind: undefined,
    })
  })

  it("falls back to a per-line parse for spaced JSON and agrees with the fast path", () => {
    const spaced = ROLLOUT.split("\n")
      .map((line) => JSON.stringify(JSON.parse(line), null, 1).replace(/\n/g, ""))
      .join("\n")
    expect(summarizeCodexRollout(spaced, "rollout.jsonl")).toMatchObject({
      originalSessionId: "cx-1",
      title: "fix the bug",
      messageCount: 4,
    })
  })

  it("defaults the version to the verified one and returns null for an empty file", () => {
    const summary = summarizeCodexRollout(
      jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }]),
      "r"
    )
    expect(summary?.sourceVersion).toBe(CODEX_HISTORY_FORMAT.verifiedVersion)
    expect(summarizeCodexRollout("", "r")).toBeNull()
  })

  it("carries the parent id so a picker can hide children without parsing them", () => {
    const summary = summarizeCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "c", parent_thread_id: "p" } },
        { type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
      ]),
      "r"
    )
    expect(summary).toMatchObject({ relationKind: "subagent", parentNativeSessionId: "p" })
  })
})

describe("format detection", () => {
  it("matches rollout names and paths, and sniffs content otherwise", () => {
    expect(isCodexRolloutFileName("rollout-1.JSONL")).toBe(true)
    expect(isCodexRolloutFileName("notes.md")).toBe(false)
    expect(detectCodexRollouts([])).toBe("no")
    expect(
      detectCodexRollouts([{ path: "/h/.codex/sessions/a.jsonl", name: "a.jsonl", content: "" }])
    ).toBe("match")
    expect(
      detectCodexRollouts([
        { path: "/x/rollout-1.jsonl", name: "rollout-1.jsonl", content: "" },
        { path: "/x/other.txt", name: "other.txt", content: "" },
      ])
    ).toBe("maybe")
    expect(
      detectCodexRollouts([
        { path: "/x/a.jsonl", name: "a.jsonl", content: '{"type":"session_meta","payload":{}}' },
      ])
    ).toBe("maybe")
    expect(detectCodexRollouts([{ path: "/x/a.txt", name: "a.txt", content: "plain" }])).toBe("no")
  })
})
