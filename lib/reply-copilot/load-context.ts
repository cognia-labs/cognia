/**
 * Assemble everything the copilot reads for one platform-bound session
 * (ADR-0194): the transcript window, the contact behind it, and the gated
 * knowledge block. Kept apart from `run-copilot.ts` so the orchestration stays
 * pure and this file owns the storage / settings reads.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { listRecentMessages } from "@/lib/db/messages"
import { prepareOwnerHistory } from "@/lib/execution/personal-visibility"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  finishToolExecutionRun,
} from "@/lib/execution/acting-authority"
import { resolveMemoryTurnPolicy } from "@/lib/memory/control-plane/policy"
import { retrieveMemories, type MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import {
  buildCopilotTranscript,
  type CopilotTranscript,
  type TranscriptRow,
} from "@/lib/reply-copilot/build-state"
import { gatherKnowledge, type CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import {
  resolveCopilotContact,
  selfPlatformIdsForAdapter,
} from "@/lib/reply-copilot/resolve-contact"
import { resolveMemoryConfig } from "@/types/memory/memory"

/** Rows read to fill the judge window after skipping system / deleted rows. */
export const COPILOT_HISTORY_ROWS = 40

export interface CopilotContext {
  transcript: CopilotTranscript
  knowledge: CopilotKnowledge
}

export interface LoadContextDeps {
  listRows: (sessionId: string, limit: number) => Promise<TranscriptRow[]>
  selfPlatformIds: (adapterId: string) => Promise<Set<string>>
  resolveContact: typeof resolveCopilotContact
  recall: (settings: AppSettings | null | undefined, query: string) => Promise<string[]>
}

/** Memory recall for the copilot; shared with the desktop screen path. */
export async function recallCopilotMemory(
  settings: AppSettings | null | undefined,
  query: string
): Promise<string[]> {
  const deps: MemoryRetrieverDeps | null =
    (await import("@/lib/memory/runtime/build-deps")
      .then((m) => m.tryBuildMemoryDeps(resolveMemoryConfig(settings?.memory)))
      .catch(() => null)) ?? null
  if (!deps) return []
  const { withPersonalMemoryVisibility } = await import("@/lib/memory/runtime/build-deps")
  // Reply drafts belong to the desktop owner. Keep an explicit admitted
  // reader through candidate loading and reranking instead of a readerless job.
  const execution = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  let failed = true
  try {
    const recalled = await retrieveMemories(
      {
        queryText: query,
        topK: 5,
        relevanceFloor: 0.2,
        types: ["semantic", "episodic"],
        // What the user has shared about people and plans — not facts mined
        // from a repository, which would read as chat context here.
        claimFilter: "personal-only",
      },
      withPersonalMemoryVisibility(
        { ...deps, loadProcedural: async () => [] },
        undefined,
        execution.id
      )
    )
    failed = false
    return recalled.map((hit) => hit.memory.text)
  } finally {
    await finishToolExecutionRun(execution.id, failed)
  }
}

const defaultDeps: LoadContextDeps = {
  listRows: async (sessionId, limit) =>
    (
      await prepareOwnerHistory(
        (await listRecentMessages(sessionId, limit)).map((message) => ({ ...message, sessionId }))
      )
    ).messages as TranscriptRow[],
  selfPlatformIds: selfPlatformIdsForAdapter,
  resolveContact: resolveCopilotContact,
  recall: recallCopilotMemory,
}

/**
 * Memory is consulted only when the session's memory policy allows recall AND
 * the user opted the copilot in (`composerAssistance.replyCopilot.memory`,
 * default off).
 */
export function copilotMemoryAllowed(
  session: Pick<ChatSession, "memoryUse">,
  settings: AppSettings | null | undefined
): boolean {
  if (settings?.composerAssistance?.replyCopilot?.memory !== true) return false
  return resolveMemoryTurnPolicy({
    config: settings?.memory ?? {},
    session: { memoryUse: session.memoryUse },
  }).canRecall
}

export async function loadCopilotContext(
  session: Pick<ChatSession, "id" | "memoryUse" | "platformBinding">,
  settings: AppSettings | null | undefined,
  deps: LoadContextDeps = defaultDeps
): Promise<CopilotContext> {
  const binding = session.platformBinding
  const [rows, selfIds] = await Promise.all([
    deps.listRows(session.id, COPILOT_HISTORY_ROWS),
    binding ? deps.selfPlatformIds(binding.adapterId) : Promise.resolve(new Set<string>()),
  ])
  const transcript = buildCopilotTranscript(rows, selfIds)
  const contact = await deps.resolveContact({
    sender: transcript.latestOtherSender,
    ...(binding ? { conversationKey: binding.conversationKey } : {}),
    isGroup: transcript.isGroup,
  })
  const knowledge = await gatherKnowledge(
    { transcript, contact, memoryAllowed: copilotMemoryAllowed(session, settings) },
    { recall: (query) => deps.recall(settings, query) }
  )
  return { transcript, knowledge }
}
