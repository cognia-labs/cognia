import { getDb } from "./schema"
import { recordTombstones } from "./tombstones"
import type {
  SiteArtifactRow,
  SiteBuildLogRow,
  SiteBuildPhase,
  SiteDeploymentRow,
  SiteEntryVerification,
  SiteEnvironmentRevisionRow,
  SiteLifecycle,
  SiteOperationEventRow,
  SiteOperationEventType,
  SiteOperationRow,
  SiteProjectRow,
  SiteProviderTokenState,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

type CreateSiteProjectInput = Omit<
  SiteProjectRow,
  "sourceSubpath" | "executionTargetKey" | "lifecycle" | "createdAt" | "updatedAt"
> & {
  sourceSubpath: string
  now?: number
}

function normalizeSourceSubpath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/")
  if (/^(?:\/|[a-zA-Z]:\/)/.test(normalized)) {
    throw new Error("site source subpath must be relative")
  }
  const output: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (output.length === 0) throw new Error("site source subpath cannot escape its root")
      output.pop()
      continue
    }
    output.push(part)
  }
  return output.join("/")
}

function targetKey(target: SiteProjectRow["executionTarget"]): string {
  if ((target as { kind?: unknown }).kind !== "local") {
    throw new Error("Sites currently require the local desktop execution target")
  }
  return "local"
}

function byteValues(value: Uint8Array | ArrayBuffer): number[] {
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  const record = value as unknown as Record<string, number>
  return Object.keys(record)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => record[key])
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftValues = byteValues(left)
  const rightValues = byteValues(right)
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((byte, index) => byte === rightValues[index])
  )
}

function normalizeArtifactBytes(row: SiteArtifactRow): SiteArtifactRow {
  return { ...row, bytes: new Uint8Array(byteValues(row.bytes)) }
}

function assertDigest(value: string): string {
  const digest = value.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("site artifact digest must be SHA-256 hex")
  return digest
}

function eventId(operationId: string, sequence: number): string {
  return `${operationId}:${sequence}`
}

async function appendOperationEvent(
  operationId: string,
  type: SiteOperationEventRow["type"],
  createdAt: number,
  extra: Pick<SiteOperationEventRow, "message" | "providerRequestId" | "phase"> = {}
): Promise<SiteOperationEventRow> {
  const table = getDb().siteOperationEvents
  const previous = await table.where("operationId").equals(operationId).last()
  const sequence = (previous?.sequence ?? 0) + 1
  const event: SiteOperationEventRow = {
    id: eventId(operationId, sequence),
    operationId,
    sequence,
    type,
    createdAt,
    ...extra,
  }
  await table.add(event)
  return event
}

export async function createSiteProject(input: CreateSiteProjectInput): Promise<SiteProjectRow> {
  const db = getDb()
  const sourceSubpath = normalizeSourceSubpath(input.sourceSubpath)
  const executionTargetKey = targetKey(input.executionTarget)
  const existing = await db.siteProjects
    .where("[projectId+sourceRoot+sourceSubpath+executionTargetKey]")
    .equals([input.projectId, input.sourceRoot, sourceSubpath, executionTargetKey])
    .first()
  if (existing) throw new Error("a Site already exists for this project source and target")
  // Every resource a Site records hangs off its Worker, and purge deletes the
  // ones marked `managed`. Two Sites naming the same account + Worker both
  // recorded it as their own, so purging one deleted the other's production.
  const workerName = input.providerConfig.workerName.trim()
  const accountId = input.providerConfig.accountId.trim()
  const sameWorker = await db.siteProjects
    .filter(
      (site) =>
        site.lifecycle !== "deleted" &&
        site.provider === input.provider &&
        site.providerConfig.accountId.trim() === accountId &&
        site.providerConfig.workerName.trim().toLowerCase() === workerName.toLowerCase()
    )
    .first()
  if (sameWorker) {
    throw new Error(`Site "${sameWorker.name}" already publishes to this Cloudflare Worker`)
  }
  const now = input.now ?? Date.now()
  const row: SiteProjectRow = {
    id: input.id,
    name: input.name.trim(),
    projectId: input.projectId,
    sourceRoot: input.sourceRoot,
    sourceSubpath,
    executionTarget: input.executionTarget,
    executionTargetKey,
    provider: input.provider,
    providerConfig: input.providerConfig,
    authoringPolicy: input.authoringPolicy,
    visitorPolicy: input.visitorPolicy,
    lifecycle: "active",
    createdAt: now,
    updatedAt: now,
  }
  await db.siteProjects.add(row)
  return row
}

export async function listSiteProjects(): Promise<SiteProjectRow[]> {
  return getDb().siteProjects.orderBy("updatedAt").reverse().toArray()
}

export async function getSiteProject(id: string): Promise<SiteProjectRow | undefined> {
  return getDb().siteProjects.get(id)
}

export async function putSiteArtifact(
  input: Omit<SiteArtifactRow, "digest" | "size" | "createdAt"> & {
    digest: string
    now?: number
  }
): Promise<SiteArtifactRow> {
  const db = getDb()
  const digest = assertDigest(input.digest)
  const existing = await db.siteArtifacts.get(digest)
  if (existing) {
    if (
      existing.mediaType !== input.mediaType ||
      existing.fileCount !== input.fileCount ||
      !bytesEqual(existing.bytes, input.bytes)
    ) {
      throw new Error(`site artifact digest collision: ${digest}`)
    }
    return normalizeArtifactBytes(existing)
  }
  const row: SiteArtifactRow = {
    digest,
    bytes: input.bytes.slice(),
    mediaType: input.mediaType,
    size: input.bytes.byteLength,
    fileCount: input.fileCount,
    createdAt: input.now ?? Date.now(),
  }
  await db.siteArtifacts.add(row)
  return row
}

export interface SiteArtifactSweepSnapshot {
  /** Every stored digest (primary keys only — no archive bytes are read). */
  digests: string[]
  sites: Array<{
    site: SiteProjectRow
    versions: SiteVersionRow[]
    deployments: SiteDeploymentRow[]
    operations: SiteOperationRow[]
  }>
}

export interface SiteArtifactSweepPlan {
  /** Archives to delete. */
  doomed: string[]
  /** Versions to mark `artifactCollectedAt` (their bytes are gone after this). */
  collectVersionIds: string[]
}

/**
 * Decide and delete in one transaction.
 *
 * Retention used to read references, then delete, then drop build logs, then
 * mark versions, each as its own write. A deployment queued between the read
 * and the delete lost its archive; a failure after the delete left `ready`
 * versions with no bytes and no collected mark, which no later sweep could
 * repair because the digest was no longer listed. `decide` is pure and runs
 * on the snapshot taken inside the transaction, so nothing can start pinning
 * an archive between the decision and its effect, and either everything lands
 * or nothing does.
 */
export async function sweepSiteArtifacts(
  decide: (snapshot: SiteArtifactSweepSnapshot) => SiteArtifactSweepPlan,
  now = Date.now()
): Promise<{
  snapshot: SiteArtifactSweepSnapshot
  plan: SiteArtifactSweepPlan
  buildLogsDeleted: number
}> {
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.siteProjects,
      db.siteVersions,
      db.siteDeployments,
      db.siteOperations,
      db.siteArtifacts,
      db.siteBuildLogs,
    ],
    async () => {
      const digests = (await db.siteArtifacts.orderBy("createdAt").primaryKeys()) as string[]
      const [projects, versions, deployments, operations] = await Promise.all([
        db.siteProjects.toArray(),
        db.siteVersions.toArray(),
        db.siteDeployments.toArray(),
        db.siteOperations.toArray(),
      ])
      const snapshot: SiteArtifactSweepSnapshot = {
        digests,
        sites: projects.map((site) => ({
          site,
          versions: versions.filter((row) => row.siteId === site.id),
          deployments: deployments.filter((row) => row.siteId === site.id),
          operations: operations.filter((row) => row.siteId === site.id),
        })),
      }
      const plan = decide(snapshot)
      if (plan.doomed.length > 0) await db.siteArtifacts.bulkDelete([...plan.doomed])
      let buildLogsDeleted = 0
      for (const versionId of plan.collectVersionIds) {
        const keys = await db.siteBuildLogs.where("versionId").equals(versionId).primaryKeys()
        await db.siteBuildLogs.bulkDelete(keys)
        buildLogsDeleted += keys.length
        const version = await db.siteVersions.get(versionId)
        if (version && version.artifactCollectedAt === undefined) {
          await db.siteVersions.put({ ...version, artifactCollectedAt: now })
        }
      }
      return { snapshot, plan, buildLogsDeleted }
    }
  )
}

export async function getSiteArtifact(digest: string): Promise<SiteArtifactRow | undefined> {
  const row = await getDb().siteArtifacts.get(digest.toLowerCase())
  return row ? normalizeArtifactBytes(row) : undefined
}

export async function createSiteEnvironmentRevision(
  input: Omit<SiteEnvironmentRevisionRow, "sequence" | "createdAt"> & { now?: number }
): Promise<SiteEnvironmentRevisionRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteProjects,
    db.siteEnvironmentRevisions,
    async (): Promise<SiteEnvironmentRevisionRow> => {
      if (!(await db.siteProjects.get(input.siteId))) throw new Error("site project not found")
      const previous = await db.siteEnvironmentRevisions
        .where("siteId")
        .equals(input.siteId)
        .reverse()
        .sortBy("sequence")
      const row: SiteEnvironmentRevisionRow = {
        id: input.id,
        siteId: input.siteId,
        sequence: (previous[0]?.sequence ?? 0) + 1,
        variables: { ...input.variables },
        secretRefs: input.secretRefs.map((reference) => ({ ...reference })),
        createdAt: input.now ?? Date.now(),
      }
      await db.siteEnvironmentRevisions.add(row)
      return row
    }
  )
}

export async function getSiteEnvironmentRevision(
  id: string
): Promise<SiteEnvironmentRevisionRow | undefined> {
  return getDb().siteEnvironmentRevisions.get(id)
}

export async function listSiteEnvironmentRevisions(
  siteId: string
): Promise<SiteEnvironmentRevisionRow[]> {
  return getDb()
    .siteEnvironmentRevisions.where("siteId")
    .equals(siteId)
    .reverse()
    .sortBy("sequence")
}

export async function createSiteVersionDraft(
  input: Omit<SiteVersionRow, "sequence" | "status" | "createdAt"> & { now?: number }
): Promise<SiteVersionRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteProjects,
    db.siteEnvironmentRevisions,
    db.siteVersions,
    async (): Promise<SiteVersionRow> => {
      if (!(await db.siteProjects.get(input.siteId))) throw new Error("site project not found")
      const environment = await db.siteEnvironmentRevisions.get(input.environmentRevisionId)
      if (!environment || environment.siteId !== input.siteId) {
        throw new Error("site environment revision not found")
      }
      const previous = await db.siteVersions
        .where("siteId")
        .equals(input.siteId)
        .reverse()
        .sortBy("sequence")
      const row: SiteVersionRow = {
        id: input.id,
        siteId: input.siteId,
        sequence: (previous[0]?.sequence ?? 0) + 1,
        status: "building",
        environmentRevisionId: input.environmentRevisionId,
        source: input.source,
        build: input.build,
        artifactDigest: input.artifactDigest,
        failureMessage: input.failureMessage,
        completedAt: input.completedAt,
        createdAt: input.now ?? Date.now(),
      }
      await db.siteVersions.add(row)
      return row
    }
  )
}

export async function completeSiteVersion(input: {
  versionId: string
  artifactDigest: string
  now?: number
}): Promise<SiteVersionRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteVersions,
    db.siteArtifacts,
    async (): Promise<SiteVersionRow> => {
      const version = await db.siteVersions.get(input.versionId)
      if (!version) throw new Error("site version not found")
      if (version.status !== "building") throw new Error("completed site versions are immutable")
      const digest = assertDigest(input.artifactDigest)
      const artifact = await db.siteArtifacts.get(digest)
      if (!artifact) throw new Error("site artifact not found")
      // Denormalized here because this transaction already holds the artifact
      // row. Reading it later to recover two integers costs a structured clone
      // of the whole archive — Dexie cannot project columns.
      const ready: SiteVersionRow = {
        ...version,
        status: "ready",
        artifactDigest: digest,
        artifactSize: artifact.size,
        artifactFileCount: artifact.fileCount,
        completedAt: input.now ?? Date.now(),
      }
      await db.siteVersions.put(ready)
      return ready
    }
  )
}

export async function failSiteVersion(
  versionId: string,
  failureMessage: string,
  now = Date.now()
): Promise<SiteVersionRow> {
  const db = getDb()
  const version = await db.siteVersions.get(versionId)
  if (!version) throw new Error("site version not found")
  if (version.status !== "building") throw new Error("completed site versions are immutable")
  const failed: SiteVersionRow = {
    ...version,
    status: "failed",
    failureMessage,
    completedAt: now,
  }
  await db.siteVersions.put(failed)
  return failed
}

export async function getSiteVersion(id: string): Promise<SiteVersionRow | undefined> {
  return getDb().siteVersions.get(id)
}

export async function listSiteVersions(siteId: string): Promise<SiteVersionRow[]> {
  return getDb().siteVersions.where("siteId").equals(siteId).reverse().sortBy("sequence")
}

/**
 * Operations that move production traffic or its entry points.
 *
 * Each used to take a lease on its own row only, so two publishes of the same
 * Worker could interleave — Cloudflare ended on B while Cognia recorded the
 * later-committing A as live — and a takedown could finish between a deploy's
 * provider write and its local commit, leaving a taken-down Site with an
 * `active` deployment. The provider has one traffic target per Worker, so the
 * consistency boundary is the Site, not the operation.
 */
export const SITE_PRODUCTION_OPERATION_TYPES: ReadonlySet<SiteOperationRow["type"]> = new Set([
  "deploy",
  "takedown",
  "restore",
  "purge",
])

const UNFINISHED_OPERATION_STATUSES: ReadonlySet<SiteOperationRow["status"]> = new Set([
  "queued",
  "running",
  "waiting-reconcile",
])

export async function queueSiteOperation(
  input: Omit<
    SiteOperationRow,
    | "status"
    | "attemptCount"
    | "leaseOwner"
    | "leaseExpiresAt"
    | "providerRequestId"
    | "errorMessage"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
  > & { now?: number }
): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteProjects,
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const now = input.now ?? Date.now()
      const duplicate = await db.siteOperations
        .where("idempotencyKey")
        .equals(input.idempotencyKey)
        .first()
      if (duplicate) {
        if (duplicate.inputDigest !== input.inputDigest || duplicate.type !== input.type) {
          throw new Error("site operation idempotency key was reused with different input")
        }
        // `failed` is a definite provider rejection (nothing applied) and
        // `cancelled` is the user taking responsibility for an attempt. Both
        // used to be returned as-is, so fixing a permission and submitting the
        // same domain or database again hit "requires reconciliation: failed"
        // with nothing left for reconciliation to look at. The key still
        // dedupes in-flight and completed work; a closed attempt reopens the
        // same row so the journal keeps one history per intent.
        if (duplicate.status !== "failed" && duplicate.status !== "cancelled") return duplicate
        await assertNoConcurrentProductionChange(duplicate.siteId, duplicate.type, duplicate.id)
        const reopened: SiteOperationRow = {
          ...duplicate,
          status: "queued",
          inputPayload: input.inputPayload,
          errorMessage: undefined,
          providerRequestId: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          completedAt: undefined,
          updatedAt: now,
        }
        await db.siteOperations.put(reopened)
        await appendOperationEvent(reopened.id, "queued", now, { message: "Retry requested" })
        return reopened
      }
      if (!(await db.siteProjects.get(input.siteId))) throw new Error("site project not found")
      await assertNoConcurrentProductionChange(input.siteId, input.type, input.id)
      const row: SiteOperationRow = {
        id: input.id,
        siteId: input.siteId,
        type: input.type,
        executionTargetKey: input.executionTargetKey,
        idempotencyKey: input.idempotencyKey,
        inputDigest: input.inputDigest,
        inputPayload: input.inputPayload,
        status: "queued",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      }
      await db.siteOperations.add(row)
      await appendOperationEvent(row.id, "queued", now)
      return row
    }
  )
}

/** Must run inside a transaction that includes `siteOperations`. */
async function assertNoConcurrentProductionChange(
  siteId: string,
  type: SiteOperationRow["type"],
  operationId: string
): Promise<void> {
  if (!SITE_PRODUCTION_OPERATION_TYPES.has(type)) return
  const busy = await getDb()
    .siteOperations.where("siteId")
    .equals(siteId)
    .filter(
      (operation) =>
        operation.id !== operationId &&
        SITE_PRODUCTION_OPERATION_TYPES.has(operation.type) &&
        UNFINISHED_OPERATION_STATUSES.has(operation.status)
    )
    .first()
  if (busy) {
    throw new Error(
      busy.status === "waiting-reconcile"
        ? `a ${busy.type} for this Site needs reconciliation before production can change again`
        : `a ${busy.type} for this Site is still in progress`
    )
  }
}

export async function claimNextSiteOperation(input: {
  executionTargetKey: string
  siteId?: string
  leaseOwner: string
  now?: number
  leaseMs: number
}): Promise<SiteOperationRow | undefined> {
  if (!input.leaseOwner.trim()) throw new Error("site operation lease owner is required")
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error("site operation lease duration must be positive")
  }
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow | undefined> => {
      const now = input.now ?? Date.now()
      const candidates = await db.siteOperations
        .where("executionTargetKey")
        .equals(input.executionTargetKey)
        .filter(
          (operation) =>
            (!input.siteId || operation.siteId === input.siteId) &&
            (operation.status === "queued" ||
              (operation.status === "running" && (operation.leaseExpiresAt ?? 0) < now))
        )
        .sortBy("createdAt")
      const current = candidates[0]
      if (!current) return undefined
      const claimed: SiteOperationRow = {
        ...current,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: now + input.leaseMs,
        attemptCount: current.attemptCount + 1,
        updatedAt: now,
      }
      await db.siteOperations.put(claimed)
      await appendOperationEvent(claimed.id, "claimed", now)
      return claimed
    }
  )
}

export async function claimSiteOperation(input: {
  operationId: string
  leaseOwner: string
  now?: number
  leaseMs: number
}): Promise<SiteOperationRow> {
  if (!input.leaseOwner.trim()) throw new Error("site operation lease owner is required")
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error("site operation lease duration must be positive")
  }
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation) throw new Error("site operation not found")
      const now = input.now ?? Date.now()
      const claimable =
        operation.status === "queued" ||
        (operation.status === "running" && (operation.leaseExpiresAt ?? 0) < now)
      if (!claimable) throw new Error("site operation is not claimable")
      const claimed: SiteOperationRow = {
        ...operation,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: now + input.leaseMs,
        attemptCount: operation.attemptCount + 1,
        updatedAt: now,
      }
      await db.siteOperations.put(claimed)
      await appendOperationEvent(claimed.id, "claimed", now)
      return claimed
    }
  )
}

export async function completeSiteOperation(input: {
  operationId: string
  leaseOwner: string
  providerRequestId?: string
  now?: number
}): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation) throw new Error("site operation not found")
      const now = input.now ?? Date.now()
      if (
        operation.status !== "running" ||
        operation.leaseOwner !== input.leaseOwner ||
        (operation.leaseExpiresAt ?? 0) < now
      ) {
        throw new Error("site operation is not held by the active lease owner")
      }
      const completed: SiteOperationRow = {
        ...operation,
        status: "succeeded",
        providerRequestId: input.providerRequestId,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        completedAt: now,
      }
      await db.siteOperations.put(completed)
      await appendOperationEvent(completed.id, "succeeded", now, {
        providerRequestId: input.providerRequestId,
      })
      return completed
    }
  )
}

export async function markSiteOperationForReconcile(input: {
  operationId: string
  leaseOwner: string
  providerRequestId?: string
  message: string
  now?: number
}): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation) throw new Error("site operation not found")
      const now = input.now ?? Date.now()
      if (operation.status !== "running" || operation.leaseOwner !== input.leaseOwner) {
        throw new Error("site operation is not held by the active lease owner")
      }
      const waiting: SiteOperationRow = {
        ...operation,
        status: "waiting-reconcile",
        providerRequestId: input.providerRequestId,
        errorMessage: input.message,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      }
      await db.siteOperations.put(waiting)
      await appendOperationEvent(waiting.id, "waiting-reconcile", now, {
        message: input.message,
        providerRequestId: input.providerRequestId,
      })
      return waiting
    }
  )
}

export async function failSiteOperation(input: {
  operationId: string
  leaseOwner: string
  message: string
  providerRequestId?: string
  now?: number
}): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation) throw new Error("site operation not found")
      const now = input.now ?? Date.now()
      if (operation.status !== "running" || operation.leaseOwner !== input.leaseOwner) {
        throw new Error("site operation is not held by the active lease owner")
      }
      const failed: SiteOperationRow = {
        ...operation,
        status: "failed",
        errorMessage: input.message,
        providerRequestId: input.providerRequestId,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        completedAt: now,
      }
      await db.siteOperations.put(failed)
      await appendOperationEvent(failed.id, "failed", now, {
        message: input.message,
        providerRequestId: input.providerRequestId,
      })
      return failed
    }
  )
}

export async function getSiteOperation(id: string): Promise<SiteOperationRow | undefined> {
  return getDb().siteOperations.get(id)
}

export async function listSiteOperations(siteId: string): Promise<SiteOperationRow[]> {
  return getDb().siteOperations.where("siteId").equals(siteId).sortBy("createdAt")
}

/**
 * Operations across all Sites that the console's rail needs a signal for:
 * still moving, or stopped in a state the user must resolve. One index-backed
 * lookup on `status` feeds both the "running" and the "failed" rail hints.
 */
export async function listSiteOperationSignals(): Promise<SiteOperationRow[]> {
  return getDb()
    .siteOperations.where("status")
    .anyOf(["queued", "running", "failed", "waiting-reconcile"])
    .toArray()
}

/**
 * Abandon an operation that will never finish on its own.
 *
 * A `queued` operation whose claimant died, or a `waiting-reconcile` one whose
 * provider outcome reconciliation cannot determine, otherwise stays non-terminal
 * forever: the Site rail keeps pulsing "running" and the journal keeps showing
 * work in flight. `cancelled` is the terminal state for "the user gave up on
 * this attempt", and it is the only writer of that status.
 *
 * Deliberately does NOT require the lease owner — the whole point is that the
 * holder is gone. A LIVE lease is the opposite case: the holder is still
 * making provider calls, and clearing its lease let it finish anyway — the
 * journal said `cancelled` while the deployment became `active`, and the
 * holder then failed on "completed site deployment cannot fail". So a
 * `running` operation can only be abandoned once its lease has expired.
 *
 * Retrying the same input afterwards reopens this row (`queueSiteOperation`):
 * the user who abandoned an uncertain attempt has accepted that its provider
 * outcome is unknown.
 */
export async function cancelSiteOperation(input: {
  operationId: string
  message?: string
  now?: number
}): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation) throw new Error("site operation not found")
      if (
        operation.status === "succeeded" ||
        operation.status === "failed" ||
        operation.status === "cancelled"
      ) {
        throw new Error("site operation has already reached a terminal state")
      }
      const now = input.now ?? Date.now()
      if (operation.status === "running" && (operation.leaseExpiresAt ?? 0) >= now) {
        throw new Error("site operation is still running and cannot be abandoned")
      }
      const cancelled: SiteOperationRow = {
        ...operation,
        status: "cancelled",
        errorMessage: input.message ?? operation.errorMessage,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        completedAt: now,
      }
      await db.siteOperations.put(cancelled)
      await appendOperationEvent(cancelled.id, "cancelled", now, {
        ...(input.message ? { message: input.message } : {}),
      })
      return cancelled
    }
  )
}

export async function resolveSiteOperationFromReconcile(input: {
  operationId: string
  providerRequestId?: string
  message?: string
  /**
   * `failed` when reconciliation found where the provider ended up and it is
   * not what the operation asked for — a deploy whose entry check found the
   * restricted Site exposed, so Cognia took it down.
   */
  outcome?: "succeeded" | "failed"
  now?: number
}): Promise<SiteOperationRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationRow> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation || operation.status !== "waiting-reconcile") {
        throw new Error("waiting Site operation not found")
      }
      const now = input.now ?? Date.now()
      const outcome = input.outcome ?? "succeeded"
      const resolved: SiteOperationRow = {
        ...operation,
        status: outcome,
        providerRequestId: input.providerRequestId ?? operation.providerRequestId,
        errorMessage: outcome === "failed" ? input.message : undefined,
        updatedAt: now,
        completedAt: now,
      }
      await db.siteOperations.put(resolved)
      await appendOperationEvent(resolved.id, outcome, now, {
        message: input.message,
        providerRequestId: resolved.providerRequestId,
      })
      return resolved
    }
  )
}

/**
 * Append a build-phase progress event.
 *
 * `appendOperationEvent` stays private — the journal is only trustworthy while
 * lifecycle transitions are the sole writers of the lifecycle types. This is
 * the one narrow opening: it accepts only the three `phase-*` types, and it
 * checks the lease, so a build whose lease has already been reclaimed cannot
 * keep writing progress into an operation someone else now owns.
 */
export async function appendSiteBuildPhaseEvent(input: {
  operationId: string
  leaseOwner: string
  phase: SiteBuildPhase
  outcome: "started" | "succeeded" | "failed"
  message?: string
  now?: number
}): Promise<SiteOperationEventRow | undefined> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteOperations,
    db.siteOperationEvents,
    async (): Promise<SiteOperationEventRow | undefined> => {
      const operation = await db.siteOperations.get(input.operationId)
      if (!operation || operation.leaseOwner !== input.leaseOwner) return undefined
      return appendOperationEvent(
        input.operationId,
        `phase-${input.outcome}` as SiteOperationEventType,
        input.now ?? Date.now(),
        { message: input.message, phase: input.phase }
      )
    }
  )
}

export async function putSiteBuildLog(
  input: Omit<SiteBuildLogRow, "createdAt"> & { now?: number }
): Promise<SiteBuildLogRow> {
  const { now, ...rest } = input
  const row: SiteBuildLogRow = { ...rest, createdAt: now ?? Date.now() }
  await getDb().siteBuildLogs.put(row)
  return row
}

/** One row per phase for a version, install before build. */
export async function listSiteBuildLogs(versionId: string): Promise<SiteBuildLogRow[]> {
  const rows = await getDb().siteBuildLogs.where("versionId").equals(versionId).toArray()
  const order: Record<SiteBuildLogRow["phase"], number> = { install: 0, build: 1 }
  return rows.sort((left, right) => order[left.phase] - order[right.phase])
}

export async function listSiteOperationEvents(
  operationId: string
): Promise<SiteOperationEventRow[]> {
  return getDb().siteOperationEvents.where("operationId").equals(operationId).sortBy("sequence")
}

export async function createSiteDeployment(
  input: Omit<SiteDeploymentRow, "status" | "createdAt" | "updatedAt"> & { now?: number }
): Promise<SiteDeploymentRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteProjects,
    db.siteVersions,
    db.siteEnvironmentRevisions,
    db.siteDeployments,
    async (): Promise<SiteDeploymentRow> => {
      const site = await db.siteProjects.get(input.siteId)
      if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
        throw new Error("deployable site project not found")
      }
      const version = await db.siteVersions.get(input.versionId)
      if (!version || version.siteId !== input.siteId || version.status !== "ready") {
        throw new Error("site deployment requires a ready version")
      }
      const environment = await db.siteEnvironmentRevisions.get(input.environmentRevisionId)
      if (!environment || environment.siteId !== input.siteId) {
        throw new Error("site deployment environment revision not found")
      }
      const now = input.now ?? Date.now()
      const row: SiteDeploymentRow = {
        id: input.id,
        siteId: input.siteId,
        versionId: input.versionId,
        environmentRevisionId: input.environmentRevisionId,
        status: "pending",
        providerDeploymentId: input.providerDeploymentId,
        productionUrl: input.productionUrl,
        failureMessage: input.failureMessage,
        createdAt: now,
        updatedAt: now,
      }
      await db.siteDeployments.add(row)
      return row
    }
  )
}

/**
 * Record that Cloudflare accepted the deployment, before anything else runs.
 *
 * The provider deployment ID is the receipt. Without it a later read failing
 * (the workers.dev subdomain lookup returning 403) filed an accepted
 * deployment as `failed`, reconciliation had nothing to look at, and a retry
 * deployed the same version a second time.
 */
export async function markSiteDeploymentAccepted(input: {
  deploymentId: string
  providerDeploymentId: string
  now?: number
}): Promise<SiteDeploymentRow> {
  const db = getDb()
  return db.transaction("rw", db.siteDeployments, async (): Promise<SiteDeploymentRow> => {
    const deployment = await db.siteDeployments.get(input.deploymentId)
    if (!deployment) throw new Error("site deployment not found")
    if (deployment.status !== "pending" && deployment.status !== "deploying") {
      throw new Error("site deployment cannot be accepted from its current status")
    }
    const updated: SiteDeploymentRow = {
      ...deployment,
      status: "deploying",
      providerDeploymentId: input.providerDeploymentId,
      updatedAt: input.now ?? Date.now(),
    }
    await db.siteDeployments.put(updated)
    return updated
  })
}

export async function markSiteDeploymentActive(input: {
  deploymentId: string
  providerDeploymentId: string
  productionUrl: string
  entryVerification?: SiteEntryVerification
  now?: number
}): Promise<SiteDeploymentRow> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteProjects,
    db.siteDeployments,
    async (): Promise<SiteDeploymentRow> => {
      const deployment = await db.siteDeployments.get(input.deploymentId)
      if (!deployment) throw new Error("site deployment not found")
      if (!["pending", "deploying"].includes(deployment.status)) {
        throw new Error("site deployment cannot become active from its current status")
      }
      const site = await db.siteProjects.get(deployment.siteId)
      if (site?.lifecycle !== "active") {
        throw new Error("a deployment cannot become active on a Site that is not active")
      }
      const now = input.now ?? Date.now()
      const active = await db.siteDeployments
        .where("siteId")
        .equals(deployment.siteId)
        .filter((candidate) => candidate.status === "active" && candidate.id !== deployment.id)
        .toArray()
      await db.siteDeployments.bulkPut(
        active.map((candidate) => ({ ...candidate, status: "superseded", updatedAt: now }))
      )
      const updated: SiteDeploymentRow = {
        ...deployment,
        status: "active",
        providerDeploymentId: input.providerDeploymentId,
        productionUrl: input.productionUrl,
        failureMessage: undefined,
        ...(input.entryVerification ? { entryVerification: input.entryVerification } : {}),
        updatedAt: now,
      }
      await db.siteDeployments.put(updated)
      return updated
    }
  )
}

/** Replace the recorded entry check of a deployment (a later "check again"). */
export async function setSiteDeploymentEntryVerification(
  deploymentId: string,
  entryVerification: SiteEntryVerification,
  failureMessage?: string,
  now = Date.now()
): Promise<SiteDeploymentRow> {
  const db = getDb()
  const deployment = await db.siteDeployments.get(deploymentId)
  if (!deployment) throw new Error("site deployment not found")
  const updated: SiteDeploymentRow = {
    ...deployment,
    entryVerification,
    ...(failureMessage ? { failureMessage } : {}),
    updatedAt: now,
  }
  await db.siteDeployments.put(updated)
  return updated
}

/**
 * Bring back the deployment a takedown stopped serving.
 *
 * Takedown closes entry points; it never changes which version Cloudflare
 * routes to. Restore only flipped the Site's lifecycle, so the console showed
 * a restored Site with no live URL. The row to reactivate is the one whose
 * receipt is the provider's current deployment — if something else was
 * deployed out of band, nothing is marked live rather than the wrong thing.
 */
export async function restoreSiteDeployment(input: {
  siteId: string
  providerDeploymentId: string
  now?: number
}): Promise<SiteDeploymentRow | undefined> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.siteDeployments,
    async (): Promise<SiteDeploymentRow | undefined> => {
      const candidate = (
        await db.siteDeployments
          .where("siteId")
          .equals(input.siteId)
          .filter(
            (row) =>
              row.status === "taken-down" && row.providerDeploymentId === input.providerDeploymentId
          )
          .toArray()
      ).sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (!candidate) return undefined
      const restored: SiteDeploymentRow = {
        ...candidate,
        status: "active",
        updatedAt: input.now ?? Date.now(),
      }
      await db.siteDeployments.put(restored)
      return restored
    }
  )
}

export async function failSiteDeployment(
  deploymentId: string,
  failureMessage: string,
  now = Date.now()
): Promise<SiteDeploymentRow> {
  const db = getDb()
  const deployment = await db.siteDeployments.get(deploymentId)
  if (!deployment) throw new Error("site deployment not found")
  if (["active", "superseded", "taken-down"].includes(deployment.status)) {
    throw new Error("completed site deployment cannot fail")
  }
  const failed: SiteDeploymentRow = {
    ...deployment,
    status: "failed",
    failureMessage,
    updatedAt: now,
  }
  await db.siteDeployments.put(failed)
  return failed
}

export async function listSiteDeployments(siteId: string): Promise<SiteDeploymentRow[]> {
  return getDb().siteDeployments.where("siteId").equals(siteId).reverse().sortBy("updatedAt")
}

/**
 * Every currently-serving deployment across all Sites.
 *
 * The console's Site rail needs one signal per row — is it live, and at which
 * version — but the per-Site tables are only loaded for the selected Site.
 * Index-backed on `status`, so this stays one lookup regardless of history.
 */
export async function listActiveSiteDeployments(): Promise<SiteDeploymentRow[]> {
  return getDb().siteDeployments.where("status").equals("active").toArray()
}

export async function getSiteDeployment(id: string): Promise<SiteDeploymentRow | undefined> {
  return getDb().siteDeployments.get(id)
}

export async function markSiteDeploymentsTakenDown(
  siteId: string,
  now = Date.now()
): Promise<SiteDeploymentRow[]> {
  const db = getDb()
  const deployments = await db.siteDeployments
    .where("siteId")
    .equals(siteId)
    .filter((row) => row.status === "active")
    .toArray()
  const updated = deployments.map((row): SiteDeploymentRow => ({
    ...row,
    status: "taken-down",
    updatedAt: now,
  }))
  await db.siteDeployments.bulkPut(updated)
  return updated
}

export async function recordSiteResource(
  input: Omit<SiteResourceRow, "status" | "createdAt" | "updatedAt"> & {
    status?: SiteResourceRow["status"]
    now?: number
  }
): Promise<SiteResourceRow> {
  const db = getDb()
  const existing = await db.siteResources.get(input.id)
  if (existing) {
    if (existing.ownership !== input.ownership) {
      throw new Error("site resource ownership is immutable")
    }
    if (
      existing.provider !== input.provider ||
      existing.kind !== input.kind ||
      existing.providerResourceId !== input.providerResourceId ||
      existing.siteId !== input.siteId
    ) {
      throw new Error("site resource identity is immutable")
    }
    const updated: SiteResourceRow = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      metadata: input.metadata ? { ...input.metadata } : existing.metadata,
      dependencies: [...input.dependencies],
      status: input.status ?? existing.status,
      updatedAt: input.now ?? Date.now(),
    }
    await db.siteResources.put(updated)
    return updated
  }
  if (!(await db.siteProjects.get(input.siteId))) throw new Error("site project not found")
  const now = input.now ?? Date.now()
  const row: SiteResourceRow = {
    id: input.id,
    siteId: input.siteId,
    provider: input.provider,
    kind: input.kind,
    providerResourceId: input.providerResourceId,
    displayName: input.displayName,
    metadata: input.metadata ? { ...input.metadata } : undefined,
    ownership: input.ownership,
    status: input.status ?? "active",
    dependencies: [...input.dependencies],
    createdAt: now,
    updatedAt: now,
  }
  await db.siteResources.add(row)
  return row
}

export async function getSiteResource(id: string): Promise<SiteResourceRow | undefined> {
  return getDb().siteResources.get(id)
}

export async function listSiteResources(siteId: string): Promise<SiteResourceRow[]> {
  return getDb().siteResources.where("siteId").equals(siteId).sortBy("createdAt")
}

export async function setSiteResourceStatus(
  id: string,
  status: SiteResourceRow["status"],
  now = Date.now()
): Promise<SiteResourceRow> {
  const db = getDb()
  const resource = await db.siteResources.get(id)
  if (!resource) throw new Error("site resource not found")
  const updated = { ...resource, status, updatedAt: now }
  await db.siteResources.put(updated)
  return updated
}

export async function updateSiteVisitorPolicy(
  id: string,
  visitorPolicy: SiteProjectRow["visitorPolicy"],
  now = Date.now()
): Promise<SiteProjectRow> {
  const db = getDb()
  const site = await db.siteProjects.get(id)
  if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
    throw new Error("active site project not found")
  }
  const updated = { ...site, visitorPolicy, updatedAt: now }
  await db.siteProjects.put(updated)
  return updated
}

/**
 * Record what this host knows about the provider credential.
 *
 * Deliberately does not bump `updatedAt`: every other writer does, and
 * `listSiteProjects` orders the rail by it — a token verification is not a
 * change to the Site that should reorder the list.
 */
export async function setSiteProviderTokenState(
  siteId: string,
  state: SiteProviderTokenState
): Promise<void> {
  const db = getDb()
  const site = await db.siteProjects.get(siteId)
  if (!site) return
  await db.siteProjects.put({ ...site, providerTokenState: state })
}

export async function updateSiteAuthoringPolicy(
  id: string,
  actorAccountId: string,
  authoringPolicy: SiteProjectRow["authoringPolicy"],
  now = Date.now()
): Promise<SiteProjectRow> {
  const db = getDb()
  const site = await db.siteProjects.get(id)
  if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
    throw new Error("active site project not found")
  }
  if (site.authoringPolicy.ownerAccountId !== actorAccountId) {
    throw new Error("only the Site owner can change authoring access")
  }
  const ownerAccountId = authoringPolicy.ownerAccountId.trim()
  if (!ownerAccountId) throw new Error("Site owner account id is required")
  const normalize = (values: string[]) => [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value && value !== ownerAccountId)
    ),
  ]
  const updated: SiteProjectRow = {
    ...site,
    authoringPolicy: {
      ownerAccountId,
      editorAccountIds: normalize(authoringPolicy.editorAccountIds),
      deployerAccountIds: normalize(authoringPolicy.deployerAccountIds),
    },
    updatedAt: now,
  }
  await db.siteProjects.put(updated)
  return updated
}

/**
 * Edit the provider fields that were unreachable after creation.
 *
 * Deliberately narrow: `zoneId` and `accessTeamName` only. `accountId` and
 * `workerName` identify every row already recorded in `siteResources`, so
 * rewriting them would silently orphan the Worker, its versions, its domains,
 * and its Access application while Cognia went on reporting them as managed.
 * Those two stay set-at-creation.
 *
 * `zoneId` matters because `addDomain` and zone-scoped analytics both require
 * it and nothing could supply it before — the custom-domain button threw for
 * every Site created in the app.
 *
 * Owner-only, matching `canAuthorSite(..., "manage")`.
 */
export async function updateSiteProviderConfig(
  id: string,
  actorAccountId: string,
  patch: { zoneId?: string; accessTeamName?: string },
  now = Date.now()
): Promise<SiteProjectRow> {
  const db = getDb()
  const site = await db.siteProjects.get(id)
  if (!site || site.lifecycle === "deleted" || site.lifecycle === "deleting") {
    throw new Error("active site project not found")
  }
  if (site.authoringPolicy.ownerAccountId !== actorAccountId) {
    throw new Error("only the Site owner can change provider configuration")
  }
  // A blank value clears the field rather than storing an empty string, so
  // `zoneId ?? undefined` checks downstream keep working.
  const optional = (
    key: "zoneId" | "accessTeamName"
  ): Record<string, string> | Record<string, never> => {
    const next = Object.hasOwn(patch, key) ? patch[key]?.trim() : site.providerConfig[key]
    return next ? { [key]: next } : {}
  }
  const updated: SiteProjectRow = {
    ...site,
    providerConfig: {
      accountId: site.providerConfig.accountId,
      workerName: site.providerConfig.workerName,
      ...optional("zoneId"),
      ...optional("accessTeamName"),
    },
    updatedAt: now,
  }
  await db.siteProjects.put(updated)
  return updated
}

const LIFECYCLE_TRANSITIONS: Record<SiteLifecycle, readonly SiteLifecycle[]> = {
  active: ["taken-down"],
  "taken-down": ["active", "deleting"],
  // A definite provider failure rolls deletion back to a retryable state.
  // Uncertain mutations stay in `deleting` until reconciliation resolves them.
  deleting: ["taken-down", "deleted"],
  deleted: [],
}

export async function setSiteLifecycle(
  id: string,
  lifecycle: SiteLifecycle,
  now = Date.now()
): Promise<SiteProjectRow> {
  const db = getDb()
  const current = await db.siteProjects.get(id)
  if (!current) throw new Error("site project not found")
  if (!LIFECYCLE_TRANSITIONS[current.lifecycle].includes(lifecycle)) {
    throw new Error(`invalid site lifecycle transition: ${current.lifecycle} -> ${lifecycle}`)
  }
  const updated = { ...current, lifecycle, updatedAt: now }
  await db.siteProjects.put(updated)
  return updated
}

export async function deleteSiteProjectMetadata(id: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [
      db.siteProjects,
      db.siteVersions,
      db.siteArtifacts,
      db.siteEnvironmentRevisions,
      db.siteDeployments,
      db.siteResources,
      db.siteOperations,
      db.siteOperationEvents,
      db.siteBuildLogs,
      // A paired client mirrors every table below but the logs and archives
      // (`lib/sites/sync/sync-handlers.ts`); each deletion it would otherwise
      // never learn about is tombstoned in this transaction.
      db.syncTombstones,
    ],
    async (): Promise<void> => {
      const site = await db.siteProjects.get(id)
      if (!site) return
      const managedResources = await db.siteResources
        .where("siteId")
        .equals(id)
        .filter((resource) => resource.ownership === "managed" && resource.status !== "deleted")
        .count()
      if (managedResources > 0) {
        throw new Error("site metadata cannot be deleted while managed resources remain")
      }
      const unfinished = await db.siteOperations
        .where("siteId")
        .equals(id)
        .filter((operation) => !["succeeded", "failed", "cancelled"].includes(operation.status))
        .count()
      if (unfinished > 0) throw new Error("site metadata cannot be deleted while operations remain")
      if (site.lifecycle !== "deleted") throw new Error("site must complete its deletion lifecycle")
      const versions = await db.siteVersions.where("siteId").equals(id).toArray()
      const operations = await db.siteOperations.where("siteId").equals(id).toArray()
      const eventIds = (
        await Promise.all(
          operations.map(
            (row) =>
              db.siteOperationEvents.where("operationId").equals(row.id).primaryKeys() as Promise<
                string[]
              >
          )
        )
      ).flat()
      const deploymentIds = (await db.siteDeployments
        .where("siteId")
        .equals(id)
        .primaryKeys()) as string[]
      const environmentIds = (await db.siteEnvironmentRevisions
        .where("siteId")
        .equals(id)
        .primaryKeys()) as string[]
      const resourceIds = (await db.siteResources
        .where("siteId")
        .equals(id)
        .primaryKeys()) as string[]
      await db.siteOperationEvents.bulkDelete(eventIds)
      await db.siteBuildLogs.where("siteId").equals(id).delete()
      await db.siteOperations.where("siteId").equals(id).delete()
      await db.siteDeployments.where("siteId").equals(id).delete()
      await db.siteEnvironmentRevisions.where("siteId").equals(id).delete()
      await db.siteVersions.where("siteId").equals(id).delete()
      await db.siteResources.where("siteId").equals(id).delete()
      for (const digest of new Set(
        versions.flatMap((row) => (row.artifactDigest ? [row.artifactDigest] : []))
      )) {
        const references = await db.siteVersions.where("artifactDigest").equals(digest).count()
        if (references === 0) await db.siteArtifacts.delete(digest)
      }
      await db.siteProjects.delete(id)
      // One watermark for the whole cascade, so a client that pulls the Site's
      // tombstone in the same run also drops everything that hung off it.
      const at = Date.now()
      await recordTombstones("siteOperationEvents", eventIds, at)
      await recordTombstones(
        "siteOperations",
        operations.map((row) => row.id),
        at
      )
      await recordTombstones("siteDeployments", deploymentIds, at)
      await recordTombstones("siteEnvironmentRevisions", environmentIds, at)
      await recordTombstones(
        "siteVersions",
        versions.map((row) => row.id),
        at
      )
      await recordTombstones("siteResources", resourceIds, at)
      await recordTombstones("siteProjects", [id], at)
    }
  )
}

/* ------------------------------------------------------- paired overview */

/**
 * The newest operations across every Site, newest first.
 *
 * The phone's overview shows what each Site did last without loading every
 * Site's whole journal; `createdAt` is indexed, so this reads `limit` rows.
 */
export async function listRecentSiteOperations(limit: number): Promise<SiteOperationRow[]> {
  return getDb().siteOperations.orderBy("createdAt").reverse().limit(limit).toArray()
}

/** The versions with these ids that exist, in no particular order. */
export async function listSiteVersionsByIds(ids: readonly string[]): Promise<SiteVersionRow[]> {
  if (ids.length === 0) return []
  const rows = await getDb().siteVersions.bulkGet([...ids])
  return rows.filter((row): row is SiteVersionRow => row !== undefined)
}
