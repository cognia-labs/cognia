/**
 * Run control for a best-of-N group's own row (`kind: "best-of-n"`,
 * ADR-0252 P5).
 *
 * Stop is the one verb: a group has no Squad to pause or steer, and nothing
 * re-dispatches it (`allowedActions` offers no retry while no retry handler is
 * registered for the kind). Stop cancels the whole group through best-of-N's
 * own path, which interrupts every attempt and waits for the Host to
 * acknowledge; the run tree then stops the candidates' rows. A group already
 * parked for a person (`recoveryRequired`, every attempt ended) has no driver
 * left to settle its row, so the row is settled here once the group reads
 * cancelled.
 *
 * Registered by best-of-N itself rather than in the kernel's table
 * (`lib/execution/control-handlers.ts`), which may not import a module. Only a
 * desktop Host runs best-of-N, so only there is it registered; a paired client
 * sends its Stop to the Host as `execution_run_control`.
 */

import { getExecutionRun } from "@/lib/db/execution-runs"
import { bestOfNGroupIdOf, settleBestOfNExecutionRun } from "@/lib/execution/best-of-n-bridge"
import { UnsupportedForKindError } from "@/lib/execution/control-handlers"
import { registerRunControlHandler, type RunControlHandler } from "@/lib/execution/run-control"
import { canManageBestOfNRuns } from "./projection"
import { cancelBestOfN } from "./service"

export const controlBestOfNRun: RunControlHandler = async (command) => {
  if (command.action === "open_details") return
  if (command.action !== "stop") throw new UnsupportedForKindError(command.action, "best-of-n")
  const run = await getExecutionRun(command.runId)
  const groupId = run ? bestOfNGroupIdOf(run) : undefined
  if (!groupId) throw new Error("Best-of-N group not found")
  if (!canManageBestOfNRuns()) throw new Error("Best-of-N runs are managed on the Host")
  const group = await cancelBestOfN(groupId)
  if (group.phase === "cancelled") {
    await settleBestOfNExecutionRun(group.teamRunId, "cancelled")
  }
}

/** Register the handler; the returned function removes it again. */
export function installBestOfNRunControl(): () => void {
  return registerRunControlHandler("best-of-n", controlBestOfNRun)
}
