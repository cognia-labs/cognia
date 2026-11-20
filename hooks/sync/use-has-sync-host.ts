"use client"

/**
 * Whether this device has a host to pull companion sync from.
 *
 * Sync mirrors a paired host, so with none there is nothing any table could
 * do, and the scheduler deliberately records no per-table error for that case
 * (`no_host`). Every sync status surface (the `/me/sync` page, the companion
 * settings card) therefore needs this as a separate input to its verdict, or
 * an unpaired device reads as "never synced" or, worse, "healthy".
 *
 * Reads `loadCompanionConfig()` and re-reads it on the
 * `cognia:companion-config-changed` window event, which
 * `notifyCompanionConfigChanged` (lib/tauri/transport-companion) fires on
 * every pair, unpair and target switch.
 */

import { useSyncExternalStore } from "react"

import { loadCompanionConfig } from "@/lib/tauri/transport-companion"

export const COMPANION_CONFIG_EVENT = "cognia:companion-config-changed"

function subscribeCompanionConfig(onChange: () => void): () => void {
  window.addEventListener(COMPANION_CONFIG_EVENT, onChange)
  return () => window.removeEventListener(COMPANION_CONFIG_EVENT, onChange)
}

function readHasSyncHost(): boolean {
  return loadCompanionConfig() !== null
}

export function useHasSyncHost(): boolean {
  return useSyncExternalStore(subscribeCompanionConfig, readHasSyncHost, () => false)
}
