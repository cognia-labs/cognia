/**
 * Wiring for the history backfill: the production deps, and the four verbs the
 * UI calls.
 *
 * Kept apart from `project-mining-backfill.ts` so the cursor logic stays a pure
 * function of injected readers. Everything that touches Dexie, the settings
 * store or the job queue lives here.
 */

import Dexie from "dexie"
import {
  isTerminalProjectMiningRun,
  projectMiningRunProgress,
} from "@cognia/memory/lifecycle/project-mining-run"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ProjectMiningRun } from "@/types/memory/governance"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { listMessages } from "@/lib/db/messages"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { cancelMemoryJobsForRun, countPendingMemoryJobsForRun } from "@/lib/db/memory-governance"
import {
  advanceProjectMiningRun,
  claimProjectMiningRun,
  createOrGetActiveProjectMiningRun,
  getActiveProjectMiningRun,
  getProjectMiningRun,
  transitionProjectMiningRun,
} from "@/lib/db/project-mining-runs"
import { nudgeMemoryJobWorker } from "@/lib/memory/lifecycle/job-worker"
import { enqueueProjectMiningJobs } from "@/lib/memory/write/project-mining-enqueue"
import { memoryTranscriptProse } from "@/lib/memory/write/project-transcript-text"
import {
  estimateProjectMiningBackfill,
  stepProjectMiningBackfill,
  type ProjectMiningBackfillDeps,
  type ProjectMiningStepOutcome,
} from "./project-mining-backfill"

/** This renderer's identity for the run lease. One per window, stable. */
let workerId: string | null = null
function thisWorker(): string {
  if (!workerId) workerId = `backfill_${Math.random().toString(36).slice(2, 10)}`
  return workerId
}

/**
 * One page of a workspace's sessions, newest first, strictly older than the
 * cursor.
 *
 * The cursor is `[createdAt, id]` rather than `createdAt` alone because
 * sessions routinely share a millisecond, and a one-part cursor would either
 * re-read or skip every row tied with the boundary.
 */
async function pageSessions({
  projectId,
  beforeCreatedAt,
  beforeSessionId,
  limit,
}: {
  projectId: string
  beforeCreatedAt?: number
  beforeSessionId?: string
  limit: number
}): Promise<ChatSession[]> {
  const table = getDb().sessions.where("[projectId+createdAt+id]")
  // Keep element 0 pinned to `projectId` at both ends. `[`${projectId}\uffff`]`
  // matched prefix-sharing projects (`p1` -> `p10`), polluting both the mined
  // windows and the watermark cursor.
  const lower = [projectId, Dexie.minKey]
  const upper =
    beforeCreatedAt === undefined
      ? [projectId, Dexie.maxKey]
      : [projectId, beforeCreatedAt, beforeSessionId ?? ""]
  const rows = (await table
    .between(lower, upper, true, false)
    .reverse()
    .limit(limit)
    .toArray()) as ChatSession[]
  return rows.filter((row) => row.projectId === projectId)
}

function backfillDeps(): ProjectMiningBackfillDeps {
  const owner = thisWorker()
  return {
    pageSessions,
    loadTranscript: async (sessionId) => {
      const session = await getDb().sessions.get(sessionId)
      if (!session || session.memoryLearn === false) return []
      const history = await preparePersonalHistory(
        undefined,
        (await listMessages(sessionId)).map((message) => ({ ...message, sessionId }))
      )
      const withheld = new Set(history.withheldMessageIds)
      return history.messages
        .filter((message) => !withheld.has(message.id))
        .flatMap((message) =>
          message.id
            ? [
                {
                  id: message.id,
                  role: message.role,
                  // The extractor must not credit the user with context the
                  // composer attached to their turn.
                  text: memoryTranscriptProse(message.parts ?? []),
                  parts: Array.isArray(message.parts) ? message.parts : undefined,
                },
              ]
            : []
        )
    },
    enqueueForSession: async ({ session, runId, transcript }) => {
      if (!session.projectId || session.memoryLearn === false) return 0
      const db = getDb()
      return db.transaction("rw", [db.projectMiningRuns, db.memoryJobs], async () => {
        const liveRun = await db.projectMiningRuns.get(runId)
        if (
          !liveRun ||
          liveRun.status !== "running" ||
          liveRun.leaseOwner !== owner ||
          liveRun.projectId !== session.projectId
        ) {
          return 0
        }
        const jobs = await enqueueProjectMiningJobs({
          sessionId: session.id,
          projectId: session.projectId,
          transcript: transcript.map((message) => ({
            ...message,
            parts: Array.isArray(message.parts) ? message.parts : undefined,
          })),
          transcriptRevision: session.transcriptRevision,
          scope: "workspace",
          characterId: session.characterId,
          // `system`, not `user`: nobody was in this conversation just now. The
          // provenance facet in /memory should be able to separate what a sweep
          // learned from what a live turn learned.
          provenance: "system",
          // The conversation is over, so every window is closed, including the
          // last one the live path deliberately holds back.
          includeTrailing: true,
          runId,
        })
        return jobs.length
      })
    },
    countPendingJobs: countPendingMemoryJobsForRun,
    claimRun: (runId, worker) => claimProjectMiningRun(runId, worker),
    advanceRun: advanceProjectMiningRun,
    finishRun: (runId) => transitionProjectMiningRun(runId, "succeeded"),
    workerId: owner,
  }
}

/**
 * Count what a sweep would cost, without reading a single message body.
 *
 * `count()` on an index walk is index-only in Dexie, so neither call
 * materialises a row.
 */
export async function estimateWorkspaceBackfill(projectId: string) {
  return estimateProjectMiningBackfill(projectId, {
    countSessions: (id) => getDb().sessions.where("projectId").equals(id).count(),
    countMessages: (id) => getDb().messages.where("projectId").equals(id).count(),
  })
}

/**
 * Create a run in `preconsent`, or hand back the one already in flight.
 *
 * Returning the existing run rather than making a second one is the whole
 * reason `getActiveProjectMiningRun` counts `preconsent` as active: two runs
 * over one workspace would fight over the same cursor and mine everything
 * twice.
 */
export async function proposeWorkspaceBackfill(projectId: string): Promise<ProjectMiningRun> {
  const existing = await getActiveProjectMiningRun(projectId)
  if (existing) return existing
  const estimate = await estimateWorkspaceBackfill(projectId)
  return createOrGetActiveProjectMiningRun({ projectId, estimate })
}

/** The user agreed to the cost. This is the only way out of `preconsent`. */
export async function confirmWorkspaceBackfill(
  runId: string
): Promise<ProjectMiningRun | undefined> {
  const updated = await transitionProjectMiningRun(runId, "queued")
  if (updated) nudgeMemoryJobWorker()
  return updated
}

export async function pauseWorkspaceBackfill(runId: string): Promise<ProjectMiningRun | undefined> {
  return transitionProjectMiningRun(runId, "paused")
}

export async function resumeWorkspaceBackfill(
  runId: string
): Promise<ProjectMiningRun | undefined> {
  const updated = await transitionProjectMiningRun(runId, "queued")
  if (updated) nudgeMemoryJobWorker()
  return updated
}

/**
 * Stop a run and withdraw the work it has not done yet.
 *
 * Runs in one `[projectMiningRuns, memoryJobs]` transaction with
 * `enqueueForSession`, so an in-flight transcript load cannot append new jobs
 * after withdrawal completes.
 */
export async function cancelWorkspaceBackfill(runId: string): Promise<number> {
  const db = getDb()
  return db.transaction("rw", [db.projectMiningRuns, db.memoryJobs], async () => {
    await transitionProjectMiningRun(runId, "cancelled").catch(() => undefined)
    return cancelMemoryJobsForRun(runId)
  })
}

/**
 * Advance the workspace's active run by one step, if it has one.
 *
 * Safe to call from an idle tick in every window: the lease decides which one
 * actually does the work, and the others get `idle`.
 */
export async function tickWorkspaceBackfill(projectId: string): Promise<ProjectMiningStepOutcome> {
  const run = await getActiveProjectMiningRun(projectId).catch(() => undefined)
  if (!run) return { kind: "idle" }
  // `preconsent` and `paused` are both "a person has not said go": neither is a
  // state a background tick may move out of.
  if (run.status !== "queued" && run.status !== "running") return { kind: "idle" }
  return stepProjectMiningBackfill(run.id, backfillDeps())
}

/**
 * Step every workspace with a `queued` or `running` backfill run.
 *
 * Driven by `startMemoryJobWorker` so a confirmed backfill progresses even
 * when the user sends no further chat turns. Returns how many runs enqueued
 * fresh mining work on this pass.
 */
export async function tickActiveWorkspaceBackfills(): Promise<number> {
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled || config.temporary || !config.mineProjectContext) return 0
  const db = getDb()
  if (!db.projectMiningRuns) return 0
  const runs = await db.projectMiningRuns
    .filter((run) => run.status === "queued" || run.status === "running")
    .toArray()
  if (runs.length === 0) return 0
  let enqueuedRuns = 0
  const seenProjects = new Set<string>()
  for (const run of runs) {
    if (seenProjects.has(run.projectId)) continue
    seenProjects.add(run.projectId)
    const outcome = await stepProjectMiningBackfill(run.id, backfillDeps())
    if (outcome.kind === "advanced" && outcome.jobsEnqueued > 0) {
      enqueuedRuns += 1
    }
  }
  return enqueuedRuns
}

export { getProjectMiningRun, isTerminalProjectMiningRun, projectMiningRunProgress }
