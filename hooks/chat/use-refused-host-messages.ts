"use client"

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isHostEnqueuePlaceholder, refusedHostMessageOf } from "@/lib/chat/refused-host-message"
import type { StoredMessage } from "@cognia/agent-config-types"

import { getDb } from "@/lib/db/schema"

export interface RefusedHostMessagesView {
  /** The device-local copies of sends the Host refused, oldest first. */
  messages: StoredMessage[]
  /** The Host message ids those copies stand for, to leave out of the timeline. */
  hiddenIds: ReadonlySet<string>
}

const NONE: StoredMessage[] = []

/**
 * The sends to a Host session this device made and the Host refused: kept on
 * the device (never a confirmed transcript row) so the user can see why and
 * take the text back. A copy whose original became a real transcript row is
 * dropped: the delivery wins.
 */
export function useRefusedHostMessages(sessionId: string): RefusedHostMessagesView {
  const messages = useLiveQuery(
    async () => {
      const db = getDb()
      const retained = await db.messages
        .where("sessionId")
        .equals(sessionId)
        .filter((message) => refusedHostMessageOf(message) !== null)
        .sortBy("createdAt")
      const originals = await db.messages.bulkGet(
        retained.map((message) => refusedHostMessageOf(message)?.messageId ?? message.id)
      )
      return retained.filter(
        (message, index) =>
          !originals[index] ||
          originals[index]?.id === message.id ||
          isHostEnqueuePlaceholder(
            originals[index],
            (message.metadata?.hostState as { actionId?: unknown } | undefined)?.actionId
          )
      )
    },
    [sessionId],
    NONE
  )
  const hiddenIds = useMemo(
    () =>
      new Set(messages.map((message) => refusedHostMessageOf(message)?.messageId ?? message.id)),
    [messages]
  )
  return { messages, hiddenIds }
}
