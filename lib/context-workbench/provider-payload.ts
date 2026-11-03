import { attachResourceContext } from "./provider-context"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import type { SendContent, SendOptions } from "@cognia/agent-config-types"
import {
  assertSafeModelInput,
  assertSafeExternalContent,
  ContentSafetyBlockedError,
} from "@cognia/content-safety"

const WITHHELD = "[External content withheld by content safety.]"

/** Reassess current canonical text, including edits; never mutate stored UI rows. */
function safeHistoryMessage<T>(message: T, enabled: boolean): T {
  if (!enabled || !message || typeof message !== "object") return message
  const record = message as Record<string, unknown>
  if (record.role === "system" || record.role === "developer") return message
  const parts = record.parts ?? record.content
  try {
    if (record.role === "user") {
      assertSafeModelInput(parts)
      // UI message tool-result parts may coexist with text, so inspect those
      // explicitly instead of treating their metadata as authored instructions.
      if (Array.isArray(parts))
        for (const part of parts) {
          if (part && typeof part === "object" && "output" in part)
            assertSafeExternalContent(part.output)
        }
    } else {
      assertSafeExternalContent(parts)
    }
    return message
  } catch (error) {
    if (!(error instanceof ContentSafetyBlockedError)) throw error
    return {
      ...record,
      ...(record.parts !== undefined
        ? { parts: [{ type: "text", text: WITHHELD }] }
        : { content: WITHHELD }),
    } as T
  }
}

export interface WorkbenchProviderPayload<TMessage = unknown> {
  content: SendContent
  messages: TMessage[]
  sendOptions: SendOptions
}

export class WorkbenchPiiGateBlocked extends Error {
  constructor() {
    super("Context Workbench provider payload failed the PII gate")
    this.name = "WorkbenchPiiGateBlocked"
  }
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  if (value instanceof Date) return new Date(value)
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value

  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    value.forEach((item) => output.push(redactValue(item, seen)))
    return output
  }

  const output: Record<string, unknown> = {}
  seen.set(value, output)
  Object.entries(value).forEach(([key, nested]) => {
    output[key] = redactValue(nested, seen)
  })
  return output
}

/**
 * Assemble and gate the provider-visible workbench text immediately before
 * dispatch. Runtime configuration (env/MCP credentials, cwd, tool allowlists)
 * is copied verbatim because it is not prompt text and redacting it can break
 * authentication or tool execution.
 */
export function gateWorkbenchProviderPayload<TMessage>(
  payload: WorkbenchProviderPayload<TMessage>,
  resourceContext = "",
  header = "Current resource context"
): WorkbenchProviderPayload<TMessage> {
  const enabled = payload.sendOptions.contentSafety?.injectionProtection === true
  assertSafeModelInput(payload.content, enabled)
  let safeResource = resourceContext
  if (enabled && resourceContext) {
    try {
      assertSafeExternalContent(resourceContext)
    } catch (error) {
      if (!(error instanceof ContentSafetyBlockedError)) throw error
      safeResource = WITHHELD
    }
  }
  const content = redactValue(
    attachResourceContext(payload.content, safeResource, header),
    new WeakMap()
  ) as SendContent
  const messages = redactValue(
    payload.messages.map((m) => safeHistoryMessage(m, enabled)),
    new WeakMap()
  ) as TMessage[]
  const sendOptions: SendOptions = {
    ...payload.sendOptions,
    ...(payload.sendOptions.systemPrompt
      ? { systemPrompt: redactText(payload.sendOptions.systemPrompt).redacted }
      : {}),
    ...(payload.sendOptions.appendSystemPrompt
      ? { appendSystemPrompt: redactText(payload.sendOptions.appendSystemPrompt).redacted }
      : {}),
  }
  const providerVisibleText = {
    content,
    messages,
    systemPrompt: sendOptions.systemPrompt,
    appendSystemPrompt: sendOptions.appendSystemPrompt,
  }
  if (!hasNoLeakingPiiDeep(providerVisibleText)) {
    throw new WorkbenchPiiGateBlocked()
  }
  return { content, messages, sendOptions }
}
