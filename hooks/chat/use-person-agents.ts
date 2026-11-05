"use client"

/**
 * An org member's agent choices and month on the paired shared Host (P6g).
 *
 * The facts arrive on the member's `host_feature_manifest` (`personAgents`),
 * negotiated when the device connects. Spend moves with every turn, so the
 * composer asks again when it shows them: `refresh` re-reads the manifest and
 * patches only this field into the runtime snapshot, leaving the negotiated
 * operations and grants alone.
 */

import { useCallback, useSyncExternalStore } from "react"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  parseHostFeatureManifest,
  type PersonAgentsManifest,
} from "@/lib/platform/host-feature-manifest"
import { getRuntimeSnapshot, updateRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"

export interface PersonAgentsDeps {
  /** The paired Host's `host_feature_manifest` answer. */
  readManifest?: () => Promise<unknown>
}

async function defaultReadManifest(): Promise<unknown> {
  const { transport } = await import("@/lib/tauri")
  return transport.call("host_feature_manifest", {})
}

/**
 * Whether the last re-read failed. The snapshot then still holds the answer
 * before it, which the composer shows as possibly out of date rather than as
 * current (ADR-0253 G10).
 */
let refreshFailed = false
const failureListeners = new Set<() => void>()
function setRefreshFailed(next: boolean) {
  if (refreshFailed === next) return
  refreshFailed = next
  for (const listener of failureListeners) listener()
}
function subscribeRefreshFailed(listener: () => void) {
  failureListeners.add(listener)
  return () => {
    failureListeners.delete(listener)
  }
}

/** Test seam: forget a failure a previous test left behind. */
export function __resetPersonAgentsRefreshForTesting(): void {
  setRefreshFailed(false)
}

/**
 * Re-read the member's agents into the snapshot.
 *
 * A Host that no longer declares them (execution turned off, the member's
 * agents withdrawn) clears them: the last answer is not kept as if it were
 * still true. A read that fails or answers something unreadable keeps the
 * last answer but is recorded, so the composer can say it may be stale.
 */
export async function refreshPersonAgents(deps: PersonAgentsDeps = {}): Promise<void> {
  if (!getRuntimeSnapshot().host?.personPartition) return
  let manifest
  try {
    manifest = parseHostFeatureManifest(await (deps.readManifest ?? defaultReadManifest)())
  } catch (error) {
    console.warn("[person-agents] host_feature_manifest read failed", error)
    setRefreshFailed(true)
    return
  }
  if (manifest?.schemaVersion !== 2) {
    setRefreshFailed(true)
    return
  }
  // A Host that is no longer this member's partition answers for someone
  // else; the next connect renegotiates the snapshot.
  if (manifest.personPartition !== true) return
  // Re-read after the await: the device may have switched Hosts meanwhile.
  const host = getRuntimeSnapshot().host
  if (!host?.personPartition) return
  setRefreshFailed(false)
  const personAgents = manifest.personAgents
  if (personAgents) {
    updateRuntimeSnapshot({ host: { ...host, personAgents } })
    return
  }
  if (host.personAgents === undefined) return
  const { personAgents: _withdrawn, ...rest } = host
  updateRuntimeSnapshot({ host: rest })
}

export function usePersonAgents(deps: PersonAgentsDeps = {}): {
  /** `null` unless the paired Host is this member's partition and declared them. */
  agents: PersonAgentsManifest | null
  /** The last re-read failed: `agents` is the answer before it. */
  refreshFailed: boolean
  refresh: () => Promise<void>
} {
  const host = useRuntimeSnapshot().host
  const failed = useSyncExternalStore(
    subscribeRefreshFailed,
    () => refreshFailed,
    () => false
  )
  const { readManifest } = deps
  const refresh = useCallback(() => refreshPersonAgents({ readManifest }), [readManifest])
  const agents = host?.personPartition ? (host.personAgents ?? null) : null
  return { agents, refreshFailed: agents !== null && failed, refresh }
}
