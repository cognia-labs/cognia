/**
 * Room hand-offs are reported however their Squad run ended (ADR-0252 §4).
 *
 * The attempt a host launched reports itself when its outcome settles, but
 * only while that host runs. At start this finds every recent attempt that
 * ended with no entry (the host stopped between the run's end and its
 * outbox entry), and whenever a Squad run ends here it looks again, so a
 * retry launched from the run's card reaches the room without a restart.
 * Scans never overlap: one asked for while another runs waits for it.
 */

export async function start(): Promise<() => void> {
  const [{ reconcileRoomHandoffs }, { onSquadRunEnded }] = await Promise.all([
    import("./settle"),
    import("../squad/squad-lifecycle-runner"),
  ])
  let stopped = false
  let tail: Promise<void> = Promise.resolve()
  const reconcile = (): Promise<void> => {
    tail = tail.then(async () => {
      if (stopped) return
      await reconcileRoomHandoffs().catch((error: unknown) =>
        console.warn("room hand-off reconciliation failed", error)
      )
    })
    return tail
  }
  const unsubscribe = onSquadRunEnded(() => {
    void reconcile()
  })
  await reconcile()
  return () => {
    stopped = true
    unsubscribe()
  }
}
