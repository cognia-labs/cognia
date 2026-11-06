// React reader for a capability port (`lib/modules/ports.ts`, ADR-0250 §14):
// the port's implementation once it has loaded, `null` when no active module
// provides it, and `undefined` while it is still loading. Mounting the hook
// starts the load.

"use client"

import { useEffect, useSyncExternalStore } from "react"
import { loggers } from "@cognia/logging"
import { loadPort, readPort, subscribePorts, type PortId, type PortMap } from "@/lib/modules/ports"

export function usePort<K extends PortId>(id: K): PortMap[K] | null | undefined {
  const port = useSyncExternalStore(
    subscribePorts,
    () => readPort(id),
    () => undefined
  )
  useEffect(() => {
    if (readPort(id) !== undefined) return
    loadPort(id).catch((error: unknown) => {
      loggers.app.warn("port failed to load", {
        port: id,
        err: error instanceof Error ? error.message : String(error),
      })
    })
  }, [id])
  return port
}
