import type { ChatSession } from "@cognia/agent-config-types"
/** Host write boundary: resolve live ancestry, prove the audience, then receipt. */
import {
  mergePersonalMarks,
  type PersonalMarkV1,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import {
  decidePersonalSink,
  type PersonalSinkReceipt,
  type SinkAudienceV1,
  type PersonalSinkContext,
} from "@cognia/plugin-contract/types/execution/personal-sink"
import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { stableJson } from "@/lib/account-sync/data/stable-json"
import { sha256Blob, sha256Bytes, sha256String } from "@/lib/utils/hash"
import type { HostPersonContext } from "./personal-visibility"
import {
  copyPersonalDisclosureCapability,
  hasPersonalDisclosureCapability,
  matchingPersonalDisclosure,
} from "./personal-disclosure"

export type { SinkAudienceV1 } from "@cognia/plugin-contract/types/execution/personal-sink"

export type { PersonalSinkContext } from "@cognia/plugin-contract/types/execution/personal-sink"

export function unverifiedPersonalSinkContext(reason: string): PersonalSinkContext {
  return { unverifiedReason: reason }
}

/** Host-held session provenance; this does not choose or taint a consuming run. */
export function sessionPersonalSinkContext(sessionId: string): PersonalSinkContext {
  return { sessionId, sessionDerived: true }
}

/** Preserve both live producers when a notification retains fields from each. */
export function mergePersonalSinkContexts(
  left: PersonalSinkContext | undefined,
  right: PersonalSinkContext
): PersonalSinkContext {
  left ??= unverifiedPersonalSinkContext("persisted notification predates Host provenance")
  const sources = new Map<string, PersonalSinkContext>()
  for (const source of [
    ...(left.personalSources ?? [left]),
    ...(right.personalSources ?? [right]),
  ]) {
    const { receiptAttemptId: _attempt, ...provenance } = source
    sources.set(stableJson(provenance), provenance as PersonalSinkContext)
  }
  const personalSources = [...sources.values()]
  return personalSources.length === 1
    ? { ...personalSources[0], receiptAttemptId: right.receiptAttemptId }
    : { personalSources, receiptAttemptId: right.receiptAttemptId }
}

export function withPersonalSinkAttempt(context: PersonalSinkContext): PersonalSinkContext {
  return copyPersonalDisclosureCapability(context, {
    ...context,
    receiptAttemptId: crypto.randomUUID(),
  })
}

/** Only Host-held state may supply this binding; absence stays an explicit denial. */
export function personalSinkContextForRun(
  context: {
    sessionId?: string
    executionRunId?: string
    hostOrigin?: PersonalSinkContext["hostOrigin"]
    unverifiedReason?: string
    receiptAttemptId?: string
    sessionDerived?: true
    personalSources?: readonly PersonalSinkContext[]
  },
  reason: string
): PersonalSinkContext {
  if (context.personalSources)
    return { personalSources: context.personalSources, receiptAttemptId: context.receiptAttemptId }
  if (context.sessionDerived && context.sessionId)
    return {
      ...sessionPersonalSinkContext(context.sessionId),
      receiptAttemptId: context.receiptAttemptId,
    }
  if (context.executionRunId)
    return {
      sessionId: context.sessionId,
      executionRunId: context.executionRunId,
      receiptAttemptId: context.receiptAttemptId,
    }
  if (context.hostOrigin) return explicitHostPersonalSinkContext(context.hostOrigin)
  return unverifiedPersonalSinkContext(context.unverifiedReason ?? reason)
}

/** Caller explicitly establishes that the payload contains no run output. */
export function explicitHostPersonalSinkContext(
  kind: NonNullable<PersonalSinkContext["hostOrigin"]>
): PersonalSinkContext {
  return { hostOrigin: kind }
}

export type RunPersonalTaint =
  | { verified: true; marks: PersonalMarkV1[] }
  | { verified: false; marks: PersonalMarkV1[]; reason: string }

// Cache consumers retain exactly the ancestry the canonical read verified.
// This is Host metadata, not another taint derivation or serialized authority.
const taintDependencies = new WeakMap<RunPersonalTaint, ReadonlySet<string>>()
export function personalTaintDependencies(
  taint: RunPersonalTaint
): ReadonlySet<string> | undefined {
  return taintDependencies.get(taint)
}

/** Read each live Host source, retaining known marks even if another source fails. */
export async function readRunPersonalTaint(
  context: PersonalSinkContext
): Promise<RunPersonalTaint> {
  const seen = new Set<PersonalSinkContext>()
  const read = async (source: PersonalSinkContext, depth: number): Promise<RunPersonalTaint> => {
    if (depth >= 32 || seen.has(source))
      return { verified: false, marks: [], reason: "Personal sink source cycle" }
    if (source.personalSources) {
      seen.add(source)
      const results: RunPersonalTaint[] = []
      for (const child of source.personalSources) results.push(await read(child, depth + 1))
      seen.delete(source)
      const marks = mergePersonalMarks(...results.map((result) => result.marks))
      const failed = results.find((result) => !result.verified)
      const combined: RunPersonalTaint =
        failed && !failed.verified
          ? { verified: false, marks, reason: failed.reason }
          : { verified: true, marks }
      taintDependencies.set(
        combined,
        new Set(results.flatMap((result) => [...(personalTaintDependencies(result) ?? [])]))
      )
      return combined
    }
    if (source.sessionDerived && source.sessionId) return readSessionPersonalTaint(source.sessionId)
    return readExecutionRunPersonalTaint(source)
  }
  return read(context, 0)
}

/** Explicit session marks only: legacy read-time attribution does not taint (D1). */
export async function readSessionPersonalTaint(sessionId: string): Promise<RunPersonalTaint> {
  const marks: PersonalMarkV1[] = []
  try {
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    let sourceId: string | undefined = sessionId
    const sourceIds = new Set<string>()
    let failure: string | undefined
    while (sourceId) {
      if (sourceIds.has(sourceId) || sourceIds.size >= 32)
        throw new Error("Personal sink source-session cycle or depth limit")
      sourceIds.add(sourceId)
      const session: ChatSession | undefined = await db.sessions.get(sourceId)
      if (!session) throw new Error("Personal sink source session unavailable")
      const messages = await db.messages.where("sessionId").equals(sourceId).toArray()
      for (const message of messages)
        marks.push(
          ...((message.metadata as { personalMarks?: PersonalMarkV1[] } | undefined)
            ?.personalMarks ?? [])
        )
      const runs = await db.executionRuns.where("sessionId").equals(sourceId).toArray()
      for (const run of runs) {
        const taint = await readExecutionRunPersonalTaint({ executionRunId: run.id }, true)
        marks.push(...taint.marks)
        if (!taint.verified) failure ??= taint.reason
      }
      // Branch/attached seeds retain their canonical parent, as in 2B derived context.
      sourceId =
        session.attachedChild?.parentSessionId ??
        (session.branchSeed
          ? session.surfaceBinding?.kind === "session"
            ? session.surfaceBinding.sessionId
            : session.parentSessionId
          : undefined)
    }
    if (!sourceIds.size) throw new Error("Personal sink source session unavailable")
    if (getDb() !== db) throw new Error("Personal sink database changed")
    return failure
      ? { verified: false, marks: mergePersonalMarks(marks), reason: failure }
      : { verified: true, marks: mergePersonalMarks(marks) }
  } catch (error) {
    return {
      verified: false,
      marks: mergePersonalMarks(marks),
      reason: error instanceof Error ? error.message : "Personal sink session unavailable",
    }
  }
}

async function readExecutionRunPersonalTaint(
  context: PersonalSinkContext,
  sessionAggregate = false
): Promise<RunPersonalTaint> {
  const marks: PersonalMarkV1[] = []
  try {
    if (context.unverifiedReason) throw new Error(context.unverifiedReason)
    if (context.executionRunId === undefined && context.hostOrigin)
      return { verified: true, marks: [] }
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    const run =
      context.executionRunId !== undefined
        ? await db.executionRuns.get(context.executionRunId)
        : undefined
    if (!run || (context.sessionId !== undefined && run.sessionId !== context.sessionId))
      throw new Error("Personal sink execution unavailable")
    marks.push(...(run.personalMarks ?? []))
    if (!sessionAggregate && !run.actingIdentity)
      throw new Error("Personal sink execution identity unavailable")
    let rootId = run.actingIdentity?.rootRunId
    const visited = new Set<string>()
    let current: ExecutionRun | undefined = run
    while (current) {
      if (visited.has(current.id) || visited.size >= 32)
        throw new Error("Personal sink ancestry cycle or depth limit")
      visited.add(current.id)
      marks.push(...(current.personalMarks ?? []))
      if (
        (!sessionAggregate && !current.actingIdentity) ||
        (current.actingIdentity?.rootRunId && current.actingIdentity.rootRunId !== rootId)
      )
        throw new Error("Personal sink identity root changed")
      const reachedIdentityRoot = current.id === rootId || (!rootId && !current.parentRunId)
      if (reachedIdentityRoot && !current.parentRunId) {
        if (getDb() !== db) throw new Error("Personal sink database changed")
        const result: RunPersonalTaint = { verified: true, marks: mergePersonalMarks(marks) }
        taintDependencies.set(result, visited)
        return result
      }
      const nextId: string | undefined = current.parentRunId ?? rootId
      if (!nextId) break
      const next: ExecutionRun | undefined = await db.executionRuns.get(nextId)
      // A confirmation may create a new credential/reader identity root, but
      // the approved content still has its old structural source ancestry.
      // Keep reading it live so a later source mark cannot be laundered.
      if (reachedIdentityRoot && current.parentRunId) rootId = next?.actingIdentity?.rootRunId
      current = next
    }
    throw new Error("Personal sink ancestor unavailable")
  } catch (error) {
    return {
      verified: false,
      marks: mergePersonalMarks(marks),
      reason: error instanceof Error ? error.message : "Personal sink ancestry unavailable",
    }
  }
}

/** The same verified connected-owner equivalence used for history readers. */
export async function readHostPersonContext(): Promise<HostPersonContext> {
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  const owners: PrincipalRefV1[] = []
  for (const adapter of await db.adapterInstances.toArray()) {
    const lark = adapter.settings.connectedUser as
      { openId?: unknown; unionId?: unknown } | undefined
    const slack = adapter.settings.connectedTeam as { authedUserId?: unknown } | undefined
    if (adapter.type === "lark" && typeof lark?.openId === "string" && lark.openId)
      owners.push({
        kind: "platform",
        platform: "lark",
        adapterId: adapter.id,
        remoteUserId: lark.openId,
        ...(typeof lark.unionId === "string" ? { unionId: lark.unionId } : {}),
      })
    if (adapter.type === "slack" && typeof slack?.authedUserId === "string" && slack.authedUserId)
      owners.push({
        kind: "platform",
        platform: "slack",
        adapterId: adapter.id,
        remoteUserId: slack.authedUserId,
      })
  }
  if (getDb() !== db) throw new Error("Personal sink database changed")
  return { connectedOwners: owners }
}

export function personalSinkWithholdMessage(persons: readonly PrincipalRefV1[]): string {
  const labels = persons.map((person) =>
    person.kind === "local-person"
      ? "the Host owner"
      : person.kind === "platform"
        ? person.platform === "lark"
          ? "a connected Lark person"
          : "another person"
        : "another person"
  )
  return `Withheld: this contains personal content of ${labels.length ? labels.join(", ") : "an unverified person"}. Only that person can disclose it to this audience. An operator or tool approval cannot authorize disclosure.`
}

export class PersonalSinkWithheldError extends Error {
  readonly code = "personal_sink_withheld"
  constructor(
    readonly persons: PrincipalRefV1[],
    readonly reason: string
  ) {
    super(personalSinkWithholdMessage(persons))
    this.name = "PersonalSinkWithheldError"
  }
}

export function isPersonalSinkWithheldError(error: unknown): error is PersonalSinkWithheldError {
  return error instanceof PersonalSinkWithheldError
}

async function payloadHash(payload: unknown): Promise<string | undefined> {
  if (payload === undefined) return undefined
  if (typeof payload === "string") return sha256String(payload)
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) return sha256Bytes(payload)
  if (typeof Blob !== "undefined" && payload instanceof Blob) return sha256Blob(payload)
  try {
    return await sha256String(stableJson(payload))
  } catch {
    // Opaque or unrepresentable content is withheld and never disclosable.
    return undefined
  }
}

/** Receipt persistence is part of confidentiality enforcement, never best-effort. */
export async function recordPersonalSinkReceipt(
  context: PersonalSinkContext,
  persons: readonly PrincipalRefV1[],
  outcome: PersonalSinkReceipt["outcome"] | "withhold",
  payload: unknown,
  originalTarget: unknown
): Promise<string> {
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  const [{ outboundReceipt }, { recordActionReviewReceipt, ACTION_REVIEW_RETENTION_DAYS }] =
    await Promise.all([
      import("@/lib/policy/action-review/outbound-receipt"),
      import("@/lib/db/action-review-receipts"),
    ])
  const contentHash = await payloadHash(payload)
  const receiptOutcome = outcome === "narrow" && contentHash ? "narrow" : "withheld"
  const receiptId = context.receiptAttemptId
    ? `personal-sink:${await sha256String(stableJson({ attempt: context.receiptAttemptId, persons, outcome: receiptOutcome, contentHash, originalTarget }))}`
    : `personal-sink:${crypto.randomUUID()}`
  if (await db.actionReviewReceipts.get(receiptId)) {
    if (outcome === "narrow" && !contentHash)
      throw new PersonalSinkWithheldError([...persons], "payload-not-disclosable")
    return receiptId
  }
  const now = Date.now()
  const receipt = outboundReceipt({
    requestId: receiptId,
    origin: {
      channel: "generic",
      scope: "personal-sink",
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    },
    subject: { kind: "tool-call", ref: "personal-sink" },
    plan: "deny",
    enforced: true,
    outcome: "deny",
    authority: "policy-deny",
    reason: personalSinkWithholdMessage(persons),
    now,
  })
  if (context.executionRunId) receipt.request.origin.runId = context.executionRunId
  if (getDb() !== db) throw new Error("Personal sink database changed")
  await recordActionReviewReceipt({
    contractVersion: receipt.request.contractVersion,
    id: receipt.request.requestId,
    ...receipt,
    personal: {
      persons: [...persons],
      outcome: receiptOutcome,
      ...(contentHash ? { contentHash } : {}),
      originalTarget: structuredClone(originalTarget),
    },
    expiresAt: now + ACTION_REVIEW_RETENTION_DAYS * 86_400_000,
  })
  if (getDb() !== db) throw new Error("Personal sink database changed")
  if (outcome === "narrow" && !contentHash)
    throw new PersonalSinkWithheldError([...persons], "payload-not-disclosable")
  return receiptId
}

export type HostPersonalSinkDecision =
  | { outcome: "allow" }
  | { outcome: "narrow"; person: PrincipalRefV1; persons: PrincipalRefV1[] }
  | { outcome: "withhold"; persons: PrincipalRefV1[]; reason: string }

/** Only the Host's recorded exact-send disclosure can override a personal withhold. */
export async function checkPersonalSink(
  context: PersonalSinkContext,
  audience: SinkAudienceV1,
  payload: unknown,
  originalTarget: unknown,
  options: { canNarrow?: boolean; taint?: RunPersonalTaint } = {}
): Promise<HostPersonalSinkDecision> {
  const taint = options.taint ?? (await readRunPersonalTaint(context))
  if (hasPersonalDisclosureCapability(context)) {
    if (
      taint.verified &&
      (await matchingPersonalDisclosure(context, payload, originalTarget, taint.marks))
    )
      return { outcome: "allow" }
    const persons = taint.marks.map(({ person }) => person)
    await recordPersonalSinkReceipt(context, persons, "withhold", payload, originalTarget)
    return { outcome: "withhold", persons, reason: "disclosure-mismatch" }
  }
  let decision: HostPersonalSinkDecision
  if (!taint.verified && audience.kind === "host-local") {
    const host = await readHostPersonContext()
    const { samePersonForHost } = await import("./personal-visibility")
    if (taint.marks.every((mark) => samePersonForHost(mark.person, { kind: "local-person" }, host)))
      return { outcome: "allow" }
  }
  if (!taint.verified) {
    decision = {
      outcome: "withhold",
      persons: taint.marks.map(({ person }) => person),
      reason: taint.reason,
    }
  } else {
    if (!taint.marks.length) return { outcome: "allow" }
    const host = await readHostPersonContext()
    const { samePersonForHost } = await import("./personal-visibility")
    const pure = decidePersonalSink(taint.marks, audience, (left, right) =>
      samePersonForHost(left, right, host)
    )
    if (pure.outcome === "allow") return pure
    if (pure.outcome === "narrow" && !(await payloadHash(payload))) {
      decision = {
        outcome: "withhold",
        persons: taint.marks.map(({ person }) => person),
        reason: "payload-not-disclosable",
      }
      await recordPersonalSinkReceipt(
        context,
        decision.persons,
        decision.outcome,
        undefined,
        originalTarget
      )
      return decision
    }
    decision =
      pure.outcome === "narrow"
        ? options.canNarrow && payload !== undefined
          ? { ...pure, persons: [pure.person] }
          : { outcome: "withhold", persons: [pure.person], reason: "sink-cannot-narrow" }
        : pure
  }
  await recordPersonalSinkReceipt(
    context,
    decision.persons,
    decision.outcome === "narrow" ? "withheld" : decision.outcome,
    payload,
    originalTarget
  )
  return decision
}

export async function assertPersonalSink(
  context: PersonalSinkContext,
  audience: SinkAudienceV1,
  payload: unknown,
  originalTarget: unknown
): Promise<void> {
  try {
    const decision = await checkPersonalSink(context, audience, payload, originalTarget)
    if (decision.outcome !== "allow")
      throw new PersonalSinkWithheldError(
        decision.persons,
        decision.outcome === "withhold" ? decision.reason : "sink-cannot-narrow"
      )
  } catch (error) {
    if (isPersonalSinkWithheldError(error)) throw error
    throw new PersonalSinkWithheldError(
      [],
      error instanceof Error ? error.message : "Personal sink unavailable"
    )
  }
}
