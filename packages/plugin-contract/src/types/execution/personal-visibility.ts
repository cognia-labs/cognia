/** Portable history projection. Only a Host may supply readers and identity equivalence. */
import { contentDigest } from "@cognia/agent"
import {
  mergePersonalMarks,
  samePerson,
  type ActingIdentityV1,
  type PersonalMarkV1,
  type PrincipalRefV1,
} from "./acting-identity"

export interface PersonalHistoryMessage {
  id: string
  metadata?: unknown
  createdAt?: number
}

/** Phase 2D seam: there is deliberately no grant-bearing variant in phase 2B. */
export type PersonalHistoryDisclosure = { phase: "unavailable" }

export interface PersonalVisibilityContext {
  boundPerson?: PrincipalRefV1
  source?: string
  samePerson?: (left: PrincipalRefV1, right: PrincipalRefV1) => boolean
  personKey?: (person: PrincipalRefV1) => string
  disclosure?: PersonalHistoryDisclosure
}

/** A resolved identity must come from the Host's live root, never from message metadata. */
export function personalReaders(identity: ActingIdentityV1 | undefined): PrincipalRefV1[] {
  if (!identity || identity.lane === "service" || identity.trigger === "external-event") return []
  const isPerson = (person: PrincipalRefV1) =>
    person.kind === "local-person" || person.kind === "platform"
  // An invalid requester does not turn an incomplete set into a personal audience.
  if (identity.requesters.length)
    return identity.requesters.every(isPerson) ? [...identity.requesters] : []
  if (
    (identity.trigger === "schedule" || identity.trigger === "local") &&
    identity.authorizingPrincipal &&
    isPerson(identity.authorizingPrincipal)
  )
    return [identity.authorizingPrincipal]
  return []
}

export function effectivePersonalMarks(
  message: { metadata?: unknown; createdAt?: number },
  session: { platformBinding?: unknown },
  context: Pick<PersonalVisibilityContext, "boundPerson" | "source">
): PersonalMarkV1[] {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const explicit = metadata?.personalMarks as PersonalMarkV1[] | undefined
  if (explicit?.length) return mergePersonalMarks(explicit)
  if (metadata?.personalMarkVersion === 1 || !session.platformBinding) return []
  return [
    {
      person: context.boundPerson ?? { kind: "local-person" },
      source: context.source ?? "integration-user",
      markedAt: message.createdAt ?? 0,
    },
  ]
}

export function personalReaderKey(person: PrincipalRefV1): string {
  if (person.kind === "local-person")
    return JSON.stringify([person.kind, person.userId ?? null, person.accountId ?? null])
  if (person.kind === "platform")
    return JSON.stringify([person.kind, person.platform, person.adapterId, person.remoteUserId])
  return JSON.stringify(person)
}

function disclosureCoversReader(_disclosure: PersonalHistoryDisclosure | undefined): boolean {
  return false
}

/** A digest of sets, independent of ordering, message prose and credential labels. */
export function personalVisibilityDigest(
  readers: readonly PrincipalRefV1[],
  withheldMessageIds: readonly string[],
  context: Pick<PersonalVisibilityContext, "personKey"> = {}
): string {
  return `personal-v1:${contentDigest({
    readers: [...new Set(readers.map(context.personKey ?? personalReaderKey))].sort(),
    withheldMessageIds: [...new Set(withheldMessageIds)].sort(),
  })}`
}

/** One message-level filter for all engines and derived prompts. Never mutates canonical rows. */
export function withholdForReaders<T extends PersonalHistoryMessage>(
  messages: readonly T[],
  readers: readonly PrincipalRefV1[],
  session: { platformBinding?: unknown } = {},
  context: PersonalVisibilityContext = {}
): { messages: T[]; visibilityDigest: string; withheldMessageIds: string[] } {
  const equal = context.samePerson ?? samePerson
  const withheldMessageIds: string[] = []
  const filtered = messages.map((message) => {
    const marks = effectivePersonalMarks(message, session, context)
    if (
      !marks.length ||
      (readers.length > 0 &&
        readers.every((reader) =>
          marks.every(
            (mark) => equal(reader, mark.person) || disclosureCoversReader(context.disclosure)
          )
        ))
    )
      return message
    withheldMessageIds.push(message.id)
    const labels = [
      ...new Set(
        marks.map(({ person }) =>
          person.kind === "local-person" || context.personKey?.(person) === "host-owner"
            ? "Host owner"
            : person.kind === "service" && person.ref === "unverified-personal-history"
              ? "unverified person"
              : `person ${contentDigest(personalReaderKey(person)).slice(7, 23)}`
        )
      ),
    ].sort()
    const placeholder = `[Withheld: personal content of ${labels.join(", ")}]`
    // Whitelist transport identity only. Tool names, snippets, attachments and
    // arbitrary producer metadata cannot survive the withheld projection.
    const result: Record<string, unknown> = {}
    const original = message as unknown as Record<string, unknown>
    for (const key of [
      "id",
      "role",
      "createdAt",
      "sessionId",
      "timestamp",
      "runId",
      "type",
      "turnKey",
      "projectId",
      "senderId",
      "senderKind",
    ])
      if (key in original) result[key] = original[key]
    if ("parts" in original) result.parts = [{ type: "text", text: placeholder }]
    if ("content" in original)
      result.content = Array.isArray(original.content)
        ? [{ type: "text", text: placeholder }]
        : placeholder
    if ("text" in original) result.text = placeholder
    if ("body" in original) result.body = placeholder
    const metadata: Record<string, unknown> = {
      personalMarkVersion: 1,
      personalMarks: marks.map((mark) => ({
        person: mark.person,
        source: "withheld",
        markedAt: mark.markedAt,
      })),
    }
    const previous = message.metadata as Record<string, unknown> | undefined
    // Keep only structural branch identity, so a hidden sibling cannot enter
    // engine history merely because its body was replaced by a placeholder.
    for (const key of ["branchGroupId", "branchOwnerId", "branchIndex", "deletedAt"])
      if (previous && key in previous) metadata[key] = previous[key]
    result.metadata = metadata
    return result as unknown as T
  })
  return {
    messages: filtered,
    withheldMessageIds,
    visibilityDigest: personalVisibilityDigest(readers, withheldMessageIds, context),
  }
}
