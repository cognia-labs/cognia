import { test } from "node:test"
import assert from "node:assert/strict"

import { mock } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"
import type { ToolHandlerExtra } from "../../tools/kernel/define.ts"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk"
import {
  enforceAnthropicToolSurface,
  applySdkToolPermissionPolicies,
  normalizeClaudeToolNames,
} from "./tool-surface.ts"
import { fakeSandboxRss } from "../../../test-support/sandbox-rss.ts"
import { firstJson } from "../../../test-support/tool-result.ts"

// Broker tests exercise dispatch, not OS RSS accounting (which has its own
// supervisor tests). Keep real child execution while supplying process usage.
fakeSandboxRss()

test("native tool aliases normalize against the installed SDK catalog", () => {
  const entries = Object.entries(LEGACY_TOOL_NAME_ALIASES)
  assert.ok(entries.length > 0)
  assert.deepEqual(
    normalizeClaudeToolNames(entries.map(([alias]) => alias)),
    entries.map(([, canonical]) => canonical)
  )
  assert.deepEqual(normalizeClaudeToolNames([...BUILTIN_TOOL_NAMES]), [...BUILTIN_TOOL_NAMES])
})

test("alias normalization preserves exact permission suffixes and MCP namespaces", () => {
  const [alias, canonical] = Object.entries(LEGACY_TOOL_NAME_ALIASES)[0]!
  const suffix = "(research:*,literal(value))"
  const mcp = `mcp__workspace__${alias}`
  const unknown = "SomeFutureNativeTool(value:*)"
  const names = [`${alias}${suffix}`, mcp, `${mcp}(*)`, unknown, "toString"]
  assert.deepEqual(normalizeClaudeToolNames(names), [
    `${canonical}${suffix}`,
    mcp,
    `${mcp}(*)`,
    unknown,
    "toString",
  ])
  assert.deepEqual(names, [`${alias}${suffix}`, mcp, `${mcp}(*)`, unknown, "toString"])
  assert.equal(normalizeClaudeToolNames(undefined), undefined)
  assert.deepEqual(normalizeClaudeToolNames([]), [])
})

test("normalizing both deny and allow rules keeps canonical denial targets equivalent", () => {
  for (const [alias, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    const deny = normalizeClaudeToolNames([`${alias}(*)`])!
    const allow = normalizeClaudeToolNames([`${canonical}(*)`])!
    assert.deepEqual(deny, allow)
  }
})

test("portable tool policies translate on SDK server registrations without weakening native deny", () => {
  const instance = { fixture: true }
  const original = {
    bridge: {
      type: "sdk",
      instance,
      tools: [{ name: "remove", permission_policy: "always_deny" }],
    },
    relay: { type: "stdio", command: "node" },
  }
  const result = applySdkToolPermissionPolicies(original, [
    { tool: "mcp__bridge__publish", decision: "ask" },
    { tool: "mcp__bridge__remove", decision: "ask" },
    { tool: "mcp__relay__publish", decision: "deny" },
  ])
  assert.equal(result.bridge.instance, instance)
  assert.deepEqual(result.bridge.tools, [
    { name: "publish", permission_policy: "always_ask" },
    { name: "remove", permission_policy: "always_deny" },
  ])
  assert.equal(result.relay, original.relay)
  assert.deepEqual(original.bridge.tools, [{ name: "remove", permission_policy: "always_deny" }])
})

test("disabled tool surface removes every SDK tool entry point", () => {
  const options = enforceAnthropicToolSurface(
    {
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      mcpServers: { unsafe: { type: "stdio", command: "unsafe" } },
      agents: { helper: { description: "helper", prompt: "help" } },
      agent: "helper",
      hooks: { PreToolUse: [] },
    },
    { toolSurface: "none" }
  )

  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.allowedTools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.agents, undefined)
  assert.equal(options.agent, undefined)
  assert.equal(options.hooks, undefined)
})

test("default tool surface preserves SDK options", () => {
  const original = { tools: ["Read"], mcpServers: { safe: { command: "test" } } }
  assert.equal(enforceAnthropicToolSurface(original, {}), original)
})

function codeRuntime(policy: Record<string, unknown> = {}) {
  const captured = captureClaudeRuntime(
    {
      toolSurface: "full",
      builtinTools: { fileExtras: true },
      execution: { composition: { toolPresentation: "both" } },
      ...policy,
    },
    // The turn stays open until the test closes input, as a real one does
    // while the model is calling tools. An iterator that ended at once would
    // run the turn's teardown, which (rightly) stops a run_code child mid-call.
    (params) => ({
      async *[Symbol.asyncIterator]() {
        for await (const _message of params.prompt as AsyncIterable<unknown>) {
          // consumed; nothing to answer
        }
      },
      interrupt() {},
      close() {},
    })
  )
  const server = captured.options.mcpServers?.["cognia-tools"]
  assert.ok(server && typeof server === "object" && "instance" in server)
  const registered = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          description: string
          handler(input: unknown, extra?: ToolHandlerExtra): Promise<CallToolResult>
        }
      >
    }
  )._registeredTools
  return { ...captured, registered }
}

async function waitForApproval(session: ReturnType<typeof codeRuntime>["session"]) {
  for (let i = 0; i < 200 && session.pendingApprovals.size === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const entry = [...session.pendingApprovals.values()][0]
  assert.ok(entry, "nested call requested approval")
  return entry
}

test("Anthropic Code uses the final permitted declaration and reachable surface", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    for (const policy of [
      { disallowedTools: ["file_info"] },
      { disallowedTools: ["mcp__cognia-tools__file_info"] },
    ]) {
      const { registered, session } = codeRuntime(policy)
      try {
        assert.equal(registered.file_info, undefined)
        assert.ok(!registered.run_code!.description.includes("file_info("))
        const result = await registered.run_code!.handler({
          source: 'try { return await cognia.file_info({path:"."}) } catch(e) { return e.message }',
        })
        assert.match(JSON.stringify(result), /not enabled|not permitted/)
      } finally {
        session.closeInput()
      }
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// CM-05: the entry and its children passed two lists. Naming only `run_code`
// registered an executor with no SDK; naming only its children dropped it.
test("Anthropic Code admits run_code by what it wraps, and never with an empty SDK", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    const onlyEntry = captureClaudeRuntime(
      {
        toolSurface: "full",
        builtinTools: { fileExtras: true },
        execution: { composition: { toolPresentation: "code" } },
        allowedTools: ["mcp__cognia-tools__run_code"],
      },
      () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
    )
    assert.equal(onlyEntry.options.mcpServers?.["cognia-tools"], undefined)
    onlyEntry.session.closeInput()

    const onlyChildren = codeRuntime({
      execution: { composition: { toolPresentation: "code" } },
      allowedTools: ["mcp__cognia-tools__file_info"],
    })
    try {
      assert.deepEqual(Object.keys(onlyChildren.registered), ["run_code"])
      assert.ok(onlyChildren.registered.run_code!.description.includes("file_info("))
    } finally {
      onlyChildren.session.closeInput()
    }

    const denied = codeRuntime({ disallowedTools: ["run_code"] })
    try {
      assert.equal(denied.registered.run_code, undefined)
      assert.ok(denied.registered.file_info, "Both keeps the native tools")
    } finally {
      denied.session.closeInput()
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// CM-08: the same missing file rejected on the AI SDK rail and resolved as an
// error envelope here; both now reject with the classified kind.
test("Anthropic nested failures reject the program with their kind", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  try {
    const { registered, session } = codeRuntime({ permissionMode: "bypassPermissions" })
    try {
      const result = await registered.run_code!.handler({
        source:
          'try { await cognia.file_hash({path:"definitely-missing-cm08.txt"}); return "resolved" } catch (e) { return [e.name, e.kind] }',
      })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      assert.deepEqual(firstJson<{ result: unknown }>(result).result, ["ToolError", "not-found"])
    } finally {
      session.closeInput()
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// CM-12: the nested call's approval and its trace both name it after the
// run_code call the CLI made, so the chat can hang one under the other.
test("Anthropic nested calls are named after their run_code call and traced under it", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  const tool = "mcp__cognia-tools__file_info"
  const runtime = codeRuntime({
    permissionMode: "bypassPermissions",
    toolPermissionRules: [{ tool, decision: "ask" }],
  })
  try {
    const resultPromise = runtime.registered.run_code!.handler(
      { source: 'return await cognia.file_info({path:"."})' },
      { _meta: { "claudecode/toolUseId": "toolu_run" } }
    )
    const pending = await waitForApproval(runtime.session)
    const request = runtime.events.find((event) => event.type === "permission_request")!
    assert.equal(request.toolUseID, "toolu_run/1")
    pending.resolve({ behavior: "allow" })
    assert.notEqual((await resultPromise).isError, true)
    const traced = runtime.events
      .filter(
        (frame) =>
          frame.type === "event" &&
          (frame.event as { subtype?: string } | undefined)?.subtype === "code_run_call"
      )
      .map((frame) => {
        const event = frame.event as {
          parent_tool_use_id: string
          call: { id: string; state: string }
        }
        return [event.parent_tool_use_id, event.call.id, event.call.state]
      })
    assert.deepEqual(traced, [
      ["toolu_run", "toolu_run/1", "running"],
      ["toolu_run", "toolu_run/1", "succeeded"],
    ])
  } finally {
    runtime.session.drainPending()
    runtime.session.closeInput()
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("Anthropic nested calls share namespaced ruleset and per-call approval decisions", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  const tool = "mcp__cognia-tools__file_info"
  try {
    const denied = codeRuntime({
      permissionMode: "bypassPermissions",
      permissionRuleset: { [tool]: "deny" },
    })
    try {
      const result = await denied.registered.run_code!.handler({
        source: 'try { return await cognia.file_info({path:"."}) } catch(e) { return e.message }',
      })
      assert.match(JSON.stringify(result), /denied by permission ruleset/)
    } finally {
      denied.session.closeInput()
    }
    const approved = codeRuntime({
      permissionMode: "bypassPermissions",
      toolPermissionRules: [{ tool, decision: "ask" }],
    })
    const controller = new AbortController()
    try {
      const resultPromise = approved.registered.run_code!.handler(
        { source: 'return await cognia.file_info({path:"."})' },
        { signal: controller.signal }
      )
      const pending = await waitForApproval(approved.session)
      assert.deepEqual(pending.input, { path: "." })
      const request = approved.events.find((event) => event.type === "permission_request")!
      assert.equal(request.toolName, tool)
      assert.equal(typeof request.toolUseID, "string")
      assert.equal(request.requiresPerCallApproval, true)
      pending.resolve({ behavior: "allow", updatedInput: { path: 42 } })
      assert.match(JSON.stringify(await resultPromise), /invalid arguments/)
      const next = approved.registered.run_code!.handler(
        { source: 'return await cognia.file_info({path:"."})' },
        { signal: controller.signal }
      )
      await waitForApproval(approved.session)
      controller.abort()
      assert.match(JSON.stringify(await next), /aborted|interrupted/)
      assert.equal(approved.session.pendingApprovals.size, 0)
      const requests = approved.events.filter((event) => event.type === "permission_request")
      assert.equal(requests.length, 2)
      assert.notEqual(requests[0]!.toolUseID, requests[1]!.toolUseID)
    } finally {
      controller.abort()
      approved.session.drainPending()
      approved.session.closeInput()
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("nested Code honors SDK permission modes and preapproval without unexpected prompts", async () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify(["/usr/bin/env"])
  const tool = "mcp__cognia-tools__file_info"
  try {
    for (const fixture of [
      { policy: { permissionMode: "bypassPermissions" }, allowed: true },
      { policy: { permissionMode: "dontAsk" }, allowed: false },
      { policy: { permissionMode: "dontAsk", allowedTools: [tool, "run_code"] }, allowed: true },
      { policy: { allowedTools: [tool, "run_code"] }, allowed: true },
      { policy: { permissionMode: "plan" }, allowed: true },
      {
        policy: { permissionMode: "bypassPermissions", permissionRuleset: { [tool]: "deny" } },
        allowed: false,
      },
    ]) {
      const runtime = codeRuntime(fixture.policy)
      const pending = runtime.session.pendingApprovals
      const set = pending.set.bind(pending)
      const watcher = mock.method(pending, "set", (id: string, entry: PendingApproval) => {
        set(id, entry)
        queueMicrotask(() =>
          entry.resolve({ behavior: "deny", message: "unexpected nested prompt" })
        )
        return pending
      })
      try {
        const result = await runtime.registered.run_code!.handler({
          source: 'return await cognia.file_info({path:"."})',
        })
        assert.equal(
          runtime.events.some((event) => event.type === "permission_request"),
          false,
          JSON.stringify(fixture.policy)
        )
        assert.equal(result.isError === true, !fixture.allowed, JSON.stringify(result))
        if (!fixture.allowed) assert.match(JSON.stringify(result), /dontAsk|permission ruleset/)
      } finally {
        watcher.mock.restore()
        runtime.session.drainPending()
        runtime.session.closeInput()
      }
    }
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("H3: a third-party server shadowing the Host relay never inherits its tracking exemption", async () => {
  const { buildToolSurface } = await import("./tool-surface.ts")
  const { createToolSessionContext } = await import("../../tools/session.ts")
  for (const shadow of [false, true]) {
    const sendOptions = {
      cwd: ".",
      personalEgressFenced: true,
      personalEgressReadTools: ["mcp__cognia-plugin-tools__private.recall"],
      pluginTools: [{ name: "private.recall", pluginId: "p", jsonSchema: { type: "object" } }],
      ...(shadow ? { mcpServers: { "cognia-plugin-tools": { command: "untrusted" } } } : {}),
    }
    const toolSession = createToolSessionContext({ sendOptions, sessionId: "ownership", log() {} })
    const surface = buildToolSurface({
      sendOptions,
      sessionId: "ownership",
      log() {},
      emit() {},
      toolSession,
      pendingPluginToolCalls: new Map(),
    })
    assert.equal(
      surface.personalEgressRelayTools.has("mcp__cognia-plugin-tools__private_recall"),
      !shadow
    )
    const { personalToolDenied } = await import("../../policy/personal-egress.ts")
    for (const name of [
      "mcp__cognia-plugin-tools__private_recall",
      "mcp__cognia-plugin-tools__private.recall",
    ])
      assert.equal(personalToolDenied(name, sendOptions), shadow)
    await toolSession.disposeProcesses()
  }
})
