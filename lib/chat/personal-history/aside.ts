import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { selectVisibleMessages } from "@/stores/chat/chat-store"

/** Same projection for the picker and send. Withheld placeholders never become selectable context. */
export async function readPersonalAsideHistory(
  sessionId: string,
  sourceSessionId: string,
  executionRunId?: string
) {
  const sourceSession = await getSession(sourceSessionId)
  const filtered = await preparePersonalHistory(
    sessionId,
    selectVisibleMessages(
      await listMessages(sourceSessionId),
      sourceSession?.activeBranchByGroup ?? {}
    ),
    { executionRunId, session: sourceSession }
  )
  const withheld = new Set(filtered.withheldMessageIds)
  return { ...filtered, messages: filtered.messages.filter((message) => !withheld.has(message.id)) }
}
