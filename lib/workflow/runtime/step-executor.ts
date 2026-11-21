import { runPersonalEgressOperation } from "@/lib/execution/personal-egress"
/**
 * Step executor — runs one node, with retries, timeout, and idempotency.
 * The orchestrator owns the queue + edge logic; this module owns "given a
 * resolved context, run the executor and persist the result".
 */

import type {
  StepExecutionContext,
  TriggerEvent,
  VisualWorkflow,
  WorkflowNode,
  WorkflowRetryPolicy,
  WorkflowRunLineage,
  WorkflowRunSecurityContext,
} from "@/types/workflow/visual"
import { nanoid } from "nanoid"
import type { WorkflowExecutionBinding } from "@/types/workflow/deployment"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { loadModuleWorkflowNodes } from "@/lib/workflow/nodes/module-nodes"
import { retiredNodeKind } from "@/lib/workflow/nodes/retired-kinds"
import { resolveDeep } from "./expression"
import { IdempotencyCache } from "./idempotency"
import type { RunLogger, StepEventMeta } from "./event-log"
import { describeStepError, recordStepInputs } from "./step-event-payload"
import type { SecretResolver } from "./secret-resolver"
import { createStreamSink } from "./stream-sink"
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from "./circuit-breaker"
import { validateNodeParams } from "@/lib/workflow/nodes/validate-params"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"

export interface RunStepInput {
  workflow: VisualWorkflow
  node: WorkflowNode
  trigger: TriggerEvent
  upstream: Record<string, unknown>
  runId: string
  signal: AbortSignal
  cache: IdempotencyCache
  retryPolicy: WorkflowRetryPolicy
  secretResolver: SecretResolver
  logger: RunLogger
  /**
   * When true AND the workflow has `pinData` for this node, the executor is
   * NOT invoked — the pinned value is returned as the step output (and recorded
   * in the event log like a real step). Set only for editor manual runs; never
   * for production triggers. Mirrors n8n's pin-data semantics.
   */
  honorPinData?: boolean
  /** Run-scoped agent-trace id, threaded onto the step context for AI-node spans. */
  traceId?: string
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /** Owning workspace, so executors can resolve a directory without a UI store. */
  projectId?: string
  /** Formal-run provenance inherited by every node executor. */
  executionBinding?: WorkflowExecutionBinding
  /**
   * Extra expression idents merged over `upstream` for this step only — the
   * loop container injects `$item` / `$loop` here (see the ident fallback in
   * `expression.ts#evalToken`). Visible both to `resolveDeep` and to the
   * executor's `ctx.upstream`.
   */
  extraUpstream?: Record<string, unknown>
  /**
   * Run-shared mutable state exposed as `{{ $static.* }}`. The loop container
   * threads its accumulator object here; top-level steps default to `{}`.
   */
  staticData?: Record<string, unknown>
  /**
   * Idempotency key override. Loop iterations pass
   * `iterationCacheKey(loopId, i, node.id)` so each iteration memoizes
   * independently; defaults to `node.id`.
   */
  cacheKey?: string
  /** Iteration provenance stamped onto step start/complete event payloads. */
  iterationMeta?: { loopId: string; iterationIndex: number }
  /**
   * Outputs of every node completed so far in this run — the
   * `{{ $nodes['id'] }}` global expression scope. Direct predecessors remain
   * the `upstream` map (`$node[...]`); this is the best-effort superset for
   * non-adjacent reads. Optional so isolated callers stay unchanged.
   */
  nodesOutputs?: Record<string, unknown>
}

export interface StepExecution {
  /** Step output (cache-hit or fresh). */
  output: unknown
  /** Branch/switch decision; orchestrator uses to skip non-chosen edges. */
  decision?: string | string[]
  /**
   * Routing of a handled failure replayed from the cache (`"error"` = only the
   * error edges, `"halt"` = no outgoing edge). Fresh executions never set it:
   * a fresh failure throws, and its handler records the route itself.
   */
  route?: "error" | "halt"
  /** True iff this step came from the idempotency cache (no executor invoked). */
  fromCache: boolean
}

/**
 * How long a timed-out attempt may take to honour its abort before the step
 * counts as having an unknown outcome. Until the executor has actually
 * stopped, starting the next attempt would run the same node twice at once.
 */
let stopConfirmGraceMs = 5_000

/** Test-only: shorten the stop-confirmation grace period. */
export function __setStopConfirmGraceMsForTesting(ms: number | null): void {
  stopConfirmGraceMs = ms ?? 5_000
}

/**
 * A timed-out attempt that would not stop. Its executor may still complete a
 * side effect, so the step must not be retried automatically: the error is
 * non-retryable and names the condition for the run history.
 */
export class StepOutcomeUnknownError extends Error {
  readonly code = "step_outcome_unknown" as const
  readonly retryable = false

  constructor(node: WorkflowNode, cause: unknown, graceMs: number) {
    super(
      `Step ${node.id} (${node.type}) did not stop within ${graceMs}ms of its timeout, so its ` +
        `outcome is unknown and it was not retried: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = "StepOutcomeUnknownError"
  }
}

function settlesWithin(settled: Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(false), ms)
    signal.addEventListener("abort", onAbort, { once: true })
    void settled.then(() => finish(true))
  })
}

export class InvalidNodeParamsError extends Error {
  readonly code = "invalid-node-params" as const
  readonly retryable = false

  constructor(node: WorkflowNode, errors: readonly string[]) {
    super(
      `Invalid params for node ${node.id} (${node.type}@${node.typeVersion}): ${errors.join("; ")}`
    )
    this.name = "InvalidNodeParamsError"
  }
}

/**
 * Run a single step, returning its output. Memoized by `(runId, stepId)`
 * via the IdempotencyCache. Retries respect the per-workflow retry policy
 * unless the executor returned a non-retryable error.
 */
/**
 * Effective retry policy for one step: the node's own
 * `data.errorHandling.retry` (n8n-style per-node setting; maxRetries = extra
 * attempts after the first) wins over the workflow-level `retryDefaults`.
 */
export function resolveStepRetryPolicy(
  node: WorkflowNode,
  workflowDefault: WorkflowRetryPolicy
): WorkflowRetryPolicy {
  const nodeRetry = node.data.errorHandling?.retry
  if (!nodeRetry) return workflowDefault
  return {
    attempts: Math.max(1, nodeRetry.maxRetries + 1),
    backoff: nodeRetry.backoff,
    baseMs: Math.max(0, nodeRetry.retryIntervalMs),
    ...(typeof nodeRetry.maxIntervalMs === "number" ? { maxMs: nodeRetry.maxIntervalMs } : {}),
  }
}

const OPAQUE_WORKFLOW_NODES = new Set([
  "io.http",
  "action.site.deploy",
  "action.site.rollback",
  "ocr.extract",
  "knowledge.source",
  "knowledge.embed",
  "knowledge.index",
  "knowledge.retrieve",
  "action.twin.ingest",
  "action.image.info",
  "action.image.transform",
  "action.image.adjust",
  "action.image.convert",
  "action.media.generateVideo",
  "action.terminal.script",
  "action.system.terminal",
  "action.terminal.session.open",
  "action.terminal.session.run",
])

export async function executeWorkflowEgress<T>(
  ctx: StepExecutionContext,
  processUnproven: boolean,
  execute: (ctx: StepExecutionContext) => Promise<T>
): Promise<T> {
  return runPersonalEgressOperation(
    { executionRunId: `execution:workflow:${ctx.runId}` },
    () => execute(ctx),
    processUnproven
  )
}

/**
 * Execution identity of the attempt a thrown step error came from, so a caller
 * that turns the failure into a handled output (`step_completed` after
 * `step_failed`) can attribute it to that same execution instance.
 */
const failedExecutionMeta = new WeakMap<object, StepEventMeta>()

export function stepExecutionMetaOf(err: unknown): StepEventMeta | undefined {
  return err !== null && typeof err === "object" ? failedExecutionMeta.get(err) : undefined
}

function newStepExecutionId(): string {
  return `wf-step_${nanoid()}`
}

export async function runStep(input: RunStepInput): Promise<StepExecution> {
  const { node, runId, cache, signal, logger } = input
  /**
   * Record a failure that happened before any attempt started (no executor,
   * invalid params, open breaker, aborted). It is still its own execution
   * instance, so the inspector can show it without mixing it into an attempt.
   */
  const failBeforeExecution = async (err: Error): Promise<Error> => {
    const meta: StepEventMeta = { ...input.iterationMeta, stepExecutionId: newStepExecutionId() }
    await logger.stepFailed(node.id, { ...describeStepError(err), retryable: false }, meta)
    failedExecutionMeta.set(err, meta)
    return err
  }
  const retryPolicy = resolveStepRetryPolicy(node, input.retryPolicy)
  const cacheKey = input.cacheKey ?? node.id

  if (cache.has(cacheKey)) {
    const routing = cache.routing(cacheKey)
    return {
      output: cache.get(cacheKey),
      ...(routing?.decision !== undefined ? { decision: routing.decision } : {}),
      ...(routing?.route !== undefined ? { route: routing.route } : {}),
      fromCache: true,
    }
  }
  // The memo key rides on the completion only when it is not the bare node id
  // (loop bodies, nested loops), so hydration can rebuild exactly this key.
  const stepKey = cache.keyFor(cacheKey)
  const replayKey = stepKey !== node.id ? { cacheKey: stepKey } : {}

  // Pin-data short-circuit (editor manual runs only). The pinned value stands
  // in for the executor's output so downstream nodes + the data view see it,
  // and the run timeline records a normal started/completed pair.
  if (
    input.honorPinData &&
    input.workflow.pinData &&
    Object.prototype.hasOwnProperty.call(input.workflow.pinData, node.id)
  ) {
    const pinned = input.workflow.pinData[node.id]
    const meta: StepEventMeta = { ...input.iterationMeta, stepExecutionId: newStepExecutionId() }
    await logger.stepStarted(node.id, { pinned: true }, meta)
    cache.set(cacheKey, pinned)
    await logger.stepCompleted(node.id, pinned, meta, replayKey)
    return { output: pinned, fromCache: false }
  }

  // Feature modules contribute their node families lazily (ADR-0250 §14
  // `workflowNodes`); they are registered before any lookup.
  await loadModuleWorkflowNodes()
  const reg = getExecutor(node.type, node.typeVersion)
  if (!reg) {
    // A retired kind cannot be fixed by installing a plugin from this app, so
    // it must not be reported as if it could. The editor's `kindRetired`
    // diagnostic blocks the run before it starts; this covers the paths that
    // do not go through the editor — scheduled runs, API-triggered runs, and
    // a workflow whose provider was unregistered mid-run.
    const retired = retiredNodeKind(node.type)
    const err = new Error(
      retired
        ? `Node kind ${node.type} was removed in ${retired.removedIn} and has no executor. ` +
            `Re-author this step, or install the compatibility plugin that provides it.`
        : `No executor registered for ${node.type}@${node.typeVersion}. ` +
            `Install the plugin that provides it, or change the node type.`
    )
    throw await failBeforeExecution(err)
  }

  // Resolve params with expression substitution before passing to the executor.
  // `extraUpstream` rides on top of the real upstream map so loop-injected
  // idents (`$item` / `$loop`) resolve through evalToken's ident fallback.
  const upstream = input.extraUpstream
    ? { ...input.upstream, ...input.extraUpstream }
    : input.upstream
  const resolvedParams = resolveDeep(node.data.params, {
    upstream,
    trigger: input.trigger,
    staticData: input.staticData ?? {},
    params: node.data.params as Record<string, unknown>,
    variables: input.workflow.variables ?? {},
    ...(input.nodesOutputs ? { nodes: input.nodesOutputs } : {}),
  })
  const resolvedParamRecord =
    resolvedParams && typeof resolvedParams === "object" && !Array.isArray(resolvedParams)
      ? (resolvedParams as Record<string, unknown>)
      : {}
  // Built-in Zod schemas describe the authored inspector payload. Validate
  // that payload before expression substitution: a valid expression string
  // may resolve to a boolean, number, object, or array that intentionally no
  // longer matches the editor field's source type. Plugin JSON Schemas, by
  // contrast, are execution contracts and therefore validate resolved input.
  const paramErrors = validateNodeParams(node.type, node.data.params).summary
  const pluginParamsSchema = nodeCatalogEntry(node.type).paramsSchema
  if (pluginParamsSchema) {
    const pluginValidation = validateAgainstJsonSchema(pluginParamsSchema, resolvedParamRecord)
    if (!pluginValidation.ok) paramErrors.push(...pluginValidation.errors)
  }
  if (paramErrors.length > 0) {
    throw await failBeforeExecution(new InvalidNodeParamsError(node, paramErrors))
  }
  const recordedInputs = recordStepInputs(resolvedParamRecord)

  const ctx: StepExecutionContext = {
    runId,
    workflowId: input.workflow.id,
    stepId: node.id,
    ...(stepKey !== node.id ? { stepKey } : {}),
    ...(input.iterationMeta ? { iteration: input.iterationMeta } : {}),
    ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}),
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(input.securityContext ? { securityContext: input.securityContext } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    params: resolvedParamRecord,
    // Credential bindings live on the node's `data`, so `params` alone never
    // carries them; hand them over explicitly or every keyring-backed ref
    // resolves to nothing at run time.
    ...(node.data.credentialRefs ? { credentialRefs: node.data.credentialRefs } : {}),
    upstream,
    trigger: input.trigger,
    signal,
    log: (level, message, payload) => void logger.log(level, message, payload, node.id),
    resolveSecret: (refId) => input.secretResolver.resolve(refId),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  }

  if (reg.pluginId && input.executionBinding?.dependencyLock?.plugins) {
    const [{ getPlugin }, { assertWorkflowPluginDependencyLock, WorkflowPluginLockError }] =
      await Promise.all([
        import("@/lib/db/plugins"),
        import("@/lib/workflow/runtime/plugin-dependency-lock"),
      ])
    const plugin = await getPlugin(reg.pluginId)
    if (!plugin) {
      throw new WorkflowPluginLockError(
        "plugin-not-locked",
        `Plugin executor ${reg.pluginId} is unavailable for this immutable workflow release.`
      )
    }
    assertWorkflowPluginDependencyLock(input.executionBinding, plugin)
  }

  // Circuit breaker (A4): if this node has tripped its breaker, fail fast
  // BEFORE consuming an attempt. The CircuitOpenError is non-retryable, so it
  // flows straight through the orchestrator's onError / error-edge path.
  const breaker = node.data.errorHandling?.circuitBreaker
  if (breaker) {
    try {
      assertCircuitClosed(input.workflow.id, node.id)
    } catch (err) {
      throw await failBeforeExecution(err instanceof Error ? err : new Error(String(err)))
    }
  }

  let attempt = 0

  while (true) {
    attempt += 1
    if (signal.aborted) {
      throw await failBeforeExecution(new Error("Workflow run aborted"))
    }

    const stepExecutionId = newStepExecutionId()
    const executionMeta: StepEventMeta = { ...input.iterationMeta, stepExecutionId, attempt }
    await logger.stepStarted(node.id, recordedInputs, executionMeta)
    // Fresh sink per attempt so a failed attempt's partial stream never
    // interleaves with the retry's output. The sink throttles `step_stream`
    // writes; commentary uses an independent channel so it cannot be folded
    // into final output. Usage lands as one `step_usage` event.
    const sink = createStreamSink({
      stepId: node.id,
      logger: {
        stepStream: (stepId, delta, seq) => logger.stepStream(stepId, delta, seq, executionMeta),
      },
    })
    const commentarySink = createStreamSink({
      stepId: node.id,
      logger: {
        stepStream: (stepId, delta, seq) =>
          logger.stepCommentary(stepId, delta, seq, executionMeta),
      },
    })
    ctx.emitStream = (delta) => sink.push(delta)
    ctx.emitCommentary = (delta) => commentarySink.push(delta)
    ctx.reportUsage = (usage) =>
      void logger.stepUsage(node.id, { ...usage, stepExecutionId }, executionMeta)
    let executionSettled = false
    let markSettled!: () => void
    const attemptSettled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    try {
      const result = await runWithTimeout(
        reg.timeoutMs ?? input.workflow.settings.timeoutMs,
        signal,
        async (attemptSignal) => {
          try {
            const attemptContext: StepExecutionContext = {
              ...ctx,
              signal: attemptSignal,
              log: (level, message, payload) =>
                void logger.log(level, message, payload, node.id, executionMeta),
            }
            return OPAQUE_WORKFLOW_NODES.has(node.type)
              ? await executeWorkflowEgress(
                  attemptContext,
                  node.type.startsWith("action.terminal.") ||
                    node.type === "action.system.terminal",
                  reg.execute
                )
              : await reg.execute(attemptContext)
          } finally {
            executionSettled = true
            markSettled()
          }
        }
      )
      sink.final()
      commentarySink.final()
      const exec: StepExecution = {
        output: result.output,
        decision: result.decision,
        fromCache: false,
      }
      // Forward any executor-supplied logs into the durable event log
      // BEFORE the step_completed marker so timeline order is correct.
      if (result.logs?.length) {
        for (const l of result.logs) {
          await logger.log(l.level, l.message, l.payload, node.id, executionMeta)
        }
      }
      cache.set(cacheKey, result.output, { decision: result.decision })
      if (breaker) recordCircuitSuccess(input.workflow.id, node.id)
      // The decision is written WITH the output: a resume that replays this
      // step must route exactly as this execution did.
      await logger.stepCompleted(node.id, result.output, executionMeta, {
        ...replayKey,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
      })
      return exec
    } catch (caught) {
      let err = caught
      sink.final()
      commentarySink.final()
      // A timeout rejects as soon as the deadline passes, but an executor that
      // ignores its abort signal is still running. Retrying now would overlap
      // two executions of the same node, so a retry waits for this attempt to
      // actually stop, and gives up retrying when it does not.
      if (
        !executionSettled &&
        !signal.aborted &&
        attempt < retryPolicy.attempts &&
        reg.retryable !== false &&
        isRetryableError(err)
      ) {
        executionSettled = await settlesWithin(attemptSettled, stopConfirmGraceMs, signal)
        if (!executionSettled) err = new StepOutcomeUnknownError(node, err, stopConfirmGraceMs)
      }
      if (node.type === "action.team.task.dispatch") {
        try {
          const { loadTeamWorkflowNodes } =
            await import("@/lib/workflow/nodes/teams/team-runtime-port")
          const team = await loadTeamWorkflowNodes(node.type)
          if (!team.assertDispatchRetry) throw new Error("stop_unconfirmed")
          await team.assertDispatchRetry(ctx, executionSettled)
          if (!executionSettled) throw new Error("stop_unconfirmed")
        } catch (refusal) {
          err = Object.assign(new Error("stop_unconfirmed", { cause: refusal }), {
            name: "NeedsHumanError",
            retryable: false,
            needsHuman: true,
          })
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      const retryable = reg.retryable !== false && isRetryableError(err)
      const lastAttempt = attempt >= retryPolicy.attempts
      // The durable log gets the redacted, bounded detail; the thrown error
      // keeps its original message for the caller.
      const detail = describeStepError(err)
      await logger.stepFailed(node.id, { ...detail, retryable }, executionMeta)

      if (!retryable || lastAttempt) {
        // Terminal failure for this node — feed the breaker so a repeatedly
        // failing node eventually trips and fail-fasts on the next run.
        if (breaker) recordCircuitFailure(input.workflow.id, node.id, breaker)
        const thrown = err instanceof Error ? err : new Error(message)
        failedExecutionMeta.set(thrown, executionMeta)
        throw thrown
      }

      const delay = computeBackoffMs(retryPolicy, attempt)
      await logger.stepRetrying(
        node.id,
        {
          attempt,
          maxAttempts: retryPolicy.attempts,
          delayMs: delay,
          error: detail.message,
        },
        executionMeta
      )
      await logger.log(
        "warn",
        `step ${node.id} failed (attempt ${attempt}/${retryPolicy.attempts}); retrying in ${delay}ms`,
        { error: detail.message },
        node.id,
        executionMeta
      )
      await wait(delay, signal)
    }
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const tagged = (err as Error & { retryable?: boolean }).retryable
    if (typeof tagged === "boolean") return tagged
    // Aborts are never retryable.
    if (err.name === "AbortError") return false
  }
  // Conservative default: retry once. If the error class flagged itself
  // non-retryable above, that wins.
  return true
}

function computeBackoffMs(policy: WorkflowRetryPolicy, attempt: number): number {
  const base = Math.max(0, policy.baseMs)
  if (policy.backoff === "fixed") return base
  // Exponential — `attempt` is 1-indexed; first retry waits `base`, next
  // `base * 2`, etc.
  const raw = base * Math.pow(2, attempt - 1)
  if (typeof policy.maxMs === "number") return Math.min(raw, policy.maxMs)
  return raw
}

async function runWithTimeout<T>(
  timeoutMs: number,
  outer: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      outer.removeEventListener("abort", onAbort)
    }
    const settle = (outcome: { value: T } | { error: unknown }) => {
      if (settled) return
      settled = true
      cleanup()
      if ("value" in outcome) resolve(outcome.value)
      else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)))
    }
    const onAbort = () => {
      const err = new Error("Workflow run aborted")
      err.name = "AbortError"
      ac.abort(err)
      settle({ error: err })
    }

    if (outer.aborted) {
      onAbort()
      return
    }
    outer.addEventListener("abort", onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`Step exceeded timeout (${timeoutMs}ms)`)
        err.name = "TimeoutError"
        ac.abort(err)
        settle({ error: err })
      }, timeoutMs)
    }
    Promise.resolve()
      .then(() => fn(ac.signal))
      .then(
        (value) => settle({ value }),
        (error) => settle({ error })
      )
  })
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Workflow run aborted"))
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error("Workflow run aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
