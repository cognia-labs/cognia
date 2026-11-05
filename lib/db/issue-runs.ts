/**
 * Issue runs — Dexie table `issueRuns` (schema v174, ADR-0132).
 *
 * One row per dispatch of a local issue to an execution engine — an AgentTask,
 * an AgentTeam run, or the GitHub issue loop. The ISSUE side owns this
 * binding: engines are never widened with an `issueId` column, so binding a
 * new engine is one adapter in `lib/issues/run/` and zero schema bumps on the
 * engine's tables.
 *
 * Claimed by `startIssueRun` (`claimIssueRun`, the start lock), bound to the
 * engine item once the adapter's engine accepted (`bindIssueRunDispatch`),
 * and settled when the engine reports a terminal state (`settleIssueRun`).
 * The row is what feeds:
 *   - the "N agents working" pills (`listActiveIssueRunIssueIds`),
 *   - the runtime-owned guard `moveIssue` applies in its own transaction
 *     (`lib/db/issues.ts`, rule in `lib/issues/state-machine.ts`),
 *   - the agent-task / agent-team federated sources' "from KEY-1" badge
 *     (`getIssueRunByTarget`),
 *   - the issue detail panel's run history (`listIssueRuns`).
 *
 * Mechanical module — no gating, no i18n. Every terminal transition also
 * appends the matching `run_*` / `artifact_linked` events to the issue's
 * activity trail in the same transaction, so the timeline can never disagree
 * with the row. Cascade-delete is the CRUD layer's job (`deleteIssueRuns`),
 * never a Dexie hook.
 */

import type {
  IssueActor,
  IssueStatus,
  IssueRun,
  IssueRunArtifact,
  IssueRunKind,
  IssueRunStatus,
  IssueRunWakeup,
} from "@/types/issues"
import { isActiveIssueRunStatus } from "@/types/issues"
import { getDb } from "./schema"
import { appendIssueEvent } from "./issue-events"
import { deliveryDigest, sameIssueArtifact } from "@/lib/issues/deliverables"

function newIssueRunId(): string {
  return `irun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * How long a claim may wait for its engine to accept the dispatch. A claim
 * still unbound after this was interrupted (the window closed mid-dispatch);
 * the reconciler settles it as failed instead of polling an engine item that
 * was never created.
 */
export const ISSUE_RUN_DISPATCH_STALE_MS = 5 * 60_000

/** Raised by `claimIssueRun` when the issue already has a `queued` / `running` run. */
export class IssueRunActiveError extends Error {
  readonly issueId: string
  readonly activeRunId: string

  constructor(issueId: string, activeRunId: string) {
    super(`Issue ${issueId} already has an active run (${activeRunId})`)
    this.name = "IssueRunActiveError"
    this.issueId = issueId
    this.activeRunId = activeRunId
    Object.setPrototypeOf(this, IssueRunActiveError.prototype)
  }
}

/** What an engine hands back once it accepted a dispatch. */
export interface IssueRunDispatch {
  /** Engine-native id of the work item the engine created. */
  targetId: string
  targetRef?: Record<string, string>
  /** `running` when the engine already picked it up, `queued` while it waits. */
  status: Extract<IssueRunStatus, "queued" | "running">
}

export interface ClaimIssueRunInput {
  issueId: string
  /** Owning workspace id, mirrored from the issue. */
  projectId: string
  adapterId: string
  kind: IssueRunKind
  by: IssueActor
  /** Lineage, when an issue wakeup started this run. */
  wakeup?: IssueRunWakeup
  /**
   * The engine item, when it already exists at claim time. Omitted on the
   * dispatch path: `startIssueRun` claims first and binds what the engine
   * returns (`bindIssueRunDispatch`), so the claim itself is the lock.
   */
  targetId?: string
  targetRef?: Record<string, string>
  status?: Extract<IssueRunStatus, "queued" | "running">
  /** Test injection. */
  now?: number
}

/**
 * Claim the issue for one run: refuse when it already has an active run,
 * otherwise insert the row and append `run_started`, in one transaction.
 *
 * This is the start lock. The active-run check and the insert share the
 * transaction, so two dispatches racing for the same issue cannot both pass
 * (Dexie serialises read-write transactions over the same table). The row is
 * `queued` with an empty `targetId` until the engine accepts; `moveIssue`
 * already treats the issue as runtime-owned from here.
 */
export async function claimIssueRun(input: ClaimIssueRunInput): Promise<IssueRun> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const row: IssueRun = {
    id: newIssueRunId(),
    issueId: input.issueId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    kind: input.kind,
    targetId: input.targetId ?? "",
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    status: input.status ?? "queued",
    by: input.by,
    startedAt: now,
    updatedAt: now,
    artifacts: [],
    ...(input.wakeup ? { wakeup: input.wakeup } : {}),
  }
  await db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const active = await activeRunOf(input.issueId)
    if (active) throw new IssueRunActiveError(input.issueId, active.id)
    await db.issueRuns.add(row)
    await appendIssueEvent({
      issueId: input.issueId,
      payload: { kind: "run_started", runId: row.id, adapterId: input.adapterId, by: input.by },
    })
  })
  return row
}

/**
 * Record what the engine accepted onto a claimed run. Returns the bound row,
 * or `undefined` when the claim is gone or no longer active (a cancel landed
 * while the engine was accepting). `statusBefore` is the issue status the
 * caller read in the same transaction, before it moved the issue on.
 */
export async function bindIssueRunDispatch(
  id: string,
  dispatch: IssueRunDispatch,
  statusBefore: IssueStatus | undefined,
  now = Date.now()
): Promise<IssueRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing || !isActiveIssueRunStatus(existing.status)) return undefined
    const next: IssueRun = {
      ...existing,
      targetId: dispatch.targetId,
      status: dispatch.status,
      updatedAt: now,
      ...(statusBefore ? { statusBefore } : {}),
    }
    if (dispatch.targetRef) next.targetRef = dispatch.targetRef
    else delete next.targetRef
    await db.issueRuns.put(next)
    return next
  })
}

/** True while the run is claimed but its engine has not accepted yet. */
export function isUnboundIssueRun(run: Pick<IssueRun, "targetId">): boolean {
  return run.targetId === ""
}

async function activeRunOf(issueId: string): Promise<IssueRun | undefined> {
  const table = getDb().issueRuns
  return (
    (await table.where("[issueId+status]").equals([issueId, "queued"]).first()) ??
    (await table.where("[issueId+status]").equals([issueId, "running"]).first())
  )
}

export async function getIssueRun(id: string): Promise<IssueRun | undefined> {
  return getDb().issueRuns.get(id)
}

export interface ListIssueRunsQuery {
  issueId?: string
  projectId?: string
  status?: IssueRunStatus
  /** Only `queued` / `running` rows. Ignored when `status` is given. */
  activeOnly?: boolean
}

/** Newest first. At least one of `issueId` / `projectId` should be given. */
export async function listIssueRuns(query: ListIssueRunsQuery = {}): Promise<IssueRun[]> {
  const db = getDb()
  let rows: IssueRun[]
  if (query.issueId !== undefined && query.status !== undefined) {
    rows = await db.issueRuns
      .where("[issueId+status]")
      .equals([query.issueId, query.status])
      .toArray()
  } else if (query.issueId !== undefined) {
    rows = await db.issueRuns.where("issueId").equals(query.issueId).toArray()
  } else if (query.projectId !== undefined && query.status !== undefined) {
    rows = await db.issueRuns
      .where("[projectId+status]")
      .equals([query.projectId, query.status])
      .toArray()
  } else if (query.projectId !== undefined) {
    rows = await db.issueRuns.where("projectId").equals(query.projectId).toArray()
  } else if (query.status !== undefined) {
    rows = await db.issueRuns.where("status").equals(query.status).toArray()
  } else {
    rows = await db.issueRuns.toArray()
  }
  if (query.status === undefined && query.activeOnly) {
    rows = rows.filter((row) => isActiveIssueRunStatus(row.status))
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
}

/** True while any `queued` / `running` run exists for the issue. */
export async function hasActiveIssueRun(issueId: string): Promise<boolean> {
  return (await activeRunOf(issueId)) !== undefined
}

/**
 * Ids of every issue in the workspace with an active run. Feeds
 * `issueRunHint` on the board and the workspace overview tile.
 */
export async function listActiveIssueRunIssueIds(projectId: string): Promise<Set<string>> {
  const db = getDb()
  const rows = await db.issueRuns
    .where("[projectId+status]")
    .anyOf([
      [projectId, "queued"],
      [projectId, "running"],
    ])
    .toArray()
  return new Set(rows.map((row) => row.issueId))
}

/**
 * The most recent run whose engine-native id is `targetId`. Lets a federated
 * source badge an engine row with the issue it was dispatched from.
 */
export async function getIssueRunByTarget(
  kind: IssueRunKind,
  targetId: string
): Promise<IssueRun | undefined> {
  const rows = await getDb().issueRuns.where("targetId").equals(targetId).toArray()
  const matching = rows.filter((row) => row.kind === kind)
  if (matching.length === 0) return undefined
  return matching.sort((a, b) => b.startedAt - a.startedAt)[0]
}

/**
 * Index of `targetId → run` for every run of `kind` in the workspace, so a
 * federated source can annotate a whole board in one query.
 */
export async function mapIssueRunsByTarget(
  projectId: string,
  kind: IssueRunKind
): Promise<Map<string, IssueRun>> {
  const rows = await getDb().issueRuns.where("projectId").equals(projectId).toArray()
  const map = new Map<string, IssueRun>()
  for (const row of rows.filter((candidate) => candidate.kind === kind)) {
    const previous = map.get(row.targetId)
    if (!previous || row.startedAt > previous.startedAt) map.set(row.targetId, row)
  }
  return map
}

/** Mark a `queued` run as picked up by the engine. No-op for any other state. */
export async function markIssueRunRunning(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueRuns, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing || existing.status !== "queued") return
    await db.issueRuns.put({ ...existing, status: "running", updatedAt: now })
  })
}

/**
 * Attach an artifact (PR, branch, worktree, session) to a run and append
 * `artifact_linked` to the issue's trail. Idempotent per href and pinned version.
 */
export async function linkIssueRunArtifact(
  id: string,
  artifact: IssueRunArtifact,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing) return
    assertNewDeliveryReceipt(artifact)
    if (existing.artifacts.some((candidate) => sameIssueArtifact(candidate, artifact))) return
    await db.issueRuns.put({
      ...existing,
      artifacts: [...existing.artifacts, artifact],
      updatedAt: now,
    })
    await appendIssueEvent({
      issueId: existing.issueId,
      payload: { kind: "artifact_linked", label: artifact.label, href: artifact.href, runId: id },
    })
  })
}

function assertNewDeliveryReceipt(artifact: IssueRunArtifact): void {
  const receipt = artifact.delivery
  if (
    receipt &&
    (receipt.acceptedAt !== undefined ||
      (!receipt.snapshot && !receipt.externalVersion?.trim()) ||
      receipt.digest !== deliveryDigest(artifact.href, receipt) ||
      receipt.id !== `delivery:${receipt.digest}`)
  )
    throw new Error("Invalid delivery receipt")
}

/** Local user acceptance, separate from engine success and bound to the exact delivered version. */
export async function acceptIssueDeliverable(
  runId: string,
  deliveryId: string,
  expectedDigest: string,
  now = Date.now()
): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const run = await db.issueRuns.get(runId)
    const artifact = run?.artifacts.find((row) => row.delivery?.id === deliveryId)
    const receipt = artifact?.delivery
    if (
      !run ||
      !artifact ||
      !receipt ||
      (!receipt.snapshot && !receipt.externalVersion) ||
      receipt.digest !== expectedDigest ||
      deliveryDigest(artifact.href, receipt) !== expectedDigest
    )
      throw new Error("Delivery version changed or is unavailable")
    if (receipt.acceptedAt !== undefined) return receipt.acceptedAt
    receipt.acceptedAt = now
    await db.issueRuns.put({ ...run, updatedAt: now })
    await appendIssueEvent({
      issueId: run.issueId,
      payload: {
        kind: "deliverable_accepted",
        label: artifact.label,
        runId,
        deliveryId,
        digest: expectedDigest,
        by: { kind: "human" },
      },
    })
    return now
  })
}

export type SettleIssueRunInput =
  | { status: "succeeded"; summary?: string; artifacts?: IssueRunArtifact[] }
  /**
   * A periodic wakeup's run reporting that it looked and there was nothing to
   * deliver. Settles as `succeeded` with the note as its summary, but the
   * trail says `run_checked_in` rather than `run_succeeded`: no verdict was
   * delivered, and the caller (`checkInIssueRun`) leaves the issue where it
   * was instead of advancing it to review.
   */
  | { status: "succeeded"; mode: "checkin"; note: string }
  | { status: "failed"; error: string; artifacts?: IssueRunArtifact[] }
  /** `reason` is kept on the row's `error` field for the run history; it is not a failure. */
  | { status: "cancelled"; reason?: string }

/**
 * Move a run to a terminal state and append the matching trail event. Returns
 * the settled row, or `undefined` when the run does not exist or was already
 * terminal (settling is one-shot; the first terminal write wins).
 */
export async function settleIssueRun(
  id: string,
  input: SettleIssueRunInput,
  now = Date.now()
): Promise<IssueRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing || !isActiveIssueRunStatus(existing.status)) return undefined

    const extraArtifacts = "artifacts" in input ? (input.artifacts ?? []) : []
    const artifacts = [...existing.artifacts]
    for (const artifact of extraArtifacts) {
      if (artifacts.some((candidate) => sameIssueArtifact(candidate, artifact))) continue
      assertNewDeliveryReceipt(artifact)
      artifacts.push(artifact)
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: { kind: "artifact_linked", label: artifact.label, href: artifact.href, runId: id },
      })
    }

    const next: IssueRun = {
      ...existing,
      status: input.status,
      updatedAt: now,
      endedAt: now,
      artifacts,
    }
    delete next.summary
    delete next.error
    if ("mode" in input) {
      next.summary = input.note
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: {
          kind: "run_checked_in",
          runId: id,
          adapterId: existing.adapterId,
          note: input.note,
        },
      })
    } else if (input.status === "succeeded") {
      if (input.summary) next.summary = input.summary
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: {
          kind: "run_succeeded",
          runId: id,
          adapterId: existing.adapterId,
          ...(input.summary ? { summary: input.summary } : {}),
        },
      })
    } else if (input.status === "cancelled") {
      // A cancel is somebody's decision, not an engine failure: its own trail
      // kind, so a subscriber to `run_failed` never hears about it.
      if (input.reason) next.error = input.reason
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: {
          kind: "run_cancelled",
          runId: id,
          adapterId: existing.adapterId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      })
    } else {
      next.error = input.error
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: {
          kind: "run_failed",
          runId: id,
          adapterId: existing.adapterId,
          error: input.error,
        },
      })
    }
    await db.issueRuns.put(next)
    return next
  })
}

/** Cascade target for `deleteIssue`. */
export async function deleteIssueRuns(issueId: string): Promise<string[]> {
  const table = getDb().issueRuns
  const ids = (await table.where("issueId").equals(issueId).primaryKeys()) as string[]
  await table.where("issueId").equals(issueId).delete()
  return ids
}

/** Cascade target for deleting a whole issue-project. Returns the ids it removed. */
export async function deleteIssueRunsForIssues(issueIds: readonly string[]): Promise<string[]> {
  if (issueIds.length === 0) return []
  const table = getDb().issueRuns
  const ids = (await table
    .where("issueId")
    .anyOf([...issueIds])
    .primaryKeys()) as string[]
  await table
    .where("issueId")
    .anyOf([...issueIds])
    .delete()
  return ids
}
