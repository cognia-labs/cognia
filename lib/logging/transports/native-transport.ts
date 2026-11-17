import type {
  LogLevel,
  StructuredLogEntry,
  Transport,
  TransportHealthSnapshot,
} from "@/types/logging"
import {
  forwardPlatformLoggingEntries,
  type PlatformLogEntryPayload,
} from "@/lib/native/native-logging"
import { isTauri } from "@/lib/tauri"

export interface NativeTransportOptions {
  minLevel?: LogLevel
  /** Entries per `platform_logging_forward` call. */
  batchSize?: number
  flushInterval?: number
  /**
   * Most entries held while the native side is unreachable. Past it the oldest
   * entries are dropped and counted in `droppedEntries`; nothing is lost silently.
   */
  maxQueueSize?: number
}

const DEFAULT_OPTIONS: Required<NativeTransportOptions> = {
  minLevel: "warn",
  batchSize: 10,
  flushInterval: 2000,
  maxQueueSize: 1000,
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export class NativeTransport implements Transport {
  name = "native"

  private readonly options: Required<NativeTransportOptions>
  private buffer: StructuredLogEntry[] = []
  /** The one flush in flight; later callers wait for it instead of racing it. */
  private inFlight: Promise<void> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private health: TransportHealthSnapshot = {
    transport: "native",
    status: isTauri() ? "healthy" : "offline",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: new Date().toISOString(),
  }

  constructor(options: NativeTransportOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    }
    this.startFlushTimer()
  }

  log(entry: StructuredLogEntry): void {
    if (!isTauri()) {
      return
    }

    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[this.options.minLevel]) {
      return
    }

    this.buffer.push(entry)
    this.enforceQueueBound()
    this.updateHealth({
      queueDepth: this.buffer.length,
    })

    if (this.buffer.length >= this.options.batchSize) {
      void this.flush()
    }
  }

  /**
   * Forward the queue in order, one batch per native call, one flush at a time.
   * A failed batch goes back to the head of the queue with everything after it,
   * so a retry resends the same entries in the same order.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (!isTauri() || this.buffer.length === 0) return Promise.resolve()
    const run = this.drain().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.batchSize)
      const forwarded = await forwardPlatformLoggingEntries(batch.map(toPlatformPayload))
      if (!forwarded) {
        // Entries logged while the call was pending sit behind the failed batch.
        this.buffer.unshift(...batch)
        this.enforceQueueBound()
        this.updateHealth({
          status: "degraded",
          queueDepth: this.buffer.length,
          retryCount: this.health.retryCount + 1,
          lastFailureAt: new Date().toISOString(),
          lastError: "native_transport_forward_failed",
        })
        return
      }
      this.updateHealth({
        status: "healthy",
        queueDepth: this.buffer.length,
        retryCount: 0,
        lastSuccessAt: new Date().toISOString(),
        lastError: undefined,
      })
    }
  }

  close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    return this.flush()
  }

  getHealth(): TransportHealthSnapshot {
    return this.health
  }

  getPendingCount(): number {
    return this.buffer.length
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }

    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushInterval)
  }

  private enforceQueueBound(): void {
    const overflow = this.buffer.length - this.options.maxQueueSize
    if (overflow <= 0) return
    this.buffer.splice(0, overflow)
    this.updateHealth({ droppedEntries: this.health.droppedEntries + overflow })
  }

  private updateHealth(partial: Partial<TransportHealthSnapshot>): void {
    this.health = {
      ...this.health,
      ...partial,
      updatedAt: new Date().toISOString(),
    }
  }
}

function toPlatformPayload(entry: StructuredLogEntry): PlatformLogEntryPayload {
  return {
    level: entry.level,
    module: entry.module,
    message: entry.message,
    timestamp: entry.timestamp,
    traceId: entry.traceId,
    spanId: entry.spanId,
    parentSpanId: entry.parentSpanId,
    executionId: entry.executionId,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    data: normalizeEntryData(entry),
  }
}

function normalizeEntryData(entry: StructuredLogEntry): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {
    ...(entry.data || {}),
  }

  if (entry.stack) {
    data.stack = entry.stack
  }
  if (entry.source) {
    data.source = entry.source
  }
  if (entry.tags) {
    data.tags = entry.tags
  }
  if (entry.runtime) {
    data.runtime = entry.runtime
  }
  if (entry.origin) {
    data.origin = entry.origin
  }

  return Object.keys(data).length > 0 ? data : undefined
}

export function createNativeTransport(options?: NativeTransportOptions): NativeTransport {
  return new NativeTransport(options)
}
