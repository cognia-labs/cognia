// Lifecycle for workbench asides (sidechats).
//
// An aside is an ordinary `resource-workbench` session row bound to a resource —
// most often the conversation it hangs beside, so the user can check something
// adjacent without spending turns in, or adding noise to, the main thread.
//
// Until now exactly one existed per resource, forever: the id was a pure
// function of the binding, and nothing could create, rename, clear or delete
// one. `ensureResourceWorkbenchSession` still owns the primary aside (the one
// auto-created on first open); everything here is the rest of the lifecycle.
//
// All reads go through the `surfaceBindingKey` index (Dexie v131). Before that
// column existed the only way to find an aside by binding was a full scan of
// every session in the profile.

import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb, withDbReopenRetry } from "./schema"
import { deleteSession, updateSession } from "./sessions"
import { invalidatePersistSnapshot } from "./messages"
import { resolveScopeProjectId } from "./project-scope"
import {
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"
import { inheritableSessionConfig } from "@/lib/chat/session-config-inheritance"
import { selectVisibleMessages } from "@/stores/chat/chat-store"
import {
  newResourceWorkbenchSessionId,
  AsideParentGoneError,
  AsideSessionContentionError,
  surfaceBindingKey,
  type ResourceSessionRepository,
} from "@/lib/context-workbench/resource-session"

async function parentGone(
  db: ReturnType<typeof getDb>,
  binding?: SessionSurfaceBinding
): Promise<boolean> {
  return (
    binding?.kind === "session" &&
    (!(await db.sessions.get(binding.sessionId)) ||
      !!(await db.syncTombstones.get(["sessions", binding.sessionId])))
  )
}

/** Shared Dexie repository for ensuring and migrating resource sidechats. */
export function createResourceSessionRepository(db = getDb()): ResourceSessionRepository {
  return {
    get: (id) => db.sessions.get(id),
    findByBinding: (target) =>
      db.sessions.where("surfaceBindingKey").equals(surfaceBindingKey(target)).first(),
    put: (row) => db.sessions.put(row).then(() => undefined),
    create: (row) =>
      db.transaction("rw", db.sessions, db.syncTombstones, async () => {
        if (await db.sessions.get(row.id)) return { created: false, reason: "occupied" } as const
        if (await parentGone(db, row.surfaceBinding))
          return { created: false, reason: "parent-gone" } as const
        await db.sessions.add(row)
        return { created: true } as const
      }),
    repair: (id, patch) =>
      db.transaction("rw", db.sessions, db.syncTombstones, async () => {
        const row = await db.sessions.get(id)
        if (
          !row ||
          (row.kind !== "resource-workbench" && !row.surfaceBinding && !row.surfaceBindingKey)
        )
          return undefined
        if (await parentGone(db, patch.surfaceBinding ?? row.surfaceBinding))
          throw new AsideParentGoneError()
        await db.sessions.update(id, patch)
        return { ...row, ...patch }
      }),
    update: (id, patch) => db.sessions.update(id, patch),
    resolveProjectId: async (target) =>
      target.kind === "session"
        ? ((await db.sessions.get(target.sessionId))?.projectId ?? (await resolveScopeProjectId()))
        : resolveScopeProjectId(),
  }
}

/**
 * Every aside bound to `binding`, oldest first.
 *
 * Order is by creation, not recency: these render as a stable list the user
 * picks from, and re-sorting on every send would move the entry under the
 * cursor. A replacement primary created after promotion sorts at its new
 * creation time, preserving the order of any additional asides.
 */
export async function listResourceWorkbenchSessions(
  binding: SessionSurfaceBinding,
  db = getDb()
): Promise<ChatSession[]> {
  const rows = await db.sessions
    .where("surfaceBindingKey")
    .equals(surfaceBindingKey(binding))
    .toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** Indexed lookup, excluding promoted rows and other resource bindings. */
export async function listSessionBoundAsides(
  parentId: string,
  db = getDb()
): Promise<ChatSession[]> {
  return (await listResourceWorkbenchSessions({ kind: "session", sessionId: parentId }, db)).filter(
    (row) =>
      row.kind === "resource-workbench" &&
      row.surfaceBinding?.kind === "session" &&
      row.surfaceBinding.sessionId === parentId &&
      row.id !== parentId
  )
}

/** Forget inherited provider memory without deleting any of the aside's own messages. */
export async function retireAsideParentContext(
  id: string,
  db = getDb(),
  clearedAt?: number
): Promise<void> {
  await withTranscriptRuntimeLock(id, async () => {
    if (getDb() !== db) throw new Error("Aside context database scope changed")
    const session = await db.sessions.get(id)
    if (session?.kind !== "resource-workbench" || session.surfaceBinding?.kind !== "session") return
    // A recovered Host action must not retire the fresh provider history a
    // successfully processed aside has acquired since that same clear.
    if (clearedAt !== undefined && (session.asideParentClearedAt ?? 0) >= clearedAt) return
    await invalidateTranscriptRuntime(id)
    if (getDb() !== db) throw new Error("Aside context database scope changed")
    // Runtime invalidation fences queued frames and triggers seeded rebuilds,
    // but deliberately preserves native resume links. These must forget too.
    await db.sessions.update(id, {
      sdkSessionId: undefined,
      forkedFromSdkSessionId: undefined,
      sdkSessionStorage: undefined,
      externalAgentSession: undefined,
      externalAgentGatewaySessions: undefined,
      branchSeed: undefined,
      asideContextCursor: undefined,
      asidePinnedParentMessageIds: undefined,
      asideParentClearedAt:
        clearedAt ??
        Math.max(
          Date.now(),
          (session.lastMessageAt ?? 0) + 1,
          (session.asideParentClearedAt ?? 0) + 1
        ),
      updatedAt: Date.now(),
    })
  })
}

/** Call after the parent's clear commits: runtime IPC cannot run in its Dexie transaction. */
export async function retireSessionAsidesParentContext(
  parentId: string,
  db = getDb()
): Promise<void> {
  let failure: unknown
  for (const aside of await listSessionBoundAsides(parentId, db)) {
    // The parent lock (when held) and these aside locks have distinct keys.
    try {
      await retireAsideParentContext(aside.id, db)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

/**
 * Create an additional aside on the same resource.
 *
 * Inherits the workspace from the conversation it is an aside to (falling back
 * to the active scope for non-session bindings). A row written without a
 * `projectId` is absent from `[projectId+updatedAt]` entirely — invisible to
 * scoped reads AND outside `deleteProjectCascade`, so it would outlive the
 * workspace it belongs to along with its messages.
 */
export async function createResourceWorkbenchSession(
  binding: SessionSurfaceBinding,
  title: string
): Promise<ChatSession> {
  const db = getDb()
  const parent = binding.kind === "session" ? await db.sessions.get(binding.sessionId) : undefined
  const projectId = parent?.projectId ?? (await resolveScopeProjectId())

  // Strictly after every existing aside, not merely `Date.now()`. Two asides
  // created inside the same millisecond — one double-click on "+" — would
  // otherwise share a `createdAt`, and the list they sort into would reorder
  // arbitrarily between reads. The ordering is user-visible and has to be a
  // real total order, not one that happens to hold when the clock cooperates.
  const siblings = await listResourceWorkbenchSessions(binding)
  const newest = siblings.reduce((max, s) => Math.max(max, s.createdAt), 0)
  const now = Math.max(Date.now(), newest + 1)

  const session: ChatSession = {
    ...(parent ? inheritableSessionConfig(parent, "aside") : {}),
    id: newResourceWorkbenchSessionId(binding),
    projectId,
    title,
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    surfaceBindingKey: surfaceBindingKey(binding),
    createdAt: now,
    updatedAt: now,
  }
  const result = await createResourceSessionRepository(db).create!(session)
  if (!result.created) {
    if (result.reason === "parent-gone") throw new AsideParentGoneError()
    throw new AsideSessionContentionError()
  }
  // Fresh row — make sure no stale persist snapshot lingers under a recycled id.
  invalidatePersistSnapshot(session.id)
  return session
}

/** Record delivered provider context only while its SDK history is still current. */
export async function advanceResourceAsideContextCursor(
  id: string,
  cursor: NonNullable<ChatSession["asideContextCursor"]>
): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((session) => {
      // Clear, promotion, or a replacement SDK can race an accepted dispatch.
      // Check and write in one IndexedDB transaction so stale events cannot
      // restore a cursor after the history it described has been discarded.
      if (
        session.kind === "resource-workbench" &&
        session.surfaceBinding?.kind === "session" &&
        session.sdkSessionId === cursor.sdkSessionId
      ) {
        session.asideContextCursor = cursor
      }
    })
}

/** Prune against the canonical branch, never against privacy-filtered placeholders or UI caches. */
export async function updateAsideParentMessagePins(
  id: string,
  change?: { messageId: string; included: boolean }
): Promise<string[]> {
  const db = getDb()
  return db.transaction("rw", db.sessions, db.messages, async () => {
    const aside = await db.sessions.get(id)
    if (aside?.kind !== "resource-workbench" || aside.surfaceBinding?.kind !== "session") return []
    if (!change && !aside.asidePinnedParentMessageIds?.length) return []
    const parent = await db.sessions.get(aside.surfaceBinding.sessionId)
    const rows = parent
      ? await db.messages.where("sessionId").equals(parent.id).sortBy("createdAt")
      : []
    const visible = new Set(
      selectVisibleMessages(rows, parent?.activeBranchByGroup ?? {}).map((row) => row.id)
    )
    const pins = new Set(
      (aside.asidePinnedParentMessageIds ?? []).filter((pin) => visible.has(pin))
    )
    if (change?.included && visible.has(change.messageId)) pins.add(change.messageId)
    if (change && !change.included) pins.delete(change.messageId)
    const next = [...pins]
    const acknowledgements = aside.asideContextCursor?.pinnedParentMessageFingerprints
    const keptAcknowledgements = acknowledgements
      ? Object.fromEntries(Object.entries(acknowledgements).filter(([pin]) => pins.has(pin)))
      : undefined
    if (JSON.stringify(next) !== JSON.stringify(aside.asidePinnedParentMessageIds ?? []))
      await updateSession(id, {
        asidePinnedParentMessageIds: next.length ? next : undefined,
        ...(aside.asideContextCursor && acknowledgements
          ? {
              asideContextCursor: {
                ...aside.asideContextCursor,
                pinnedParentMessageFingerprints: keptAcknowledgements,
              },
            }
          : {}),
      })
    return next
  })
}

/** A queued external event must not restore links retired by a parent clear. */
export async function advanceResourceAsideExternalSession(
  id: string,
  links: Pick<ChatSession, "externalAgentSession" | "externalAgentGatewaySessions">,
  expected: Pick<ChatSession, "runtimeTranscriptGeneration" | "asideParentClearedAt">
): Promise<boolean> {
  const db = getDb()
  let accepted = false
  await db.transaction("rw", db.sessions, async () => {
    const session = await db.sessions.get(id)
    if (
      session?.kind !== "resource-workbench" ||
      session.surfaceBinding?.kind !== "session" ||
      session.runtimeTranscriptGeneration !== expected.runtimeTranscriptGeneration ||
      session.asideParentClearedAt !== expected.asideParentClearedAt
    )
      return
    // Preserve the usual write guard and lifecycle notification inside the
    // same transaction as the generation/parent-clear comparison.
    await updateSession(id, links)
    accepted = true
  })
  return accepted
}

/** Rename an aside. Trimmed; an empty name is rejected rather than persisted. */
export async function renameResourceWorkbenchSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error("An aside needs a name")
  await updateSession(id, { title: trimmed })
}

/**
 * Drop an aside's messages, keeping the aside itself.
 *
 * Also clears the SDK linkage: the provider-side conversation still holds the
 * turns we just deleted, so resuming it would reintroduce the context the user
 * asked to be rid of. Mirrors what "Clear conversation" does for a main thread.
 */
export async function clearResourceWorkbenchSession(id: string): Promise<void> {
  const db = getDb()
  await withTranscriptRuntimeLock(id, async () => {
    // Retire the live provider loop and fence its queued frames before clearing
    // local rows; otherwise a late reply can repopulate the deleted thread.
    await invalidateTranscriptRuntime(id)
    await db.transaction("rw", db.messages, db.sessions, async () => {
      await db.messages.where("sessionId").equals(id).delete()
      await db.sessions.update(id, {
        sdkSessionId: undefined,
        forkedFromSdkSessionId: undefined,
        sdkSessionStorage: undefined,
        externalAgentSession: undefined,
        externalAgentGatewaySessions: undefined,
        branchSeed: undefined,
        spawnedTask: undefined,
        asideContextCursor: undefined,
        asidePinnedParentMessageIds: undefined,
        runtimeTranscriptInvalidated: undefined,
        workingSet: undefined,
        activeBranchByGroup: undefined,
        lastMessagePreview: undefined,
        lastMessageAt: undefined,
        updatedAt: Date.now(),
      })
    })
  })
  invalidatePersistSnapshot(id)
}

/**
 * Delete an aside and its messages.
 *
 * Routed through `deleteSession` rather than a local delete so the aside gets
 * the same cascade as any other conversation — usage rows and sync tombstones
 * included. An aside that skipped tombstoning would resurrect on the next pull.
 */
export async function deleteResourceWorkbenchSession(id: string): Promise<void> {
  await deleteSession(id)
}

/**
 * Turn an aside into an ordinary conversation, in place.
 *
 * The messages, the id and the workspace all stay put; only the markers that
 * kept it out of the conversation rail are cleared. Keeping the id means
 * permalinks into the aside survive being promoted.
 */
export async function promoteResourceWorkbenchSession(id: string): Promise<ChatSession> {
  const db = getDb()
  const existing = await db.sessions.get(id)
  if (!existing) throw new Error(`Cannot promote: session ${id} not found`)
  if (existing.kind !== "resource-workbench") {
    throw new Error(`Cannot promote: session ${id} is not an aside`)
  }

  // A promoted aside must land in a workspace or it is unreachable from the
  // sidebar — the exact failure the v131 backfill exists to repair.
  const projectId = existing.projectId ?? (await resolveScopeProjectId())
  let promoted: ChatSession | undefined
  try {
    await withDbReopenRetry(() => {
      const transactionDb = getDb()
      return transactionDb.transaction(
        "rw",
        transactionDb.sessions,
        transactionDb.syncTombstones,
        async () => {
          const current = await transactionDb.sessions.get(id)
          if (!current) throw new Error(`Cannot promote: session ${id} not found`)
          if (current.kind !== "resource-workbench")
            throw new Error(`Cannot promote: session ${id} is not an aside`)
          if (await parentGone(transactionDb, current.surfaceBinding))
            throw new AsideParentGoneError()
          await transactionDb.sessions
            .where("id")
            .equals(id)
            .modify((session) => {
              session.kind = "direct"
              session.projectId ??= projectId
              session.updatedAt = Date.now()
              delete session.visibility
              delete session.surfaceBinding
              delete session.surfaceBindingKey
            })
          promoted = await transactionDb.sessions.get(id)
        }
      )
    })
  } catch (error) {
    if (error instanceof AsideParentGoneError) throw error
    const durable = await getDb().sessions.get(id)
    const promotedDurably =
      durable?.kind === "direct" &&
      durable.projectId === projectId &&
      durable.visibility === undefined &&
      durable.surfaceBinding === undefined &&
      durable.surfaceBindingKey === undefined
    if (!promotedDurably) throw error
    promoted = durable
  }
  return promoted!
}
