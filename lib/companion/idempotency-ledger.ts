// An answer ledger for companion writes a retry must not repeat.
//
// The companion server already de-duplicates a write that carries an
// `Idempotency-Key` header, but only for the transport that saw it, and only
// when the client sent the header at all. A phone that loses the reply,
// reconnects over a different channel and presses again must not act twice.
// So a host dispatch that changes state also keys on the `idempotencyKey` in
// the body, scoped to the AUTHENTICATED device (`callerDeviceId` is injected
// server-side, see `CALLER_DEVICE_ID_COMMANDS` in
// `crates/cognia-companion-rpc/src/rpc.rs`), so one device can neither replay
// nor pre-empt another's intent.
//
// The in-flight promise is what is stored, not only the settled value: a retry
// that lands while the first attempt is still running joins it instead of
// starting a second one. A rejection is forgotten, so a transient failure can
// be retried with the same key.
//
// Remote pet care (ADR-0219, `lib/pet/remote/idempotency.ts`) and the Files
// writes (ADR-0223 §9, `lib/files-library/remote/idempotency.ts`) each keep
// their own ledger built here.

/** How long an answer is replayed. Longer than any client retry window. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

/** Bound on remembered intents; the oldest is evicted first. */
export const IDEMPOTENCY_MAX_ENTRIES = 512

interface Entry {
  value: Promise<unknown>
  expiresAt: number
}

export interface IdempotencyLedger {
  /**
   * Run `fn` once per `(callerDeviceId, idempotencyKey)` inside the TTL, and
   * answer every repeat with the first run's (possibly still pending) result.
   */
  run<T>(callerDeviceId: string, idempotencyKey: string, fn: () => Promise<T>): Promise<T>
  /** Number of remembered intents (tests, diagnostics). */
  size(): number
  clear(): void
}

export function ledgerKey(callerDeviceId: string, idempotencyKey: string): string {
  return `${callerDeviceId}:${idempotencyKey}`
}

export function createIdempotencyLedger(
  opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}
): IdempotencyLedger {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS
  const maxEntries = opts.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES
  // A Map iterates in insertion order, so the first key is the oldest. A hit
  // does not refresh recency on purpose: the TTL is measured from the intent,
  // not from its latest retry, or a client retrying forever would never let go.
  const entries = new Map<string, Entry>()

  const sweep = (at: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key)
    }
  }

  return {
    run<T>(callerDeviceId: string, idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
      const at = now()
      sweep(at)
      const key = ledgerKey(callerDeviceId, idempotencyKey)
      const existing = entries.get(key)
      if (existing) return existing.value as Promise<T>

      const value = fn()
      entries.set(key, { value, expiresAt: at + ttlMs })
      value.catch(() => {
        // Only forget the attempt that failed, never a newer one that reused
        // the slot after a sweep.
        if (entries.get(key)?.value === value) entries.delete(key)
      })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return value
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  }
}
