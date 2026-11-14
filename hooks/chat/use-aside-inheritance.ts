"use client"

import { useEffect, useState } from "react"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import { readPersonalAsideHistory } from "@/lib/chat/personal-history/aside"
import { summarizeAsideInheritance } from "@/lib/chat/session-aside-context"
import { updateAsideParentMessagePins } from "@/lib/db/resource-workbench-sessions"
import {
  parentAttachmentUnavailableReason,
  restoreParentAttachment,
} from "@/lib/chat/attachments/parent"
import { dispatchComposerAppend } from "@/lib/chat/composer-append"

/** No raw parent rows escape the personal-history projection, including during attachment clicks. */
export function useAsideInheritance(sessionId: string, parentId: string) {
  const [actionError, setActionError] = useState(false)
  const snapshot = useClientLiveQuery(
    async () => {
      try {
        const aside = await getDb().sessions.get(sessionId)
        if (
          aside?.kind !== "resource-workbench" ||
          aside.surfaceBinding?.kind !== "session" ||
          aside.surfaceBinding.sessionId !== parentId
        )
          return null
        const history = await readPersonalAsideHistory(sessionId, parentId)
        const summary = summarizeAsideInheritance(history.messages, {
          pins: aside.asidePinnedParentMessageIds,
        })
        const attachments = await Promise.all(
          summary.attachments.map(async (attachment) => ({
            ...attachment,
            unavailable: await parentAttachmentUnavailableReason(
              parentId,
              history.messages.find((message) => message.id === attachment.messageId)!,
              attachment.partIndex
            ),
          }))
        )
        return {
          sessionId,
          parentId,
          messages: history.messages,
          summary,
          attachments,
          hidden: history.withheldMessageIds.length,
        }
      } catch {
        return { sessionId, parentId, failed: true as const }
      }
    },
    [sessionId, parentId],
    null
  )
  const current =
    snapshot?.sessionId === sessionId && snapshot.parentId === parentId ? snapshot : null
  const data = current && !("failed" in current) ? current : null
  useEffect(() => {
    if (!data) return
    void updateAsideParentMessagePins(sessionId).catch(() => setActionError(true))
  }, [sessionId, parentId, data])

  return {
    data,
    failed: Boolean(current && "failed" in current) || actionError,
    async setIncluded(messageId: string, included: boolean) {
      try {
        const fresh = await readPersonalAsideHistory(sessionId, parentId)
        if (!fresh.messages.some((message) => message.id === messageId)) return
        await updateAsideParentMessagePins(sessionId, { messageId, included })
        setActionError(false)
      } catch {
        setActionError(true)
      }
    },
    async attach(messageId: string, partIndex: number) {
      const fresh = await readPersonalAsideHistory(sessionId, parentId)
      const message = fresh.messages.find((row) => row.id === messageId)
      if (!message) return "missingBytes" as const
      const restored = await restoreParentAttachment(parentId, message, partIndex)
      if (!restored.file) return restored.reason
      // Normal composer staging owns size/provider/PII checks; never a hidden prompt attachment.
      return dispatchComposerAppend({ sessionId, files: [restored.file] })
        ? undefined
        : ("composerUnavailable" as const)
    },
  }
}
