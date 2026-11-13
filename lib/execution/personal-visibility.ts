/** Host identity resolution for the shared, portable history filter. */
import type { ChatSession } from "@cognia/agent-config-types"
import type {
  PersonalMarkV1,
  PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { mergePersonalMarks } from "@cognia/plugin-contract/types/execution/acting-identity"
import {
  effectivePersonalMarks,
  personalReaderKey,
  personalReaders,
  personalVisibilityDigest,
  withholdForReaders,
  type PersonalHistoryMessage,
  type PersonalVisibilityContext,
  type PersonalHistoryDisclosure,
} from "@cognia/plugin-contract/types/execution/personal-visibility"
import { getDb } from "@/lib/db/schema"
import { resolveRunActingIdentity } from "./acting-authority"
import {
  addPersonalMarksToRun,
  personalMarkContextForSession,
  personalMessageAttributedMarks,
} from "./personal-marks"
import type { RerankerOptions } from "@/lib/twin/runtime/reranker"
import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { personalDisclosureMessageHash } from "./personal-disclosure"
import { stableJson } from "@/lib/account-sync/data/stable-json"

export {
  personalReaders,
  withholdForReaders,
} from "@cognia/plugin-contract/types/execution/personal-visibility"

export interface HostPersonContext {
  /** Published only after the adapter verified its connected owner on this Host. */
  connectedOwners: readonly PrincipalRefV1[]
}

function samePlatformPerson(left: PrincipalRefV1, right: PrincipalRefV1): boolean {
  return (
    left.kind === "platform" &&
    right.kind === "platform" &&
    left.platform === right.platform &&
    ((left.adapterId === right.adapterId && left.remoteUserId === right.remoteUserId) ||
      (!!left.unionId && !!right.unionId && left.unionId === right.unionId))
  )
}

/** One Host equivalence: its local person and its verified connected owners. */
export function samePersonForHost(
  left: PrincipalRefV1,
  right: PrincipalRefV1,
  context: HostPersonContext
): boolean {
  const isOwner = (person: PrincipalRefV1) =>
    person.kind === "local-person" ||
    context.connectedOwners.some((owner) => samePlatformPerson(person, owner))
  if (isOwner(left) && isOwner(right)) return true
  return samePlatformPerson(left, right)
}

/** Recheck before model-backed scoring, after retrieval and any preceding awaits. */
export function withPersonalRerankerVisibility<
  T extends Pick<RerankerOptions, "scorer" | "batchScorer">,
>(
  reranker: T | undefined,
  consumer: { sessionId?: string; executionRunId?: string }
): T | undefined {
  if (!reranker) return reranker
  const readable = async () => {
    const result = await preparePersonalHistory(
      consumer.sessionId,
      [
        {
          id: "personal-reranker",
          metadata: {
            personalMarks: [
              { person: { kind: "local-person" }, source: "twin-history", markedAt: 0 },
            ],
          },
        },
      ],
      consumer
    )
    return result.withheldMessageIds.length === 0
  }
  return {
    ...reranker,
    ...(reranker.scorer
      ? {
          scorer: async (...args: Parameters<NonNullable<RerankerOptions["scorer"]>>) =>
            (await readable()) ? reranker.scorer!(...args) : 0,
        }
      : {}),
    ...(reranker.batchScorer
      ? {
          batchScorer: async (...args: Parameters<NonNullable<RerankerOptions["batchScorer"]>>) =>
            (await readable()) ? reranker.batchScorer!(...args) : args[1].map(() => 0),
        }
      : {}),
  }
}

/** Session id is the consuming run; stored message session ids retain source attribution. */
export async function preparePersonalHistory<T extends PersonalHistoryMessage>(
  sessionId: string | undefined,
  messages: readonly T[],
  options: { executionRunId?: string; session?: Pick<ChatSession, "platformBinding"> } = {}
): Promise<{
  messages: T[]
  visibilityDigest: string
  withheldMessageIds: string[]
  readers: PrincipalRefV1[]
}> {
  return prepareHistoryForReaders(sessionId, messages, options)
}

/** Explicit owner-only UI/job read; never use this to establish a run's audience. */
export function prepareOwnerHistory<T extends PersonalHistoryMessage>(
  messages: readonly T[],
  options: { session?: Pick<ChatSession, "platformBinding"> } = {}
): ReturnType<typeof preparePersonalHistory<T>> {
  return prepareHistoryForReaders(undefined, messages, options, [{ kind: "local-person" }])
}

/** Plugins are code, never a personal reader, including in an owner's invocation. */
export function preparePluginHistory<T extends PersonalHistoryMessage>(
  sessionId: string | undefined,
  messages: readonly T[]
): ReturnType<typeof preparePersonalHistory<T>> {
  return prepareHistoryForReaders(sessionId, messages, {}, [])
}

/** Host-set paired audience. Unknown or absent roles never grant a personal reader. */
export function preparePairedHistory<T extends PersonalHistoryMessage>(
  messages: readonly T[],
  reader?: unknown
): ReturnType<typeof preparePersonalHistory<T>> {
  return reader === "owner"
    ? prepareOwnerHistory(messages)
    : preparePluginHistory(undefined, messages)
}

async function prepareHistoryForReaders<T extends PersonalHistoryMessage>(
  sessionId: string | undefined,
  messages: readonly T[],
  options: { executionRunId?: string; session?: Pick<ChatSession, "platformBinding"> },
  ownerReaders?: PrincipalRefV1[],
  contextMarks?: ReadonlyMap<string, readonly PersonalMarkV1[]>
): ReturnType<typeof preparePersonalHistory<T>> {
  const db = getDb()
  const assertCurrent = () => {
    if (getDb() !== db) throw new Error("Personal history database changed")
  }
  const adapters = await db.adapterInstances.toArray()
  const connectedOwners: PrincipalRefV1[] = []
  for (const adapter of adapters) {
    const connected = adapter.settings.connectedUser as
      { openId?: unknown; unionId?: unknown } | undefined
    const slack = adapter.settings.connectedTeam as { authedUserId?: unknown } | undefined
    if (adapter.type === "lark" && typeof connected?.openId === "string" && connected.openId)
      connectedOwners.push({
        kind: "platform",
        platform: "lark",
        adapterId: adapter.id,
        remoteUserId: connected.openId,
        ...(typeof connected.unionId === "string" ? { unionId: connected.unionId } : {}),
      })
    if (adapter.type === "slack" && typeof slack?.authedUserId === "string" && slack.authedUserId)
      connectedOwners.push({
        kind: "platform",
        platform: "slack",
        adapterId: adapter.id,
        remoteUserId: slack.authedUserId,
      })
  }
  const host: HostPersonContext = { connectedOwners }
  const consumerSession =
    options.session ?? (sessionId ? await db.sessions.get(sessionId) : undefined)
  const contexts = new Map<
    string | undefined,
    Awaited<ReturnType<typeof personalMarkContextForSession>>
  >()
  const sessions = new Map<string | undefined, Pick<ChatSession, "platformBinding"> | undefined>([
    [sessionId, consumerSession],
  ])
  const canonical: T[] = []
  const disclosures: PersonalHistoryDisclosure[] = []
  // A shared fact applies only to a turn in the original connector session.
  // Owner/plugin/derived projections do not receive this Host authority.
  const conversationKey = consumerSession?.platformBinding?.conversationKey
  const explicitById = new Map<string, PersonalMarkV1[]>()
  for (const message of messages) {
    const metadata = message.metadata as Record<string, unknown> | undefined
    if (!ownerReaders && options.executionRunId && sessionId && conversationKey && !contextMarks) {
      const stored = await db.messages.get(message.id)
      const entries = stored?.metadata?.personalDisclosures
      if (
        stored?.sessionId === sessionId &&
        Array.isArray(entries) &&
        (await personalDisclosureMessageHash(stored)) ===
          (await personalDisclosureMessageHash(message))
      ) {
        for (const entry of entries as (PersonalHistoryDisclosure & { messageHash: string })[]) {
          const receipt = await db.actionReviewReceipts.get(entry.receiptId)
          const pending = receipt?.personalDisclosurePending,
            grant = receipt?.personal?.disclosure
          const job = grant?.jobId ? await db.outboundQueue.get(grant.jobId) : undefined
          if (
            pending &&
            grant &&
            job?.status === "sent" &&
            entry.sessionId === sessionId &&
            entry.messageId === message.id &&
            entry.target.conversationKey === conversationKey &&
            entry.messageHash === (await personalDisclosureMessageHash(stored)) &&
            pending.messageId === message.id &&
            pending.sessionId === sessionId &&
            stableJson(entry.target) === stableJson(grant.target) &&
            stableJson(entry.persons) === stableJson(pending.persons) &&
            entry.contentHash === grant.contentHash
          )
            disclosures.push(entry)
        }
      }
    }
    const sourceSessionId =
      typeof (message as T & { sessionId?: unknown }).sessionId === "string"
        ? (message as T & { sessionId: string }).sessionId
        : typeof metadata?.sessionId === "string"
          ? metadata.sessionId
          : sessionId
    if (!sessions.has(sourceSessionId))
      sessions.set(
        sourceSessionId,
        sourceSessionId ? await db.sessions.get(sourceSessionId) : undefined
      )
    const sourceSession = sessions.get(sourceSessionId)
    if (!contexts.has(sourceSessionId))
      contexts.set(sourceSessionId, await personalMarkContextForSession(db, sourceSession))
    const attributed = await personalMessageAttributedMarks(message.id)
    const marks = mergePersonalMarks(
      effectivePersonalMarks(message, sourceSession ?? {}, contexts.get(sourceSessionId)!),
      attributed
    )
    if (attributed.length) explicitById.set(message.id, attributed)
    // A copy returned by an earlier preparation carries the legacy read-time
    // attribution materialized in metadata.personalMarks. It is still legacy,
    // so it never taints a consuming run (phase 2C-1 D1).
    const inferred = effectivePersonalMarks(
      { ...message, metadata: { ...metadata, personalMarks: undefined } },
      sourceSession ?? {},
      contexts.get(sourceSessionId)!
    )
    const stored = metadata?.personalMarks as PersonalMarkV1[] | undefined
    if (
      stored?.length &&
      JSON.stringify(mergePersonalMarks(stored)) !== JSON.stringify(mergePersonalMarks(inferred))
    )
      explicitById.set(message.id, mergePersonalMarks(stored, attributed))
    canonical.push(
      marks.length ? { ...message, metadata: { ...metadata, personalMarks: marks } } : message
    )
  }
  assertCurrent()
  // Reader resolution is phase 2B's and unchanged here; only the mark commit
  // below needs the exact consuming run.
  const readers =
    ownerReaders ??
    personalReaders(await resolveRunActingIdentity(sessionId, options.executionRunId))
  assertCurrent()
  const visibility: PersonalVisibilityContext = {
    sessionId,
    conversationKey,
    disclosures,
    samePerson: (left, right) => samePersonForHost(left, right, host),
    personKey: (person) =>
      samePersonForHost(person, { kind: "local-person" }, host)
        ? "host-owner"
        : person.kind === "platform" && person.unionId
          ? JSON.stringify([person.platform, "union", person.unionId])
          : personalReaderKey(person),
  }
  let result = withholdForReaders(canonical, readers, {}, visibility)
  if (!ownerReaders) {
    const withheld = new Set(result.withheldMessageIds)
    // Only producer-explicit marks taint runs. Legacy read-time attribution
    // still controls visibility, but is not a new personal read in phase 2C.
    const explicitMarks = (message: T) =>
      contextMarks?.get(message.id) ?? explicitById.get(message.id) ?? []
    const consumed = messages.filter(
      (message) => !withheld.has(message.id) && explicitMarks(message).length > 0
    )
    if (consumed.length && options.executionRunId) {
      // The commit is awaited before releasing any context. A failed transaction
      // rejects this preparation, just as a failed memory-recall mark does.
      await addPersonalMarksToRun(
        { sessionId, executionRunId: options.executionRunId },
        mergePersonalMarks(...consumed.map(explicitMarks))
      )
      assertCurrent()
    } else if (consumed.length) {
      // No exact Host-held consuming run: never pick an ambient active run to
      // carry the taint. Withhold the explicitly marked context instead.
      const ids = new Set(consumed.map(({ id }) => id))
      const forced = withholdForReaders(canonical, [], {}, visibility)
      const placeholders = new Map(
        forced.messages.filter(({ id }) => ids.has(id)).map((message) => [message.id, message])
      )
      const messagesOut = result.messages.map((message) => placeholders.get(message.id) ?? message)
      const withheldMessageIds = [...result.withheldMessageIds, ...ids]
      result = {
        messages: messagesOut,
        withheldMessageIds,
        visibilityDigest: personalVisibilityDigest(readers, withheldMessageIds, visibility),
      }
    }
  }
  return { ...result, readers }
}

/** Derived text keeps its Host source's taint; missing provenance never grants access. */
export async function preparePersonalDerivedHistory<T extends PersonalHistoryMessage>(
  sessionId: string | undefined,
  messages: readonly T[],
  source: {
    runIds?: readonly string[]
    sessionId?: string
    executionRunId?: string
    /** Host-owned legacy title/seed/skill; known source marks still take precedence. */
    legacyOwnerArtifact?: true
  } = {}
): ReturnType<typeof preparePersonalHistory<T>> {
  return prepareDerivedHistory(sessionId, messages, source)
}

/** Owner-local derived UI/job output. Later run consumers must re-derive its source taint. */
export function prepareOwnerDerivedHistory<T extends PersonalHistoryMessage>(
  messages: readonly T[],
  source: { runIds?: readonly string[]; sessionId?: string } = {}
): ReturnType<typeof preparePersonalHistory<T>> {
  return prepareDerivedHistory(undefined, messages, { ...source, legacyOwnerArtifact: true }, true)
}

async function prepareDerivedHistory<T extends PersonalHistoryMessage>(
  sessionId: string | undefined,
  messages: readonly T[],
  source: {
    runIds?: readonly string[]
    sessionId?: string
    executionRunId?: string
    legacyOwnerArtifact?: true
  },
  ownerRead = false
): ReturnType<typeof preparePersonalHistory<T>> {
  const db = getDb()
  const marksFromRuns: PersonalMarkV1[] = []
  let proven = !!source.runIds?.length
  for (const sourceId of source.runIds ?? []) {
    let id: string | undefined = sourceId
    const visited = new Set<string>()
    while (id) {
      if (visited.has(id) || visited.size >= 32) throw new Error("Personal history ancestry cycle")
      visited.add(id)
      const run: ExecutionRun | undefined = await db.executionRuns.get(id)
      if (!run) {
        proven = false
        break
      }
      if (!run.actingIdentity) proven = false
      marksFromRuns.push(...(run.personalMarks ?? []))
      // A confirmed action has a new identity root, but still consumes its
      // structural source. Later marks on that source must remain visible.
      id =
        run.parentRunId ??
        (run.actingIdentity?.rootRunId !== id ? run.actingIdentity?.rootRunId : undefined)
    }
  }
  const sourceSessions: (ChatSession | undefined)[] = []
  const sourceSessionIds = new Set<string>()
  let sourceSessionId = source.sessionId
  while (sourceSessionId) {
    if (sourceSessionIds.has(sourceSessionId) || sourceSessionIds.size >= 32)
      throw new Error("Personal history source-session ancestry cycle")
    sourceSessionIds.add(sourceSessionId)
    const session = await db.sessions.get(sourceSessionId)
    sourceSessions.push(session)
    // Staged attached/branch seeds retain their canonical parent as provenance.
    // A later run must re-derive it rather than trust the owner's earlier UI read.
    sourceSessionId =
      session?.attachedChild?.parentSessionId ??
      (session?.branchSeed
        ? session.surfaceBinding?.kind === "session"
          ? session.surfaceBinding.sessionId
          : session.parentSessionId
        : undefined)
  }
  // Message deletion does not erase a title, seed or working set. Preserve the
  // source session's durable run taint even after its marked rows are gone.
  const retainedMarks: PersonalMarkV1[][] = []
  const explicitSourceMarks: PersonalMarkV1[][] = [marksFromRuns]
  const legacy: PersonalMarkV1[][] = []
  for (const [index, id] of [...sourceSessionIds].entries()) {
    const session = sourceSessions[index]
    const stored = await db.messages.where("sessionId").equals(id).toArray()
    const sourceRuns = await db.executionRuns.where("sessionId").equals(id).toArray()
    const context = await personalMarkContextForSession(db, session)
    legacy.push(effectivePersonalMarks({}, session ?? {}, context))
    retainedMarks.push(
      ...sourceRuns.map((run) => run.personalMarks ?? []),
      ...stored.map((message) => effectivePersonalMarks(message, session ?? {}, context))
    )
    explicitSourceMarks.push(
      ...sourceRuns.map((run) => run.personalMarks ?? []),
      ...stored.map(
        (message) =>
          (message.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)?.personalMarks ??
          []
      )
    )
  }
  const legacyMarks = mergePersonalMarks(...legacy)
  const marks = mergePersonalMarks(
    marksFromRuns,
    ...retainedMarks,
    // Remaining public rows cannot prove that an older derived artifact never
    // included a deleted personal row. A legacy bound person is attributable;
    // otherwise an unverified sentinel cannot equal any personal reader.
    !proven
      ? legacyMarks.length
        ? legacyMarks
        : source.legacyOwnerArtifact
          ? [{ person: { kind: "local-person" }, source: "legacy-owner-artifact", markedAt: 0 }]
          : [
              {
                person: { kind: "service", ref: "unverified-personal-history" },
                source: "unverified-derived-history",
                markedAt: 0,
              },
            ]
      : []
  )
  if (getDb() !== db) throw new Error("Personal history database changed")
  const marked = messages.map((message) => ({
    ...message,
    metadata: {
      ...(message.metadata as Record<string, unknown> | undefined),
      personalMarkVersion: 1,
      personalMarks: mergePersonalMarks(
        (message.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)?.personalMarks,
        marks
      ),
    },
  }))
  if (ownerRead) return prepareOwnerHistory(marked)
  const knownMarks = mergePersonalMarks(...explicitSourceMarks)
  return prepareHistoryForReaders(
    sessionId,
    marked,
    { executionRunId: source.executionRunId },
    undefined,
    new Map(
      messages.map((message) => [
        message.id,
        mergePersonalMarks(
          (message.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)?.personalMarks,
          knownMarks
        ),
      ])
    )
  )
}

/** Paired derived fields use the same Host-set audience as transcript rows. */
export async function projectPersonalSessionHistory(
  session: ChatSession,
  reader?: unknown
): Promise<ChatSession> {
  const db = getDb()
  const attributed = await prepareOwnerDerivedHistory([{ id: session.id, text: session.title }], {
    sessionId: session.id,
  })
  const result = await preparePairedHistory(attributed.messages, reader)
  if (getDb() !== db) throw new Error("Personal history database changed")
  if (result.withheldMessageIds.length === 0) return session
  return {
    ...session,
    title: result.messages[0].text,
    lastMessagePreview: result.messages[0].text,
    branchSeed: undefined,
    scratchpad: undefined,
    workingSet: undefined,
    spawnedTask: undefined,
    importCanonicalState: undefined,
    importLifecycle: undefined,
    importRuntimeBinding: undefined,
    sdkSessionId: undefined,
    forkedFromSdkSessionId: undefined,
    externalAgentSession: undefined,
    externalAgentGatewaySessions: undefined,
  }
}
