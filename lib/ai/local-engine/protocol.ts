/**
 * Wire shapes of the two Host commands that manage a local inference engine on
 * the execution Host (`provider_local_engine_read`, `provider_local_engine_mutate`).
 *
 * The client (`./client.ts`) and the Host's handlers (`./host-rpc.ts`) share
 * these, and the request-schema contract in
 * `scripts/build/companion-request-schema-contracts.mjs` mirrors the request
 * half for the Host's input validation.
 */

import type {
  LocalModelInfo,
  LocalModelPullProgress,
  LocalProviderName,
  LocalServerStatus,
} from "@cognia/provider-types/local-provider"
import type { OllamaModelCapabilities } from "@cognia/provider-types/ollama"
import type { LocalProviderRequestErrorCode } from "@cognia/provider-core/providers/local-provider-service"

export const LOCAL_ENGINE_READ_COMMAND = "provider_local_engine_read"
export const LOCAL_ENGINE_MUTATE_COMMAND = "provider_local_engine_mutate"

/** Models one `capabilities` read may probe. */
export const MAX_CAPABILITY_MODELS = 64

/** The engine the request addresses, as the client's settings describe it. */
export interface LocalEngineEndpoint {
  providerId: LocalProviderName
  /** Omitted: the engine's default URL on the Host. */
  baseUrl?: string
  apiKey?: string
  customHeaders?: Record<string, string>
}

export type LocalEngineReadRequest =
  | ({ op: "status" } & LocalEngineEndpoint)
  | ({ op: "models" } & LocalEngineEndpoint)
  | { op: "installation"; baseUrls?: Partial<Record<LocalProviderName, string>> }
  | { op: "pull_status"; jobId: string }
  | { op: "capabilities"; baseUrl?: string; models: string[] }

export type LocalEngineMutateRequest =
  | ({ op: "pull"; model: string } & LocalEngineEndpoint)
  | ({ op: "delete"; model: string } & LocalEngineEndpoint)
  | ({ op: "stop"; model: string } & LocalEngineEndpoint)

/** A failure the engine reported, carried with its code so the UI can map it. */
export interface LocalEngineWireError {
  /** A `LocalProviderRequestError` code, or `request_failed` for anything else. */
  code: LocalProviderRequestErrorCode | "request_failed"
  message: string
  status?: number
}

export type LocalEngineWireResult<T> =
  { ok: true; value: T } | { ok: false; error: LocalEngineWireError }

export interface LocalEngineInstallation {
  providerId: LocalProviderName
  installed?: boolean
  running: boolean
  version?: string
  error?: string
}

export type LocalEnginePullState = "running" | "succeeded" | "failed"

export interface LocalEnginePullJob {
  jobId: string
  providerId: LocalProviderName
  model: string
  state: LocalEnginePullState
  /** The latest progress line the engine reported, if any. */
  progress?: LocalModelPullProgress
  error?: string
  startedAt: number
  updatedAt: number
}

export interface LocalEngineReadResults {
  status: LocalServerStatus
  models: LocalModelInfo[]
  installation: LocalEngineInstallation[]
  pull_status: LocalEnginePullJob
  /** Ollama `/api/show` answers, keyed by model id. */
  capabilities: Record<string, OllamaModelCapabilities>
}

export interface LocalEngineMutateResults {
  /** The pull runs on the Host; poll `pull_status` with this job. */
  pull: { supported: boolean; job?: LocalEnginePullJob }
  /** `false`: this engine cannot delete models. */
  delete: { supported: boolean }
  /** `false`: this engine cannot unload models. */
  stop: { supported: boolean }
}
