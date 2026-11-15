"use client"

/**
 * Network proxy store helpers over `useSettingsStore`'s `networkProxy` field.
 * There is no separate persistent store: the source of truth is the singleton
 * `AppSettings` row in Dexie, written via `useSettingsStore.save({ networkProxy })`.
 *
 * - `useNetworkProxy` / `getNetworkProxy` read the typed settings (with
 *   defaults) for the settings UI.
 * - `applyProxyToRust(cfg)` pushes the latest config into the Rust
 *   `proxy_config` module via the `proxy_apply` Tauri command. Rust is the only
 *   routing authority: the renderer never derives a proxy URL or a route.
 * - `getProxyRuntimeStatus()` reads the sanitized native state back, including
 *   the policy revision and which long-lived processes still carry an older one.
 */

import { invoke } from "@tauri-apps/api/core"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/platform/window-role"
import { isProxyActive } from "@/lib/network/proxy-config"
import { notifyNetworkProxyApplied } from "@/lib/network/proxy-events"
import {
  applyProxyPasswordMutation,
  migrateLegacyProxyPassword,
  type ProxyPasswordMutation,
} from "@/lib/network/proxy-credentials"
import { loggers } from "@cognia/logging"
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type LegacyNetworkProxySettings,
  type NetworkProxySettings,
  type ProxyActiveStatus,
  type ProxyCandidate,
} from "@/types/network/proxy"

const log = loggers.network

// ---------------------------------------------------------------------------
// React hook + helpers consumed by the settings UI.
// ---------------------------------------------------------------------------

/** React hook returning the typed `NetworkProxySettings` (with defaults). */
export function useNetworkProxy(): NetworkProxySettings {
  const stored = useSettingsStore((s) => s.settings?.networkProxy)
  return stored ?? DEFAULT_NETWORK_PROXY_SETTINGS
}

/** Non-hook accessor — for IPC plumbing & tests. */
export function getNetworkProxy(): NetworkProxySettings {
  return useSettingsStore.getState().settings?.networkProxy ?? DEFAULT_NETWORK_PROXY_SETTINGS
}

// ---------------------------------------------------------------------------
// Push to Rust — keeps `proxy_config::current()` in sync with the UI.
// ---------------------------------------------------------------------------

let lastPushedSerialized: string | null = null

/**
 * Send the latest proxy config to the Rust `proxy_config::set_current`
 * apply command. Cheap to call repeatedly — short-circuits when the serialized
 * payload hasn't changed since the last push. No-op outside Tauri and in
 * least-privilege secondary windows, where process-level proxy commands are
 * intentionally unavailable.
 */
export async function applyProxyToRust(cfg?: NetworkProxySettings | null): Promise<void> {
  if (!isTauri() || !isMainAppWindow()) return
  const source = (cfg ?? getNetworkProxy()) as LegacyNetworkProxySettings
  // Native proxy_apply resolves credentials only when the policy needs them.
  // A presence check here would make even direct traffic depend on keychain
  // availability during startup. Touch keyring only for an actual legacy row.
  const migration = source.password === undefined ? null : await migrateLegacyProxyPassword(source)
  const settings = migration?.settings ?? source
  const payload = {
    mode: settings.mode,
    protocol: settings.protocol,
    host: settings.host,
    port: settings.port,
    username: settings.username ?? null,
    bypass: settings.bypass,
    proxy_websockets: settings.proxyWebsockets,
  }
  const serialized = JSON.stringify(payload)
  if (serialized === lastPushedSerialized) return
  await invoke("proxy_apply", { input: payload })
  lastPushedSerialized = serialized
  notifyNetworkProxyApplied()

  if (migration?.migrated) {
    // Persist the sanitized row only after both keyring verification and the
    // atomic native apply succeed. The recursive apply triggered by `save` is
    // deduped by the marker above.
    await useSettingsStore.getState().save({ networkProxy: settings })
  }

  if (isProxyActive(settings)) {
    log.debug(`Applied proxy endpoint ${settings.protocol}://${settings.host}:${settings.port}`)
  } else {
    log.debug("Applied explicit direct network policy")
  }
}

/** Update only the keyring-backed password, then atomically rebuild native state. */
export async function updateProxyPassword(mutation: ProxyPasswordMutation): Promise<boolean> {
  if (!isTauri() || !isMainAppWindow()) return false
  const configured = await applyProxyPasswordMutation(mutation)
  lastPushedSerialized = null
  await applyProxyToRust()
  return configured
}

/** Read sanitized native state for the settings UI and diagnostics. */
export async function getProxyRuntimeStatus(): Promise<ProxyActiveStatus> {
  if (!isTauri() || !isMainAppWindow()) {
    return { state: "ready", credentialConfigured: false }
  }
  return invoke<ProxyActiveStatus>("proxy_get_active")
}

/** Test-only — clears the dedupe cache so subsequent applyProxyToRust pushes. */
export function resetApplyProxyDedupeForTesting(): void {
  lastPushedSerialized = null
}

// ---------------------------------------------------------------------------
// Startup auto-detect — makes `mode: "auto"` a live setting, not a label.
// ---------------------------------------------------------------------------

/**
 * When the persisted proxy mode is `auto`, re-run local detection at boot and
 * adopt the top candidate if its host/port differs from what's stored. Proxy
 * clients (Clash, V2Ray, …) can pick a different port between launches, so an
 * `auto` config that was pinned once would otherwise silently break.
 *
 * No-op outside Tauri, in least-privilege secondary windows, when mode isn't
 * `auto`, or when detection finds nothing (the previously-stored host is left
 * untouched rather than wiped). Never throws — a failed probe just leaves the
 * config as-is.
 */
export async function maybeAutoDetectProxy(): Promise<void> {
  if (!isTauri() || !isMainAppWindow()) return
  const cfg = getNetworkProxy()
  if (cfg.mode !== "auto") return
  try {
    const candidates = await invoke<ProxyCandidate[]>("proxy_detect")
    const best = candidates?.find((candidate) => candidate.verified === true)
    if (!best) return
    if (best.host === cfg.host && best.port === cfg.port) return
    const next: NetworkProxySettings = {
      ...cfg,
      protocol: best.kind === "socks5" ? "socks5" : "http",
      host: best.host,
      port: best.port,
      lastDetectedAt: Date.now(),
    }
    await useSettingsStore.getState().save({ networkProxy: next })
    log.debug(`Auto-detect adopted proxy ${best.host}:${best.port}`)
  } catch (err) {
    log.warn(`Auto-detect failed: ${String(err)}`)
  }
}
