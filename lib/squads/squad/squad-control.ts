/**
 * The guards a Squad run's resume must pass (ADR-0169, ADR-0252 §7.2).
 *
 * The control state machine itself is `durable-control.ts`: every pause,
 * resume and stop of a Squad run goes through its `controlSquadRun`. This
 * file only answers whether a resume may proceed, and why not:
 *
 *   legacy        a run backfilled from the legacy runtime has no checkpoint
 *                 to resume from. It restarts as a new run (`retry`) or stops.
 *   constraints   a run without its frozen authority snapshot cannot be
 *                 re-entered: it would run with authority nobody granted it.
 *   replay        a child whose last checkpoint is not verified safe makes
 *                 the run uncertain (the package's `assessStoredRunRecovery`),
 *                 and an uncertain run is never silently replayed.
 *   readiness     a Squad that could not start must not re-enter either
 *                 (`guardSquadResume`, which parks the run itself).
 */

import { LEGACY_RUN_NOT_RESUMABLE } from "@/lib/squads/legacy-run-history"
import { dexieTeamRunStore } from "@/lib/db/agent-team-runtime"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import { assessStoredRunRecovery } from "@cognia/agent-orchestration/coordinator"
import type { RunRecoveryAssessment } from "@cognia/agent-orchestration/replay"

export type SquadResumeGuard =
  | { kind: "admit" }
  /** A legacy-runtime run: refused, left as it is. */
  | { kind: "legacy" }
  /** No frozen authority snapshot: park it on a recovery decision. */
  | { kind: "missing_constraints" }
  /** A child's last checkpoint cannot be trusted: park it on a recovery decision. */
  | {
      kind: "uncertain"
      reason: NonNullable<RunRecoveryAssessment["reason"]>
      uncertainChildIds: string[]
    }
  /** The Squad is not ready to run; the readiness guard already parked the run. */
  | { kind: "unready" }

export interface SquadResumeGuardDeps {
  now?: () => number
  /** The readiness guard (`guardSquadResume`). Parks the run when it blocks. */
  readiness?: (teamId: string, runId: string) => Promise<{ blocked: boolean }>
}

async function defaultReadiness(teamId: string, runId: string): Promise<{ blocked: boolean }> {
  const { guardSquadResume } = await import("./squad-lifecycle-runner")
  return guardSquadResume(teamId, runId)
}

/**
 * Whether `run` may resume. `reentry` is set when no lifecycle for the run is
 * alive here and resuming means re-entering it over the remaining work; a
 * live lifecycle is only unpaused, so the readiness guard does not apply.
 */
export async function guardSquadRunResume(
  run: AgentTeamRunRecord,
  options: { reentry: boolean },
  deps: SquadResumeGuardDeps = {}
): Promise<SquadResumeGuard> {
  if (run.recoveryReason === LEGACY_RUN_NOT_RESUMABLE) return { kind: "legacy" }
  if (run.executionConstraints?.version !== 1 || !run.executionConstraints.teamConfig) {
    return { kind: "missing_constraints" }
  }
  const replay = await assessStoredRunRecovery(dexieTeamRunStore, run.id, (deps.now ?? Date.now)())
  if (!replay.safe) {
    return {
      kind: "uncertain",
      reason: replay.reason ?? "uncertain_side_effect",
      uncertainChildIds: replay.uncertainChildIds,
    }
  }
  if (options.reentry && (await (deps.readiness ?? defaultReadiness)(run.teamId, run.id)).blocked) {
    return { kind: "unready" }
  }
  return { kind: "admit" }
}
