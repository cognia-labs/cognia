/**
 * The memory module's tool family (ADR-0250 §14 amendment): the deep path of
 * project continuity, `project_history_search` over this workspace's own
 * conversations (`./project-history-tool.ts`).
 *
 * It rides the same switch as the continuity section (`enableProjectContinuity`,
 * off by default) rather than a second flag: both are the one feature "let this
 * chat see what earlier chats in this workspace established", and a person who
 * has not turned that on should not find a tool that can read every
 * conversation in the workspace. It needs a workspace for the same reason the
 * section does (the scope filter IS the isolation) and is withheld from
 * temporary chats, which exist to leave no trace.
 *
 * Calls run host-side: the resident search corpus, the chat result index and
 * Dexie all live here. The runner pre-filters PII per hit, so the relay's
 * output gate is a backstop rather than the gate.
 */

import type { ModuleToolFamily } from "@/lib/modules/manifest-types"
import type { UIMessage } from "ai"
import type { ProjectHistoryEvidence } from "@/lib/chat/history-evidence-registry"
import {
  mergePersonalMarks,
  type PersonalMarkV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { resolveMemoryConfig } from "@/types/memory/memory"
import {
  projectHistoryToolEntries,
  runProjectHistorySearch,
  type ProjectHistoryToolDeps,
} from "./project-history-tool"

interface PersonalProjectHistoryDeps extends ProjectHistoryToolDeps {
  markEvidence?: (
    evidence: readonly ProjectHistoryEvidence[],
    context: { sessionId: string; executionRunId?: string }
  ) => Promise<void>
}
type ProjectHistoryDepsResolver = () =>
  Promise<PersonalProjectHistoryDeps> | PersonalProjectHistoryDeps

let depsOverride: ProjectHistoryDepsResolver | null = null

/** Inject project-history deps (tests / CLI host). Pass `null` to restore the default. */
export function __setProjectHistoryToolDepsForTesting(fn: ProjectHistoryDepsResolver | null): void {
  depsOverride = fn
}

/**
 * Build the project-history tool's host deps.
 *
 * Reuse the chat-search engine, result index, indexer drain and `@msg:` window
 * formatting. Host source receipts stay beside the reads until the returned
 * evidence determines which marks the consuming run must inherit.
 */
async function resolveProjectHistoryToolDeps(): Promise<PersonalProjectHistoryDeps> {
  if (depsOverride) return depsOverride()
  const [
    { searchChatHistory },
    { drainSearchIndex },
    { searchChatResults },
    { clampSpan, formatMessageReference, projectMessageBody },
    { getDb },
  ] = await Promise.all([
    import("@/lib/chat/search/engine"),
    import("@/lib/chat/search/indexer"),
    import("@/lib/db/chat-result-index"),
    import("@/lib/chat/mentions/message-reference"),
    import("@/lib/db/schema"),
  ])
  const db = getDb()
  const messageMarks = new Map<string, PersonalMarkV1[]>()
  const titleMarks = new Map<string, PersonalMarkV1[]>()
  const windowMarks = new Map<string, PersonalMarkV1[]>()
  return {
    markEvidence: async (evidence, context) => {
      if (getDb() !== db) throw new Error("Personal history database changed")
      const marks = mergePersonalMarks(
        ...evidence.flatMap((item) => [
          messageMarks.get(item.messageId),
          item.kind === "message" ? titleMarks.get(item.sessionId) : undefined,
          item.id === `window:${item.messageId}` ? windowMarks.get(item.messageId) : undefined,
        ])
      )
      const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
      await addPersonalMarksToRun(context, marks)
    },
    resolveProjectId: async (sessionId) => {
      const { getSession } = await import("@/lib/db/sessions")
      const session = await getSession(sessionId).catch(() => null)
      const projectId = session?.projectId?.trim()
      return projectId ? projectId : null
    },
    // `backfill: false`: the tool needs the DIRTY queue flushed so a message
    // sent moments ago is findable. Widening coverage into older history is
    // the idle scheduler's job and would make every call pay for a 500-row read.
    drainIndex: async () => {
      await drainSearchIndex(undefined, { backfill: false })
    },
    searchMessages: (query) => searchChatHistory(query),
    searchResults: (needle, limit) => searchChatResults(needle, limit),
    getSessions: (ids) => getDb().sessions.bulkGet(ids as string[]),
    locateMessage: async (messageId) => {
      const row = await getDb().messages.get(messageId)
      return row?.sessionId ?? null
    },
    canReadMessage: async (messageId, context) => {
      const row = await getDb().messages.get(messageId)
      if (!row) return false
      const { preparePersonalHistory } = await import("@/lib/execution/personal-visibility")
      const history = await preparePersonalHistory(context.sessionId, [row], {
        executionRunId: context.executionRunId,
      })
      if (!history.withheldMessageIds.length)
        messageMarks.set(
          messageId,
          (history.messages[0].metadata as { personalMarks?: PersonalMarkV1[] } | undefined)
            ?.personalMarks ?? []
        )
      return history.withheldMessageIds.length === 0
    },
    readSessionTitle: async (sessionId, context) => {
      const session = await getDb().sessions.get(sessionId)
      if (!session) return "Conversation"
      const { preparePersonalDerivedHistory } = await import("@/lib/execution/personal-visibility")
      const history = await preparePersonalDerivedHistory(
        context.sessionId,
        [{ id: session.id, text: session.title }],
        { sessionId, executionRunId: context.executionRunId, legacyOwnerArtifact: true }
      )
      if (!history.withheldMessageIds.length)
        titleMarks.set(
          sessionId,
          (history.messages[0] as { metadata?: { personalMarks?: PersonalMarkV1[] } }).metadata
            ?.personalMarks ?? []
        )
      return history.withheldMessageIds.length ? "Conversation" : session.title
    },
    buildWindow: async (input) => {
      // The text-only reference builder drops source identities. Keep its
      // bounded, branch-aware selection here and reuse its formatter so the
      // Host can receipt the exact readable messages that make the window.
      const anchor = await db.messages.get(input.messageId)
      if (!anchor || anchor.sessionId !== input.sessionId) return null
      const { before, after } = clampSpan(input.span)
      const table = db.messages.where("[sessionId+createdAt]")
      const earlier = before
        ? (
            await table
              .between([input.sessionId, 0], [input.sessionId, anchor.createdAt], true, true)
              .reverse()
              .limit(before + 1)
              .toArray()
          )
            .filter((row) => row.id !== anchor.id)
            .slice(0, before)
            .reverse()
        : []
      const later = after
        ? (
            await table
              .between(
                [input.sessionId, anchor.createdAt],
                [input.sessionId, Number.MAX_SAFE_INTEGER],
                true,
                true
              )
              .limit(after + 1)
              .toArray()
          )
            .filter((row) => row.id !== anchor.id)
            .slice(0, after)
        : []
      let selected = [...earlier, anchor, ...later]
      let anchorIndex = earlier.length
      if (
        selected.some(
          (row) =>
            row.metadata?.branchGroupId !== undefined || row.metadata?.branchOwnerId !== undefined
        )
      ) {
        const { selectVisibleMessages, useChatStore } = await import("@/stores/chat/chat-store")
        const rows = await table
          .between([input.sessionId, 0], [input.sessionId, Number.MAX_SAFE_INTEGER], true, true)
          .toArray()
        const visible = selectVisibleMessages(
          rows as unknown as UIMessage[],
          useChatStore.getState().sessions[input.sessionId]?.activeBranchByGroup ?? {}
        )
        const at = visible.findIndex((row) => row.id === anchor.id)
        if (at >= 0) {
          const start = Math.max(0, at - before)
          selected = visible.slice(start, at + after + 1) as unknown as typeof selected
          anchorIndex = at - start
        }
      }
      const { preparePersonalHistory } = await import("@/lib/execution/personal-visibility")
      const history = await preparePersonalHistory(input.readerSessionId, selected, {
        executionRunId: input.executionRunId,
      })
      const withheld = new Set(history.withheldMessageIds)
      windowMarks.set(
        input.messageId,
        mergePersonalMarks(
          ...history.messages
            .filter((row) => !withheld.has(row.id) && projectMessageBody(row.parts))
            .map(
              (row) =>
                (row.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)?.personalMarks
            )
        )
      )
      return formatMessageReference(history.messages, anchorIndex)
    },
    now: () => Date.now(),
  }
}

export const toolFamily: ModuleToolFamily = {
  surface: (ctx) => {
    if (!ctx.session?.id) return null
    const projectId = ctx.session.projectId ?? ctx.activeProject?.id
    const config = resolveMemoryConfig(ctx.settings?.memory)
    if (!projectId || !config.enableProjectContinuity || config.temporary) return null
    return { tools: projectHistoryToolEntries() }
  },
  run: async (_name, args, call) => {
    const { recordProjectHistoryEvidence } = await import("@/lib/chat/history-evidence-registry")
    const deps = await resolveProjectHistoryToolDeps()
    let consumed: readonly ProjectHistoryEvidence[] = []
    const result = await runProjectHistorySearch(
      args,
      {
        ...deps,
        // Bound per call rather than in the resolver: the evidence is keyed by
        // the CALLING session, which only the call carries.
        recordEvidence: (evidence) => {
          consumed = evidence
        },
      },
      { sessionId: call.sessionId, executionRunId: call.executionRunId }
    )
    if (result.ok) {
      await deps.markEvidence?.(consumed, {
        sessionId: call.sessionId,
        executionRunId: call.executionRunId,
      })
      recordProjectHistoryEvidence(call.sessionId, consumed)
    }
    return result
  },
}
