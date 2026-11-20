import { test } from "node:test"
import assert from "node:assert/strict"

import { RUN_CODE_TOOL_NAME, codeModeToolDefs, createRunCodeTool } from "./index.ts"
import { asCallable, firstJson, firstText } from "../../../../test-support/tool-result.ts"
import { fakeSandboxRss } from "../../../../test-support/sandbox-rss.ts"
import type { CodeRunCallReport } from "./trace.ts"

const SANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: true, launcher: ["/usr/bin/env"] })
const UNSANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: false, launcher: null })
const SDK_TOOLS = [{ name: "read" }]

/** The JSON `run_code` answers with, success or failure. */
interface RunCodePayload {
  result?: unknown
  callsUsed: number
  logs?: { level: string; text: string }[]
  limit?: { kind: string }
  phase?: string
  error?: { name: string; message: string }
}

/** The failure classification `run_code` attached, if any. */
function failureOf(result: unknown) {
  return (result as { _meta?: { "cognia/failure"?: { kind: string; retryable: boolean } } })
    ._meta?.["cognia/failure"]
}

/** Pull the text payload out of an MCP CallToolResult. */
function payload(result: { content: unknown[] }): RunCodePayload {
  return firstJson<RunCodePayload>(result)
}

// Broker tests exercise dispatch, not OS RSS accounting (which has its own
// supervisor tests). Keep real child execution while supplying process usage.
const processGroups = fakeSandboxRss()

test("exposes exactly one tool in Code presentation", () => {
  const defs = codeModeToolDefs({
    callTool: async () => null,
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
  })
  assert.equal(defs.length, 1)
  assert.equal(defs[0]!.name, RUN_CODE_TOOL_NAME)
})

// Fail closed: there is no executor to reach at all on an unsandboxed host,
// rather than one that refuses per call.
test("exposes no tool at all when the host cannot sandbox", () => {
  assert.deepEqual(
    codeModeToolDefs({ callTool: async () => null, probe: UNSANDBOXED, sdkTools: SDK_TOOLS }),
    []
  )
})

// CM-05: a run_code whose SDK has no functions can only fail.
test("exposes no tool when no eligible tool is permitted", () => {
  assert.deepEqual(
    codeModeToolDefs({ callTool: async () => null, probe: SANDBOXED, sdkTools: [] }),
    []
  )
})

// CM-06: deferring the entry behind tool search left a Code turn whose first
// step could only search for the one tool it had.
test("stays resident under tool search", () => {
  const [def] = codeModeToolDefs({
    callTool: async () => null,
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
  })
  assert.equal(def!.alwaysLoad, true)
})

test("runs a program and reports the calls it used", async () => {
  const tool = asCallable(
    createRunCodeTool({
      callTool: async (name) => ({ tool: name }),
      probe: SANDBOXED,
      sdkTools: SDK_TOOLS,
    })
  )
  const result = await tool.handler({ source: 'return await cognia.read({ path: "a" })' })
  assert.notEqual(result.isError, true)
  assert.deepEqual(payload(result).result, { tool: "read" })
  assert.equal(payload(result).callsUsed, 1)
})

test("reports a limit hit with the ceiling that was reached", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: "x".repeat(40_000) })
  assert.equal(result.isError, true)
  assert.equal(payload(result).limit!.kind, "source-too-large")
})

test("refuses with an explicit no-fallback message when unsandboxed", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: UNSANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: "return 1" })
  assert.equal(result.isError, true)
  const text = firstText(result)
  assert.match(text, /strict sandbox/)
  // The user-facing wording has to rule out the degraded path explicitly.
  assert.match(text, /no unsandboxed fallback/i)
})

test("treats a missing source as an empty program rather than throwing", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({})
  assert.notEqual(result.isError, true)
  assert.equal(payload(result).result, null)
})

test("surfaces program logs alongside the result", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: 'console.log("hi"); return 1' })
  assert.deepEqual(payload(result).logs, [{ level: "info", text: "hi" }])
})

test("run_code forwards call context to nested authorization with the run's signal", async () => {
  const controller = new AbortController()
  let seen: { marker?: unknown; signal?: AbortSignal } | undefined
  const tool = createRunCodeTool({
    callTool: async (_name, _input, extra) => {
      seen = extra as typeof seen
      return extra?.marker
    },
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
  })
  const result = await tool.handler(
    { source: "return await cognia.read({})" },
    { signal: controller.signal, marker: "turn-ctx" }
  )
  assert.notEqual(result.isError, true)
  assert.equal(payload(result).result, "turn-ctx")
  // Not the turn's signal itself: the run's own, which ending the run trips.
  assert.notEqual(seen!.signal, controller.signal)
  assert.equal(seen!.signal!.aborted, true, "the run's end cancels what it started")
})

// CM-12: nested approvals, reviews and executions used ids unrelated to the
// run, so nothing could show a call under the run_code that made it.
test("names nested calls after the run_code call and reports them under it", async () => {
  const ids: unknown[] = []
  const reports: CodeRunCallReport[] = []
  const tool = createRunCodeTool({
    callTool: async (_name, _input, extra) => {
      ids.push(extra?.toolCallId)
      return { ok: true }
    },
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
    reportCall: (report) => reports.push(report),
  })
  const result = await tool.handler(
    { source: 'await cognia.read({ path: "a" }); return await cognia.read({ path: "b" })' },
    { toolCallId: "toolu_outer" }
  )
  assert.notEqual(result.isError, true)
  assert.deepEqual(ids, ["toolu_outer/1", "toolu_outer/2"])
  assert.ok(reports.every((report) => report.parentToolCallId === "toolu_outer"))
  assert.deepEqual(
    reports.map(({ call }) => [call.ordinal, call.state]),
    [
      [1, "running"],
      [1, "succeeded"],
      [2, "running"],
      [2, "succeeded"],
    ]
  )
})

test("reports nothing for a call the rail did not name", async () => {
  const ids: unknown[] = []
  const reports: CodeRunCallReport[] = []
  const tool = createRunCodeTool({
    callTool: async (_name, _input, extra) => {
      ids.push(extra?.toolCallId)
      return null
    },
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
    reportCall: (report) => reports.push(report),
  })
  await tool.handler({ source: "return await cognia.read({})" })
  assert.deepEqual(reports, [])
  assert.equal(typeof ids[0], "string", "the nested call still gets an id of its own")
  assert.doesNotMatch(String(ids[0]), /\//)
})

// CM-10: the supervisor never saw the turn's signal, so Stop left the script
// and its nested calls running until the wall clock.
test("cancelling the turn cancels the program and its pending nested call", async () => {
  const controller = new AbortController()
  let nestedSignal: AbortSignal | undefined
  const tool = createRunCodeTool({
    callTool: (_name, _input, extra) => {
      nestedSignal = extra?.signal
      setTimeout(() => controller.abort(), 20)
      return new Promise(() => {})
    },
    probe: SANDBOXED,
    sdkTools: SDK_TOOLS,
  })
  const result = await tool.handler(
    { source: "return await cognia.read({})" },
    { signal: controller.signal }
  )
  assert.equal(result.isError, true)
  assert.equal(payload(result).phase, "cancelled")
  assert.deepEqual(failureOf(result), { kind: "aborted", retryable: false })
  assert.equal(nestedSignal!.aborted, true)
})

test("an already-cancelled turn never spawns the program", async () => {
  const controller = new AbortController()
  controller.abort()
  const before = processGroups.size
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: "return 1" }, { signal: controller.signal })
  assert.equal(payload(result).phase, "cancelled")
  assert.equal(processGroups.size, before)
})

// CM-08: a syntax error used to be reported as `resource-exhausted`.
test("classifies a program that does not compile as invalid arguments", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: "return )(" })
  assert.equal(result.isError, true)
  assert.equal(payload(result).phase, "compile")
  assert.equal(payload(result).error!.name, "SyntaxError")
  assert.deepEqual(failureOf(result), { kind: "invalid-args", retryable: false })
})

test("classifies a program that threw as an execution failure", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: 'throw new Error("boom")' })
  assert.equal(payload(result).phase, "run")
  assert.deepEqual(failureOf(result), { kind: "execution-failed", retryable: true })
})

test("classifies a program refused for concurrency as retryable", async () => {
  const sessionId = `run-code-busy-${process.pid}-${Date.now()}`
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const tool = asCallable(
    createRunCodeTool({
      callTool: async () => {
        await held
        return null
      },
      probe: SANDBOXED,
      sdkTools: SDK_TOOLS,
      sessionId,
    })
  )
  const first = tool.handler({ source: "return await cognia.read({})" })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const controller = new AbortController()
  const second = tool.handler({ source: "return 1" }, { signal: controller.signal })
  controller.abort()
  const cancelled = await second
  assert.equal(payload(cancelled).phase, "cancelled", "a queued program follows the turn")
  release()
  assert.notEqual((await first).isError, true)
})

test("keeps limits classified as resource exhaustion", async () => {
  const tool = asCallable(
    createRunCodeTool({ callTool: async () => null, probe: SANDBOXED, sdkTools: SDK_TOOLS })
  )
  const result = await tool.handler({ source: "x".repeat(40_000) })
  assert.equal(payload(result).phase, "limit")
  assert.deepEqual(failureOf(result), { kind: "resource-exhausted", retryable: false })
})
