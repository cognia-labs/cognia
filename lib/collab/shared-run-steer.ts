/**
 * Steering a shared session's run (ADR-0252 §5, ADR-0241).
 *
 * A shared session's turn runs on one member's device, the lease holder's.
 * A person who writes into the session while that run streams is steering
 * it, wherever they write from:
 *
 *   - Their message is posted to the shared transcript as usual
 *     (`message.created`), so every member reads it.
 *   - It is then steered into the run. On the holder's own device that is
 *     the local turn's input (the one steer entry, `steerRun`). Elsewhere it
 *     goes through the server (`POST …/steer`, which checks the lease and the
 *     `session.steer` grant) as a `run.steered` event naming the message.
 *   - The holder applies `run.steered` events for the run it holds, live
 *     into its local turn. When that turn has closed its input, the message
 *     becomes the next run's queued input — what a message written during a
 *     run did before steering existed.
 *
 * `sharedSessionSteerLane` is the remote lane of the steer entry: input for a
 * shared conversation whose run another device holds. It carries a person's
 * input only; derived inputs belong to the host that produced them.
 */

import type { SendContent, SessionEvent } from "@cognia/agent-config-types"
import { steerTextOf } from "@/lib/claude/steer"
import {
  registerRemoteSessionSteerLane,
  steerRun,
  type RemoteSessionSteerLane,
  type SteerOutcome,
} from "@/lib/execution/steer"
import { getSession } from "@/lib/db/sessions"
import { CollabError } from "./client"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "./runtime-client"
import { activeSharedRunId } from "./shared-run-coordinator"

export interface SharedRunSteerDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
  getSession?: typeof getSession
  steer?: typeof steerRun
  heldRunId?: (localSessionId: string) => string | undefined
}

type SharedBinding =
  | { kind: "private" }
  | { kind: "unreachable" }
  | { kind: "shared"; context: CurrentCollabContext; sharedSessionId: string }

/** Whether the conversation is shared, and the connection that reaches it now. */
async function sharedBinding(
  localSessionId: string,
  deps: SharedRunSteerDeps
): Promise<SharedBinding> {
  const session = await (deps.getSession ?? getSession)(localSessionId)
  const binding = session?.collaboration
  if (!binding) return { kind: "private" }
  const context = await (deps.resolveContext ?? resolveCurrentCollabContext)()
  if (
    !context ||
    context.orgId !== binding.orgId ||
    (binding.endpoint && binding.endpoint !== context.client.baseUrl)
  ) {
    return { kind: "unreachable" }
  }
  return { kind: "shared", context, sharedSessionId: binding.sessionId }
}

/** The steer entry's lane for shared conversations whose run another device holds. */
export function createSharedSessionSteerLane(
  deps: SharedRunSteerDeps = {}
): RemoteSessionSteerLane {
  const heldRunId = deps.heldRunId ?? activeSharedRunId
  return {
    steer: async (sessionId, request) => {
      if (request.origin !== "person") return null
      // Held here: the local turn's input, which the entry reaches next.
      if (heldRunId(sessionId)) return null
      const shared = await sharedBinding(sessionId, deps)
      if (shared.kind === "private") return null
      // A shared conversation this device cannot reach right now: there is
      // no turn here to fall back to either.
      if (shared.kind === "unreachable") return { status: "degraded", reason: "no_active_run" }
      const text = steerTextOf(request.content)
      if (!text) return { status: "degraded", reason: "not_admitted" }
      return steerRemoteRun(shared, text, request.sourceMessageId)
    },
  }
}

async function steerRemoteRun(
  shared: Extract<SharedBinding, { kind: "shared" }>,
  text: string,
  messageId: string | undefined
): Promise<SteerOutcome> {
  const { context, sharedSessionId } = shared
  try {
    const lease = await context.client.getActiveSessionRunLease(context.orgId, sharedSessionId)
    if (!lease) return { status: "degraded", reason: "no_active_run" }
    const event = await context.client.steerSessionRun(context.orgId, sharedSessionId, {
      runId: lease.runId,
      payload: { text, ...(messageId ? { messageId } : {}) },
      operationId: `steer:${messageId ?? crypto.randomUUID()}`,
    })
    return { status: "delivered", receiptIds: [event.id] }
  } catch (error) {
    if (error instanceof CollabError) {
      // The lease moved on, or this member may not steer someone else's run.
      if (error.status === 409) return { status: "degraded", reason: "no_active_run" }
      if (error.status === 403) return { status: "degraded", reason: "not_admitted" }
    }
    return { status: "degraded", reason: "provider_unsupported" }
  }
}

/** Register the shared-session lane with the one steer entry. */
export function installSharedSessionSteerLane(deps: SharedRunSteerDeps = {}): () => void {
  return registerRemoteSessionSteerLane(createSharedSessionSteerLane(deps))
}

export type SharedFollowUpOutcome = "steered" | "queued" | "none"

/**
 * A person's message just landed in a shared session: steer it into the run
 * that streams now, here or on the holder's device. With no run streaming it
 * is an ordinary message (`none`). On the holder's own device a turn that
 * closed its input takes the message as the next run's input (`queued`).
 */
export async function steerSharedFollowUp(
  localSessionId: string,
  message: { messageId: string; content: SendContent },
  deps: SharedRunSteerDeps = {}
): Promise<SharedFollowUpOutcome> {
  const steer = deps.steer ?? steerRun
  const heldHere = Boolean((deps.heldRunId ?? activeSharedRunId)(localSessionId))
  const outcome = await steer({
    target: { sessionId: localSessionId },
    origin: "person",
    content: message.content,
    sourceMessageId: message.messageId,
  })
  if (outcome.status === "delivered") return "steered"
  if (!heldHere) return "none"
  return (await queueAsNextRunInput(
    localSessionId,
    message.messageId,
    `steer-local:${message.messageId}`,
    deps
  ))
    ? "queued"
    : "none"
}

/** Steer events already applied in this process: a pull and the stream may both carry one. */
const appliedSteers = new Set<string>()

/**
 * The holder's side of a `run.steered` event: deliver the member's input into
 * the run this device holds, or queue the message for the next run when the
 * turn has closed its input. An event for a run this device does not hold is
 * someone else's to apply. Resolves what happened.
 */
export async function applySharedRunSteer(
  localSessionId: string,
  event: SessionEvent,
  deps: SharedRunSteerDeps = {}
): Promise<"steered" | "queued" | "skipped"> {
  if (event.kind !== "run.steered" || appliedSteers.has(event.id)) return "skipped"
  const payload = event.payload as { runId?: unknown; input?: unknown }
  const input =
    payload.input && typeof payload.input === "object"
      ? (payload.input as { text?: unknown; messageId?: unknown })
      : {}
  const heldRunId = (deps.heldRunId ?? activeSharedRunId)(localSessionId)
  if (!heldRunId || payload.runId !== heldRunId || typeof input.text !== "string") {
    return "skipped"
  }
  appliedSteers.add(event.id)
  if (appliedSteers.size > 2048) appliedSteers.delete(appliedSteers.values().next().value!)
  const messageId = typeof input.messageId === "string" ? input.messageId : undefined
  const outcome = await (deps.steer ?? steerRun)({
    target: { sessionId: localSessionId },
    origin: "person",
    content: input.text,
    ...(messageId ? { sourceMessageId: messageId } : {}),
  })
  if (outcome.status === "delivered") return "steered"
  if (!messageId) return "skipped"
  return (await queueAsNextRunInput(localSessionId, messageId, `steer-fallback:${event.id}`, deps))
    ? "queued"
    : "skipped"
}

async function queueAsNextRunInput(
  localSessionId: string,
  messageId: string,
  operationId: string,
  deps: SharedRunSteerDeps
): Promise<boolean> {
  const shared = await sharedBinding(localSessionId, deps)
  if (shared.kind !== "shared") return false
  try {
    await shared.context.client.enqueueSessionRunInput(
      shared.context.orgId,
      shared.sharedSessionId,
      { payload: { messageId }, operationId }
    )
    return true
  } catch {
    return false
  }
}

/** Test-only. */
export function __resetSharedRunSteerForTesting(): void {
  appliedSteers.clear()
}
