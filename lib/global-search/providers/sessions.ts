/**
 * Conversations by title (ADR-0129).
 *
 * Reads the cross-workspace session list the dialog already holds (no Dexie
 * read per keystroke), applies the exposure contract for global search, then
 * the archive / workspace filters, and ranks titles with the shared scorer.
 * The empty query suggests the most recently updated conversations.
 */

import { MessageSquareIcon, UsersIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { filterExposedSessions, withScopedAsides } from "@/lib/chat/session-exposure"
import { filterPersonalAsideParents } from "@/lib/chat/search/engine"
import { matchTitles } from "./helpers"
import type {
  GlobalSearchContext,
  GlobalSearchItem,
  GlobalSearchProvider,
  ParsedGlobalSearchQuery,
} from "../types"

export const SESSIONS_PROVIDER_ID = "builtin.sessions"

function isArchived(session: ChatSession): boolean {
  return (session as { archivedAt?: number | null }).archivedAt != null
}

function sessionTimestamp(session: ChatSession): number {
  const last = (session as { lastMessageAt?: number }).lastMessageAt
  return typeof last === "number" && last > session.updatedAt ? last : session.updatedAt
}

/**
 * Sessions the current query is allowed to see. Platform-bound (IM) sessions
 * are the inbox provider's (`./inbox`): they open in the Inbox route, and
 * listing them here too would show every IM conversation twice.
 */
export function visibleSessions(
  ctx: GlobalSearchContext,
  filters: ParsedGlobalSearchQuery["filters"]
): ChatSession[] {
  const exposed = filterExposedSessions(ctx.sessions, "global-search")
  const eligible = exposed.filter((session) => {
    if (session.platformBinding) return false
    if (!filters.archived && isArchived(session)) return false
    // A conversation with no workspace is shared, not foreign (`byProjectId`):
    // the chat list shows it in whichever workspace is open
    // (`listWorkspaceSessions`), so a search scoped to that workspace must not
    // be the one place it cannot be found.
    if (filters.workspace === "current" && ctx.activeProjectId && session.projectId) {
      if (session.projectId !== ctx.activeProjectId) return false
    }
    return true
  })
  return withScopedAsides(eligible, ctx.sessions)
}

function workspaceName(
  ctx: GlobalSearchContext,
  projectId: string | undefined
): string | undefined {
  if (!projectId) return undefined
  return ctx.workspaces.find((p) => p.id === projectId)?.name
}

export function sessionToItem(
  session: ChatSession,
  ctx: GlobalSearchContext,
  score: number,
  titlePositions: readonly number[] = []
): GlobalSearchItem {
  const title = session.title?.trim() || ctx.t("globalSearch.untitledConversation")
  const preview = (session as { lastMessagePreview?: string }).lastMessagePreview
  const showWorkspace = ctx.workspaces.length > 1
  const parentId =
    session.kind === "resource-workbench" && session.surfaceBinding?.kind === "session"
      ? session.surfaceBinding.sessionId
      : undefined
  const parent = ctx.sessions.find((s) => s.id === parentId)
  return {
    id: `session:${session.id}`,
    kind: "session",
    title,
    titlePositions,
    subtitle: parent
      ? ctx.t("globalSearch.sideChatOf", {
          title: parent.title?.trim() || ctx.t("globalSearch.untitledConversation"),
        })
      : preview?.trim() || undefined,
    meta: showWorkspace ? workspaceName(ctx, parent?.projectId ?? session.projectId) : undefined,
    icon: { lucide: session.kind === "team" ? UsersIcon : MessageSquareIcon },
    score,
    timestamp: sessionTimestamp(session),
    extra: {
      archived: isArchived(parent ?? session),
      current: ctx.activeSessionId === session.id,
    },
    action: {
      type: "open-session",
      sessionId: session.id,
      ...(parentId ? { parentSessionId: parentId } : {}),
    },
  }
}

/** Preserve ordinary rows while closing newly searchable asides of withheld parents. */
async function personalVisibleSessions(
  ctx: GlobalSearchContext,
  filters: ParsedGlobalSearchQuery["filters"]
) {
  const visible = visibleSessions(ctx, filters)
  const parents = filterExposedSessions(visible, "global-search")
  const scoped = withScopedAsides(await filterPersonalAsideParents(parents, visible), visible)
  const eligible = new Set([...parents, ...scoped].map((s) => s.id))
  return visible.filter((s) => eligible.has(s.id))
}

export const sessionsProvider: GlobalSearchProvider = {
  id: SESSIONS_PROVIDER_ID,
  kind: "session",
  async search({ query, ctx, limit }) {
    const rows = await personalVisibleSessions(ctx, query.filters)
    const { hits, total, truncated } = matchTitles(rows, query.needle, {
      getTitle: (s) => s.title ?? "",
      // The id is a legitimate secondary: people paste session ids from logs.
      getKeywords: (s) => [s.id],
      getTimestamp: sessionTimestamp,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => sessionToItem(row, ctx, match.score, match.positions)),
      total,
      truncated,
    }
  },
  async suggest({ ctx, limit }) {
    const rows = await personalVisibleSessions(ctx, {})
    return rows
      .slice()
      .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
      .slice(0, limit)
      .map((session, index) => sessionToItem(session, ctx, 1 - index / (limit + 1)))
  },
}
