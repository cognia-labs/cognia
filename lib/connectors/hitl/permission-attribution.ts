/**
 * Who decided a connector turn's permission request (the receipt
 * `approveTool` files with the decision).
 *
 * The IM responder settles the run's tool interrupt before it returns, so the
 * interrupt is the evidence: a person's click on the card is attributed to
 * the connector user who resolved it, not to the turn's initiator (an
 * operator may have answered instead). Automatic allows have no interrupt;
 * transport and TTL denials carry a message. A decision that already names
 * its authority keeps it.
 */

import type { ApproveToolAttribution } from "@/lib/claude/ipc"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import { getDb } from "@/lib/db/schema"

/** `outcome` with the attribution its run's interrupt supports, when it has none. */
export async function attributeConnectorDecision(
  runId: string,
  requestId: string,
  outcome: CapturePermissionDecision
): Promise<CapturePermissionDecision> {
  if (outcome.attribution) return outcome
  const attribution = await attributionFromInterrupt(runId, requestId, outcome)
  return attribution ? { ...outcome, attribution } : outcome
}

async function attributionFromInterrupt(
  runId: string,
  requestId: string,
  outcome: CapturePermissionDecision
): Promise<ApproveToolAttribution | undefined> {
  try {
    const interrupt = await getDb().executionRunInterrupts.get(
      `tool-interrupt:${runId}:${requestId}`
    )
    if (outcome.message === "approval timed out" || interrupt?.status === "expired") {
      return { authority: "timeout" }
    }
    if (
      !outcome.message &&
      interrupt?.runId === runId &&
      interrupt.status === (outcome.decision === "deny" ? "denied" : "approved")
    ) {
      return {
        authority: "human",
        actor: {
          kind: "connector-user",
          ...(interrupt.resolvedBy?.remoteUserId ? { id: interrupt.resolvedBy.remoteUserId } : {}),
        },
      }
    }
    return { authority: outcome.decision === "deny" ? "policy-deny" : "policy-rule" }
  } catch {
    // Missing evidence must not invent a human receipt or block the decision.
    return undefined
  }
}
