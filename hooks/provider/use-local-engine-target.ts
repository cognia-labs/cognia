"use client"

/**
 * Which machine the local-engine panels manage: this device, or the Host that
 * executes this client's turns (`lib/ai/local-engine/client.ts`). Re-renders
 * when the desktop switches to or from a remote Host, or a pairing changes.
 */

import { useSyncExternalStore } from "react"

import { subscribeExecutionHost } from "@/lib/ai/execution-host"
import {
  getLocalEngineTarget,
  getThisDeviceLocalEngineTarget,
  type LocalEngineTarget,
} from "@/lib/ai/local-engine/client"

export function useLocalEngineTarget(): LocalEngineTarget {
  return useSyncExternalStore(
    subscribeExecutionHost,
    getLocalEngineTarget,
    getThisDeviceLocalEngineTarget
  )
}
