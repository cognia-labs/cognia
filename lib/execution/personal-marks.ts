/** Host-owned run taint and message provenance, separate from credential authority. */
import Dexie from "dexie"
import type { UIMessage } from "ai"
import {
  mergePersonalMarks,
  preservePersonalMarkMetadata,
  type ActingIdentityV1,
  type PersonalMarkV1,
  type PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { getDb } from "@/lib/db/schema"
import { resolveExecutingRun } from "./acting-authority"
import type { PersonalCredentialContext, PersonalCredentialSource } from "./personal-credential"

/** Admission cannot release the credential until the whole ancestry commits. */
export async function markPersonalCredential(
  context: PersonalCredentialContext,
  identity: ActingIdentityV1,
  person: PrincipalRefV1,
  source: PersonalCredentialSource
): Promise<void> {
  const db = getDb()
  const run = await resolveExecutingRun(context.sessionId, context.executionRunId, {
    delivery: source === "lark-user" && context.delivery,
  })
  if (!run || getDb() !== db) throw new Error("Personal mark execution unavailable")
  const { appendRunEventInsideTransaction, semanticRunEvent } =
    await import("@/lib/db/execution-runs")
  const mark: PersonalMarkV1 = { person, source, markedAt: Date.now() }
  await db.transaction(
    "rw",
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
    async () => {
      const rootId = identity.rootRunId ?? run.actingIdentity?.rootRunId
      const visited = new Set<string>()
      let id: string | undefined = run.id
      let reachedRoot = false
      for (let depth = 0; id && depth < 32; depth++) {
        if (visited.has(id)) throw new Error("Personal mark ancestry cycle")
        visited.add(id)
        const current: ExecutionRun | undefined = await db.executionRuns.get(id)
        if (!current?.actingIdentity) throw new Error("Personal mark ancestor unavailable")
        if (current.actingIdentity.rootRunId && current.actingIdentity.rootRunId !== rootId)
          throw new Error("Personal mark identity changed")
        if (id === rootId || (!rootId && !current.parentRunId)) {
          if (JSON.stringify(current.actingIdentity) !== JSON.stringify(identity))
            throw new Error("Personal mark authority changed")
          reachedRoot = true
        }
        const marks = mergePersonalMarks(current.personalMarks, [mark])
        if (JSON.stringify(marks) !== JSON.stringify(current.personalMarks ?? [])) {
          await db.executionRuns.update(id, { personalMarks: marks })
          await appendRunEventInsideTransaction(
            db,
            id,
            semanticRunEvent(
              "personal.marked",
              { mark },
              { visibility: "private", ts: mark.markedAt }
            )
          )
        }
        if (reachedRoot) break
        // Follow every parent, never jump straight over a team/plan/delegation.
        id = current.parentRunId ?? (rootId !== current.id ? rootId : undefined)
      }
      if (!reachedRoot || getDb() !== db) throw new Error("Personal mark identity root unavailable")
    }
  )
}

// Only Host writers bind generated message ids. Model/plugin metadata is never
// used to choose a run. Weak database ownership prevents cross-account reuse.
const messageRuns = new WeakMap<ReturnType<typeof getDb>, Map<string, readonly string[]>>()
export function bindPersonalMessageRun(
  messageId: string,
  runId: string | readonly string[] | undefined
): void {
  if (!runId) return
  const runIds = typeof runId === "string" ? [runId] : runId
  const db = getDb()
  let bindings = messageRuns.get(db)
  if (!bindings) messageRuns.set(db, (bindings = new Map()))
  bindings.set(messageId, [...new Set(runIds)])
}

/** Only messages produced/changed by this exact Host event belong to its run. */
export function bindPersonalMessageChanges(
  before: readonly UIMessage[],
  after: readonly UIMessage[],
  runId: string | undefined
): void {
  const previous = new Map(before.map((message) => [message.id, message]))
  for (const message of after) {
    if (
      previous.get(message.id) !== message &&
      (message.role === "assistant" ||
        message.parts.some((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool"))
    )
      bindPersonalMessageRun(message.id, runId)
  }
}

/** Dexie replaces Promise within transactions, so instanceof is not reliable. */
export function isPendingPersonalMetadata(
  value: ReturnType<typeof personalMessageMetadata>
): value is Promise<Record<string, unknown> | undefined> {
  return !!value && typeof value.then === "function"
}

/** Read at the actual DB write, including delayed streaming/prepared deltas. */
export function personalMessageMetadata(
  messageId: string,
  incoming: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  state: { rowExists: boolean }
): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined> {
  const db = getDb()
  const runIds = messageRuns.get(db)?.get(messageId)
  const finish = (hostMarks?: PersonalMarkV1[]) => {
    if (getDb() !== db) throw new Error("Personal message database changed")
    const marks = mergePersonalMarks(
      previous?.personalMarks as PersonalMarkV1[] | undefined,
      runIds ? hostMarks : (incoming?.personalMarks as PersonalMarkV1[] | undefined)
    )
    const metadata = { ...incoming }
    if (runIds) delete metadata.personalMarks
    if (marks.length) metadata.personalMarks = marks
    // This path consumes producer output. Only the Host bound-session rule
    // below its caller may version a new row; output cannot supply that proof.
    delete metadata.personalMarkVersion
    return preservePersonalMarkMetadata(metadata, previous, { rowExists: state.rowExists })
  }
  // Keep ordinary writes synchronous inside their existing Dexie transaction.
  if (!runIds) return finish()
  const read = async () => {
    const marks: PersonalMarkV1[] = []
    for (const runId of runIds) {
      let id: string | undefined = runId
      const visited = new Set<string>()
      while (id) {
        if (visited.has(id) || visited.size >= 32)
          throw new Error("Personal message ancestry cycle")
        visited.add(id)
        const run: ExecutionRun | undefined = await db.executionRuns.get(id)
        if (!run) throw new Error("Personal message execution unavailable")
        marks.push(...(run.personalMarks ?? []))
        if (run.actingIdentity?.rootRunId === id) break
        id = run.parentRunId ?? run.actingIdentity?.rootRunId
      }
    }
    return finish(marks)
  }
  return (async () => {
    return Dexie.currentTransaction &&
      !Dexie.currentTransaction.storeNames.includes("executionRuns")
      ? await Dexie.waitFor(Dexie.ignoreTransaction(read))
      : await read()
  })()
}

/** Pure phase-2B read boundary. The caller supplies the Host-resolved bound person. */
export function effectivePersonalMarks(
  message: { metadata?: Record<string, unknown>; createdAt: number },
  session: { platformBinding?: unknown },
  context: { boundPerson: PrincipalRefV1; source: string }
): PersonalMarkV1[] {
  const explicit = message.metadata?.personalMarks as PersonalMarkV1[] | undefined
  if (explicit?.length) return mergePersonalMarks(explicit)
  if (
    message.metadata?.personalMarkVersion === 1 ||
    !session.platformBinding ||
    !context.boundPerson
  )
    return []
  return [{ person: context.boundPerson, source: context.source, markedAt: message.createdAt }]
}

/** Materialize a legacy read-time mark on a portable copy, never on its source row.
 * Lark and Slack expose a connected platform person; older adapters without such an
 * identity belong to the Host's local person. Neither choice grants authority.
 */
export async function personalMessageForCopy<
  T extends { sessionId: string; createdAt: number; metadata?: Record<string, unknown> },
>(
  db: ReturnType<typeof getDb>,
  message: T,
  knownSession?: Pick<ChatSession, "platformBinding">
): Promise<T & { metadata?: Record<string, unknown> }> {
  if (
    (message.metadata?.personalMarks as PersonalMarkV1[] | undefined)?.length ||
    message.metadata?.personalMarkVersion === 1
  )
    return message
  const session = knownSession ?? (await db.sessions.get(message.sessionId))
  const binding = session?.platformBinding
  if (!binding) return message
  const adapter = await db.adapterInstances.get(binding.adapterId)
  const connected = adapter?.settings.connectedUser as
    { openId?: unknown; unionId?: unknown } | undefined
  const slack = adapter?.settings.connectedTeam as { authedUserId?: unknown } | undefined
  const person: PrincipalRefV1 =
    binding.platform === "lark" && typeof connected?.openId === "string" && connected.openId
      ? {
          kind: "platform",
          platform: binding.platform,
          adapterId: binding.adapterId,
          remoteUserId: connected.openId,
          ...(typeof connected.unionId === "string" ? { unionId: connected.unionId } : {}),
        }
      : binding.platform === "slack" &&
          typeof slack?.authedUserId === "string" &&
          slack.authedUserId
        ? {
            kind: "platform",
            platform: binding.platform,
            adapterId: binding.adapterId,
            remoteUserId: slack.authedUserId,
          }
        : { kind: "local-person" }
  const personalMarks = effectivePersonalMarks(message, session, {
    boundPerson: person,
    source:
      binding.platform === "lark"
        ? "lark-user"
        : binding.platform === "slack"
          ? "slack-user"
          : "integration-user",
  })
  return { ...message, metadata: { ...message.metadata, personalMarks } }
}
