/**
 * The lane that brings a Squad's result back into the IM group it was asked
 * from (ADR-0177 batch 5, ADR-0249 §6).
 *
 * A member of an IM room bound to a character team handed work to a Squad;
 * when the run ends, the result is owed to that member. The delivery path
 * (`lib/background-tasks/result-delivery.ts`) picks this lane for an IM
 * group's hand-off results, and this lane starts the turn on the
 * conversation's own queue (`ConnectorBus.enqueueAutomatedRoomTurn`), which
 * the runtime answers as a room turn addressed to the proposer.
 *
 * Reachable where this host runs the conversation's adapter; idle when no
 * turn of the conversation runs or waits here, so whatever the group sent
 * first is answered first. The bus's turn boundary is the drain point, as the
 * room runner's is for a desktop room.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { BackgroundDeliveryLane } from "@/lib/background-tasks/result-delivery"
import type { ConnectorBus } from "@/lib/connectors/bus"
import { roomKindOf } from "@/lib/chat/room/kind"
import { getDb } from "@/lib/db/schema"

export interface ImRoomDeliveryLaneDeps {
  bus: () => Pick<
    ConnectorBus,
    "getAdapter" | "isConversationTurnIdle" | "enqueueAutomatedRoomTurn"
  >
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  /** The id this host claims job ends under, stable across restarts. */
  consumerId: () => string
}

/** The IM group's binding, when the session is one. */
async function groupBinding(
  deps: ImRoomDeliveryLaneDeps,
  sessionId: string
): Promise<NonNullable<ChatSession["platformBinding"]> | undefined> {
  const session = await deps.getSession(sessionId).catch(() => undefined)
  return roomKindOf(session) === "im" ? session?.platformBinding : undefined
}

export function createImRoomDeliveryLane(deps: ImRoomDeliveryLaneDeps): BackgroundDeliveryLane {
  return {
    isReachable: async (sessionId) => {
      const binding = await groupBinding(deps, sessionId)
      return Boolean(binding && deps.bus().getAdapter(binding.adapterId))
    },
    isIdle: async (sessionId) => {
      const binding = await groupBinding(deps, sessionId)
      return Boolean(binding && deps.bus().isConversationTurnIdle(binding.conversationKey))
    },
    // Accepted once the group's turn is queued (its job is written): a room
    // turn runs for minutes, and a second send of the delivery is the same turn.
    send: async (framedText, sessionId, deliveryId, _personalRunIds, targets) => {
      const binding = await groupBinding(deps, sessionId)
      if (!binding) return false
      return deps
        .bus()
        .enqueueAutomatedRoomTurn({
          binding,
          text: framedText,
          deliveryId,
          producer: "background-result",
          ...(targets?.memberIds.length ? { targetMemberIds: targets.memberIds } : {}),
        })
        .catch(() => false)
    },
    consumerId: deps.consumerId,
  }
}

export interface InstallImRoomDeliveryDeps {
  bus: Pick<
    ConnectorBus,
    "getAdapter" | "isConversationTurnIdle" | "enqueueAutomatedRoomTurn" | "onConversationTurnsIdle"
  >
  getSession?: (sessionId: string) => Promise<ChatSession | undefined>
  /** The sessions bound to a conversation. */
  sessionsOf?: (conversationKey: string) => Promise<string[]>
  /** Hand-off results still owed, by session. */
  owedSessions?: () => Promise<string[]>
  consumerId?: () => string
  delivery?: Pick<
    typeof import("@/lib/background-tasks/result-delivery"),
    "registerImRoomDeliveryLane" | "maybeDrainBackgroundResults" | "attemptBackgroundResultDelivery"
  >
}

/**
 * Register the lane with the delivery path, drain at the bus's turn
 * boundary, and deliver what a previous run of the host left owed. Returns
 * the teardown.
 */
export function installImRoomDelivery(deps: InstallImRoomDeliveryDeps): () => void {
  let stopped = false
  let unregister: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  const getSession =
    deps.getSession ??
    (async (sessionId: string) => (await import("@/lib/db/sessions")).getSession(sessionId))
  const sessionsOf =
    deps.sessionsOf ??
    (async (conversationKey: string) => {
      return getDb()
        .sessions.where("platformConversationKey")
        .equals(conversationKey)
        .primaryKeys() as Promise<string[]>
    })
  const owedSessions =
    deps.owedSessions ??
    (async () => {
      const { listBackgroundTaskRecords } = await import("@/lib/db/background-tasks")
      const owed = await listBackgroundTaskRecords({ host: "renderer" })
      return [
        ...new Set(
          owed
            .filter((row) => row.kind === "squad-handoff" && row.deliveryState === "pending")
            .map((row) => row.sessionId)
        ),
      ]
    })
  const consumerId = deps.consumerId ?? (() => `im-room:${getDb().name}`)

  void (async () => {
    const delivery = deps.delivery ?? (await import("@/lib/background-tasks/result-delivery"))
    if (stopped) return
    unregister = delivery.registerImRoomDeliveryLane(
      createImRoomDeliveryLane({ bus: () => deps.bus, getSession, consumerId })
    )
    unsubscribe = deps.bus.onConversationTurnsIdle((conversationKey) => {
      void sessionsOf(conversationKey)
        .then((ids) => {
          for (const id of ids) delivery.maybeDrainBackgroundResults(id, { turnSettled: true })
        })
        .catch(() => undefined)
    })
    for (const sessionId of await owedSessions().catch(() => [] as string[])) {
      if (stopped) return
      void delivery.attemptBackgroundResultDelivery(sessionId)
    }
  })()

  return () => {
    stopped = true
    unsubscribe?.()
    unregister?.()
  }
}
