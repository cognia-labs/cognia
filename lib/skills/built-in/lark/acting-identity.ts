/** Shared ownership check for CLI skills and the adapter's user-token HTTP path. */
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { resolveBuiltInSkillTurnActors } from "../context"
import type { BuiltInSkillContext } from "../types"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"

export interface VerifiedLarkUserAuthorization {
  accessToken: string
  authorizationEpoch: string
}

export class LarkActingIdentityError extends Error {
  readonly reason = "sender_not_token_owner" as const

  constructor(owner?: string) {
    super(
      owner
        ? `sender_not_token_owner: this Lark action runs with ${owner}'s personal authorization; only ${owner} can use it from chat.`
        : "sender_not_token_owner: cannot verify that every IM sender owns this Lark personal authorization."
    )
    this.name = "LarkActingIdentityError"
  }
}

export async function assertLarkActingIdentity(
  adapterId: string,
  ctx?: BuiltInSkillContext
): Promise<VerifiedLarkUserAuthorization | undefined> {
  // Adapter/control-plane callers without a session are outside the IM skill lane.
  if (!ctx) return
  try {
    const { getDb } = await import("@/lib/db/schema")
    const session = await getDb().sessions.get(ctx.sessionId)
    if (!session) throw new LarkActingIdentityError()
    const binding = session.platformBinding
    if (!binding) return
    // open_ids are app-scoped: another platform or adapter cannot prove ownership.
    if (binding.platform !== "lark" || binding.adapterId !== adapterId || !binding.conversationKey)
      throw new LarkActingIdentityError()
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
      throw new LarkActingIdentityError(ownerName)
    // Only the host's verified Confirm callback can replace the current run's actors.
    // Otherwise refresh the job view so a newly steered sender cannot use stale context.
    const senders = ctx.hitlBypass
      ? (ctx.actingSenders ?? "unknown")
      : (await resolveBuiltInSkillTurnActors(binding.conversationKey, adapterId, ctx.sessionId))
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
      throw new LarkActingIdentityError(ownerName)
    // The native token publication precedes the separate connectedUser write.
    // Never combine metadata for one authorization with another one's token.
    const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
    if (!snapshot.configured || !snapshot.accessToken || !snapshot.authorizationEpoch)
      throw new LarkActingIdentityError(ownerName)
    if (owner.authorizationEpoch !== undefined) {
      if (
        typeof owner.authorizationEpoch !== "string" ||
        owner.authorizationEpoch !== snapshot.authorizationEpoch
      )
        throw new LarkActingIdentityError(ownerName)
    } else if (snapshot.accountLabel !== (ownerName || owner.openId)) {
      throw new LarkActingIdentityError(ownerName)
    }
    return { accessToken: snapshot.accessToken, authorizationEpoch: snapshot.authorizationEpoch }
  } catch (err) {
    if (err instanceof LarkActingIdentityError) throw err
    throw new LarkActingIdentityError()
  }
}
