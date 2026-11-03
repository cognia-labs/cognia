import { currentRuntimeProfile } from "@/lib/plugin/character-pack/platform-availability"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { RuntimeSupportContext } from "@/lib/external-services/runtime-support"

const contexts = new Map<string, RuntimeSupportContext>()

/**
 * The runtime that serves each external-service facet here. A mirrored client
 * runs its plugins on the paired desktop, so every facet is the desktop's. A
 * client that only has an active paired gateway forwards exchange and network
 * calls to that Host, while secrets, OAuth callbacks and background sync stay
 * in this runtime. A standalone Capacitor shell owns its native OAuth callback.
 * The returned object is stable per combination (useSyncExternalStore snapshot).
 */
export function currentExternalServiceRuntimeContext(): RuntimeSupportContext {
  let local = currentRuntimeProfile()
  if (local === "browser" && isMirroredPluginClient()) local = "tauri"
  const gateway = local === "tauri" || isRemoteHostActive() ? "tauri" : local
  const key = `${local}:${gateway}`
  let context = contexts.get(key)
  if (!context) {
    context = Object.freeze({ local, gateway })
    contexts.set(key, context)
  }
  return context
}
