// Thin wrapper around the `fs_search_workspace` Tauri command with an in-memory
// LRU so a fast typist doesn't IPC-flood the Rust side. The popover debounces
// input separately; this cache covers the common case where the user pauses
// briefly and the same query+root pair re-runs.
//
// Intentionally not a hook — keeps the search call site decoupled from React's
// lifecycle so non-component code (e.g. unit tests) can call it directly.

import { transport } from "@/lib/tauri"
import { getCompanionConfigGeneration, loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  subscribeActiveRemoteEndpoint,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { detectPlatform } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  fromRawWorkspaceEntry,
  type RawWorkspaceEntry,
  type WorkspaceEntry,
} from "@/lib/files/types"

interface CacheEntry {
  ts: number
  results: WorkspaceEntry[]
}

const CACHE_LIMIT = 32
const CACHE_TTL_MS = 30_000
const COMPANION_CONFIG_EVENT = "cognia:companion-config-changed"

const cache = new Map<string, CacheEntry>()
const remoteTransportIds = new WeakMap<object, number>()
let nextRemoteTransportId = 1
let invalidationWired = false

function remoteTransportId(remote: object): number {
  let id = remoteTransportIds.get(remote)
  if (!id) {
    id = nextRemoteTransportId++
    remoteTransportIds.set(remote, id)
  }
  return id
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/**
 * Scope key identifying the execution Host `transport.call("fs_search_workspace")`
 * currently targets, using foundation-layer transport/runtime primitives only.
 * Prevents two Hosts sharing a `root` path (e.g. `/workspace`) from colliding.
 */
function currentHostScopeKey(): string {
  const remote = typeof getActiveRemoteTransport === "function" ? getActiveRemoteTransport() : null
  if (remote) {
    const endpoint =
      typeof getActiveRemoteEndpoint === "function" ? getActiveRemoteEndpoint() : null
    const tid = remoteTransportId(remote)
    if (endpoint?.remoteHost?.id) return `remote:${endpoint.remoteHost.id}#t${tid}`
    if (endpoint?.baseUrl) {
      return `remote-endpoint:${normalizeBaseUrl(endpoint.baseUrl)}:${endpoint.deviceId}:${endpoint.accountId ?? ""}#t${tid}`
    }
    return `remote-ephemeral:#t${tid}`
  }
  const context =
    typeof getActiveRuntimeTargetContext === "function" ? getActiveRuntimeTargetContext() : null
  const cgen =
    typeof getCompanionConfigGeneration === "function" ? getCompanionConfigGeneration() : 0
  if (context) {
    return `paired:${context.accountId}:${context.targetId}#g${context.routingGeneration}:c${cgen}`
  }
  try {
    const config = typeof loadCompanionConfig === "function" ? loadCompanionConfig() : null
    if (config?.baseUrl) {
      return `paired-endpoint:${normalizeBaseUrl(config.baseUrl)}:${config.deviceId}:${config.targetId ?? ""}:${config.accountId ?? ""}#c${cgen}`
    }
  } catch {
    // Ignore unavailable storage during headless/node tests.
  }
  return "local"
}

function ensureHostInvalidationSubscribed(): void {
  if (invalidationWired) return
  invalidationWired = true
  const clear = () => cache.clear()
  if (typeof subscribeActiveRemoteTransport === "function") subscribeActiveRemoteTransport(clear)
  if (typeof subscribeActiveRemoteEndpoint === "function") subscribeActiveRemoteEndpoint(clear)
  if (typeof subscribeRuntimeTargetContext === "function") subscribeRuntimeTargetContext(clear)
  if (typeof onTransportChange === "function") onTransportChange(clear)
  if (typeof window !== "undefined") {
    window.addEventListener(COMPANION_CONFIG_EVENT, clear)
  }
}

function cacheKey(hostScope: string, root: string, query: string, limit: number): string {
  return `${hostScope}\u0000${root}\u0000${query.toLowerCase()}\u0000${limit}`
}

/**
 * Search for files/folders under `root` matching `query`. Empty query returns
 * the first `limit` walk entries. Results are cached for 30 seconds keyed on
 * `(root, lowercase query, limit)`.
 *
 * Throws if the Tauri side errors (e.g. `root` is not a directory). Callers
 * should display the error in the popover instead of crashing the composer.
 */
/**
 * Can this shell reach a workspace at all?
 *
 * True on the desktop (a local host) and on any shell whose `transport` is the
 * companion one — a phone or a browser paired to a host runs
 * `fs_search_workspace` over the wire, because it is in the companion RPC
 * catalogue (`protocol/companion-commands.json`) and advertised as the
 * `workspace.files` host feature.
 *
 * False only for a plain browser with neither. There the call rejects with
 * `WebStubTransport`'s internal message, which the composer's `@` panel used to
 * render verbatim — "tauri-only command from web mode: fs_search_workspace" in
 * the middle of the file picker. Asking first lets the panel say what is
 * actually true: pair a device and files appear.
 */
export function isWorkspaceSearchReachable(): boolean {
  return detectPlatform() !== "web" || hasWebCompanionTarget()
}

export async function searchWorkspace(
  root: string,
  query: string,
  limit = 50
): Promise<WorkspaceEntry[]> {
  ensureHostInvalidationSubscribed()
  const hostScope = currentHostScopeKey()
  const key = cacheKey(hostScope, root, query, limit)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return hit.results
  }
  const raw = await transport.call<RawWorkspaceEntry[]>("fs_search_workspace", {
    root,
    query,
    limit,
  })
  const results = raw.map(fromRawWorkspaceEntry)
  // Drop cache write if the active Host switched while the RPC was in flight.
  if (currentHostScopeKey() === hostScope) {
    cache.set(key, { ts: Date.now(), results })
    if (cache.size > CACHE_LIMIT) {
      // drop the oldest entry — Map preserves insertion order
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
  }
  return results
}

/** Test helper. Not exported from the package barrel. */
export function __resetWorkspaceSearchCache() {
  cache.clear()
}
