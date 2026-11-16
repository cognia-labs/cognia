import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import {
  isFeatureCallEvent,
  type ClaudeEvent,
  type FeatureCallCredentials,
  type FeatureCallEvent,
  type FeatureCallRequest,
  type ToolHostControl,
} from "@cognia/agent-config-types"

import { transport } from "@/lib/tauri"

const SIDECAR_EVENT = "claude://message"

interface FeatureCallDependencies {
  call: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  /**
   * Returns the unsubscribe handle, synchronously or not: the real
   * `transport.subscribe` is sync (`() => void`, see `lib/tauri/transport-types.ts`)
   * while the tests inject an async one. `ensureListener` awaits the result
   * either way, so both are correct — the union is what makes the declared
   * contract match reality.
   */
  subscribe: (
    event: string,
    handler: (event: ClaudeEvent) => void
  ) => (() => void) | Promise<() => void>
  randomUUID: () => string
}

export interface SidecarLanguageModelConfig {
  modelId: string
  providerId?: string
  credentials: FeatureCallCredentials
  protocolAdapterSpec?: FeatureCallRequest["protocolAdapterSpec"]
}

export type SidecarEmbeddingModelConfig = SidecarLanguageModelConfig

interface PendingResult {
  kind: "result"
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

interface PendingStream {
  kind: "stream"
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
}

type Pending = PendingResult | PendingStream

function serializableOptions(options: LanguageModelV3CallOptions): Record<string, unknown> {
  const { abortSignal: _abortSignal, ...rest } = options
  return rest as Record<string, unknown>
}

function abortError(): DOMException {
  return new DOMException("Feature call aborted", "AbortError")
}

export function createSidecarFeatureCallClient(deps: FeatureCallDependencies) {
  const pending = new Map<string, Pending>()
  let listener: (() => void) | Promise<() => void> | undefined
  let disposed: Error | undefined

  function settle(event: FeatureCallEvent) {
    const entry = pending.get(event.requestId)
    if (!entry) return
    if (event.type === "feature_call_stream" && entry.kind === "stream") {
      entry.controller.enqueue(event.part as LanguageModelV3StreamPart)
      return
    }
    pending.delete(event.requestId)
    if (event.type === "feature_call_result" && entry.kind === "result") {
      entry.resolve(event.result as LanguageModelV3GenerateResult)
      return
    }
    if (entry.kind === "stream") {
      if (event.type === "feature_call_stream_end") entry.controller.close()
      else if (event.type === "feature_call_aborted") entry.controller.error(abortError())
      else if (event.type === "feature_call_error") entry.controller.error(new Error(event.error))
      return
    }
    if (event.type === "feature_call_aborted") entry.reject(abortError())
    else if (event.type === "feature_call_error") entry.reject(new Error(event.error))
  }

  async function ensureListener() {
    if (disposed) throw disposed
    listener ??= deps.subscribe(SIDECAR_EVENT, (event) => {
      if (isFeatureCallEvent(event)) settle(event)
    })
    await listener
    if (disposed) throw disposed
  }

  async function sendAbort(requestId: string) {
    await deps.call("claude_feature_abort", { requestId })
  }

  async function requestResult(
    request: Omit<FeatureCallRequest, "requestId">,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    await ensureListener()
    const requestId = deps.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { kind: "result", resolve, reject })
    })
    const onAbort = () => void sendAbort(requestId)
    abortSignal?.addEventListener("abort", onAbort, { once: true })
    try {
      const [, value] = await Promise.all([
        deps.call("claude_feature_call", { request: { ...request, requestId } }),
        result,
      ])
      return value
    } catch (error) {
      pending.delete(requestId)
      throw error
    } finally {
      abortSignal?.removeEventListener("abort", onAbort)
    }
  }

  function languageModel(config: SidecarLanguageModelConfig): LanguageModelV3 {
    const base = {
      specificationVersion: "v3" as const,
      provider: "amazon-bedrock.sidecar",
      modelId: config.modelId,
      supportedUrls: {},
    }

    return {
      ...base,
      async doGenerate(options) {
        const request: Omit<FeatureCallRequest, "requestId"> = {
          operation: "language-generate",
          providerId: config.providerId ?? "bedrock",
          model: config.modelId,
          credentials: config.credentials,
          ...(config.protocolAdapterSpec
            ? { protocolAdapterSpec: config.protocolAdapterSpec }
            : {}),
          options: serializableOptions(options),
        }
        return (await requestResult(request, options.abortSignal)) as LanguageModelV3GenerateResult
      },
      async doStream(options) {
        await ensureListener()
        const requestId = deps.randomUUID()
        const stream = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            pending.set(requestId, { kind: "stream", controller })
          },
          cancel() {
            pending.delete(requestId)
            return sendAbort(requestId)
          },
        })
        const onAbort = () => {
          void sendAbort(requestId)
        }
        options.abortSignal?.addEventListener("abort", onAbort, { once: true })
        const request: FeatureCallRequest = {
          requestId,
          operation: "language-stream",
          providerId: config.providerId ?? "bedrock",
          model: config.modelId,
          credentials: config.credentials,
          ...(config.protocolAdapterSpec
            ? { protocolAdapterSpec: config.protocolAdapterSpec }
            : {}),
          options: serializableOptions(options),
        }
        try {
          await deps.call("claude_feature_call", { request })
        } catch (error) {
          const entry = pending.get(requestId)
          pending.delete(requestId)
          if (entry?.kind === "stream") entry.controller.error(error)
          throw error
        }
        return { stream }
      },
    }
  }

  function embeddingModel(config: SidecarEmbeddingModelConfig): EmbeddingModelV3 {
    return {
      specificationVersion: "v3",
      provider: "amazon-bedrock.sidecar",
      modelId: config.modelId,
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed(options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
        return (await requestResult(
          {
            operation: "embedding",
            providerId: config.providerId ?? "bedrock",
            model: config.modelId,
            credentials: config.credentials,
            options: options as unknown as Record<string, unknown>,
          },
          options.abortSignal
        )) as EmbeddingModelV3Result
      },
    }
  }

  function dispose(error = new Error("Feature call Host disconnected")) {
    if (disposed) return
    disposed = error
    for (const entry of pending.values()) {
      if (entry.kind === "result") entry.reject(error)
      else entry.controller.error(error)
    }
    pending.clear()
    if (listener)
      void Promise.resolve(listener)
        .then((off) => off())
        .catch(() => undefined)
  }

  return { languageModel, embeddingModel, requestResult, dispose }
}

/**
 * The process-wide feature-call client. Model adapters, discovery calls and
 * tool-host control share its one correlated listener.
 */
export const defaultClient = createSidecarFeatureCallClient({
  call: (command, args) => transport.call(command, args),
  subscribe: (event, handler) => transport.subscribe(event, handler),
  randomUUID: () => crypto.randomUUID(),
})

/** Reuse the existing trusted feature IPC for session-owned external tool hosts. */
export function callSidecarToolHost(
  operation: "tool-host-start" | "tool-host-stop" | "tool-host-reply",
  toolHost: ToolHostControl,
  requestResult = defaultClient.requestResult
): Promise<unknown> {
  return requestResult({ operation, credentials: {}, toolHost })
}
