/**
 * Retry one durable child of a Squad run (the Squad console's Retry, and Retry
 * on another host).
 *
 * The coordinator opens the child's next attempt, which fences out the
 * previous one, optionally pinned to a host. Its task goes back to pending,
 * and the lifecycle re-enters over that one task, past the same resume guards
 * a resume passes (readiness, the frozen authority). A guard that blocks
 * parks the run for a person instead of running it.
 */

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"

export async function retrySquadChild(childRunId: string, hostRef?: string): Promise<void> {
  const [{ getDurableTeamCoordinator }, { getAgentTeamChildRun }] = await Promise.all([
    import("./durable-runtime"),
    import("@/lib/db/agent-team-runtime"),
  ])
  const child = await getAgentTeamChildRun(childRunId)
  if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
  const team = useAgentTeamStore.getState().getTeam(child.teamId)
  if (!team) throw new Error(`Unknown Squad: ${child.teamId}`)
  await getDurableTeamCoordinator().retryChild(childRunId, hostRef)
  useAgentTeamStore.getState().updateTask(child.taskId, {
    status: "pending",
    error: undefined,
    completedAt: undefined,
  })
  const { runSquadLifecycle, restoreSquadRunInput, guardSquadResume } =
    await import("../squad/squad-lifecycle-runner")
  const guard = await guardSquadResume(team.id, child.runId)
  if (guard.blocked) return
  const restored = await restoreSquadRunInput(team.id, child.runId)
  if (!restored) return
  await runSquadLifecycle({
    ...restored,
    taskFilter: (task) => task.id === child.taskId,
  })
}
