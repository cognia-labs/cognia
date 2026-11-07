/**
 * `launchChildRun`: the one way to start a child run (ADR-0252 §3).
 *
 * Every asynchronous child of a run is one `executionRuns` row linked to its
 * parent by `parentRunId`. The launcher writes that row, links it, starts the
 * engine, settles the row from the engine's outcome and records how long the
 * dispatch took. Callers keep only their own policy (a Squad delegation's
 * approval, depth and cycle checks run as guards before this).
 *
 * Four targets, two kinds of engine:
 *
 *   agent      `executeAgent` (kernel), a `job` row written here.
 *   external   `ExternalAgentManager.execute` (kernel), placed on an always-on
 *              Host first (ADR-0224 A8), a `job` row written here.
 *   twin       the `twin-answer` port, a `job` row written here.
 *   squad      the `squad-launch` port. A Squad run writes its own `team` row
 *              in the transaction that writes its durable record, so the
 *              launcher hands it the parent instead of writing a row first.
 *
 * Order: the row is written, and only then is the engine started or the run
 * registered with the background-agent manager. That registration writes a
 * `backgroundTasks` row which `job-bridge.ts` projects onto the same id; with
 * the row already there, the projection finds it and leaves the parent link
 * alone.
 *
 * Capability grants (ADR-0198) customise the run. Each engine says which grant
 * fields it applies. A grant that sets a field the engine would ignore is
 * refused before anything is written: a grant that quietly does nothing is a
 * widening the caller did not see.
 *
 * Nothing here carries the prompt or the answer into the journal or the span.
 * The text and the error are handed back to the caller in the outcome.
 */

import { emitFinishedSpan } from "@cognia/agent-trace/emitter"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type { SpanSurface } from "@/types/agent-trace/span"
import type { ChildRunOutcome, StartedChildEngine } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import type { BackgroundAgentKind } from "@/lib/ai/agent/background-agent-manager"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { loadPort } from "@/lib/modules/ports"
import { finishToolExecutionRun, startToolExecutionRun } from "./acting-authority"

/** Registers the child in the Job Center, where a person can see and cancel it. */
export interface ChildRunBackgroundRegistration {
  /** The Job Center's label for the run. An id or a fixed phrase, never free text. */
  label: string
  kind: BackgroundAgentKind
}

export type ChildRunTarget =
  | {
      kind: "agent"
      prompt: string
      systemPrompt?: string
      background?: ChildRunBackgroundRegistration
    }
  | {
      kind: "external"
      /** The external agent's id (`claude-code`, `codex`, …). */
      agentId: string
      prompt: string
      systemPrompt?: string
      workingDirectory?: string
      /** The engine's own deadline. Defaults to ten minutes. */
      timeoutMs?: number
    }
  | {
      kind: "twin"
      twinId: string
      question: string
      systemPrompt?: string
      background?: ChildRunBackgroundRegistration
    }
  | {
      kind: "squad"
      squadId: string
      brief: string
      /** Gate-policy origin (`"delegation"`, `"room"`, …). */
      origin: string
      ultracode?: boolean
    }

export type ChildRunTargetKind = ChildRunTarget["kind"]

export interface LaunchChildRunInput {
  /** The run this one is a child of. */
  parentRunId?: string
  /**
   * The delegation the child does work for (`execution:delegation:<id>`).
   * When set it is the parent: a delegation's attempts are its children.
   */
  delegationRunId?: string
  target: ChildRunTarget
  grants?: readonly AgentCapabilityGrantV1[]
  /** The conversation the child belongs to. Defaults to the parent's. */
  sessionId?: string
  /** The row's title. An id or a fixed phrase, never the prompt. */
  title: string
  /** The child's own id. Defaults to a fresh one; a Squad run mints its own. */
  childId?: string
  /** Where the dispatch span is reported. */
  surface?: SpanSurface
  /** Stops the child. Before the engine starts, nothing starts. */
  signal?: AbortSignal
}

export type LaunchChildRunRefusal =
  /** The named parent has no row. A child is never linked to nothing. */
  | "parent_not_found"
  /** A grant sets a field this target's engine does not apply. */
  | "grant_not_honoured"
  /** No module provides the target's engine on this host. */
  | "engine_unavailable"
  /** The engine refused to start. See `detail`. */
  | "engine_refused"
  /** The child's row could not be written. Nothing was started. */
  | "journal_failed"
  /** The signal was aborted before anything was written. */
  | "cancelled"

export type LaunchChildRunResult =
  | {
      started: true
      childId: string
      executionRunId: string
      /** Settles once the engine is done and the row is settled. Never rejects. */
      outcome: Promise<ChildRunOutcome>
    }
  | { started: false; reason: LaunchChildRunRefusal; detail?: string }

const DEFAULT_EXTERNAL_TIMEOUT_MS = 600_000

/** The row id of a child the launcher writes itself. */
export function childJobExecutionRunId(childId: string): string {
  return `execution:job:${childId}`
}

type GrantField = Exclude<keyof AgentCapabilityGrantV1, "schemaVersion" | "source">

/** The grant fields a grant actually sets. */
export function grantFieldsSet(grant: AgentCapabilityGrantV1): GrantField[] {
  return (Object.keys(grant) as (keyof AgentCapabilityGrantV1)[]).filter(
    (key): key is GrantField =>
      key !== "schemaVersion" && key !== "source" && grant[key] !== undefined
  )
}

/**
 * What each engine applies. `executeAgent` resolves grants through
 * `resolveSendOptions` like any other run, and a twin answers through it. An
 * external agent runs its own harness, and a Squad run is governed by its own
 * team configuration and frozen execution constraints, so neither applies any.
 */
const HONOURED_GRANT_FIELDS: Record<ChildRunTargetKind, "all" | readonly GrantField[]> = {
  agent: "all",
  twin: "all",
  external: [],
  squad: [],
}

function unhonouredGrantFields(
  kind: ChildRunTargetKind,
  grants: readonly AgentCapabilityGrantV1[]
): GrantField[] {
  const honoured = HONOURED_GRANT_FIELDS[kind]
  if (honoured === "all") return []
  const set = new Set(grants.flatMap(grantFieldsSet))
  return [...set].filter((field) => !honoured.includes(field))
}

const SPAN_PROVIDER: Record<ChildRunTargetKind, string> = {
  agent: "cognia.subagent",
  external: "cognia.external",
  twin: "cognia.twin",
  squad: "cognia.team",
}

function targetRef(target: ChildRunTarget): string {
  switch (target.kind) {
    case "agent":
      return target.background?.label ?? "agent"
    case "external":
      return target.agentId
    case "twin":
      return target.twinId
    case "squad":
      return target.squadId
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `agent` engine: one `executeAgent` run. A stop aborts it; whatever the
 * run returns or throws after a stop settles as `cancelled`. The twin port
 * answers through this engine too.
 */
export function startAgentEngine(input: {
  prompt: string
  systemPrompt?: string
  grants?: readonly AgentCapabilityGrantV1[]
}): StartedChildEngine {
  const controller = new AbortController()
  const outcome = (async (): Promise<ChildRunOutcome> => {
    try {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      if (controller.signal.aborted) return { status: "cancelled", error: "Cancelled." }
      const result = await executeAgent(input.prompt, {
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        abortSignal: controller.signal,
        ...(input.grants && input.grants.length > 0 ? { capabilityGrants: input.grants } : {}),
      })
      return controller.signal.aborted
        ? { status: "cancelled", text: result.text }
        : { status: "completed", text: result.text }
    } catch (error) {
      return controller.signal.aborted
        ? { status: "cancelled", error: errorText(error) }
        : { status: "failed", error: errorText(error) }
    }
  })()
  return { outcome, stop: (reason) => controller.abort(new Error(reason ?? "stopped")) }
}

/**
 * The `external` engine: place the agent, then one `execute` behind the
 * engine's deadline. The same signal carries a stop and the deadline, because
 * that signal is what makes the manager cancel the agent's session.
 */
function startExternalEngine(
  target: Extract<ChildRunTarget, { kind: "external" }>
): StartedChildEngine {
  const controller = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort(new Error("external agent timed out"))
  }, target.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS)
  const stopped = () => controller.signal.aborted && !timedOut
  const outcome = (async (): Promise<ChildRunOutcome> => {
    try {
      const [{ getExternalAgentManager }, { placeDispatchedAgent }] = await Promise.all([
        import("@/lib/ai/agent/external/manager"),
        import("@/lib/sandbox/host-agent-placement"),
      ])
      // An always-on Host starts the agent in its project's runtime
      // environment (ADR-0224 A8); a refusal fails the child.
      await placeDispatchedAgent(target.agentId, target.workingDirectory, getExternalAgentManager())
      if (stopped()) return { status: "cancelled", error: "Cancelled." }
      const result = await getExternalAgentManager().execute(target.agentId, target.prompt, {
        ...(target.systemPrompt ? { systemPrompt: target.systemPrompt } : {}),
        ...(target.workingDirectory ? { workingDirectory: target.workingDirectory } : {}),
        signal: controller.signal,
      })
      if (stopped()) return { status: "cancelled", error: "Cancelled." }
      if (!result.success) {
        return {
          status: "failed",
          error: result.error || `external agent ${target.agentId} returned a failure`,
          ...(timedOut ? { timedOut: true } : {}),
        }
      }
      return { status: "completed", text: result.finalResponse ?? "" }
    } catch (error) {
      if (stopped()) return { status: "cancelled", error: errorText(error) }
      return { status: "failed", error: errorText(error), ...(timedOut ? { timedOut: true } : {}) }
    } finally {
      clearTimeout(deadline)
    }
  })()
  return { outcome, stop: (reason) => controller.abort(new Error(reason ?? "stopped")) }
}

async function startJobEngine(
  target: Exclude<ChildRunTarget, { kind: "squad" }>,
  grants: readonly AgentCapabilityGrantV1[]
): Promise<StartedChildEngine | { refused: LaunchChildRunRefusal; detail?: string }> {
  switch (target.kind) {
    case "agent":
      return startAgentEngine({
        prompt: target.prompt,
        ...(target.systemPrompt ? { systemPrompt: target.systemPrompt } : {}),
        grants,
      })
    case "external":
      return startExternalEngine(target)
    case "twin": {
      const port = await loadPort("twin-answer")
      if (!port) return { refused: "engine_unavailable", detail: "twin-answer" }
      return port.start({
        twinId: target.twinId,
        question: target.question,
        ...(target.systemPrompt ? { systemPrompt: target.systemPrompt } : {}),
        grants,
      })
    }
  }
}

function settledEngine(outcome: ChildRunOutcome): StartedChildEngine {
  return { outcome: Promise.resolve(outcome), stop: () => undefined }
}

/** Ties a stop signal to an engine that has started. */
function onAbort(signal: AbortSignal | undefined, stop: (reason: string) => void): () => void {
  if (!signal) return () => undefined
  const listener = () => stop(errorText(signal.reason ?? "stopped"))
  if (signal.aborted) {
    listener()
    return () => undefined
  }
  signal.addEventListener("abort", listener, { once: true })
  return () => signal.removeEventListener("abort", listener)
}

function emitDispatchSpan(input: {
  target: ChildRunTarget
  executionRunId: string
  parent: ExecutionRun | undefined
  delegationRunId?: string
  sessionId?: string
  surface: SpanSurface
  launchedAt: number
  startedAt: number
  settledAt: number
  outcome: ChildRunOutcome
}): void {
  const failed = input.outcome.status === "failed"
  emitFinishedSpan({
    // A child without a conversation still has a run to file the span under.
    sessionId: input.sessionId ?? input.executionRunId,
    runId: input.executionRunId,
    operationName: "invoke_agent",
    providerName: SPAN_PROVIDER[input.target.kind],
    surface: input.surface,
    agentId: targetRef(input.target),
    startTime: input.launchedAt,
    endTime: input.settledAt,
    status: failed ? "error" : "ok",
    // Codes only. The error text is the caller's, like the answer.
    ...(failed ? { errorType: input.outcome.timedOut ? "timeout" : "child_failed" } : {}),
    ...(input.parent
      ? { handoff: { fromAgent: input.parent.id, toAgent: input.executionRunId } }
      : {}),
    events: [
      {
        name: "child.dispatch",
        at: input.startedAt,
        attributes: {
          targetKind: input.target.kind,
          latencyMs: Math.max(0, input.startedAt - input.launchedAt),
        },
      },
    ],
    metadata: {
      role: "child-run",
      targetKind: input.target.kind,
      outcome: input.outcome.status,
      ...(input.parent ? { parentRunId: input.parent.id } : {}),
      ...(input.delegationRunId ? { delegationRunId: input.delegationRunId } : {}),
    },
  })
}

/**
 * Start a child run. Resolves once the child's row exists and its engine has
 * started, or with a refusal when nothing was started. The outcome settles
 * later and never rejects: an engine that throws is a `failed` outcome.
 */
export async function launchChildRun(input: LaunchChildRunInput): Promise<LaunchChildRunResult> {
  const launchedAt = Date.now()
  const grants = input.grants ?? []
  const unhonoured = unhonouredGrantFields(input.target.kind, grants)
  if (unhonoured.length > 0) {
    return { started: false, reason: "grant_not_honoured", detail: unhonoured.join(",") }
  }
  if (input.signal?.aborted) return { started: false, reason: "cancelled" }

  const parentId = input.delegationRunId ?? input.parentRunId
  const parent = parentId ? await getExecutionRun(parentId).catch(() => undefined) : undefined
  if (parentId && !parent) return { started: false, reason: "parent_not_found", detail: parentId }
  const sessionId = input.sessionId ?? parent?.sessionId
  const surface = input.surface ?? "chat"

  if (input.target.kind === "squad") {
    const target = input.target
    const port = await loadPort("squad-launch")
    if (!port) return { started: false, reason: "engine_unavailable", detail: "squad-launch" }
    if (input.signal?.aborted) return { started: false, reason: "cancelled" }
    const launched = await port.start({
      squadId: target.squadId,
      brief: target.brief,
      origin: target.origin,
      ...(parent ? { launchedByRunId: parent.id } : {}),
      // Only a conversation the caller names: a Squad run bound to a session
      // projects its progress there, which the parent's thread did not ask for.
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(target.ultracode !== undefined ? { ultracode: target.ultracode } : {}),
    })
    if (!launched.started) {
      return { started: false, reason: "engine_refused", detail: launched.reason }
    }
    const startedAt = Date.now()
    const detach = onAbort(input.signal, launched.stop)
    const outcome = launched.outcome
      .catch((error: unknown): ChildRunOutcome => ({ status: "failed", error: errorText(error) }))
      .then((settled) => {
        detach()
        emitDispatchSpan({
          target,
          executionRunId: launched.executionRunId,
          parent,
          ...(input.delegationRunId ? { delegationRunId: input.delegationRunId } : {}),
          ...(sessionId ? { sessionId } : {}),
          surface,
          launchedAt,
          startedAt,
          settledAt: Date.now(),
          outcome: settled,
        })
        return settled
      })
    return {
      started: true,
      childId: launched.squadRunId,
      executionRunId: launched.executionRunId,
      outcome,
    }
  }

  const target = input.target
  const childId = input.childId ?? crypto.randomUUID()
  const executionRunId = childJobExecutionRunId(childId)
  try {
    await startToolExecutionRun(sessionId, {
      runId: executionRunId,
      ...(parent ? { parentRunId: parent.id } : {}),
      title: input.title,
    })
  } catch (error) {
    return { started: false, reason: "journal_failed", detail: errorText(error) }
  }

  const background = target.kind === "external" ? undefined : target.background
  let engine: StartedChildEngine
  // Set once this launch holds the Job Center entry; a failed registration
  // (an id already registered) must not settle somebody else's entry.
  let backgroundSignal: AbortSignal | undefined
  if (input.signal?.aborted) {
    engine = settledEngine({ status: "cancelled", error: "Cancelled." })
  } else {
    try {
      if (background) {
        const { getBackgroundAgentManager } =
          await import("@/lib/ai/agent/background-agent-manager")
        backgroundSignal = getBackgroundAgentManager().registerAgent(childId, {
          label: background.label,
          kind: background.kind,
          prompt: target.kind === "twin" ? target.question : target.prompt,
        })
      }
      const started = await startJobEngine(target, grants)
      engine =
        "refused" in started
          ? settledEngine({
              status: "failed",
              error: started.detail ? `${started.refused}: ${started.detail}` : started.refused,
            })
          : started
    } catch (error) {
      engine = settledEngine({ status: "failed", error: errorText(error) })
    }
  }
  const startedAt = Date.now()
  // A stop from the caller, or a cancel from the Job Center.
  const detachCaller = onAbort(input.signal, engine.stop)
  const detachBackground = onAbort(backgroundSignal, engine.stop)

  const outcome = engine.outcome
    .catch((error: unknown): ChildRunOutcome => ({ status: "failed", error: errorText(error) }))
    .then(async (settled) => {
      detachCaller()
      detachBackground()
      if (backgroundSignal) {
        const { getBackgroundAgentManager } =
          await import("@/lib/ai/agent/background-agent-manager")
        getBackgroundAgentManager().finishAgent(childId, {
          text: settled.text ?? "",
          ...(settled.status === "completed" ? {} : { error: settled.error ?? settled.status }),
        })
      }
      await finishToolExecutionRun(
        executionRunId,
        settled.status === "completed" ? false : settled.status === "cancelled" ? "cancelled" : true
      ).catch(() => undefined)
      emitDispatchSpan({
        target,
        executionRunId,
        parent,
        ...(input.delegationRunId ? { delegationRunId: input.delegationRunId } : {}),
        ...(sessionId ? { sessionId } : {}),
        surface,
        launchedAt,
        startedAt,
        settledAt: Date.now(),
        outcome: settled,
      })
      return settled
    })
  return { started: true, childId, executionRunId, outcome }
}
