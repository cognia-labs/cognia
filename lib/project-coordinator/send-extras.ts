import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { useChatStore } from "@/stores/chat"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { projectRoleToolsApply, resolveCoordinatorConfig } from "./config"
import { buildCoordinatorContextSection, type DigestThreadInput } from "./digest"
import { listProjectThreads } from "./thread-runtime"
import { updateCoordinator } from "./project-access"
import { buildSetupRecommendationsSection, shouldOfferSetup } from "./setup-recommendations"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"
import { listSessionPrObservationsByProject } from "@/lib/db/session-pr-observations"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"

/**
 * The per-turn project status a coordinator turn adds to its send options
 * (ADR-0204): the thread digest and, once, the setup offer. It changes every
 * turn, so it belongs in the dynamic tail. The tools and the session-stable
 * protocols are the module's tool contribution (`./agent-tools.ts`).
 */

export interface SendExtrasDeps {
  listThreads: (coordinatorSessionId: string) => Promise<ChatSession[]>
  prStatuses: (projectId: string) => Promise<ReadonlyMap<string, PrDerivedStatus>>
  threadInput: (thread: ChatSession) => Omit<DigestThreadInput, "pr">
  now: () => number
  listSchedules: (projectId: string) => Promise<ScheduledTask[]>
  markSetupOffered: (projectId: string, at: number) => void
}

function defaultDeps(): SendExtrasDeps {
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
  deps: SendExtrasDeps = defaultDeps()
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
  deps: SendExtrasDeps
): Promise<string | undefined> {
  const { setupOfferedAt } = resolveCoordinatorConfig(project)
  if (!projectId || !shouldOfferSetup({ setupOfferedAt, threadCount })) return undefined
  // A schedule read that fails leaves the list out; the offer stands.
  const schedules = await deps.listSchedules(projectId).catch(() => [])
  deps.markSetupOffered(projectId, deps.now())
  return buildSetupRecommendationsSection({ project, schedules })
}
