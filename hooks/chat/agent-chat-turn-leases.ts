/**
 * One desktop chat turn's admission lease, keyed by `sessionTurnLockKey`. Send
 * takes it, the event queue joins it, and Stop holds it until the interrupt
 * settles.
 */
export type DesktopTurnLease = {
  pendingDispatches: number
  settle: () => void
  /** Set by Stop; the lease is held until the interrupt command settles. */
  stopping?: { interruptSettled: boolean }
}

/** The live leases of this renderer, one per session turn lock. */
export const desktopTurnLeases = new Map<string, DesktopTurnLease>()
