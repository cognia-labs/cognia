/**
 * Device-originated model turns require a real Host session (ADR-0123).
 * Keep its receipt and cleanup separate from the credential-bearing model
 * request: only ids enter the durable outbox, never prompts or credentials.
 */
import type { HostStateIntentSettlement } from "@/lib/db/mobile-outbound-queue"

const SETTLEMENT_TIMEOUT_MS = 5_000

export async function withHostUtilitySession<T>(
  options: {
    sessionId: string
    providerId: string
    model: string
    assertCurrent: () => void
    signal: AbortSignal
  },
  run: () => Promise<T>
): Promise<T> {
  const { sessionId, assertCurrent, signal } = options
  assertCurrent()
  signal.throwIfAborted()
  // These modules reach the chat renderer too; load only after its bootstrap.
  const [
    queue,
    { hydrateHostStateSession },
    { getRuntimeSnapshot },
    { transport },
    { closeSession },
  ] = await Promise.all([
    import("@/lib/db/mobile-outbound-queue"),
    import("@/lib/sync/host-state-service"),
    import("@/lib/runtime/runtime-snapshot-store"),
    import("@/lib/tauri"),
    import("@/lib/claude/ipc"),
  ])
  assertCurrent()
  signal.throwIfAborted()
  const { awaitHostStateIntentSettlement, enqueueHostStateIntentIfAvailable } = queue
  const scope = getRuntimeSnapshot().host?.hostStateScope
  if (!scope) throw new Error("Host utility session admission is unavailable")
  const hydrate = () => hydrateHostStateSession({ transport, ...scope, sessionId, assertCurrent })
  const row = await enqueueHostStateIntentIfAvailable({
    sessionId,
    actionId: `${sessionId}:create`,
    action: {
      kind: "session.create",
      title: "Background utility",
      seed: { provider: options.providerId, model: options.model },
    },
  })
  assertCurrent()
  if (!row) throw new Error("Host utility session admission is unavailable")
  let creation: HostStateIntentSettlement | undefined
  try {
    creation = await awaitHostStateIntentSettlement(row.id, { timeoutMs: SETTLEMENT_TIMEOUT_MS })
    assertCurrent()
    signal.throwIfAborted()
    if (creation.outcome !== "applied") {
      throw new Error(`Host utility session creation ${creation.outcome}`)
    }
    return await run()
  } finally {
    // Reconcile the SAME queued create after cancellation or a lost answer.
    // Never retry the model send or address a replacement account/Host.
    assertCurrent()
    if (!creation || creation.outcome === "pending") {
      creation = await awaitHostStateIntentSettlement(row.id, { timeoutMs: SETTLEMENT_TIMEOUT_MS })
      assertCurrent()
    }
    if (creation.outcome === "pending") {
      throw new Error("Host utility session creation is pending; cleanup is not confirmed")
    }
    if (creation.outcome === "applied") {
      await closeSession(sessionId)
      assertCurrent()
      await hydrate()
      assertCurrent()
      const cleanup = await enqueueHostStateIntentIfAvailable({
        sessionId,
        actionId: `${sessionId}:delete`,
        action: { kind: "session.delete" },
      })
      assertCurrent()
      if (!cleanup) throw new Error("Host utility session cleanup is unavailable")
      const settled = await awaitHostStateIntentSettlement(cleanup.id, {
        timeoutMs: SETTLEMENT_TIMEOUT_MS,
      })
      assertCurrent()
      if (settled.outcome !== "applied") {
        throw new Error(`Host utility session cleanup ${settled.outcome}`)
      }
    }
  }
}
