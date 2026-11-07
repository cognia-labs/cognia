/**
 * The one steer entry (ADR-0252 §5).
 *
 * Every caller that sends input into a running piece of work comes here: a
 * chat follow-up to a running Squad, a person's IM message into the run its
 * conversation is driving, IM `steer:` and a card button (through the control
 * gate, which calls this), a paired device's follow-up, an issue wakeup, an
 * ADR-0249 completion. The entry applies the queue rule
 * (`steer-queue.ts`) and dispatches by kind to the engine, which stays where
 * it is:
 *
 *   - a conversation's live turn: the sidecar's streaming input
 *     (`steerSession` → `routeSteer`), or a shared session's run on the
 *     device that holds it (a registered remote lane);
 *   - a run row: the engine its kind registers (`registerRunSteerEngine`): a
 *     Squad's durable runtime, a delegation's live children; an `agent-turn`
 *     row steers its session.
 *
 * A person's input goes live. A derived input waits behind a running turn and
 * drains at its boundary as one brief, through the session lane the chat
 * runtime registers; with nothing running there is no turn to join, and the
 * caller keeps its own fallback (`degraded`, `no_active_run`).
 *
 * The control gate (`executeRunControlCommand`) keeps what only it does —
 * authorization, revision, idempotency, the journal's `control.accepted` —
 * and its handlers' `steer` branches call this. Steer text never enters the
 * journal or a span: each engine owns its PII gate.
 */

import type { SendContent } from "@cognia/agent-config-types"
import type { AutomatedTurnProducer } from "@cognia/agent-config-types/automated-turn"
import { getExecutionRun, listChildExecutionRuns, listExecutionRuns } from "@/lib/db/execution-runs"
import { steerTextOf } from "@/lib/claude/steer"
import { isLiveRunStatus } from "./run-status"
import { steerDisposition, type DerivedSteerSource, type SteerOrigin } from "./steer-queue"
import type { SteerDegradedReason } from "./run-control"
import type { ExecutionRun, ExecutionRunKind } from "@/types/execution/run"

/** What to steer: a run row, or the live turn of a conversation. */
export type SteerTarget = { runId: string } | { sessionId: string }

export interface SteerRequest {
  target: SteerTarget
  origin: SteerOrigin
  /** Text, or content blocks for a conversation's turn (an IM message with images). */
  content: SendContent
  /** The platform message this input came from, for the sidecar's dedupe. */
  sourceMessageId?: string
  /** A paired device's `turn.steer` (`now`) or `turn.followup` (`next`). */
  priority?: "now" | "next"
  /** The host-state command id the sidecar acknowledges against. */
  commandId?: string
  /** Set exactly when `origin` is `derived`. */
  derived?: {
    source: DerivedSteerSource
    producer: AutomatedTurnProducer
    /** A newer input with the same key replaces the older one in the queue. */
    dedupeKey?: string
  }
}

export type SteerOutcome =
  /** The engine took it. `receiptIds` are durable receipts, where the engine writes them. */
  | { status: "delivered"; receiptIds: readonly string[] }
  /** A derived input is held for the running turn's boundary. */
  | { status: "queued"; entryId: string }
  /** The kind can steer, this one could not right now; the caller still owns the input. */
  | { status: "degraded"; reason: SteerDegradedReason }
  /** This kind has no steer at all (a `job`, a workflow). */
  | { status: "unsupported_for_kind"; kind: ExecutionRunKind }
  | { status: "run_not_found" }

/** Steers one run row of a kind. */
export type RunSteerEngine = (run: ExecutionRun, request: SteerRequest) => Promise<SteerOutcome>

/**
 * What the chat runtime of this context knows about a conversation: whether
 * a turn runs in it, and how to hold a derived input for its boundary.
 */
export interface SessionSteerLane {
  /** `true` while a turn runs, `false` when idle, `undefined` when this lane does not know it. */
  busy(sessionId: string): boolean | undefined
  /** Hold a derived input for the next boundary; resolves the queue entry id. */
  queueDerived(
    sessionId: string,
    input: {
      text: string
      source: DerivedSteerSource
      producer: AutomatedTurnProducer
      dedupeKey?: string
    }
  ): string
}

/**
 * A conversation whose turn runs elsewhere (a shared session's run held by
 * another member's device). Answers `null` for a conversation it does not
 * carry, so the local lane is tried next.
 */
export interface RemoteSessionSteerLane {
  steer(sessionId: string, request: SteerRequest): Promise<SteerOutcome | null>
}

const runEngines = new Map<ExecutionRunKind, RunSteerEngine>()
let sessionLane: SessionSteerLane | undefined
const remoteLanes = new Set<RemoteSessionSteerLane>()

/** Register the steer engine for a run kind. Returns its unregister. */
export function registerRunSteerEngine(kind: ExecutionRunKind, engine: RunSteerEngine): () => void {
  runEngines.set(kind, engine)
  return () => {
    if (runEngines.get(kind) === engine) runEngines.delete(kind)
  }
}

/** Register this context's chat lane (the renderer's chat runtime). */
export function registerSessionSteerLane(lane: SessionSteerLane): () => void {
  sessionLane = lane
  return () => {
    if (sessionLane === lane) sessionLane = undefined
  }
}

/** Register a lane for conversations whose turn runs on another device. */
export function registerRemoteSessionSteerLane(lane: RemoteSessionSteerLane): () => void {
  remoteLanes.add(lane)
  return () => {
    remoteLanes.delete(lane)
  }
}

/** Test-only: forget every registration. */
export function __resetSteerForTesting(): void {
  runEngines.clear()
  sessionLane = undefined
  remoteLanes.clear()
}

/** Send `request` into its target under the queue rule. Never throws for a refusal. */
export async function steerRun(request: SteerRequest): Promise<SteerOutcome> {
  if ("sessionId" in request.target) return steerSessionTurn(request.target.sessionId, request)
  const run = await getExecutionRun(request.target.runId)
  if (!run) return { status: "run_not_found" }
  return steerExecutionRun(run, request)
}

/** Dispatch a run row to its kind's engine. */
export async function steerExecutionRun(
  run: ExecutionRun,
  request: SteerRequest
): Promise<SteerOutcome> {
  const engine = runEngines.get(run.kind) ?? builtInEngine(run.kind)
  if (!engine) return { status: "unsupported_for_kind", kind: run.kind }
  try {
    return await engine(run, request)
  } catch {
    // An engine's own refusal reached here as a throw: the input was not
    // taken, and the caller keeps it.
    return { status: "degraded", reason: "provider_unsupported" }
  }
}

function builtInEngine(kind: ExecutionRunKind): RunSteerEngine | undefined {
  if (kind === "agent-turn") return steerAgentTurn
  if (kind === "delegation") return steerDelegation
  return undefined
}

/** An `agent-turn` row: its conversation's live turn. */
const steerAgentTurn: RunSteerEngine = async (run, request) => {
  if (!run.sessionId) return { status: "degraded", reason: "no_active_run" }
  return steerSessionTurn(run.sessionId, request)
}

/**
 * A delegation does not execute: the input goes to every live child, and the
 * delegation counts as steered when any one of them took it. A child that
 * cannot be steered does not stop the ones that can.
 */
const steerDelegation: RunSteerEngine = async (run, request) => {
  const children = (await listChildExecutionRuns(run.id)).filter((child) =>
    isLiveRunStatus(child.status)
  )
  if (children.length === 0) return { status: "degraded", reason: "no_active_run" }
  const receiptIds: string[] = []
  let taken = false
  let lastReason: SteerDegradedReason = "no_active_run"
  for (const child of children) {
    const outcome = await steerExecutionRun(child, {
      ...request,
      target: { runId: child.id },
    })
    if (outcome.status === "delivered") {
      taken = true
      receiptIds.push(...outcome.receiptIds)
    } else if (outcome.status === "queued") {
      taken = true
    } else if (outcome.status === "degraded") {
      lastReason = outcome.reason
    }
  }
  return taken ? { status: "delivered", receiptIds } : { status: "degraded", reason: lastReason }
}

/**
 * The Squad turn a conversation is holding for: a live `team` row of the
 * session that no other run launched. A Squad turn keeps its conversation
 * busy until the run ends, so input to the conversation is input to the
 * Squad. A replacement after a retry (its parent is the earlier `team` row)
 * is still the conversation's turn; a Squad another run launched as its child
 * (a delegation's, a tool's) is not.
 */
export async function liveSessionSquadRun(sessionId: string): Promise<ExecutionRun | undefined> {
  const runs = await listExecutionRuns({ sessionId, kinds: ["team"], limit: 20 })
  return runs.find(
    (run) =>
      isLiveRunStatus(run.status) &&
      (!run.parentRunId || run.parentRunId.startsWith("execution:team:"))
  )
}

async function steerSessionTurn(sessionId: string, request: SteerRequest): Promise<SteerOutcome> {
  for (const lane of remoteLanes) {
    const outcome = await lane.steer(sessionId, request).catch(() => null)
    if (outcome) return outcome
  }
  const squad = await liveSessionSquadRun(sessionId).catch(() => undefined)
  if (squad) return steerExecutionRun(squad, { ...request, target: { runId: squad.id } })
  if (request.origin === "derived") {
    const busy = sessionLane?.busy(sessionId)
    // A context whose chat runtime does not know the conversation (a host
    // with no chat runtime) cannot hold the input: it goes to the sidecar,
    // which refuses when no turn runs.
    if (busy !== undefined && sessionLane) {
      const disposition = steerDisposition({ origin: "derived", sessionBusy: busy })
      if (disposition === "idle") return { status: "degraded", reason: "no_active_run" }
      if (!request.derived) return { status: "degraded", reason: "not_admitted" }
      const text = steerTextOf(request.content)
      if (!text) return { status: "degraded", reason: "not_admitted" }
      const entryId = sessionLane.queueDerived(sessionId, {
        text,
        source: request.derived.source,
        producer: request.derived.producer,
        ...(request.derived.dedupeKey ? { dedupeKey: request.derived.dedupeKey } : {}),
      })
      return { status: "queued", entryId }
    }
  }
  return steerSidecarSession(sessionId, request)
}

/** The sidecar's streaming input for a running query (`routeSteer`). */
async function steerSidecarSession(
  sessionId: string,
  request: SteerRequest
): Promise<SteerOutcome> {
  const { steerSession } = await import("@/lib/claude/ipc")
  try {
    // `steerSession` runs its own renderer-side PII gate and throws rather
    // than sending — the gate is relied on, not re-implemented, and its
    // refusal is reported as the reason it actually was.
    await steerSession(sessionId, request.content, request.sourceMessageId, {
      ...(request.priority ? { priority: request.priority } : {}),
      ...(request.commandId ? { commandId: request.commandId } : {}),
    })
    return { status: "delivered", receiptIds: [] }
  } catch (error) {
    return {
      status: "degraded",
      reason:
        error instanceof Error && /PII/i.test(error.message)
          ? "pii_blocked"
          : "provider_unsupported",
    }
  }
}
