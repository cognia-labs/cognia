/**
 * The one way a conversation's title is written (ADR-0253 D06).
 *
 * A title has two authors and two carriers. A person renames; a machine names
 * (the first message's preview, then the utility model's title after the first
 * turn). Where a Host owns the conversation — a paired client whose session
 * channel the Host has confirmed — a rename is a HostState `session.rename`
 * the Host applies and confirms, and machine titles are the Host's own to
 * write (`host-state-service.ts` names it from the first message and again
 * after the first turn): a device copy would race the Host and be replaced by
 * the next projection. Everywhere else both land on the local row, a rename
 * clearing `titleAuto` so no machine title replaces it again.
 *
 * Every surface that titled a conversation used to make this choice itself,
 * or skip it: the chat send path, the turn-complete upgrade, the focus retry,
 * the room runner and the sidebar rename. One module, so none can.
 */

import { isPlaceholderTitle } from "@/lib/chat/placeholder-title"
import {
  enqueueHostStateIntentIfAvailable,
  hostStateSessionIntentAvailable,
} from "@/lib/db/mobile-outbound-queue"
import { getSession, updateSession } from "@/lib/db/sessions"

/** The local row writer, injectable for a caller that carries its own db. */
export type SessionTitleUpdate = (
  sessionId: string,
  patch: { title: string; titleAuto: boolean }
) => Promise<void>

/**
 * A person's rename: to the Host when it owns the conversation, else onto the
 * local row, opting it out of machine titles either way.
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options: { isCurrentScope?: () => boolean } = {}
): Promise<void> {
  if (
    await enqueueHostStateIntentIfAvailable({
      sessionId,
      action: { kind: "session.rename", title },
    })
  ) {
    return
  }
  if (options.isCurrentScope && !options.isCurrentScope()) return
  await updateSession(sessionId, { title, titleAuto: false })
}

/**
 * Whether this device writes the conversation's machine titles. False when a
 * Host owns it: the Host titles its own conversations. Ask before spending a
 * model call on a title only the Host may write.
 */
export async function autoSessionTitlesWrittenHere(sessionId: string): Promise<boolean> {
  return !(await hostStateSessionIntentAvailable(sessionId))
}

/**
 * Whether a machine may still replace the conversation's title: no person has
 * renamed it. Re-read fresh, so a rename that landed while a model ran wins.
 * A row that is gone is not refused here; the write itself finds nothing.
 */
export async function sessionTitleStillAuto(sessionId: string): Promise<boolean> {
  const fresh = await getSession(sessionId).catch(() => undefined)
  return !fresh || fresh.titleAuto !== false
}

/**
 * A machine title. Written onto the local row, marked `titleAuto`, only where
 * this device owns the conversation's titles. `overPlaceholderOnly` is the
 * instant preview's rule: it never replaces any title the row already has,
 * read fresh so a concurrent write is not overwritten from a stale snapshot.
 * Returns whether the title was written.
 */
export async function writeAutoSessionTitle(
  sessionId: string,
  title: string,
  options: { overPlaceholderOnly?: boolean; update?: SessionTitleUpdate } = {}
): Promise<boolean> {
  if (!title) return false
  if (!(await autoSessionTitlesWrittenHere(sessionId))) return false
  if (options.overPlaceholderOnly) {
    const fresh = await getSession(sessionId).catch(() => undefined)
    if (fresh && !isPlaceholderTitle(fresh.title)) return false
  }
  await (options.update ?? updateSession)(sessionId, { title, titleAuto: true })
  return true
}
