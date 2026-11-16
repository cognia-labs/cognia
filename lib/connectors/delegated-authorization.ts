/**
 * The delegated lane's authorization link (ADR-0243 phase 4, D7) and a
 * person's own revocation (D9), vendor-neutral over
 * `ConnectorVendorContribution.delegatedCredentials`.
 *
 * A requester whose turn needs their own authorization, and who has none,
 * gets a link only they can complete. It goes out as a delivery of the turn
 * itself: the turn's run is already marked with that person (their admission
 * marked it), so the personal-delivery routing narrows it to them, an
 * ephemeral card in a group, the conversation when it is their direct chat,
 * else a direct message, and withholds it behind a fixed notice when none
 * of those reaches them. The turn ends there; the person asks again after
 * authorizing, and no turn waits for a sign-in.
 */

import {
  principalKey,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { parseConversationKey } from "@/types/connectors/event"
import type { OutboundRequest } from "@/types/connectors"
import { connectorVendor } from "./vendor-contribution"

/** One link per person and adapter while the last one can still be completed. */
const LINK_TTL_MS = 10 * 60_000
const offered = new Map<string, number>()

export type AuthorizationOffer = "queued" | "already-offered" | "unsupported"

/** Bilingual, like every in-chat Host reply; it names no content of the turn. */
export function authorizationLinkText(url: string): string {
  return (
    `请点击链接授权 Cognia 使用你自己的账号，完成后再发一次请求：${url}\n` +
    `Authorize Cognia to use your own account, then ask again: ${url}`
  )
}

export async function offerDelegatedAuthorization(input: {
  adapterId: string
  conversationKey: string
  /** The turn whose run is marked with `person`; the link is its delivery. */
  executionRunId: string
  person: PrincipalRefV1
  now?: number
}): Promise<AuthorizationOffer> {
  const row = await getAdapterInstance(input.adapterId)
  const credentials = row && connectorVendor(row.type)?.delegatedCredentials
  if (!row || !credentials) return "unsupported"
  const now = input.now ?? Date.now()
  const slot = `${row.id}\u0000${principalKey(input.person)}`
  if ((offered.get(slot) ?? -Infinity) > now - LINK_TTL_MS) return "already-offered"
  offered.set(slot, now)
  const url = await credentials.beginAuthorization(row, input.person)
  const key = parseConversationKey(input.conversationKey)
  const request: OutboundRequest = {
    conversationRef: {
      platform: key.platform,
      adapterId: key.adapterId,
      channelId: key.remoteChatId,
    },
    segments: [{ type: "text", text: authorizationLinkText(url) }],
    metadata: { idempotencyKey: `delegated-authorization:${input.executionRunId}` },
  }
  const { enqueueGoverned } = await import("./delivery-gateway")
  await enqueueGoverned({
    adapterId: row.id,
    conversationKey: input.conversationKey,
    request,
    source: "ai-run",
    personalContext: { executionRunId: input.executionRunId },
    authorization: { kind: "system-notice", inboundConversationKey: input.conversationKey },
  })
  return "queued"
}

/** Forget the throttle (a revocation lets the person authorize again at once). */
export function forgetAuthorizationOffer(adapterId: string, person: PrincipalRefV1): void {
  offered.delete(`${adapterId}\u0000${principalKey(person)}`)
}
