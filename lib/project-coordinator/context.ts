import type { ChatSession } from "@cognia/agent-config-types"
import type { ContextContribution } from "@/lib/modules/manifest-types"
import type { Project } from "@/types"
import { useChatStore } from "@/stores/chat"
import { sessionStatusOf } from "@/lib/chat/steer-runtime"
import { projectRoleToolsApply, resolveCoordinatorConfig } from "./config"
import { buildCoordinatorContextSection, type DigestThreadInput } from "./digest"
import { listProjectThreads } from "./thread-runtime"
import { updateCoordinator } from "./project-access"
import { buildSetupRecommendationsSection, shouldOfferSetup } from "./setup-recommendations"
import { buildProjectGoalSection } from "./protocol"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"
import { listSessionPrObservationsByProject } from "@/lib/db/session-pr-observations"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"

/**
 * What project coordination adds to a coordinated conversation's system
 * prompt (ADR-0204), as the module's context contributions (ADR-0250 §14
 * `context` amendment):
 *
 * - the project goal, for the coordinator and its threads: stable within a
 *   session, in the `project-goal` slot after the workspace instructions;
 * - the coordinator's live project status (the thread digest and, once, the
 *   setup offer): it changes every turn, so it goes to the dynamic tail.
 *
 * The tools and the session-stable protocols are the module's tool
 * contribution (`./agent-tools.ts`).
 */

export interface CoordinatorStatusDeps {
  listThreads: (coordinatorSessionId: string) => Promise<ChatSession[]>
  prStatuses: (projectId: string) => Promise<ReadonlyMap<string, PrDerivedStatus>>
  threadInput: (thread: ChatSession) => Omit<DigestThreadInput, "pr">
  now: () => number
  listSchedules: (projectId: string) => Promise<ScheduledTask[]>
  markSetupOffered: (projectId: string, at: number) => void
}

function defaultDeps(): CoordinatorStatusDeps {
  return {
    listThreads: listProjectThreads,
    prStatuses: async (projectId) =>
      new Map(
        (await listSessionPrObservationsByProject(projectId)).map(
          (row) => [row.sessionId, row.derivedStatus] as const
        )
      ),
    threadInput: (thread) => ({
      thread,
      status: sessionStatusOf(thread.id),
      pendingApprovals: useChatStore.getState().sessions[thread.id]?.pendingApprovals.length ?? 0,
    }),
    now: Date.now,
    listSchedules: (projectId) => schedulerDb.getTasksByProject(projectId),
    markSetupOffered: (projectId, at) => {
      updateCoordinator(projectId, { setupOfferedAt: at })
    },
  }
}

export async function resolveCoordinatorTurnSection(
  session: Pick<ChatSession, "id" | "projectRole" | "projectId">,
  project: Pick<Project, "coordinator"> & Partial<Pick<Project, "roots">>,
  deps: CoordinatorStatusDeps = defaultDeps()
): Promise<string | undefined> {
  if (session.projectRole !== "coordinator" || !projectRoleToolsApply(session, project))
    return undefined
  const [threads, prStatuses] = await Promise.all([
    deps.listThreads(session.id),
    session.projectId ? deps.prStatuses(session.projectId) : new Map<string, PrDerivedStatus>(),
  ])
  const status = buildCoordinatorContextSection(
    project,
    threads.map((thread) => ({ ...deps.threadInput(thread), pr: prStatuses.get(thread.id) })),
    deps.now()
  )
  const setup = await setupSection(session.projectId, project, threads.length, deps)
  return setup ? `${status}\n\n${setup}` : status
}

/** The one-off setup offer, recorded as offered the moment it is included. */
async function setupSection(
  projectId: string | undefined,
  project: Pick<Project, "coordinator"> & Partial<Pick<Project, "roots">>,
  threadCount: number,
  deps: CoordinatorStatusDeps
): Promise<string | undefined> {
  const { setupOfferedAt } = resolveCoordinatorConfig(project)
  if (!projectId || !shouldOfferSetup({ setupOfferedAt, threadCount })) return undefined
  // A schedule read that fails leaves the list out; the offer stands.
  const schedules = await deps.listSchedules(projectId).catch(() => [])
  deps.markSetupOffered(projectId, deps.now())
  return buildSetupRecommendationsSection({ project, schedules })
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "project-goal",
    cache: "session",
    slot: "project-goal",
    produce: ({ session, activeProject }) => {
      if (!projectRoleToolsApply(session, activeProject)) return null
      const text = buildProjectGoalSection(activeProject)
      return text ? { text } : null
    },
  },
  {
    id: "status",
    cache: "turn",
    // Dexie reads of the threads, their pull requests and the schedules; a
    // busy disk must not drop the status (or an offer already marked made).
    deadlineMs: 5_000,
    produce: async ({ session, activeProject }) => {
      if (!session || !activeProject) return null
      const text = await resolveCoordinatorTurnSection(session, activeProject)
      return text ? { text } : null
    },
  },
]
