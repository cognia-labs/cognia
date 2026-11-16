/**
 * Personal Lark access for built-in skills, the adapter's user-token HTTP path
 * and the lark-cli bridge (ADR-0243 phase 4): a call uses the authorization of
 * the person the run acts as, admitted by the kernel's single admission point.
 */
import {
  admitPersonalCredential,
  type PersonalCredentialContext,
} from "@/lib/execution/personal-credential"
import enSkillMessages from "@/i18n/messages/en/skills.json"
import { currentLocale } from "@/lib/i18n/runtime-translator"
import {
  resolveBuiltInSkillRunScope,
  resolveBuiltInSkillSessionBinding,
} from "@/lib/skills/built-in/context"
import type { BuiltInSkillContext } from "@/lib/skills/built-in/types"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import {
  observeActingAuthority,
  snapshotActingAuthority,
  resolveRunActingIdentity,
} from "@/lib/execution/acting-authority"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { loggers } from "@cognia/logging"
import { larkActingPerson } from "../host-auth"

/** One person's token, captured with its epoch in a single Host snapshot. */
export interface LarkUserAuthorization {
  /** Whose authorization this is (`larkUserKey`). */
  principal: string
  accessToken: string
  authorizationEpoch: string
}

export class LarkActingIdentityError extends Error {
  readonly reason = "personal_access_refused" as const

  constructor(hint = enSkillMessages.actingIdentity.personalAccessRule) {
    super(`personal_access_refused: this run cannot use a Lark personal authorization. ${hint}`)
    this.name = "LarkActingIdentityError"
  }
}

/** Resolve the executing identity root, including host-registered child routes. */
export async function resolveLarkRunIdentity(ctx: BuiltInSkillContext) {
  const scope = resolveBuiltInSkillRunScope(ctx)
  return resolveRunActingIdentity(
    scope.sessionId,
    scope.runId,
    ctx.delivery ? { delivery: true } : undefined
  )
}

/** Literal catalog message, shared by the HTTP gate and user-only CLI calls. */
export async function larkPersonalAccessHint(): Promise<string> {
  return (await currentLocale()) === "zh-CN"
    ? (await import("@/i18n/messages/zh-CN/skills.json")).actingIdentity.personalAccessRule
    : enSkillMessages.actingIdentity.personalAccessRule
}

/** The admission context of a built-in skill call. */
export function larkSkillCredentialContext(ctx: BuiltInSkillContext): PersonalCredentialContext {
  const scope = resolveBuiltInSkillRunScope(ctx)
  return {
    sessionId: scope.sessionId,
    executionRunId: scope.runId,
    ...(ctx.delivery ? { delivery: true } : {}),
  }
}

/**
 * The acting person's own Lark authorization, admitted and marked. Throws
 * `LarkActingIdentityError` when the run may use nobody's; `undefined` when
 * the person it may use has not authorized the adapter.
 */
export async function admitLarkUserAuthorization(
  adapterId: string,
  credentialContext: PersonalCredentialContext | undefined
): Promise<LarkUserAuthorization | undefined> {
  const authoritySnapshot = credentialContext?.sessionId
    ? snapshotActingAuthority(credentialContext.sessionId, credentialContext.executionRunId)
    : undefined
  const refusal = async () => new LarkActingIdentityError(await larkPersonalAccessHint())
  // An identity that cannot be read is nobody's, as the kernel admission treats it.
  const acting = await larkActingPerson(adapterId, credentialContext).catch(() => undefined)
  if (!acting) throw await refusal()
  const admission = await admitPersonalCredential(credentialContext, {
    source: "lark-user",
    person: acting.person,
  })
  if (!admission.ok) throw await refusal()
  void authoritySnapshot
    ?.then((seen) => {
      if (seen) return observeActingAuthority(seen.runId, seen.revision, "lark-personal-token")
    })
    .catch(() => undefined)
  const principal = acting.key
  const snapshot = principal
    ? await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
    : undefined
  if (
    !principal ||
    !snapshot?.configured ||
    !snapshot.accessToken ||
    !snapshot.authorizationEpoch
  ) {
    // A requester who never authorized gets their own link, privately.
    if (acting.person.kind === "platform")
      await offerLink(adapterId, acting.person, credentialContext, authoritySnapshot)
    return
  }
  return {
    principal,
    accessToken: snapshot.accessToken,
    authorizationEpoch: snapshot.authorizationEpoch,
  }
}

/** Hand the acting requester an authorization link as a delivery of their turn. */
async function offerLink(
  adapterId: string,
  person: PrincipalRefV1,
  credentialContext: PersonalCredentialContext | undefined,
  authoritySnapshot: ReturnType<typeof snapshotActingAuthority> | undefined
): Promise<void> {
  const sessionId = credentialContext?.sessionId
  const executionRunId = credentialContext?.executionRunId ?? (await authoritySnapshot)?.runId
  if (!sessionId || !executionRunId) return
  const { binding } = await resolveBuiltInSkillSessionBinding(sessionId)
  if (!binding?.conversationKey || binding.adapterId !== adapterId) return
  const { offerDelegatedAuthorization } = await import("@/lib/connectors/delegated-authorization")
  // A link that cannot be issued (no relay registered) leaves the plain refusal.
  await offerDelegatedAuthorization({
    adapterId,
    conversationKey: binding.conversationKey,
    executionRunId,
    person,
  }).catch((error: unknown) =>
    loggers.network.warn("[lark] authorization link not delivered", {
      adapterId,
      reason: error instanceof Error ? error.message : String(error),
    })
  )
}

/** `admitLarkUserAuthorization` for a built-in skill call. */
export async function assertLarkActingIdentity(
  adapterId: string,
  ctx?: BuiltInSkillContext
): Promise<LarkUserAuthorization | undefined> {
  const refusal = async () => new LarkActingIdentityError(await larkPersonalAccessHint())
  // A plugin invocation cannot borrow the host's current desktop or IM run.
  if (!ctx || ctx.outboundAuthorization?.kind === "plugin") throw await refusal()
  // A session a plugin, Bot or sync created is no personal desktop lane,
  // whatever run it carries; only its IM binding can make it a person's.
  const lane = await resolveBuiltInSkillSessionBinding(
    ctx.hitlBypass ? (ctx.imAuthoritySessionId ?? ctx.sessionId) : ctx.sessionId
  ).catch(() => undefined)
  if (!lane || (!lane.binding && !lane.personalRunOnly && lane.personalLane !== "local-session"))
    throw await refusal()
  return admitLarkUserAuthorization(adapterId, larkSkillCredentialContext(ctx))
}
