// The squads module's implementation of the `squad-launch` port
// (`types/modules/ports/squad-launch.ts`, ADR-0252 §3): a Squad run started
// as the child of another run, through the one launch seam (`startSquadRun`).
//
// The Squad run writes its own `team` row, linked to the launching run as its
// parent (`launchedByRunId`). Its outcome is the row's terminal status, which
// the lifecycle settles; a stop is a run-control stop, so the run ends the way
// any stopped Squad run ends and the watcher sees it settle as `cancelled`.

import type { ChatSession } from "@cognia/agent-config-types"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { SquadLaunchPort } from "@/types/modules/ports/squad-launch"

export const port: SquadLaunchPort = {
  async start(input) {
    const { startSquadRun } = await import("../squad/start-squad-run")
    const result = await startSquadRun({
      squadId: input.squadId,
      goal: input.brief,
      origin: input.origin,
      // Another run asked for it. The acting identity is the parent's
      // (`launchedByRunId`), not the surface's.
      triggeredFrom: { source: "api" },
      ...(input.sessionId ? { session: { id: input.sessionId } as ChatSession } : {}),
      ...(input.launchedByRunId ? { launchedByRunId: input.launchedByRunId } : {}),
      ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
    })
    if (!result.started || !result.runId || !result.executionRunId) {
      const reason =
        result.reason === "not_ready"
          ? `not_ready:${(result.blockers ?? []).map((blocker) => blocker.code).join(",")}`
          : (result.reason ?? "dispatch_error")
      return { started: false, reason }
    }
    // A fresh launch mints its run id, so it is never a replay.
    if (result.duplicate) return { started: false, reason: "duplicate" }
    const { runId, executionRunId } = result
    const squadId = input.squadId

    const outcome = (async (): Promise<ChildRunOutcome> => {
      const [{ awaitSquadRunSettlement }, { useAgentTeamStore }] = await Promise.all([
        import("../squad/watch-squad-run"),
        import("@/stores/squads/agent-team-store/store"),
      ])
      const status = await awaitSquadRunSettlement(executionRunId)
      const squad = useAgentTeamStore.getState().teams[squadId]
      if (status === "completed") {
        return { status: "completed", ...(squad?.finalResult ? { text: squad.finalResult } : {}) }
      }
      if (status === "failed") {
        return { status: "failed", error: squad?.error ?? `Squad run ${runId} failed` }
      }
      return { status: "cancelled", error: `Squad run ${runId} was stopped` }
    })()

    return {
      started: true,
      executionRunId,
      squadRunId: runId,
      outcome,
      stop: () => {
        void import("../squad/squad-control")
          .then(({ controlSquadRun }) => controlSquadRun(runId, "stop"))
          .catch(() => undefined)
      },
    }
  },
}
