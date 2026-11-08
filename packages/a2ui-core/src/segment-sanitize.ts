/**
 * Stored, model and tool content is presentation: it never carries the Host's
 * callback authority. These strip it from outbound message segments (A2UI
 * surfaces and native cards alike) before they are sent or stored:
 * binding hints (`binding*`), run-control routing (`runId`, `revision`,
 * `interruptId`, run-control `action`s) and namespaced callback values
 * (`prefix:…`) in the fields platforms echo back on a tap. A data-bound
 * callback value is resolved against the surface's data model first.
 *
 * The connectors run it on every reply and scheduled send; the scheduler's
 * store runs `sanitizeScheduledOutboundPayload` on every task payload and
 * execution input it writes, synchronously, because some callers write inside
 * their own Dexie transaction.
 */

import type { MessageSegment } from "@cognia/plugin-contract/types/connectors/segment"
import { getValueByPath } from "./data-model"

/** Model/tool content, including native cards, cannot reuse Host callbacks. */
function withoutBindingHints<T>(content: T, dataModel: Record<string, unknown> = {}): T {
  const namespaced = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_.-]*:/.test(value)
  const callbackFields = new Set([
    "value",
    "callback_data",
    "action_id",
    "actionId",
    "custom_id",
    "callback_id",
    "event_key",
    // WeCom template_card.button_list[].key is echoed as event_key.
    "key",
  ])
  const clean = (value: unknown, inCallbackValue = false): unknown => {
    if (Array.isArray(value))
      return value
        .filter((entry) => !inCallbackValue || !namespaced(entry))
        .map((entry) => clean(entry, inCallbackValue))
    if (!value || typeof value !== "object") return value
    const raw = value as Record<string, unknown>
    // QQ callback buttons echo action.data as button_data. Link (type 0) and
    // command (type 2) data are presentation, and must retain their URLs/text.
    const isCallbackField = (key: string) =>
      callbackFields.has(key) ||
      (key === "data" && raw.type === 1 && Object.hasOwn(raw, "permission"))
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([key, entry]) => {
          if (key.startsWith("binding")) return false
          if (["runId", "revision", "interruptId"].includes(key)) return false
          if (
            key === "action" &&
            (inCallbackValue || "runId" in raw || "revision" in raw) &&
            typeof entry === "string" &&
            [
              "stop",
              "pause",
              "resume",
              "approve",
              "deny",
              "retry",
              "open_details",
              "steer",
            ].includes(entry)
          )
            return false
          if (!inCallbackValue && !isCallbackField(key)) return true
          const resolved =
            entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string"
              ? getValueByPath(dataModel, entry.path)
              : entry
          return !namespaced(resolved)
        })
        .map(([key, entry]) => [key, clean(entry, inCallbackValue || isCallbackField(key))])
    )
  }
  return clean(content) as T
}

/** Stored/model/tool content is presentation, never a Host callback builder. */
export function sanitizeOutboundSegments(segments: MessageSegment[]): MessageSegment[] {
  return segments.map((segment) =>
    withoutBindingHints(segment, segment.type === "a2ui" ? segment.content.dataModel : undefined)
  )
}

/** Shared scheduler persistence boundary: create, update, import and execution input. */
export function sanitizeScheduledOutboundPayload<T extends Record<string, unknown> | undefined>(
  payload: T
): T {
  if (!payload || !Array.isArray(payload.segments)) return payload
  return { ...payload, segments: sanitizeOutboundSegments(payload.segments as MessageSegment[]) }
}
