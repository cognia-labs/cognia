/**
 * Plugin Agent SDK runtime — `runPluginAgent` (one-shot) and
 * `runPluginAgentStreamed` (async-iterable). Both adapt the typed
 * {@link PluginAgentRunOptions} onto the executor's `ExecuteAgentConfig`
 * (`lib/ai/agent/agent-executor.ts`), register the run with the
 * background-agent-manager for cancellation, run it as a child run so it has
 * its `executionRuns` row (`launchChildRun`), and reuse the structured-output /
 * `canUseTool` / streaming plumbing the executor already threads.
 *
 * Permission gating (the `agent:control` check for tool-enabled runs) lives in
 * the caller (`lib/plugin/core/context.ts`); this module is permission-agnostic
 * so it stays unit-testable without the plugin manager.
 */

import type {
  ExecuteAgentConfig,
  ExecuteAgentResult,
  AgentTool,
} from "@/lib/ai/agent/agent-executor"
import { getBackgroundAgentManager } from "@/lib/ai/agent/background-agent-manager"
import { hasRunStop } from "@/lib/execution/run-stops"
import { createPluginAgentRun } from "./stream"
import { runInputGuardrails, runOutputGuardrails } from "./guardrails"
import { resolveContextContributions } from "./context-providers"
import { withRunTrace } from "./tracing"
import { createPiiRedactionGate } from "./pii-gate"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  validateAgentCapabilityGrant,
  type AgentCapabilityGrantV1,
} from "@cognia/agent-config-types/agent-capability-grant"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
  PluginToolPermissionFn,
} from "@/types/plugin/plugin-agent-sdk"

export interface RunPluginAgentMeta {
  /** Owning plugin id (telemetry + bulk cancel). */
  pluginId?: string
  /** Human-readable label shown in the background-agent list. */
  label?: string
  /** Caller-chosen cancellation handle. Minted when omitted. */
  agentId?: string
}

/**
 * Compose the permission gates that guard a run into a single
 * {@link PluginToolPermissionFn}. Stages run in order and a `deny` from any one
 * short-circuits; each stage's (possibly rewritten) input flows into the next:
 *   0. PII redaction — host-applied, always
 *   1. per-tool `canUseTool` (declared on an inline tool)
 *   2. run-level `canUseTool`
 *   3. `hooks.onPreToolUse` lifecycle hook — sees the fully-rewritten input
 *
 * Stage 0 is the host's, not the plugin's. A plugin-driven tool call has no
 * human reviewing its arguments, so the redactor runs on EVERY plugin run
 * rather than only the ones whose author remembered to pass
 * `canUseTool: createPiiRedactionGate()`. It runs first so every later stage —
 * and the tool itself — only ever sees placeholders. This is why the gate
 * implementation stays off the author surface: it is not something a plugin
 * opts into.
 *
 * Always returns a gate for that reason.
 */
function composeGate(
  runGate: PluginToolPermissionFn | undefined,
  tools: PluginAgentRunOptions["tools"],
  preToolUse: PluginToolPermissionFn | undefined
): PluginToolPermissionFn {
  const toolGates = new Map<string, PluginToolPermissionFn>()
  for (const tool of tools ?? []) {
    if (tool.canUseTool) toolGates.set(tool.name, tool.canUseTool)
  }
  const piiGate = createPiiRedactionGate()

  return async (toolName, input, ctx) => {
    let current = input
    for (const gate of [piiGate, toolGates.get(toolName), runGate, preToolUse]) {
      if (!gate) continue
      const r = await gate(toolName, current, ctx)
      if (r.behavior === "deny") return r
      if (r.updatedInput) current = r.updatedInput
    }
    return current === input ? { behavior: "allow" } : { behavior: "allow", updatedInput: current }
  }
}

/** Map a plugin-facing inline tool onto the executor's `AgentTool`. */
function toAgentTool(tool: NonNullable<PluginAgentRunOptions["tools"]>[number]): AgentTool {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
    ...(tool.schema ? { schema: tool.schema } : {}),
    execute: (input) => Promise.resolve(tool.execute(input)),
    ...(tool.canUseTool ? { canUseTool: tool.canUseTool } : {}),
  }
}

/**
 * Translate `PluginAgentRunOptions` → `ExecuteAgentConfig`, binding the
 * cancellation signal and composed gate. `onEvent` is supplied by the streaming
 * caller; the one-shot caller leaves it undefined.
 */
/**
 * Validate a plugin's capability grants and stamp the plugin as their source,
 * whatever each one claims. A malformed grant fails the run: running without a
 * denial the plugin asked for is the unsafe direction.
 */
export function acceptPluginGrants(
  grants: PluginAgentRunOptions["capabilityGrants"],
  pluginId: string | undefined
): AgentCapabilityGrantV1[] | undefined {
  if (!grants?.length) return undefined
  return grants.map((grant, index) => {
    const checked = validateAgentCapabilityGrant(grant)
    if (!checked.ok) {
      throw new Error(
        `Plugin agent run: capabilityGrants[${index}] is invalid: ${checked.errors.join("; ")}`
      )
    }
    return { ...checked.value, source: { kind: "plugin", ...(pluginId ? { id: pluginId } : {}) } }
  })
}

function toExecuteConfig(
  options: PluginAgentRunOptions,
  signal: AbortSignal,
  onEvent?: ExecuteAgentConfig["onEvent"],
  pluginId?: string
): ExecuteAgentConfig {
  const gate = composeGate(options.canUseTool, options.tools, options.hooks?.onPreToolUse)
  const capabilityGrants = acceptPluginGrants(options.capabilityGrants, pluginId)
  return {
    ...(options.system ? { systemPrompt: options.system } : {}),
    ...(options.appendSystem ? { appendSystem: options.appendSystem } : {}),
    ...(options.model ? { model: options.model } : {}),
    // `provider` is the per-run override both rails honour; `defaultProvider`
    // alone only fed the text rail's snapshot, so the tool rail ignored it.
    ...(options.provider ? { provider: options.provider, defaultProvider: options.provider } : {}),
    grantSource: { kind: "plugin", ...(pluginId ? { id: pluginId } : {}) },
    ...(capabilityGrants ? { capabilityGrants } : {}),
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools.map(toAgentTool) } : {}),
    ...(options.toolsEnabled !== undefined ? { toolsEnabled: options.toolsEnabled } : {}),
    ...(options.characterId ? { characterId: options.characterId } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.maxSteps !== undefined
      ? { maxSteps: options.maxSteps }
      : options.maxTurns !== undefined
        ? { maxSteps: options.maxTurns }
        : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    canUseTool: gate,
    ...(options.hooks?.onPostToolUse ? { onPostToolUse: options.hooks.onPostToolUse } : {}),
    abortSignal: signal,
    ...(onEvent ? { onEvent } : {}),
  }
}

/**
 * Fire the run's `onStop` hook (best-effort) with the final outcome. Called on
 * BOTH channels so a plugin always sees completion even when tools never ran.
 */
function fireStopHook(
  options: PluginAgentRunOptions,
  result: PluginAgentRunResult,
  signal: AbortSignal
): void {
  const onStop = options.hooks?.onStop
  if (!onStop) return
  try {
    void Promise.resolve(
      onStop(
        {
          text: result.text,
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          channel: result.channel,
        },
        { signal }
      )
    ).catch(() => undefined)
  } catch {
    /* onStop is best-effort */
  }
}

function newAgentId(meta?: RunPluginAgentMeta): string {
  return meta?.agentId && meta.agentId.length > 0 ? meta.agentId : crypto.randomUUID()
}

/**
 * Execute one turn through the unified authority (ADR-0090 Phase 6). Behind
 * the resolver flag the service resolves the frozen spec with surface
 * "plugin" and stamps runtime/routeKind/degradedReason onto the result;
 * otherwise the legacy executor path runs unchanged.
 */
async function executeThroughAuthority(
  prompt: string,
  cfg: ExecuteAgentConfig
): Promise<ExecuteAgentResult> {
  const { executeAgentTurnFromRenderer } =
    await import("@/lib/ai/agent/execution/agent-execution-service")
  return executeAgentTurnFromRenderer(prompt, cfg, { surface: "plugin" })
}

/**
 * Append the running plugin's context-provider contributions to `appendSystem`
 * (Package E). Returns the options unchanged when nothing is contributed.
 */
async function withContextContributions(
  prompt: string,
  options: PluginAgentRunOptions,
  pluginId: string | undefined
): Promise<PluginAgentRunOptions> {
  const contribution = await resolveContextContributions({ prompt }, pluginId)
  if (!contribution) return options
  const appendSystem = [options.appendSystem, contribution].filter(Boolean).join("\n\n")
  if (!hasNoLeakingPii(appendSystem)) {
    throw new Error("Plugin context contribution failed the outbound PII gate")
  }
  return { ...options, appendSystem }
}

/**
 * Execute a run with the Package F robustness wrappers: a per-run trace span
 * and an optional one-shot fallback-model retry. Fallback is disabled for the
 * streamed path (a retry would re-emit already-pushed events).
 */
function executeWithRobustness(
  prompt: string,
  opts: PluginAgentRunOptions,
  signal: AbortSignal,
  meta: { agentId: string; pluginId?: string },
  onEvent: ExecuteAgentConfig["onEvent"] | undefined,
  enableFallback: boolean
): Promise<ExecuteAgentResult> {
  if (
    !hasNoLeakingPiiDeep({
      prompt,
      system: opts.system,
      appendSystem: opts.appendSystem,
    })
  ) {
    throw new Error("Plugin agent input failed the outbound PII gate")
  }
  const runOnce = (model?: string): Promise<ExecuteAgentResult> => {
    const cfg = toExecuteConfig(model ? { ...opts, model } : opts, signal, onEvent, meta.pluginId)
    const traceModel = model ?? opts.model
    return withRunTrace(
      Boolean(opts.trace),
      {
        agentId: meta.agentId,
        ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
        ...(traceModel ? { model: traceModel } : {}),
      },
      prompt,
      () => executeThroughAuthority(prompt, cfg)
    )
  }
  if (!enableFallback || !opts.fallbackModel) return runOnce()
  const fallbackModel = opts.fallbackModel
  return runOnce().catch(() => runOnce(fallbackModel))
}

/**
 * Run `body` as a child run (ADR-0252 §3): `launchChildRun` writes, settles
 * and traces the run's `execution:job:<agentId>` row; `body` is its engine and
 * keeps its own result and thrown error. A plugin run has no parent run or
 * conversation, so the row stands alone. A stop before the run started (the
 * caller's signal, or a cancel from the Job Center) starts nothing.
 */
async function runAsChildRun<T>(
  agentId: string,
  meta: RunPluginAgentMeta,
  signal: AbortSignal,
  body: (runSignal: AbortSignal) => Promise<T>,
  /** Told the child's run id once its engine has started. */
  onLaunched?: (executionRunId: string) => void
): Promise<T> {
  const { launchChildRun } = await import("@/lib/execution/launch-child-run")
  let value: { result: T } | undefined
  let thrown: { error: unknown } | undefined
  const label = meta.label ?? agentId
  const launched = await launchChildRun({
    title: label,
    childId: agentId,
    surface: "plugin",
    signal,
    // A run-control stop cancels the Job Center entry, as its own Cancel
    // does; that abort reaches this run through `signal`.
    stop: () => {
      getBackgroundAgentManager().cancelAgent(agentId)
    },
    target: {
      kind: "agent",
      label,
      engine: {
        run: async (runSignal) => {
          try {
            value = { result: await body(runSignal) }
          } catch (error) {
            thrown = { error }
            throw error
          }
          return { status: "completed" }
        },
      },
    },
  })
  if (!launched.started) {
    if (launched.reason === "cancelled")
      throw signal.reason ?? new Error("Plugin agent run cancelled before it started")
    throw new Error(
      `Plugin agent run could not start (${launched.reason}${launched.detail ? `: ${launched.detail}` : ""})`
    )
  }
  onLaunched?.(launched.executionRunId)
  const settled = await launched.outcome
  if (thrown) throw thrown.error
  if (value) return value.result
  throw new Error(settled.error ?? "Plugin agent run ended without a result")
}

/** Run a single agent turn and resolve with the typed result. */
export async function runPluginAgent(
  prompt: string,
  options: PluginAgentRunOptions = {},
  meta: RunPluginAgentMeta = {}
): Promise<PluginAgentRunResult> {
  const manager = getBackgroundAgentManager()
  const agentId = newAgentId(meta)
  const managedSignal = manager.registerAgent(agentId, {
    kind: "plugin-agent",
    prompt,
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  try {
    const withId = await runAsChildRun(agentId, meta, signal, async (runSignal) => {
      await runInputGuardrails(prompt, options.guardrails, runSignal)
      const opts = await withContextContributions(prompt, options, meta.pluginId)
      const result = await executeWithRobustness(
        prompt,
        opts,
        runSignal,
        { agentId, ...(meta.pluginId ? { pluginId: meta.pluginId } : {}) },
        undefined,
        true
      )
      const withId = { ...result, agentId }
      await runOutputGuardrails(prompt, result.text, options.guardrails, runSignal)
      fireStopHook(options, withId, runSignal)
      return withId
    })
    // Settle with the real outcome so the journal row carries text/usage.
    manager.finishAgent(agentId, {
      text: withId.text,
      ...(withId.usage ? { usage: withId.usage } : {}),
    })
    return withId
  } catch (err) {
    manager.finishAgent(agentId, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    // Settle-once backstop for any path that slipped past the two above.
    manager.finishAgent(agentId)
  }
}

/**
 * Run an agent turn as a live async-iterable. Emits `text-delta` / `tool-call`
 * events, resolves `.result`, and `.cancel()` aborts the underlying run.
 */
export function runPluginAgentStreamed(
  prompt: string,
  options: PluginAgentRunOptions = {},
  meta: RunPluginAgentMeta = {}
): PluginAgentRun {
  const manager = getBackgroundAgentManager()
  const agentId = newAgentId(meta)
  const managedSignal = manager.registerAgent(agentId, {
    kind: "plugin-agent",
    prompt,
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  // Once launched, the stream's cancel is the one tree stop: this run and
  // every run under it. Before that, the manager's cancel aborts it at once,
  // so nothing starts.
  let launchedRunId: string | undefined
  const controller = createPluginAgentRun(agentId, () => {
    const runId = launchedRunId
    if (!runId || !hasRunStop(runId)) {
      manager.cancelAgent(agentId)
      return
    }
    void import("@/lib/execution/run-control")
      .then(({ stopRunTree }) => stopRunTree(runId))
      .catch(() => manager.cancelAgent(agentId))
  })

  void (async () => {
    try {
      const withId = await runAsChildRun(
        agentId,
        meta,
        signal,
        async (runSignal) => {
          await runInputGuardrails(prompt, options.guardrails, runSignal)
          const opts = await withContextContributions(prompt, options, meta.pluginId)
          const result = await executeWithRobustness(
            prompt,
            opts,
            runSignal,
            { agentId, ...(meta.pluginId ? { pluginId: meta.pluginId } : {}) },
            (event) => {
              // The plugin agent stream surfaces only text/tool events — capture-only
              // events (thinking-delta, usage, compact) have no PluginAgentStreamEvent
              // counterpart, so they're dropped here.
              if (
                event.type === "text-delta" ||
                event.type === "tool-call" ||
                event.type === "tool-result"
              ) {
                controller.push(event)
              }
            },
            false
          )
          const withId = { ...result, agentId }
          await runOutputGuardrails(prompt, result.text, options.guardrails, runSignal)
          fireStopHook(options, withId, runSignal)
          return withId
        },
        (executionRunId) => {
          launchedRunId = executionRunId
        }
      )
      manager.finishAgent(agentId, {
        text: withId.text,
        ...(withId.usage ? { usage: withId.usage } : {}),
      })
      controller.close(withId)
    } catch (err) {
      manager.finishAgent(agentId, { error: err instanceof Error ? err.message : String(err) })
      controller.fail(err)
    } finally {
      manager.finishAgent(agentId)
    }
  })()

  return controller.run
}
