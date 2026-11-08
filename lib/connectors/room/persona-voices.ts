/**
 * A room member's own bot (ADR-0177 batch 4, ADR-0252 P7).
 *
 * An IM group bound to a character team answers through its conversation's
 * bot, every member signing its reply with its name. A team that wants each
 * persona to be a bot of its own maps members to sibling bots of the same
 * platform sitting in the same chat (`ConversationOverrideRow.
 * memberBotAdapterIds`). The member's reply then leaves through that bot,
 * the same reroute a respond-via dispatch rule takes
 * (`resolveRespondViaTarget`), and needs no signature when the bot speaks for
 * that member alone.
 *
 * Two things follow from a bot being a voice, both decided here:
 *
 * - **It does not answer the group itself.** A person's message reaches every
 *   bot in the chat, so the voice's own conversation would otherwise run a
 *   turn of its own next to the room's. While a sibling's room in the same
 *   chat names it, its turns are history only (`personaVoiceRoomOf`).
 * - **Its posts are not new messages to the room.** A platform that shows
 *   bots each other's messages delivers the voice's post back to the room's
 *   bot. The room already holds that reply as the member's own row, so the
 *   echo is recognised by the outbound job that carried it
 *   (`findRespondViaEcho`) and is neither stored again nor answered.
 */

import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  OutboundJobRow,
} from "@/lib/db/connector-types"
import {
  buildConversationKey,
  deliveryTargetFromEvent,
  parseConversationKey,
  type NormalizedInboundEvent,
} from "@/types/connectors/event"

type VoiceOverride = Pick<ConversationOverrideRow, "characterTeamId" | "memberBotAdapterIds">

/** How long after it was queued a reply can still come back as an echo. */
export const RESPOND_VIA_ECHO_WINDOW_MS = 10 * 60_000

/** How long an echo that raced its own send waits for the send to report its id. */
export const RESPOND_VIA_ECHO_WAIT_MS = 3_000
const ECHO_POLL_MS = 200

/** The members' bots, empty without a character team. */
function voiceMap(override: VoiceOverride | null | undefined): Record<string, string> {
  if (!override?.characterTeamId?.trim()) return {}
  const map = override.memberBotAdapterIds
  if (!map || typeof map !== "object") return {}
  const out: Record<string, string> = {}
  for (const [characterId, adapterId] of Object.entries(map)) {
    if (typeof adapterId === "string" && adapterId.trim()) out[characterId] = adapterId.trim()
  }
  return out
}

/** The bot a member speaks through, when its room maps one to it. */
export function memberVoiceAdapterId(
  override: VoiceOverride | null | undefined,
  characterId: string
): string | undefined {
  return voiceMap(override)[characterId]
}

/**
 * Whether a reply that left through `adapterId` needs the member's name.
 * Only a bot that speaks for this member and nobody else goes unsigned: the
 * room's own bot, a fallback to it, and a bot two members share all sign.
 */
export function voiceNeedsSignature(
  override: VoiceOverride | null | undefined,
  characterId: string,
  adapterId: string,
  receivingAdapterId: string
): boolean {
  if (adapterId === receivingAdapterId) return true
  const map = voiceMap(override)
  if (map[characterId] !== adapterId) return true
  return Object.values(map).filter((voice) => voice === adapterId).length !== 1
}

/** The keys a sibling's conversation for the same chat can have: with the thread, then without. */
function siblingConversationKeys(
  event: NormalizedInboundEvent,
  siblingAdapterId: string
): string[] {
  const address = deliveryTargetFromEvent(event).address
  const keys = [
    buildConversationKey(address.platform, siblingAdapterId, address.containerId, address.topicId),
  ]
  if (address.topicId) {
    keys.push(buildConversationKey(address.platform, siblingAdapterId, address.containerId))
  }
  return keys
}

export interface PersonaVoiceDeps {
  listAdapters: (type: AdapterInstanceRow["type"]) => Promise<AdapterInstanceRow[]>
  readOverride: (conversationKey: string) => Promise<VoiceOverride | null | undefined>
}

/**
 * The conversation key of the room this bot is a member's voice in, for a
 * group message this bot received; `undefined` when it is nobody's voice
 * here. A one-to-one chat is never a room.
 */
export async function personaVoiceRoomOf(
  event: NormalizedInboundEvent,
  adapterRow: Pick<AdapterInstanceRow, "id" | "type">,
  deps: PersonaVoiceDeps
): Promise<string | undefined> {
  if (event.channel.kind === "private") return undefined
  const siblings = (await deps.listAdapters(adapterRow.type)).filter(
    (row) => row.id !== adapterRow.id && row.enabled
  )
  for (const sibling of siblings) {
    for (const key of siblingConversationKeys(event, sibling.id)) {
      const override = await deps.readOverride(key)
      if (Object.values(voiceMap(override)).includes(adapterRow.id)) return key
    }
  }
  return undefined
}

export interface RespondViaEchoDeps {
  /** The sibling conversation's outbound jobs queued at or after `since`. */
  listJobs: (conversationKey: string, since: number) => Promise<OutboundJobRow[]>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** The inbound conversation an ai-run reply answered, from what authorised it. */
function answeredConversationKey(job: OutboundJobRow): string | undefined {
  const authorization = job.authorizationProvenance?.authorization as
    { kind?: unknown; inboundConversationKey?: unknown } | undefined
  return authorization?.kind === "origin-reply" &&
    typeof authorization.inboundConversationKey === "string"
    ? authorization.inboundConversationKey
    : undefined
}

/** Whether `job` answered a message of `event`'s chat through this bot's own conversation. */
function answersThisChat(job: OutboundJobRow, event: NormalizedInboundEvent): boolean {
  if (job.source !== "ai-run" || job.adapterId === event.adapterId) return false
  const answered = answeredConversationKey(job)
  if (!answered) return false
  // The same chat of this bot, a thread of it or not: both keys are this
  // adapter's own, so their chat ids compare directly.
  try {
    const parsed = parseConversationKey(answered)
    const own = parseConversationKey(event.conversationKey)
    return parsed.adapterId === own.adapterId && parsed.remoteChatId === own.remoteChatId
  } catch {
    return false
  }
}

const IN_FLIGHT: ReadonlySet<OutboundJobRow["status"]> = new Set(["pending", "sending"])

/**
 * The outbound job a sibling bot's message came from, when that message is
 * a reply this bot's conversation sent through the sibling. A send that has
 * not reported its platform id yet is waited for briefly: some platforms
 * deliver a bot's message to the others before the send call returns.
 */
export async function findRespondViaEcho(
  event: NormalizedInboundEvent,
  siblingAdapterId: string,
  deps: RespondViaEchoDeps
): Promise<OutboundJobRow | undefined> {
  if (!event.messageId) return undefined
  const keys = siblingConversationKeys(event, siblingAdapterId)
  const deadline = deps.now() + RESPOND_VIA_ECHO_WAIT_MS
  for (;;) {
    const since = deps.now() - RESPOND_VIA_ECHO_WINDOW_MS
    const jobs = (await Promise.all(keys.map((key) => deps.listJobs(key, since))))
      .flat()
      .filter((job) => answersThisChat(job, event))
    const echo = jobs.find((job) => job.platformMessageId === event.messageId)
    if (echo) return echo
    const racing = jobs.some((job) => IN_FLIGHT.has(job.status) && !job.platformMessageId)
    if (!racing || deps.now() >= deadline) return undefined
    await deps.sleep(ECHO_POLL_MS)
  }
}
