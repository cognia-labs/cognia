/**
 * The lane for character-team rooms this host orchestrates (ADR-0249 §6,
 * ADR-0252 §4).
 *
 * A room's turns are its runner's, not a chat controller's: a result owed to
 * a room (a Squad run a member handed work to) becomes the room's automated
 * turn, sent to the members it is owed to. The runner writes the framed row
 * under the delivery id, so a second attempt at the same batch is accepted
 * without a second turn, and the members' runs carry no person's authority.
 * The room is idle when no turn of it runs here and no steer waits: a
 * person's queued message goes first, and the runner's turn boundary drains
 * the results after it (`./runtime-room-lane.ts`).
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { RoomRunner } from "@/lib/chat/room/runner"
import { isLocallyOrchestratedRoom } from "@/lib/chat/room/kind"
import type { BackgroundDeliveryLane } from "./result-delivery"

export interface RoomDeliveryLaneDeps {
  runner: () => Pick<RoomRunner, "isIdle" | "send">
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  /** The id this host claims job ends under, stable across restarts. */
  consumerId: () => string
}

export function createRoomDeliveryLane(deps: RoomDeliveryLaneDeps): BackgroundDeliveryLane {
  return {
    isReachable: async (sessionId) =>
      isLocallyOrchestratedRoom(await deps.getSession(sessionId).catch(() => undefined)),
    isIdle: (sessionId) => deps.runner().isIdle(sessionId),
    // Accepted once the room took the turn (its row is written and its
    // members start), not when the turn ends: a room turn runs for minutes.
    send: (framedText, sessionId, deliveryId, _personalRunIds, targets) =>
      new Promise<boolean>((resolve) => {
        let answered = false
        const answer = (accepted: boolean) => {
          if (answered) return
          answered = true
          resolve(accepted)
        }
        deps
          .runner()
          .send(framedText, {
            sessionId,
            automatedTurn: { producer: "background-result", messageId: deliveryId },
            ...(targets?.memberIds.length ? { targetMemberIds: [...targets.memberIds] } : {}),
            onAccepted: () => answer(true),
            onRefused: () => answer(false),
          })
          .then(
            () => answer(false),
            () => answer(false)
          )
      }),
    consumerId: deps.consumerId,
  }
}
