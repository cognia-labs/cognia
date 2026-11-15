/**
 * Renderer evidence for ADR-0244. Kept separate from the database-backed run
 * records so recovery forms and callers can share this pure, clocked view.
 * This never writes proof or changes recovery admission.
 */
import type { AgentTeamChildRun, AgentTeamRunRecord, StopProof } from "@cognia/agent-orchestration"
import {
  childStopProof,
  hasRemoteDispatch,
  isChildSettled,
} from "@cognia/agent-orchestration/replay"

export type SquadStopState = "none" | "requested" | "unconfirmed" | "stopped"

export interface SquadChildStopStatus {
  state: SquadStopState
  proof?: StopProof
  controlLost: boolean
}

export function deriveSquadChildStop(child: AgentTeamChildRun, now: number): SquadChildStopStatus {
  const proof = childStopProof(child, now)
  if (proof) return { state: "stopped", proof, controlLost: false }
  const stop = child.stop?.epoch === (child.dispatchEpoch ?? 0) ? child.stop : undefined
  const state = stop ? (stop.state === "requested" ? "requested" : "unconfirmed") : "none"
  // WorkerDetachedError's persisted message retains the cause after the
  // runtime handle disappears. A failed attempt alone is not control loss.
  const controlLost =
    state !== "none" &&
    hasRemoteDispatch(child) &&
    !!child.error?.startsWith("Worker connection ") &&
    child.error.includes(" detached:")
  return { state, controlLost }
}

export function summarizeSquadStop(
  run: Pick<AgentTeamRunRecord, "stop">,
  children: readonly AgentTeamChildRun[],
  now: number
): { state: SquadStopState; proofKinds: StopProof["kind"][]; controlLost: boolean } {
  const stops = children.map((child) => deriveSquadChildStop(child, now))
  const allStopped =
    children.length > 0 &&
    children.every((child, index) => stops[index]!.state === "stopped" || isChildSettled(child))
  const controlLost = stops.some((stop) => stop.controlLost)
  const state: SquadStopState =
    run.stop?.state === "confirmed" ||
    (allStopped && (run.stop || stops.some((stop) => stop.proof)))
      ? "stopped"
      : controlLost ||
          stops.some((stop) => stop.state === "unconfirmed") ||
          run.stop?.state === "unconfirmed"
        ? "unconfirmed"
        : stops.some((stop) => stop.state === "requested") || run.stop?.state === "requested"
          ? "requested"
          : "none"
  return {
    state,
    proofKinds: [...new Set(stops.flatMap((stop) => (stop.proof ? [stop.proof.kind] : [])))],
    controlLost,
  }
}
