/** One publication boundary for content-bearing ctx APIs, including native guests.
 * A shared wrapper is necessary because synchronous getters, asynchronous reads
 * and subscriptions otherwise implement different personal-reader policies.
 */
import { personalEgressOptionsSource } from "@/lib/execution/personal-egress"
import { preparePluginHistory, withholdForReaders } from "@/lib/execution/personal-visibility"
import { readRunPersonalTaint } from "@/lib/execution/personal-sink"
import type { PersonalMarkV1 } from "@cognia/plugin-contract/types/execution/acting-identity"

const reads: Record<string, readonly string[]> = {
  session: [
    "getMessages",
    "onMessagesChange",
    "getSession",
    "getCurrentSession",
    "onSessionChange",
    "listSessions",
    "createSession",
    "updateSession",
    "cloneSession",
  ],
  sessions: ["create", "resume"],
  handle: ["history", "send"],
}
const unverified: PersonalMarkV1 = {
  person: { kind: "service", ref: "marked-plugin-output" },
  source: "plugin-run-output",
  markedAt: 0,
}

function withheld(value: unknown, marks: PersonalMarkV1[] = [unverified]): unknown {
  if (value == null) return value
  if (Array.isArray(value)) return value.map((item) => withheld(item, marks))
  if (value instanceof Uint8Array) return new TextEncoder().encode("[Withheld: personal content]")
  if (value instanceof ArrayBuffer)
    return new TextEncoder().encode("[Withheld: personal content]").buffer
  const row = typeof value === "object" ? (value as Record<string, unknown>) : { text: value }
  const projected: Record<string, unknown> = withholdForReaders(
    [
      {
        ...row,
        id: typeof row.id === "string" ? row.id : "plugin-read",
        metadata: { personalMarks: marks },
      },
    ],
    []
  ).messages[0]
  if (typeof value !== "object") return projected.text
  if (value instanceof Blob)
    return new Blob([String(projected.text ?? "[Withheld: personal content]")], {
      type: value.type,
    })
  return projected
}

async function project(value: unknown, ...runIds: (string | undefined)[]): Promise<unknown> {
  for (const runId of new Set(runIds)) {
    if (!runId) continue
    const taint = await readRunPersonalTaint({ executionRunId: runId })
    if (taint.marks.length) return withheld(value, taint.marks)
  }
  return value
}

function projectSeed(value: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
  const seed = value.branchSeed
  if (!isObject(seed) || !Array.isArray(seed.personalMarks) || !seed.personalMarks.length)
    return value
  return {
    ...value,
    branchSeed: { ...seed, content: "[Withheld: personal content]", personalMarks: undefined },
  }
}

async function projectSession(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(projectSession))
  if (!isObject(value)) return value
  const sessionId = typeof value.id === "string" ? value.id : undefined
  let output = projectSeed({ ...value })
  if (isObject(output.branchSeed) && !Array.isArray(output.branchSeed.personalMarks) && sessionId) {
    const taint = await readRunPersonalTaint({ sessionId, sessionDerived: true })
    if (taint.marks.length)
      output = projectSeed({
        ...output,
        branchSeed: { ...output.branchSeed, personalMarks: taint.marks },
      })
  }
  for (const key of ["messages", "history", "initialMessages"]) {
    if (Array.isArray(value[key]))
      output[key] = (await preparePluginHistory(sessionId, value[key])).messages
  }
  return output
}

/** Facades never expose an unwrapped method through property descriptors. */
function facade(target: object, read: (key: PropertyKey) => unknown): object {
  return new Proxy(
    {},
    {
      get: (_target, key) => read(key),
      has: (_target, key) => Reflect.has(target, key),
      ownKeys: () => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (_target, key) =>
        Reflect.has(target, key)
          ? {
              configurable: true,
              enumerable: Reflect.getOwnPropertyDescriptor(target, key)?.enumerable ?? true,
              get: () => read(key),
            }
          : undefined,
      getPrototypeOf: () => null,
    }
  )
}
function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return !!value && (typeof value === "object" || typeof value === "function")
}

/** Preserve synchronous getter/disposer and stream-handle contracts. */
export function withPluginPersonalReads<T extends object>(
  context: T,
  execution: () => { executionRunId?: string } = () => ({})
): T {
  const wrap = (target: object, namespace: string): object =>
    facade(target, (key) => {
      const value: unknown = Reflect.get(target, key)
      if (
        value &&
        typeof value === "object" &&
        ["agent", "sessions", "traces", "context"].includes(String(key))
      )
        return wrap(value, String(key))
      if (
        typeof value !== "function" ||
        (namespace !== "agent" && !reads[namespace]?.includes(String(key)))
      )
        return value
      return (...args: unknown[]) => {
        const messageRead =
          (namespace === "session" && ["getMessages", "onMessagesChange"].includes(String(key))) ||
          (namespace === "handle" && key === "history")
        const source =
          (namespace === "session" || (namespace === "export" && key === "exportSession")) &&
          typeof args[0] === "string"
            ? args[0]
            : namespace === "handle" && typeof Reflect.get(target, "id") === "string"
              ? (Reflect.get(target, "id") as string)
              : undefined
        const invocation = execution()
        let drivenResult: object | undefined
        let projectCallbacks = true
        const projectRead = async (result: unknown) => {
          if (messageRead && Array.isArray(result))
            return (await preparePluginHistory(source, result)).messages
          if (namespace === "session") return projectSession(result)
          return project(
            result,
            invocation.executionRunId,
            drivenResult && personalEgressOptionsSource(drivenResult)?.executionRunId,
            isObject(result) ? personalEgressOptionsSource(result)?.executionRunId : undefined
          )
        }
        let active = true
        const callbacks = (arg: unknown): unknown => {
          if (typeof arg === "function")
            return (...items: unknown[]) => {
              if (!projectCallbacks) return Reflect.apply(arg, undefined, items)
              return (async () => {
                const projected = await Promise.all(
                  items.map((item) =>
                    typeof item === "function"
                      ? async (...nextArgs: unknown[]) =>
                          projectRead(await Reflect.apply(item, undefined, nextArgs))
                      : projectRead(item)
                  )
                )
                if (active) return Reflect.apply(arg, undefined, projected)
              })()
            }
          if (arg && typeof arg === "object" && Object.getPrototypeOf(arg) === Object.prototype)
            return Object.fromEntries(
              Object.entries(arg).map(([key, item]) => [key, callbacks(item)])
            )
          if (Array.isArray(arg)) return arg.map(callbacks)
          return arg
        }
        const result: unknown = Reflect.apply(value, target, args.map(callbacks))
        if (isObject(result)) drivenResult = result
        if (
          namespace === "agent" &&
          !(
            isObject(result) &&
            (typeof result.then === "function" ||
              typeof result[Symbol.asyncIterator] === "function")
          )
        )
          projectCallbacks = false
        if (typeof result === "function")
          return () => {
            active = false
            result()
          }
        if (isObject(result) && typeof result[Symbol.asyncIterator] === "function")
          return facade(result, (key) => {
            if (key === Symbol.asyncIterator)
              return async function* () {
                for await (const item of result as unknown as AsyncIterable<unknown>)
                  yield await projectRead(item)
              }
            if (key === "result") return Promise.resolve(result.result).then(projectRead)
            const member = result[key]
            if (["next", "return", "throw"].includes(String(key)) && typeof member === "function")
              return async (...args: unknown[]) => {
                const step = (await Reflect.apply(member, result, args)) as IteratorResult<unknown>
                return { ...step, value: await projectRead(step.value) }
              }
            if (key === "cancel" && typeof member === "function") return member.bind(result)
            if (key === "agentId") return member
            return member
          })
        if (isObject(result) && typeof result.then === "function")
          return Promise.resolve(result).then((output: unknown) => {
            if (namespace === "sessions" && output && typeof output === "object")
              return wrap(output, "handle")
            return projectRead(output)
          })
        // Metadata getters stay synchronous. Project only embedded transcript
        // fields with positive stored marks; asynchronous transcript APIs use
        // the canonical effective-visibility reader above.
        if (namespace === "session" && Array.isArray(result))
          return result.map((row) => (isObject(row) ? projectSeed(row) : row))
        if (namespace === "session" && isObject(result)) {
          const output = projectSeed({ ...result })
          for (const field of ["messages", "history", "initialMessages"])
            if (Array.isArray(result[field]))
              output[field] = withholdForReaders(result[field], []).messages
          return output
        }
        return result
      }
    })
  return facade(context, (key) => {
    const value: unknown = Reflect.get(context, key)
    return value && typeof value === "object" && (String(key) === "agent" || reads[String(key)])
      ? wrap(value, String(key))
      : value
  }) as T
}
