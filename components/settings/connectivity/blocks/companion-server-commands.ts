/**
 * The companion server's lifecycle commands, shared by the Local host blocks.
 *
 * Lifted out of the retired `companion-section.tsx`: the Locked Use reseed
 * still rides every start, for the reason recorded on its function.
 */

import { listPairedDevices } from "@/lib/db/paired-devices"
import { localTransport as transport } from "@/lib/tauri"
import type { TauriInvoker } from "@/lib/connectivity/mdns-discovery"
import type { MeshStatus } from "@/lib/connectivity/mesh"

/** Re-export: the port is owned by `lib/connectivity`, next to the tunnel client. */
export { COMPANION_SERVER_DEFAULT_PORT as DEFAULT_PORT } from "@/lib/connectivity/tunnel-resolver"

import { COMPANION_SERVER_DEFAULT_PORT as DEFAULT_PORT } from "@/lib/connectivity/tunnel-resolver"

export type BindMode = "loopback" | "lan"

/** Mirror of the Rust `CompanionServerStatus` (`companion_api/commands.rs`). */
export interface CompanionServerStatus {
  running: boolean
  bindMode: "loopback" | "lan" | "none"
  boundPort: number | null
}

/** Mirror of the Rust `CompanionTlsPaths` (`companion_api/commands.rs`). */
export interface CompanionTlsPaths {
  certPemPath: string
  keyPemPath: string
  fingerprintSha256: string
}

export interface TunnelInfo {
  publicUrl: string
  localUrl: string
}

export interface TunnelConfig {
  mode: "quick" | "named"
  hostname?: string
  hasToken: boolean
}

export async function fetchServerStatus(): Promise<CompanionServerStatus> {
  return transport.call<CompanionServerStatus>("companion_server_status")
}

export async function startServer(bindMode: BindMode): Promise<number> {
  const port = await transport.call<number>("companion_server_start", {
    port: DEFAULT_PORT,
    bindLoopbackOnly: bindMode === "loopback",
  })
  // The three elevated grants live in the host's SecurityStore, which is
  // persistent, so nothing is re-projected at boot.
  await seedLockedComputerUseAllowList()
  return port
}

export async function stopServer(): Promise<void> {
  await transport.call<void>("companion_server_stop")
}

/**
 * Locked Use keeps its per-boot reseed: unlike the three elevated grants, its list
 * is in-memory and intentionally dormant, so Dexie is still its only truth.
 * See `src-tauri/src/companion_api/locked_use_allow_list.rs`.
 */
export async function seedLockedComputerUseAllowList(): Promise<void> {
  try {
    const devices = await listPairedDevices()
    const allowed = devices
      .filter(
        (device) =>
          device.allowRemoteControl === true &&
          device.allowLockedComputerUse === true &&
          device.revokedAt === undefined
      )
      .map((device) => device.deviceId)
    await transport.call<void>("companion_seed_locked_computer_use", { deviceIds: allowed })
  } catch (err) {
    console.warn("seedLockedComputerUseAllowList failed", err)
  }
}

/**
 * The `lib/connectivity` wrappers take an invoker so they stay testable off
 * Tauri. These blocks manage this desktop, even when a remote host is selected.
 */
export const transportInvoker = async (): Promise<TauriInvoker> => ({
  // Arity matters to the transport spies: `call(name, undefined)` is not
  // `call(name)`, so an argument-less command is forwarded argument-less.
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) =>
    args === undefined ? transport.call<T>(cmd) : transport.call<T>(cmd, args),
})

// `companion_tunnel_start` and `companion_tunnel_probe` are deliberately NOT
// wrapped here: `lib/connectivity/tunnel-resolver` already owns them, and its
// discriminated `StartOutcome` is where the `tunnel_busy:` wire format is read.
// Hand it `transportInvoker` rather than growing a second client for one
// command — two wrappers is how the two surfaces drifted apart.

export async function getMeshStatus(): Promise<MeshStatus> {
  return transport.call<MeshStatus>("companion_mesh_status")
}

export async function stopTunnel(): Promise<void> {
  await transport.call<void>("companion_tunnel_stop")
}

export async function getTunnelInfo(): Promise<TunnelInfo | null> {
  return transport.call<TunnelInfo | null>("companion_tunnel_current")
}

export async function getTunnelConfig(): Promise<TunnelConfig | null> {
  return transport.call<TunnelConfig | null>("companion_tunnel_get_config")
}

export async function setTunnelMode(mode: "quick" | "named"): Promise<void> {
  return transport.call<void>("companion_tunnel_set_mode", { mode })
}

export async function clearNamedTunnelConfig(): Promise<void> {
  return transport.call<void>("companion_tunnel_clear_named")
}

export async function getMdnsStatus(): Promise<boolean> {
  return transport.call<boolean>("companion_mdns_status")
}
