// Characterization probes for observed defects, not application acceptance.
// Each passing assertion confirms a gap; repair should invalidate that probe.
// Run: node --test docs/evidence/2026-11-08-builtin-agent-tool-support-audit.probes.mjs
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, test } from "node:test"
import { build } from "esbuild"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"

import { buildAiSdkTools } from "../../sidecar/src/tools/adapters/ai-sdk.ts"
import { createReadTracker } from "../../sidecar/src/tools/state/read-tracker.ts"
import { buildPluginToolDefinitions } from "../../sidecar/src/tools/plugin/proxy.ts"
import { createEventAdapter } from "../../sidecar/src/runtimes/ai-sdk/events.ts"
import { finalizeToolSurface } from "../../lib/claude/tool-surface-finalizer.ts"
import { createToolPermissionGate } from "../../sidecar/src/policy/permission/ai-sdk-gate.ts"
import { createAnthropicCanUseTool } from "../../sidecar/src/policy/permission/sdk-can-use-tool.ts"
import { jsonSchemaToZodShape } from "../../sidecar/src/tools/plugin/json-schema-zod.ts"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = path.join(root, ".cache/builtin-agent-tool-support-audit")
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(path.join(cache, "probe-"))
after(() => rm(scratch, { recursive: true, force: true }))

const findings = []
function record(id, evidence) {
  findings.push({ id, ...evidence })
}
after(() => writeFile(path.join(cache, "probes.json"), JSON.stringify(findings, null, 2)))

test("F1: Claude-style deny names leave native AI SDK equivalents executable", async () => {
  const tools = buildAiSdkTools({
    sessionId: "audit-native-deny",
    emit() {},
    readTracker: createReadTracker(),
    sendOptions: {
      cwd: scratch,
      builtinTools: { coreFiles: true },
      disallowedTools: ["Write", "Read", "Edit", "Bash"],
      permissionMode: "bypassPermissions",
    },
  })
  const present = ["write", "read", "edit", "bash"].filter((name) => name in tools)
  assert.equal(present.length, 4)
  const file = path.join(scratch, "denied-write.txt")
  await tools.write.execute({ file_path: file, content: "audit-marker" })
  assert.equal(await readFile(file, "utf8"), "audit-marker")
  const control = buildAiSdkTools({
    sessionId: "audit-native-deny-control",
    emit() {},
    readTracker: createReadTracker(),
    sendOptions: { builtinTools: { coreFiles: true }, disallowedTools: ["write"] },
  })
  assert.equal(control.write, undefined)
  record("F1", {
    denied: ["Write", "Read", "Edit", "Bash"],
    present,
    wroteFixture: true,
    bareControlRemoved: true,
  })
})

test("F2: Code broker reaches a tool removed and explicitly denied at the adapter", async (t) => {
  if (process.platform !== "darwin") return t.skip("This fixture uses macOS sandbox-exec")
  const previous = process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  // Real OS launcher, network and file writes denied. The program is a fixed
  // metadata lookup of this probe's own fixture; no user code or secrets.
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = JSON.stringify([
    "/usr/bin/sandbox-exec",
    "-p",
    "(version 1)(allow default)(deny network*)(deny file-write*)",
  ])
  try {
    const fixture = path.join(scratch, "metadata.txt")
    await writeFile(fixture, "audit-marker")
    const options = {
      builtinTools: { fileExtras: true },
      disallowedTools: ["file_info"],
      permissionRuleset: { "mcp__cognia-tools__file_info": "deny" },
      permissionMode: "bypassPermissions",
      execution: { composition: { toolPresentation: "both" } },
    }
    const tools = buildAiSdkTools({ sessionId: "audit-code-deny", emit() {}, sendOptions: options })
    assert.equal(tools.file_info, undefined)
    assert.ok(tools.run_code)
    const output = await tools.run_code.execute({
      source: `return await cognia.file_info({path:${JSON.stringify(fixture)}})`,
    })
    const nested = JSON.parse(output)
    const info = JSON.parse(nested.result.content[0].text)
    assert.equal(info.exists, true)
    assert.equal(info.size, 12)
    // Remove only the palette denial: the direct gate still refuses this same
    // fully-qualified ruleset, proving the nested broker skipped that gate.
    const direct = buildAiSdkTools({
      sessionId: "audit-code-deny-control",
      emit() {},
      sendOptions: { ...options, disallowedTools: [], execution: undefined },
    })
    await assert.rejects(
      direct.file_info.execute({ path: fixture }),
      /denied by permission ruleset/
    )
    record("F2", {
      directToolRemoved: true,
      nestedExists: info.exists,
      nestedCalls: nested.callsUsed,
      directRulesetControlDenied: true,
      launcher: "sandbox-exec",
    })
  } finally {
    if (previous === undefined) delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
    else process.env.COGNIA_CODE_SANDBOX_LAUNCHER = previous
  }
})

test("F3: renderer-proxied MCP isError becomes a successful AI SDK result", async () => {
  const payload = { isError: true, content: [{ type: "text", text: "fixture failed" }] }
  const pending = new Map()
  const tools = buildAiSdkTools({
    sessionId: "audit-error-result",
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "audit_error", description: "Fixture", jsonSchema: { type: "object" } },
      ],
    },
    pendingPluginToolCalls: pending,
    emit(frame) {
      if (frame.type === "plugin_tool_exec")
        pending.get(frame.toolUseId).resolve({ result: payload })
    },
  })
  const output = await tools.audit_error.execute({}, { toolCallId: "audit-call" })
  assert.equal(JSON.parse(output).isError, true)
  const mapper = createEventAdapter({ sdkSessionId: "audit-error-result", model: "fixture" })
  const frames = mapper.handle({
    type: "tool-result",
    toolCallId: "audit-call",
    toolName: "audit_error",
    output,
  })
  const result = frames.find((frame) => frame.type === "user").message.content[0]
  assert.equal(result.is_error, false)
  const nativePending = new Map()
  const [native] = buildPluginToolDefinitions({
    sessionId: "audit-error-result-control",
    tools: [{ name: "audit_error", description: "Fixture", jsonSchema: { type: "object" } }],
    pendingPluginToolCalls: nativePending,
    emit(frame) {
      nativePending.get(frame.toolUseId).resolve({ result: payload })
    },
  })
  assert.equal((await native.handler({})).isError, true)
  record("F3", {
    payloadIsError: true,
    aiSdkOutput: output,
    renderedIsError: result.is_error,
    anthropicProxyPreservesError: true,
  })
})

// The only substituted dependency is the effectful renderer executor. The
// bridge and installed ai@7.0.128 definitions execute unchanged from source.
const standaloneModule = path.join(scratch, "standalone-tools.mjs")
await build({
  entryPoints: [path.join(root, "lib/ai/chat/standalone-tools.ts")],
  outfile: standaloneModule,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  plugins: [
    {
      name: "isolated-renderer-executor",
      setup(api) {
        api.onResolve({ filter: /^@\/lib\/claude\/plugin-tool-ipc$/ }, () => ({
          path: "executor",
          namespace: "audit",
        }))
        api.onLoad({ filter: /.*/, namespace: "audit" }, () => ({
          contents:
            "export async function handlePluginToolExec(request) { globalThis.__builtinAuditCalls.push(request); return {result: 'fixture-executed'} }",
        }))
      },
    },
  ],
})
const { buildStandaloneTools } = await import(pathToFileURL(standaloneModule).href)
const manifest = (name) => ({
  name,
  description: "Audit fixture",
  pluginId: "cognia-artifact-builtin",
  requiresApproval: true,
  jsonSchema: { type: "object", properties: {} },
})

test("F4: standalone ignores nonempty allow/deny lists, plan mode and per-call approval", async () => {
  globalThis.__builtinAuditCalls = []
  const policies = [
    finalizeToolSurface({}, { mode: "deny", tools: ["artifact_delete"] }),
    finalizeToolSurface({}, { mode: "allow", tools: ["artifact_read"] }),
    { permissionRuleset: { artifact_delete: "deny" } },
    { permissionMode: "plan" },
    {},
  ]
  for (const policy of policies) {
    const resolved = buildStandaloneTools(
      { pluginTools: [manifest("artifact_delete")], ...policy },
      "audit-standalone-policy"
    )
    assert.ok(resolved.tools.artifact_delete)
    assert.equal(
      await resolved.tools.artifact_delete.execute({}, { toolCallId: "audit-delete" }),
      "fixture-executed"
    )
  }
  assert.equal(globalThis.__builtinAuditCalls.length, policies.length)
  record("F4", {
    deniedToolExposed: true,
    incompatibleAllowListIgnored: true,
    planModeIgnored: true,
    requiresApprovalIgnored: true,
    fixtureExecutorCalls: policies.length,
  })
})

test("F5: standalone drops the caller abort signal at the renderer executor", async () => {
  globalThis.__builtinAuditCalls = []
  const controller = new AbortController()
  controller.abort()
  const resolved = buildStandaloneTools(
    { pluginTools: [manifest("web_search")] },
    "audit-standalone-abort"
  )
  await resolved.tools.web_search.execute(
    {},
    { toolCallId: "audit-abort", abortSignal: controller.signal }
  )
  assert.equal(globalThis.__builtinAuditCalls.length, 1)
  assert.equal(globalThis.__builtinAuditCalls[0].abortSignal, undefined)
  record("F5", {
    callerAlreadyAborted: true,
    fixtureExecutorCalls: 1,
    executorReceivedSignal: false,
  })
})

test("G1: standalone drops dotted tool names accepted by the sidecar alias layer", () => {
  const resolved = buildStandaloneTools(
    { pluginTools: [manifest("ocr.extract"), manifest("web_search")] },
    "audit-standalone-names"
  )
  assert.deepEqual(resolved.rejected, ["ocr.extract"])
  assert.equal(resolved.tools["ocr.extract"], undefined)
  record("G1", { dropped: resolved.rejected, remaining: Object.keys(resolved.tools) })
})

test("F6: AI SDK approval rewrites skip the credential-path authority recheck", async () => {
  const toolName = "mcp__cognia-plugin-tools__audit_writer"
  const original = { path: path.join(scratch, "safe.txt") }
  const rewritten = { path: path.join(scratch, ".ssh", "id_rsa") }
  const options = {
    cwd: scratch,
    confinement: { enabled: true, roots: [scratch] },
    pluginTools: [{ name: "audit_writer", access: "write", pathParams: ["path"] }],
  }
  const pending = new Map()
  const gate = createToolPermissionGate({
    sessionId: "audit-rewrite",
    sendOptions: options,
    pendingApprovals: pending,
    emit(frame) {
      queueMicrotask(() =>
        pending.get(frame.requestId)?.resolve({ behavior: "allow", updatedInput: rewritten })
      )
    },
  })
  assert.deepEqual(await gate(toolName, original), rewritten)
  await assert.rejects(gate(toolName, rewritten), /protected credential path/)
  const nativePending = new Map()
  const native = createAnthropicCanUseTool({
    sessionId: "audit-rewrite-control",
    sendOptions: options,
    pendingApprovals: nativePending,
    pluginToolNameAliases: new Map(),
    log() {},
    emit(frame) {
      queueMicrotask(() =>
        nativePending.get(frame.requestId)?.resolve({ behavior: "allow", updatedInput: rewritten })
      )
    },
  })
  assert.equal((await native(toolName, original, {})).behavior, "deny")
  record("F6", {
    aiSdkAllowedCredentialRewrite: true,
    directCredentialControlDenied: true,
    anthropicRewriteControlDenied: true,
    effectfulHandlerInvoked: false,
  })
})

test("F7: JSON Schema metadata without a validator lets invalid model input reach the proxy", async () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string", minLength: 3 }, limit: { type: "integer", maximum: 2 } },
    required: ["query"],
    additionalProperties: false,
  }
  const invalid = { query: 123, limit: 999, extra: true }
  assert.equal(z.object(jsonSchemaToZodShape(schema)).safeParse(invalid).success, false)
  const pending = new Map()
  const received = []
  const tools = buildAiSdkTools({
    sessionId: "audit-schema",
    pendingPluginToolCalls: pending,
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [{ name: "audit_schema", description: "Fixture", jsonSchema: schema }],
    },
    emit(frame) {
      if (frame.type !== "plugin_tool_exec") return
      received.push(frame.args)
      pending.get(frame.toolUseId).resolve({ result: "fixture-executed" })
    },
  })
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "invalid-schema",
          toolName: "audit_schema",
          input: JSON.stringify(invalid),
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
  await generateText({
    model,
    messages: [{ role: "user", content: "Exercise the fixture" }],
    tools,
    telemetry: { isEnabled: false },
  })
  assert.deepEqual(received, [invalid])
  record("F7", {
    realAiSdkModelCalls: model.doGenerateCalls.length,
    invalidInputReachedProxy: true,
    convertedZodControlRejected: true,
  })
})
