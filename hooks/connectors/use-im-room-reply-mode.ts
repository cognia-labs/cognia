"use client"

/**
 * An IM room's reply mode, read from and written to the conversation's
 * activation policy (ADR-0177 batch 4, `lib/connectors/room-reply-mode.ts`).
 *
 * The room settings section shows one reply-mode control for every room
 * kind; for an IM room it is this hook, so the room and the Inbox's
 * conversation settings edit the same field and can never disagree. Writes go
 * through `mutateConversationOverride`, which applies locally on the host and
 * relays the change from a paired device.
 */

import { useCallback, useMemo } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { platformScopeOf, roomKindOf } from "@/lib/chat/room/kind"
import type { RoomReplyMode } from "@/lib/chat/room/types"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { activationPolicyForReplyMode, imRoomReplyMode } from "@/lib/connectors/room-reply-mode"

export interface ImRoomReplyMode {
  /** `null` until the adapter row has loaded: no mode is shown that is not known. */
  mode: RoomReplyMode | null
  setMode(mode: RoomReplyMode): Promise<void>
}

type ImRoomSession = Pick<
  ChatSession,
  "id" | "platformBinding" | "kind" | "teamId" | "collaboration"
>

/** The reply mode of `session` when it is an IM room, else `null`. */
export function useImRoomReplyMode(
  session: ImRoomSession | null | undefined
): ImRoomReplyMode | null {
  const binding = roomKindOf(session) === "im" ? session?.platformBinding : undefined
  const adapter = useAdapterInstance(binding?.adapterId)
  const override = useConversationOverride(binding?.conversationKey)
  const scope = binding ? platformScopeOf(binding) : undefined

  const mode = useMemo(
    () => (binding && adapter ? imRoomReplyMode({ adapter, override, scope }) : null),
    [binding, adapter, override, scope]
  )

  const setMode = useCallback(
    async (next: RoomReplyMode) => {
      if (!binding || !adapter || !session) return
      await mutateConversationOverride(
        {
          kind: "configSection",
          adapterId: binding.adapterId,
          conversationKey: binding.conversationKey,
          sessionId: session.id,
          section: "behavior",
          source: "room.settings",
          patch: {
            inboundActivationPolicy: activationPolicyForReplyMode(next, {
              adapter,
              override,
              scope,
            }),
          },
        },
        { label: "room.replyMode" }
      )
    },
    [binding, adapter, override, scope, session]
  )

  return binding ? { mode, setMode } : null
}
