import type { StructuredLogEntry } from "./types/log-entry"
/**
 * Logger Context
 * Manages session ID, trace ID, and context propagation
 */

/**
 * Generate a unique 32-char hex ID. Used both as the per-tab session ID and as
 * the canonical trace ID — Cognia's logger originally pulled the trace-ID
 * generator from the agent-trace module, but cognia-next has no agent-trace
 * subsystem, so we generate locally with the same shape (UUIDv4 minus hyphens).
 */
function generateHexId(byteLength: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(byteLength)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  return Array.from({ length: byteLength * 2 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("")
}

function generateId(): string {
  return generateHexId(16)
}

export function generateSpanId(): string {
  return generateHexId(8)
}

/**
 * Global logger context
 */
class LoggerContext {
  private _sessionId: string
  private _traceId: string | undefined
  private _context: Record<string, unknown> = {}
  private _spanStack: string[] = []

  constructor() {
    this._sessionId = this.initSessionId()
  }

  /**
   * Initialize or restore session ID
   */
  private initSessionId(): string {
    if (typeof window === "undefined") {
      return generateId()
    }

    const stored = sessionStorage.getItem("cognia-log-session-id")
    if (stored) {
      return stored
    }

    const newId = generateId()
    sessionStorage.setItem("cognia-log-session-id", newId)
    return newId
  }

  /**
   * Get current session ID
   */
  get sessionId(): string {
    return this._sessionId
  }

  /**
   * Get current trace ID
   */
  get traceId(): string | undefined {
    return this._traceId
  }

  /**
   * Set trace ID for current request chain
   */
  setTraceId(traceId: string): void {
    this._traceId = traceId
  }

  /**
   * Generate and set a new trace ID
   */
  newTraceId(): string {
    this._traceId = generateId()
    return this._traceId
  }

  /**
   * Clear current trace ID
   */
  clearTraceId(): void {
    this._traceId = undefined
  }

  /**
   * Get global context
   */
  get context(): Record<string, unknown> {
    return { ...this._context }
  }

  /**
   * Set global context values
   */
  setContext(context: Record<string, unknown>): void {
    this._context = { ...this._context, ...context }
  }

  /**
   * Clear global context
   */
  clearContext(): void {
    this._context = {}
  }

  /**
   * Current (innermost) span ID, or undefined when no span is active.
   */
  get spanId(): string | undefined {
    return this._spanStack[this._spanStack.length - 1]
  }

  /**
   * Parent span ID of the current span (the enclosing span), if any.
   */
  get parentSpanId(): string | undefined {
    return this._spanStack[this._spanStack.length - 2]
  }

  /**
   * Run a function inside a new span. Logs emitted within `fn` carry the new
   * `spanId` (and `parentSpanId` when nested). The span is always popped,
   * even if `fn` throws. The generated span ID is passed to `fn`.
   *
   * Synchronous only. This stack is shared by everything in the realm, so a
   * span held open across an `await` would be read (and popped) by whatever
   * else runs meanwhile. Async work carries its span explicitly through the
   * scoped logger `Logger.spanAsync` hands it.
   */
  withSpan<T>(fn: (spanId: string) => T): T {
    const spanId = generateSpanId()
    this._spanStack.push(spanId)
    try {
      return fn(spanId)
    } finally {
      this._spanStack.pop()
    }
  }

  /**
   * Run a function with a specific trace ID
   */
  withTrace<T>(fn: () => T): T {
    const prevTrace = this._traceId
    this._traceId = generateId()
    try {
      return fn()
    } finally {
      this._traceId = prevTrace
    }
  }
}

/**
 * Singleton logger context instance
 */
export const logContext = new LoggerContext()

/**
 * Generate a new trace ID
 */
export function generateTraceId(): string {
  return generateId()
}

/** Host-stamped producer references survive durable retry; public log data is never authority. */
export interface HostLogEgressSource {
  version: 1
  runIds: string[]
  blocked?: true
}
let currentEgressSource: HostLogEgressSource | undefined
export function withLogEgressSource<T>(source: HostLogEgressSource | undefined, task: () => T): T {
  const previous = currentEgressSource
  currentEgressSource = source
  try {
    return task()
  } finally {
    currentEgressSource = previous
  }
}
export function captureLogEgressSource(): HostLogEgressSource | undefined {
  return currentEgressSource
}
type LogEgressPolicy = (
  entries: StructuredLogEntry[],
  send: (entries: StructuredLogEntry[]) => Promise<unknown>
) => Promise<unknown>
let logEgressPolicy: LogEgressPolicy | undefined
export function configureLogEgressPolicy(policy: LogEgressPolicy): () => void {
  const previous = logEgressPolicy
  logEgressPolicy = policy
  return () => {
    logEgressPolicy = previous
  }
}
export function runLogEgress<T>(
  entries: StructuredLogEntry[],
  send: (entries: StructuredLogEntry[]) => Promise<T>
): Promise<T | undefined> {
  if (logEgressPolicy) return logEgressPolicy(entries, send) as Promise<T | undefined>
  // A pure package host without the policy port cannot authorize stamped replay.
  const background = entries.filter((entry) => entry.hostEgressSource === undefined)
  return background.length ? send(background) : Promise.resolve(undefined)
}
export function stripLogEgressSources(entries: StructuredLogEntry[]): StructuredLogEntry[] {
  return entries.map((entry) => {
    const copy = { ...entry }
    delete copy.hostEgressSource
    return copy
  })
}

/** Host failure provenance survives rejected callbacks without ambient async state. */
let failureSource: ((error: unknown) => HostLogEgressSource | undefined) | undefined
export function configureLogFailureSource(
  resolve: (error: unknown) => HostLogEgressSource | undefined
): void {
  failureSource = resolve
}
export function captureLogFailureSource(error: unknown): HostLogEgressSource | undefined {
  return failureSource?.(error)
}
export function mergeLogEgressSources(
  ...sources: (HostLogEgressSource | undefined)[]
): HostLogEgressSource | undefined {
  const present = sources.filter((source): source is HostLogEgressSource => source !== undefined)
  return present.length
    ? {
        version: 1,
        runIds: [...new Set(present.flatMap((source) => source.runIds))],
        ...(present.some((source) => source.blocked) ? { blocked: true } : {}),
      }
    : undefined
}
