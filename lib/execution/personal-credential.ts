/** ADR-0243: the single Host admission point for a person's own credentials.
 * Direct UI actions carry an in-memory symbol; serialized labels never grant.
 * Execution contexts always resolve their persisted identity root afresh.
 */
import { LOCAL_PERSON_RUN, resolveRunActingIdentity, type LocalPersonRun } from "./acting-authority"
import { markPersonalCredential } from "./personal-marks"
import { readHostPersonContext } from "./personal-sink"
import { samePersonForHost } from "./personal-visibility"
import {
  samePerson,
  type ActingIdentityV1,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"

/** The Host's own person: the owner of every desktop sign-in. */
export const LOCAL_PERSON = { kind: "local-person" } as const satisfies PrincipalRefV1

export type PersonalCredentialSource =
  | "lark-user"
  | "google-docs"
  | "google-drive-backup"
  | "mcp-oauth"
  | "github-user"
  | "slack-user"
  | "integration-user"
export interface PersonalCredentialContext {
  sessionId?: string
  executionRunId?: string
  /** Host-reserved reader/mark identity; not a parent until its row is admitted. */
  executionRunReserved?: true
  /** Host-known authority parent while the reserved turn has no row. */
  executionRunParentId?: string
  /** Host content carries explicit marks even when no durable run exists. */
  personalEgressBlocked?: true
  /** Host UI entries only. Never populate from plugin/tool/IPC arguments. */
  localAuthorization?: LocalPersonRun
  /** Host delivery of this exact persisted run, including its terminal reply. */
  delivery?: boolean
  /**
   * The credential would be handed to an external engine process (an MCP
   * server it connects to itself), so it would leave the Host: always
   * refused. An engine's personal reads run on the Host through the tool host
   * instead, gated by the run's marks (ADR-0243 3C §4).
   */
  externalEngine?: boolean
}
export type PersonalCredentialRefusal =
  | "missing-identity"
  | "service-lane"
  | "multiple-requesters"
  | "trigger-not-personal"
  | "owner-not-verified"
  | "external-engine"
  | "mark-unavailable"
export type PersonalCredentialDecision =
  | { ok: true; source: PersonalCredentialSource; person: PrincipalRefV1 }
  | {
      ok: false
      source: PersonalCredentialSource
      reason: PersonalCredentialRefusal
      cause?: unknown
    }

export class PersonalCredentialRefusedError extends Error {
  constructor(readonly decision: Extract<PersonalCredentialDecision, { ok: false }>) {
    super(`Personal credential ${decision.source} refused: ${decision.reason}`)
    this.name = "PersonalCredentialRefusedError"
  }
}

/** Sources a Host delivery of a finished run still uses: its reply goes out as the person. */
const DELIVERY_SOURCES: ReadonlySet<PersonalCredentialSource> = new Set(["lark-user"])

/**
 * The person whose own credentials this run may use: the acting principal of
 * a delegated requester or schedule run, or the local person of a local or
 * schedule run they authorized. Every other run uses nobody's.
 */
function runPerson(identity: ActingIdentityV1): PrincipalRefV1 | undefined {
  if (
    identity.trigger !== "requester" &&
    identity.trigger !== "local" &&
    identity.trigger !== "schedule"
  )
    return undefined
  if (identity.lane === "delegated") return identity.actingPrincipal
  if (identity.trigger !== "requester" && identity.authorizingPrincipal?.kind === "local-person")
    return identity.authorizingPrincipal
  return undefined
}

/**
 * Admit `credential.person`'s own credential for this context, or refuse.
 * The person is whoever the credential belongs to; it is admitted only when
 * the run (or the direct Host UI action) acts as that same person, and the
 * run is then marked with them.
 */
export async function admitPersonalCredential(
  context: PersonalCredentialContext | undefined,
  credential: { source: PersonalCredentialSource; person: PrincipalRefV1 }
): Promise<PersonalCredentialDecision> {
  const refuse = (
    reason: PersonalCredentialRefusal,
    cause?: unknown
  ): PersonalCredentialDecision => ({
    ok: false,
    source: credential.source,
    reason,
    ...(cause ? { cause } : {}),
  })
  if (context?.externalEngine) return refuse("external-engine")
  try {
    // A run can never be overridden by direct-UI proof. Before a desktop turn
    // exists, its Host entry may explicitly forward the same LOCAL_PERSON_RUN
    // admission used by startDirectChatExecutionRun.
    const direct =
      context?.executionRunId === undefined && context?.localAuthorization === LOCAL_PERSON_RUN
    const identity =
      context?.sessionId || context?.executionRunId !== undefined
        ? await resolveRunActingIdentity(
            context?.sessionId,
            context?.executionRunId,
            context?.delivery && DELIVERY_SOURCES.has(credential.source)
              ? { delivery: true }
              : undefined
          )
        : undefined
    let acting: PrincipalRefV1 | undefined
    if (direct) acting = LOCAL_PERSON
    else {
      if (!identity) return refuse("missing-identity")
      if (identity.lane === "service") return refuse("service-lane")
      if (identity.requesters.length > 1) return refuse("multiple-requesters")
      acting = runPerson(identity)
      if (!acting) return refuse("trigger-not-personal")
    }
    if (
      !samePerson(acting, credential.person) &&
      !samePersonForHost(acting, credential.person, await readHostPersonContext())
    )
      return refuse("owner-not-verified")
    if (identity && context) {
      try {
        await markPersonalCredential(context, identity, acting, credential.source)
      } catch (cause) {
        return refuse("mark-unavailable", cause)
      }
    }
    return { ok: true, source: credential.source, person: acting }
  } catch (cause) {
    return refuse("owner-not-verified", cause)
  }
}
