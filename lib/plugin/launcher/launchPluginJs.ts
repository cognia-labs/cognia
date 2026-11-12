// ADR-0028 Phase 5 / T2 — re-exec a plugin JS entry under the verified,
// bundled Node 26.3.1+ runtime
// `--permission` so the entry's filesystem / network / child-process
// surface is bounded by the manifest's declared `PluginPermission[]`.
//
// Composes with T1: even if a plugin spawns `bash`, the SDK builtin Bash
// is disabled in sandbox-enabled sessions (build-options adds it to
// `disallowedTools`) and the model routes through our `sandbox_*` tools
// instead.
//
// The loader builds a Node-target plugin definition from this helper;
// the manager reaches it through the normal load/activate lifecycle and
// kills the spawned process through the definition's deactivate hook.

import { getPluginI18nBundle } from "@/lib/i18n/plugin-i18n-registry"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import { invoke } from "@tauri-apps/api/core"

/**
 * Permission scope inputs the plugin manifest carries. `PluginPermission`
 * is an opaque enum of permission strings (`"filesystem:read"`,
 * `"network:fetch"`, etc.); the manifest also separately carries the
 * concrete path / host lists the renderer-side permission UI consumes.
 *
 * Node 26's permission model gives us scoped filesystem flags, but its
 * network and subprocess switches are all-or-nothing. Those permissions
 * remain host-broker-only.
 */
export interface NodePermissionScope {
  /** Permissions declared on the plugin manifest. */
  permissions: ReadonlyArray<PluginPermission>
  /** Concrete read-allowed paths (absolute). */
  readPaths: ReadonlyArray<string>
  /** Concrete write-allowed paths (absolute). */
  writePaths: ReadonlyArray<string>
  /** Concrete host allowlist requested by the manifest. Never emitted as a broad grant. */
  netHosts: ReadonlyArray<string>
  /** Subprocess names requested by the manifest. Never emitted as a broad grant. */
  allowedSubprocesses: ReadonlyArray<string>
}

export type NodePermissionSupport =
  | { available: true }
  | {
      available: false
      reason: "network-broker-missing" | "subprocess-broker-missing"
    }

/** Project the native Node host's currently implemented permission boundary. */
export function nodePermissionSupport(permission: PluginPermission): NodePermissionSupport {
  if (
    permission === "network:fetch" ||
    permission === "network:upload" ||
    permission === "network:websocket"
  ) {
    return { available: false, reason: "network-broker-missing" }
  }
  if (permission === "shell:execute" || permission === "process:spawn") {
    return { available: false, reason: "subprocess-broker-missing" }
  }
  return { available: true }
}

export type PluginJsHostInvoker = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export interface HostPluginProcess {
  killed: boolean
  isRunning(): Promise<boolean>
  kill(): Promise<void>
}

export interface LaunchPluginJsOptions {
  pluginId: string
  entryPath: string
  scope: NodePermissionScope
  extraArgs?: ReadonlyArray<string>
  cwd?: string
  hostInvoker?: PluginJsHostInvoker
  context?: object
  manifest?: PluginManifest
  requestTimeoutMs?: number
}

export interface LaunchPluginJsResult {
  command: string
  argv: string[]
  generation: string
  process: HostPluginProcess
  activation: NodePluginActivationSnapshot
  invokeCallback(callbackId: string, args: unknown[]): Promise<unknown>
  deactivate(): Promise<void>
}

export interface NodePluginActivationSnapshot {
  hooks: unknown
  exports: Record<string, unknown>
}

function cleanAllowValues(values: ReadonlyArray<string>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && !value.includes("*"))
    )
  )
}

/**
 * Translate a permission scope into safe `--allow-*` flags for Node 26.3.1+.
 * Returns the argv prefix that callers prepend before the entry path.
 *
 * Node 26.3.1+ `--permission` semantics:
 *   - The flag itself ENABLES the permission model (everything is
 *     denied unless allowed).
 *   - Each filesystem path uses its own `--allow-fs-read=<path>` or
 *     `--allow-fs-write=<path>` flag. Node does not accept CSV path lists.
 *   - `--allow-net` is all-or-nothing and is therefore never emitted.
 *   - `--allow-child-process` is all-or-nothing, so it is not used for
 *     manifest subprocess allowlists.
 *
 * Empty lists translate to OMITTED flags, NOT to `*`. The fail-safe is
 * a deny.
 *
 * Pure: no I/O.
 */
export function nodePermissionArgs(scope: NodePermissionScope): string[] {
  const args: string[] = ["--permission"]
  const readPaths = cleanAllowValues(scope.readPaths)
  const writePaths = cleanAllowValues(scope.writePaths)
  const netHosts = cleanAllowValues(scope.netHosts)
  const allowedSubprocesses = cleanAllowValues(scope.allowedSubprocesses)
  if (netHosts.length > 0) {
    throw new Error(
      "Node network grants require a scoped host broker; refusing broad --allow-net access."
    )
  }
  if (allowedSubprocesses.length > 0) {
    throw new Error(
      "Node subprocess grants require a scoped host broker; refusing broad --allow-child-process access."
    )
  }
  if (readPaths.length > 0) {
    args.push(...readPaths.map((path) => `--allow-fs-read=${path}`))
  }
  if (writePaths.length > 0) {
    args.push(...writePaths.map((path) => `--allow-fs-write=${path}`))
  }
  return args
}

/**
 * Convert the manifest's coarse `PluginPermission[]` into the concrete
 * scope fields when the renderer-side permission grant didn't already
 * supply a precise list. Conservative: when a permission category is
 * declared but no specific paths are known, return an empty list so the
 * Node flag is OMITTED entirely. This is intentionally restrictive —
 * the manifest must surface its concrete paths somewhere (e.g.
 * `manifest.fileScope`) for those paths to land in the flag.
 */
export function deriveScopeFromManifest(
  permissions: ReadonlyArray<PluginPermission>,
  concrete: {
    readPaths?: string[]
    writePaths?: string[]
    netHosts?: string[]
    subprocesses?: string[]
  }
): NodePermissionScope {
  return {
    permissions,
    readPaths: concrete.readPaths ?? [],
    writePaths: concrete.writePaths ?? [],
    netHosts: concrete.netHosts ?? [],
    allowedSubprocesses: concrete.subprocesses ?? [],
  }
}

/**
 * Build the full argv to re-exec a plugin JS file. Result is the
 * sequence the native plugin host passes to its verified Node child process.
 */
export function buildLaunchArgv(
  entryPath: string,
  scope: NodePermissionScope,
  extraArgs: ReadonlyArray<string> = []
): string[] {
  return [...nodePermissionArgs(scope), entryPath, ...extraArgs]
}

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])
const WIRE_KEYS = [
  "$callback",
  "$undefined",
  "$cogniaSecretRef",
  "$cogniaPlainObject",
  "$hostHandle",
]
type WireFrame = Record<string, unknown> & { type: string; id?: string }

function safeSegments(path: string): string[] {
  const segments = path ? path.split(".") : []
  if (segments.some((segment) => !segment || UNSAFE_SEGMENTS.has(segment))) {
    throw new Error(`Node plugin requested an unsafe context path: ${path}`)
  }
  return segments
}

export function encodeNodePluginValue(
  value: unknown,
  onFunction: (value: (...args: never[]) => unknown, path: string[]) => unknown,
  path: string[] = [],
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "function") return onFunction(value as (...args: never[]) => unknown, path)
  if (value === undefined) return { $undefined: true }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) throw new Error("Node plugin value contains a cycle")
  seen.add(value)
  const entries = Object.entries(value).map(([key, item]) => [
    key,
    encodeNodePluginValue(item, onFunction, [...path, key], seen),
  ])
  seen.delete(value)
  if (Array.isArray(value)) return entries.map(([, item]) => item)
  const encoded = Object.fromEntries(entries)
  if (
    Object.getOwnPropertyDescriptor(value, Symbol.for("cognia.plugin.secretRef"))?.value === true
  ) {
    return { $cogniaSecretRef: encoded }
  }
  return WIRE_KEYS.some((key) => Object.hasOwn(value, key))
    ? { $cogniaPlainObject: entries }
    : encoded
}

export function reviveNodePluginValue(
  value: unknown,
  callback: (id: string, args: unknown[]) => Promise<unknown>,
  hostHandle?: (reference: { id: string; path?: string[] }) => unknown
): unknown {
  if (Array.isArray(value))
    return value.map((item) => reviveNodePluginValue(item, callback, hostHandle))
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const reviveObject = (object: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(object).map(([key, item]) => [
        key,
        reviveNodePluginValue(item, callback, hostHandle),
      ])
    )
  if (Object.keys(record).length === 1) {
    if (record.$undefined === true) return undefined
    if (Array.isArray(record.$cogniaPlainObject)) {
      return Object.fromEntries(
        record.$cogniaPlainObject.map(([key, item]: [string, unknown]) => [
          key,
          reviveNodePluginValue(item, callback, hostHandle),
        ])
      )
    }
    if (record.$cogniaSecretRef && typeof record.$cogniaSecretRef === "object") {
      return Object.defineProperty(
        reviveObject(record.$cogniaSecretRef as Record<string, unknown>),
        Symbol.for("cognia.plugin.secretRef"),
        { value: true }
      )
    }
    if (typeof record.$callback === "string")
      return (...args: unknown[]) => callback(record.$callback as string, args)
    if (record.$hostHandle && hostHandle)
      return hostHandle(record.$hostHandle as { id: string; path?: string[] })
  }
  return reviveObject(record)
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node plugin ${label} timed out`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function launchPluginJs(
  options: LaunchPluginJsOptions
): Promise<LaunchPluginJsResult> {
  if (!options.pluginId.trim()) throw new Error("launchPluginJs: pluginId is required")
  if (!options.entryPath.trim())
    throw new Error(`launchPluginJs: entryPath is required for ${options.pluginId}`)
  if (!options.cwd?.trim())
    throw new Error(`launchPluginJs: cwd is required for ${options.pluginId}`)
  const argv = buildLaunchArgv(options.entryPath, options.scope, options.extraArgs ?? [])
  if (argv.some((arg) => arg.includes("*")))
    throw new Error(`launchPluginJs: wildcard grants are forbidden for ${options.pluginId}`)
  const hostInvoker = options.hostInvoker ?? invoke
  const launched = await hostInvoker<{
    command: string
    argv: string[]
    generation: string
  }>("plugin_launch_js", {
    pluginId: options.pluginId,
    pluginPath: options.cwd,
    entry: options.entryPath,
    extraArgs: options.extraArgs ?? [],
  })
  const identity = {
    pluginId: options.pluginId,
    pluginPath: options.cwd,
    entry: options.entryPath,
    generation: launched.generation,
  }
  const context = (options.context ?? {}) as Record<string, unknown>
  const timeoutMs = options.requestTimeoutMs ?? 120_000
  const requests = new Map<
    string,
    {
      resolve: (frame: WireFrame) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      kind: string
    }
  >()
  const handles = new Map<string, { value: unknown; cleanup: boolean }>()
  const handleCalls = new Map<string, Promise<unknown>>()
  const hostCalls = new Map<string, Set<Promise<unknown>>>()
  const outbox: WireFrame[] = []
  let sequence = 0
  let closed = false
  let terminalError: Error | undefined
  let stopping: Promise<void> | undefined
  const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  const disposeHandle = async (value: unknown) => {
    if (typeof value === "function") await value()
    else if (value && typeof value === "object") {
      const handle = value as Record<string, unknown>
      for (const name of ["dispose", "unsubscribe", "unregister", "close"]) {
        if (typeof handle[name] === "function") {
          await (handle[name] as () => unknown).call(handle)
          break
        }
      }
    }
  }
  const cleanupHandles = async () => {
    const entries = [...handles.entries()].filter(([, handle]) => handle.cleanup)
    handles.clear()
    const results = await Promise.allSettled(
      entries.map(([, handle]) => bounded(disposeHandle(handle.value), 5_000, "handle disposal"))
    )
    results.forEach((result, index) => {
      if (result.status === "rejected") handles.set(...entries[index])
    })
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }
  const process: HostPluginProcess = {
    killed: false,
    async isRunning() {
      if (process.killed || closed) return false
      return hostInvoker<boolean>("plugin_js_status", {
        pluginId: options.pluginId,
        generation: launched.generation,
      })
    },
    kill() {
      if (stopping) return stopping
      stopping = (async () => {
        closed = true
        for (const pending of requests.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error("Node plugin stopped"))
        }
        requests.clear()
        hostCalls.clear()
        outbox.length = 0
        let disposalError: unknown
        try {
          await cleanupHandles()
        } catch (error) {
          disposalError = error
        }
        try {
          if (!process.killed)
            await bounded(
              hostInvoker<void>("plugin_stop_js", {
                pluginId: options.pluginId,
                generation: launched.generation,
              }),
              5_000,
              "stop"
            )
        } catch (error) {
          if (disposalError)
            throw new AggregateError(
              [disposalError, error],
              "Node plugin handle cleanup and stop failed"
            )
          throw error
        }
        process.killed = true
        if (disposalError) throw disposalError
      })()
      void stopping.catch(() => {
        stopping = undefined
      })
      return stopping
    },
  }
  const request = (frame: WireFrame, budget = timeoutMs) => {
    if (closed) return Promise.reject(terminalError ?? new Error("Node plugin stopped"))
    const id = frame.id ?? `request:${++sequence}`
    return new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id)
        hostCalls.delete(id)
        reject(new Error("Node plugin request timed out"))
      }, budget)
      requests.set(id, { resolve, reject, timer, kind: frame.type })
      outbox.push({ ...frame, id })
    })
  }
  const encode = (value: unknown, id: string, cleanup = true) => {
    let hasHandle = false
    const encoded = encodeNodePluginValue(value, (_fn, path) => {
      hasHandle = true
      return { $hostHandle: { id, path } }
    })
    hasHandle ||= Boolean(
      value &&
      typeof value === "object" &&
      [...Object.keys(value), "dispose", "unsubscribe", "unregister", "close"].some(
        (key) => typeof (value as Record<string, unknown>)[key] === "function"
      )
    )
    if (hasHandle) handles.set(id, { value, cleanup })
    if (
      hasHandle &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return { $hostHandle: { id, path: [], properties: encoded } }
    }
    return encoded
  }
  const resolveHostHandle = (reference: { id: string; path?: string[] }) => {
    if (!handles.has(reference.id))
      throw new Error("Node plugin requested an unavailable host handle")
    let value = handles.get(reference.id)?.value
    let owner: unknown
    for (const segment of safeSegments((reference.path ?? []).join("."))) {
      owner = value
      value =
        value && (typeof value === "object" || typeof value === "function")
          ? (value as Record<string, unknown>)[segment]
          : undefined
    }
    return typeof value === "function" && owner ? value.bind(owner) : value
  }
  const awaitHostHandles = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 1 && record.$hostHandle) {
      const id = (record.$hostHandle as { id: string }).id
      if (handleCalls.has(id)) await handleCalls.get(id)
      return
    }
    await Promise.all(Object.values(record).map(awaitHostHandles))
  }
  const invokeCallback = async (callbackId: string, args: unknown[]) => {
    const id = `request:${++sequence}`
    const frame = await request({
      type: "invoke",
      id,
      callbackId,
      args: encode(args, id, false),
    })
    return reviveNodePluginValue(frame.value, invokeCallback, resolveHostHandle)
  }
  const execute = async (frame: WireFrame) => {
    const id = frame.id as string
    const path = safeSegments(String(frame.path ?? ""))
    let owner: unknown = context
    if (frame.handle) {
      const handleId = String(frame.handle)
      if (handleCalls.has(handleId)) await handleCalls.get(handleId)
      if (!handles.has(handleId))
        throw new Error("Node plugin requested an unavailable host handle")
      owner = handles.get(handleId)?.value
    } else if (!path.length) throw new Error("Node plugin requested an empty context path")
    let method = owner
    for (const segment of path) {
      if (!method || (typeof method !== "object" && typeof method !== "function"))
        throw new Error("Node plugin requested unavailable context method")
      owner = method
      method = (method as Record<string, unknown>)[segment]
    }
    if (typeof method !== "function")
      throw new Error(`Node plugin requested unavailable context method: ${frame.path}`)
    await awaitHostHandles(frame.args)
    if (closed) throw new Error("Node plugin stopped")
    const args = reviveNodePluginValue(frame.args, invokeCallback, resolveHostHandle)
    if (!Array.isArray(args)) throw new Error("Node plugin context arguments must be an array")
    const value = await method.apply(owner, args)
    if (
      frame.handle &&
      (!path.length ||
        ["dispose", "unsubscribe", "unregister", "close"].includes(path.at(-1) ?? ""))
    )
      handles.delete(String(frame.handle))
    if (closed) {
      await disposeHandle(value)
      return { $undefined: true }
    }
    return encode(value, id)
  }
  const receive = (frame: WireFrame) => {
    if (closed) return
    if (frame.type === "call") {
      const id = frame.id as string
      const task = bounded(execute(frame), timeoutMs, "host call")
      handleCalls.set(id, task)
      const ownerId = String(frame.requestId ?? "")
      if (requests.has(ownerId)) {
        const calls = hostCalls.get(ownerId) ?? new Set<Promise<unknown>>()
        calls.add(task)
        hostCalls.set(ownerId, calls)
      }
      task
        .then(
          (value) => {
            if (!closed) outbox.push({ type: "reply", id, value })
          },
          (error) => {
            if (!closed) outbox.push({ type: "reply", id, error: errorOf(error).message })
            const pending = requests.get(ownerId)
            if (pending?.kind === "activate") {
              clearTimeout(pending.timer)
              requests.delete(ownerId)
              pending.reject(errorOf(error))
            }
          }
        )
        .finally(() => {
          handleCalls.delete(id)
        })
      return
    }
    const id = frame.id as string
    const pending = requests.get(id)
    if (!pending) return
    if (frame.type === "error") {
      requests.delete(id)
      clearTimeout(pending.timer)
      hostCalls.delete(id)
      pending.reject(new Error(String(frame.error)))
      return
    }
    const calls = hostCalls.get(id)
    hostCalls.delete(id)
    const settled =
      pending.kind === "activate" ? Promise.all(calls ?? []) : Promise.allSettled(calls ?? [])
    settled
      .then(
        () => pending.resolve(frame),
        (error) => pending.reject(errorOf(error))
      )
      .finally(() => {
        requests.delete(id)
        clearTimeout(pending.timer)
      })
  }
  const pump = async () => {
    try {
      while (!closed) {
        const frames: WireFrame[] = []
        let bytes = 0
        while (outbox.length && frames.length < 32) {
          const size = new TextEncoder().encode(JSON.stringify(outbox[0])).length + 1
          if (size > 2 * 1024 * 1024)
            throw new Error("Node plugin frame exceeded the protocol limit")
          if (bytes + size > 2 * 1024 * 1024) break
          bytes += size
          frames.push(outbox.shift() as WireFrame)
        }
        const batch = await bounded(
          hostInvoker<{ frames: WireFrame[] }>("plugin_invoke_js_callback", {
            ...identity,
            callbackId: "$exchange",
            args: { frames, waitMs: frames.length ? 0 : 100 },
          }),
          5_000,
          "exchange"
        )
        if (!Array.isArray(batch.frames)) throw new Error("Invalid Node plugin exchange response")
        for (const frame of batch.frames) receive(frame)
        if (!batch.frames.length && !outbox.length)
          await new Promise((resolve) => setTimeout(resolve, 1))
      }
    } catch (error) {
      terminalError = errorOf(error)
      for (const pending of requests.values()) {
        clearTimeout(pending.timer)
        pending.reject(errorOf(error))
      }
      requests.clear()
      closed = true
      try {
        await process.kill()
      } catch (cleanupError) {
        terminalError = new AggregateError(
          [error, cleanupError],
          "Node plugin transport and cleanup failed"
        )
      }
    }
  }
  try {
    const i18n = context.i18n as
      | {
          getCurrentLocale?: () => string
          getAvailableLocales?: () => string[]
          getLocaleName?: (locale: string) => string
        }
      | undefined
    const locales = i18n?.getAvailableLocales?.() ?? []
    const permissions = context.permissions as
      { getGrantedPermissions?: () => string[] } | undefined
    const configuration = context.configuration as
      { getAll?: () => Record<string, unknown> } | undefined
    const snapshot = encodeNodePluginValue(
      {
        pluginId: context.pluginId ?? options.pluginId,
        pluginPath: context.pluginPath ?? options.cwd,
        manifest: context.manifest ?? options.manifest ?? {},
        config: context.config ?? configuration?.getAll?.() ?? {},
        capabilities: context.capabilities,
        local: {
          permissions: permissions?.getGrantedPermissions?.() ?? [],
          i18n: i18n
            ? {
                locale: i18n.getCurrentLocale?.() ?? "en",
                locales,
                localeNames: Object.fromEntries(
                  locales.map((locale) => [locale, i18n.getLocaleName?.(locale) ?? locale])
                ),
                messages: getPluginI18nBundle(options.pluginId)?.messages ?? {},
              }
            : undefined,
        },
      },
      () => {
        throw new Error("Node plugin snapshot contains a function")
      }
    )
    const activationRequest = request({ type: "activate", snapshot }, Math.min(timeoutMs, 30_000))
    void pump()
    const frame = await activationRequest
    const activation: NodePluginActivationSnapshot = {
      hooks: reviveNodePluginValue(frame.hooks, invokeCallback, resolveHostHandle),
      exports: reviveNodePluginValue(frame.exports, invokeCallback, resolveHostHandle) as Record<
        string,
        unknown
      >,
    }
    return {
      command: launched.command,
      argv: launched.argv,
      generation: launched.generation,
      process,
      activation,
      invokeCallback,
      async deactivate() {
        if (closed) {
          await process.kill()
          return
        }
        const id = "deactivate"
        const budget = Math.min(timeoutMs, 5_000)
        const completion = request({ type: "deactivate", id }, budget)
        void completion.catch(() => {})
        // The existing native command starts deactivation; the exchange pump
        // continues serving nested calls until its result arrives.
        const queued = outbox.findIndex((frame) => frame.id === id)
        if (queued >= 0) outbox.splice(queued, 1)
        try {
          await bounded(hostInvoker<void>("plugin_deactivate_js", identity), budget, "deactivation")
          await completion
        } catch (error) {
          try {
            await process.kill()
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Node plugin deactivation and cleanup failed"
            )
          }
          throw error
        }
        await process.kill()
      },
    }
  } catch (error) {
    try {
      await process.kill()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Node plugin activation and cleanup failed")
    }
    throw error
  }
}
