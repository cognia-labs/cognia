/** Host process leases shared by dock tools and the headless consent path. */
import {
  trackPersonalEgressProcess,
  type PersonalEgressContext,
} from "@/lib/execution/personal-egress"
import { getLiveSession, subscribeLiveSessions } from "./session-registry"
import { personalOperationSources } from "@/lib/execution/personal-operation"
import type { BaseTerminalSession } from "./base-session"

const leaseCleanups = new Set<() => void>()

export function retainTerminalPersonalEgress(
  context: PersonalEgressContext,
  sessionId: string,
  original = getLiveSession(sessionId)
): void {
  if (
    !context.executionRunId &&
    !personalOperationSources(context) &&
    !("personalSources" in context)
  )
    return
  let confirmed = false
  const subscriptions = new Map<BaseTerminalSession, () => void>()
  const release = trackPersonalEgressProcess(context, sessionId, () => {
    observe()
    return !confirmed
  })
  const cleanup = () => {
    confirmed = true
    release()
    offRegistry()
    for (const off of subscriptions.values()) off()
    subscriptions.clear()
    leaseCleanups.delete(cleanup)
  }
  const confirm = (session: BaseTerminalSession) => {
    if (session.processExitConfirmed !== true) return
    cleanup()
  }
  function observe() {
    if (confirmed) return
    for (const session of new Set([original, getLiveSession(sessionId)])) {
      if (!session) continue // Missing/disconnected handles prove no Host process exit.
      if (!subscriptions.has(session))
        subscriptions.set(
          session,
          session.onExit(() => confirm(session))
        )
      confirm(session)
      if (confirmed) break
    }
  }
  const offRegistry = subscribeLiveSessions(observe)
  leaseCleanups.add(cleanup)
  observe()
}

// Private headless PTYs have no renderer handle. Only the native child-wait
// proof returned by the bounded kill command releases their lease.
const headless = new Map<
  string,
  { releases: Array<() => void>; polling?: Promise<boolean>; off?: () => void }
>()
async function observeHeadlessProof(sessionId: string, lease: { off?: () => void }): Promise<void> {
  try {
    const { listen } = await import("@tauri-apps/api/event")
    const off = await listen<{ sessionId: string }>(
      "terminal:headless-exit-proof",
      ({ payload }) => {
        if (payload.sessionId === sessionId && headless.get(sessionId) === lease)
          confirmHeadlessPersonalEgressExit(sessionId)
      }
    )
    if (headless.get(sessionId) !== lease) {
      if (typeof off === "function") off()
      return
    }
    lease.off = off
    // Reconcile an exit between native return and listener registration without signalling a live child.
    const { invoke } = await import("@tauri-apps/api/core")
    const proof = await invoke<{ status: string }>("terminal_headless_kill", {
      sessionId,
      observeOnly: true,
    })
    if (proof?.status === "exited" && headless.get(sessionId) === lease)
      confirmHeadlessPersonalEgressExit(sessionId)
  } catch {
    /* Lazy proof polling remains available when the event bridge disconnects. */
  }
}
export function retainHeadlessPersonalEgress(
  context: PersonalEgressContext,
  sessionId: string
): void {
  if (
    !context.executionRunId &&
    !personalOperationSources(context) &&
    !("personalSources" in context)
  )
    return
  let lease = headless.get(sessionId)
  if (!lease) {
    lease = { releases: [] }
    headless.set(sessionId, lease)
    void observeHeadlessProof(sessionId, lease)
  }
  lease.releases.push(
    trackPersonalEgressProcess(context, sessionId, async () => {
      const current = headless.get(sessionId)
      if (!current) return false
      current.polling ??= (async () => {
        try {
          const { closeRunSession } = await import("./headless-session-registry")
          await closeRunSession(sessionId, "headless")
        } catch {
          /* Unknown proof retains the lease for the next admission. */
        }
        return headless.has(sessionId)
      })().finally(() => {
        current.polling = undefined
      })
      return current.polling
    })
  )
}
export function confirmHeadlessPersonalEgressExit(sessionId: string): void {
  const lease = headless.get(sessionId)
  headless.delete(sessionId)
  if (typeof lease?.off === "function") lease.off()
  for (const release of lease?.releases ?? []) release()
}

/** Reset synthetic renderer resources between unit tests, never at run completion. */
export function __clearTerminalPersonalEgressForTesting(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Terminal lease reset is test-only")
  for (const cleanup of [...leaseCleanups]) cleanup()
  for (const sessionId of headless.keys()) confirmHeadlessPersonalEgressExit(sessionId)
}
