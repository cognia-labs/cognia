/**
 * Single reuse point for cancelling a running child from the UI: a subagent's
 * chat card, the Job Center, the settings runtime tab, a plugin's
 * `cancelAgent`, a model cancelling the subagent it dispatched.
 *
 * A child with a run row in this process is stopped through the one tree stop
 * (`stopRunTree`, ADR-0252 §3): its kind's handler reaches the stop its
 * launcher registered (a dispatched subagent records the cancellation in its
 * background outbox first) and every live run under it is stopped too. Two
 * children have no registered stop yet, and keep their own target:
 *
 *   - a dispatch still before its launch (resolving its definition, routing
 *     an approval): the cancel registry `dispatch-run` fills at its start, or
 *     the background registry for a detached one;
 *   - an in-turn SDK `Task`, which never gets a run row: its `stopTask`,
 *     registered by `sdk-subagent-bridge`.
 *
 * A Job Center agent whose launch has not registered a stop yet is cancelled
 * through the background-agent manager.
 */

import { requestCancelSubagentRunAndWait } from "./subagent-cancel-registry"
import {
  cancelRendererBackgroundRunAndWait,
  hasRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import { childJobExecutionRunId } from "@/lib/execution/launch-child-run"
import { stopRunTree } from "@/lib/execution/run-control"
import { hasRunStop } from "@/lib/execution/run-stops"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

/**
 * Cancel the child `id` (a subagent run id, a background agent id). Resolves
 * `true` once the stop reached it (and any persisted intent is written).
 */
export async function cancelChildRun(
  id: string,
  opts?: { backgrounded?: boolean; reason?: string }
): Promise<boolean> {
  const runId = childJobExecutionRunId(id)
  if (hasRunStop(runId)) return (await stopRunTree(runId)).stopped
  // Both registries point at one adapter. Invoke it once, and await the
  // persisted cancellation intent before projecting a terminal UI state.
  if (opts?.backgrounded || hasRendererBackgroundRun(id)) {
    return cancelRendererBackgroundRunAndWait(id)
  }
  if (await requestCancelSubagentRunAndWait(id, opts?.reason)) return true
  const { getBackgroundAgentManager } = await import("@/lib/ai/agent/background-agent-manager")
  return getBackgroundAgentManager().cancelAgent(id)
}

/**
 * Cancel a subagent and mark its runtime-store node `cancelled` so the chat
 * card reflects the action after its durable receipt. For a dispatched run
 * that mark is only the engine's report: the store keeps the status its run
 * row settles to (ADR-0252 §2). An in-turn SDK `Task` has no row, so the mark
 * is its status.
 */
export async function cancelSubagentRun(
  id: string,
  opts?: { backgrounded?: boolean; reason?: string }
): Promise<boolean> {
  const cancelled = await cancelChildRun(id, opts)
  if (cancelled) useSubagentRuntimeStore.getState().setStatus(id, "cancelled")
  return cancelled
}
