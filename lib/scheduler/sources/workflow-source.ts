/**
 * Workflow-source adapter: surfaces every workflow cron schedule as a unified
 * scheduled item.
 *
 * The list is DERIVED, never a second store (WF-07):
 *
 *   - every enabled `trigger.cron` node of each workflow's ACTIVE production
 *     version — what the native cron daemon actually fires, whether the
 *     workflow was published from the editor or scheduled from here;
 *   - plus every enabled cron node that exists only in a workflow's draft,
 *     listed as awaiting publish (it cannot fire until a publish ships it).
 *
 * It used to list the `workflowTriggers` table, which only the Scheduler's own
 * quick-add ever wrote: a schedule published from the editor never showed up,
 * and a quick-added one showed as active while admission refused it.
 *
 * Mutations:
 *
 *   - `pause` / `resume` — a runtime override on the published trigger
 *     (`lib/workflow/runtime/trigger-pauses.ts`). It never edits the draft
 *     graph or a version, and every projection (publish, rollback, boot
 *     reconcile) keeps honouring it.
 *   - `runNow` — invoke the active deployment through `ExecutionAuthority`
 *     with a synthetic `manual` trigger payload.
 *   - `create` / `update` / `delete` — NOT supported at this layer. The
 *     canonical write path is the workflow editor (and the quick-add dialog
 *     for a new draft cron node); the UI deep-links to the editor.
 */

import Dexie from "dexie"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { executeDeployedWorkflow } from "@/lib/workflow/runtime/execution-authority"
import {
  isWorkflowTriggerPaused,
  setWorkflowTriggerPaused,
} from "@/lib/workflow/runtime/trigger-pauses"
import type { VisualWorkflow, WorkflowNode, WorkflowRunRow } from "@/types/workflow/visual"
import {
  makeUnifiedId,
  type UnifiedScheduledItem,
  type UnifiedItemStatus,
} from "@/types/scheduler/unified"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
  ScheduledItemSubscription,
} from "./types"
import { getNextCronTime } from "@/lib/scheduler/cron-parser"
import { toUnifiedFromWorkflowRun } from "./run-mappers"
import { parseWorkflowScheduleSourceId, workflowScheduleSourceId } from "./workflow-schedule-id"

export class WorkflowSourceWriteNotSupportedError extends Error {
  constructor(action: string) {
    super(
      `Workflow trigger ${action} is not supported from the scheduler page — open the workflow editor.`
    )
    this.name = "WorkflowSourceWriteNotSupportedError"
  }
}

/** One workflow cron schedule as the Scheduler shows it. */
export interface WorkflowScheduleEntry {
  workflowId: string
  workflowName?: string
  triggerId: string
  cron: string
  timezone?: string
  /** In the active deployment's version (it fires), or only in the draft. */
  published: boolean
  /** Operator pause override on the published trigger. */
  paused: boolean
}

function cronNodes(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  return nodes.filter((node) => node.type === "trigger.cron" && !node.data.disabled)
}

function cronParams(node: WorkflowNode): { cron: string; timezone?: string } {
  const params = (node.data.params ?? {}) as { cron?: unknown; timezone?: unknown }
  return {
    cron: typeof params.cron === "string" ? params.cron.trim() : "",
    ...(typeof params.timezone === "string" && params.timezone.trim()
      ? { timezone: params.timezone.trim() }
      : {}),
  }
}

/**
 * Derive every schedule from the active deployments and the draft rows. Under
 * `Dexie.liveQuery` this observes `workflowDeployments`, `workflowVersions`
 * and `workflows`, so a publish, an unpublish, a rollback, a draft save or a
 * pause all re-emit.
 */
export async function listWorkflowSchedules(): Promise<WorkflowScheduleEntry[]> {
  const db = getDb()
  const accountId = getActiveAccountId()
  const [drafts, deployments] = await Promise.all([
    db.workflows.toArray(),
    db.workflowDeployments.where("status").equals("active").toArray(),
  ])
  const live = deployments.filter(
    (deployment) => deployment.accountId === accountId && deployment.environment === "production"
  )
  const versions = await db.workflowVersions.bulkGet(live.map((deployment) => deployment.versionId))
  const deployedDefinitions = new Map<string, VisualWorkflow>()
  live.forEach((deployment, index) => {
    const version = versions[index]
    if (
      version &&
      version.workflowId === deployment.workflowId &&
      version.accountId === accountId
    ) {
      deployedDefinitions.set(deployment.workflowId, version.definition)
    }
  })
  return deriveWorkflowSchedules(drafts, deployedDefinitions)
}

/** The pure half of {@link listWorkflowSchedules}. */
export function deriveWorkflowSchedules(
  drafts: readonly VisualWorkflow[],
  deployed: ReadonlyMap<string, VisualWorkflow>
): WorkflowScheduleEntry[] {
  const entries: WorkflowScheduleEntry[] = []
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]))
  const workflowIds = new Set([...draftsById.keys(), ...deployed.keys()])
  for (const workflowId of [...workflowIds].sort()) {
    const draft = draftsById.get(workflowId)
    if (draft?.isTemplate || draft?.isBuiltIn) continue
    const definition = deployed.get(workflowId)
    const name = draft?.name ?? definition?.name
    const publishedIds = new Set<string>()
    for (const node of cronNodes(definition?.nodes ?? [])) {
      publishedIds.add(node.id)
      entries.push({
        workflowId,
        ...(name ? { workflowName: name } : {}),
        triggerId: node.id,
        ...cronParams(node),
        published: true,
        paused: isWorkflowTriggerPaused(draft, node.id),
      })
    }
    for (const node of cronNodes(draft?.nodes ?? [])) {
      if (publishedIds.has(node.id)) continue
      entries.push({
        workflowId,
        ...(name ? { workflowName: name } : {}),
        triggerId: node.id,
        ...cronParams(node),
        published: false,
        paused: false,
      })
    }
  }
  return entries
}

export interface WorkflowRunInput {
  workflowId: string
  triggerId: string
}

export interface WorkflowRawObservable {
  subscribe(observer: { next(rows: WorkflowScheduleEntry[]): void; error?(err: unknown): void }): {
    unsubscribe(): void
  }
}

export interface WorkflowSourceDeps {
  list?: () => Promise<WorkflowScheduleEntry[]>
  setPaused?: (workflowId: string, triggerId: string, paused: boolean) => Promise<unknown>
  run?: (input: WorkflowRunInput) => Promise<unknown>
  observe?: (querier: () => Promise<WorkflowScheduleEntry[]>) => WorkflowRawObservable
  listRuns?: (limit: number) => Promise<WorkflowRunRow[]>
  now?: () => number
}

export function createWorkflowSource(
  deps: WorkflowSourceDeps = {}
): ScheduledItemSource<never, Partial<{ enabled: boolean; cron: string }>> {
  const list = deps.list ?? listWorkflowSchedules
  const setPaused =
    deps.setPaused ??
    ((workflowId: string, triggerId: string, paused: boolean) =>
      setWorkflowTriggerPaused(workflowId, triggerId, paused))
  const run =
    deps.run ??
    (async ({ workflowId, triggerId }) =>
      executeDeployedWorkflow({
        workflowId,
        entrypoint: "desktop",
        caller: "scheduler:run-now",
        triggerKind: "trigger.manual",
        payload: { triggerId },
      }))
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const observe = deps.observe ?? ((querier) => Dexie.liveQuery(querier))
  const listRuns =
    deps.listRuns ??
    ((limit: number) => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray())
  const now = deps.now ?? Date.now
  const toItem = (entry: WorkflowScheduleEntry) => toUnifiedTrigger(entry, now())

  async function find(sourceId: string): Promise<WorkflowScheduleEntry | undefined> {
    const key = parseWorkflowScheduleSourceId(sourceId)
    if (!key) return undefined
    return (await list()).find(
      (entry) => entry.workflowId === key.workflowId && entry.triggerId === key.triggerId
    )
  }

  /** A pause is an override on what runs: a draft-only schedule has nothing to pause. */
  async function publishedOrThrow(sourceId: string): Promise<WorkflowScheduleEntry> {
    const entry = await find(sourceId)
    if (!entry) throw new Error(`Workflow trigger ${sourceId} was not found.`)
    if (!entry.published) {
      throw new Error(
        `Workflow trigger ${sourceId} is not published yet; publish the workflow first.`
      )
    }
    return entry
  }

  return {
    kind: "workflow",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      const sub = observe(list).subscribe({
        next: (rows: WorkflowScheduleEntry[]) => observer.next(rows.map(toItem)),
        error: (err: unknown) => observer.error?.(err),
      })
      return { unsubscribe: () => sub.unsubscribe() }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      return (await list()).map(toItem)
    },

    async listRuns(limit) {
      return (await listRuns(limit)).map(toUnifiedFromWorkflowRun)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      const entry = await find(sourceId)
      return entry ? toItem(entry) : undefined
    },

    create(): Promise<UnifiedScheduledItem> {
      return Promise.reject(new WorkflowSourceWriteNotSupportedError("create"))
    },

    async update(sourceId, input): Promise<void> {
      // The cron expression is part of the graph; editing it here would be a
      // draft edit the running version never sees. Only the pause override
      // is the Scheduler's to change.
      if (typeof input.cron === "string") throw new WorkflowSourceWriteNotSupportedError("update")
      if (typeof input.enabled !== "boolean") return
      const entry = await publishedOrThrow(sourceId)
      await setPaused(entry.workflowId, entry.triggerId, !input.enabled)
    },

    delete(): Promise<void> {
      return Promise.reject(new WorkflowSourceWriteNotSupportedError("delete"))
    },

    async pause(sourceId: string): Promise<void> {
      await this.update(sourceId, { enabled: false })
    },

    async resume(sourceId: string): Promise<void> {
      await this.update(sourceId, { enabled: true })
    },

    async runNow(sourceId: string): Promise<void> {
      // Returning quietly here read as "it ran" to every caller.
      const entry = await publishedOrThrow(sourceId)
      await run({ workflowId: entry.workflowId, triggerId: entry.triggerId })
    },
  }
}

export function toUnifiedTrigger(
  entry: WorkflowScheduleEntry,
  now: number = Date.now()
): UnifiedScheduledItem {
  const next =
    entry.published && !entry.paused && entry.cron
      ? getNextCronTime(entry.cron, new Date(now), entry.timezone)
      : null
  return {
    unifiedId: makeUnifiedId(
      "workflow",
      workflowScheduleSourceId(entry.workflowId, entry.triggerId)
    ),
    kind: "workflow",
    sourceId: workflowScheduleSourceId(entry.workflowId, entry.triggerId),
    name: `${entry.workflowName ?? entry.workflowId} · ${entry.cron || "trigger.cron"}`,
    ...(entry.published
      ? { description: "trigger.cron" }
      : { descriptionKey: "workflowTriggerAwaitingPublish" }),
    status: mapWorkflowStatus(entry),
    triggerSummary: {
      type: "cron",
      cron: entry.cron,
      eventType: "trigger.cron",
      ...(entry.timezone ? { timezone: entry.timezone } : {}),
    },
    ...(next ? { nextRunAt: next.getTime() } : {}),
    origin: {
      deepLinkHref: `/workflows/editor?id=${encodeURIComponent(entry.workflowId)}`,
    },
    capabilities: {
      runNow: entry.published,
      pause: entry.published,
      edit: false, // edit happens in the workflow editor
      delete: false,
    },
  }
}

function mapWorkflowStatus(entry: WorkflowScheduleEntry): UnifiedItemStatus {
  if (!entry.published) return "disabled"
  return entry.paused ? "paused" : "active"
}
