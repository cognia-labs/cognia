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
 *   agent      `executeAgent` (kernel), or an engine the caller drives
 *              itself (`dispatch_agent`'s retrying dispatch), a `job` row
 *              written here either way.
 *   external   `ExternalAgentManager.execute` (kernel), placed on an always-on
 *              Host first (ADR-0224 A8), a `job` row written here.
 *   twin       the `twin-answer` port, a `job` row written here.
 *   squad      the `squad-launch` port. A Squad run writes its own `team` row
 *              in the transaction that writes its durable record, so the
 *              launcher hands it the parent instead of writing a row first.
 *
 * Stop: while its engine runs, a `job` child's stop is registered under its
 * run id (`run-stops.ts`), which the `job` run-control handler and the tree
 * stop (`stopRunTree`) reach. A Squad child is a `team` run, stopped by the
 * `team` handler like any Squad run.
 *
 * Order: the row is written, and only then is the engine started or the run
 * registered with the background-agent manager (its `backgroundTasks` entry
 * carries the result to deliver, never the run's identity or parent). The
 * launcher is the only writer of these rows: no bridge projects them back.
 * A run whose host stopped before it settled is settled `cancelled` by the
 * renderer's recovery: through its outbox entry when it has one
 * (`interruptRendererBackgroundTasksOnBoot`), otherwise through the ownership
 * claim held while it runs (`child-run-ownership.ts`).
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
import { registerRunStop, type RunStop } from "./run-stops"
import { CHILD_RUN_LAUNCHER_MARK, holdChildRunOwnership } from "./child-run-ownership"

/** Registers the child in the Job Center, where a person can see and cancel it. */
export interface ChildRunBackgroundRegistration {
  /** The Job Center's label for the run. An id or a fixed phrase, never free text. */
  label: string
  kind: BackgroundAgentKind
}

/**
 * An agent run the caller drives itself, because how it runs is the caller's
 * own policy: `dispatch_agent`'s retries, subtree budget, deadline, approval
 * route and Job Center journal (`lib/claude/agents/dispatch-run.ts`). The
 * launcher still writes the row, links the parent, settles the row from the
 * returned outcome and records the dispatch; a stop aborts `signal`. It
 * applies no grant: the caller resolved the run's configuration itself.
 */
export interface ChildRunCallerEngine {
  run(signal: AbortSignal): Promise<ChildRunOutcome>
}

export type ChildRunTarget =
  | {
      kind: "agent"
      prompt: string
      systemPrompt?: string
      /** Run as this agent profile (ADR-0199 variants apply). */
      characterId?: string
      /** `false` runs the tool-less channel. */
      toolsEnabled?: boolean
      /** The directory the agent works in. */
      cwd?: string
      background?: ChildRunBackgroundRegistration
    }
  | {
      kind: "agent"
      engine: ChildRunCallerEngine
      /** The agent's id for the dispatch span (a subagent id). Never free text. */
      label: string
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
  /**
   * A named parent without a readable row: refuse (the default), or start the
   * child unparented, for a caller whose pin may name a run since removed
   * (`dispatch_agent` recovering a journaled run).
   */
  missingParent?: "refuse" | "unparented"
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
  /**
   * How a run-control stop of this child stops it, when that is more than
   * aborting `signal` (`dispatch_agent` records the cancellation in its
   * background outbox first). Registered under the child's run id for as long
   * as its engine runs (`run-stops.ts`). Defaults to the engine's own stop, or
   * the background-agent manager's cancel for a child registered there.
   */
  stop?: RunStop
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
 * team configuration and frozen execution constraints, so neither applies any;
 * nor does a caller's own engine.
 */
const HONOURED_GRANT_FIELDS: Record<ChildRunTargetKind, "all" | readonly GrantField[]> = {
  agent: "all",
  twin: "all",
  external: [],
  squad: [],
}

function unhonouredGrantFields(
  target: ChildRunTarget,
  grants: readonly AgentCapabilityGrantV1[]
): GrantField[] {
  const honoured = "engine" in target ? [] : HONOURED_GRANT_FIELDS[target.kind]
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
      return "engine" in target
        ? target.label
        : (target.background?.label ?? target.characterId ?? "agent")
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
  characterId?: string
  toolsEnabled?: boolean
  cwd?: string
  grants?: readonly AgentCapabilityGrantV1[]
}): StartedChildEngine {
  const controller = new AbortController()
  const outcome = (async (): Promise<ChildRunOutcome> => {
    try {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      if (controller.signal.aborted) return { status: "cancelled", error: "Cancelled." }
      const result = await executeAgent(input.prompt, {
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.characterId ? { characterId: input.characterId } : {}),
        ...(input.toolsEnabled !== undefined ? { toolsEnabled: input.toolsEnabled } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
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
      if ("engine" in target) return startCallerEngine(target.engine)
      return startAgentEngine({
        prompt: target.prompt,
        ...(target.systemPrompt ? { systemPrompt: target.systemPrompt } : {}),
        ...(target.characterId ? { characterId: target.characterId } : {}),
        ...(target.toolsEnabled !== undefined ? { toolsEnabled: target.toolsEnabled } : {}),
        ...(target.cwd ? { cwd: target.cwd } : {}),
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

/** A caller's engine: its run gets the stop signal; a throw is a failed outcome. */
function startCallerEngine(engine: ChildRunCallerEngine): StartedChildEngine {
  const controller = new AbortController()
  const outcome = (async (): Promise<ChildRunOutcome> => {
    try {
      return await engine.run(controller.signal)
    } catch (error) {
      return controller.signal.aborted
        ? { status: "cancelled", error: errorText(error) }
        : { status: "failed", error: errorText(error) }
    }
  })()
  return { outcome, stop: (reason) => controller.abort(new Error(reason ?? "stopped")) }
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
  const unhonoured = unhonouredGrantFields(input.target, grants)
  if (unhonoured.length > 0) {
    return { started: false, reason: "grant_not_honoured", detail: unhonoured.join(",") }
  }
  if (input.signal?.aborted) return { started: false, reason: "cancelled" }

  const parentId = input.delegationRunId ?? input.parentRunId
  const parent = parentId ? await getExecutionRun(parentId).catch(() => undefined) : undefined
  if (parentId && !parent && input.missingParent !== "unparented") {
    return { started: false, reason: "parent_not_found", detail: parentId }
  }
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
  // Claimed before the row exists and released after it is settled, so a
  // reconciliation in any webview tells a live child from an orphan.
  const releaseOwnership = await holdChildRunOwnership(executionRunId)
  try {
    await startToolExecutionRun(sessionId, {
      runId: executionRunId,
      ...(parent ? { parentRunId: parent.id } : {}),
      title: input.title,
      launchedBy: CHILD_RUN_LAUNCHER_MARK,
    })
  } catch (error) {
    releaseOwnership()
    return { started: false, reason: "journal_failed", detail: errorText(error) }
  }

  // Only an agent or twin the launcher runs itself is registered here; a
  // caller's engine keeps its own journal.
  const background =
    target.kind === "twin"
      ? target.background && { ...target.background, prompt: target.question }
      : target.kind === "agent" && !("engine" in target)
        ? target.background && { ...target.background, prompt: target.prompt }
        : undefined
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
          prompt: background.prompt,
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
  // A run-control stop (the Job Center, a chat card, a tree stop). A child the
  // Job Center tracks is cancelled through the manager, which also settles its
  // entry at once; its abort reaches the engine through `backgroundSignal`.
  const unregisterStop = registerRunStop(
    executionRunId,
    input.stop ??
      (backgroundSignal
        ? async () => {
            const { getBackgroundAgentManager } =
              await import("@/lib/ai/agent/background-agent-manager")
            getBackgroundAgentManager().cancelAgent(childId)
          }
        : engine.stop)
  )

  const outcome = engine.outcome
    .catch((error: unknown): ChildRunOutcome => ({ status: "failed", error: errorText(error) }))
    .then(async (settled) => {
      unregisterStop()
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
      releaseOwnership()
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
