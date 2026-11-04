/** ADR-0243: the single Host admission point for a person's own credentials.
 * Direct UI actions carry an in-memory symbol; serialized labels never grant.
 * Execution contexts always resolve their persisted identity root afresh.
 */
import { LOCAL_PERSON_RUN, resolveRunActingIdentity, type LocalPersonRun } from "./acting-authority"
import { markPersonalCredential } from "./personal-marks"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { BuiltInSkillContext } from "@/lib/skills/built-in/types"
import type { VerifiedLarkUserAuthorization } from "@/lib/skills/built-in/lark/acting-identity"

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
  /** Host UI entries only. Never populate from plugin/tool/IPC arguments. */
  localAuthorization?: LocalPersonRun
  larkContext?: BuiltInSkillContext
  /** Host delivery of this exact persisted run, including its terminal reply. */
  delivery?: boolean
  /** External engines have no admitted personal broker/isolation in this slice. */
  externalEngine?: boolean
}
export type PersonalCredentialRefusal =
  | "missing-identity"
  | "service-lane"
  | "multiple-requesters"
  | "trigger-not-personal"
  | "owner-not-verified"
  | "authorization-unavailable"
  | "external-engine"
  | "mark-unavailable"
export type PersonalCredentialDecision =
  | {
      ok: true
      source: PersonalCredentialSource
      person?: string
      authorization?: VerifiedLarkUserAuthorization
    }
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

export async function admitPersonalCredential(
  context: PersonalCredentialContext | undefined,
  credential: { source: PersonalCredentialSource; person?: string }
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
            credential.source === "lark-user" && context?.delivery ? { delivery: true } : undefined
          )
        : undefined
    const admit = async (
      authorization?: VerifiedLarkUserAuthorization
    ): Promise<PersonalCredentialDecision> => {
      if (identity && context) {
        const local =
          (identity.trigger === "local" || identity.trigger === "schedule") &&
          identity.authorizingPrincipal?.kind === "local-person"
        const person: PrincipalRefV1 | undefined = direct
          ? { kind: "local-person" }
          : local
            ? identity.authorizingPrincipal
            : authorization
              ? (
                  await import("@/lib/skills/built-in/lark/acting-identity")
                ).verifiedLarkAuthorizationPerson(authorization)
              : undefined
        if (!person) return refuse("owner-not-verified")
        try {
          await markPersonalCredential(context, identity, person, credential.source)
        } catch (cause) {
          return refuse("mark-unavailable", cause)
        }
      }
      return { ok: true, ...credential, ...(authorization ? { authorization } : {}) }
    }
    if (!direct) {
      if (!identity) return refuse("missing-identity")
      if (identity.lane === "service") return refuse("service-lane")
      if (identity.requesters.length > 1) return refuse("multiple-requesters")
      const local =
        (identity.trigger === "local" || identity.trigger === "schedule") &&
        identity.authorizingPrincipal?.kind === "local-person"
      if (!local) {
        if (
          credential.source !== "lark-user" ||
          !credential.person ||
          !context?.larkContext ||
          (identity.trigger !== "requester" && identity.trigger !== "local")
        )
          return refuse("trigger-not-personal")
        const { verifyLarkImOwnerAuthorization } =
          await import("@/lib/skills/built-in/lark/acting-identity")
        const authorization = await verifyLarkImOwnerAuthorization(
          credential.person,
          context.larkContext
        )
        if (!authorization) return refuse("owner-not-verified")
        return await admit(authorization)
      }
      if (credential.source === "lark-user" && credential.person && context?.larkContext) {
        const { verifyLarkImOwnerAuthorization } =
          await import("@/lib/skills/built-in/lark/acting-identity")
        const authorization = await verifyLarkImOwnerAuthorization(
          credential.person,
          context.larkContext
        )
        if (authorization) return await admit(authorization)
      }
    }
    return await admit()
  } catch (cause) {
    return refuse("owner-not-verified", cause)
  }
}
