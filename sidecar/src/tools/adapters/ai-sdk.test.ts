// Tests for the AI SDK tool bridge: converts built-in tool defs + plugin tool
// manifests into native AI SDK tools for the non-Anthropic dispatch path.

import { test } from "node:test"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { createEventAdapter } from "../../runtimes/ai-sdk/events.ts"
import assert from "node:assert/strict"

import { buildAiSdkTools, aiSdkToolPolicyName, __testing__ } from "./ai-sdk.ts"
import { createAiSdkToolSearchController } from "./ai-sdk-tool-search.ts"
import { createSessionTaskStore } from "../state/tasks.ts"
import type { ReadTracker } from "../state/read-tracker.ts"
import { createVerificationBudget } from "../../shared/verification-budget.ts"
import { createReadTracker } from "../state/read-tracker.ts"
import { fakeSandboxRss } from "../../../test-support/sandbox-rss.ts"

// Broker tests exercise dispatch, not OS RSS accounting (which has its own
// supervisor tests). Keep real child execution while supplying process usage.
fakeSandboxRss()

test("production AI SDK tools preserve closed process admission for Bash and PTY", async () => {
  const closed = new AbortController()
  closed.abort()
  const tools = build({
    sessionId: "closed-tools",
    processSignal: closed.signal,
    groupProofSupported: false,
    readTracker: createReadTracker(),
    emit() {},
    sendOptions: {
      builtinTools: { coreFiles: true, terminalRepl: true },
      permissionMode: "bypassPermissions",
    },
  })
  await assert.rejects(
    tools.bash!.execute({ command: "echo should-never-run" }),
    /interrupted|cancelled|aborted/
  )
  await assert.rejects(
    tools.terminal_repl_spawn!.execute({
      agentId: "closed-tools",
      shell: "/bin/sh",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    }),
    /session is closing/
  )
})

/** An AI SDK tool as these tests call it: execute without options, toModelOutput with the output alone. */
interface TestAiTool {
  description?: string
  execute(args: unknown, options?: unknown): Promise<unknown>
  toModelOutput(options: { output: unknown }): { type: string; value: unknown }
  [field: string]: unknown
}

/** A captured outbound frame. */
type Frame = Record<string, unknown>

function build(params: Parameters<typeof buildAiSdkTools>[0]): Record<string, TestAiTool> {
  return buildAiSdkTools(params) as unknown as Record<string, TestAiTool>
}

/** `builtinDefToAiSdkTool`, as a test calls the tool it returns. */
function convert(...args: Parameters<typeof __testing__.builtinDefToAiSdkTool>): TestAiTool {
  return __testing__.builtinDefToAiSdkTool(...args) as unknown as TestAiTool
}

/** The MCP result shape the resource tests read back. */
interface ResourceResult {
  content: { resource: { text: string; blob: string } }[]
}

test("buildAiSdkTools registers built-in tools for enabled categories only", () => {
  const tools = build({
    sendOptions: { builtinTools: { git: true, process: false } },
    emit: () => {},
    sessionId: "s1",
  })
  // git category contributes git_status / git_diff / git_log …
  assert.ok(tools.git_status, "git_status present when git enabled")
  // process category disabled → its tools absent.
  assert.equal(tools.process_list ?? tools.list_processes, undefined)
})

test("buildAiSdkTools keeps always-load built-ins resident under tool search", () => {
  const tools = buildAiSdkTools({
    sendOptions: { builtinTools: { fileExtras: true, git: true } },
    emit: () => {},
    sessionId: "s1",
  })
  const controller = createAiSdkToolSearchController({
    tools,
    sendOptions: { toolSearchEnabled: true },
  })!
  const active = controller.prepareStep().activeTools
  // file_info is defined with `alwaysLoad`; git_diff is not.
  assert.ok(active.includes("file_info"))
  assert.ok(!active.includes("git_diff"))
})

// CM-06: with tool search on, a Code turn's first step offered only ToolSearch.
test("buildAiSdkTools keeps run_code resident under tool search", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    const tools = buildAiSdkTools({
      sendOptions: {
        builtinTools: { git: true },
        execution: { composition: { toolPresentation: "code" } },
      },
      emit: () => {},
      sessionId: "s1",
    })
    assert.deepEqual(Object.keys(tools), ["run_code"])
    const controller = createAiSdkToolSearchController({
      tools,
      sendOptions: { toolSearchEnabled: true },
    })!
    assert.ok(controller.prepareStep().activeTools.includes("run_code"))
    assert.deepEqual(controller.deferredToolNames(), [])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("buildAiSdkTools returns no built-in tools when builtinTools is absent", () => {
  const tools = build({ sendOptions: {}, emit: () => {}, sessionId: "s1" })
  assert.equal(Object.keys(tools).length, 0)
})

test("buildAiSdkTools exposes no tools when the runtime tool surface is disabled", () => {
  const tools = build({
    sendOptions: {
      toolSurface: "none",
      builtinTools: { git: true },
      pluginTools: [
        { name: "web_search", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "support-session",
    pendingPluginToolCalls: new Map(),
  })
  assert.deepEqual(tools, {})
})

test("buildAiSdkTools wires plugin tools that round-trip through the renderer", async () => {
  const emitted: Frame[] = []
  const pendingPluginToolCalls = new Map()
  const tools = build({
    // This test exercises the plugin round-trip, not the permission gate; the
    // gate is covered separately. bypassPermissions lets execute() proceed
    // without wiring a `pendingApprovals` channel.
    sendOptions: {
      permissionMode: "bypassPermissions",
      turnId: "turn-1",
      execution: { identity: { attemptId: "attempt-2" } },
      sandboxRuntimeRef: "sandbox-runtime:ai-sdk",
      pluginTools: [
        {
          name: "my_plugin_tool",
          description: "does a thing",
          jsonSchema: { type: "object", properties: { q: { type: "string" } } },
          pluginId: "p1",
        },
      ],
    },
    emit: (m) => emitted.push(m),
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  assert.ok(tools.my_plugin_tool, "plugin tool registered")
  assert.equal(
    aiSdkToolPolicyName(tools.my_plugin_tool!),
    "mcp__cognia-plugin-tools__my_plugin_tool"
  )
  assert.equal(aiSdkToolPolicyName({ ...tools.my_plugin_tool }), undefined)

  // Kick off execute; it should emit a plugin_tool_exec and await a response.
  const execPromise = tools.my_plugin_tool!.execute({ q: "hi" }, { toolCallId: "engine-call-id" })
  // Let the microtask register the pending call.
  await Promise.resolve()
  const event = emitted.find((m) => m.type === "plugin_tool_exec")
  assert.ok(event, "plugin_tool_exec emitted")
  assert.equal(event.name, "my_plugin_tool")
  assert.equal(
    event.toolUseId,
    "engine-call-id",
    "H3: Host admission and runtime tracking share the engine call id"
  )
  assert.deepEqual(event.args, { q: "hi" })
  assert.equal(event.sandboxRuntimeRef, "sandbox-runtime:ai-sdk")
  assert.equal(event.turnId, "turn-1")
  assert.equal(event.attemptId, "attempt-2")
  assert.equal(pendingPluginToolCalls.size, 1)

  // Resolve the round-trip the way claude-host's plugin_tool_response would.
  const pending = pendingPluginToolCalls.get(event.toolUseId)
  pending.resolve({ result: "plugin says hi" })
  const result = await execPromise
  assert.equal(result, "plugin says hi")
})

test("AI SDK plugin tools honor the manifest timeout instead of the 120s default", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        {
          name: "short_deadline",
          description: "test timeout propagation",
          jsonSchema: { type: "object", properties: {} },
          pluginId: "test",
          timeoutMs: 5,
        },
      ],
    },
    emit: () => {},
    sessionId: "s-timeout",
    pendingPluginToolCalls,
  })

  const outcome = await Promise.race([
    tools.short_deadline!.execute({}).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 40)),
  ])

  assert.equal("stalled" in (outcome as object), false, "manifest timeout was ignored")
  assert.match(String((outcome as { error?: unknown }).error), /timed out after 5ms/)
  assert.equal(pendingPluginToolCalls.size, 0)
})

test("plugin tool image results pass through as content blocks the model can see", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "take_screenshot", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.take_screenshot!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  const callToolResult = {
    content: [
      { type: "text", text: "shot.png (12 bytes)" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  }
  pending.resolve({ result: callToolResult })
  // Not JSON.stringify-ed: the raw MCP object survives for toModelOutput.
  assert.deepEqual(await execPromise, callToolResult)

  // …and toModelOutput maps it to a multimodal part, not a base64 string.
  const modelOutput = tools.take_screenshot!.toModelOutput({ output: callToolResult })
  assert.equal(modelOutput.type, "content")
  assert.deepEqual(modelOutput.value, [
    { type: "text", text: "shot.png (12 bytes)" },
    { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
  ])
})

test("plugin tool audio-only results pass through as file content the model can see", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "record_audio", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.record_audio!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  const callToolResult = {
    content: [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }],
  }
  pending.resolve({ result: callToolResult })

  assert.deepEqual(await execPromise, callToolResult)
  assert.deepEqual(tools.record_audio!.toModelOutput({ output: callToolResult }), {
    type: "content",
    value: [{ type: "file", mediaType: "audio/wav", data: { type: "data", data: "UklGRg==" } }],
  })
})

test("plugin tool resource-only results pass through with embedded text and blob content", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  const callToolResult = {
    content: [
      {
        type: "resource",
        resource: { uri: "file:///repo/notes.txt", text: "resource text", mimeType: "text/plain" },
      },
      {
        type: "resource",
        resource: {
          uri: "file:///repo/clip.wav",
          name: "clip.wav",
          blob: "UklGRg==",
          mimeType: "audio/wav",
        },
      },
    ],
  }
  pending.resolve({ result: callToolResult })

  assert.deepEqual(await execPromise, callToolResult)
  assert.deepEqual(tools.read_resource!.toModelOutput({ output: callToolResult }), {
    type: "content",
    value: [
      { type: "text", text: "resource text" },
      {
        type: "file",
        mediaType: "audio/wav",
        data: { type: "data", data: "UklGRg==" },
        filename: "clip.wav",
      },
    ],
  })
})

test("plugin rich results are redacted before model output when they contain PII", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  pending.resolve({
    result: {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///repo/contacts.txt",
            text: "Contact alice@example.com",
            mimeType: "text/plain",
          },
        },
      ],
    },
  })

  const result = (await execPromise) as ResourceResult
  assert.equal(result.content[0]!.resource.text, "Contact <EMAIL_001>")
  assert.doesNotMatch(JSON.stringify(result), /alice@example\.com/)
})

test("textual resource blobs are decoded and redacted before model output", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  pending.resolve({
    result: {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///repo/contacts.txt",
            blob: Buffer.from("Contact alice@example.com").toString("base64"),
            mimeType: "text/plain; charset=utf-8",
          },
        },
      ],
    },
  })

  const result = (await execPromise) as ResourceResult
  const decoded = Buffer.from(result.content[0]!.resource.blob, "base64").toString("utf8")
  assert.equal(decoded, "Contact <EMAIL_001>")
  assert.doesNotMatch(decoded, /alice@example\.com/)
})

test("plugin tool results with no image still flatten to JSON text", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "plain", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.plain!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  pending.resolve({ result: { ok: true, count: 2 } })
  assert.equal(await execPromise, '{"ok":true,"count":2}')
})

test("plugin tool execute throws on an error response", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "boom", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.boom!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  pending.resolve({ error: "plugin failed" })
  await assert.rejects(execPromise, /plugin failed/)
})

test("plugin tool errors are redacted before they reach the model", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "boom", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.boom!.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]!
  pending.resolve({ error: "Contact alice@example.com" })

  await assert.rejects(execPromise, (error: Error) => {
    assert.match(error.message, /Contact <EMAIL_001>/)
    assert.doesNotMatch(error.message, /alice@example\.com/)
    return true
  })
})

test("buildAiSdkTools returns keys in sorted order regardless of registration order", () => {
  const tools = build({
    sendOptions: {
      builtinTools: { git: true },
      pluginTools: [
        { name: "zz_last", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "aa_first", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  const keys = Object.keys(tools)
  assert.ok(keys.length > 2, "built-in + plugin tools present")
  assert.deepEqual(keys, [...keys].sort(), "tools map keys are sorted")
  assert.ok(keys.includes("aa_first") && keys.includes("zz_last"))
})

test("buildAiSdkTools threads a caller-provided doomGuard into the gate (so the session can reset it per turn)", async () => {
  // F1: the ai-sdk tools map is built once and reused across turns, so the
  // session owns the doom-loop guard and resets it per turn. This verifies the
  // provided guard is the one the gate actually consults (the reset hook is
  // pointless if buildAiSdkTools silently makes its own).
  const checked: Frame[] = []
  const spyGuard = {
    check: (name: string, input: unknown) => {
      checked.push({ name, input })
      return null // no doom — let the call proceed
    },
    reset: () => {},
  }
  const tools = build({
    sendOptions: {
      builtinTools: { git: true },
      permissionRuleset: { "*": "allow" },
    },
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    doomGuard: spyGuard,
  })
  try {
    await tools.git_status!.execute({ cwd: "/tmp" })
  } catch {
    // The handler may fail to shell out in CI; the doom guard is consulted
    // by the gate BEFORE execution, which is all this test asserts.
  }
  assert.ok(
    checked.some((c) => c.name === "mcp__cognia-tools__git_status"),
    "the caller-provided doomGuard was consulted for the gated call"
  )
})

test("buildAiSdkTools gates a built-in tool through the permission gate (deny blocks handler)", async () => {
  const pendingApprovals = new Map()
  const tools = build({
    sendOptions: {
      builtinTools: { git: true },
      permissionRuleset: { "*": "deny" },
    },
    emit: () => {},
    sessionId: "s1",
    pendingApprovals,
  })
  // git_status execute should be blocked by the deny ruleset before running.
  await assert.rejects(tools.git_status!.execute({ cwd: "/tmp" }), /denied/)
})

test("coreFiles tools are registered on the ai-sdk path when enabled + tracked", () => {
  const tools = build({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
  })
  for (const name of [
    "grep",
    "glob",
    "read",
    "ls",
    "edit",
    "multi_edit",
    "write",
    "bash",
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "list_shells",
    "Monitor",
    "monitor_cancel",
    "monitor_list",
  ]) {
    assert.ok(tools[name], `${name} registered`)
  }
})

test("AI-SDK monitor tools reach host_rpc with the active session owner", async () => {
  const calls: Frame[] = []
  const tools = build({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "session-monitor",
    hostRpc: {
      async call(method: string, params: unknown) {
        calls.push({ method, params })
        return { monitors: [{ id: "monitor-1", status: "waiting" }] }
      },
    },
  })

  const result = JSON.parse((await tools.monitor_list!.execute({})) as string)

  assert.deepEqual(result.monitors, [{ id: "monitor-1", status: "waiting" }])
  assert.deepEqual(calls, [
    {
      method: "monitors.list",
      params: { owner: { kind: "session", sessionId: "session-monitor" } },
    },
  ])
})

test("structured tasks persist when the ai-sdk tool map is rebuilt between turns", async () => {
  const taskStore = createSessionTaskStore()
  const shared = {
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
    taskStore,
  }
  const firstTurn = build(shared)
  const created = JSON.parse(
    (await firstTurn.TaskCreate!.execute({
      subject: "Research",
      description: "Map gaps",
    })) as string
  )
  assert.equal(created.task.id, "1")

  const secondTurn = build(shared)
  const listed = JSON.parse((await secondTurn.TaskList!.execute({})) as string)
  assert.deepEqual(
    listed.tasks.map((task: { subject: string }) => task.subject),
    ["Research"]
  )
})

test("coreFiles tools are absent without a readTracker or when category disabled", () => {
  const noTracker = build({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
  })
  assert.equal(noTracker.grep, undefined)
  const disabled = build({
    sendOptions: { builtinTools: { coreFiles: false }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    // Deliberately partial: the category is off, so the tracker is never read.
    readTracker: { record() {} } as unknown as ReadTracker,
  })
  assert.equal(disabled.grep, undefined)
})

test("disallowedTools filters built-in tools by bare and namespaced names", () => {
  const tracker = { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} }
  const tools = build({
    sendOptions: {
      builtinTools: { coreFiles: true, git: true },
      cwd: ".",
      disallowedTools: ["bash", "mcp__cognia-tools__write", "mcp__cognia-tools__git_status"],
    },
    emit: () => {},
    sessionId: "s1",
    readTracker: tracker,
  })
  assert.equal(tools.bash, undefined, "bare name denied")
  assert.equal(tools.write, undefined, "namespaced name denied")
  assert.equal(tools.git_status, undefined, "namespaced builtin denied")
  assert.ok(tools.read, "undenied tools remain")
  assert.ok(tools.git_diff, "undenied git tools remain")
})

test("disallowedTools filters plugin tools too", () => {
  const tools = build({
    sendOptions: {
      pluginTools: [
        { name: "keep_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "drop_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
      disallowedTools: ["mcp__cognia-plugin-tools__drop_me"],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.ok(tools.keep_me)
  assert.equal(tools.drop_me, undefined)
})

test("allowedTools whitelist: only listed tools are exposed (bare + namespaced match)", () => {
  const tools = build({
    sendOptions: {
      builtinTools: { git: true },
      allowedTools: ["git_status", "mcp__cognia-tools__git_diff"],
    },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status, "bare allow-name exposes the tool")
  assert.ok(tools.git_diff, "namespaced allow-name exposes the tool")
  assert.equal(tools.git_log, undefined, "an unlisted git tool is filtered out")
})

test("allowedTools whitelist: Claude-Code core names map to cognia coreFiles names", () => {
  const tracker = { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} }
  const tools = build({
    sendOptions: {
      builtinTools: { coreFiles: true },
      cwd: ".",
      // A skill/character restricting to Claude-Code names must scope the
      // equivalent cognia tools on the AI-SDK path, not filter everything out.
      allowedTools: ["Read", "Grep"],
    },
    emit: () => {},
    sessionId: "s1",
    readTracker: tracker,
  })
  assert.ok(tools.read, "Read → read")
  assert.ok(tools.grep, "Grep → grep")
  assert.equal(tools.write, undefined, "Write not in allow list → write filtered")
  assert.equal(tools.bash, undefined, "Bash not in allow list → bash filtered")
})

test("allowedTools whitelist: filters plugin tools by bare and namespaced name", () => {
  const tools = build({
    sendOptions: {
      pluginTools: [
        { name: "keep_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "drop_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
      allowedTools: ["mcp__cognia-plugin-tools__keep_me"],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.ok(tools.keep_me, "listed plugin tool kept")
  assert.equal(tools.drop_me, undefined, "unlisted plugin tool filtered")
})

test("allowedTools whitelist: absent or empty → no filtering (every enabled tool exposed)", () => {
  const tools = build({
    sendOptions: { builtinTools: { git: true } }, // no allowedTools
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status && tools.git_diff && tools.git_log, "all git tools present")
  const empty = build({
    sendOptions: { builtinTools: { git: true }, allowedTools: [] },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(empty.git_status && empty.git_log, "empty allow list is treated as no restriction")
})

test("allowedTools + disallowedTools: deny still wins over an allow entry", () => {
  const tools = build({
    sendOptions: {
      builtinTools: { git: true },
      allowedTools: ["git_status", "git_diff"],
      disallowedTools: ["git_diff"],
    },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status, "allowed + not denied → present")
  assert.equal(tools.git_diff, undefined, "allowed but denied → absent (deny wins)")
})

test("builtinDefToAiSdkTool returns joined text and throws on isError", async () => {
  const okTool = convert(
    {
      name: "ok",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "done" }] }),
    },
    null,
    0
  )
  assert.equal(await okTool.execute({}), "done")

  const errTool = convert(
    {
      name: "err",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
    },
    null,
    0
  )
  await assert.rejects(errTool.execute({}), /nope/)
})

test("runBuiltinHandler bounds a hung read-only tool and rejects on timeout", async () => {
  const { runBuiltinHandler } = __testing__
  // `grep` is a read-only built-in (requiresApproval === false) → gets the net.
  const hung = { name: "grep", handler: () => new Promise(() => {}) }
  await assert.rejects(runBuiltinHandler(hung, {}, 20), /grep.*execution budget/)
})

test("runBuiltinHandler leaves exec tools unbounded (own timeout governs)", async () => {
  const { runBuiltinHandler } = __testing__
  let resolved = false
  // `bash` is NOT read-only → excluded from the net even with a tiny budget,
  // so its handler runs to completion (its own internal timeout governs).
  const slowExec = {
    name: "bash",
    handler: () =>
      new Promise((r) =>
        setTimeout(() => {
          resolved = true
          r("ok")
        }, 30)
      ),
  }
  assert.equal(await runBuiltinHandler(slowExec, {}, 5), "ok")
  assert.equal(resolved, true)
})

test("runBuiltinHandler with a 0 / non-finite budget disables the net", async () => {
  const { runBuiltinHandler } = __testing__
  const def = {
    name: "grep",
    handler: () => new Promise((r) => setTimeout(() => r("late"), 20)),
  }
  assert.equal(await runBuiltinHandler(def, {}, 0), "late")
  assert.equal(await runBuiltinHandler(def, {}, Number.POSITIVE_INFINITY), "late")
})

test("builtinDefToAiSdkTool surfaces a read-only timeout as a thrown execute (→ tool-error)", async () => {
  const t = convert(
    {
      name: "content_search",
      description: "",
      inputSchema: {},
      handler: () => new Promise(() => {}),
    },
    null,
    15
  )
  await assert.rejects(t.execute({}), /content_search.*execution budget/)
})

test("the default built-in tool budget is the 120s plugin-tool-parity safety net", () => {
  assert.equal(__testing__.DEFAULT_BUILTIN_TOOL_TIMEOUT_MS, 120_000)
})

test("execute-layer review rewrites the output the MODEL receives", async () => {
  const def = {
    name: "echo_x",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "original" }] }),
  }
  const review = async (
    toolName: string,
    _toolCallId: string | undefined,
    output: unknown,
    isError: boolean
  ) => {
    assert.equal(toolName, "mcp__cognia-tools__echo_x")
    assert.equal(output, "original")
    assert.equal(isError, false)
    return "REWRITTEN"
  }
  const t = convert(def, null, 0, review)
  const out = await t.execute({}, { toolCallId: "tc1" })
  assert.equal(out, "REWRITTEN")
})

test("execute-layer review can rewrite an error message; undefined passes through", async () => {
  const failing = {
    name: "boom",
    description: "",
    inputSchema: {},
    handler: async () => ({ isError: true, content: [{ type: "text", text: "raw failure" }] }),
  }
  const t1 = convert(failing, null, 0, async () => "cleaned failure")
  await assert.rejects(() => t1.execute({}, {}), /cleaned failure/)
  const ok = {
    name: "fine",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "kept" }] }),
  }
  const t2 = convert(ok, null, 0, async () => undefined)
  assert.equal(await t2.execute({}, {}), "kept")
})

test("built-in thrown and isError failures are redacted before they reach the model", async () => {
  const thrown = {
    name: "thrown_pii",
    description: "",
    inputSchema: {},
    handler: async () => {
      throw new Error("Contact alice@example.com")
    },
  }
  const errorResult = {
    name: "result_pii",
    description: "",
    inputSchema: {},
    handler: async () => ({
      isError: true,
      content: [{ type: "text", text: "Contact bob@example.com" }],
    }),
  }

  for (const definition of [thrown, errorResult]) {
    const subject = convert(definition, null, 0)
    await assert.rejects(
      () => subject.execute({}, {}),
      (error: Error) => {
        assert.match(error.message, /Contact <EMAIL_001>/)
        assert.doesNotMatch(error.message, /@(example\.com)/)
        return true
      }
    )
  }
})

test("JSON-string tool results remain valid while nested PII is redacted", async () => {
  const definition = {
    name: "json_pii",
    description: "",
    inputSchema: {},
    handler: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ createdAt: 1_754_000_000_000, contact: "alice@example.com" }),
        },
      ],
    }),
  }
  const subject = convert(definition, null, 0)

  const output = await subject.execute({}, {})

  assert.deepEqual(JSON.parse(output as string), {
    createdAt: 1_754_000_000_000,
    contact: "<EMAIL_001>",
  })
})

test("a throwing reviewer fails open (original output preserved)", async () => {
  assert.equal(
    await __testing__.applyOutputReview(
      async () => {
        throw new Error("reviewer broke")
      },
      "mcp__cognia-tools__x",
      "id",
      "original",
      false
    ),
    "original"
  )
})

test("fileCheckpointFrames snapshots a file writer's target after the gate and before it runs", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-checkpoint-")))
  try {
    const file = path.join(dir, "existing.txt")
    fs.writeFileSync(file, "BEFORE\n")
    const emitted: Frame[] = []
    const tools = build({
      sendOptions: {
        permissionMode: "bypassPermissions",
        builtinTools: { coreFiles: true, fileExtras: true },
        cwd: dir,
        fileCheckpointFrames: true,
      },
      emit: (m) => emitted.push(m),
      sessionId: "s1",
    })
    await tools.file_binary_write!.execute({
      path: file,
      data: Buffer.from("AFTER\n").toString("base64"),
    })
    assert.equal(fs.readFileSync(file, "utf8"), "AFTER\n")
    const frame = emitted.find((m) => m.type === "file_pre_mutation") as
      { entries: { path: string; before: string; contentBase64?: string }[] } | undefined
    assert.ok(frame, "a pre-mutation frame was emitted")
    assert.equal(frame.entries[0]!.path, file)
    assert.equal(Buffer.from(frame.entries[0]!.contentBase64!, "base64").toString(), "BEFORE\n")

    // Off unless the host asked for it.
    const quiet: Frame[] = []
    const plain = build({
      sendOptions: {
        permissionMode: "bypassPermissions",
        builtinTools: { fileExtras: true },
        cwd: dir,
      },
      emit: (m) => quiet.push(m),
      sessionId: "s1",
    })
    await plain.file_binary_write!.execute({
      path: file,
      data: Buffer.from("x").toString("base64"),
    })
    assert.equal(
      quiet.some((m) => m.type === "file_pre_mutation"),
      false
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("fileCheckpointFrames reports a sandboxed editor's target before its plugin round-trip", async () => {
  const emitted: Frame[] = []
  const pendingPluginToolCalls = new Map()
  const tools = build({
    sendOptions: {
      permissionMode: "bypassPermissions",
      cwd: "/nonexistent-workspace",
      fileCheckpointFrames: true,
      pluginTools: [
        { name: "sandbox_write", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: (m) => emitted.push(m),
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const exec = tools.sandbox_write!.execute({
    path: "/nonexistent-workspace/new.txt",
    content: "x",
  })
  await new Promise((r) => setImmediate(r))
  const types = emitted.map((m) => m.type)
  assert.deepEqual(types.slice(0, 2), ["file_pre_mutation", "plugin_tool_exec"])
  const exec_ = emitted[1] as { toolUseId: string }
  pendingPluginToolCalls.get(exec_.toolUseId).resolve({ result: "ok" })
  await exec
})

function budgetTools(sendOptions: Parameters<typeof buildAiSdkTools>[0]["sendOptions"]) {
  const budget = createVerificationBudget()
  budget.reset({ startedAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 360_000 })
  return build({
    sendOptions: { builtinTools: { coreFiles: true }, ...sendOptions },
    emit: () => {},
    sessionId: "budget-test",
    verificationBudget: budget,
    readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
  })
}

test("verification batch cannot expand a Bash or batch palette restriction", () => {
  for (const denied of ["bash", "Bash", "mcp__cognia-tools__bash", "verification_batch"]) {
    assert.equal(budgetTools({ disallowedTools: [denied] }).verification_batch, undefined)
  }
  assert.equal(budgetTools({ allowedTools: ["verification_batch"] }).verification_batch, undefined)
  assert.equal(budgetTools({ allowedTools: ["Bash"] }).verification_batch, undefined)
  assert.ok(budgetTools({ allowedTools: ["Bash", "verification_batch"] }).verification_batch)
})

test("verification batch applies nested Bash deny rules and plan restrictions", async () => {
  const commands = [{ label: "blocked", command: "echo MUST_NOT_EXECUTE" }]
  const denied = budgetTools({ permissionRuleset: { "*": "allow", Bash: "deny" } })
  const result = JSON.stringify(await denied.verification_batch!.execute({ commands }))
  assert.match(result, /denied_or_invalid/)
  assert.doesNotMatch(result, /\"status\":\"passed\"/)
  const plan = budgetTools({ permissionMode: "plan" })
  await assert.rejects(plan.verification_batch!.execute({ commands }), /plan|denied|approval/i)
})

test("verification batch admits each command after its approval and runs none once denied", async () => {
  const { createWorkerToolAdmission } = await import("../../policy/fence/admission.ts")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp2b-batch-"))
  const marker = path.join(root, "ran")
  let admitted = 0
  let denied = 0
  const workerToolAdmission = createWorkerToolAdmission({
    sessionId: "budget-test",
    onDenied() {
      denied++
    },
    hostRpc: {
      async call(method: string) {
        assert.equal(method, "worker.admitTool")
        admitted++
        // The batch tool itself is admitted; its first command's admission,
        // after that command's own approval, finds the fence closed.
        return admitted === 1 ? { allowed: true, leaseTtlMs: 60_000 } : { allowed: false }
      },
    },
  })
  try {
    const budget = createVerificationBudget()
    budget.reset({ startedAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 360_000 })
    const tools = build({
      sendOptions: { builtinTools: { coreFiles: true }, permissionMode: "bypassPermissions" },
      emit: () => {},
      sessionId: "budget-test",
      verificationBudget: budget,
      workerToolAdmission,
      readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
    })
    const commands = [
      { label: "first", command: `touch ${JSON.stringify(marker)}` },
      { label: "second", command: `touch ${JSON.stringify(marker)}` },
    ]
    const result = JSON.stringify(await tools.verification_batch!.execute({ commands }))
    assert.doesNotMatch(result, /\"status\":\"passed\"/)
    assert.equal(fs.existsSync(marker), false)
    // The first denial latches: the second command is refused without a round trip.
    assert.equal(admitted, 2)
    assert.equal(denied, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("verification batch rechecks admission at each spawn, after the approval's own check", async () => {
  const { createWorkerToolAdmission, FenceDeniedError } =
    await import("../../policy/fence/admission.ts")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp2b-spawn-"))
  const marker = path.join(root, "ran")
  let checks = 0
  let closed = false
  const workerToolAdmission = createWorkerToolAdmission({
    sessionId: "budget-test",
    onDenied() {},
    hostRpc: {
      get isClosed() {
        return closed
      },
      async call() {
        return { allowed: true, leaseTtlMs: 60_000 }
      },
    },
  })
  // Close the channel once the approval callback's own final check has passed,
  // so only a check at the spawn itself can refuse the command.
  const assertAllowed = workerToolAdmission.assertAllowed
  workerToolAdmission.assertAllowed = () => {
    assertAllowed()
    // 1: the batch tool's own final check; 2: the command approval's.
    if (++checks === 2) closed = true
  }
  try {
    const budget = createVerificationBudget()
    budget.reset({ startedAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 360_000 })
    const tools = build({
      sendOptions: { builtinTools: { coreFiles: true }, permissionMode: "bypassPermissions" },
      emit: () => {},
      sessionId: "budget-test",
      verificationBudget: budget,
      workerToolAdmission,
      readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
    })
    const result = JSON.stringify(
      await tools.verification_batch!.execute({
        commands: [{ label: "one", command: `touch ${JSON.stringify(marker)}` }],
      })
    )
    assert.doesNotMatch(result, /\"status\":\"passed\"/)
    assert.equal(fs.existsSync(marker), false)
    assert.throws(() => workerToolAdmission.assertOpen(), FenceDeniedError)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("verification batch aggregate stdout and stderr retain the output PII gate", async () => {
  const tools = budgetTools({ permissionMode: "bypassPermissions" })
  const commands = [
    {
      label: "redaction",
      command: "printf 'alice'; printf '@example.com'; printf 'bob' >&2; printf '@example.com' >&2",
    },
  ]
  const result = JSON.stringify(await tools.verification_batch!.execute({ commands }))
  assert.match(result, /batch_passed/)
  assert.doesNotMatch(result, /alice@example\.com|bob@example\.com/)
})

test("Claude aliases deny the same built-in surface they allow", () => {
  for (const alias of ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob", "LS"]) {
    const common = {
      sessionId: "alias-parity",
      emit() {},
      readTracker: createReadTracker(),
      sendOptions: { builtinTools: { coreFiles: true }, allowedTools: [alias] },
    }
    const allowed = build(common)
    assert.equal(Object.keys(allowed).length, 1, alias)
    assert.deepEqual(
      build({ ...common, sendOptions: { ...common.sendOptions, disallowedTools: [alias] } }),
      {},
      alias
    )
  }
})

test("plugin MCP execution errors are reviewed and thrown; domain refusals remain results", async () => {
  const pending = new Map()
  const reviews: unknown[][] = []
  let payload: unknown = { content: [{ type: "text", text: "fixture failed" }], isError: true }
  const tools = build({
    sessionId: "plugin-errors",
    pendingPluginToolCalls: pending,
    emit(frame) {
      if (frame.type === "plugin_tool_exec")
        pending.get(frame.toolUseId).resolve({ result: payload })
    },
    reviewToolOutput(...args) {
      reviews.push(args)
      return args[3] ? "reviewed failure" : undefined
    },
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [{ name: "fixture", jsonSchema: { type: "object" } }],
    },
  })
  await assert.rejects(tools.fixture!.execute({}), /reviewed failure/)
  assert.equal(reviews[0]?.[3], true)
  assert.equal(reviews[0]?.[2], "fixture failed")
  payload = { ok: false }
  assert.equal(await tools.fixture!.execute({}), '{"ok":false}')
})

test("plugin runtime validation rejects invalid inputs before permission or relay and applies defaults", async () => {
  const pending = new Map()
  const emitted: Frame[] = []
  const approvals = new Map()
  const tools = build({
    sessionId: "plugin-schema",
    pendingPluginToolCalls: pending,
    pendingApprovals: approvals,
    emit(frame) {
      emitted.push(frame)
      if (frame.type === "permission_request")
        queueMicrotask(() => approvals.get(frame.requestId)?.resolve({ behavior: "allow" }))
      if (frame.type === "plugin_tool_exec") pending.get(frame.toolUseId).resolve({ result: "ok" })
    },
    sendOptions: {
      permissionMode: "default",
      pluginTools: [
        {
          name: "fixture",
          jsonSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2 },
              limit: { type: "integer", minimum: 1, maximum: 2, default: 1 },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    },
  })
  for (const args of [
    { query: 123 },
    { query: "a" },
    { query: "ok", limit: 3 },
    { query: "ok", limit: 0 },
    { query: "ok", limit: 1.5 },
    {},
    { query: "ok", extra: true },
  ]) {
    await assert.rejects(tools.fixture!.execute(args), /invalid arguments/i)
  }
  assert.equal(emitted.length, 0)
  assert.equal(await tools.fixture!.execute({ query: "ok" }), "ok")
  assert.deepEqual(emitted.find((frame) => frame.type === "plugin_tool_exec")?.args, {
    query: "ok",
    limit: 1,
  })
})

test("Code declarations and nested calls respect the final allow and deny lists", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    for (const policy of [
      { disallowedTools: ["file_info"] },
      { disallowedTools: ["mcp__cognia-tools__file_info"] },
    ]) {
      const tools = build({
        sessionId: "code-policy",
        emit() {},
        sendOptions: {
          builtinTools: { fileExtras: true },
          permissionMode: "bypassPermissions",
          execution: { composition: { toolPresentation: "both" } },
          ...policy,
        },
      })
      assert.ok(tools.run_code)
      assert.equal(tools.file_info, undefined)
      assert.ok(!tools.run_code.description?.includes("file_info("))
      const result = JSON.parse(
        String(
          await tools.run_code.execute({
            source:
              'try { return await cognia.file_info({path:"."}) } catch (e) { return e.message }',
          })
        )
      )
      assert.match(result.result, /not enabled|not permitted/)
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// CM-05: the entry and its children passed two lists. Naming only `run_code`
// registered an executor with no SDK; naming only its children dropped it.
test("Code admits run_code by what it wraps, and never with an empty SDK", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  const surface = (policy: Record<string, unknown>, toolPresentation = "code") =>
    build({
      sessionId: "code-admission",
      emit() {},
      sendOptions: {
        builtinTools: { fileExtras: true },
        permissionMode: "bypassPermissions",
        execution: { composition: { toolPresentation } },
        ...policy,
      },
    })
  try {
    assert.deepEqual(Object.keys(surface({ allowedTools: ["run_code"] })), [])
    const children = surface({ allowedTools: ["file_info"] })
    assert.deepEqual(Object.keys(children), ["run_code"])
    assert.ok(children.run_code!.description?.includes("file_info("))
    const denied = surface({ disallowedTools: ["mcp__cognia-tools__run_code"] }, "both")
    assert.equal(denied.run_code, undefined)
    assert.ok(denied.file_info, "Both keeps the native tools")
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// CM-08: the same missing file rejected here and resolved as an error envelope
// on the Claude SDK rail; both now reject with the classified kind.
test("nested failures reject the program with their kind", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    const tools = build({
      sessionId: "nested-kind",
      emit() {},
      sendOptions: {
        builtinTools: { fileExtras: true },
        permissionMode: "bypassPermissions",
        execution: { composition: { toolPresentation: "code" } },
      },
    })
    const result = JSON.parse(
      String(
        await tools.run_code!.execute({
          source:
            'try { await cognia.file_hash({path:"definitely-missing-cm08.txt"}); return "resolved" } catch (e) { return [e.name, e.kind] }',
        })
      )
    )
    assert.deepEqual(result.result, ["ToolError", "not-found"])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("nested Code calls use the namespaced permission ruleset", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    const tools = build({
      sessionId: "nested-ruleset",
      emit() {},
      sendOptions: {
        builtinTools: { fileExtras: true },
        permissionMode: "bypassPermissions",
        permissionRuleset: { "mcp__cognia-tools__file_info": "deny" },
        execution: { composition: { toolPresentation: "both" } },
      },
    })
    const result = JSON.parse(
      String(
        await tools.run_code!.execute({
          source:
            'try { return await cognia.file_info({path:"."}) } catch (e) { return e.message }',
        })
      )
    )
    assert.match(result.result, /denied by permission ruleset/)
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("built-in approval rewrites are schema-validated before the handler", async () => {
  let calls = 0
  const converted = convert(
    {
      name: "read",
      inputSchema: { path: (await import("zod")).z.string() },
      handler: async () => {
        calls++
        return { content: [] }
      },
    },
    async () => ({ path: 42 }),
    0
  )
  await assert.rejects(converted.execute({ path: "safe" }), /invalid arguments/i)
  assert.equal(calls, 0)
})

test("the installed AI SDK rejects schema-invalid plugin calls and projects MCP failures as tool errors", async () => {
  const pending = new Map()
  const received: unknown[] = []
  const tools = buildAiSdkTools({
    sessionId: "real-sdk",
    pendingPluginToolCalls: pending,
    emit(frame) {
      received.push(frame.args)
      pending.get(frame.toolUseId)?.resolve({
        result: { content: [{ type: "text", text: "fixture failure" }], isError: true },
      })
    },
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        {
          name: "fixture",
          jsonSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2 },
              limit: { type: "integer", minimum: 1, maximum: 2, default: 1 },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    },
  })
  for (const input of [
    { query: 123 },
    { query: "a" },
    { query: "ok", limit: 999 },
    {},
    { query: "ok", extra: true },
    { query: "ok" },
  ]) {
    const before = received.length
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "fixture-call",
            toolName: "fixture",
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    })
    const result = await generateText({
      model,
      messages: [{ role: "user", content: "Exercise fixture" }],
      tools,
    })
    const error = result.content.find((part) => part.type === "tool-error")
    assert.ok(error)
    const valid = input.query === "ok" && Object.keys(input).length === 1
    assert.equal(received.length, before + (valid ? 1 : 0))
    assert.match(
      String(error.error),
      valid ? /fixture failure/ : /invalid arguments|Invalid input|validation/i
    )
    const mapper = createEventAdapter({
      sessionId: "real-sdk",
      sdkSessionId: "real-sdk",
      provider: "fixture",
    })
    const frames = mapper.handle({
      type: "tool-error",
      toolCallId: "fixture-call",
      error: error.error,
    })
    assert.equal(frames.find((frame) => frame.type === "user")?.message?.content[0]?.is_error, true)
  }
  assert.deepEqual(received, [{ query: "ok", limit: 1 }])
})

test("plugin approval rewrites are parsed before relay", async () => {
  const pending = new Map()
  const approvals = new Map()
  let relayed = false
  const tools = build({
    sessionId: "rewrite-schema",
    pendingPluginToolCalls: pending,
    pendingApprovals: approvals,
    emit(frame) {
      if (frame.type === "permission_request")
        queueMicrotask(() =>
          approvals.get(frame.requestId)?.resolve({ behavior: "allow", updatedInput: { path: 42 } })
        )
      if (frame.type === "plugin_tool_exec") {
        relayed = true
        pending.get(frame.toolUseId)?.resolve({ result: "must not run" })
      }
    },
    sendOptions: {
      pluginTools: [
        {
          name: "fixture",
          jsonSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    },
  })
  await assert.rejects(tools.fixture!.execute({ path: "safe" }), /invalid arguments/)
  assert.equal(relayed, false)
})

test("nested Code results pass through the per-tool output reviewer", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  const reviewed: string[] = []
  try {
    const tools = build({
      sessionId: "nested-review",
      emit() {},
      sendOptions: {
        builtinTools: { fileExtras: true },
        permissionMode: "bypassPermissions",
        execution: { composition: { toolPresentation: "both" } },
      },
      reviewToolOutput(name) {
        reviewed.push(name)
        return name.endsWith("__file_info") ? { reviewed: true } : undefined
      },
    })
    const result = JSON.parse(
      String(await tools.run_code!.execute({ source: 'return await cognia.file_info({path:"."})' }))
    )
    assert.deepEqual(result.result, { reviewed: true })
    assert.deepEqual(reviewed, ["mcp__cognia-tools__file_info", "mcp__cognia-tools__run_code"])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("AI SDK plugin validation accepts pattern keys and preserves their values", async () => {
  const pending = new Map()
  const received: unknown[] = []
  const tools = build({
    sessionId: "pattern-schema",
    pendingPluginToolCalls: pending,
    emit(frame) {
      received.push(frame.args)
      pending.get(frame.toolUseId)?.resolve({ result: "ok" })
    },
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        {
          name: "fixture",
          jsonSchema: {
            type: "object",
            patternProperties: { "^safe_": { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    },
  })
  assert.equal(await tools.fixture!.execute({ safe_name: "ok" }), "ok")
  for (const args of [{ safe_name: 42 }, { other: "ok" }])
    await assert.rejects(tools.fixture!.execute(args), /invalid arguments/)
  assert.deepEqual(received, [{ safe_name: "ok" }])
})

for (const kind of ["builtin", "plugin"] as const) {
  test(`${kind} admission follows approval and precedes its final execute`, async () => {
    const { createWorkerToolAdmission, FenceDeniedError } =
      await import("../../policy/fence/admission.ts")
    let approve!: () => void
    const approval = new Promise<void>((resolve) => {
      approve = resolve
    })
    let admitted = 0
    let executed = 0
    let stopped = 0
    const admission = createWorkerToolAdmission({
      sessionId: "s",
      onDenied() {
        stopped++
      },
      hostRpc: {
        async call() {
          admitted++
          return { allowed: false }
        },
      },
    })
    const gate = async (_name: string, input: unknown) => {
      await approval
      return input
    }
    const tool =
      kind === "builtin"
        ? convert(
            {
              name: "test",
              description: "test",
              inputSchema: {},
              async handler() {
                executed++
                return { content: [{ type: "text", text: "ok" }] }
              },
            },
            gate,
            0,
            undefined,
            true,
            false,
            admission
          )
        : (__testing__.pluginToolToAiSdkTool(
            { name: "plugin", jsonSchema: { type: "object" } },
            {
              emit() {
                executed++
              },
              sessionId: "s",
              pendingPluginToolCalls: new Map(),
              gate,
              workerToolAdmission: admission,
            }
          ) as unknown as TestAiTool)
    const call = tool.execute({})
    await Promise.resolve()
    assert.equal(admitted, 0)
    approve()
    await assert.rejects(call, FenceDeniedError)
    assert.equal(admitted, 1)
    assert.equal(executed, 0)
    assert.equal(stopped, 1)
  })
}

test("built-in final execution rechecks the cached local deadline synchronously", async () => {
  const { createWorkerToolAdmission, FenceDeniedError } =
    await import("../../policy/fence/admission.ts")
  let now = 0
  let executions = 0
  let calls = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => now,
    onDenied() {},
    hostRpc: {
      async call() {
        calls++
        return { allowed: true, leaseTtlMs: 10 }
      },
    },
  })
  const tool = convert(
    {
      name: "test",
      description: "test",
      inputSchema: {},
      async handler() {
        executions++
        return { content: [] }
      },
    },
    undefined,
    0,
    undefined,
    true,
    false,
    {
      async admit(name, id) {
        await admission.admit(name, id)
        now = 10
      },
      assertAllowed: () => admission.assertAllowed(),
      assertOpen: () => admission.assertOpen(),
    }
  )
  await assert.rejects(tool.execute({}), FenceDeniedError)
  assert.equal(executions, 0)
  assert.equal(calls, 1)
})
