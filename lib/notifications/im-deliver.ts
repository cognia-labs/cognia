/**
 * IM proactive-push delivery channel (control-plane notifications).
 *
 * The Notification Center fans a record to this channel when its resolved
 * channels include `"im"`. This decides which conversation the record belongs
 * in (see {@link resolveConversationKey}) and hands it to that conversation's
 * channel (the `conversation-channel` port's `deliverNotification`), which
 * enforces the conversation's opt-in, gates the content for PII and posts it
 * (the IM channel: `lib/connectors/notifications/im-deliver.ts`).
 */

import type { NotificationRecord } from "@/types/notifications"
import type { ConversationNotificationOutcome } from "@/types/modules/ports/conversation-channel"
import { conversationChannelFor } from "@/lib/chat/conversation-channel"
import { listExecutionRunBindings } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"

export interface ImDeliverDeps {
  /** Session lookup by id, for the `session`/`groupKey` resolution step. */
  getSession?: (
    sessionId: string
  ) => Promise<{ platformBinding?: { conversationKey?: string } } | undefined>
  /** Run-binding lookup, for the run-kind resolution step. */
  listRunBindings?: typeof listExecutionRunBindings
  /** The channel a conversation is bound to (defaults to the port reader). */
  channelFor?: typeof conversationChannelFor
}

/** `sourceRef.kind` values that name a durable run rather than a chat. */
const RUN_SOURCE_KINDS = new Set(["run", "team-run", "background-run"])

async function defaultGetSession(sessionId: string) {
  return getDb().sessions.get(sessionId)
}

/**
 * Which IM conversation this record belongs in, or `undefined` for one that
 * belongs in none.
 *
 * The gate used to be `sourceRef.kind === "conversation"` and a silent
 * `return`. Every other producer names its own domain entity, so a plan
 * awaiting approval (`kind: "plan"`), a finished team run, and a scheduled
 * task were all invisible in IM by construction, with nothing recorded to say
 * why. Each step below reads a table that already exists and already holds the
 * link, and a step that resolves nothing simply falls through.
 *
 * This widens WHERE a notification can land, never WHETHER one is pushed. The
 * `proactivePush` opt-in downstream is untouched and still fail-closed.
 */
async function resolveConversationKey(
  rec: NotificationRecord,
  deps: {
    getSession: NonNullable<ImDeliverDeps["getSession"]>
    listRunBindings: typeof listExecutionRunBindings
  }
): Promise<string | undefined> {
  const ref = rec.sourceRef
  if (ref?.kind === "conversation") return ref.id

  // A session id reaches the conversation through the binding the session
  // already carries. `groupKey` is the plan hub's spelling of the same thing
  // (`notifyPlanAwaitingApproval` sets it to `plan.sessionId`).
  const sessionId = ref?.kind === "session" ? ref.id : rec.groupKey
  if (sessionId) {
    const session = await deps.getSession(sessionId).catch(() => undefined)
    const key = session?.platformBinding?.conversationKey
    if (key) return key
  }

  // A run knows the conversation that started it: `ExecutionRunBinding` is
  // minted with `conversationKey` when the run is dispatched from IM. A run
  // started on the desktop has no binding, and resolves to nothing.
  if (ref && RUN_SOURCE_KINDS.has(ref.kind)) {
    const bindings = await deps.listRunBindings(ref.id).catch(() => [])
    const bound = bindings.find((b) => b.conversationKey)
    if (bound?.conversationKey) return bound.conversationKey
  }

  return undefined
}

/**
 * The structured outcome of one IM delivery attempt: what the durable
 * diagnostics and the V2 reconciler read. A `pushed` outcome means the record
 * reached the outbound queue; every other outcome names WHY it didn't (the
 * route exists only where an existing table already holds the link, nothing
 * here guesses a destination).
 */
export type ImDeliverOutcome =
  | ConversationNotificationOutcome
  | {
      status: "skipped"
      reason:
        | "no-conversation" // belongs in no IM conversation
        | "no-channel" // no active channel serves the conversation
      conversationKey?: string
    }

/**
 * Deliver one center record to its resolved IM conversation. Returns the
 * structured outcome; never throws, so a failed IM push can't break the
 * notification persist or the other channels.
 */
export async function deliverRecordToIM(
  rec: NotificationRecord,
  deps: ImDeliverDeps = {}
): Promise<ImDeliverOutcome> {
  const getSession = deps.getSession ?? defaultGetSession
  const listRunBindings = deps.listRunBindings ?? listExecutionRunBindings
  const channelFor = deps.channelFor ?? conversationChannelFor
  try {
    const conversationKey = await resolveConversationKey(rec, { getSession, listRunBindings })
    if (!conversationKey) return { status: "skipped", reason: "no-conversation" }
    const channel = await channelFor({ conversationKey })
    if (!channel) return { status: "skipped", reason: "no-channel", conversationKey }
    return await channel.deliverNotification({ record: rec, conversationKey })
  } catch {
    // Fail-closed: a delivery error must never propagate into notify()'s
    // persist / other channels.
    return { status: "error" }
  }
}

/**
 * Build the `imDeliver` fn the Notification Center calls — the compatibility
 * bridge over {@link deliverRecordToIM}. The notify() channel signature stays
 * `Promise<void>`; callers that want the structured outcome call
 * `deliverRecordToIM` directly.
 */
export function createImDeliver(
  deps: ImDeliverDeps = {}
): (rec: NotificationRecord) => Promise<void> {
  return async (rec: NotificationRecord): Promise<void> => {
    await deliverRecordToIM(rec, deps)
  }
}
