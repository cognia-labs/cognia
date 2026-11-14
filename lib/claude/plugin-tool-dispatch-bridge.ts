/** Shared sidecar tool round-trip for desktop, CLI and the headless brain. */
import { loggers } from "@cognia/logging"
import type { sendPluginToolResponse, subscribePluginToolExec } from "./ipc"
import type { PluginToolExecRequest, PluginToolExecResponse } from "./plugin-tool-ipc"
import type { RemoteExecutionContext } from "./remote-execution"

export interface PluginToolDispatchBridgeDeps {
  sessionId?: string
  subscribe?: typeof subscribePluginToolExec
  handle?: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  send?: typeof sendPluginToolResponse
  prepareRequest?: (request: PluginToolExecRequest) => PluginToolExecRequest
  /** Desktop compatibility check when driving another host. */
  canExecuteRemote?: () => boolean
}

interface DispatchSubscription {
  owners: Set<PluginToolDispatchBridgeDeps>
  ready?: Promise<void>
  unsubscribe?: () => void
  /** Completed ids are bounded; in-flight calls are never evicted. */
  calls: Map<string, boolean>
  inFlight: Map<string, { request: PluginToolExecRequest; controller: AbortController }>
  pending: number
}

// All production owners use the same IPC source. Session-scoped CLI owners
// share its listener with global owners instead of racing to execute a call.
const subscriptions = new Map<typeof subscribePluginToolExec, DispatchSubscription>()
const MAX_COMPLETED_CALLS = 2048

function callKey(request: PluginToolExecRequest): string {
  const context = request.remoteExecutionContext
  return JSON.stringify([
    context?.hostId,
    context?.originDeviceId,
    context?.generation,
    request.sessionId,
    request.toolUseId,
  ])
}

/** Cancel only this session's calls on the named host incarnation (or locally). */
export function abortPluginToolCallsForSession(
  sessionId: string,
  reason: string,
  remoteExecutionContext?: RemoteExecutionContext,
  turnId?: string
): void {
  for (const state of subscriptions.values()) {
    for (const { request, controller } of state.inFlight.values()) {
      const remote = request.remoteExecutionContext
      if (request.sessionId !== sessionId) continue
      if (turnId && request.turnId && request.turnId !== turnId) continue
      if (
        remote?.hostId !== remoteExecutionContext?.hostId ||
        remote?.originDeviceId !== remoteExecutionContext?.originDeviceId ||
        remote?.generation !== remoteExecutionContext?.generation
      )
        continue
      controller.abort(reason)
    }
  }
}

async function execute(
  request: PluginToolExecRequest,
  owner: PluginToolDispatchBridgeDeps,
  controller: AbortController
): Promise<void> {
  const failure = (error: string): PluginToolExecResponse => ({
    type: "plugin_tool_response",
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    error,
  })
  let removeAbortListener: (() => void) | undefined
  let signal = controller.signal
  let response: PluginToolExecResponse | undefined
  try {
    const prepared = owner.prepareRequest?.(request) ?? request
    signal = AbortSignal.any(
      [controller.signal, request.abortSignal, prepared.abortSignal].filter(
        (value): value is AbortSignal => value !== undefined
      )
    )
    const cancelled = new Promise<undefined>((resolve) => {
      const onAbort = () => resolve(undefined)
      signal.addEventListener("abort", onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener("abort", onAbort)
      if (signal.aborted) onAbort()
    })
    const run = async (): Promise<PluginToolExecResponse> => {
      signal.throwIfAborted()
      if (request.remoteExecutionContext && owner.canExecuteRemote?.() === false)
        return failure("REMOTE_FEATURE_UNSUPPORTED: controller tool proxy is not advertised")
      const handle = owner.handle ?? (await import("./plugin-tool-ipc")).handlePluginToolExec
      signal.throwIfAborted()
      return handle({ ...prepared, abortSignal: signal })
    }
    // Release the bridge even when a handler ignores cancellation. Its eventual
    // result is observed by the race but never sent after the signal aborts.
    response = await Promise.race([
      run().catch(() => failure("Plugin tool executor failed")),
      cancelled,
    ])
  } catch {
    // Neither preparation nor execution may reflect private exception text.
    response = failure("Plugin tool executor failed")
  } finally {
    removeAbortListener?.()
  }
  if (!response || signal.aborted) return
  try {
    const send = owner.send ?? (await import("./ipc")).sendPluginToolResponse
    if (!signal.aborted) await send(response, request.remoteExecutionContext)
  } catch {
    loggers.app.error("plugin_tool_response write failed", { toolUseId: request.toolUseId })
  }
}

/** Acquire the process-wide listener; release only this owner's registration. */
export async function subscribePluginToolDispatchBridge(
  deps: PluginToolDispatchBridgeDeps = {}
): Promise<() => void> {
  // IPC can cancel active calls through this module. Resolve the default
  // transport lazily so initialization only goes in one direction.
  const subscribe = deps.subscribe ?? (await import("./ipc")).subscribePluginToolExec
  let subscription = subscriptions.get(subscribe)
  if (!subscription) {
    subscription = { owners: new Set(), calls: new Map(), inFlight: new Map(), pending: 0 }
    subscriptions.set(subscribe, subscription)
  }
  const state = subscription
  // Each acquisition needs its own identity even if the caller reuses deps.
  const owner = { ...deps }
  state.owners.add(owner)

  const forgetIfIdle = () => {
    if (state.owners.size === 0 && state.pending === 0 && subscriptions.get(subscribe) === state) {
      subscriptions.delete(subscribe)
    }
  }

  if (!state.ready) {
    state.ready = Promise.resolve().then(async () => {
      let listening = true
      const unsubscribe = await subscribe((request) => {
        if (!listening) return
        const owners = [...state.owners]
        const selected =
          owners.find((candidate) => candidate.sessionId === request.sessionId) ??
          owners.find((candidate) => !candidate.sessionId)
        if (!selected) return
        const key = callKey(request)
        if (state.calls.has(key)) return
        state.calls.set(key, false)
        const controller = new AbortController()
        state.inFlight.set(key, { request, controller })
        state.pending += 1
        void execute(request, selected, controller).finally(() => {
          state.inFlight.delete(key)
          state.pending -= 1
          state.calls.set(key, true)
          for (const [completedKey, completed] of state.calls) {
            if (state.calls.size - state.pending <= MAX_COMPLETED_CALLS) break
            if (completed) state.calls.delete(completedKey)
          }
          forgetIfIdle()
        })
      })
      state.unsubscribe = () => {
        listening = false
        unsubscribe()
      }
    })
  }
  try {
    await state.ready
  } catch (error) {
    state.owners.delete(owner)
    state.ready = undefined
    forgetIfIdle()
    throw error
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    state.owners.delete(owner)
    if (state.owners.size > 0) return
    try {
      state.unsubscribe?.()
    } finally {
      state.unsubscribe = undefined
      state.ready = undefined
      // Retain claims while tools drain, including across a quick remount.
      forgetIfIdle()
    }
  }
}
