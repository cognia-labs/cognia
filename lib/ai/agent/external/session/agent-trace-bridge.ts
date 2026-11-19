/**
 * Agent-Trace Bridge — wires the external-agent manager's lifecycle into
 * the cognia-next agent-trace emitter.
 *
 * The external-agent manager (ACP / etc.) calls these 4 hooks across a
 * teammate run. Each bridge instance owns one `invoke_agent` span with
 * `surface = "agent-team"`. Mid-run events become `recordEvent` calls; the
 * terminal call (`onComplete` / `onError`) finalises the span.
 *
 * Multiple ExternalAgentTraceBridge instances may be created per turn (one
 * per dispatched teammate); each is independent. The bridge swallows all
 * exceptions — instrumented call sites must never see an error from this
 * file.
 */

import {
  endSpan,
  recordEvent,
  startSpan,
  type EndSpanInput,
  type SpanHandle,
} from "@cognia/agent-trace/emitter"
import { costFromTokensUsd, resolveModelPricingUsd } from "@/lib/usage/pricing"
import { externalTokenUsageToUsageInfo } from "@/lib/usage/usage-info"
import type { SpanProviderName, SpanUsage } from "@/types/agent-trace/span"

export interface ExternalAgentTraceBridgeOptions {
  sessionId: string
  turnId?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  tracestate?: string
  modelId?: string
  agentId: string
  agentName?: string
  /** Wire protocol name (acp / a2a / ...). Routes to a span provider name. */
  protocol?: string
  transport?: string
  acpSessionId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface ExternalAgentTraceBridge {
  onStart(prompt: unknown): Promise<void>
  onEvent(event: unknown): Promise<void>
  onComplete(result: unknown): Promise<void>
  onError(error: unknown, context?: unknown): Promise<void>
}

const NO_HANDLE: SpanHandle = { spanId: "", traceId: "" }

export function createExternalAgentTraceBridge(
  options: ExternalAgentTraceBridgeOptions
): ExternalAgentTraceBridge {
  let handle: SpanHandle = NO_HANDLE
  let finished = false
  const streamedResult: Record<string, unknown> = {}
  let streamedText = ""

  const providerName = providerFromProtocol(options.protocol)
  const handoff = options.parentSpanId
    ? { fromAgent: "leader", toAgent: options.agentId }
    : undefined

  return {
    async onStart(prompt: unknown) {
      try {
        const merged: Record<string, unknown> = { ...(options.metadata ?? {}) }
        if (options.turnId) merged.turnId = options.turnId
        if (options.protocol) merged.protocol = options.protocol
        if (options.transport) merged.transport = options.transport
        if (options.acpSessionId) merged.acpSessionId = options.acpSessionId
        if (options.tracestate) merged.tracestate = options.tracestate
        if (options.tags && options.tags.length > 0) merged.tags = options.tags

        handle = startSpan({
          operationName: "invoke_agent",
          providerName,
          sessionId: options.sessionId,
          turnId: options.turnId,
          surface: "agent-team",
          traceId: options.traceId,
          parentSpanId: options.parentSpanId,
          spanId: options.spanId,
          requestModel: options.modelId,
          agentId: options.agentId,
          agentName: options.agentName,
          handoff,
          inputPreview: coerceToPreview(prompt),
          metadata: Object.keys(merged).length > 0 ? merged : undefined,
        })
      } catch {
        // bridge contract: never throw back into the caller
      }
    },

    async onEvent(event: unknown) {
      try {
        if (!handle.spanId) return
        if (isPlainObject(event)) {
          if (event.tokenUsage) streamedResult.tokenUsage = event.tokenUsage
          if (event.type === "done") {
            if (typeof event.success === "boolean") streamedResult.success = event.success
            if (typeof event.stopReason === "string") streamedResult.finishReason = event.stopReason
          }
          if (event.type === "error") {
            streamedResult.success = false
            streamedResult.error = event.error
          }
          const delta = event.delta
          if (
            event.type === "message_delta" &&
            isPlainObject(delta) &&
            delta.type === "text" &&
            typeof delta.text === "string"
          ) {
            streamedText = (streamedText + delta.text).slice(0, 4096)
          }
        }
        const attributes = isPlainObject(event) ? event : { value: event }
        const name = pickEventName(event) ?? "external_event"
        recordEvent(handle.spanId, {
          name,
          at: Date.now(),
          attributes,
        })
      } catch {
        // bridge contract
      }
    },

    async onComplete(result: unknown) {
      try {
        if (!handle.spanId || finished) return
        finished = true
        endSpan(
          handle.spanId,
          buildCompletionInput(
            {
              ...streamedResult,
              ...(isPlainObject(result) ? result : {}),
              tokenUsage:
                isPlainObject(result) && standardUsageOf(result.tokenUsage)
                  ? result.tokenUsage
                  : streamedResult.tokenUsage,
              finalResponse: pickOutputText(result) || streamedText || undefined,
            },
            {
              fallbackModelId: options.modelId,
              pricingProviderId: pricingProviderFromProtocol(options.protocol),
            }
          )
        )
      } catch {
        // bridge contract
      }
    },

    async onError(error: unknown, context?: unknown) {
      try {
        if (!handle.spanId || finished) return
        finished = true
        const errMsg = stringifyError(error)
        const ctxMeta = isPlainObject(context) ? { context } : undefined
        endSpan(handle.spanId, {
          ...buildCompletionInput(
            { ...streamedResult, finalResponse: streamedText },
            {
              fallbackModelId: options.modelId,
              pricingProviderId: pricingProviderFromProtocol(options.protocol),
            }
          ),
          errorType: "external_agent_error",
          errorMessage: errMsg,
          metadata: ctxMeta,
        })
      } catch {
        // bridge contract
      }
    },
  }
}

function providerFromProtocol(protocol: string | undefined): SpanProviderName {
  // Anything that isn't an explicit Anthropic protocol is treated as a
  // cognia-side teammate run. Future expansion (openai protocol etc.) can
  // map here.
  if (protocol === "anthropic" || protocol === "claude") return "anthropic"
  return "cognia.team"
}

function pricingProviderFromProtocol(protocol: string | undefined): string | undefined {
  if (protocol === "anthropic" || protocol === "claude") return "anthropic"
  if (protocol && protocol !== "acp" && protocol !== "a2a") return protocol
  return undefined
}

function buildCompletionInput(
  result: unknown,
  context: { fallbackModelId?: string; pricingProviderId?: string } = {}
): EndSpanInput {
  const out: EndSpanInput = {}
  if (!isPlainObject(result)) return out

  if (result.success === false || result.is_error === true) {
    out.errorType = "external_agent_error"
    out.errorMessage =
      typeof result.error === "string" ? result.error : "External agent execution failed"
  }

  const usage = extractUsageLike(result)
  if (usage) out.usage = usage

  const finishRaw =
    (result as Record<string, unknown>).finish_reason ??
    (result as Record<string, unknown>).finishReason
  if (typeof finishRaw === "string" && finishRaw.length > 0) {
    out.finishReasons = [finishRaw]
  } else if (Array.isArray(finishRaw)) {
    const filtered = finishRaw.filter((f): f is string => typeof f === "string")
    if (filtered.length > 0) out.finishReasons = filtered
  }

  const modelRaw =
    (result as Record<string, unknown>).model ?? (result as Record<string, unknown>).response_model
  if (typeof modelRaw === "string" && modelRaw.length > 0) {
    out.responseModel = modelRaw
  }

  const standardUsage = standardUsageOf(result.tokenUsage)
  const costRaw = result.total_cost_usd ?? standardUsage?.totalCostUsd
  if (typeof costRaw === "number" && Number.isFinite(costRaw)) {
    out.costUsdEstimate = costRaw
  } else if (usage && !isPlainObject(result.tokenUsage)) {
    const modelId = out.responseModel ?? context.fallbackModelId
    const pricing = resolveModelPricingUsd(context.pricingProviderId, modelId)
    const fallbackCost = costFromTokensUsd(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadTokens,
        cacheCreationInputTokens: usage.cacheCreationTokens,
      },
      pricing
    )
    if (fallbackCost > 0) out.costUsdEstimate = fallbackCost
  }

  const outputText = pickOutputText(result)
  if (outputText) out.outputPreview = outputText

  return out
}

function extractUsageLike(result: Record<string, unknown>): SpanUsage | undefined {
  const standard = standardUsageOf(result.tokenUsage)
  if (standard) {
    const usage = {
      inputTokens: standard.inputTokens ?? 0,
      outputTokens: standard.outputTokens ?? 0,
      cacheCreationTokens: standard.cacheCreationInputTokens ?? 0,
      cacheReadTokens: standard.cacheReadInputTokens ?? 0,
    }
    return Object.values(usage).some((value) => value > 0) ? usage : undefined
  }
  const direct = isPlainObject(result.usage) ? result.usage : undefined
  const nested =
    !direct && isPlainObject(result.message) && isPlainObject(result.message.usage)
      ? result.message.usage
      : undefined
  const raw = direct ?? nested
  if (!raw) return undefined

  const num = (k: string): number => {
    const v = raw[k]
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  }
  const usage: SpanUsage = {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheCreationTokens: num("cache_creation_input_tokens"),
    cacheReadTokens: num("cache_read_input_tokens"),
  }
  // Drop the block entirely if everything is zero AND nothing was reported.
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    usage.cacheReadTokens === 0
  ) {
    return undefined
  }
  return usage
}

function pickOutputText(result: unknown): string | undefined {
  if (typeof result === "string") return result
  if (!isPlainObject(result)) return undefined
  const direct = result.finalResponse || result.result || result.output || result.text
  if (typeof direct === "string") return direct
  return undefined
}

function standardUsageOf(
  value: unknown
): ReturnType<typeof externalTokenUsageToUsageInfo> | undefined {
  if (!isPlainObject(value)) return undefined
  if (
    ![value.promptTokens, value.completionTokens, value.totalTokens].every(
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0
    )
  )
    return undefined
  return externalTokenUsageToUsageInfo(
    value as unknown as Parameters<typeof externalTokenUsageToUsageInfo>[0]
  )
}

function pickEventName(event: unknown): string | undefined {
  if (!isPlainObject(event)) return undefined
  const raw = event.type ?? event.name ?? event.event
  return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function coerceToPreview(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  if (Array.isArray(value)) {
    const text = value
      .map((v) =>
        typeof v === "string" ? v : isPlainObject(v) && typeof v.text === "string" ? v.text : ""
      )
      .filter(Boolean)
      .join("\n")
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (isPlainObject(error)) {
    const m = error.message
    if (typeof m === "string") return m
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
