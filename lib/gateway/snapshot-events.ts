/** Lightweight config-to-publisher notification without importing credential projection. */
const listeners = new Set<() => void>()

export function subscribeGatewaySnapshotChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyGatewaySnapshotChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* A subscriber cannot fail a saved config update. */
    }
  }
}
