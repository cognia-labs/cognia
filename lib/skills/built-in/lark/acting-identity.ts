/** Shared ownership check for CLI skills and the adapter's user-token HTTP path. */
import { admitPersonalCredential } from "@/lib/execution/personal-credential"
import enSkillMessages from "@/i18n/messages/en/skills.json"
import { currentLocale } from "@/lib/i18n/runtime-translator"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  resolveBuiltInSkillRunScope,
  resolveBuiltInSkillSessionBinding,
  resolveBuiltInSkillTurnActors,
} from "../context"
import type { BuiltInSkillContext } from "../types"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import {
  observeActingAuthority,
  snapshotActingAuthority,
  resolveRunActingIdentity,
} from "@/lib/execution/acting-authority"

export interface VerifiedLarkUserAuthorization {
  accessToken: string
  authorizationEpoch: string
}

export class LarkActingIdentityError extends Error {
  readonly reason = "sender_not_token_owner" as const

  constructor(owner?: string, hint = enSkillMessages.actingIdentity.personalAccessPhases) {
    super(
      (owner
        ? `sender_not_token_owner: this Lark action runs with ${owner}'s personal authorization; only ${owner} can use it from chat.`
        : "sender_not_token_owner: cannot verify that every IM sender owns this Lark personal authorization.") +
        ` ${hint}`
    )
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
    ? (await import("@/i18n/messages/zh-CN/skills.json")).actingIdentity.personalAccessPhases
    : enSkillMessages.actingIdentity.personalAccessPhases
}

export async function verifyLarkImOwnerAuthorization(
  adapterId: string,
  ctx?: BuiltInSkillContext
): Promise<VerifiedLarkUserAuthorization | undefined> {
  const hint = await larkPersonalAccessHint()
  const refusal = (owner?: string) => new LarkActingIdentityError(owner, hint)
  if (!ctx) throw refusal()
  const authoritySnapshot = snapshotActingAuthority(ctx.sessionId, ctx.executionRunId)
  try {
    const { binding, personalLane, personalRunOnly, rootSessionId } =
      await resolveBuiltInSkillSessionBinding(
        ctx.hitlBypass ? (ctx.imAuthoritySessionId ?? ctx.sessionId) : ctx.sessionId
      )
    // A plugin invocation cannot borrow the host's current desktop or IM run.
    if (ctx.outboundAuthorization?.kind === "plugin") throw refusal()
    if (!binding) {
      // Never trust ctx.personalLane or treat a missing IM binding as consent.
      if (!personalRunOnly && personalLane !== "local-session") throw refusal()
      const identity = await resolveLarkRunIdentity(ctx)
      if (identity?.trigger !== "local" || identity.authorizingPrincipal?.kind !== "local-person")
        throw refusal()
      return
    }
    // Event actors never become requesters, even if the sender owns this token.
    const identity = await resolveLarkRunIdentity(ctx)
    if (
      !identity ||
      identity.lane === "service" ||
      (identity.trigger !== "requester" && identity.trigger !== "local")
    )
      throw refusal()
    // open_ids are app-scoped: another platform or adapter cannot prove ownership.
    if (binding.platform !== "lark" || binding.adapterId !== adapterId || !binding.conversationKey)
      throw refusal()
    const adapter = await getAdapterInstance(adapterId)
    const connected = adapter?.settings.connectedUser
    const owner =
      connected && typeof connected === "object"
        ? (connected as {
            openId?: unknown
            unionId?: unknown
            name?: unknown
            authorizationEpoch?: unknown
          })
        : undefined
    const ownerName = typeof owner?.name === "string" ? owner.name : undefined
    if (
      adapter?.type !== "lark" ||
      !adapter.enabled ||
      typeof owner?.openId !== "string" ||
      !owner.openId.trim()
    )
      throw refusal(ownerName)
    // Only the host's verified Confirm callback can replace the current run's actors.
    // Otherwise refresh the job view so a newly steered sender cannot use stale context.
    const deliverySenders =
      ctx.delivery && ctx.executionRunId
        ? identity.requesters.map((principal) =>
            principal.kind === "platform" &&
            principal.platform === "lark" &&
            principal.adapterId === adapterId
              ? {
                  remoteUserId: principal.remoteUserId,
                  ...(principal.unionId ? { unionId: principal.unionId } : {}),
                }
              : undefined
          )
        : undefined
    if (deliverySenders?.some((sender) => !sender)) throw refusal(ownerName)
    const senders = deliverySenders
      ? deliverySenders.filter((sender): sender is NonNullable<typeof sender> => !!sender)
      : ctx.hitlBypass
        ? (ctx.actingSenders ?? "unknown")
        : (await resolveBuiltInSkillTurnActors(binding.conversationKey, adapterId, rootSessionId))
            .actingSenders
    if (
      senders === "unknown" ||
      senders.length === 0 ||
      senders.some(
        (sender) =>
          sender.remoteUserId !== owner.openId ||
          (sender.unionId !== undefined &&
            typeof owner.unionId === "string" &&
            sender.unionId !== owner.unionId)
      )
    )
      throw refusal(ownerName)
    // The native token publication precedes the separate connectedUser write.
    void authoritySnapshot
      .then((seen) => {
        if (seen) return observeActingAuthority(seen.runId, seen.revision, "lark-personal-token")
      })
      .catch(() => undefined)
    // Never combine metadata for one authorization with another one's token.
    const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
    if (!snapshot.configured || !snapshot.accessToken || !snapshot.authorizationEpoch)
      throw refusal(ownerName)
    if (owner.authorizationEpoch !== undefined) {
      if (
        typeof owner.authorizationEpoch !== "string" ||
        owner.authorizationEpoch !== snapshot.authorizationEpoch
      )
        throw refusal(ownerName)
    } else if (snapshot.accountLabel !== (ownerName || owner.openId)) {
      throw refusal(ownerName)
    }
    return { accessToken: snapshot.accessToken, authorizationEpoch: snapshot.authorizationEpoch }
  } catch (err) {
    if (err instanceof LarkActingIdentityError) throw err
    throw refusal()
  }
}

/** All personal Lark consumers share the Host credential choke point. */
export async function assertLarkActingIdentity(
  adapterId: string,
  ctx?: BuiltInSkillContext
): Promise<VerifiedLarkUserAuthorization | undefined> {
  const scope = ctx ? resolveBuiltInSkillRunScope(ctx) : undefined
  const decision = await admitPersonalCredential(
    scope
      ? {
          sessionId: scope.sessionId,
          executionRunId: scope.runId,
          larkContext: ctx,
          ...(ctx?.delivery ? { delivery: true } : {}),
        }
      : undefined,
    { source: "lark-user", person: adapterId }
  )
  if (!decision.ok) {
    if (decision.cause instanceof LarkActingIdentityError) throw decision.cause
    throw new LarkActingIdentityError(undefined, await larkPersonalAccessHint())
  }
  if (decision.authorization) return decision.authorization
  // A local-person run still captures token+epoch atomically. Never fall back
  // to a separately read user_token after the admission decision.
  const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
  if (!snapshot.configured || !snapshot.accessToken || !snapshot.authorizationEpoch) return
  return { accessToken: snapshot.accessToken, authorizationEpoch: snapshot.authorizationEpoch }
}
