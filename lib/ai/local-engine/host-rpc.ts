/**
 * The Host's answer to `provider_local_engine_read` / `provider_local_engine_mutate`.
 *
 * A client whose turns run on this Host (a paired browser or phone, a desktop
 * driving this Host) manages the inference engines HERE: the engine URL in its
 * settings (`http://localhost:11434`) means this machine's loopback, the same
 * address the Host's sidecar uses for the client's chat turns. These handlers
 * run the ordinary `LocalProviderService` on this machine, so status, model
 * lists and pulls behave exactly as they do in this machine's own panel.
 *
 * The engine URL is the caller's. It is confined to addresses a local engine
 * can live on (loopback, private and link-local ranges, `.local`, and
 * single-label names such as a container's service name) so the commands cannot
 * be pointed at an arbitrary public endpoint from this Host.
 *
 * A pull outlives its request: Ollama streams progress for the whole download,
 * so `pull` starts a job here and the client polls `pull_status`. Jobs live in
 * memory, are bounded in number and expire some minutes after they settle.
 */

import {
  LOCAL_PROVIDER_NAMES,
  type LocalModelInfo,
  type LocalModelPullProgress,
  type LocalProviderName,
  type LocalServerStatus,
} from "@cognia/provider-types/local-provider"
import {
  checkAllProvidersInstallation,
  createLocalProviderService,
  LocalProviderRequestError,
} from "@cognia/provider-core/providers/local-provider-service"
import { isPrivateOrLinkLocalHostname } from "@cognia/provider-core/providers/catalog-runtime-resolver"
import { probeOllamaModelCapabilities } from "@cognia/provider-core/providers/ollama"
import { LOCAL_PROVIDER_CONFIGS } from "@cognia/provider-core/providers/local-providers"
import type { OllamaModelCapabilities } from "@cognia/provider-types/ollama"

import {
  MAX_CAPABILITY_MODELS,
  type LocalEngineEndpoint,
  type LocalEngineInstallation,
  type LocalEngineMutateResults,
  type LocalEnginePullJob,
  type LocalEngineReadResults,
  type LocalEngineWireError,
  type LocalEngineWireResult,
} from "./protocol"

const PROVIDER_IDS = new Set<string>(LOCAL_PROVIDER_NAMES)
const MAX_MODEL_NAME = 512
const MAX_API_KEY = 4096
const MAX_HEADERS = 32
const MAX_HEADER_VALUE = 4096
const MAX_URL = 2048

/** Pulls running at once on this Host. */
export const MAX_RUNNING_PULLS = 4
/** Jobs kept, running or settled. */
export const MAX_PULL_JOBS = 32
/** How long a settled job stays readable. */
export const SETTLED_PULL_TTL_MS = 15 * 60 * 1000
/**
 * How long a job may run before it stops counting against the pull limit.
 * Ollama cannot cancel a download (it finishes on the engine regardless), so
 * this bounds what the Host tracks, not what the engine does.
 */
export const MAX_PULL_DURATION_MS = 6 * 60 * 60 * 1000

export class LocalEngineRequestInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalEngineRequestInvalidError"
  }
}

function invalid(message: string): never {
  throw new LocalEngineRequestInvalidError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(payload: Record<string, unknown>, key: string, max: number) {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") invalid(`${key} must be a string`)
  if (value.length > max) invalid(`${key} is too long`)
  return value.trim() || undefined
}

function requiredString(payload: Record<string, unknown>, key: string, max: number): string {
  const value = optionalString(payload, key, max)
  if (!value) invalid(`${key} is required`)
  return value
}

function parseProviderId(value: unknown): LocalProviderName {
  if (typeof value !== "string" || !PROVIDER_IDS.has(value)) {
    invalid("providerId is not a local engine")
  }
  return value as LocalProviderName
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** Names private networks use for their machines (container, tailnet, home LAN). */
const LOCAL_NAME_SUFFIXES = [".ts.net", ".lan", ".home.arpa", ".localdomain", ".docker.internal"]

/**
 * Cloud instance metadata services. They sit on link-local / unique-local
 * addresses this check otherwise accepts, and answer with credentials.
 */
function isMetadataAddress(host: string): boolean {
  return host.startsWith("169.254.") || host === "fd00:ec2::254"
}

/** 100.64.0.0/10, the shared address space Tailscale and carrier NATs use. */
function isSharedAddressSpace(host: string): boolean {
  if (!IPV4_RE.test(host)) return false
  const [first, second] = host.split(".").map(Number)
  return first === 100 && second >= 64 && second <= 127
}

/**
 * Hosts a local inference engine can be reached on from this machine:
 * loopback, private and shared address space, mDNS and private-network names
 * (`gpu.local`, `box.tail1234.ts.net`, `host.docker.internal`), and single-label
 * names (`ollama`, `gpu-box`), which cannot name a host on the public
 * internet. Never a cloud metadata address.
 */
export function isLocalEngineHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!host || isMetadataAddress(host)) return false
  if (host === "0.0.0.0" || isPrivateOrLinkLocalHostname(host)) return true
  if (isSharedAddressSpace(host)) return true
  if (host.includes(":")) return false
  if (LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return !host.includes(".") && !IPV4_RE.test(host)
}

/** Validate an engine URL; throws on anything that is not a local engine. */
export function parseLocalEngineBaseUrl(value: string): string {
  if (value.length > MAX_URL) invalid("baseUrl is too long")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid("baseUrl is not a URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid("baseUrl must use http or https")
  }
  if (url.username || url.password) invalid("baseUrl must not carry credentials")
  // The service appends endpoint paths to the base URL as text: a query or a
  // fragment here would turn them into arbitrary paths on the target.
  if (url.search || url.hash || /[?#]/.test(value)) invalid("baseUrl must not carry a query")
  if (!isLocalEngineHostname(url.hostname)) {
    invalid("baseUrl must address a local engine (loopback, LAN or a local host name)")
  }
  return value
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) invalid("customHeaders must be an object")
  const entries = Object.entries(value)
  if (entries.length > MAX_HEADERS) invalid("customHeaders has too many entries")
  const headers: Record<string, string> = {}
  for (const [name, header] of entries) {
    if (typeof header !== "string") invalid("customHeaders values must be strings")
    if (header.length > MAX_HEADER_VALUE) invalid("a customHeaders value is too long")
    headers[name] = header
  }
  return entries.length > 0 ? headers : undefined
}

export function parseLocalEngineEndpoint(payload: Record<string, unknown>): LocalEngineEndpoint {
  const providerId = parseProviderId(payload.providerId)
  const rawBaseUrl = optionalString(payload, "baseUrl", MAX_URL)
  const apiKey = optionalString(payload, "apiKey", MAX_API_KEY)
  const customHeaders = parseHeaders(payload.customHeaders)
  return {
    providerId,
    ...(rawBaseUrl ? { baseUrl: parseLocalEngineBaseUrl(rawBaseUrl) } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(customHeaders ? { customHeaders } : {}),
  }
}

interface InstallationTargets {
  baseUrls: Partial<Record<LocalProviderName, string>>
  /** Engines whose configured URL this Host refuses to probe, with the reason. */
  refused: Partial<Record<LocalProviderName, string>>
}

/**
 * One engine's unusable URL is that engine's answer, not a reason to refuse
 * the scan of the other nine.
 */
function parseInstallationTargets(value: unknown): InstallationTargets {
  const targets: InstallationTargets = { baseUrls: {}, refused: {} }
  if (value === undefined || value === null) return targets
  if (!isRecord(value)) invalid("baseUrls must be an object")
  for (const [id, url] of Object.entries(value)) {
    const providerId = parseProviderId(id)
    if (url === undefined || url === null) continue
    if (typeof url !== "string") invalid("baseUrls values must be strings")
    const trimmed = url.trim()
    if (!trimmed) continue
    try {
      targets.baseUrls[providerId] = parseLocalEngineBaseUrl(trimmed)
    } catch (error) {
      if (!(error instanceof LocalEngineRequestInvalidError)) throw error
      targets.refused[providerId] = error.message
    }
  }
  return targets
}

async function probeInstallations(targets: InstallationTargets) {
  const results = await checkAllProvidersInstallation(targets.baseUrls)
  return results.map((result) => {
    const refused = targets.refused[result.providerId]
    return refused ? { providerId: result.providerId, running: false, error: refused } : result
  })
}

function wireError(error: unknown): LocalEngineWireError {
  if (error instanceof LocalProviderRequestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  return {
    code: "request_failed",
    message: error instanceof Error ? error.message : String(error),
  }
}

async function settle<T>(work: () => Promise<T>): Promise<LocalEngineWireResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    // A malformed request is the caller's bug, not an engine answer.
    if (error instanceof LocalEngineRequestInvalidError) throw error
    return { ok: false, error: wireError(error) }
  }
}

function serviceFor(endpoint: LocalEngineEndpoint) {
  return createLocalProviderService(endpoint.providerId, {
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    customHeaders: endpoint.customHeaders,
  })
}

function parseModelList(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("models must be a list")
  if (value.length > MAX_CAPABILITY_MODELS) invalid("models has too many entries")
  const models = new Set<string>()
  for (const model of value) {
    if (typeof model !== "string" || !model.trim()) invalid("models entries must be names")
    if (model.length > MAX_MODEL_NAME) invalid("a model name is too long")
    models.add(model.trim())
  }
  return [...models]
}

/** Ollama's `/api/show`; the only engine that reports model capabilities. */
async function probeCapabilities(
  baseUrl: string,
  models: string[]
): Promise<Record<string, OllamaModelCapabilities>> {
  const entries = await Promise.all(
    models.map(
      async (model) =>
        [model, sanitizeCapabilities(await probeOllamaModelCapabilities(baseUrl, model))] as const
    )
  )
  return Object.fromEntries(entries)
}

// ── Answer shapes ────────────────────────────────────────────────────────
//
// Engines answer with whatever their JSON holds; the Host's response contract
// is exact. These keep the declared fields with their declared types and drop
// the rest, so one odd engine does not fail the Host's output check.

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown, min = Number.NEGATIVE_INFINITY): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined
}

function int(value: unknown): number | undefined {
  const n = num(value, 0)
  return n === undefined ? undefined : Math.floor(n)
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function sanitizeStatus(status: LocalServerStatus): LocalServerStatus {
  return compact({
    connected: status.connected === true,
    version: str(status.version),
    models_count: int(status.models_count),
    error: str(status.error),
    latency_ms: num(status.latency_ms, 0),
  })
}

export function sanitizeModel(model: LocalModelInfo): LocalModelInfo {
  return compact({
    id: String(model.id),
    object: str(model.object),
    created: num(model.created),
    owned_by: str(model.owned_by),
    size: num(model.size, 0),
    family: str(model.family),
    quantization: str(model.quantization),
    context_length: num(model.context_length, 0),
  })
}

function sanitizeInstallation(result: LocalEngineInstallation): LocalEngineInstallation {
  return compact({
    providerId: result.providerId,
    installed: typeof result.installed === "boolean" ? result.installed : undefined,
    running: result.running === true,
    version: str(result.version),
    error: str(result.error),
  })
}

function sanitizeCapabilities(caps: OllamaModelCapabilities): OllamaModelCapabilities {
  return compact({
    supportsVision: caps.supportsVision === true,
    supportsTools: caps.supportsTools === true,
    supportsEmbedding: caps.supportsEmbedding === true,
    supportsThinking: caps.supportsThinking === true,
    contextLength: int(caps.contextLength),
    architecture: str(caps.architecture),
    inferred: caps.inferred === true,
  })
}

function sanitizeProgress(raw: unknown, model: string): LocalModelPullProgress | undefined {
  if (!isRecord(raw)) return undefined
  const status = str(raw.status)
  if (!status) return undefined
  return compact({
    model,
    status,
    digest: str(raw.digest),
    total: num(raw.total, 0),
    completed: num(raw.completed, 0),
    percentage: num(raw.percentage),
  })
}

// ── Pull jobs ────────────────────────────────────────────────────────────

const jobs = new Map<string, LocalEnginePullJob>()
/** Which engine (kind and URL) each job downloads to; never sent to clients. */
const jobEngines = new Map<string, string>()
/** Each running job's deadline. */
const jobDeadlines = new Map<string, ReturnType<typeof setTimeout>>()

function engineKey(endpoint: LocalEngineEndpoint): string {
  return JSON.stringify([endpoint.providerId, endpoint.baseUrl ?? null])
}

function now(): number {
  return Date.now()
}

function pruneJobs(at: number): void {
  for (const [id, job] of jobs) {
    if (job.state !== "running" && at - job.updatedAt > SETTLED_PULL_TTL_MS) {
      jobs.delete(id)
      jobEngines.delete(id)
    }
  }
  if (jobs.size <= MAX_PULL_JOBS) return
  const settled = [...jobs.values()]
    .filter((job) => job.state !== "running")
    .sort((a, b) => a.updatedAt - b.updatedAt)
  for (const job of settled) {
    if (jobs.size <= MAX_PULL_JOBS) break
    jobs.delete(job.jobId)
    jobEngines.delete(job.jobId)
  }
}

function snapshot(job: LocalEnginePullJob): LocalEnginePullJob {
  return { ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) }
}

async function startPull(
  endpoint: LocalEngineEndpoint,
  model: string
): Promise<LocalEngineMutateResults["pull"]> {
  const service = serviceFor(endpoint)
  if (!service.getCapabilities().canPullModels) return { supported: false }
  const at = now()
  pruneJobs(at)
  const running = [...jobs.values()].filter((job) => job.state === "running")
  // A second request for a download already under way, on the same engine,
  // joins it.
  const engine = engineKey(endpoint)
  const existing = running.find(
    (job) => job.model === model && jobEngines.get(job.jobId) === engine
  )
  if (existing) return { supported: true, job: snapshot(existing) }
  if (running.length >= MAX_RUNNING_PULLS) {
    throw new Error(`Too many model downloads are running on this Host (${MAX_RUNNING_PULLS})`)
  }
  if (jobs.size >= MAX_PULL_JOBS) {
    throw new Error("Too many model downloads are tracked on this Host")
  }
  const job: LocalEnginePullJob = {
    jobId: crypto.randomUUID(),
    providerId: endpoint.providerId,
    model,
    state: "running",
    startedAt: at,
    updatedAt: at,
  }
  jobs.set(job.jobId, job)
  jobEngines.set(job.jobId, engine)
  const deadline = new AbortController()
  const finish = (state: "succeeded" | "failed", error?: string) => {
    if (job.state !== "running") return
    clearTimeout(timer)
    jobDeadlines.delete(job.jobId)
    job.state = state
    job.updatedAt = now()
    if (error) job.error = error
  }
  const timer = setTimeout(() => {
    deadline.abort()
    finish("failed", "The download did not finish in time; the engine may still complete it")
  }, MAX_PULL_DURATION_MS)
  // The deadline alone never keeps a headless Host process alive.
  ;(timer as { unref?: () => void }).unref?.()
  jobDeadlines.set(job.jobId, timer)
  void service
    .pullModel(model, {
      signal: deadline.signal,
      onProgress: (raw) => {
        if (job.state !== "running") return
        // Ollama reports a failed download as a progress line carrying
        // `error` (the fetch-based reader forwards it verbatim).
        const failure = (raw as { error?: unknown }).error
        if (typeof failure === "string" && failure) return finish("failed", failure)
        const progress = sanitizeProgress(raw, model)
        if (!progress) return
        job.progress = progress
        job.updatedAt = now()
      },
    })
    .then(
      (handle) => {
        handle.unsubscribe()
        if (handle.success) finish("succeeded")
        else finish("failed", job.progress?.status ?? "Model download failed")
      },
      (error: unknown) => finish("failed", error instanceof Error ? error.message : String(error))
    )
  return { supported: true, job: snapshot(job) }
}

function readPull(jobId: string): LocalEnginePullJob {
  pruneJobs(now())
  const job = jobs.get(jobId)
  if (!job) throw new Error("Unknown model download")
  return snapshot(job)
}

// ── Commands ─────────────────────────────────────────────────────────────

type ReadAnswer = LocalEngineWireResult<LocalEngineReadResults[keyof LocalEngineReadResults]>
type MutateAnswer = LocalEngineWireResult<LocalEngineMutateResults[keyof LocalEngineMutateResults]>

export async function handleLocalEngineRead(payload: Record<string, unknown>): Promise<ReadAnswer> {
  switch (payload.op) {
    case "status": {
      const endpoint = parseLocalEngineEndpoint(payload)
      return settle(async () => sanitizeStatus(await serviceFor(endpoint).getStatus()))
    }
    case "models": {
      const endpoint = parseLocalEngineEndpoint(payload)
      return settle(async () => (await serviceFor(endpoint).listModels()).map(sanitizeModel))
    }
    case "installation": {
      const targets = parseInstallationTargets(payload.baseUrls)
      return settle(async () => (await probeInstallations(targets)).map(sanitizeInstallation))
    }
    case "capabilities": {
      const rawBaseUrl = optionalString(payload, "baseUrl", MAX_URL)
      const baseUrl = rawBaseUrl
        ? parseLocalEngineBaseUrl(rawBaseUrl)
        : LOCAL_PROVIDER_CONFIGS.ollama.defaultBaseURL
      const models = parseModelList(payload.models)
      return settle(() => probeCapabilities(baseUrl, models))
    }
    case "pull_status": {
      const jobId = requiredString(payload, "jobId", 128)
      return settle(async () => readPull(jobId))
    }
    default:
      return invalid("op is not a local engine read")
  }
}

export async function handleLocalEngineMutate(
  payload: Record<string, unknown>
): Promise<MutateAnswer> {
  const op = payload.op
  if (op !== "pull" && op !== "delete" && op !== "stop") {
    return invalid("op is not a local engine change")
  }
  const endpoint = parseLocalEngineEndpoint(payload)
  const model = requiredString(payload, "model", MAX_MODEL_NAME)
  switch (op) {
    case "pull":
      return settle(() => startPull(endpoint, model))
    case "delete":
      return settle(async () => ({ supported: await serviceFor(endpoint).deleteModel(model) }))
    case "stop":
      return settle(async () => ({ supported: await serviceFor(endpoint).stopModel(model) }))
  }
}

/** Test-only: drop every tracked pull. */
export function __resetLocalEnginePullJobsForTests(): void {
  for (const timer of jobDeadlines.values()) clearTimeout(timer)
  jobDeadlines.clear()
  jobs.clear()
  jobEngines.clear()
}
