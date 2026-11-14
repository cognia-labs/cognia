/**
 * The local inference engine panel's client: the machine that executes this
 * client's turns is the machine whose engines it manages.
 *
 * - This device executes its own turns: the ordinary `LocalProviderService`
 *   (provider-core), which reaches the engine through this device's proxy.
 * - A Host executes them (`../execution-host.ts`): the two Host commands
 *   answered by `./host-rpc.ts` on that Host, so `http://localhost:11434`
 *   is the Host's Ollama, the one the Host's sidecar uses for chat.
 *
 * Both sides expose the same shape, so the hook and the settings panels do not
 * branch. A request built for one Host never lands on another: every Host
 * answer is checked against the route it was sent on.
 */

import type {
  LocalModelInfo,
  LocalProviderName,
  LocalServerStatus,
} from "@cognia/provider-types/local-provider"
import {
  createLocalProviderService,
  checkAllProvidersInstallation,
  getProviderCapabilities,
  LocalProviderRequestError,
  type LocalProviderCapabilities,
  type LocalProviderRequestOptions,
  type ModelPullOptions,
} from "@cognia/provider-core/providers/local-provider-service"

import type { OllamaModelCapabilities } from "@cognia/provider-types/ollama"
import { probeOllamaModelCapabilities } from "@cognia/provider-core/providers/ollama"

import {
  getRemoteExecutionHost,
  isSameExecutionHost,
  type RemoteExecutionHost,
} from "../execution-host"
import {
  LOCAL_ENGINE_MUTATE_COMMAND,
  LOCAL_ENGINE_READ_COMMAND,
  MAX_CAPABILITY_MODELS,
  type LocalEngineInstallation,
  type LocalEngineMutateRequest,
  type LocalEngineMutateResults,
  type LocalEnginePullJob,
  type LocalEngineReadRequest,
  type LocalEngineReadResults,
  type LocalEngineWireResult,
} from "./protocol"

/** How often a Host pull's progress is read. */
export const HOST_PULL_POLL_MS = 1_000

export type LocalEngineTarget =
  { kind: "this-device" } | { kind: "host"; label: string | undefined; scopeKey: string }

const THIS_DEVICE_TARGET: LocalEngineTarget = Object.freeze({ kind: "this-device" })
let cachedHostTarget: Extract<LocalEngineTarget, { kind: "host" }> | null = null

/**
 * Which machine's engines the panel manages right now. The same route returns
 * the same object, so React can hold it as an external-store snapshot.
 */
export function getLocalEngineTarget(): LocalEngineTarget {
  const host = getRemoteExecutionHost()
  if (!host) return THIS_DEVICE_TARGET
  if (cachedHostTarget?.scopeKey !== host.scopeKey || cachedHostTarget.label !== host.label) {
    cachedHostTarget = Object.freeze({ kind: "host", label: host.label, scopeKey: host.scopeKey })
  }
  return cachedHostTarget
}

/** The server-render snapshot: nothing is paired before hydration. */
export function getThisDeviceLocalEngineTarget(): LocalEngineTarget {
  return THIS_DEVICE_TARGET
}

/** A key that changes whenever the managed machine does. */
export function localEngineTargetKey(target: LocalEngineTarget): string {
  return target.kind === "host" ? target.scopeKey : "this-device"
}

export interface LocalEnginePullHandle {
  success: boolean
  /** Stop reporting progress. The download itself keeps running. */
  unsubscribe: () => void
}

export interface LocalEngineClient {
  readonly target: LocalEngineTarget
  getCapabilities(): LocalProviderCapabilities
  getStatus(): Promise<LocalServerStatus>
  listModels(): Promise<LocalModelInfo[]>
  pullModel(modelName: string, options?: ModelPullOptions): Promise<LocalEnginePullHandle>
  deleteModel(modelName: string): Promise<boolean>
  stopModel(modelName: string): Promise<boolean>
}

export class LocalEngineHostChangedError extends Error {
  constructor() {
    super("Host connection changed during the local engine request")
    this.name = "LocalEngineHostChangedError"
  }
}

function unwrap<T>(result: LocalEngineWireResult<T>): T {
  if (result.ok) return result.value
  const { code, message, status } = result.error
  if (code === "request_failed") throw new Error(message)
  throw new LocalProviderRequestError(code, message, status)
}

function isWireResult(value: unknown): value is LocalEngineWireResult<unknown> {
  if (typeof value !== "object" || value === null) return false
  const record = value as { ok?: unknown; error?: unknown }
  if (record.ok === true) return "value" in record
  return record.ok === false && typeof record.error === "object" && record.error !== null
}

async function callHost<T>(
  host: RemoteExecutionHost,
  command: string,
  payload: object
): Promise<T> {
  if (!isSameExecutionHost(host)) throw new LocalEngineHostChangedError()
  const result = await host.transport.call<unknown>(command, payload as Record<string, unknown>)
  if (!isSameExecutionHost(host)) throw new LocalEngineHostChangedError()
  if (!isWireResult(result)) throw new Error("The Host returned an invalid local engine answer")
  return unwrap(result as LocalEngineWireResult<T>)
}

function readHost<K extends LocalEngineReadRequest["op"]>(
  host: RemoteExecutionHost,
  request: Extract<LocalEngineReadRequest, { op: K }>
): Promise<LocalEngineReadResults[K]> {
  return callHost(host, LOCAL_ENGINE_READ_COMMAND, request)
}

function mutateHost<K extends LocalEngineMutateRequest["op"]>(
  host: RemoteExecutionHost,
  request: Extract<LocalEngineMutateRequest, { op: K }>
): Promise<LocalEngineMutateResults[K]> {
  return callHost(host, LOCAL_ENGINE_MUTATE_COMMAND, request)
}

function endpointOf(providerId: LocalProviderName, options: LocalProviderRequestOptions) {
  const baseUrl = options.baseUrl?.trim()
  const apiKey = options.apiKey?.trim()
  return {
    providerId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(options.customHeaders && Object.keys(options.customHeaders).length > 0
      ? { customHeaders: options.customHeaders }
      : {}),
  }
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

function createHostClient(
  host: RemoteExecutionHost,
  providerId: LocalProviderName,
  options: LocalProviderRequestOptions
): LocalEngineClient {
  const endpoint = endpointOf(providerId, options)
  return {
    target: getLocalEngineTarget(),
    getCapabilities: () => getProviderCapabilities(providerId),
    // The local service reports an unreachable engine as a status, never a
    // throw; an unreachable Host reads the same way here.
    getStatus: async () => {
      try {
        return await readHost(host, { op: "status", ...endpoint })
      } catch (error) {
        if (error instanceof LocalEngineHostChangedError) throw error
        return {
          connected: false,
          error: error instanceof Error ? error.message : "Connection failed",
        }
      }
    },
    listModels: () => readHost(host, { op: "models", ...endpoint }),
    deleteModel: async (model) =>
      (await mutateHost(host, { op: "delete", model, ...endpoint })).supported,
    stopModel: async (model) =>
      (await mutateHost(host, { op: "stop", model, ...endpoint })).supported,
    pullModel: async (model, pullOptions) => {
      const started = await mutateHost(host, { op: "pull", model, ...endpoint })
      if (!started.supported || !started.job) return { success: false, unsubscribe: () => {} }
      const detach = new AbortController()
      const unsubscribe = () => detach.abort()
      const onAbort = () => detach.abort()
      pullOptions?.signal?.addEventListener("abort", onAbort, { once: true })
      if (pullOptions?.signal?.aborted) detach.abort()
      let job: LocalEnginePullJob = started.job
      let lastUpdate = -1
      try {
        for (;;) {
          if (job.progress && job.updatedAt !== lastUpdate) {
            lastUpdate = job.updatedAt
            pullOptions?.onProgress?.({ ...job.progress, model })
          }
          if (job.state !== "running") break
          // Detaching stops reporting; the Host keeps downloading, as Ollama
          // does for this device's own pulls.
          if (detach.signal.aborted) return { success: false, unsubscribe }
          await waitFor(HOST_PULL_POLL_MS, detach.signal)
          if (detach.signal.aborted) return { success: false, unsubscribe }
          job = await readHost(host, { op: "pull_status", jobId: job.jobId })
        }
        if (job.state === "failed" && job.error) throw new Error(job.error)
        return { success: job.state === "succeeded", unsubscribe }
      } finally {
        pullOptions?.signal?.removeEventListener("abort", onAbort)
      }
    },
  }
}

function createDeviceClient(
  providerId: LocalProviderName,
  options: LocalProviderRequestOptions
): LocalEngineClient {
  const service = createLocalProviderService(providerId, options)
  return {
    target: THIS_DEVICE_TARGET,
    getCapabilities: () => service.getCapabilities(),
    getStatus: () => service.getStatus(),
    listModels: () => service.listModels(),
    pullModel: (model, pullOptions) => service.pullModel(model, pullOptions),
    deleteModel: (model) => service.deleteModel(model),
    stopModel: (model) => service.stopModel(model),
  }
}

/** A client for one engine on the machine that executes this client's turns. */
export function createLocalEngineClient(
  providerId: LocalProviderName,
  options: LocalProviderRequestOptions = {}
): LocalEngineClient {
  const host = getRemoteExecutionHost()
  return host
    ? createHostClient(host, providerId, options)
    : createDeviceClient(providerId, options)
}

/**
 * Ollama model capabilities (`/api/show`) from the machine that executes this
 * client's turns, keyed by model id.
 */
export async function probeLocalEngineModelCapabilities(
  baseUrl: string,
  models: string[]
): Promise<Map<string, OllamaModelCapabilities>> {
  const host = getRemoteExecutionHost()
  if (!host) {
    const entries = await Promise.all(
      models.map(async (id) => [id, await probeOllamaModelCapabilities(baseUrl, id)] as const)
    )
    return new Map(entries)
  }
  const answers: Record<string, OllamaModelCapabilities> = {}
  for (let start = 0; start < models.length; start += MAX_CAPABILITY_MODELS) {
    const batch = models.slice(start, start + MAX_CAPABILITY_MODELS)
    Object.assign(answers, await readHost(host, { op: "capabilities", baseUrl, models: batch }))
  }
  return new Map(Object.entries(answers))
}

/** Probe every engine kind on the machine that executes this client's turns. */
export async function checkLocalEngineInstallations(
  baseUrls?: Partial<Record<LocalProviderName, string | undefined>>
): Promise<LocalEngineInstallation[]> {
  const host = getRemoteExecutionHost()
  if (!host) return checkAllProvidersInstallation(baseUrls)
  const defined = Object.fromEntries(
    Object.entries(baseUrls ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()
    )
  ) as Partial<Record<LocalProviderName, string>>
  return readHost(host, { op: "installation", baseUrls: defined })
}
