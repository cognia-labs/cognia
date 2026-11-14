import assert from "node:assert/strict"
import { test } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildAnthropicOptions } from "./options.ts"
import { buildToolSurface } from "./tool-surface.ts"
import type { ToolPresentationOptions } from "../../tools/middleware/presentation.ts"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import { makeLazyLspResolver } from "../../services/lsp/lazy-resolver.ts"
import { createLspResolver } from "../../services/lsp/resolver.ts"
import { withProcessSandbox } from "../../platform/process/exec.ts"
import { createToolSessionContext } from "../../tools/session.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import { createStderrLogSink } from "../../mcp/client/log.ts"

test("portable extensions restore through the same trusted content boundary and expose neutral live control", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-extension-restore-"))
  try {
    const plugin = path.join(root, "extension")
    fs.mkdirSync(plugin)
    fs.writeFileSync(path.join(plugin, "SKILL.md"), "Explain repository conventions")
    const sendOptions = {
      cwd: root,
      trustedWorkspaceRoots: [root],
      toolSurface: "full",
      runtimeExtensions: [{ kind: "directory" as const, path: plugin }],
    }
    const { options, session } = captureClaudeRuntime(sendOptions, () => ({
      async *[Symbol.asyncIterator]() {},
      interrupt() {},
      close() {},
    }))
    assert.deepEqual(options.plugins, [
      { type: "local", path: fs.realpathSync(plugin), skipMcpDiscovery: true },
    ])
    assert.equal(typeof session.reloadExtensions, "function")
    session.closeInput()
    fs.writeFileSync(path.join(plugin, "SKILL.md"), "Contact private.person@example.com")
    assert.throws(
      () =>
        captureClaudeRuntime(sendOptions, () => ({
          async *[Symbol.asyncIterator]() {},
          interrupt() {},
          close() {},
        })),
      /PII gate/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("portable subagent options translate at the runtime boundary", () => {
  const { options, session } = captureClaudeRuntime(
    {
      toolSurface: "full",
      subagentRuntime: { contextMode: "fork" },
      agents: {
        reviewer: {
          description: "Review",
          prompt: "Review",
          contextPolicy: { compactAtTokens: 120000 },
        },
      },
    },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.env?.CLAUDE_CODE_FORK_SUBAGENT, "1")
  const reviewer = options.agents?.reviewer
  assert.ok(reviewer)
  assert.equal(reviewer.autoCompactWindow, 120000)
  assert.equal("contextPolicy" in reviewer, false)
  session.closeInput()
})

test("an omitted permission mode stays manual and fork subagents stay disabled", () => {
  const { options, session } = captureClaudeRuntime(
    { env: { CLAUDE_CODE_FORK_SUBAGENT: "1" } },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.permissionMode, "default")
  assert.equal(options.env?.CLAUDE_CODE_FORK_SUBAGENT, "0")
  session.closeInput()
})

test("an explicit permission mode and conversation fork survive SDK compatibility defaults", () => {
  const { options, session } = captureClaudeRuntime(
    { permissionMode: "plan", forkFromSessionId: "source-session" },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.permissionMode, "plan")
  assert.equal(options.forkSession, true)
  assert.equal(options.resume, "source-session")
  assert.equal(options.env?.CLAUDE_CODE_FORK_SUBAGENT, "0")
  session.closeInput()
})

test("nested options and interaction callbacks reach the SDK after the final deny-all clamp", async () => {
  const { options, session, events } = captureClaudeRuntime(
    {
      model: "model",
      fallbackModel: "fallback",
      systemPrompt: "base",
      appendSystemPrompt: "dynamic",
      claudeAgentSdk: {
        version: 1,
        tools: ["Bash"],
        title: "nested title",
        elicitation: { enabled: true },
      },
    },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.title, "nested title")
  assert.equal(options.model, "model")
  assert.equal(options.fallbackModel, "fallback")
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.hooks?.PreToolUse?.length, 1)
  assert.equal(typeof options.onElicitation, "function")
  assert.ok(options.systemPrompt)
  assert.equal(
    events.some((event) => event.type === "sdk_option_warning"),
    false
  )
  session.closeInput()
})

test("native PostToolUse starts LSP with host ports before the first tool request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-native-lsp-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}")
  const file = path.join(root, "index.ts")
  fs.writeFileSync(file, "const value: number = 'invalid'")
  const sessionId = "native-hook-first"
  const trusted = { COGNIA_PORT: "41010", COGNIA_PORT_COUNT: "10", PORT: "41010" }
  const starts: Record<string, unknown>[] = []
  const hostCalls: string[] = []
  const hostRpc = {
    async call(method: string, params?: unknown) {
      if (method === "jobs.killOwnedBy") return { killed: [] }
      if (method === "jobs.list") return { jobs: [] }
      hostCalls.push(method)
      assert.equal(method, "workspace.portEnv")
      assert.deepEqual(params, { cwd: fs.realpathSync(root) })
      return trusted
    },
  }
  const sendOptions = {
    cwd: root,
    lsp: {
      enabled: true,
      servers: [
        {
          id: "typescript",
          languages: ["typescript"],
          extensions: [".ts"],
          command: "typescript-language-server",
          rootMarkers: ["tsconfig.json"],
          env: { PORT: "9999" },
        },
      ],
    },
  }
  const log = () => {}
  const emit = () => {}
  const lsp = makeLazyLspResolver({ sendOptions, log }, async (opts) => {
    const resolver = createLspResolver({
      ...opts,
      diagnosticsWaitMs: 0,
      ensureCommand: (command) => command,
      service: {
        async start(params) {
          starts.push(params)
        },
        didOpen(params) {
          resolver.ingestDiagnostics({
            uri: params.uri,
            diagnostics: [{ message: "type mismatch", severity: 1 }],
          })
        },
        didChange() {},
        async request() {
          return { contents: "hover" }
        },
        stop() {},
      },
    })
    return resolver
  })
  t.after(() => lsp.dispose())
  const toolSession = createToolSessionContext({ sendOptions, sessionId, hostRpc, log })
  t.after(() => toolSession.dispose())
  const options = buildAnthropicOptions({
    sendOptions,
    sessionId,
    hostRpc,
    emit,
    log,
    toolSession,
    mcpStderrSink: createStderrLogSink({ sessionId, emit, source: "stderr" }),
    ledgerGate: createCallLedgerGate({ ledger: null, sessionId, emit }),
    sdkFallbackModel: undefined,
    sdkMaxBudgetUsd: undefined,
    pendingApprovals: new Map(),
    pendingPluginHookCalls: new Map(),
    doomGuard: createDoomLoopGuard(),
    interruptForLedger() {},
    surface: {
      setNestedToolAuthorizer() {},
      mergedMcpServers: {},
      pluginToolNameAliases: new Map(),
      personalEgressRelayTools: new Set(),
      modelAllowedTools: [],
      disallowed: new Set(),
      lspEnabled: lsp.lspEnabled,
      lspResolver: lsp.lspResolver,
    },
  })
  const hook = options.hooks?.PostToolUse?.[1]?.hooks[0]
  assert.ok(hook)
  assert.equal(starts.length, 0)
  const result = await hook(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      transcript_path: "",
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: file },
      tool_response: {},
      tool_use_id: "write-first",
    },
    "write-first",
    { signal: new AbortController().signal }
  )
  assert.ok("hookSpecificOutput" in result)
  assert.equal(result.hookSpecificOutput?.hookEventName, "PostToolUse")
  if (result.hookSpecificOutput?.hookEventName === "PostToolUse")
    assert.match(String(result.hookSpecificOutput.additionalContext), /type mismatch/)
  assert.deepEqual(hostCalls, ["workspace.portEnv"])
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0]!.env, trusted)
  assert.ok(lsp.lspResolver)
  assert.deepEqual(
    await withProcessSandbox(
      undefined,
      root,
      () => lsp.lspResolver!.request(file, "textDocument/hover"),
      { hostRpc, sessionId }
    ),
    { contents: "hover" }
  )
  assert.equal(starts.length, 1)
})

test("options bind nested authorization to the session canUseTool with approval context", async (t) => {
  const toolName = "mcp__cognia-tools__file_info"
  const sendOptions: SendOptions = {
    builtinTools: { fileExtras: true },
    toolPermissionRules: [{ tool: toolName, decision: "ask" as const }],
  }
  const sessionId = "nested-options"
  const pendingApprovals = new Map()
  const frames: Record<string, unknown>[] = []
  const emit = (frame: Record<string, unknown>) => {
    frames.push(frame)
  }
  const log = () => {}
  const toolSession = createToolSessionContext({
    sendOptions,
    sessionId,
    log,
  })
  t.after(() => toolSession.dispose())
  const surface = buildToolSurface({
    sendOptions,
    sessionId,
    emit,
    log,
    toolSession,
    pendingPluginToolCalls: new Map(),
  })
  let authorize: NonNullable<ToolPresentationOptions["authorizeTool"]> | undefined
  const bind = surface.setNestedToolAuthorizer
  surface.setNestedToolAuthorizer = (callback) => {
    authorize = callback
    bind(callback)
  }
  buildAnthropicOptions({
    sendOptions,
    sessionId,
    emit,
    log,
    toolSession,
    surface,
    mcpStderrSink: createStderrLogSink({
      sessionId,
      emit: (event) => emit({ ...event }),
      source: "stderr",
    }),
    ledgerGate: createCallLedgerGate({ ledger: null, sessionId, emit }),
    sdkFallbackModel: undefined,
    sdkMaxBudgetUsd: undefined,
    pendingApprovals,
    pendingPluginHookCalls: new Map(),
    doomGuard: createDoomLoopGuard(),
    interruptForLedger() {},
  })
  assert.ok(authorize)
  const controller = new AbortController()
  const call = authorize(toolName, { path: "." }, { signal: controller.signal })
  const entry = [...pendingApprovals.values()][0]
  assert.ok(entry)
  const request = frames.find((frame) => frame.type === "permission_request")!
  assert.equal(request.toolName, toolName)
  assert.equal(typeof request.toolUseID, "string")
  entry.resolve({ behavior: "deny", message: "person refused nested call" })
  await assert.rejects(call, /person refused nested call/)
  controller.abort()
  await assert.rejects(
    authorize(toolName, { path: "." }, { signal: controller.signal }),
    /interrupted/
  )
})

test("mandatory PreToolUse denies preallowed Bash and WebFetch after a Host fence", async () => {
  const { options, session } = captureClaudeRuntime(
    {
      toolSurface: "full",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "WebFetch"],
    },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  const hook = options.hooks?.PreToolUse?.at(-1)?.hooks[0]
  assert.ok(hook)
  const { fencePersonalEgress } = await import("../../policy/personal-egress.ts")
  assert.ok(session.sendOptions)
  fencePersonalEgress(session.sendOptions)
  for (const name of ["Bash", "WebFetch"]) {
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "",
        cwd: ".",
        tool_name: name,
        tool_input: {},
        tool_use_id: "tool",
      },
      "tool",
      { signal: new AbortController().signal }
    )
    assert.ok("hookSpecificOutput" in result)
    assert.equal(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
      "deny"
    )
  }
  for (const name of ["Read", "Glob", "WebSearch"]) {
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "",
        cwd: ".",
        tool_name: name,
        tool_input: {},
        tool_use_id: "native",
      },
      "native",
      { signal: new AbortController().signal }
    )
    assert.deepEqual(result, {}, `G1: real native ${name} remains allowed`)
  }
  session.closeInput()
})

test("H3: real native bridge self-admission uses relay identity and waits for siblings", async () => {
  let finishQuery!: () => void
  const running = new Promise<void>((resolve) => {
    finishQuery = resolve
  })
  const captured = captureClaudeRuntime(
    {
      toolSurface: "full",
      permissionMode: "bypassPermissions",
      pluginTools: [{ name: "private_recall", pluginId: "p", jsonSchema: { type: "object" } }],
    },
    () => ({
      async *[Symbol.asyncIterator]() {
        await running
      },
      interrupt() {},
      close() {
        finishQuery()
      },
    })
  )
  const { options, session, events } = captured
  const pre = options.hooks!.PreToolUse!.at(-1)!.hooks[0]!
  await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "",
      cwd: ".",
      tool_name: "mcp__cognia-plugin-tools__private_recall",
      tool_input: {},
      tool_use_id: "sdk-native-id",
    },
    "sdk-native-id",
    { signal: new AbortController().signal }
  )
  const server = options.mcpServers!["cognia-plugin-tools"]!
  assert.ok("instance" in server)
  const registered = (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler(input: unknown): Promise<unknown> }>
    }
  )._registeredTools
  const call = registered.private_recall!.handler({})
  const event = events.find((frame) => frame.type === "plugin_tool_exec")!
  assert.ok(event)
  assert.notEqual(event.toolUseId, "sdk-native-id")
  const { beginPersonalEgressOperation, fencePersonalEgress, quiescePersonalEgress } =
    await import("../../policy/personal-egress.ts")
  const finishSibling = beginPersonalEgressOperation(session.sendOptions!, false, "sibling-shell")
  fencePersonalEgress(session.sendOptions!)
  let admitted = false
  const admission = quiescePersonalEgress(session.sendOptions!, [String(event.toolUseId)]).then(
    () => {
      admitted = true
    }
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(admitted, false)
  finishSibling()
  await admission
  assert.equal(admitted, true, "outer SDK identity must not deadlock its own Host relay")
  session.pendingPluginToolCalls.get(String(event.toolUseId))!.resolve({ result: "private result" })
  await call
  session.closeInput()
  finishQuery()
})

test("R6: aborted and approval-denied native calls release their in-flight leases", async () => {
  for (const denied of [false, true]) {
    const { options, session } = captureClaudeRuntime({ toolSurface: "full" }, () => ({
      async *[Symbol.asyncIterator]() {},
      interrupt() {},
      close() {},
    }))
    const controller = new AbortController()
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!
    await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "",
        cwd: ".",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "native-cleanup",
      },
      "native-cleanup",
      { signal: controller.signal }
    )
    if (denied) {
      const approval = options.canUseTool!("Bash", { command: "pwd" }, {
        signal: controller.signal,
        toolUseID: "native-cleanup",
      } as never)
      for (let i = 0; i < 10 && !session.pendingApprovals.size; i++) await Promise.resolve()
      const entry = [...session.pendingApprovals.values()][0]
      assert.ok(entry)
      entry.resolve({ behavior: "deny", message: "person denied" })
      await approval
    } else controller.abort()
    const { fencePersonalEgress, quiescePersonalEgress } =
      await import("../../policy/personal-egress.ts")
    fencePersonalEgress(session.sendOptions!)
    await quiescePersonalEgress(session.sendOptions!)
    session.closeInput()
  }
})

for (const permissionMode of ["default", "bypassPermissions", "dontAsk"] as const) {
  test(`worker PreToolUse is unconditional in ${permissionMode} and refuses a missing host channel`, async () => {
    const { options, session } = captureClaudeRuntime(
      {
        workerToolAdmission: true,
        toolSurface: "full",
        permissionMode,
        allowedTools: ["Bash"],
        claudeAgentSdk: { version: 1, tools: ["Bash"] },
      },
      () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
    )
    try {
      const mandatory = options.hooks?.PreToolUse?.at(-1)
      assert.ok(mandatory)
      assert.equal(mandatory.matcher, undefined)
      const result = await mandatory.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          session_id: "sdk-id",
          transcript_path: "",
          cwd: ".",
          tool_name: "Bash",
          tool_input: {},
          tool_use_id: "t",
        },
        "t",
        { signal: new AbortController().signal }
      )
      assert.equal("continue" in result && result.continue, false)
      assert.equal("stopReason" in result && result.stopReason, "worker_fence_closed")
      assert.equal(
        (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
          .permissionDecision,
        "deny"
      )
    } finally {
      session.closeInput()
    }
  })
}

test("a fenced worker turn refuses a delegated permission prompt tool it cannot re-admit after", () => {
  const query = () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  assert.throws(
    () =>
      captureClaudeRuntime(
        {
          workerToolAdmission: true,
          toolSurface: "full",
          claudeAgentSdk: { version: 1, permissionPromptToolName: "mcp__permission__review" },
        },
        query
      ),
    /delegated permission prompt tool/
  )
  // Without the worker flag the refusal never fires; the delegate reaches the
  // existing managed-server check instead.
  assert.throws(
    () =>
      captureClaudeRuntime(
        {
          toolSurface: "full",
          claudeAgentSdk: { version: 1, permissionPromptToolName: "mcp__permission__review" },
        },
        query
      ),
    /must belong to a managed MCP server/
  )
})

test("a configured PreToolUse allow is re-admitted after the hook finishes", async () => {
  const { dispatchAnthropic } = await import("./index.ts")
  const { nodeCmd } = await import("../../../test-support/hook-command.ts")
  let allowed = true
  let interrupted = 0
  let options!: import("@anthropic-ai/claude-agent-sdk").Options
  let finish!: () => void
  const running = new Promise<void>((resolve) => {
    finish = resolve
  })
  const session = dispatchAnthropic(
    {
      sessionId: "hook-worker",
      firstPrompt: "work",
      emit() {},
      log() {},
      sendOptions: {
        workerToolAdmission: true,
        toolSurface: "full",
        permissionMode: "bypassPermissions",
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCmd(
                    'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}))'
                  ),
                },
              ],
            },
          ],
        },
      },
      hostRpc: {
        async call() {
          return { allowed, leaseTtlMs: 10000 }
        },
      },
    },
    {
      query(args) {
        options = args.options
        return {
          async *[Symbol.asyncIterator]() {
            await running
          },
          interrupt() {
            interrupted++
            finish()
          },
          close() {
            finish()
          },
        }
      },
    }
  )
  const input = {
    hook_event_name: "PreToolUse" as const,
    session_id: "sdk-id",
    transcript_path: "",
    cwd: ".",
    tool_name: "Read",
    tool_input: {},
    tool_use_id: "t",
  }
  const context = { signal: new AbortController().signal }
  try {
    await options.hooks!.PreToolUse!.at(-1)!.hooks[0]!(input, "t", context)
    allowed = false
    const result = await options.hooks!.PreToolUse![1]!.hooks[0]!(input, "t", context)
    assert.equal(
      (result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
        .permissionDecision,
      "deny"
    )
    assert.equal("continue" in result && result.continue, false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(interrupted, 1)
  } finally {
    session.closeInput()
    finish()
  }
})
