import test from "node:test"
import assert from "node:assert/strict"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { RuntimeDeps } from "./runtime-types.ts"
import { dispatchAnthropic } from "./index.ts"
import { buildPermissionResult } from "../../host/commands/responses.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const namespace = {
  version: 1 as const,
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowNestedUserNamespaces: true,
  },
  prewarm: { enabled: true },
}

function capture(sendOptions: SendOptions, overrides: RuntimeDeps = {}) {
  const frames: Record<string, unknown>[] = []
  let spawned = 0
  let claimed = 0
  let warmed = 0
  let queryOptions: Options | undefined
  const session = dispatchAnthropic(
    {
      sessionId: "policy-session",
      firstPrompt: "hello",
      sendOptions: { toolSurface: "none", ...sendOptions },
      emit(frame) {
        frames.push(frame)
      },
      log() {},
    },
    {
      platform: "linux",
      ensurePolicyCompatibility: async () => {},
      pool: {
        claim() {
          claimed++
          return null
        },
        async prewarm() {
          warmed++
          return null
        },
      },
      query({ options }) {
        spawned++
        queryOptions = options
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success" }
          },
          interrupt() {},
          close() {},
        }
      },
      ...overrides,
    }
  )
  return {
    session,
    frames,
    stats: () => ({ spawned, claimed, warmed }),
    options: () => queryOptions,
  }
}

test("a completed query cannot prove disposal while its CLI subprocess is still alive", async () => {
  let child!: SpawnedProcess
  const captured = capture(
    {},
    {
      query({ options }) {
        child = options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          env: process.env,
          signal: new AbortController().signal,
        })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success" }
          },
          interrupt() {},
          close() {},
        }
      },
    }
  )
  try {
    await flush()
    assert.equal(
      captured.frames.some((frame) => frame.type === "session_ended"),
      true
    )
    assert.equal(
      captured.frames.some((frame) => frame.type === "session_disposed"),
      false
    )
  } finally {
    child.kill("SIGTERM")
  }
  for (
    let i = 0;
    i < 100 && !captured.frames.some((frame) => frame.type === "session_disposed");
    i++
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(captured.frames.filter((frame) => frame.type === "session_disposed").length, 1)
})

test("dispatch registers a synchronous session, then requires one-off Namespace consent before query or pool", async () => {
  const captured = capture({
    claudeAgentSdk: namespace,
    permissionMode: "bypassPermissions",
    bypassPermissionsConfirmed: true,
    permissionProfile: { workspace: "sandbox", outbound: "ask", secrets: "ask", hostConfig: "ask" },
  })
  assert.equal(typeof captured.session.pendingApprovals.get, "function")
  assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
  await flush()
  const request = captured.frames.find((frame) => frame.type === "permission_request")!
  assert.equal(request.toolName, "Runtime:Sandbox:NestedUserNamespaces")
  captured.session.pendingApprovals
    .get(String(request.requestId))!
    .resolve({ ...buildPermissionResult("allow", { requiresExplicitConsent: true }) })
  await flush()
  assert.deepEqual(captured.stats(), { spawned: 1, claimed: 0, warmed: 0 })
  assert.equal(captured.options()!.sandbox!.allowNestedUserNamespaces, true)
  assert.equal(captured.options()!.sandbox!.failIfUnavailable, true)
  assert.equal(captured.frames.filter((frame) => frame.type === "session_ended").length, 1)
  assert.equal(captured.session._ended, true)
})

test("denied Namespace and unknown host decisions never spawn, even in bypass mode", async () => {
  for (const decision of ["deny", "allow_always", "unknown"]) {
    const captured = capture({
      claudeAgentSdk: namespace,
      permissionMode: "bypassPermissions",
      bypassPermissionsConfirmed: true,
    })
    await flush()
    const request = captured.frames.find((frame) => frame.type === "permission_request")!
    captured.session.pendingApprovals
      .get(String(request.requestId))!
      .resolve({ ...buildPermissionResult(decision, { requiresExplicitConsent: true }) })
    await flush()
    assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
    assert.equal(captured.session.pendingApprovals.size, 0)
    assert.match(
      String(captured.frames.find((frame) => frame.type === "session_ended")!.error),
      /authorization/
    )
  }
})

test("a hostConfig deny ceiling prevents Namespace approval and query admission", () => {
  assert.throws(
    () =>
      capture({
        claudeAgentSdk: namespace,
        permissionMode: "bypassPermissions",
        bypassPermissionsConfirmed: true,
        permissionProfile: {
          workspace: "sandbox",
          outbound: "ask",
          secrets: "ask",
          hostConfig: "deny",
        },
      }),
    /hostConfig.*den/
  )
})

test("cancel or close before consent cannot create any SDK query", async () => {
  for (const close of [false, true]) {
    const captured = capture({ claudeAgentSdk: namespace })
    await flush()
    if (close) captured.session.q.close?.()
    else await captured.session.q.interrupt()
    await flush()
    assert.deepEqual(captured.stats(), { spawned: 0, claimed: 0, warmed: 0 })
    assert.equal(captured.session.pendingApprovals.size, 0)
    assert.equal(captured.session._ended, true)
  }
})

test("retry policy becomes managed env and abortController, never an SDK option or prewarm", async () => {
  const captured = capture({
    claudeAgentSdk: {
      version: 1,
      unattendedRetry: { maxWaitMs: 60000, usageLimitRecheckMs: 60000 },
      prewarm: { enabled: true },
    },
  })
  await flush()
  assert.deepEqual(captured.stats(), { spawned: 1, claimed: 0, warmed: 0 })
  assert.equal(captured.options()!.env!.CLAUDE_CODE_RETRY_WATCHDOG, "1")
  assert.equal("unattendedRetry" in captured.options()!, false)
  assert.ok(captured.options()!.abortController)
})

test("an incompatible actual CLI cannot start a policy invocation", async () => {
  const captured = capture(
    { claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs: 60000 } } },
    {
      ensurePolicyCompatibility: async () => {
        throw new Error("Claude Code >=2.1.305 is required (found 2.1.304)")
      },
    }
  )
  await flush()
  assert.equal(captured.stats().spawned, 0)
  assert.match(
    String(captured.frames.find((frame) => frame.type === "session_ended")!.error),
    /2.1.304/
  )
})

test("retry elapsed deadline terminates once and drains pending round trips", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let abortSignal: AbortSignal | undefined
  let closed = 0
  const captured = capture(
    { claudeAgentSdk: { version: 1, unattendedRetry: { maxWaitMs: 60000 } } },
    {
      query({ options }) {
        abortSignal = options.abortController!.signal
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
            yield { type: "never" }
          },
          interrupt: () => new Promise(() => {}),
          close() {
            closed++
          },
        }
      },
    }
  )
  await flush()
  let denied = false
  captured.session.pendingApprovals.set("later-tool", {
    input: {},
    resolve(answer) {
      denied = answer.behavior === "deny"
    },
  })
  captured.session.pushUserMessage("steer", "now")
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(abortSignal!.aborted, true)
  assert.equal(closed, 1)
  assert.equal(denied, true)
  assert.equal(captured.session.pendingApprovals.size, 0)
  assert.equal(captured.session._ended, true)
  const ended = captured.frames.filter((frame) => frame.type === "session_ended")
  assert.equal(ended.length, 1)
  assert.match(String(ended[0]!.error), /total invocation deadline/)
})

for (const name of [
  "Bash",
  "mcp__cognia-tools__write",
  "mcp__cognia-plugin-tools__plugin",
  "mcp__external__write",
]) {
  for (const expired of [false, true]) {
    test(`worker fence ${expired ? "expiry" : "refusal"} denies ${name} and interrupts the Claude query`, async (t) => {
      let now = 0
      t.mock.method(performance, "now", () => now)
      let allowed = true
      let calls = 0
      let interrupted = 0
      let executed = 0
      let options!: Options
      let finish!: () => void
      const running = new Promise<void>((resolve) => {
        finish = resolve
      })
      const session = dispatchAnthropic(
        {
          sessionId: "worker",
          firstPrompt: "work",
          sendOptions: {
            toolSurface: "full",
            permissionMode: "bypassPermissions",
            workerToolAdmission: true,
          },
          emit() {},
          log() {},
          hostRpc: {
            async call(method, params) {
              if (method !== "worker.admitTool") return { jobs: [], killed: [] }
              calls++
              assert.deepEqual(params, { sessionId: "worker", toolName: name, toolUseId: "tool" })
              return { allowed, leaseTtlMs: 100 }
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
      const pre = options.hooks!.PreToolUse!.at(-1)!.hooks[0]!
      const invoke = async () => {
        const decision = await pre(
          {
            hook_event_name: "PreToolUse",
            session_id: "sdk-private-id",
            transcript_path: "",
            cwd: ".",
            tool_name: name,
            tool_input: {},
            tool_use_id: "tool",
          },
          "tool",
          { signal: new AbortController().signal }
        )
        if (!("continue" in decision && decision.continue === false)) executed++
        return decision
      }
      try {
        await invoke()
        allowed = false
        if (expired) now = 100
        const result = await invoke()
        assert.ok("hookSpecificOutput" in result)
        assert.equal(result.hookSpecificOutput?.hookEventName, "PreToolUse")
        assert.equal(
          (result.hookSpecificOutput as { permissionDecision?: string }).permissionDecision,
          "deny"
        )
        await flush()
        assert.equal(interrupted, 1)
        assert.equal(executed, 1)
        const previousCalls = calls
        await invoke()
        assert.equal(calls, previousCalls, "denial is session-latched")
        // A lapsed local deadline still asks Node; the unrenewed lease is refused there.
        assert.equal(calls, 2)
      } finally {
        session.closeInput()
        finish()
      }
    })
  }
}

test("Claude sends without workerToolAdmission never ask the worker authority", async () => {
  let calls = 0
  let options!: Options
  const session = dispatchAnthropic(
    {
      sessionId: "generic",
      firstPrompt: "work",
      sendOptions: { toolSurface: "full", permissionMode: "bypassPermissions" },
      emit() {},
      log() {},
      hostRpc: {
        async call(method) {
          if (method === "worker.admitTool") calls++
          return {}
        },
      },
    },
    {
      query(args) {
        options = args.options
        return {
          async *[Symbol.asyncIterator]() {},
          interrupt() {},
          close() {},
        }
      },
    }
  )
  try {
    for (const entry of options.hooks?.PreToolUse ?? []) {
      for (const hook of entry.hooks)
        await hook(
          {
            hook_event_name: "PreToolUse",
            session_id: "generic",
            transcript_path: "",
            cwd: ".",
            tool_name: "Read",
            tool_input: {},
            tool_use_id: "t",
          },
          "t",
          { signal: new AbortController().signal }
        )
    }
    assert.equal(calls, 0)
  } finally {
    session.closeInput()
  }
})
