"use client"

/**
 * Renderer-side LSP server status store.
 *
 * One snapshot per configured server id combining:
 *   - **binary detection** (`lsp:detect` → installed / managed / missing),
 *   - **runtime health** (`lsp:status` + live `lsp:state` pushes →
 *     stopped / starting / running / crashed / broken),
 *   - **install progress** (`lsp:installProgress` pushes while a one-click
 *     install runs).
 *
 * Consumed by Settings → Language Servers (status badges + Install buttons)
 * and the editor's missing-server hint. Inert on web/mobile: every action
 * checks host availability and resolves to an empty state.
 *
 * Agent-owned runtime entries use composite serverIds (`<id>#<rootHash>`,
 * see sidecar/src/services/lsp/resolver.ts) — health rolls up by the prefix before `#`.
 */

import { create } from "zustand"
import type { LspServerStatus, LspHealthState, ResolvedLspServer } from "@/types/lsp/config"
import {
  getSystemLspClient,
  type TauriLspClientAdapter,
  type LspDetectResultEntry,
  type LspInstallProgressEvent,
  type LspRuntimeStatusEntry,
  type LspSidecarLogEntry,
} from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import { isVscodeHostAvailable } from "@/lib/plugin/core/vscode-loader"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { getRemoteLspTransport } from "@/lib/lsp/host-transport"

export interface LspStatusDeps {
  adapter: Pick<
    TauriLspClientAdapter,
    "detect" | "installServer" | "status" | "logs" | "onInstallProgress" | "onStatePush"
  >
  /** Resolve the layered server list (builtin ← user ← project). */
  resolveServers: () => Promise<ResolvedLspServer[]>
  /** Managed install root (`<appData>/lsp`); undefined off-Tauri. */
  resolveInstallDir: () => Promise<string | undefined>
  hostAvailable: () => boolean
  hostIdentity?: () => unknown
}

let deps: LspStatusDeps | null = null

/** Inject dependencies (tests) or lazily build the production set. */
export function configureLspStatusStore(next: LspStatusDeps | null): void {
  deps = next
}

function productionDeps(): LspStatusDeps {
  const adapter = getSystemLspClient()
  return {
    adapter,
    resolveServers: async () => {
      const settings = useSettingsStore.getState().settings
      const { projects, activeProjectId } = useProjectStore.getState()
      const project = projects.find((entry) => entry.id === activeProjectId)
      return resolveLspServers({
        rootDir: project ? primaryRootOf(project)?.path : undefined,
        userServers: settings?.lsp?.servers,
        readProjectFile: readProjectLspFile,
      })
    },
    resolveInstallDir: async () => {
      try {
        if (getRemoteLspTransport()) return undefined
        const { isTauri } = await import("@/lib/tauri")
        if (!isTauri()) return undefined
        const { appDataDir, join } = await import("@tauri-apps/api/path")
        return await join(await appDataDir(), "lsp")
      } catch {
        return undefined
      }
    },
    hostAvailable: () => isVscodeHostAvailable() || Boolean(getRemoteLspTransport()),
    hostIdentity: getRemoteLspTransport,
  }
}

function getDeps(): LspStatusDeps {
  if (!deps) deps = productionDeps()
  return deps
}

/** Roll several runtime entries up to one health value (most alive wins). */
const HEALTH_PRIORITY: LspHealthState[] = ["running", "starting", "crashed", "broken", "stopped"]
function rollupHealth(entries: LspRuntimeStatusEntry[]): LspHealthState {
  for (const health of HEALTH_PRIORITY) {
    if (entries.some((e) => e.state === health)) return health
  }
  return "stopped"
}

/** `typescript#a1b2` → `typescript` (agent composite ids). */
function baseServerId(serverId: string): string {
  const hash = serverId.indexOf("#")
  return hash === -1 ? serverId : serverId.slice(0, hash)
}

export interface LspStatusStoreState {
  /** serverId → combined status. Empty off-Tauri. */
  statuses: Record<string, LspServerStatus>
  installProgress: Record<string, LspInstallProgressEvent>
  refreshing: boolean
  /** Sidecar ring-buffer snapshot (newest last) for the logs dialog. */
  logs: LspSidecarLogEntry[]
  /** Re-run detect + status and merge. */
  refresh: () => Promise<void>
  /** One-click install; resolves true when the binary materialised. */
  install: (serverId: string) => Promise<boolean>
  /** Load the sidecar log ring (optionally filtered by server). */
  loadLogs: (serverId?: string) => Promise<void>
}

let pushesWired = false
let refreshRevision = 0
let lastRefreshHost: unknown

export const useLspStatusStore = create<LspStatusStoreState>((set, get) => ({
  statuses: {},
  installProgress: {},
  refreshing: false,
  logs: [],

  loadLogs: async (serverId?: string) => {
    const d = getDeps()
    if (!d.hostAvailable()) {
      set({ logs: [] })
      return
    }
    try {
      set({ logs: await d.adapter.logs(serverId ? { serverId } : {}) })
    } catch {
      set({ logs: [] })
    }
  },

  refresh: async () => {
    const d = getDeps()
    const host = d.hostIdentity?.()
    const revision = ++refreshRevision
    const current = () => revision === refreshRevision && host === d.hostIdentity?.()
    if (host !== lastRefreshHost) {
      lastRefreshHost = host
      set({ statuses: {}, installProgress: {}, logs: [] })
    }
    if (!d.hostAvailable()) {
      set({ statuses: {}, refreshing: false })
      return
    }
    if (!pushesWired) {
      pushesWired = true
      d.adapter.onInstallProgress((p) => {
        set((s) => ({ installProgress: { ...s.installProgress, [p.serverId]: p } }))
        if (p.phase === "done" || p.phase === "error") void get().refresh()
      })
      d.adapter.onStatePush((p) => {
        const id = baseServerId(p.serverId)
        set((s) => {
          const prev = s.statuses[id]
          if (!prev) return s
          return {
            statuses: {
              ...s.statuses,
              [id]: { ...prev, health: p.state, restarts: p.restarts, lastError: p.lastError },
            },
          }
        })
      })
    }
    set({ refreshing: true })
    try {
      const [servers, installDir] = await Promise.all([d.resolveServers(), d.resolveInstallDir()])
      if (!current()) return
      const [detected, runtime] = await Promise.all([
        d.adapter.detect({
          servers: servers.map((s) => ({
            serverId: s.id,
            command: s.command,
            npmPackage: s.install?.npmPackage,
            version: s.install?.version,
          })),
          installDir,
        }),
        d.adapter.status(),
      ])
      const detectedById = new Map<string, LspDetectResultEntry>(
        detected.map((entry) => [entry.serverId, entry])
      )
      const runtimeById = new Map<string, LspRuntimeStatusEntry[]>()
      for (const entry of runtime) {
        const id = baseServerId(entry.serverId)
        const bucket = runtimeById.get(id) ?? []
        bucket.push(entry)
        runtimeById.set(id, bucket)
      }
      const statuses: Record<string, LspServerStatus> = {}
      for (const server of servers) {
        const det = detectedById.get(server.id)
        const run = runtimeById.get(server.id) ?? []
        statuses[server.id] = {
          serverId: server.id,
          install: det?.status ?? "missing",
          resolvedPath: det?.resolvedPath ?? undefined,
          npmPackage: server.install?.npmPackage,
          health: run.length > 0 ? rollupHealth(run) : "stopped",
          restarts: run.reduce((max, e) => Math.max(max, e.restarts), 0),
          lastError: det?.error ?? run.find((e) => e.lastError)?.lastError,
        }
      }
      if (current()) set({ statuses, refreshing: false })
    } catch {
      if (current()) set({ statuses: {}, installProgress: {}, refreshing: false })
    }
  },

  install: async (serverId: string) => {
    const d = getDeps()
    if (!d.hostAvailable()) return false
    const [servers, installDir] = await Promise.all([d.resolveServers(), d.resolveInstallDir()])
    const server = servers.find((s) => s.id === serverId)
    if (!server?.install?.npmPackage || !installDir) return false
    set((s) => ({
      installProgress: {
        ...s.installProgress,
        [serverId]: { serverId, phase: "resolving" },
      },
    }))
    try {
      const result = await d.adapter.installServer({
        serverId,
        command: server.command,
        npmPackage: server.install.npmPackage,
        version: server.install.version,
        installDir,
      })
      await get().refresh()
      return result.status !== "missing"
    } catch {
      set((s) => ({
        installProgress: {
          ...s.installProgress,
          [serverId]: { serverId, phase: "error" },
        },
      }))
      return false
    }
  },
}))

/** Test helper — reset module singletons. */
export function __resetLspStatusStoreForTesting(): void {
  deps = null
  pushesWired = false
  refreshRevision += 1
  lastRefreshHost = undefined
  useLspStatusStore.setState({ statuses: {}, installProgress: {}, refreshing: false, logs: [] })
}
