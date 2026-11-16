import {
  configureLogEgressPolicy,
  configureLogFailureSource,
  type HostLogEgressSource,
} from "@cognia/logging/context"
/** Live Host egress authority. Kept separate from fixed-content sink disclosures. */
import { getDb } from "@/lib/db/schema"
import {
  forkPersonalOperation,
  bindPersonalOperationSources,
  isPersonalAdmissionOperation,
  personalOperationSources,
  personalFailureSource,
  configurePersonalDispatchFence,
} from "./personal-operation"
import type { PersonalSinkContext } from "./personal-sink"
import {
  readRunPersonalTaint,
  personalSinkContextForRun,
  personalTaintDependencies,
} from "./personal-sink"
import { PERSONAL_EGRESS_DENIAL } from "@cognia/plugin-contract/types/execution/personal-egress"
import type { PersonalEgressToolOwner } from "@cognia/plugin-contract/types/execution/personal-egress"
import { personalEgressToolDenied } from "@cognia/plugin-contract/types/execution/personal-egress"

export class PersonalEgressDeniedError extends Error {
  readonly code = "personal-egress-denied"
  constructor() {
    super(PERSONAL_EGRESS_DENIAL)
    this.name = "PersonalEgressDeniedError"
  }
}

export type PersonalEgressContext =
  | PersonalSinkContext
  | { sessionId?: string; executionRunId?: string; personalEgressBlocked?: true }

// Host-only association: external/model options cannot manufacture this source.
const optionSources = new WeakMap<object, PersonalEgressContext>()
export function bindPersonalEgressOptions<T extends object>(
  options: T,
  source: PersonalEgressContext
): T {
  optionSources.set(options, source)
  return options
}
export function personalEgressOptionsSource(
  options: object | undefined
): PersonalEgressContext | undefined {
  return options && optionSources.get(options)
}

function hasExecutionId(context: PersonalEgressContext, expected?: string): boolean {
  const pending: object[] = [context]
  const seen = new Set<object>()
  while (pending.length) {
    const source = pending.pop()!
    if (seen.has(source)) continue
    if (seen.size >= 128) return expected === undefined
    seen.add(source)
    if (
      "executionRunId" in source &&
      typeof source.executionRunId === "string" &&
      source.executionRunId &&
      (expected === undefined || source.executionRunId === expected)
    )
      return true
    pending.push(...(personalOperationSources(source) ?? []))
    if ("personalSources" in source && Array.isArray(source.personalSources))
      pending.push(...source.personalSources)
  }
  return false
}

interface TaintCache {
  revision: number
  changedAt: Map<string, number>
  entries: Map<string, { dependencies: ReadonlySet<string>; fenced: boolean; exposed: boolean }>
}
const caches = new WeakMap<object, TaintCache>()
const unavailableDatabase = {}
let currentDatabase: object | undefined
let currentDatabaseName: string | undefined
function databaseCache(): { scope: object; cache: TaintCache } {
  let db: ReturnType<typeof getDb> | undefined
  try {
    db = getDb()
  } catch {
    /* Canonical reads still fail closed for identified runs. */
  }
  const scope = db ?? unavailableDatabase
  const name = db?.name
  if (db && currentDatabase && name !== currentDatabaseName) {
    sessions.clear()
    activeOperations.clear()
    unprovenProcessSources.clear()
  }
  if (db) {
    currentDatabase = db
    currentDatabaseName = name
  }
  let cache = caches.get(scope)
  if (!cache) {
    cache = { revision: 0, changedAt: new Map(), entries: new Map() }
    caches.set(scope, cache)
    const invalidate = (id: string) => {
      cache!.revision++
      cache!.changedAt.set(id, cache!.revision)
      for (const [runId, entry] of cache!.entries)
        if (entry.dependencies.has(id)) cache!.entries.delete(runId)
    }
    if (db) {
      db.executionRuns.hook("updating", (changes, id) => {
        if (
          Object.keys(changes).some((key) =>
            /^(?:personalMarks|parentRunId|actingIdentity)(?:\.|$)/.test(key)
          )
        )
          invalidate(String(id))
      })
      db.executionRuns.hook("creating", (id, run) => {
        invalidate(String(id ?? run.id))
      })
      db.executionRuns.hook("deleting", (id) => {
        invalidate(String(id))
      })
    }
  }
  return { scope, cache }
}
/** Every mark commit invalidates all descendant snapshots synchronously. */
export function invalidatePersonalEgressCache(runId: string): void {
  const { cache } = databaseCache()
  cache.revision++
  cache.changedAt.set(runId, cache.revision)
  for (const [id, entry] of cache.entries)
    if (entry.dependencies.has(runId)) cache.entries.delete(id)
}
const compositeSnapshots = new WeakMap<
  object,
  {
    scope: object
    revision: number
    dependencies: ReadonlySet<string>
    fenced: boolean
    exposed: boolean
  }
>()
function compositeSnapshot(context: PersonalEgressContext) {
  const snapshot = compositeSnapshots.get(context)
  if (!snapshot) return undefined
  const { scope, cache } = databaseCache()
  return scope === snapshot.scope &&
    ![...snapshot.dependencies].some((id) => (cache.changedAt.get(id) ?? 0) > snapshot.revision)
    ? snapshot
    : undefined
}
/** Synchronous egress only: all retained producers need a current snapshot. */
function cachedEgress(
  context: PersonalEgressContext,
  seen = new Set<object>()
): { known: boolean; fenced: boolean } {
  if ("personalEgressBlocked" in context && context.personalEgressBlocked)
    return { known: true, fenced: true }
  if (seen.has(context) || seen.size >= 128) return { known: false, fenced: true }
  seen.add(context)
  try {
    const composite = compositeSnapshot(context)
    if (composite) return { known: true, fenced: composite.fenced }
    const sources =
      personalOperationSources(context) ??
      ("personalSources" in context ? context.personalSources : undefined)
    if (sources) {
      const snapshots = sources.map((source) => cachedEgress(source as PersonalEgressContext, seen))
      return {
        known:
          snapshots.some((item) => item.known && item.fenced) ||
          snapshots.every((item) => item.known),
        fenced: snapshots.some((item) => item.fenced),
      }
    }
    if ("sessionDerived" in context && context.sessionDerived) return { known: false, fenced: true }
    if (!context.executionRunId) return { known: true, fenced: false }
    const entry = databaseCache().cache.entries.get(context.executionRunId)
    return { known: Boolean(entry), fenced: !entry || entry.fenced }
  } finally {
    seen.delete(context)
  }
}
/** Unknown-provenance egress refusal is never evidence of content exposure. */
function cachedContentExposure(
  context: PersonalEgressContext,
  seen = new Set<object>()
): boolean | undefined {
  if ("personalEgressBlocked" in context && context.personalEgressBlocked) return true
  if (seen.has(context)) return undefined
  seen.add(context)
  try {
    const composite = compositeSnapshot(context)
    if (composite) return composite.exposed
    const sources =
      personalOperationSources(context) ??
      ("personalSources" in context ? context.personalSources : undefined)
    if (sources) {
      const snapshots = sources.map((source) =>
        cachedContentExposure(source as PersonalEgressContext, seen)
      )
      return snapshots.includes(true) ? true : snapshots.includes(undefined) ? undefined : false
    }
    if ("sessionDerived" in context && context.sessionDerived) return undefined
    return context.executionRunId
      ? databaseCache().cache.entries.get(context.executionRunId)?.exposed
      : false
  } finally {
    seen.delete(context)
  }
}
export function hasPersonalEgressSnapshot(context: PersonalEgressContext): boolean {
  return cachedEgress(context).known
}
export function personalEgressCachedFenced(context: PersonalEgressContext): boolean {
  return cachedEgress(context).fenced
}
export async function personalEgressFenced(context: PersonalEgressContext): Promise<boolean> {
  const originalContext = context
  if ("personalEgressBlocked" in context && context.personalEgressBlocked) return true
  const pending: object[] = [context]
  const canonical: PersonalSinkContext[] = []
  const visited = new Set<object>()
  let expanded = false
  let derived = false
  while (pending.length) {
    const source = pending.pop()!
    if (visited.has(source)) continue
    if (visited.size >= 128) return true
    visited.add(source)
    if ("personalEgressBlocked" in source && source.personalEgressBlocked) return true
    derived ||= "sessionDerived" in source && source.sessionDerived === true
    const producers =
      personalOperationSources(source) ??
      ("personalSources" in source && Array.isArray(source.personalSources)
        ? source.personalSources
        : undefined)
    if (producers) {
      expanded = true
      pending.push(...producers)
    } else canonical.push(source as PersonalSinkContext)
  }
  if (expanded) context = { personalSources: canonical }
  const identified = hasExecutionId(context)
  if (!identified && !derived && !("personalSources" in context && context.personalSources))
    return false
  const { scope, cache } = databaseCache(),
    revision = cache.revision
  let fenced: boolean
  let exposed = false
  let verified = false
  let dependencies: ReadonlySet<string> = new Set(
    context.executionRunId ? [context.executionRunId] : []
  )
  try {
    const taint = await readRunPersonalTaint(
      personalSinkContextForRun(context, "Opaque egress has no Host execution provenance")
    )
    dependencies = personalTaintDependencies?.(taint) ?? dependencies
    verified = taint.verified
    exposed = taint.marks.length > 0
    fenced = exposed || ((identified || derived) && !taint.verified)
  } catch {
    fenced = identified || derived
  }
  const current = databaseCache()
  // A concurrent mark invalidates the read. Refuse without doing a second read.
  if (
    scope !== current.scope ||
    [...dependencies].some((id) => (cache.changedAt.get(id) ?? 0) > revision)
  )
    return true
  if (
    verified &&
    !derived &&
    (expanded || ("personalSources" in context && context.personalSources))
  )
    compositeSnapshots.set(originalContext, { scope, revision, dependencies, fenced, exposed })
  if (verified && !derived && context.executionRunId)
    cache.entries.set(context.executionRunId, { dependencies, fenced, exposed })
  return fenced
}

/** Positive content exposure, with a stable canonical snapshot across all producers. */
export async function personalContentExposed(context: PersonalEgressContext): Promise<boolean> {
  for (;;) {
    const { scope, cache } = databaseCache()
    const revision = cache.revision
    const dependencies = new Set<string>()
    const pending: object[] = [context]
    const seen = new Set<object>()
    let exposed = false
    while (pending.length) {
      const source = pending.pop()!
      if (seen.has(source)) continue
      seen.add(source)
      if ("personalEgressBlocked" in source && source.personalEgressBlocked === true) exposed = true
      const producers =
        personalOperationSources(source) ??
        ("personalSources" in source && Array.isArray(source.personalSources)
          ? source.personalSources
          : undefined)
      if (producers) pending.push(...producers)
      else {
        const leaf = source as PersonalEgressContext
        if (leaf.executionRunId) dependencies.add(leaf.executionRunId)
        try {
          const taint = await readRunPersonalTaint(
            personalSinkContextForRun(leaf, "Plugin delivery has no Host execution provenance")
          )
          for (const id of personalTaintDependencies(taint) ?? []) dependencies.add(id)
          exposed ||= taint.marks.length > 0
        } catch {
          // Missing canonical proof does not establish content exposure.
        }
      }
    }
    const current = databaseCache()
    if (
      scope === current.scope &&
      ![...dependencies].some((id) => (cache.changedAt.get(id) ?? 0) > revision)
    )
      return exposed
    // A producer changed during another read. Re-read its positive evidence
    // before handing over content, without treating invalidation as exposure.
  }
}

export async function assertPersonalEgress(context: PersonalEgressContext): Promise<void> {
  if (await personalEgressFenced(context)) throw new PersonalEgressDeniedError()
}

/** Resolve the invocation from the Host's turn registry, never from tool input. */
export async function assertPersonalToolEgress(
  name: string,
  context: PersonalEgressContext,
  declaredRead = false,
  owner?: PersonalEgressToolOwner
): Promise<void> {
  if (!(await personalEgressFenced(context))) return
  const bare = name.split("__").at(-1) ?? name
  const opaque =
    /(?:fetch|clone|browser|shell|bash|process|terminal|code_interpreter|python|execute_code|^git_|^lsp_|^codegraph_)/i.test(
      bare
    )
  if (owner?.kind !== "plugin" && !opaque && declaredRead) return
  if (!owner) {
    const { toolOwnerBeforePlugin } =
      await import("@/lib/ai/agent/execution/contributions/tool-contributions")
    if (toolOwnerBeforePlugin(name)) owner = { kind: "host" }
  }
  if (personalEgressToolDenied(name, true, [], owner)) throw new PersonalEgressDeniedError()
}

// Each binding is installed by a Host dispatch, not by tool/model parameters.
// Re-read all live sources after a commit: siblings and descendants share taint.
const sessions = new Set<{
  context: PersonalEgressContext
  fence?: (admission?: PersonalEgressContext) => Promise<void>
}>()
export function bindPersonalEgressSession(
  context: PersonalEgressContext,
  fence?: (admission?: PersonalEgressContext) => Promise<void>
): () => void {
  const binding = { context, fence }
  sessions.add(binding)
  return () => {
    sessions.delete(binding)
  }
}

/** Must settle after the DB commit and before any marked content is returned. */
export async function fencePersonalEgressSessions(
  admission?: PersonalEgressContext,
  markingRunId = admission?.executionRunId
): Promise<void> {
  databaseCache()
  if (!markingRunId) throw new PersonalEgressDeniedError()
  const db = getDb()
  const taint = await readRunPersonalTaint({ executionRunId: markingRunId })
  if (!taint.verified) throw new PersonalEgressDeniedError()
  const ancestry = personalTaintDependencies(taint) ?? new Set([markingRunId])
  const memo = new Map<string, boolean>()
  const affected = async (
    context: PersonalEgressContext,
    seen = new Set<object>()
  ): Promise<boolean> => {
    if (seen.has(context)) return false
    if (seen.size >= 128) throw new PersonalEgressDeniedError()
    seen.add(context)
    const producers = personalOperationSources(context)
    if (producers) {
      for (const source of producers)
        if (await affected(source as PersonalEgressContext, seen)) return true
      return false
    }
    if ("personalSources" in context && context.personalSources) {
      for (const source of context.personalSources) if (await affected(source, seen)) return true
      return false
    }
    const id = context.executionRunId
    if (!id) return false
    if (ancestry.has(id)) return true
    if (memo.has(id)) return memo.get(id)!
    const candidate = await readRunPersonalTaint({ executionRunId: id })
    const dependencies = personalTaintDependencies(candidate)
    const value =
      !candidate.verified ||
      Boolean(dependencies && [...dependencies].some((key) => ancestry.has(key)))
    memo.set(id, value)
    return value
  }
  for (const binding of sessions) {
    if (!(await affected(binding.context))) continue
    if (!binding.fence) throw new PersonalEgressDeniedError()
    await binding.fence(admission)
  }
  await quiesceHostPersonalEgress(admission, affected)
  if (getDb() !== db)
    throw new Error("Personal egress database changed during fence acknowledgment")
}

const activeOperations = new Set<{ context: PersonalEgressContext; done: Promise<void> }>()
const unprovenProcessSources = new Set<{
  scopeName: string
  context: PersonalEgressContext
  processId: string
  isAlive: () => boolean | Promise<boolean>
}>()

/** Host-owned process identity and liveness; a settled RPC is not a live process. */
export function trackPersonalEgressProcess(
  context: PersonalEgressContext,
  processId: string,
  isAlive: () => boolean | Promise<boolean>
): () => void {
  databaseCache()
  const entry = {
    scopeName: currentDatabaseName ?? "unavailable",
    context: forkPersonalOperation(context),
    processId,
    isAlive,
  }
  unprovenProcessSources.add(entry)
  return () => {
    unprovenProcessSources.delete(entry)
  }
}

/** Register before the one final canonical read. A timeout never means completion. */
export function runPersonalEgressOperation<T>(
  context: PersonalEgressContext,
  task: (operation: PersonalEgressContext) => Promise<T>,
  processUnproven = false,
  allowFenced = false
): Promise<T> {
  databaseCache()
  const bound = forkPersonalOperation(context)
  let finish!: () => void
  const operation = {
    context: bound,
    done: new Promise<void>((resolve) => {
      finish = resolve
    }),
  }
  activeOperations.add(operation)
  let processLive = true
  let releaseProcess: (() => void) | undefined
  const execute = () => {
    if (processUnproven && hasExecutionId(bound))
      releaseProcess = trackPersonalEgressProcess(bound, crypto.randomUUID(), () => processLive)
    return task(bound)
  }
  const release = () => {
    processLive = false
    releaseProcess?.()
    activeOperations.delete(operation)
    finish()
  }
  let result: Promise<T>
  try {
    result = allowFenced ? execute() : assertPersonalEgress(bound).then(execute)
  } catch (error) {
    release()
    throw error
  }
  return Promise.resolve(result).then(
    (value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !(Symbol.asyncIterator in value || Symbol.iterator in value) ||
        !("next" in value)
      ) {
        release()
        return value
      }
      const stream = value as object
      const wrapped = new Proxy(stream, {
        get(target, key) {
          if (key === Symbol.asyncIterator || key === Symbol.iterator) return () => wrapped
          const member = Reflect.get(target, key, target)
          if (!["next", "return", "throw"].includes(String(key)) || typeof member !== "function")
            return member
          return (...args: unknown[]) => {
            const settle = (step: IteratorResult<unknown>) => {
              if (step.done) release()
              return step
            }
            try {
              const step = Reflect.apply(member, target, args) as
                IteratorResult<unknown> | Promise<IteratorResult<unknown>>
              return "then" in step
                ? Promise.resolve(step).then(settle, (error) => {
                    release()
                    throw error
                  })
                : settle(step)
            } catch (error) {
              release()
              throw error
            }
          }
        },
      })
      return wrapped as T
    },
    (error) => {
      release()
      throw error
    }
  )
}

async function quiesceHostPersonalEgress(
  admission: PersonalEgressContext | undefined,
  affected: (context: PersonalEgressContext) => Promise<boolean>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const quiesce = async () => {
    const pending: Promise<void>[] = []
    for (const operation of activeOperations)
      if (
        !isPersonalAdmissionOperation(operation.context, admission) &&
        (await affected(operation.context))
      )
        pending.push(operation.done)
    await Promise.all(pending)
    for (const entry of unprovenProcessSources) {
      if (!(await affected(entry.context))) continue
      let alive = true
      try {
        alive = await entry.isAlive()
      } catch {
        /* Unknown process liveness fails closed. */
      }
      if (!alive) {
        unprovenProcessSources.delete(entry)
        continue
      }
      throw new PersonalEgressDeniedError()
    }
  }
  try {
    await Promise.race([
      quiesce(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PersonalEgressDeniedError()), 2000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Serializable Host producer references, never public logger fields or credentials. */
export function personalLogEgressSource(
  context: PersonalEgressContext | undefined
): HostLogEgressSource | undefined {
  if (!context) return undefined
  const pending: object[] = [context],
    seen = new Set<object>(),
    runIds = new Set<string>()
  let blocked = false
  while (pending.length) {
    const source = pending.pop()!
    if (seen.has(source)) continue
    if (seen.size >= 128) {
      blocked = true
      break
    }
    seen.add(source)
    if ("personalEgressBlocked" in source && source.personalEgressBlocked) blocked = true
    if (
      "executionRunId" in source &&
      typeof source.executionRunId === "string" &&
      source.executionRunId
    )
      runIds.add(source.executionRunId)
    pending.push(...(personalOperationSources(source) ?? []))
    if ("personalSources" in source && Array.isArray(source.personalSources))
      pending.push(...source.personalSources)
  }
  return runIds.size || blocked
    ? { version: 1, runIds: [...runIds], ...(blocked ? { blocked: true } : {}) }
    : undefined
}

/** Installed before logger bootstrap/replay and by the plugin logger facade. */
export function installPersonalLogEgressPolicy(): void {
  configureLogFailureSource((error) =>
    personalLogEgressSource(personalFailureSource(error) as PersonalEgressContext | undefined)
  )
  configureLogEgressPolicy(async (entries, send) => {
    const admitted: typeof entries = [],
      sources: PersonalEgressContext[] = []
    for (const entry of entries) {
      const stamp = entry.hostEgressSource
      if (stamp === undefined) {
        admitted.push(entry)
        continue
      }
      if (
        !stamp ||
        stamp.version !== 1 ||
        !Array.isArray(stamp.runIds) ||
        stamp.runIds.length === 0 ||
        stamp.runIds.length > 128 ||
        stamp.runIds.some((id) => typeof id !== "string" || !id) ||
        stamp.blocked
      )
        continue
      const source = { personalSources: stamp.runIds.map((executionRunId) => ({ executionRunId })) }
      if (await personalEgressFenced(source)) continue
      admitted.push(entry)
      sources.push(source)
    }
    if (!admitted.length) return undefined
    try {
      return await runPersonalEgressOperation(bindPersonalOperationSources({}, sources), async () =>
        send(admitted)
      )
    } catch (error) {
      // A denied persisted batch is consumed, not retried forever as a network failure.
      if (error instanceof PersonalEgressDeniedError) return undefined
      throw error
    }
  })
}

configurePersonalDispatchFence((context) => cachedContentExposure(context as PersonalEgressContext))
