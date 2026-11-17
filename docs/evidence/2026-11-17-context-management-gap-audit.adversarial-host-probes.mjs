#!/usr/bin/env node
/**
 * Local, synthetic characterization of two host orchestration boundaries.
 * Run: node docs/evidence/2026-11-17-context-management-gap-audit.adversarial-host-probes.mjs
 *
 * This separate review artifact exercises public plugin run + child launcher
 * functions together, beyond the original resolver-only probe. Production
 * files are transpiled unchanged. Registry, journal, ownership, authority and
 * background-manager boundaries are synthetic; no model is allowed to run.
 * The native case checks the actual option overlay, not vendor SDK behavior.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(resolve(root, "package.json"))
const ts = require("typescript")

function loadSource(relativePath, dependencies = {}) {
  const source = readFileSync(resolve(root, relativePath), "utf8")
  const compiled = ts.transpileModule(source, {
    fileName: relativePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const cjsModule = { exports: {} }
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith("node:")) return require(name)
      throw new Error(`Unprovided import in isolated probe: ${relativePath}: ${name}`)
    },
    cjsModule,
    cjsModule.exports
  )
  return cjsModule.exports
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolveValue) => {
    resolvePromise = resolveValue
  })
  return { promise, resolve: resolvePromise }
}

function forbidden(label) {
  return () => {
    throw new Error(`Forbidden side effect in host probe: ${label}`)
  }
}

async function pluginAbortDuringContextPreparation() {
  const entered = deferred()
  const providerReply = deferred()
  const provider = {
    pluginId: "audit-plugin",
    entry: {
      provide: () => {
        entered.resolve()
        return providerReply.promise
      },
    },
  }
  const context = loadSource("lib/plugin/agent-sdk/context-providers.ts", {
    "@/lib/plugin/registries/context-provider-registry": {
      listContextProviderEntries: () => [provider],
    },
    "@/lib/execution/personal-visibility": {},
  })
  const guardrails = loadSource("packages/plugin-contract/src/lib/plugin/agent-sdk/guardrails.ts", {
    "../registries/guardrail-registry": { getGuardrail: () => undefined },
  })
  const personalEgress = { bindPersonalEgressOptions: (value) => value }
  const rows = new Map()
  const owned = new Set()
  const stops = new Map()
  const runStops = {
    registerRunStop: (id, stop) => {
      stops.set(id, stop)
      return () => stops.delete(id)
    },
    hasRunStop: (id) => stops.has(id),
  }
  const launcher = loadSource("lib/execution/launch-child-run.ts", {
    "@/lib/execution/personal-egress": personalEgress,
    "@cognia/agent-trace/emitter": { emitFinishedSpan() {} },
    "@/lib/db/execution-runs": {
      getExecutionRun: async (id) => rows.get(id),
      appendRunObservation: forbidden("appendRunObservation"),
    },
    "@/lib/modules/ports": { loadPort: forbidden("loadPort") },
    "./acting-authority": {
      startToolExecutionRun: async (_sessionId, input) => {
        rows.set(input.runId, { id: input.runId, status: "running" })
      },
      finishToolExecutionRun: async (id, failed) => {
        rows.get(id).status = failed === "cancelled" ? "cancelled" : failed ? "failed" : "completed"
      },
    },
    "./run-stops": runStops,
    "./child-run-ownership": {
      CHILD_RUN_LAUNCHER_MARK: "child-run",
      holdChildRunOwnership: async (id) => {
        owned.add(id)
        return () => owned.delete(id)
      },
    },
    "./run-authority": {
      resolveRunAuthority: async () => ({}),
      RunAuthorityError: class RunAuthorityError extends Error {},
    },
  })
  let modelCalls = 0
  const managed = new AbortController()
  const manager = {
    registerAgent: () => managed.signal,
    finishAgent() {},
    cancelAgent: () => managed.abort(),
  }
  const runner = loadSource("lib/plugin/agent-sdk/run.ts", {
    "@/lib/plugin/core/invocation-identity": { pluginExecutionContext: () => undefined },
    "@/lib/execution/personal-egress": personalEgress,
    "@/lib/execution/personal-operation": { personalOperationSources: () => undefined },
    "@/lib/ai/agent/background-agent-manager": { getBackgroundAgentManager: () => manager },
    "@/lib/execution/run-stops": runStops,
    "./stream": loadSource("lib/plugin/agent-sdk/stream.ts"),
    "./guardrails": guardrails,
    "./context-providers": context,
    "./tracing": { withRunTrace: (_enabled, _meta, _prompt, work) => work() },
    "./pii-gate": { createPiiRedactionGate: forbidden("PII tool gate creation") },
    "@cognia/redact": { hasNoLeakingPii: () => true, hasNoLeakingPiiDeep: () => true },
    "@cognia/agent-config-types/agent-capability-grant": {},
    "@/lib/execution/launch-child-run": launcher,
    "@/lib/execution/acting-authority": { authorityParentRunId: async () => undefined },
    "@/lib/ai/agent/execution/agent-execution-service": {
      executeAgentTurnFromRenderer: () => {
        modelCalls += 1
        throw new Error("No model/provider execution is allowed in this probe")
      },
    },
  })
  const controller = new AbortController()
  let settled = false
  const pending = runner.runPluginAgent(
    "synthetic task",
    { abortSignal: controller.signal, timeoutMs: 5 },
    { pluginId: "audit-plugin", agentId: "audit-plugin-run" }
  )
  pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await entered.promise
  controller.abort(new Error("synthetic caller stop"))
  await new Promise((done) => setTimeout(done, 40))
  const runId = "execution:job:audit-plugin-run"
  assert.equal(settled, false)
  assert.equal(rows.get(runId)?.status, "running")
  assert.equal(owned.has(runId), true)
  assert.equal(stops.has(runId), true)
  assert.equal(modelCalls, 0)
  console.log(
    JSON.stringify({
      id: "AH01-plugin-preparation-outlives-stop-and-run-timeout",
      result: "observed",
      callerAborted: controller.signal.aborted,
      configuredRunTimeoutMs: 5,
      observedAfterMs: 40,
      runPromiseSettled: settled,
      executionRowStatus: rows.get(runId).status,
      childOwnershipHeld: owned.has(runId),
      runStopRegistered: stops.has(runId),
      modelCalls,
      limits:
        "In-memory authority/journal/ownership adapters; no assertion about Job Center visual state.",
    })
  )
  // End the synthetic provider explicitly; no pending test promise survives.
  providerReply.resolve("")
  await pending.catch(() => undefined)
  assert.equal(owned.has(runId), false)
  assert.equal(modelCalls, 0)
}

function defaultNativeOptionsDoNotRescueInstructionLoading() {
  const overlay = loadSource("sidecar/src/runtimes/claude-agent-sdk/sdk-options.ts", {
    "@cognia/agent-contracts/external-agent": {},
    "@cognia/redact": {},
    "@cognia/agent-config-types/claude-agent-sdk-options": {},
  })
  const native = overlay.applyClaudeAgentSdkOptions(
    {
      settingSources: ["user", "project", "local"],
    },
    undefined
  )
  assert.deepEqual(native.options.settingSources, [])
  assert.deepEqual(native.options.skills, [])
  console.log(
    JSON.stringify({
      id: "AH02-default-native-overlay-disables-discovery",
      result: "observed",
      nestedSdkOption: "omitted",
      resultingSettingSources: native.options.settingSources,
      resultingSkills: native.options.skills,
      limits:
        "Actual Cognia options overlay only; vendor SDK not started. Shared headless loader is covered by C2.",
    })
  )
}

await pluginAbortDuringContextPreparation()
defaultNativeOptionsDoNotRescueInstructionLoading()
console.log("2 adversarial host characterization probes observed the current boundaries.")
