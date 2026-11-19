/**
 * Bring one conversation on screen from anywhere else in the app.
 *
 * Every "open this conversation" that starts outside the conversation list —
 * the ⌘K palette, the Control Center, an Inbox thread's "open in chat", a
 * scheduled run's link — needs the same three things, and each one that was
 * skipped showed up as its own bug:
 *
 * - **The workspace.** The chat pane only reads the active workspace's
 *   conversations (`useSessions`), so a conversation of another workspace is
 *   followed there first; focusing it without the switch left the pane on
 *   whatever was open before.
 * - **The guild.** A team conversation opens under its team, a direct one
 *   under Direct Messages (`guildFromSession`), never a fixed guild.
 * - **Its row.** The list's own narrowing (a folded folder or group, a search
 *   still in the field, the other archive view) can hide it, so the list is
 *   asked once to reveal it (`requestConversationReveal`,
 *   `hooks/chat/use-conversation-reveal.ts`), the same request a new
 *   conversation makes. The list undoes only what actually hides the row.
 *
 * Routing to the chat pane is the caller's: only it knows whether it is
 * already there.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { guildFromSession } from "@/lib/chat/session-guild"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"

/**
 * Follow `session` into its workspace and guild, focus it through `select`,
 * and ask the conversation list to show its row. `session` may be unknown
 * (the row could not be read): the id is still focused, with nothing to
 * follow.
 */
export function focusSession(
  session: Pick<ChatSession, "projectId" | "kind" | "teamId"> | undefined,
  id: string,
  select: (id: string) => void
): void {
  if (session?.projectId) {
    const projectState = useProjectStore.getState()
    if (session.projectId !== projectState.activeProjectId) {
      projectState.setActiveProject(session.projectId)
    }
  }
  if (session) useUIStore.getState().setSelectedGuild(guildFromSession(session))
  select(id)
  useUIStore.getState().requestConversationReveal(id)
}

/**
 * {@link focusSession} for a caller that only holds the id: reads the row
 * first (a missing or unreadable row still focuses the id) and focuses it in
 * the chat store.
 */
export async function focusSessionInItsWorkspace(sessionId: string): Promise<void> {
  const [{ useChatStore }, { getSession }] = await Promise.all([
    import("@/stores/chat"),
    import("@/lib/db/sessions"),
  ])
  const session = await getSession(sessionId).catch(() => undefined)
  focusSession(session ?? undefined, sessionId, (id) =>
    useChatStore.getState().setActiveSession(id)
  )
}

/** The route the chat pane lives on, in every shell. */
export const CHAT_ROUTE = "/"

/** Whether `pathname` is already the chat pane's route. */
export function isOnChatRoute(pathname: string | null | undefined): boolean {
  return (pathname ?? CHAT_ROUTE) === CHAT_ROUTE
}
