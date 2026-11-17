/**
 * Evidence shaping for workflow step events: the resolved inputs a step
 * actually ran with, and the error it failed with. Both are stored in the
 * durable run event log that the step inspector reads, so they follow the
 * logger's redaction policy and are size-bounded before they are written.
 */

import { getLoggerConfig } from "@cognia/logging"
import { redactLogValue } from "@cognia/logging/redaction"
import {
  serializeError,
  toJsonSafe,
  type SerializeLimits,
  type SerializedError,
} from "@/lib/error/serialize-error"

/** Serialized size above which recorded inputs are replaced by a preview. */
export const MAX_STEP_INPUT_BYTES = 64 * 1024
/** Characters of the serialized inputs kept as the preview when truncated. */
export const STEP_INPUT_PREVIEW_CHARS = 8 * 1024

const INPUT_LIMITS: SerializeLimits = { maxStringChars: 16_000, maxDepth: 8, maxEntries: 200 }
const ERROR_LIMITS: SerializeLimits = { maxStackChars: 16_000, maxStringChars: 4_000 }

export interface RecordedStepInputs {
  /** Redacted inputs, or a string preview of them when `inputsTruncatedBytes` is set. */
  inputs: unknown
  /** Serialized byte size of the full redacted inputs when they were cut to a preview. */
  inputsTruncatedBytes?: number
}

export type StepErrorDetail = Pick<SerializedError, "name" | "stack" | "cause" | "truncated"> & {
  message: string
}

/**
 * Redact and bound the inputs one execution ran with. The stored value is
 * plain JSON data whatever the upstream produced (class instances, BigInts,
 * cycles become explicit markers), matching what the inspector renders.
 */
export function recordStepInputs(inputs: Record<string, unknown>): RecordedStepInputs {
  const safe = toJsonSafe(redactLogValue(inputs, getLoggerConfig().redaction), INPUT_LIMITS)
  const serialized = JSON.stringify(safe)
  const bytes = new TextEncoder().encode(serialized).length
  if (bytes > MAX_STEP_INPUT_BYTES) {
    return { inputs: serialized.slice(0, STEP_INPUT_PREVIEW_CHARS), inputsTruncatedBytes: bytes }
  }
  return { inputs: safe }
}

/**
 * The error detail recorded on `step_failed`: name, message, stack and the
 * `cause` chain, bounded by the shared serializer and redacted with the
 * logger's rules. A non-Error throw keeps its string form as the message.
 */
export function describeStepError(err: unknown): StepErrorDetail {
  const redaction = getLoggerConfig().redaction
  const serialized: SerializedError =
    err instanceof Error
      ? serializeError(err, ERROR_LIMITS)
      : { name: "Error", message: String(err).slice(0, ERROR_LIMITS.maxStringChars) }
  return redactLogValue(serialized, redaction) as StepErrorDetail
}
