/**
 * Paired BYOK utilities use the existing model-turn channel, never an HTTP
 * proxy. Unlike the subscription fallback, this consumes an already resolved
 * provider and sends no chat settings, tools, memory or conversation history.
 */
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import type { SendOptions } from "@cognia/agent-config-types"
import type { ResolvedProvider } from "./provider-consumption"
import type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "@/lib/twin/distill/llm"
import { runAndCaptureAssistantReply } from "@/lib/ai/agent/execution/run-and-capture"
import { withHostUtilitySession } from "./host-utility-session"
import {
  getRemoteExecutionHost,
  isSameExecutionHost,
  subscribeExecutionHost,
} from "./execution-host"

/**
 * Utility model calls follow the machine that executes this client's turns
 * (`./execution-host.ts`): a paired browser or phone, and a desktop driving a
 * remote Host, both run them on that Host.
 */
const log = loggers.ai

export function shouldUseHostLlmClient(): boolean {
  return getRemoteExecutionHost() !== null
}

/**
 * Without HostState admission, a desktop driving a remote Host sends the turn
 * over its pinned execution route, as its own chat does there, and then closes
 * the Host session the send opened. The close is best effort: a lost close
 * must not turn a delivered answer into a failure, and it is only attempted
 * once the send was dispatched (so it reaches the Host that ran it).
 */
async function runOnDesktopRemoteRoute<T>(
  sessionId: string,
  run: (onDispatched: () => void) => Promise<T>
): Promise<T> {
  let dispatched = false
  try {
    return await run(() => {
      dispatched = true
    })
  } finally {
    if (dispatched) {
      const { closeSession } = await import("@/lib/ai/agent/execution/sidecar-client")
      await closeSession(sessionId).catch((error: unknown) => {
        log.warn("Host utility session close failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
}

/**
 * The frozen execution spec every sidecar send carries. A utility call brings
 * its own credentials, which only the AI SDK rail reads, so the runtime is
 * pinned to it whatever the provider; the route is direct because the
 * credentials travel with the request.
 */
async function utilityExecutionSpec(
  sessionId: string,
  provider: ResolvedProvider & { model: string }
): Promise<NonNullable<SendOptions["execution"]>> {
  const [{ resolveAgentExecutionSpec, sendSpecFromResolved }, { getAgentExecutionFlags }, env] =
    await Promise.all([
      import("@/lib/ai/agent/execution/resolve-agent-execution-spec"),
      import("@/lib/ai/agent/execution/feature-flags"),
      import("@/lib/ai/agent/execution/host-environment"),
    ])
  const { spec } = resolveAgentExecutionSpec({
    surface: "agent-executor",
    environment: env.resolveAgentExecutionEnvironment(),
    flags: getAgentExecutionFlags(),
    policy: { executionKind: "agent", runtimePolicy: "ai-sdk", routePolicy: "direct" },
    legacy: { providerId: provider.providerId, modelId: provider.model },
    identity: { sessionId },
  })
  return sendSpecFromResolved(spec)
}

export function createHostLlmClient(
  provider: ResolvedProvider & { model: string },
  featureId: string
): LlmClient {
  const host = getRemoteExecutionHost()
  const assertCurrent = () => {
    if (!host || !isSameExecutionHost(host)) {
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
    const onRouteChange = () => {
      if (!host || !isSameExecutionHost(host)) cancel()
    }
    const unsubscribe = subscribeExecutionHost(onRouteChange)
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
    send.execution = await utilityExecutionSpec(sessionId, provider)
    // Set by the direct route only: told when the turn is handed to the Host.
    let onDispatched: (() => void) | undefined
    const work = async () => {
      const result = await runAndCaptureAssistantReply(sessionId, prompt, send, {
        signal: controller.signal,
        timeoutMs: 30_000,
        beforeSend: async () => {
          assertCurrent()
          controller.signal.throwIfAborted()
          onDispatched?.()
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
    // A paired client's turns need a Host-owned session (ADR-0123). A desktop
    // driving a remote Host takes the same admission when the Host offers it
    // HostState, and its direct route otherwise.
    const direct = () =>
      runOnDesktopRemoteRoute(sessionId, (dispatched) => {
        onDispatched = dispatched
        return work()
      })
    try {
      return await withHostUtilitySession(
        {
          sessionId,
          providerId: provider.providerId,
          model: provider.model,
          assertCurrent,
          signal: controller.signal,
          ...(host?.kind === "desktop-remote" ? { whenUnavailable: direct } : {}),
        },
        work
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
