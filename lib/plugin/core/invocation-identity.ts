import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"

/** A Host operation without personal provenance is never an outside-dispatch read. */
export const HOST_BACKGROUND: Readonly<PersonalCredentialContext> = Object.freeze({
  executionRunId: "",
})

// Plugin APIs are registered once, outside any invocation. Browser runtimes have
// no async-local storage, so retain every Host-bound invocation until its actual
// callback settles. Only a verified Host parent -> job chain may overlap;
// unrelated runs fail closed. Public plugin fields cannot establish a chain.
const invocations = new Map<string, Set<PersonalCredentialContext>>()
// Only the synchronous entry into a Host dispatch may lend its identity to a
// registered callback. An unrelated background callback must not borrow a
// local-person invocation merely because that invocation is still awaiting.
const dispatching = new Map<string, PersonalCredentialContext>()
export function pluginDispatchContext(pluginId: string): PersonalCredentialContext {
  return { ...(dispatching.get(pluginId) ?? HOST_BACKGROUND) }
}
const callbackReceivers = new WeakMap<object, object>()
const delegatedAncestors = new WeakMap<PersonalCredentialContext, ReadonlySet<string>>()
const localProofIds = new Map<symbol, number>()
function localProofKey(proof: PersonalCredentialContext["localAuthorization"]) {
  if (proof === undefined) return null
  if (!localProofIds.has(proof)) localProofIds.set(proof, localProofIds.size + 1)
  return localProofIds.get(proof)
}
const contextKey = (context: PersonalCredentialContext) =>
  JSON.stringify([
    context.sessionId,
    context.executionRunId,
    localProofKey(context.localAuthorization),
  ])

/** Later Host state may narrow a captured read, never replace its authority. */
export function restrictPluginCredentialContext(
  captured: PersonalCredentialContext | undefined,
  current: PersonalCredentialContext | undefined
): PersonalCredentialContext | undefined {
  if (current && (!captured || contextKey(current) !== contextKey(captured)))
    return { executionRunId: "" }
  return captured && { ...captured, ...(current?.externalEngine ? { externalEngine: true } : {}) }
}

export function pluginExecutionContext(pluginId: string): PersonalCredentialContext | undefined {
  const active = invocations.get(pluginId)
  if (!active?.size) return undefined
  const contexts = [...active]
  const leaf = contexts.find((candidate) =>
    contexts.every(
      (item) =>
        contextKey(item) === contextKey(candidate) ||
        delegatedAncestors.get(candidate)?.has(contextKey(item))
    )
  )
  return leaf
    ? { ...leaf, ...(contexts.some((item) => item.externalEngine) ? { externalEngine: true } : {}) }
    : { executionRunId: "" }
}

/** Host dispatch only; never called with plugin/model arguments. */
export function withPluginExecutionContext<T>(
  pluginId: string,
  context: PersonalCredentialContext,
  task: () => T
): T {
  return bindPluginExecutionContext(pluginId, context, task)
}

function bindPluginExecutionContext<T>(
  pluginId: string,
  context: PersonalCredentialContext,
  task: () => T,
  ancestors?: ReadonlySet<string>
): T {
  const binding = {
    ...context,
    ...(context.executionRunId === undefined && context.localAuthorization === undefined
      ? HOST_BACKGROUND
      : {}),
  }
  const active = invocations.get(pluginId) ?? new Set<PersonalCredentialContext>()
  const same = [...active].find((item) => contextKey(item) === contextKey(binding))
  const inherited = ancestors ?? (same && delegatedAncestors.get(same))
  if (inherited) delegatedAncestors.set(binding, inherited)
  active.add(binding)
  invocations.set(pluginId, active)
  const release = () => {
    active.delete(binding)
    if (!active.size) invocations.delete(pluginId)
  }
  try {
    const previous = dispatching.get(pluginId)
    dispatching.set(pluginId, binding)
    let result: T
    try {
      result = task()
    } finally {
      if (previous) dispatching.set(pluginId, previous)
      else dispatching.delete(pluginId)
    }
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function")
      return Promise.resolve(result).then(
        (value) => finish(value, release),
        (error) => {
          release()
          throw error
        }
      ) as T
    return finish(result, release)
  } catch (error) {
    release()
    throw error
  }
}

function isIterator(value: unknown): value is Iterator<unknown> & object {
  return (
    !!value &&
    typeof value === "object" &&
    "next" in value &&
    typeof value.next === "function" &&
    (Symbol.asyncIterator in value || Symbol.iterator in value)
  )
}

/** A yielded stream is still executing between next() calls. Keep its binding
 * until done/return/throw actually settles, including cancellation cleanup. */
function finish<T>(value: T, release: () => void): T {
  if (!isIterator(value)) {
    release()
    return value
  }
  const iterator = new Proxy(value, {
    get(target, key) {
      if (key === Symbol.asyncIterator || key === Symbol.iterator) {
        if (!(key in target)) return undefined
        return () => iterator
      }
      const method = Reflect.get(target, key, target)
      if (!["next", "return", "throw"].includes(String(key)) || typeof method !== "function")
        return method
      return (...args: unknown[]) => {
        const settle = (step: IteratorResult<unknown>) => {
          if (step.done) release()
          return step
        }
        try {
          const step = Reflect.apply(method, target, args)
          return step && typeof step.then === "function"
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
  return iterator as T
}

/**
 * Fence callbacks contributed to Host registries, including factory results.
 * Plain data stays cloneable; class receivers and synchronous contracts stay
 * intact. Render components are the plugin's own panel UI, not Host operations.
 * Specific dispatchers establish exact operation identity outside this fence;
 * a registry with no such provenance receives HOST_BACKGROUND.
 */
export function bindPluginCallbacks<T>(
  pluginId: string,
  value: T,
  execution: () => PersonalCredentialContext = () => dispatching.get(pluginId) ?? HOST_BACKGROUND,
  seen = new WeakMap<object, unknown>()
): T {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value
  const object = value as object
  if (seen.has(object)) return seen.get(object) as T
  if (typeof value === "function") {
    // A callable facade can guard frozen callback properties too; a Proxy of
    // the original function cannot replace its non-configurable members.
    const facade = function () {}
    const bound: typeof facade = new Proxy(facade, {
      get(target, key) {
        if (["prototype", "caller", "arguments", "name", "length"].includes(String(key)))
          return Reflect.get(target, key, target)
        return bindPluginCallbacks(pluginId, Reflect.get(value, key, value), execution, seen)
      },
      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(value)])]
      },
      getOwnPropertyDescriptor(target, key) {
        const own = Reflect.getOwnPropertyDescriptor(target, key)
        if (own && !own.configurable) return own
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
        return descriptor && { ...descriptor, configurable: true }
      },
      apply(_target, receiver, args) {
        const context = execution()
        const result = withPluginExecutionContext(pluginId, context, () =>
          Reflect.apply(value, (receiver && callbackReceivers.get(receiver)) || receiver, args)
        )
        const wrapResult = (output: unknown) => {
          // Generator bodies execute on next(), after stream() has returned.
          const iterator = isIterator(output)
          return bindPluginCallbacks(pluginId, output, iterator ? () => context : execution)
        }
        return result && typeof (result as PromiseLike<unknown>).then === "function"
          ? Promise.resolve(result).then(wrapResult)
          : wrapResult(result)
      },
      construct(_target, args, newTarget): object {
        return bindPluginCallbacks(
          pluginId,
          withPluginExecutionContext(pluginId, execution(), () =>
            Reflect.construct(value, args, newTarget === bound ? value : newTarget)
          ),
          execution
        )
      },
    })
    callbackReceivers.set(bound, object)
    seen.set(object, bound)
    return bound as T
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    // Platform objects are opaque. Plugin factory instances have prototype
    // methods; bind those with the real receiver (including private fields).
    if (
      value instanceof Date ||
      value instanceof Map ||
      value instanceof Set ||
      value instanceof AbortSignal ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    )
      return value
    const bound = new Proxy(object, {
      get(target, key) {
        const member = Reflect.get(target, key, target)
        return typeof member === "function"
          ? bindPluginCallbacks(pluginId, member.bind(target), execution, seen)
          : bindPluginCallbacks(pluginId, member, execution, seen)
      },
    })
    seen.set(object, bound)
    return bound as T
  }
  const bound = (Array.isArray(value) ? [] : Object.create(prototype)) as Record<
    PropertyKey,
    unknown
  >
  callbackReceivers.set(bound, object)
  seen.set(object, bound)
  let changed = false
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!
    if ("value" in descriptor && !["render", "component", "Component"].includes(String(key))) {
      const original = descriptor.value
      descriptor.value = bindPluginCallbacks(pluginId, original, execution, seen)
      changed ||= descriptor.value !== original
    }
    if (descriptor.get) {
      descriptor.get = bindPluginCallbacks(pluginId, descriptor.get, execution, seen)
      changed = true
    }
    if (descriptor.set) {
      descriptor.set = bindPluginCallbacks(pluginId, descriptor.set, execution, seen)
      changed = true
    }
    Object.defineProperty(bound, key, descriptor)
  }
  // Opaque Host proof objects are WeakMap keys. Never copy data-only arguments.
  if (!changed) seen.set(object, value)
  return changed ? (bound as T) : value
}

/** Wrap only plugin → Host arguments; Host API functions themselves confer no identity. */
export function bindPluginContextCallbacks<T extends object>(pluginId: string, api: T): T {
  const seen = new WeakMap<object, unknown>()
  const callbacks = new WeakMap<object, unknown>()
  const handles = new WeakMap<object, object>()
  const result = (value: unknown): unknown => {
    if (value && typeof (value as PromiseLike<unknown>).then === "function")
      return Promise.resolve(value).then(result)
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value
    // Data-only objects include opaque Host proof keys and must keep identity.
    const hasMethods = (object: object, visited = new WeakSet<object>()): boolean => {
      if (visited.has(object)) return false
      visited.add(object)
      if (typeof object === "function") return true
      return Reflect.ownKeys(object).some((key) => {
        const member = Object.getOwnPropertyDescriptor(object, key)?.value
        return (
          typeof member === "function" ||
          (member &&
            typeof member === "object" &&
            Object.getPrototypeOf(member) === Object.prototype &&
            hasMethods(member, visited))
        )
      })
    }
    return hasMethods(value as object) ? wrap(value as object) : value
  }
  const argsForHost = (args: unknown[]) =>
    args.map((arg) =>
      bindPluginCallbacks(
        pluginId,
        arg && (typeof arg === "object" || typeof arg === "function")
          ? (handles.get(arg as object) ?? arg)
          : arg,
        undefined,
        callbacks
      )
    )
  const wrap = (value: object): object => {
    if (seen.has(value)) return seen.get(value) as object
    const proxy = new Proxy(value, {
      apply(target, receiver, args) {
        return result(
          Reflect.apply(target as (...args: unknown[]) => unknown, receiver, argsForHost(args))
        )
      },
      get(target, key) {
        const member = Reflect.get(target, key, target)
        if (typeof member === "function") {
          if (seen.has(member)) return seen.get(member)
          const method: (...args: unknown[]) => unknown = new Proxy(member, {
            apply(_member, _receiver, args) {
              return result(Reflect.apply(member, target, argsForHost(args)))
            },
            construct(_member, args, newTarget): object {
              return result(
                Reflect.construct(
                  member,
                  argsForHost(args),
                  newTarget === method ? member : newTarget
                )
              ) as object
            },
          })
          seen.set(member, method)
          return method
        }
        return member &&
          typeof member === "object" &&
          Object.getPrototypeOf(member) === Object.prototype
          ? wrap(member)
          : member
      },
    })
    seen.set(value, proxy)
    handles.set(proxy, value)
    return proxy
  }
  return wrap(api) as T
}

/** Host job dispatch only. Persisted parent and exact root establish delegation,
 * never equal principal labels, an id prefix alone or plugin-supplied fields. */
export async function withPluginJobExecutionContext<T>(
  pluginId: string,
  jobId: string,
  task: () => Promise<T>
): Promise<T> {
  const context = { executionRunId: `execution:job:integration:${jobId}` }
  const parent = pluginExecutionContext(pluginId)
  if (!parent?.executionRunId || parent.executionRunId === context.executionRunId)
    return withPluginExecutionContext(pluginId, context, task)
  const { getDb } = await import("@/lib/db/schema")
  const { resolveExecutingRun } = await import("@/lib/execution/acting-authority")
  const db = getDb()
  const [job, child, parentRun] = await Promise.all([
    db.integrationActionJobs.get(jobId),
    resolveExecutingRun(undefined, context.executionRunId),
    resolveExecutingRun(parent.sessionId, parent.executionRunId),
  ])
  const current = pluginExecutionContext(pluginId)
  const parentBinding = [...(invocations.get(pluginId) ?? [])].find(
    (item) => contextKey(item) === contextKey(parent)
  )
  if (
    getDb() === db &&
    job?.pluginId === pluginId &&
    job.status === "running" &&
    child?.kind === "job" &&
    child.sourceId === `integration:${jobId}` &&
    parentRun &&
    child.parentRunId === parentRun.id &&
    child.actingIdentity?.rootRunId &&
    child.actingIdentity.rootRunId === parentRun.actingIdentity?.rootRunId &&
    current &&
    contextKey(current) === contextKey(parent) &&
    parentBinding
  ) {
    return bindPluginExecutionContext(
      pluginId,
      context,
      task,
      new Set([...(delegatedAncestors.get(parentBinding) ?? []), contextKey(parent)])
    )
  }
  return withPluginExecutionContext(pluginId, context, task)
}

/** An opaque Host API read, not a plugin-supplied outside-run flag. */
export interface PluginCredentialAccess {
  readonly __pluginCredentialAccess: unique symbol
}
const accesses = new WeakMap<
  object,
  {
    pluginId: string
    context?: PersonalCredentialContext
    assertConsumerAccess?: (ref: string) => Promise<void>
  }
>()

export function createPluginCredentialAccess(
  pluginId: string,
  assertConsumerAccess?: (ref: string) => Promise<void>
): PluginCredentialAccess {
  const proof = {} as PluginCredentialAccess
  accesses.set(proof, { pluginId, context: pluginExecutionContext(pluginId), assertConsumerAccess })
  return proof
}

export function readPluginCredentialAccess(proof: PluginCredentialAccess) {
  return accesses.get(proof)
}

/** Only Host dispatch binding determines whether a command is inside a run. */
export async function withPluginCommandExecution<T>(
  pluginId: string,
  context: object | undefined,
  task: () => Promise<T>
): Promise<T> {
  const bound = hostCommandExecution(context) ?? pluginDispatchContext(pluginId)
  return withPluginExecutionContext(pluginId, bound ?? HOST_BACKGROUND, task)
}

// The promoted SlashCommand IPC passes the same Host-created context object
// through dispatch. A public context field cannot reproduce this association.
const commandExecutions = new WeakMap<
  object,
  Pick<PersonalCredentialContext, "sessionId" | "executionRunId">
>()
export function hostCommandExecution(context: object | undefined) {
  return context ? commandExecutions.get(context) : undefined
}
export async function withHostCommandExecution<T>(
  context: object,
  execution: Pick<PersonalCredentialContext, "sessionId" | "executionRunId">,
  task: () => Promise<T>
): Promise<T> {
  commandExecutions.set(context, {
    sessionId: execution.sessionId,
    executionRunId: execution.executionRunId ?? "",
  })
  try {
    return await task()
  } finally {
    commandExecutions.delete(context)
  }
}
