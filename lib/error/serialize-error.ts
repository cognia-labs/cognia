/**
 * Bounded, JSON-safe snapshots of thrown values for debugging surfaces.
 *
 * `JSON.stringify(new Error("x"))` is `"{}"`: an Error's name, message, stack
 * and cause are not own enumerable properties, so every log path that clones
 * through JSON loses exactly the parts needed to locate a failure. These
 * helpers keep them, cap their size, and mark what they cut or could not
 * serialize instead of dropping it silently.
 *
 * Pure (no DOM, no stores), so the plugin debugger, workflow runtime and any
 * other log producer can share one shape.
 */

export interface SerializedError {
  name: string
  message: string
  stack?: string
  /** The `cause` chain, itself serialized (an Error or any other value). */
  cause?: SerializedError | JsonSafeValue
  /** Set when the stack or the cause chain was cut to fit the limits. */
  truncated?: true
}

export type JsonSafeValue =
  string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue }

export interface SerializeLimits {
  /** Characters kept of a stack trace. */
  maxStackChars?: number
  /** Characters kept of a message or a string value. */
  maxStringChars?: number
  /** Levels of `cause` followed. */
  maxCauseDepth?: number
  /** Levels of nested objects/arrays followed by `toJsonSafe`. */
  maxDepth?: number
  /** Keys / items kept per object or array by `toJsonSafe`. */
  maxEntries?: number
}

const DEFAULT_LIMITS: Required<SerializeLimits> = {
  maxStackChars: 4_000,
  maxStringChars: 2_000,
  maxCauseDepth: 3,
  maxDepth: 6,
  maxEntries: 50,
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false }
}

/** True for real Errors and for error-shaped objects that crossed a realm or a structured clone. */
export function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true
  if (value === null || typeof value !== "object") return false
  const candidate = value as { message?: unknown; name?: unknown; stack?: unknown }
  return (
    typeof candidate.message === "string" &&
    (typeof candidate.stack === "string" || typeof candidate.name === "string")
  )
}

export function serializeError(error: Error, limits: SerializeLimits = {}): SerializedError {
  return serializeErrorAt(error, { ...DEFAULT_LIMITS, ...limits }, 0, new WeakSet())
}

function serializeErrorAt(
  error: Error,
  limits: Required<SerializeLimits>,
  depth: number,
  seen: WeakSet<object>
): SerializedError {
  seen.add(error)
  const message = cap(String(error.message ?? ""), limits.maxStringChars)
  const out: SerializedError = {
    name: String(error.name || "Error"),
    message: message.text,
  }
  let cut = message.cut
  if (typeof error.stack === "string" && error.stack.length > 0) {
    const stack = cap(error.stack, limits.maxStackChars)
    out.stack = stack.text
    cut ||= stack.cut
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) {
    if (depth >= limits.maxCauseDepth) {
      cut = true
    } else if (typeof cause === "object" && cause !== null && seen.has(cause)) {
      out.cause = "[circular cause]"
    } else {
      out.cause = isErrorLike(cause)
        ? serializeErrorAt(cause, limits, depth + 1, seen)
        : toJsonSafeAt(cause, limits, depth + 1, seen)
    }
  }
  if (cut) out.truncated = true
  return out
}

/**
 * A JSON-safe copy of any value: Errors become `SerializedError`, BigInts and
 * symbols become strings, cycles and depth/size overruns become explicit
 * markers. Never throws.
 */
export function toJsonSafe(value: unknown, limits: SerializeLimits = {}): JsonSafeValue {
  return toJsonSafeAt(value, { ...DEFAULT_LIMITS, ...limits }, 0, new WeakSet())
}

function toJsonSafeAt(
  value: unknown,
  limits: Required<SerializeLimits>,
  depth: number,
  seen: WeakSet<object>
): JsonSafeValue {
  if (value === null) return null
  switch (typeof value) {
    case "string":
      return cap(value, limits.maxStringChars).text
    case "number":
      return Number.isFinite(value) ? value : String(value)
    case "boolean":
      return value
    case "bigint":
      return `${value}n`
    case "undefined":
      return "[undefined]"
    case "symbol":
    case "function":
      return String(value)
  }
  const object = value as object
  if (seen.has(object)) return "[circular]"
  if (isErrorLike(object)) {
    return serializeErrorAt(object, limits, depth, seen) as unknown as JsonSafeValue
  }
  if (depth >= limits.maxDepth) return `[depth limit: ${Object.prototype.toString.call(object)}]`
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      const items = object
        .slice(0, limits.maxEntries)
        .map((item) => toJsonSafeAt(item, limits, depth + 1, seen))
      if (object.length > limits.maxEntries) {
        items.push(`[${object.length - limits.maxEntries} more items]`)
      }
      return items
    }
    if (object instanceof Date)
      return Number.isNaN(object.getTime()) ? "[invalid date]" : object.toISOString()
    if (object instanceof Map || object instanceof Set) {
      return toJsonSafeAt(
        object instanceof Map ? Object.fromEntries(object) : Array.from(object),
        limits,
        depth,
        seen
      )
    }
    const out: { [key: string]: JsonSafeValue } = {}
    const keys = Object.keys(object)
    for (const key of keys.slice(0, limits.maxEntries)) {
      let field: unknown
      try {
        field = (object as Record<string, unknown>)[key]
      } catch {
        out[key] = "[unreadable]"
        continue
      }
      out[key] = toJsonSafeAt(field, limits, depth + 1, seen)
    }
    if (keys.length > limits.maxEntries) {
      out["…"] = `[${keys.length - limits.maxEntries} more keys]`
    }
    return out
  } finally {
    seen.delete(object)
  }
}
