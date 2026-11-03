import type { ExternalAgentMessage } from "@/types/agent/external-agent"

import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  assertSafeModelInput,
  assertSafeModelHistory,
  assertSafeExternalContent,
} from "@cognia/content-safety"
import type { ExternalAgentExecutionOptions } from "@cognia/agent-contracts"

/** Model content only; runtime MCP credentials are not model instructions. */
export function assertExternalAgentContentSafety(
  message: unknown,
  options?: ExternalAgentExecutionOptions
): void {
  if (options?.contentSafety?.injectionProtection !== true) return
  assertSafeModelInput(message)
  const {
    mcpServers: _mcp,
    additionalDirectories: _roots,
    sandboxToolHostLeaseIds: _leases,
    conversationHistory,
    ...custom
  } = options.context?.custom ?? {}
  if (Array.isArray(conversationHistory)) assertSafeModelHistory(conversationHistory)
  else assertSafeExternalContent(conversationHistory)
  assertSafeExternalContent({
    attachments: options.attachments,
    context: { ...options.context, custom },
  })
}

/**
 * Inspect provider-visible prompt content before protocols hide text inside
 * base64 transport fields that the structural PII detector cannot decode.
 * The decoding lives in `@cognia/agent-runtime-kit/prompt-gate` (ADR-0217);
 * this binds it to the app's PII gate.
 */
export function hasNoLeakingExternalAgentPromptInput(
  message: ExternalAgentMessage,
  metadata?: Record<string, unknown>
): boolean {
  return promptInputPassesGate(message, hasNoLeakingPiiDeep, metadata)
}
