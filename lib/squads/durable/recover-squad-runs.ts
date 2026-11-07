/**
 * Squad runs after a restart (ADR-0169, ADR-0217): rebuild the durable queues
 * and replay only what a verified checkpoint allows.
 *
 * The coordinator's `recover()` decides each open run's fate. A run it
 * cancelled is settled; one that needs a person is paused behind its recovery
 * interrupt; one that may continue first answers any review a person still
 * owes it, then passes the resume guards (readiness, the frozen authority)
 * and re-enters the lifecycle over its remaining work. A pause or stop that
 * wins while a guard awaits host state owns the run from then on.
 */

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { loggers } from "@cognia/logging"
import type { RecoveryOutcome } from "./durable-runtime"

/** Rebuild durable queues after a restart and replay only safe checkpoints. */
export async function recoverSquadRuns(
  options: { signal?: AbortSignal } = {}
): Promise<RecoveryOutcome[]> {
  if (options.signal?.aborted) return []
  const [{ getDurableTeamCoordinator }, { getAgentTeamRun }] = await Promise.all([
    import("./durable-runtime"),
    import("@/lib/db/agent-team-runtime"),
  ])
  if (options.signal?.aborted) return []
  const outcomes = await getDurableTeamCoordinator().recover()
  if (options.signal?.aborted) return outcomes
  await Promise.all(
    outcomes.map(async (outcome) => {
      const run = await getAgentTeamRun(outcome.runId)
      if (!run || options.signal?.aborted) return
      if (outcome.status === "cancelled" || outcome.status === "terminated") {
        if (run.status !== outcome.status) return
        const { settleAgentTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
        await settleAgentTeamExecutionRun(run, "cancelled", run.completedAt)
        useAgentTeamStore.getState().setTeamStatus(run.teamId, "cancelled")
        return
      }
      const team = useAgentTeamStore.getState().getTeam(run.teamId)
      if (!team) return
      if (outcome.status === "needs_input") {
        useAgentTeamStore.getState().setTeamStatus(team.id, "paused")
        const { ensureTeamRecoveryInterrupt } = await import("./team-recovery")
        await ensureTeamRecoveryInterrupt(outcome.runId).catch(() => undefined)
        return
      }
      const { listPendingSquadReviews, openSquadReview, squadReviewRequestIdFromInterrupt } =
        await import("../gates/squad-review-gate")
      const pending = await listPendingSquadReviews(outcome.runId)
      const {
        guardSquadResume,
        prepareSquadResume,
        resumeTaskFilter,
        runSquadLifecycle,
        restoreSquadRunInput,
        parkSquadRecovery,
      } = await import("../squad/squad-lifecycle-runner")
      const stillRecovering = async () => {
        if (options.signal?.aborted) return false
        const current = await getAgentTeamRun(outcome.runId)
        return !options.signal?.aborted && current?.status === "recovering"
      }
      const parkFailedRecovery = async (lifecycleStarted = false) => {
        if (options.signal?.aborted) return
        try {
          const current = await getAgentTeamRun(outcome.runId)
          if (
            options.signal?.aborted ||
            !current ||
            (current.status !== "recovering" && !(lifecycleStarted && current.status === "running"))
          )
            return
          await parkSquadRecovery(outcome.runId, team.id, "reentry_failed")
          outcome.status = "needs_input"
        } catch {
          if (!options.signal?.aborted) {
            loggers.agent.error("Failed to park interrupted Squad recovery", {
              runId: outcome.runId,
            })
          }
        }
      }
      const reenter = async () => {
        if (!(await stillRecovering())) return
        const guard = await guardSquadResume(team.id, outcome.runId)
        if (guard.blocked) {
          outcome.status = "needs_input"
          return
        }
        if (!(await stillRecovering())) return
        const restored = await restoreSquadRunInput(team.id, outcome.runId)
        if (!restored) {
          outcome.status = "needs_input"
          return
        }
        if (!(await stillRecovering())) return
        await prepareSquadResume(team.id)
        // Readiness and restore can await host state. A Pause/Stop that won
        // while they were pending owns the run now, not this old continuation.
        if (!(await stillRecovering())) return
        void runSquadLifecycle({
          ...restored,
          taskFilter: resumeTaskFilter,
          recovery: { signal: options.signal },
        }).catch(() => parkFailedRecovery(true))
      }
      if (pending.length > 0) {
        // A persisted human question still owns the next step. Re-entry must
        // not replace it with a readiness recovery before the person answers.
        // The bootstrap stays ready while the existing durable gate waits.
        void (async () => {
          for (const review of pending) {
            const target = squadReviewRequestIdFromInterrupt(review)
            if (!target || target.kind === "team_recovery" || options.signal?.aborted) return
            const decision = await openSquadReview({
              ...target,
              teamId: team.id,
              signal: options.signal,
            })
            if (options.signal?.aborted) return
            const current = await getAgentTeamRun(outcome.runId)
            if (!current || current.status !== "recovering") return
            if (decision.outcome !== "approve") {
              // No lifecycle survived to handle a refusal. Keep the decision
              // durable and pause; only a new operator gesture may resume work.
              const { controlSquadRun } = await import("./durable-control")
              if (!(await stillRecovering())) return
              await controlSquadRun({ runId: outcome.runId }, "pause")
              return
            }
          }
          await reenter()
        })().catch(() => parkFailedRecovery())
        return
      }
      await reenter()
    })
  )
  return outcomes
}
