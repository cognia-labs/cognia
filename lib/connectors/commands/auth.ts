/**
 * `/auth` — a person's own delegated authorization (ADR-0243 phase 4, D9).
 *
 * `/auth` sends the sender a link to authorize Cognia to use their own
 * account on this bot; `/auth revoke` forgets that authorization, so their
 * next request refuses. Both act on the sender alone, in a direct chat with
 * the bot, and only for a sender the principal registry resolved: with the
 * registry off nobody but the local person has personal access (D6).
 *
 * Bilingual literals, like every other command reply (see `render.ts`).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorRequester } from "@/lib/execution/acting-authority"
import { readResolvedPrincipal } from "@/lib/execution/resolved-principal"
import { isPrivateConversation } from "../conversation-admission"
import { authorizationLinkText, forgetAuthorizationOffer } from "../delegated-authorization"
import { connectorVendor } from "../vendor-contribution"

export interface AuthCommandInput {
  event: NormalizedInboundEvent
  arg: string
  adapterRow: AdapterInstanceRow
  reply: (
    text: string,
    outcome: "applied" | "denied" | "unknown",
    extra?: Record<string, unknown>
  ) => Promise<void>
}

export async function handleAuthCommand(input: AuthCommandInput): Promise<void> {
  const { event, adapterRow, reply } = input
  const sub = input.arg.trim().toLowerCase()
  if (sub !== "" && sub !== "revoke") {
    await reply("用法 / Usage: /auth | /auth revoke", "unknown")
    return
  }
  const credentials = connectorVendor(adapterRow.type)?.delegatedCredentials
  if (!credentials) {
    await reply("此平台没有个人授权 / This platform has no per-person authorization", "unknown", {
      reason: "unsupported",
    })
    return
  }
  if (!readResolvedPrincipal(event.channelData)) {
    await reply(
      "个人授权需要先开启身份注册表 / Personal authorization needs the principal registry turned on",
      "denied",
      { reason: "registry_off" }
    )
    return
  }
  if (!isPrivateConversation(event)) {
    await reply(
      "请在与机器人的私聊中使用 /auth / Use /auth in a direct chat with the bot",
      "denied",
      { reason: "not_private" }
    )
    return
  }
  const person = connectorRequester(event)
  if (sub === "revoke") {
    await credentials.revoke(adapterRow, person)
    forgetAuthorizationOffer(adapterRow.id, person)
    await reply("已撤销你的授权 / Your authorization is revoked", "applied", { op: "revoke" })
    return
  }
  const state = await credentials.stateFor(adapterRow, person)
  if (state.status === "authorized") {
    await reply(
      "你已授权；发送 /auth revoke 可撤销 / You have authorized; send /auth revoke to revoke",
      "applied",
      { op: "status" }
    )
    return
  }
  await reply(
    authorizationLinkText(await credentials.beginAuthorization(adapterRow, person)),
    "applied",
    { op: "link" }
  )
}
