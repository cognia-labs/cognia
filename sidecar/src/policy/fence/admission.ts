import type { HostRpcClient } from "../../platform/host-rpc.ts"

export class FenceDeniedError extends Error {
  readonly code = "worker_fence_closed"

  constructor() {
    super("Worker tool admission is closed")
    this.name = "FenceDeniedError"
  }
}

/** Bound on one `worker.admitTool` round trip; a timeout is a real denial. */
export const HOST_ADMISSION_TIMEOUT_MS = 5_000

export interface WorkerToolAdmission {
  /**
   * Ask the Node authority right before a tool runs. A lapsed cached grant is
   * never refused up front (the brain may have renewed since); a refusal, an
   * error, a timeout, a closed channel or a reply that lapsed in transit
   * latches every later call.
   */
  admit(toolName: string, toolUseId?: string): Promise<void>
  /**
   * Synchronous final check right before execution; never starts a round trip.
   * Throws, and latches, once the grant answered for the most recently sent
   * request (measured from its send time) has lapsed.
   */
  assertAllowed(): void
  /** Synchronous check of the latch and the channel only (turn and hook start). */
  assertOpen(): void
}

/**
 * Session-owned authority shared by both rails. Only worker-dispatch sends
 * create one. TTLs are relative: request latency consumes the lease rather
 * than extending it, and no host clock value is compared with our clock.
 */
export function createWorkerToolAdmission({
  sessionId,
  hostRpc,
  onDenied,
  now = () => performance.now(),
}: {
  sessionId: string
  hostRpc?: (Pick<HostRpcClient, "call"> & Partial<Pick<HostRpcClient, "isClosed">>) | null
  onDenied(error: FenceDeniedError): void
  now?: () => number
}): WorkerToolAdmission {
  /** The grant answered for the most recently SENT request: Node's latest view. */
  let grant: { seq: number; deadline: number } | undefined
  /** Strict request order; a monotonic clock may read the same value twice. */
  let nextSeq = 0
  let denial: FenceDeniedError | undefined

  function deny(): never {
    if (!denial) {
      denial = new FenceDeniedError()
      onDenied(denial)
    }
    throw denial
  }

  function assertOpen(): void {
    if (denial) throw denial
    if (!hostRpc || hostRpc.isClosed) deny()
  }

  // Expiry latches like a refusal. It is only ever judged right after a reply
  // (a grant that lapsed in transit, or before the tool could start), never
  // against a stale cache before asking, so a renewal is always seen first; and
  // a latch is what stops a concurrent call in the interrupted turn from
  // starting its tool on a later, valid grant.
  const expire = deny

  function assertAllowed(): void {
    assertOpen()
    if (grant === undefined || now() >= grant.deadline) expire()
  }

  return {
    assertAllowed,
    assertOpen,
    async admit(toolName, toolUseId) {
      assertOpen()
      const seq = ++nextSeq
      const sentAt = now()
      // A fixed bound, independent of the cached grant: a renewal Node already
      // holds must not time out because the old grant was about to lapse. No
      // tool runs while this waits, and the reply's own grant is checked below.
      const timeoutMs = HOST_ADMISSION_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      let answer: unknown
      try {
        // Bound even an injected/broken caller that ignores its timeout option.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new FenceDeniedError()), timeoutMs)
          timer.unref?.()
        })
        answer = await Promise.race([
          hostRpc!.call(
            "worker.admitTool",
            { sessionId, toolName, ...(toolUseId ? { toolUseId } : {}) },
            { timeoutMs }
          ),
          timeout,
        ])
      } catch {
        deny()
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      // A concurrent denial cannot be revived by a late allow.
      assertOpen()
      const result = answer as { allowed?: unknown; leaseTtlMs?: unknown } | null
      if (
        result?.allowed !== true ||
        typeof result.leaseTtlMs !== "number" ||
        !Number.isFinite(result.leaseTtlMs) ||
        result.leaseTtlMs <= 0
      )
        deny()
      // A renewal may shorten the lease, so a grant only ever replaces one
      // answered for an earlier-sent request, and this call is judged by its
      // own grant, never by a longer one cached before.
      const own = { seq, deadline: sentAt + result.leaseTtlMs }
      if (grant === undefined || own.seq > grant.seq) grant = own
      if (now() >= own.deadline) expire()
      assertAllowed()
    },
  }
}
