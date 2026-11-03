"use client"

import { useSyncExternalStore } from "react"
import { currentExternalServiceRuntimeContext } from "@/lib/external-services/runtime-profile"
import type { RuntimeSupportContext } from "@/lib/external-services/runtime-support"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

const SERVER_CONTEXT: RuntimeSupportContext = Object.freeze({
  local: "browser",
  gateway: "browser",
})

/** Match auth enforcement, including changes to the paired gateway. */
export function useExternalServiceRuntimeProfile(): RuntimeSupportContext {
  return useSyncExternalStore(
    subscribeActiveRemoteTransport,
    currentExternalServiceRuntimeContext,
    () => SERVER_CONTEXT
  )
}
