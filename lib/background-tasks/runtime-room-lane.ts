/**
 * Results owed to a character-team room reach it here (ADR-0252 §4), on
 * every host that orchestrates rooms: the desktop and the Host brain.
 *
 * Registers the room lane with the one delivery path, and makes the room
 * runner's turn boundary its drain point, as a chat turn's settle is in a
 * window: the steer queue goes first, then the results. At start, results
 * left owed by a previous run of the host are delivered.
 */

export async function start(): Promise<() => void> {
  const [
    delivery,
    { createRoomDeliveryLane },
    { getHostRoomRunner },
    { getSession },
    { getDb },
    { listBackgroundTaskRecords },
  ] = await Promise.all([
    import("./result-delivery"),
    import("./room-delivery-lane"),
    import("@/lib/chat/room/runner-host"),
    import("@/lib/db/sessions"),
    import("@/lib/db/schema"),
    import("@/lib/db/background-tasks"),
  ])
  const runner = getHostRoomRunner()
  const unregister = delivery.registerRoomDeliveryLane(
    createRoomDeliveryLane({
      runner: () => runner,
      getSession,
      consumerId: () => `room:${getDb().name}`,
    })
  )
  const unsubscribe = runner.onTurnSettled((roomId) =>
    delivery.maybeDrainBackgroundResults(roomId, { turnSettled: true })
  )

  const owed = await listBackgroundTaskRecords({ host: "renderer" }).catch(() => [])
  const rooms = new Set(
    owed
      .filter((row) => row.kind === "squad-handoff" && row.deliveryState === "pending")
      .map((row) => row.sessionId)
  )
  for (const roomId of rooms) void delivery.attemptBackgroundResultDelivery(roomId)

  return () => {
    unsubscribe()
    unregister()
  }
}
