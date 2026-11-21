"use client"

/**
 * Read and write the terminal host's own settings, from whichever shell.
 *
 * These settings are NOT part of `AppSettings`. They live in a file next to
 * the terminal host process (`terminal-host/settings.json`) and govern the
 * host itself: its session and replay limits, whether it starts at login, and
 * the remote-access switch every `/ws/terminal` connection is checked against.
 * `AppSettings.terminal.host` is a mirror of them, written alongside each
 * successful change so the card has something to render before the host
 * answers.
 *
 * Two command names because they are two authorities: the local command also
 * owns `provision` and the login-service registration and stays local, while
 * `terminal_host_configure` is capability-gated on `host.admin` and requires an
 * interactive approval lease (`adminLease`).
 */

import { transport } from "@/lib/tauri"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import { callWithTerminalAdminLease } from "./host-target"
import { selectTerminalTransportChain } from "./pick-transport"

export interface TerminalHostSettingsWire {
  allowRemoteAccess: boolean
  startAtLogin: boolean
  diagnostics: boolean
  maxSessions: number
  maxRemoteSessionsPerDevice: number
  replayBytesPerSession: number
  totalReplayBytes: number
}

export interface TerminalHostStatusWire {
  running: boolean
  endpoint: string
  settings: TerminalHostSettingsWire
}

/** True when some host — local or remote — can answer at all. */
export function terminalHostReachable(): boolean {
  return selectTerminalTransportChain().length > 0
}

function isLocalHost(): boolean {
  return selectTerminalTransportChain()[0] === "tauri-channel"
}

function defaultHostAdminCall(): typeof transport.call {
  const remote = getActiveRemoteTransport()
  return remote ? remote.call.bind(remote) : transport.call.bind(transport)
}

/** User-initiated recovery only. Never call from boot, polling or remote clients. */
export async function authorizeTerminalHostCredentials(
  call: typeof transport.call = transport.call.bind(transport)
): Promise<void> {
  if (!isLocalHost()) throw new Error("credential authorization requires the local terminal host")
  await call("terminal_host_service", { action: { kind: "authorizeCredentials" } })
}

/**
 * The host's settings as it actually has them.
 */
export async function readTerminalHostSettings(
  call?: typeof transport.call
): Promise<TerminalHostSettingsWire | null> {
  if (!terminalHostReachable()) return null
  const rpcCall = call ?? defaultHostAdminCall()
  try {
    const status = isLocalHost()
      ? await rpcCall<TerminalHostStatusWire>("terminal_host_service", {
          action: { kind: "status" },
        })
      : // invoke-parity-exempt: companion-only RPC dispatched over remote transport
        await rpcCall<TerminalHostStatusWire>("terminal_host_status", {})
    return status?.settings ?? null
  } catch {
    return null
  }
}

/**
 * Apply settings to the host. Throws when the host refuses or is unreachable,
 * so the caller can keep the mirror untouched rather than recording a change
 * that never happened.
 */
export async function writeTerminalHostSettings(
  settings: TerminalHostSettingsWire,
  call?: typeof transport.call
): Promise<void> {
  if (!terminalHostReachable()) {
    throw new Error("no terminal host is reachable from this shell")
  }
  if (isLocalHost()) {
    const invoke = call ?? transport.call.bind(transport)
    await invoke("terminal_host_service", { action: { kind: "configure", settings } })
    return
  }
  const target = call ? { call } : (getActiveRemoteTransport() ?? transport)
  await callWithTerminalAdminLease("terminal_host_configure", { settings }, { transport: target })
}
