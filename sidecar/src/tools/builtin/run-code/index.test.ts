import { test } from "node:test"
import assert from "node:assert/strict"

import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { after, mock } from "node:test"

import { RUN_CODE_TOOL_NAME, codeModeToolDefs, createRunCodeTool } from "./index.ts"
import { asCallable, firstJson, firstText } from "../../../../test-support/tool-result.ts"

const SANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: true, launcher: ["/usr/bin/env"] })
const UNSANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: false, launcher: null })

/** The JSON `run_code` answers with, success or failure. */
interface RunCodePayload {
  result?: unknown
  callsUsed: number
  logs?: { level: string; text: string }[]
  limit?: { kind: string }
}

/** Pull the text payload out of an MCP CallToolResult. */
function payload(result: { content: unknown[] }): RunCodePayload {
  return firstJson<RunCodePayload>(result)
}

// Broker tests exercise dispatch, not OS RSS accounting (which has its own
// supervisor tests). Keep real child execution while supplying process usage.
const processGroups = new Set<number>()
const spawn = childProcess.spawn
const spawnSync = childProcess.spawnSync
mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
  const child = spawn(...args)
  if (child.pid) processGroups.add(child.pid)
  return child
})
mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawnSync>) =>
  args[0] === "ps"
    ? { status: 0, stdout: [...processGroups].map((pid) => `${pid} ${pid} 1`).join("\n") }
    : spawnSync(...args)
)
syncBuiltinESMExports()
after(() => {
  mock.restoreAll()
  syncBuiltinESMExports()
})

test("exposes exactly one tool in Code presentation", () => {
  const defs = codeModeToolDefs({ callTool: async () => null, probe: SANDBOXED })
  assert.equal(defs.length, 1)
  assert.equal(defs[0]!.name, RUN_CODE_TOOL_NAME)
})

// Fail closed: there is no executor to reach at all on an unsandboxed host,
// rather than one that refuses per call.
test("exposes no tool at all when the host cannot sandbox", () => {
  assert.deepEqual(codeModeToolDefs({ callTool: async () => null, probe: UNSANDBOXED }), [])
})

test("runs a program and reports the calls it used", async () => {
  const tool = asCallable(
    createRunCodeTool({
      callTool: async (name) => ({ tool: name }),
      probe: SANDBOXED,
    })
  )
  const result = await tool.handler({ source: 'return await cognia.read({ path: "a" })' })
  assert.notEqual(result.isError, true)
  assert.deepEqual(payload(result).result, { tool: "read" })
  assert.equal(payload(result).callsUsed, 1)
})

test("reports a limit hit with the ceiling that was reached", async () => {
  const tool = asCallable(createRunCodeTool({ callTool: async () => null, probe: SANDBOXED }))
  const result = await tool.handler({ source: "x".repeat(40_000) })
  assert.equal(result.isError, true)
  assert.equal(payload(result).limit!.kind, "source-too-large")
})

test("refuses with an explicit no-fallback message when unsandboxed", async () => {
  const tool = asCallable(createRunCodeTool({ callTool: async () => null, probe: UNSANDBOXED }))
  const result = await tool.handler({ source: "return 1" })
  assert.equal(result.isError, true)
  const text = firstText(result)
  assert.match(text, /strict sandbox/)
  // The user-facing wording has to rule out the degraded path explicitly.
  assert.match(text, /no unsandboxed fallback/i)
})

test("treats a missing source as an empty program rather than throwing", async () => {
  const tool = asCallable(createRunCodeTool({ callTool: async () => null, probe: SANDBOXED }))
  const result = await tool.handler({})
  assert.notEqual(result.isError, true)
  assert.equal(payload(result).result, null)
})

test("surfaces program logs alongside the result", async () => {
  const tool = asCallable(createRunCodeTool({ callTool: async () => null, probe: SANDBOXED }))
  const result = await tool.handler({ source: 'console.log("hi"); return 1' })
  assert.deepEqual(payload(result).logs, [{ level: "info", text: "hi" }])
})

test("run_code forwards call context to nested authorization", async () => {
  const controller = new AbortController()
  const tool = createRunCodeTool({
    callTool: async (_name, _input, extra) => extra?.signal === controller.signal,
    probe: SANDBOXED,
  })
  const result = await tool.handler(
    { source: "return await cognia.read({})" },
    { signal: controller.signal }
  )
  assert.notEqual(result.isError, true)
  assert.equal(payload(result).result, true)
})
