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
import { resolveMemoryConfig } from "@/types/memory/memory"
import {
  projectHistoryToolEntries,
  runProjectHistorySearch,
  type ProjectHistoryToolDeps,
} from "./project-history-tool"

type ProjectHistoryDepsResolver = () => Promise<ProjectHistoryToolDeps> | ProjectHistoryToolDeps

let depsOverride: ProjectHistoryDepsResolver | null = null

/** Inject project-history deps (tests / CLI host). Pass `null` to restore the default. */
export function __setProjectHistoryToolDepsForTesting(fn: ProjectHistoryDepsResolver | null): void {
  depsOverride = fn
}

/**
 * Build the project-history tool's host deps.
 *
 * Everything here is an existing reader used as-is: the chat-search engine, the
 * result index, the indexer drain, and the `@msg:` window builder. The tool
 * adds filtering and framing on top; it owns no storage of its own.
 */
async function resolveProjectHistoryToolDeps(): Promise<ProjectHistoryToolDeps> {
  if (depsOverride) return depsOverride()
  const [
    { searchChatHistory },
    { drainSearchIndex },
    { searchChatResults },
    { buildMessageReferenceText },
    { getDb },
  ] = await Promise.all([
    import("@/lib/chat/search/engine"),
    import("@/lib/chat/search/indexer"),
    import("@/lib/db/chat-result-index"),
    import("@/lib/chat/mentions/message-reference"),
    import("@/lib/db/schema"),
  ])
  return {
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
    buildWindow: ({ sessionId, messageId, span }) =>
      buildMessageReferenceText({ sessionId, messageId, span }),
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
    const { recordProjectHistoryEvidence } =
      await import("@/lib/claude/project-history-evidence-registry")
    return runProjectHistorySearch(
      args,
      {
        ...(await resolveProjectHistoryToolDeps()),
        // Bound per call rather than in the resolver: the evidence is keyed by
        // the CALLING session, which only the call carries.
        recordEvidence: (evidence) => recordProjectHistoryEvidence(call.sessionId, evidence),
      },
      { sessionId: call.sessionId }
    )
  },
}
