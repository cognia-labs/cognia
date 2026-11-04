/**
 * Paired BYOK utilities use the existing model-turn channel, never an HTTP
 * proxy. Unlike the subscription fallback, this consumes an already resolved
 * provider and sends no chat settings, tools, memory or conversation history.
 */
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { SendOptions } from "@cognia/agent-config-types"
import type { ResolvedProvider } from "./provider-consumption"
import type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "@/lib/twin/distill/llm"
import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { withHostUtilitySession } from "./host-utility-session"

export function shouldUseHostLlmClient(): boolean {
  const active = getActiveRuntimeTargetContext()
  const config = loadCompanionConfig()
  return !isTauri() && !!active && !!config?.deviceId && config.targetId === active.targetId
}

function hostScopeKey(): string {
  const config = loadCompanionConfig()
  return JSON.stringify([
    getRuntimeTargetScopeKey(),
    config?.deviceId,
    config?.deviceKeyThumbprint,
    config?.baseUrl,
    config?.serverFingerprint,
  ])
}

export function createHostLlmClient(
  provider: ResolvedProvider & { model: string },
  featureId: string
): LlmClient {
  const scope = hostScopeKey()
  const assertCurrent = () => {
    if (!shouldUseHostLlmClient() || hostScopeKey() !== scope) {
      throw new Error("Host connection changed during the utility request")
    }
  }
  const usage: LlmUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const run = async (
    prompt: string,
    options?: LlmClientCallOptions,
    onPartial?: (text: string) => void
  ) => {
    assertCurrent()
    options?.abortSignal?.throwIfAborted()
    if (!hasNoLeakingPiiDeep({ prompt, system: options?.system })) {
      throw new Error("Utility prompt rejected by the PII gate")
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const unsubscribe = subscribeRuntimeTargetContext(() => {
      if (hostScopeKey() !== scope) cancel()
    })
    options?.abortSignal?.addEventListener("abort", cancel, { once: true })
    const sessionId = `utility-${crypto.randomUUID()}`
    const send: SendOptions = {
      provider: provider.providerId,
      model: provider.model,
      providerCredentials: {
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        protocol: provider.protocol,
        apiFlavor: provider.apiFlavor,
        headers: provider.headers,
      },
      systemPrompt: options?.system,
      toolSurface: "none",
      allowedTools: [],
      mcpServers: {},
      maxTurns: 1,
      permissionMode: "dontAsk",
      // No history to summarize: a metered utility must never launch an
      // additional compaction request outside its caller's reservation.
      compaction: { enabled: false },
      modelParams: {
        maxOutputTokens: options?.maxTokens ?? 512,
        temperature: options?.temperature ?? 0,
        // Retry belongs to the utility caller (or its budget ledger), never
        // to an additional hidden Host retry loop.
        maxRetries: options?.maxRetries ?? 0,
        ...(options?.stopSequences ? { stopSequences: options.stopSequences } : {}),
      },
    }
    try {
      return await withHostUtilitySession(
        {
          sessionId,
          providerId: provider.providerId,
          model: provider.model,
          assertCurrent,
          signal: controller.signal,
        },
        async () => {
          const result = await runAndCaptureAssistantReply(sessionId, prompt, send, {
            signal: controller.signal,
            timeoutMs: 30_000,
            beforeSend: async () => {
              assertCurrent()
              controller.signal.throwIfAborted()
            },
            execution: { kind: "subagent", label: featureId },
            ...(onPartial
              ? {
                  onPartial: (text: string) => {
                    assertCurrent()
                    onPartial(text)
                  },
                }
              : {}),
          })
          assertCurrent()
          controller.signal.throwIfAborted()
          if (result.resultSubtype && result.resultSubtype !== "success") {
            throw new Error(`Host utility request failed (${result.resultSubtype})`)
          }
          const delta = {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            cacheReadTokens: result.usage?.cacheReadInputTokens ?? 0,
            cacheCreationTokens: result.usage?.cacheCreationInputTokens ?? 0,
          }
          usage.inputTokens += delta.inputTokens
          usage.outputTokens += delta.outputTokens
          usage.totalTokens = usage.inputTokens + usage.outputTokens
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + delta.cacheReadTokens
          usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + delta.cacheCreationTokens
          options?.onUsage?.(delta)
          return result.text
        }
      )
    } finally {
      unsubscribe()
      options?.abortSignal?.removeEventListener("abort", cancel)
    }
  }
  return {
    provider: provider.providerId,
    model: provider.model,
    reportsCallUsage: true,
    complete: (prompt, options) => run(prompt, options),
    // Loaded on first stream: the headless turn client reaches build-options,
    // whose workflow imports lead back to the renderer rail that imports this.
    stream: async function* (prompt, options) {
      const { deltasFromRunningTotal } = await import("./headless-turn-llm-client")
      yield* deltasFromRunningTotal((onPartial) => run(prompt, options, onPartial))
    },
    getUsageSnapshot: () => ({ ...usage }),
  }
}
