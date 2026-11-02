/**
 * Reconcile one binding (spec 2026-09-06, D1 and D2).
 *
 * For every remote item the provider reports:
 *   - no local issue carries its ref: create one (import) with the ref.
 *   - a local issue carries it: compare field by field.
 *       remote changed since the ref's last sync  = remoteUpdatedAt > syncedAt
 *       local changed since then                  = last non-sync event on that field
 *       both                                      = conflict, newer side wins (D2),
 *                                                   the loser is recorded as an event
 *       only remote                               = apply remote
 *       only local                                = push (below)
 *       first reconciliation (no syncedAt)        = remote is authoritative
 *
 * Then, for every local issue with a ref on this binding, the fields a person
 * changed since the last sync and that the remote did not overwrite go to the
 * provider's `push` in one patch. A queued push (approval gate) leaves the ref
 * untouched so the next pass repeats it under the same idempotency key.
 *
 * Cycles come first so `cycleIdOf` can resolve while items are applied.
 * Links (pull requests) come last and only add refs.
 */

import {
  createIssueWithResult,
  getIssueByExternalKey,
  linkIssueExternal,
  listIssuesByExternalKey,
  recordIssuePullRequestChecks,
  recordIssuePullRequestState,
  touchIssueExternalRef,
  setIssueExternalRefDeparted,
  adoptIssueExternalRefBinding,
} from "@/lib/db/issues"
import { createIssueCycle, listIssueCycles, updateIssueCycle } from "@/lib/db/issue-cycles"
import { listIssueEvents } from "@/lib/db/issue-events"
import { hasActiveIssueRun } from "@/lib/db/issue-runs"
import { listLabels } from "@/lib/db/labels"
import { getDb } from "@/lib/db/schema"
import { appendIssueEvent } from "@/lib/db/issue-events"
import type { Issue, IssueExternalRef, IssueStatus, IssueSyncField } from "@/types/issues"
import { externalKeyOf, ISSUE_SYNC_FIELDS, statusCategoryOf, syncActorFor } from "@/types/issues"
import { runExternalSync } from "@/lib/external-services/sync/core"
import type { ExternalSyncTarget } from "@/lib/external-services/sync/types"
import type { LabelRow } from "@/types/labels"
import {
  applyRemoteField,
  ensureIssueLabels,
  fieldValuesDiffer,
  localFieldValue,
  remoteFieldValue,
  type RemoteFieldValue,
} from "./apply"
import { lastLocalChangeAt, localEditorOf } from "./field-clock"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  ReconcileOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
  PullPage,
} from "./types"

export interface ReconcileOptions {
  full?: boolean
  now?: () => number
  signal?: AbortSignal
}

/**
 * What a remote that only knows open versus closed can tell apart. `todo` and
 * `in_progress` are both "open" to it, so a coarse compare treats them as one.
 */
export function coarseStatusBucket(status: IssueStatus): "open" | "done" | "canceled" {
  const category = statusCategoryOf(status)
  if (category === "completed") return "done"
  if (category === "canceled") return "canceled"
  return "open"
}

/** Stable per (issue, patch) so a re-queued push deduplicates upstream. */
export function pushIdempotencyKey(issueId: string, patch: RemotePatch): string {
  const body = JSON.stringify(patch, Object.keys(patch).sort())
  let hash = 0
  for (let i = 0; i < body.length; i += 1) hash = (hash * 31 + body.charCodeAt(i)) | 0
  return `issue-sync:${issueId}:${(hash >>> 0).toString(16)}`
}

async function upsertCycles(
  binding: IssueSyncBinding,
  cycles: readonly RemoteCycle[],
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const byExternalId = new Map<string, string>()
  // An external record may be imported into more than one workspace. Never
  // let a global ref lookup transfer one workspace's planning row to another.
  const owned = (await listIssueCycles({ projectId: binding.projectId })).filter(
    (cycle) => cycle.issueProjectId === binding.issueProjectId
  )
  for (const remote of cycles) {
    signal?.throwIfAborted()
    const matches = (externalId: string) =>
      owned.find((cycle) =>
        cycle.externalRefs.some(
          (ref) =>
            ref.provider === binding.providerId &&
            ref.externalId === externalId &&
            ref.meta?.binding === binding.key
        )
      )
    const existing =
      matches(remote.externalId) ??
      remote.legacyExternalIds?.map(matches).find((cycle) => cycle !== undefined)
    const ref: IssueExternalRef = {
      provider: binding.providerId,
      externalId: remote.externalId,
      ...(remote.url ? { url: remote.url } : {}),
      meta: { binding: binding.key },
    }
    if (existing) {
      await updateIssueCycle(existing.id, {
        name: remote.name,
        ...(remote.status ? { status: remote.status } : {}),
        startsAt: remote.startsAt ?? null,
        endsAt: remote.endsAt ?? null,
        externalRefs: [
          ...existing.externalRefs.filter(
            (r) =>
              externalKeyOf(r) !== externalKeyOf(ref) &&
              !(
                r.provider === binding.providerId &&
                r.meta?.binding === binding.key &&
                remote.legacyExternalIds?.includes(r.externalId)
              )
          ),
          ref,
        ],
      })
      byExternalId.set(remote.externalId, existing.id)
    } else {
      const created = await createIssueCycle({
        projectId: binding.projectId,
        issueProjectId: binding.issueProjectId,
        kind: remote.kind,
        name: remote.name,
        ...(remote.status ? { status: remote.status } : {}),
        ...(remote.startsAt !== undefined ? { startsAt: remote.startsAt } : {}),
        ...(remote.endsAt !== undefined ? { endsAt: remote.endsAt } : {}),
        externalRefs: [ref],
      })
      owned.push(created)
      byExternalId.set(remote.externalId, created.id)
    }
  }
  return byExternalId
}

function refOf(
  issue: Issue,
  binding: IssueSyncBinding,
  externalId: string
): IssueExternalRef | undefined {
  return (issue.externalRefs ?? []).find(
    (ref) =>
      ref.provider === binding.providerId &&
      ref.externalId === externalId &&
      ref.meta?.binding === binding.key
  )
}

/**
 * Does a newly imported item land in triage? Only when its binding opted in
 * (`GithubRepoSyncSettings.triageNewIssues`) and the item is open and nobody
 * is assigned: a closed item has nothing to decide, an assigned one was
 * already decided remotely.
 */
export function triageOnImport(
  binding: Pick<IssueSyncBinding, "resource">,
  remote: Pick<RemoteIssue, "status" | "assigneeLabel">
): boolean {
  const resource = binding.resource
  if (resource.kind !== "github-repo" || resource.sync?.triageNewIssues !== true) return false
  const category = statusCategoryOf(remote.status)
  return (category === "unstarted" || category === "started") && !remote.assigneeLabel
}

async function importRemote(
  binding: IssueSyncBinding,
  remote: RemoteIssue,
  cycleIdOf: (externalId: string) => string | undefined,
  now: number,
  signal?: AbortSignal
): Promise<{ issue: Issue; created: boolean }> {
  const by = syncActorFor(binding.providerId)
  const labels = remote.labels?.length ? await ensureIssueLabels(remote.labels, signal) : []
  const cycleId = remote.cycleExternalId ? cycleIdOf(remote.cycleExternalId) : undefined
  signal?.throwIfAborted()
  return createIssueWithResult({
    projectId: binding.projectId,
    issueProjectId: binding.issueProjectId,
    title: remote.title,
    ...(remote.description ? { description: remote.description } : {}),
    status: remote.status,
    ...(remote.priority ? { priority: remote.priority } : {}),
    ...(remote.assigneeLabel ? { assignee: { kind: "human", label: remote.assigneeLabel } } : {}),
    createdBy: by,
    labelIds: labels.map((row) => row.id),
    ...(typeof remote.dueDate === "number" ? { dueDate: remote.dueDate } : {}),
    ...(typeof remote.estimate === "number" ? { estimate: remote.estimate } : {}),
    ...(cycleId ? { cycleId } : {}),
    ...(triageOnImport(binding, remote) ? { triage: "pending" as const } : {}),
    externalRefs: [
      {
        provider: binding.providerId,
        externalId: remote.externalId,
        ...(remote.url ? { url: remote.url } : {}),
        ...(remote.label ? { label: remote.label } : {}),
        syncedAt: now,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        meta: { ...(remote.meta ?? {}), binding: binding.key },
      },
    ],
  })
}

interface FieldContext {
  labelsById: Map<string, LabelRow>
  cycleExternalIdOf: (cycleId: string) => string | undefined
  cycleIdOf: (externalId: string) => string | undefined
}

async function buildFieldContext(binding: IssueSyncBinding): Promise<FieldContext> {
  const labels = await listLabels("issue")
  const cycles = await listIssueCycles({ projectId: binding.projectId })
  const externalByCycleId = new Map<string, string>()
  const cycleIdByExternal = new Map<string, string>()
  for (const cycle of cycles) {
    for (const ref of cycle.externalRefs) {
      if (ref.provider !== binding.providerId) continue
      externalByCycleId.set(cycle.id, ref.externalId)
      if (cycle.issueProjectId === binding.issueProjectId && ref.meta?.binding === binding.key) {
        cycleIdByExternal.set(ref.externalId, cycle.id)
      }
    }
  }
  return {
    labelsById: new Map(labels.map((row) => [row.id, row])),
    cycleExternalIdOf: (id) => externalByCycleId.get(id),
    cycleIdOf: (externalId) => cycleIdByExternal.get(externalId),
  }
}

/** Reload the row after writers touched it. */
async function fresh(issueId: string): Promise<Issue | undefined> {
  return getDb().issues.get(issueId)
}

async function reconcileItem(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  local: Issue,
  remote: RemoteIssue,
  context: FieldContext,
  now: number,
  tally: ReconcileOutcome,
  signal?: AbortSignal
): Promise<{ patch: RemotePatch; pushFields: IssueSyncField[]; watermark: number }> {
  const by = syncActorFor(binding.providerId, provider.label)
  const ref = refOf(local, binding, remote.externalId)
  const syncedAt = ref?.syncedAt
  const firstTime = syncedAt === undefined
  const remoteChanged = firstTime || remote.remoteUpdatedAt > syncedAt
  const events = await listIssueEvents({ issueId: local.id })
  const localClock = lastLocalChangeAt(events, syncedAt ?? 0)
  // The trail's clock is monotonic and may run a millisecond ahead of the
  // wall clock, so an edit made just before this pass can carry a ts later
  // than `now`. The ref must be stamped no earlier than the newest event it
  // examined, or that edit looks new again next time and is pushed twice.
  const watermark = events.reduce((max, event) => Math.max(max, event.ts), now)
  const runActive = await hasActiveIssueRun(local.id)
  signal?.throwIfAborted()

  const patch: RemotePatch = {}
  const pushFields: IssueSyncField[] = []
  let touched = false

  for (const field of ISSUE_SYNC_FIELDS) {
    const remoteValue = remoteFieldValue(remote, field)
    if (remoteValue === undefined || !provider.pullFields.includes(field)) continue
    const current = (await fresh(local.id)) ?? local
    signal?.throwIfAborted()
    const localValue = localFieldValue(current, field, context)
    if (!fieldValuesDiffer(localValue, remoteValue)) continue
    if (
      field === "status" &&
      remote.coarseStatus &&
      typeof localValue === "string" &&
      typeof remoteValue === "string" &&
      coarseStatusBucket(localValue as IssueStatus) ===
        coarseStatusBucket(remoteValue as IssueStatus)
    ) {
      continue
    }

    const localChangedAt = localClock.get(field)
    const canPush = provider.pushFields.includes(field) && Boolean(provider.push)

    let winner: "local" | "remote"
    let conflict = false
    if (localChangedAt === undefined) {
      // Only the remote moved (or nothing did and this is the first pass).
      winner = "remote"
    } else if (!remoteChanged) {
      winner = "local"
    } else {
      conflict = true
      winner = remote.remoteUpdatedAt > localChangedAt ? "remote" : "local"
    }
    if (conflict) {
      await appendIssueEvent({
        issueId: local.id,
        payload: {
          kind: "sync_conflict",
          provider: binding.providerId,
          field,
          winner,
          localValue,
          remoteValue,
          by,
        },
      })
      tally.conflicts += 1
    }

    if (winner === "remote") {
      signal?.throwIfAborted()
      const applied = await applyRemoteField(current, field, remoteValue, by, {
        provider: binding.providerId,
        cycleIdOf: context.cycleIdOf,
        runActive,
        signal,
      })
      if (applied) touched = true
    } else if (canPush) {
      pushFields.push(field)
      addToPatch(patch, field, localValue)
    }
  }

  // Fields the remote item did not carry (a provider that only reports what
  // it stores) but a person changed locally still go out.
  for (const [field] of localClock) {
    if (pushFields.includes(field)) continue
    if (remoteFieldValue(remote, field) !== undefined) continue
    if (!provider.pushFields.includes(field) || !provider.push) continue
    const current = (await fresh(local.id)) ?? local
    pushFields.push(field)
    addToPatch(patch, field, localFieldValue(current, field, context))
  }

  if (touched) tally.updated += 1
  return { patch, pushFields, watermark }
}

function addToPatch(patch: RemotePatch, field: IssueSyncField, value: RemoteFieldValue): void {
  switch (field) {
    case "title":
      if (typeof value === "string") patch.title = value
      break
    case "description":
      patch.description = typeof value === "string" ? value : null
      break
    case "status":
      if (typeof value === "string") patch.status = value as RemotePatch["status"]
      break
    case "priority":
      if (typeof value === "string") patch.priority = value as RemotePatch["priority"]
      break
    case "labels":
      patch.labels = Array.isArray(value) ? value : []
      break
    case "dueDate":
      patch.dueDate = typeof value === "number" ? value : null
      break
    case "estimate":
      patch.estimate = typeof value === "number" ? value : null
      break
    case "cycle":
      patch.cycleExternalId = typeof value === "string" ? value : null
      break
    case "assignee":
      patch.assignee = typeof value === "string" && value ? value : null
      break
  }
}

/** The synced fields a patch carries. */
function patchFields(patch: RemotePatch): Set<IssueSyncField> {
  return new Set(
    (Object.keys(patch) as Array<keyof RemotePatch>).map((key): IssueSyncField =>
      key === "cycleExternalId" ? "cycle" : key
    )
  )
}

async function pushPatch(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  issue: Issue,
  ref: IssueExternalRef,
  patch: RemotePatch,
  syncedAt: number,
  tally: ReconcileOutcome,
  signal?: AbortSignal
): Promise<void> {
  if (!provider.push || ref.departedAt !== undefined || Object.keys(patch).length === 0) return
  const by = syncActorFor(binding.providerId, provider.label)
  // A person's own edits go out as that person's write; anything an agent
  // or a team changed is left to the outbound policy (ADR-0239).
  const editedBy = localEditorOf(
    await listIssueEvents({ issueId: issue.id }),
    ref.syncedAt ?? 0,
    patchFields(patch)
  )
  signal?.throwIfAborted()
  const outcome = await provider.push(binding, ref, patch, issue, {
    idempotencyKey: pushIdempotencyKey(issue.id, patch),
    by,
    editedBy,
    signal,
  })
  signal?.throwIfAborted()
  if (outcome.status === "queued") {
    tally.queued += 1
    return
  }
  tally.pushed += 1
  await touchIssueExternalRef(issue.id, ref, {
    syncedAt,
    ...(outcome.remoteUpdatedAt !== undefined
      ? { remoteUpdatedAt: outcome.remoteUpdatedAt }
      : ref.remoteUpdatedAt !== undefined
        ? { remoteUpdatedAt: ref.remoteUpdatedAt }
        : {}),
    meta: { ...(ref.meta ?? {}), binding: binding.key },
  })
}

async function linkRemote(
  binding: IssueSyncBinding,
  links: readonly RemoteLink[],
  tally: ReconcileOutcome,
  signal?: AbortSignal
): Promise<void> {
  if (links.length === 0) return
  const db = getDb()
  const byIdentifier = new Map<string, Issue>()
  for (const issue of await db.issues.where("projectId").equals(binding.projectId).toArray()) {
    byIdentifier.set(issue.identifier.toUpperCase(), issue)
  }
  const by = syncActorFor(binding.providerId)
  for (const link of links) {
    const targets = new Map<string, Issue>()
    for (const identifier of link.mentionsIdentifiers) {
      const issue = byIdentifier.get(identifier.toUpperCase())
      if (issue) targets.set(issue.id, issue)
    }
    for (const externalId of link.mentionsExternalIds) {
      const issue = await getIssueByExternalKey(binding.providerId, externalId)
      if (issue) targets.set(issue.id, issue)
    }
    // A pull request already linked to other issues (by an earlier pass, or
    // by the run that opened it) still gets its state recorded there.
    if (link.prState || link.ciState) {
      for (const issue of await listIssuesByExternalKey(externalKeyOf(link))) {
        if (issue.projectId === binding.projectId) targets.set(issue.id, issue)
      }
    }
    for (const issue of targets.values()) {
      signal?.throwIfAborted()
      const already = (issue.externalKeys ?? []).includes(
        externalKeyOf({ provider: link.provider, externalId: link.externalId })
      )
      if (!already) {
        await linkIssueExternal(
          issue.id,
          {
            provider: link.provider,
            externalId: link.externalId,
            ...(link.url ? { url: link.url } : {}),
            ...(link.label ? { label: link.label } : {}),
            meta: { binding: binding.key },
          },
          by
        )
        tally.linked += 1
      }
      if (link.prState) {
        signal?.throwIfAborted()
        await recordIssuePullRequestState(issue.id, link.externalId, link.prState, by)
      }
      if (link.ciState) {
        signal?.throwIfAborted()
        await recordIssuePullRequestChecks(issue.id, link.externalId, link.ciState, by)
      }
    }
  }
}

/** One stored target per local container binding, including plugin purge ownership. */
export function issueSyncTarget(binding: IssueSyncBinding): ExternalSyncTarget {
  const plugin = /^plugin:([^/]+)\//.exec(binding.providerId)
  return {
    key: `issues:${binding.issueProjectId}:${binding.key}`,
    owner: plugin ? `plugin:${plugin[1]}` : "host",
  }
}

export async function reconcileBinding(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  options: ReconcileOptions = {}
): Promise<ReconcileOutcome> {
  const now = options.now ?? Date.now
  const tally: ReconcileOutcome = {
    binding,
    status: "completed",
    pages: 0,
    tombstoned: 0,
    created: 0,
    updated: 0,
    pushed: 0,
    queued: 0,
    conflicts: 0,
    linked: 0,
    cycles: 0,
    notModified: true,
    truncated: false,
  }
  const target = issueSyncTarget(binding)
  const offline = typeof navigator !== "undefined" && navigator.onLine === false
  if (offline) {
    // Deferral must not resolve credentials (an App token may require a request).
    const stored = await getDb().externalSyncCursors.get(target.key)
    if (stored?.owner === target.owner) target.connectionRef = stored.connectionRef
  } else if (!options.signal?.aborted && provider.prepare) {
    const prepared = await provider.prepare(binding)
    provider = prepared.provider
    if (prepared.connectionRef) target.connectionRef = prepared.connectionRef
    // A first offline request has no credential identity or checkpoint yet.
    // Replace only that empty deferral when the real identity becomes known.
    const table = getDb().externalSyncCursors
    await getDb().transaction("rw", table, async () => {
      const stored = await table.get(target.key)
      if (
        stored?.owner === target.owner &&
        stored.deferredOffline &&
        !stored.cursor &&
        !stored.generation &&
        stored.connectionRef !== target.connectionRef
      )
        await table.delete(target.key)
    })
  }
  const mentioned = new Set<string>()
  const ownedIssues = async () =>
    (await getDb().issues.where("projectId").equals(binding.projectId).toArray()).filter(
      (issue) => issue.issueProjectId === binding.issueProjectId
    )
  let departureChecksRemaining = 50
  const tombstone = async (ids: string[], signal: AbortSignal) => {
    if (ids.length === 0) return
    const issues = await ownedIssues()
    const requested = new Set(ids)
    let removed = requested
    if (provider.confirmDeparted) {
      const candidates = new Set<string>()
      for (const issue of issues)
        for (const ref of issue.externalRefs ?? [])
          if (
            ref.provider === binding.providerId &&
            ref.meta?.binding === binding.key &&
            ref.departedAt === undefined &&
            requested.has(ref.externalId)
          )
            candidates.add(ref.externalId)
      const checking = [...candidates].slice(0, departureChecksRemaining)
      if (checking.length === 0) return
      departureChecksRemaining -= checking.length
      signal.throwIfAborted()
      // Share the budget across page deletions and the final full-scan sweep.
      // An unsuccessful batch leaves all its refs untouched for a later run.
      // Unchecked ids stay linked until a later full scan.
      const allowed = new Set(checking)
      const confirmed = await provider.confirmDeparted(binding, checking, { signal })
      signal.throwIfAborted()
      removed = new Set(confirmed.filter((id) => allowed.has(id)))
    }
    for (const issue of issues) {
      for (const ref of issue.externalRefs ?? []) {
        if (
          ref.provider !== binding.providerId ||
          ref.meta?.binding !== binding.key ||
          !removed.has(ref.externalId)
        )
          continue
        signal.throwIfAborted()
        if (
          await setIssueExternalRefDeparted(
            issue.id,
            { ...ref, binding: binding.key },
            now(),
            syncActorFor(binding.providerId, provider.label)
          )
        )
          tally.tombstoned += 1
      }
    }
  }
  let fetched: PullPage = { items: [] }
  const outcome = await runExternalSync(
    target,
    {
      fullScanOnly: provider.fullScanOnly,
      itemId: (item: RemoteIssue) => item.externalId,
      fetchPage: async (input) => {
        if (provider.pullPage) {
          // A full scan starts from the beginning, but the provider still needs
          // its previously committed cursor as a floor for the terminal cursor.
          const previous =
            input.cursor ?? (await getDb().externalSyncCursors.get(target.key))?.cursor
          fetched = await provider.pullPage(binding, {
            ...input,
            ...(previous !== undefined ? { cursor: previous } : {}),
          })
          tally.notModified &&= fetched.items.length === 0
        } else {
          // The legacy adapter uses only the committed cursor, never ref timestamps.
          const previous = (await getDb().externalSyncCursors.get(target.key))?.cursor
          const pulled = await provider.pull(binding, {
            ...(input.mode === "incremental" && input.cursor !== undefined
              ? { since: Number(input.cursor) }
              : {}),
            ...(input.mode === "full" ? { full: true } : {}),
            signal: input.signal,
          })
          tally.notModified &&= pulled.notModified
          tally.truncated ||= pulled.truncated ?? false
          const previousTime = Number(previous ?? 0)
          const newest = pulled.items.reduce(
            (max, item) => Math.max(max, item.remoteUpdatedAt),
            Number.isFinite(previousTime) ? previousTime : 0
          )
          fetched = { ...pulled, cursor: pulled.truncated ? (previous ?? "0") : String(newest) }
        }
        return fetched
      },
      applyPage: async ({ items, deleted }, { signal }) => {
        if (fetched.cycles?.length) {
          await upsertCycles(binding, fetched.cycles, signal)
          tally.cycles += fetched.cycles.length
        }
        const context = await buildFieldContext(binding)
        signal.throwIfAborted()
        const pending: Array<{
          issue: Issue
          ref: IssueExternalRef
          patch: RemotePatch
          syncedAt: number
        }> = []
        const stamp = now()
        for (const remote of items) {
          mentioned.add(remote.externalId)
          let local = await getIssueByExternalKey(binding.providerId, remote.externalId)
          signal.throwIfAborted()
          if (!local) {
            const imported = await importRemote(binding, remote, context.cycleIdOf, stamp, signal)
            signal.throwIfAborted()
            if (imported.created) {
              tally.created += 1
              continue
            }
            // A concurrent link/import may have won the unique external key.
            // Reconcile that returned row before allowing this page to commit.
            local = imported.issue
          }
          if (
            local.projectId !== binding.projectId ||
            local.issueProjectId !== binding.issueProjectId
          )
            continue
          let oldRef = refOf(local, binding, remote.externalId)
          if (!oldRef) {
            const candidate = local.externalRefs?.find(
              (ref) => ref.provider === binding.providerId && ref.externalId === remote.externalId
            )
            if (!candidate || candidate.meta?.binding !== undefined) continue
            signal.throwIfAborted()
            if (
              !(await adoptIssueExternalRefBinding(local.id, candidate, {
                projectId: binding.projectId,
                issueProjectId: binding.issueProjectId,
                binding: binding.key,
              }))
            )
              continue
            local = (await fresh(local.id)) ?? local
            oldRef = refOf(local, binding, remote.externalId)
          }
          if (!oldRef) continue
          if (oldRef.departedAt !== undefined) {
            await setIssueExternalRefDeparted(
              local.id,
              { ...oldRef, binding: binding.key },
              undefined,
              syncActorFor(binding.providerId, provider.label)
            )
            local = (await fresh(local.id)) ?? local
          }
          const { patch, watermark } = await reconcileItem(
            binding,
            provider,
            local,
            remote,
            context,
            stamp,
            tally,
            signal
          )
          const current = (await fresh(local.id)) ?? local
          signal.throwIfAborted()
          const ref = refOf(current, binding, remote.externalId)
          if (!ref) continue
          if (Object.keys(patch).length > 0)
            pending.push({ issue: current, ref, patch, syncedAt: watermark })
          else
            await touchIssueExternalRef(current.id, ref, {
              syncedAt: watermark,
              remoteUpdatedAt: remote.remoteUpdatedAt,
              meta: { ...(ref.meta ?? {}), ...(remote.meta ?? {}), binding: binding.key },
            })
        }
        await tombstone(deleted, signal)
        for (const { issue, ref, patch, syncedAt } of pending) {
          if (deleted.includes(ref.externalId)) continue
          signal.throwIfAborted()
          await pushPatch(binding, provider, issue, ref, patch, syncedAt, tally, signal)
        }
        if (fetched.links?.length) await linkRemote(binding, fetched.links, tally, signal)
        signal.throwIfAborted()
      },
      ...(provider.pullPage && provider.completeFullScan
        ? {
            listKnownIds: async (signal: AbortSignal) => {
              const ids: string[] = []
              for (const issue of await ownedIssues()) {
                signal.throwIfAborted()
                for (const ref of issue.externalRefs ?? [])
                  if (
                    ref.provider === binding.providerId &&
                    ref.meta?.binding === binding.key &&
                    ref.departedAt === undefined
                  )
                    ids.push(ref.externalId)
              }
              return ids
            },
            tombstone: (ids: string[], { signal }: { signal: AbortSignal }) =>
              tombstone(ids, signal),
          }
        : {}),
      // Only after a successful scan, under its exclusion and after tombstones.
      // Busy/offline/backoff/failed/cancelled runs must never issue these writes.
      // A push failure retains the terminal checkpoint and receives core backoff.
      complete: async ({ signal }) => {
        if (!provider.push || provider.pushFields.length === 0) return
        const context = await buildFieldContext(binding)
        for (const issue of await ownedIssues()) {
          for (const ref of issue.externalRefs ?? []) {
            if (
              ref.provider !== binding.providerId ||
              ref.meta?.binding !== binding.key ||
              ref.departedAt !== undefined ||
              ref.syncedAt === undefined ||
              mentioned.has(ref.externalId)
            )
              continue
            signal.throwIfAborted()
            const events = await listIssueEvents({ issueId: issue.id })
            const clock = lastLocalChangeAt(events, ref.syncedAt)
            const patch: RemotePatch = {}
            for (const field of clock.keys()) {
              if (provider.pushFields.includes(field))
                addToPatch(patch, field, localFieldValue(issue, field, context))
            }
            const watermark = events.reduce((max, event) => Math.max(max, event.ts), now())
            await pushPatch(binding, provider, issue, ref, patch, watermark, tally, signal)
          }
        }
      },
    },
    { mode: options.full ? "full" : "auto", now, signal: options.signal }
  )
  return {
    ...tally,
    status: outcome.status,
    pages: outcome.pages,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  }
}
