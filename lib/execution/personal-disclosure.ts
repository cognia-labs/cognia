/** Host-only disclosure capabilities and transactional consumption.
 * Kept out of the portable sink policy and plugin APIs: serialized fields grant nothing.
 */
import Dexie from "dexie"
import type {
  PrincipalRefV1,
  PersonalMarkV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import type { PersonalSinkContext } from "./personal-sink"
import type { OutboundRequest } from "@/types/connectors"
import type { CogniaDB } from "@/lib/db/schema"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import { stableJson } from "@/lib/account-sync/data/stable-json"
import { sha256String } from "@/lib/utils/hash"
import { parseConversationKey } from "@/types/connectors/event"

export interface PersonalDisclosureTarget {
  adapterId: string
  conversationKey: string
}
export interface PendingPersonalDisclosure {
  request: OutboundRequest
  contentHash: string
  originalTarget: PersonalDisclosureTarget
  persons: PrincipalRefV1[]
  context: PersonalSinkContext
  sessionId: string
  messageId: string
  messageHash: string
  createdAt: number
  expiresAt: number
  closedAt?: number
  /** Until phase 5 supplies declared recipients, this lane cannot disclose. */
  lane: "delegated" | "bound-person"
  privateEphemeral?: boolean
  grantedName?: string
  callbackCard?: { conversationKey: string; messageId: string }
}

export function declaredRecipientsCoverDisclosure(scope: {
  lane: "delegated" | "bound-person"
  target: PersonalDisclosureTarget
}): boolean {
  return scope.lane !== "bound-person"
}

export function requestMatchesPersonalDisclosureTarget(
  request: OutboundRequest,
  target: PersonalDisclosureTarget
): boolean {
  try {
    const key = parseConversationKey(target.conversationKey),
      ref = request.conversationRef
    return (
      key.adapterId === target.adapterId &&
      ref.adapterId === target.adapterId &&
      ref.platform === key.platform &&
      (request.threadId === undefined || request.threadId === key.threadId) &&
      (ref.threadId === undefined || ref.threadId === key.threadId) &&
      (request.deliveryTarget
        ? request.deliveryTarget.address.adapterId === target.adapterId &&
          request.deliveryTarget.address.conversationKey === target.conversationKey &&
          request.deliveryTarget.address.containerId === key.remoteChatId &&
          (request.deliveryTarget.address.topicId === undefined ||
            request.deliveryTarget.address.topicId === key.threadId) &&
          stableJson(request.deliveryTarget.conversationRef) === stableJson(ref)
        : ref.channelId === key.remoteChatId)
    )
  } catch {
    return false
  }
}

export async function personalDisclosureHash(request: unknown): Promise<string> {
  return sha256String(stableJson(request))
}

export function personalDisclosureMessageHash(message: object): Promise<string> {
  const row = message as { parts?: unknown; role?: unknown }
  return personalDisclosureHash({ role: row.role, parts: row.parts })
}

interface Capability {
  receiptId: string
  jobId?: string
  database: CogniaDB
}
const capabilities = new WeakMap<object, Capability>()
async function currentDb(): Promise<CogniaDB> {
  const { getDb } = await import("@/lib/db/schema")
  return getDb()
}

export function copyPersonalDisclosureCapability<T extends object>(source: object, target: T): T {
  const capability = capabilities.get(source)
  if (capability) capabilities.set(target, capability)
  return target
}
export function hasPersonalDisclosureCapability(context: object): boolean {
  return capabilities.has(context)
}

/** Called only after the strict Host callback path has recorded the grant. */
export function personalDisclosureContext(
  context: PersonalSinkContext,
  receiptId: string,
  database: CogniaDB
): PersonalSinkContext {
  const result = structuredClone(context)
  capabilities.set(result, { receiptId, database })
  return result
}

/** A runner recovers only its own committed delivery; plugins cannot mint this binding. */
export function personalDisclosureContextForJob(
  context: PersonalSinkContext,
  job: OutboundJobRow,
  database: CogniaDB
): PersonalSinkContext {
  if (job.personalDisclosureReceiptId)
    capabilities.set(context, {
      receiptId: job.personalDisclosureReceiptId,
      jobId: job.id,
      database,
    })
  return context
}

export async function matchingPersonalDisclosure(
  context: PersonalSinkContext,
  payload: unknown,
  target: unknown,
  marks: readonly PersonalMarkV1[],
  db: CogniaDB | undefined = undefined,
  now = Date.now()
): Promise<boolean> {
  db ??= await currentDb()
  const capability = capabilities.get(context)
  if (
    !capability ||
    capability.database !== db ||
    payload === undefined ||
    marks.some((mark) => mark.source === "bound-person")
  )
    return false
  const row = await db.actionReviewReceipts.get(capability.receiptId)
  const personal = row?.personal,
    pending = row?.personalDisclosurePending,
    grant = personal?.disclosure
  if (
    !personal?.contentHash ||
    !pending ||
    !grant ||
    pending.closedAt !== undefined ||
    pending.expiresAt <= now ||
    grant.expiresAt <= now ||
    !requestMatchesPersonalDisclosureTarget(pending.request, pending.originalTarget) ||
    !declaredRecipientsCoverDisclosure({ lane: pending.lane, target: pending.originalTarget }) ||
    stableJson(target) !== stableJson(pending.originalTarget) ||
    stableJson(grant.target) !== stableJson(pending.originalTarget) ||
    stableJson(personal.originalTarget) !== stableJson(pending.originalTarget) ||
    grant.contentHash !== personal.contentHash ||
    pending.contentHash !== personal.contentHash ||
    (capability.jobId
      ? grant.jobId !== capability.jobId || grant.consumedAt === undefined
      : grant.consumedAt !== undefined)
  )
    return false
  const persons = [...new Set(marks.map((mark) => stableJson(mark.person)))].sort()
  if (
    !persons.length ||
    stableJson(persons) !== stableJson([...new Set(pending.persons.map(stableJson))].sort()) ||
    stableJson(personal.persons) !== stableJson(pending.persons)
  )
    return false
  const hash = await personalDisclosureHash(payload)
  return (
    hash === grant.contentHash &&
    (await personalDisclosureHash(pending.request)) === hash &&
    (await currentDb()) === db
  )
}

/** Runs inside the queue transaction. Failure rolls back both the grant and the job. */
export async function consumePersonalDisclosureForEnqueue(
  db: CogniaDB,
  context: PersonalSinkContext | undefined,
  jobs: OutboundJobRow[]
): Promise<void> {
  if (!context || !capabilities.has(context)) return
  const capability = capabilities.get(context)!
  if (capability.jobId || jobs.length !== 1) throw new Error("PERSONAL_DISCLOSURE_INVALID_ENQUEUE")
  const job = jobs[0]
  const { readRunPersonalTaint } = await import("./personal-sink")
  const taint = await readRunPersonalTaint(context)
  if (
    !taint.verified ||
    !(await Dexie.waitFor(
      matchingPersonalDisclosure(
        context,
        job.request,
        { adapterId: job.adapterId, conversationKey: job.conversationKey },
        taint.marks,
        db
      )
    ))
  )
    throw new Error("PERSONAL_DISCLOSURE_CHANGED_OR_CONSUMED")
  const row = (await db.actionReviewReceipts.get(capability.receiptId))!
  const pending = row.personalDisclosurePending!
  const message = await db.messages.get(pending.messageId)
  if (
    !message ||
    message.sessionId !== pending.sessionId ||
    (await Dexie.waitFor(personalDisclosureMessageHash(message))) !== pending.messageHash
  )
    throw new Error("PERSONAL_DISCLOSURE_MESSAGE_CHANGED")
  const disclosure = { ...row.personal!.disclosure!, consumedAt: Date.now(), jobId: job.id }
  await db.actionReviewReceipts.update(row.id, { personal: { ...row.personal!, disclosure } })
  job.personalDisclosureReceiptId = row.id
  await db.outboundQueue.update(job.id, { personalDisclosureReceiptId: row.id })
}

/** Publish history only after the queue reports the exact granted delivery succeeded. */
export async function commitPersonalDisclosureHistory(job: OutboundJobRow): Promise<void> {
  if (!job.personalDisclosureReceiptId) return
  const db = await currentDb()
  await db.transaction("rw", db.actionReviewReceipts, db.messages, db.outboundQueue, async () => {
    const row = await db.actionReviewReceipts.get(job.personalDisclosureReceiptId!)
    const pending = row?.personalDisclosurePending,
      grant = row?.personal?.disclosure
    if (!pending || !grant || grant.jobId !== job.id)
      throw new Error("PERSONAL_DISCLOSURE_MISSING_GRANT")
    if ((await db.outboundQueue.get(job.id))?.status !== "sent") return
    const message = await db.messages.get(pending.messageId)
    if (
      !message ||
      message.sessionId !== pending.sessionId ||
      grant.contentHash !== (await Dexie.waitFor(personalDisclosureHash(job.request))) ||
      !requestMatchesPersonalDisclosureTarget(job.request, grant.target) ||
      (await Dexie.waitFor(personalDisclosureMessageHash(message))) !== pending.messageHash
    )
      return
    const entry = {
      ...grant,
      messageId: pending.messageId,
      sessionId: pending.sessionId,
      persons: pending.persons,
      receiptId: row!.id,
      messageHash: pending.messageHash,
    }
    await db.messages.update(message.id, {
      metadata: { ...message.metadata, personalDisclosures: [entry] },
    })
  })
}
