/**
 * ADR-0243 3C: the launch profile of one external execution, derived on the
 * Host from the acting identity of the run it serves. The process hosts
 * interpret the profile (`@cognia/agent-contracts/engine-launch-profile`); this
 * file decides it.
 *
 * - No Host-bound run: a Host operation the local person started (a direct
 *   connect, a model probe). `owner`.
 * - A bound run whose identity cannot be read is `isolated`, never `owner`.
 * - The service lane is `isolated/service`, an external event `isolated/event`.
 * - The local person's own run (a `local` or `schedule` trigger they
 *   authorised with no one else asking), or a request from exactly one
 *   requester who is the local person or whom their channel verifies as this
 *   Host's owner, is `owner`.
 * - Anything else is `isolated/requester`.
 *
 * An isolated key names the private state of one conversation for one set of
 * requesters (or, without a conversation, of one run tree): a new requester
 * gives a new key, so a resumed engine session never carries one requester's
 * transcript to another.
 */

import {
  principalKey,
  type ActingIdentityV1,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import type {
  EngineIsolationReason,
  EngineLaunchProfile,
} from "@cognia/agent-contracts/engine-launch-profile"
import { sha256Hex } from "@/lib/data/crypto"
import type { PersonalEgressContext } from "@/lib/execution/personal-egress"
import { externalRunAuthorityId } from "./run-authority"

export interface EngineLaunchProfileInput {
  /** The execution's Host-bound run source (`personalEgressOptionsSource`). */
  context: PersonalEgressContext | undefined
  /** The Cognia conversation the execution belongs to, when it has one. */
  chatSessionId?: string
}

export async function engineLaunchProfile(
  input: EngineLaunchProfileInput
): Promise<EngineLaunchProfile> {
  const runId = externalRunAuthorityId(input.context)
  if (!runId) return { kind: "owner" }
  const { resolveRunActingIdentity } = await import("@/lib/execution/acting-authority")
  const identity = await resolveRunActingIdentity(undefined, runId)
  const reason = await isolationReason(identity)
  if (!reason) return { kind: "owner" }
  const scope = input.chatSessionId
    ? ["chat", input.chatSessionId]
    : ["run", identity?.rootRunId ?? runId]
  const requesters = (identity?.requesters ?? []).map(principalKey).sort()
  return { kind: "isolated", key: await sha256Hex(JSON.stringify([scope, requesters])), reason }
}

/** Why the run is not the owner's own, or `null` when it is. */
async function isolationReason(
  identity: ActingIdentityV1 | undefined
): Promise<EngineIsolationReason | null> {
  if (!identity) return "requester"
  if (identity.lane === "service") return "service"
  if (identity.trigger === "external-event") return "event"
  if (identity.trigger === "local" || identity.trigger === "schedule")
    return identity.authorizingPrincipal?.kind === "local-person" &&
      identity.requesters.every((requester) => requester.kind === "local-person")
      ? null
      : "requester"
  if (identity.trigger === "requester" && identity.requesters.length === 1)
    return (await isOwner(identity.requesters[0]!)) ? null : "requester"
  return "requester"
}

async function isOwner(requester: PrincipalRefV1): Promise<boolean> {
  if (requester.kind === "local-person") return true
  if (requester.kind !== "platform") return false
  const { platformRequesterIsOwner } = await import("@/lib/chat/conversation-channel")
  return platformRequesterIsOwner(requester)
}
