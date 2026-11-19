import { isCapacitor, isHeadlessHost, isTauri } from "@/lib/platform/detect"
import { CompanionTransport, loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { localTransport, onTransportChange, transport } from "@/lib/tauri/transport-instance"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

/** Opt-in Companion topic. The Host only sends frames addressed to this device. */
export const DEVICE_LSP_EVENT = "lsp://rpc"

export async function waitForLspEventStream(target: Transport): Promise<void> {
  const channels = [DEVICE_LSP_EVENT]
  await target.whenSubscribed?.(channels)
  if (target.hasSubscribedChannels?.(channels) === false) {
    throw new Error("remote LSP event subscription unavailable")
  }
}

/** Desktop host selection and direct browser pairing use distinct transport owners. */
export function getRemoteLspTransport(): Transport | null {
  return (
    getActiveRemoteTransport() ??
    (!isCapacitor() &&
    !isHeadlessHost() &&
    transport instanceof CompanionTransport &&
    loadCompanionConfig()
      ? transport
      : null)
  )
}

export function subscribeRemoteLspTransport(notify: () => void): () => void {
  const stopRouting = subscribeActiveRemoteTransport(notify)
  const stopTransport = onTransportChange(notify)
  if (typeof window !== "undefined") {
    window.addEventListener("cognia:companion-config-changed", notify)
  }
  return () => {
    stopRouting()
    stopTransport()
    if (typeof window !== "undefined") {
      window.removeEventListener("cognia:companion-config-changed", notify)
    }
  }
}

/** Keep the dispatcher registration while swapping the actual event source. */
export function listenToLspHostEvents(localEvent: string, receive: (payload: string) => void) {
  let bound: Transport | null = null
  let unlisten: (() => void) | undefined
  let revision = 0
  const bind = () => {
    const remote = getRemoteLspTransport()
    const source = remote ?? (isHeadlessHost() ? transport : isTauri() ? localTransport : null)
    if (source === bound) return
    bound = source
    const ticket = ++revision
    unlisten?.()
    unlisten = source?.subscribe<unknown>(remote ? DEVICE_LSP_EVENT : localEvent, (payload) => {
      if (ticket === revision && getRemoteLspTransport() === remote) {
        if (typeof payload === "string") receive(payload)
        else if (payload && typeof payload === "object") receive(JSON.stringify(payload))
      }
    })
  }
  const stopWatching = subscribeRemoteLspTransport(bind)
  bind()
  return () => {
    revision += 1
    stopWatching()
    unlisten?.()
  }
}
