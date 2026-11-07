/**
 * Start a Squad run and wait for it to end, for the callers that want the
 * outcome rather than the launch: a scheduled task, a workflow node, a
 * composed team that starts at once.
 *
 * `startSquadRun` stays the only launch (ADR-0252 §5) and is fire-and-forget.
 * This waits on the run's execution row, which only a terminal status ends:
 * a run that parks for a person is still running for its caller, and the
 * caller resumes waiting when the person lets it go on. A caller's abort
 * stops the run through the one control machine.
 *
 * A refused start throws `SquadRunRefusedError`, carrying the refusal, so a
 * caller reports the real reason. A replay of a run id already launched waits
 * for that run.
 */

import type { ExecutionRunStatus } from "@/types/execution/run"
import type { StartSquadRunDeps, StartSquadRunInput, StartSquadRunResult } from "./start-squad-run"

export type SquadRunOutcome = "completed" | "failed" | "cancelled"

export interface SquadRunEnd {
  start: StartSquadRunResult & { runId: string; executionRunId: string }
  /** The execution row's terminal status. */
  status: ExecutionRunStatus
  outcome: SquadRunOutcome
  /**
   * Why it ended that way, when the lifecycle said (it ran in this process)
   * or the run was parked for a reason before it ended.
   */
  reason?: string
}

/** The refusal of a start, with what `startSquadRun` answered. */
export class SquadRunRefusedError extends Error {
  readonly result: StartSquadRunResult

  constructor(result: StartSquadRunResult) {
    super(`Squad run refused: ${squadStartRefusalDetail(result)}`)
    this.name = "SquadRunRefusedError"
    this.result = result
  }
}

/** A refusal as one code: `not_ready:<blocker,…>` for readiness, else the reason. */
export function squadStartRefusalDetail(result: StartSquadRunResult): string {
  return result.reason === "not_ready"
    ? `not_ready:${(result.blockers ?? []).map((blocker) => blocker.code).join(",")}`
    : (result.reason ?? "dispatch_error")
}

export interface RunSquadToEndDeps {
  start?: (input: StartSquadRunInput, deps?: StartSquadRunDeps) => Promise<StartSquadRunResult>
  startDeps?: StartSquadRunDeps
  awaitSettlement?: (
    executionRunId: string,
    options: { signal?: AbortSignal }
  ) => Promise<ExecutionRunStatus>
  stop?: (runId: string) => Promise<unknown>
  /** The lifecycle's result for runs that ended in this process. */
  lifecycleResult?: (runId: string) => { reason?: string } | undefined
  /** The durable run's parked reason, read after it ended. */
  recoveryReason?: (runId: string) => Promise<string | undefined>
}

async function defaultStart(input: StartSquadRunInput, deps?: StartSquadRunDeps) {
  const { startSquadRun } = await import("./start-squad-run")
  return startSquadRun(input, deps)
}

async function defaultAwaitSettlement(executionRunId: string, options: { signal?: AbortSignal }) {
  const { awaitSquadRunSettlement } = await import("./watch-squad-run")
  return awaitSquadRunSettlement(executionRunId, options)
}

async function defaultStop(runId: string) {
  const { controlSquadRun } = await import("../durable/durable-control")
  return controlSquadRun({ runId }, "stop")
}

async function defaultRecoveryReason(runId: string) {
  const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
  return (await getAgentTeamRun(runId))?.recoveryReason
}

function outcomeOf(status: ExecutionRunStatus): SquadRunOutcome {
  return status === "completed" || status === "cancelled" ? status : "failed"
}

export async function runSquadToEnd(
  input: StartSquadRunInput,
  options: { signal?: AbortSignal } = {},
  deps: RunSquadToEndDeps = {}
): Promise<SquadRunEnd> {
  const { signal } = options
  signal?.throwIfAborted()
  const result = await (deps.start ?? defaultStart)(input, deps.startDeps)
  if (!result.started || !result.runId || !result.executionRunId) {
    throw new SquadRunRefusedError(result)
  }
  const start = result as SquadRunEnd["start"]
  const stop = deps.stop ?? defaultStop
  const stopRun = () => {
    void stop(start.runId).catch(() => undefined)
  }
  signal?.addEventListener("abort", stopRun, { once: true })
  let status: ExecutionRunStatus
  try {
    if (signal?.aborted) stopRun()
    status = await (deps.awaitSettlement ?? defaultAwaitSettlement)(start.executionRunId, {
      ...(signal ? { signal } : {}),
    })
  } finally {
    signal?.removeEventListener("abort", stopRun)
  }
  let reason = deps.lifecycleResult
    ? deps.lifecycleResult(start.runId)?.reason
    : (await import("./squad-lifecycle-runner")).endedSquadLifecycleResult(start.runId)?.reason
  if (!reason) {
    reason = await (deps.recoveryReason ?? defaultRecoveryReason)(start.runId).catch(
      () => undefined
    )
  }
  return {
    start,
    status,
    outcome: outcomeOf(status),
    ...(reason ? { reason } : {}),
  }
}
