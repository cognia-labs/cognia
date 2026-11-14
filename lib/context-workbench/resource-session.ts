import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import type { ContextResource } from "@/types/context-workbench"
import {
  inheritableSessionConfig,
  missingInheritedSessionConfig,
} from "@/lib/chat/session-config-inheritance"

export interface ResourceSessionRepository {
  get: (id: string) => Promise<ChatSession | undefined>
  findByBinding?: (binding: SessionSurfaceBinding) => Promise<ChatSession | undefined>
  put: (session: ChatSession) => Promise<void>
  create?: (session: ChatSession) => Promise<ResourceSessionCreateResult>
  /** Return the fresh repaired row, or undefined if it was removed/promoted. */
  repair?: (id: string, patch: Partial<ChatSession>) => Promise<ChatSession | undefined>
  update: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  now?: () => number
  /**
   * Owning workspace for a newly-created embedded session. Injected rather than
   * imported so repository operations can be unit-tested against a plain
   * in-memory implementation.
   *
   * Load-bearing, not cosmetic: `listScopedSessions` reads through the
   * `[projectId+updatedAt]` compound index, and Dexie does not index a row whose
   * key path contains `undefined`. A sidechat written without one is invisible
   * to every scoped query — including the `deleteProjectCascade` sweep, so it
   * and its messages would survive deletion of the workspace they belong to
   * with no surface left that can reach them. Absent on legacy rows only; the
   * v131 upgrade backfills those.
   */
  resolveProjectId?: (binding: SessionSurfaceBinding) => Promise<string | undefined>
}

export type ResourceSessionCreateResult =
  { created: true } | { created: false; reason: "occupied" | "parent-gone" }

export class AsideParentGoneError extends Error {
  readonly code = "aside_parent_gone"
  constructor() {
    super("The aside's parent conversation no longer exists")
    this.name = "AsideParentGoneError"
  }
}

export class AsideSessionContentionError extends Error {
  readonly code = "aside_session_contention"
  constructor() {
    super("The aside changed repeatedly while opening")
    this.name = "AsideSessionContentionError"
  }
}

/**
 * Maps a workbench resource onto the persisted binding of its embedded chat
 * session.
 *
 * A `session` resource maps to a binding too: a conversation can own a
 * *sidechat*, an aside for checking something without spending turns in the
 * main thread. The aside is an ordinary `resource-workbench` row like every
 * other binding — it is the main session that is the "resource" here.
 *
 * A `resource-workbench` session is not itself bindable: letting an aside own
 * an aside would nest without limit, and there is no surface that would render
 * the second level anyway. Callers pass the resource, so the guard belongs
 * where the resource is built (`appliesTo`). Prefixed IDs fail closed unless
 * the caller has positively established promotion from the current row.
 */
export function surfaceBindingForContextResource(
  resource: ContextResource,
  knownPromoted = false
): SessionSurfaceBinding | null {
  switch (resource.kind) {
    case "canvas-document":
      return { kind: "canvas-document", documentId: resource.documentId }
    case "project-file":
      return {
        kind: "project-file",
        projectId: resource.projectId,
        rootId: resource.rootId,
        relPath: resource.relPath,
      }
    case "artifact":
      return { kind: "artifact", artifactId: resource.artifactId }
    case "workflow":
      return { kind: "workflow", workflowId: resource.workflowId }
    case "session":
      // IDs survive promotion, but an unknown prefixed ID is still an aside.
      // "none" remains the dock's no-conversation placeholder.
      return resource.sessionId === "none" ||
        (!knownPromoted && isEmbeddedAside(resource.sessionId))
        ? null
        : { kind: "session", sessionId: resource.sessionId }
  }
}

/**
 * Flat, indexable rendering of a binding — the value persisted as
 * `ChatSession.surfaceBindingKey` (Dexie v131).
 *
 * Shared with the v131 backfill so a row written today and a row rewritten by
 * the upgrade produce byte-identical keys; a second derivation would drift.
 * Carries no workbench instance suffix, so every aside of one conversation
 * shares a key and can be enumerated with a single `.equals()`.
 */
export function surfaceBindingKey(binding: SessionSurfaceBinding): string {
  return bindingParts(binding).map(encodeURIComponent).join(":")
}

function bindingParts(binding: SessionSurfaceBinding): string[] {
  switch (binding.kind) {
    case "canvas-document":
      return ["canvas", binding.documentId]
    case "project-file":
      return ["project", binding.projectId, binding.rootId, binding.relPath]
    case "artifact":
      return ["artifact", binding.artifactId]
    case "workflow":
      return ["workflow", binding.workflowId]
    case "session":
      return ["session", binding.sessionId]
  }
}

/**
 * Id of a resource's **primary** aside — the one `ensureResourceWorkbenchSession`
 * creates on first open.
 *
 * Deliberately derived purely from the binding and NOT from
 * `workbenchInstanceId`: the same conversation opened in a desktop dock and a
 * mobile sheet must land on the same thread, and every row written before
 * multi-aside support uses exactly this form. Additional asides get a minted id
 * from {@link newResourceWorkbenchSessionId} instead. After promotion, ensure
 * probes deterministic generation suffixes without modifying the promoted row.
 */
export function resourceWorkbenchSessionId(
  binding: SessionSurfaceBinding,
  _workbenchInstanceId?: string
): string {
  return `resource-workbench:${surfaceBindingKey(binding)}`
}

/** Primary generations retain the initial primary's lifecycle protections. */
export function isPrimaryResourceWorkbenchSessionId(
  binding: SessionSurfaceBinding,
  sessionId: string
): boolean {
  const primaryId = resourceWorkbenchSessionId(binding)
  if (sessionId === primaryId) return true
  const generationPrefix = `${primaryId}#primary:`
  return (
    sessionId.startsWith(generationPrefix) &&
    /^[1-9]\d*$/.test(sessionId.slice(generationPrefix.length))
  )
}

/**
 * Id for an ADDITIONAL aside on the same resource.
 *
 * Shares the `surfaceBindingKey` column with its siblings — that is what makes
 * "every aside of this conversation" a single indexed lookup — and differs only
 * by a minted suffix. The suffix is not the workbench instance id: asides are
 * per-conversation, not per-window, and keying them to a window would give the
 * same conversation different asides in a dock and a sheet.
 */
export function newResourceWorkbenchSessionId(binding: SessionSurfaceBinding): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `${resourceWorkbenchSessionId(binding)}#${suffix}`
}

/**
 * Patch that turns an embedded aside into an ordinary conversation.
 *
 * Every marker that keeps it out of the rails has to go together:
 * `isEmbeddedSession` reads `kind` OR `visibility`, so clearing one and not the
 * other leaves the row hidden with no surface able to render it. Dexie deletes
 * a field on `undefined`, which is what drops it out of the
 * `surfaceBindingKey` index.
 */
export function promoteEmbeddedSessionPatch(): Partial<ChatSession> {
  return {
    kind: "direct",
    visibility: undefined,
    surfaceBinding: undefined,
    surfaceBindingKey: undefined,
  }
}

/** Opening a legacy aside fills configuration gaps without resetting user choices. */
export async function fillResourceSessionConfigGaps(
  session: ChatSession,
  binding: SessionSurfaceBinding,
  repository: Pick<ResourceSessionRepository, "get" | "update">
): Promise<ChatSession> {
  if (binding.kind !== "session") return session
  const parent = await repository.get(binding.sessionId)
  if (!parent) return session
  const patch = missingInheritedSessionConfig(session, parent)
  if (Object.keys(patch).length === 0) return session
  await repository.update(session.id, patch)
  return { ...session, ...patch }
}

function wasPromoted(
  session: Pick<ChatSession, "kind" | "surfaceBinding" | "surfaceBindingKey">
): boolean {
  return (
    session.kind !== "resource-workbench" && !session.surfaceBinding && !session.surfaceBindingKey
  )
}

/** Unknown prefixed IDs remain asides until their own row proves promotion. */
export function isEmbeddedAside(
  sessionId: string | null | undefined,
  session?: Pick<
    ChatSession,
    "id" | "kind" | "visibility" | "surfaceBinding" | "surfaceBindingKey"
  > | null
): boolean {
  return (
    !!sessionId?.startsWith("resource-workbench:") &&
    !(session?.id === sessionId && wasPromoted(session) && session.visibility !== "embedded")
  )
}

export async function ensureResourceWorkbenchSession(
  binding: SessionSurfaceBinding,
  title: string,
  repository: ResourceSessionRepository,
  workbenchInstanceId?: string
): Promise<ChatSession> {
  const primaryId = resourceWorkbenchSessionId(binding, workbenchInstanceId)
  // Bound contention retries, while allowing any number of already-promoted
  // generations to retain their stable permalinks.
  for (let attempt = 0; attempt < 8; attempt++) {
    let id = primaryId
    const bindingKey = surfaceBindingKey(binding)
    let existing = await repository.get(id)
    // Promotion preserves the old row and its permalinks. Deterministic generation
    // ids let separate windows converge on the next primary without resurrecting
    // any promoted conversation or selecting an unrelated additional aside.
    let generation = 0
    while (existing && wasPromoted(existing)) {
      id = `${primaryId}#primary:${++generation}`
      existing = await repository.get(id)
    }
    if (!existing && generation === 0) {
      const bound = await repository.findByBinding?.(binding)
      if (bound && !wasPromoted(bound)) existing = bound
    }
    if (existing) {
      // `surfaceBindingKey` and `projectId` join the drift check: a row written
      // before v131 carries neither, and the workbench is the only place that
      // reliably knows the binding — so repair it here rather than leaving the
      // row un-indexed and outside the workspace cascade until the next upgrade.
      if (
        existing.kind !== "resource-workbench" ||
        existing.visibility !== "embedded" ||
        existing.surfaceBindingKey !== bindingKey ||
        existing.projectId === undefined ||
        JSON.stringify(existing.surfaceBinding) !== JSON.stringify(binding)
      ) {
        const patch: Partial<ChatSession> = {
          kind: "resource-workbench",
          visibility: "embedded",
          surfaceBinding: binding,
          surfaceBindingKey: bindingKey,
          updatedAt: repository.now?.() ?? Date.now(),
        }
        // Only ever fills a gap — an existing workspace stays put, so repairing a
        // legacy row can never move a sidechat out from under its conversation.
        if (existing.projectId === undefined) {
          const projectId = await repository.resolveProjectId?.(binding)
          if (projectId !== undefined) patch.projectId = projectId
        }
        if (repository.repair) {
          const repaired = await repository.repair(existing.id, patch)
          if (!repaired) continue
          return fillResourceSessionConfigGaps(repaired, binding, repository)
        }
        await repository.update(existing.id, patch)
        return fillResourceSessionConfigGaps({ ...existing, ...patch }, binding, repository)
      }
      return fillResourceSessionConfigGaps(existing, binding, repository)
    }

    const now = repository.now?.() ?? Date.now()
    const parent = binding.kind === "session" ? await repository.get(binding.sessionId) : undefined
    const session: ChatSession = {
      ...(parent ? inheritableSessionConfig(parent, "aside") : {}),
      id,
      title,
      kind: "resource-workbench",
      visibility: "embedded",
      surfaceBinding: binding,
      surfaceBindingKey: bindingKey,
      createdAt: now,
      updatedAt: now,
    }
    const projectId = await repository.resolveProjectId?.(binding)
    if (projectId !== undefined) session.projectId = projectId
    if (repository.create) {
      const result = await repository.create(session)
      if (!result.created) {
        if (result.reason === "parent-gone") throw new AsideParentGoneError()
        continue
      }
    } else {
      await repository.put(session)
    }
    return session
  }
  throw new AsideSessionContentionError()
}

export async function migrateResourceSessionBinding(
  sessionId: string,
  binding: SessionSurfaceBinding,
  repository: Pick<ResourceSessionRepository, "update" | "now">
): Promise<void> {
  await repository.update(sessionId, {
    surfaceBinding: binding,
    // Must move with the binding — a stale key would leave the row enumerable
    // under the resource it no longer belongs to.
    surfaceBindingKey: surfaceBindingKey(binding),
    updatedAt: repository.now?.() ?? Date.now(),
  })
}
