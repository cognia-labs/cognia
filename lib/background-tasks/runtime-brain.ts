/**
 * Background job ends on the Host brain (ADR-0249 §6): the brain consumes the
 * supervisor's `jobs://exited` and `jobs://monitor-fired` like a window does
 * (and reconciles at start and after missed events), and delivers what a
 * conversation is owed through its own lane, the Host's automated turn
 * (`./host-delivery-lane.ts`). A window paired to this Host consumes the same
 * events; the supervisor's claim hands each end to one of them.
 *
 * A turn's end on this Host is the drain point, as a settle is in a window:
 * the steer queue and a person's queued message go first, then the results.
 */

import type { ClaudeEvent } from "@cognia/agent-config-types"

export async function start(): Promise<() => void> {
  const [
    delivery,
    { createHostDeliveryLane, runHostAutomatedTurn, afterTurnSettles, isTurnEndFrame },
    { startJobSettlementConsumer },
    { jobExitFromSettledFrame, outboxRecordFromJobExit },
    { listBackgroundJobSettlements },
    { onTauriEvent },
    { remoteEventResyncCoordinator },
    { onClaudeMessage },
    { getSession },
    { listWorkSubmissions },
    { getDb },
    { runtimeRefForSession },
  ] = await Promise.all([
    import("./result-delivery"),
    import("./host-delivery-lane"),
    import("./job-settlement-consumer"),
    import("./job-settlement"),
    import("@/lib/jobs/background-jobs"),
    import("@/lib/tauri/events"),
    import("@/lib/tauri/resync-coordinator"),
    import("@/lib/claude/ipc"),
    import("@/lib/db/sessions"),
    import("@/lib/db/work-submissions"),
    import("@/lib/db/schema"),
    import("@/stores/agent/agent-runtime-store"),
  ])

  const hasOpenTurn = async (sessionId: string) =>
    (
      await listWorkSubmissions({
        sessionId,
        dispatchStates: ["pending", "blocked", "claimed", "dispatched"],
        limit: 1,
      })
    ).length > 0

  const unregisterLane = delivery.registerBackgroundDeliveryLane(
    createHostDeliveryLane({
      getSession,
      isBuiltinRuntime: (sessionId) => runtimeRefForSession(sessionId).kind === "builtin",
      hasOpenTurn,
      databaseName: () => getDb().name,
      send: (text, sessionId, deliveryId, personalRunIds) =>
        runHostAutomatedTurn({
          sessionId,
          text,
          deliveryId,
          ...(personalRunIds ? { personalRunIds } : {}),
        }),
    })
  )

  const consumer = startJobSettlementConsumer({
    host: "renderer",
    subscribe: onTauriEvent,
    listSettlements: listBackgroundJobSettlements,
    onSettled: delivery.onBackgroundJobSettled,
    registerResync: (domain, resolver) => remoteEventResyncCoordinator.register(domain, resolver),
    warn: (message, error) => console.warn(message, error),
  })

  let stopped = false
  const unlistenFrames = await onClaudeMessage((event: ClaudeEvent) => {
    if (stopped) return
    // An in-process background shell ended (a sidecar with no supervisor).
    const exit = jobExitFromSettledFrame(event)
    if (exit) {
      const record = outboxRecordFromJobExit(exit, "renderer")
      if (record) void delivery.onBackgroundJobSettled(record)
      return
    }
    if (!isTurnEndFrame(event)) return
    const sessionId = event.sessionId
    afterTurnSettles(
      sessionId,
      () => {
        if (!stopped) delivery.maybeDrainBackgroundResults(sessionId, { turnSettled: true })
      },
      { hasOpenTurn }
    )
  })

  return () => {
    stopped = true
    unlistenFrames()
    consumer.stop()
    unregisterLane()
  }
}
