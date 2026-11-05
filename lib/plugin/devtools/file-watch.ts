/**
 * In-app plugin file watcher.
 *
 * Replaces the 546-line `hot-reload.ts`, which had no production caller: its
 * only importers were the retired DevTools panel and two modules that were
 * themselves unreachable. The Rust watcher it was built on is real
 * (`plugin_watch_start` holds a `notify::RecommendedWatcher` and emits
 * `plugin:file-change`), so this module keeps that capability and drops the
 * dead scaffolding around it.
 *
 * What it does: watch the install directories of locally-sourced plugins and,
 * after a debounce, put each changed plugin through the same verified reload
 * the CLI uses (`pluginDevReload`), which only reports success once the
 * lifecycle coordinator reports a new active generation.
 *
 * What it deliberately does NOT do: build anything. The app has no compiler.
 * That is why `wasm` and `vscode-extension` plugins are reported as
 * `needs-build` rather than watched. A source edit for those produces no new
 * artifact, so reloading would re-activate the same bytes and look like a
 * hot reload that changed nothing. Those runtimes need `cognia plugin dev`,
 * which builds and installs before asking for the reload.
 *
 * During Managed IDE Dev Mode it also watches the plugin folders registered
 * there, in place of those plugins' installed copies: an edit in the folder
 * first reinstalls the plugin from it (`syncDevFolder`, which also renews its
 * `local-dev` receipt), then reloads it, and the reload activates a temporary
 * Pro IDE proxy rather than committing one.
 *
 * A plugin installed with "Load unpacked" is watched the same way in the
 * folder it was loaded from (`syncUnpackedSource`), since the installed copy
 * is not what its author edits.
 *
 * Reloads of one plugin never overlap: a save that lands mid-reload is replayed
 * once afterwards. An installer swapping a watched install copy is not a save
 * (`isInstallSwap`), since the installer reloads the plugin itself.
 */

import type { Plugin } from "@/types/plugin"
import { isTauri } from "@/lib/tauri"
import {
  pluginDevReload,
  type PluginDevReloadResult,
} from "@/lib/cli-bridge/handlers/plugin-dev-reload"
import { devFolders } from "@/lib/plugin/ide/dev-mode"
import { recordHotReloadEvent } from "@/stores/plugin-runtime/hot-reload-history-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { loggers } from "../core/logger"

/** The event the Rust watcher emits. It carries no plugin id, only a path. */
export const FILE_CHANGE_EVENT = "plugin:file-change"

/** Marks history rows this watcher produced, as opposed to the CLI's. */
export const APP_WATCH_SOURCE = "app"

/** Matches the old module's debounce so rapid saves still coalesce. */
export const DEFAULT_DEBOUNCE_MS = 300

export interface PluginFileChangePayload {
  type: "create" | "modify" | "delete" | "rename"
  path: string
  timestamp: number
}

export type WatchIneligibility =
  /** No compiler in the app, so a source edit yields no new artifact. */
  | "needs-build"
  /** Installed from a package, so there is no source tree on disk to watch. */
  | "not-local-source"
  /** The watcher is a Tauri command. */
  | "desktop-required"

export type WatchEligibility =
  { watchable: true } | { watchable: false; reason: WatchIneligibility }

/** Runtimes whose on-disk artifact is not the source the author edits. */
const NEEDS_BUILD = new Set<Plugin["manifest"]["type"]>(["wasm", "vscode-extension"])
/** Sources that have an author-owned directory on disk. */
const LOCAL_SOURCES = new Set<Plugin["source"]>(["dev", "local"])

/**
 * Whether this watcher can do anything useful for a plugin, and if not, why.
 *
 * Exported because the reason is shown in the UI: a plugin that silently never
 * reloads is indistinguishable from a broken watcher.
 */
export function watchEligibility(
  plugin: Pick<Plugin, "source" | "manifest">,
  isDesktop: boolean
): WatchEligibility {
  if (!isDesktop) return { watchable: false, reason: "desktop-required" }
  if (!LOCAL_SOURCES.has(plugin.source)) {
    return { watchable: false, reason: "not-local-source" }
  }
  if (NEEDS_BUILD.has(plugin.manifest.type)) {
    return { watchable: false, reason: "needs-build" }
  }
  return { watchable: true }
}

/**
 * What a watched folder is, which decides what happens before a reload.
 *
 * - `install`: the installed copy. Reloaded as it is.
 * - `dev-folder`: a Managed IDE Dev Mode folder, reinstalled before each reload.
 * - `unpacked-source`: the folder a plugin was "Load unpacked" from, reinstalled
 *   before each reload (see `lib/plugin/local/unpacked-sources`).
 */
export type WatchedVia = "install" | "dev-folder" | "unpacked-source"

export interface WatchedRoot {
  pluginId: string
  root: string
  via: WatchedVia
}

/**
 * Map a changed path back to a plugin by longest matching install root.
 *
 * The previous implementation guessed with a `/plugins/<id>/` regex and then
 * fell back to `filePath.includes(pluginId)`, which credits the wrong plugin
 * whenever one id is a substring of another or a path merely mentions an id.
 * The roots are known exactly here, so nothing needs guessing.
 */
export function resolveWatchedPluginId(
  roots: readonly Pick<WatchedRoot, "pluginId" | "root">[],
  changedPath: string
): string | null {
  return resolveWatchedRoot(roots, changedPath)?.pluginId ?? null
}

function resolveWatchedRoot<T extends Pick<WatchedRoot, "pluginId" | "root">>(
  roots: readonly T[],
  changedPath: string
): T | null {
  let best: T | null = null
  for (const candidate of roots) {
    if (!isUnder(changedPath, candidate.root)) continue
    if (!best || candidate.root.length > best.root.length) best = candidate
  }
  return best
}

/**
 * Whether a change is an installer replacing a watched install copy.
 *
 * Every installer (`cognia plugin dev`, Load unpacked, updates) stages a tree
 * and renames it over the plugin directory, which the native watcher reports
 * as events on the directory itself, while an edit inside it reports the file.
 * The installer reloads the plugin itself, so answering the swap with a second
 * reload only repeated the work, once per `cognia plugin dev` build while this
 * watch was on.
 */
export function isInstallSwap(
  root: Pick<WatchedRoot, "root" | "via">,
  changedPath: string
): boolean {
  return root.via === "install" && trimSeparator(changedPath) === trimSeparator(root.root)
}

function trimSeparator(path: string): string {
  return path.endsWith("/") || path.endsWith("\\") ? path.slice(0, -1) : path
}

function isUnder(changedPath: string, root: string): boolean {
  if (changedPath === root) return true
  const normalizedRoot = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root
  return (
    changedPath.startsWith(`${normalizedRoot}/`) || changedPath.startsWith(`${normalizedRoot}\\`)
  )
}

export interface PluginFileWatchDependencies {
  isDesktop: () => boolean
  startWatch: (paths: string[]) => Promise<void>
  stopWatch: () => Promise<void>
  listen: (
    event: string,
    handler: (payload: PluginFileChangePayload) => void
  ) => Promise<() => void>
  reload: (pluginId: string, attempt: number, sessionId: string) => Promise<PluginDevReloadResult>
  /** Managed IDE Dev Mode plugin folders (empty outside Dev Mode). */
  devFolders: () => Array<{ path: string; pluginId: string }>
  /** Reinstall a plugin from its Dev Mode folder, ahead of its reload. */
  syncDevFolder: (path: string) => Promise<void>
  /** "Load unpacked" folders still trusted for these plugins. */
  unpackedSources: (pluginIds: string[]) => Promise<Array<{ pluginId: string; sourceDir: string }>>
  /** Reinstall a plugin from its "Load unpacked" folder, ahead of its reload. */
  syncUnpackedSource: (pluginId: string, sourceDir: string) => Promise<void>
  record: typeof recordHotReloadEvent
  now: () => number
  debounceMs: number
  /** Stable id for this watcher run, echoed into every reload request. */
  sessionId: string
}

export interface PluginFileWatchHandle {
  /** Plugin ids this run is actually watching. */
  watchedPluginIds: string[]
  /** Each watched folder and what it is, so the UI can say where it looks. */
  roots: WatchedRoot[]
  stop: () => Promise<void>
}

/**
 * Start watching. Returns a handle even when nothing is eligible, so a caller
 * can render "watching 0 of 3" instead of failing.
 */
export async function startPluginFileWatch(
  plugins: readonly Plugin[],
  overrides: Partial<PluginFileWatchDependencies> = {}
): Promise<PluginFileWatchHandle> {
  const deps = { ...defaultDependencies(), ...overrides }
  const folders = deps.isDesktop() ? deps.devFolders() : []
  // A plugin with a Dev Mode folder is watched there, not in its install:
  // syncing writes the install, which must not trigger a second reload.
  const fromFolder = new Set(folders.map((folder) => folder.pluginId))
  const roots: WatchedRoot[] = folders.map((folder) => ({
    pluginId: folder.pluginId,
    root: folder.path,
    via: "dev-folder",
  }))
  const eligible = plugins.filter(
    (plugin) =>
      !fromFolder.has(plugin.manifest.id) && watchEligibility(plugin, deps.isDesktop()).watchable
  )
  // An unpacked plugin is watched in the folder it was loaded from, which is
  // what its author edits; the installed copy is the installer's.
  const unpacked = new Map(
    (await deps.unpackedSources(eligible.map((plugin) => plugin.manifest.id))).map((entry) => [
      entry.pluginId,
      entry.sourceDir,
    ])
  )
  for (const plugin of eligible) {
    const sourceDir = unpacked.get(plugin.manifest.id)
    if (sourceDir) {
      roots.push({ pluginId: plugin.manifest.id, root: sourceDir, via: "unpacked-source" })
    } else if (plugin.path) {
      roots.push({ pluginId: plugin.manifest.id, root: plugin.path, via: "install" })
    }
  }

  if (roots.length === 0) {
    return { watchedPluginIds: [], roots: [], stop: async () => {} }
  }

  await deps.startWatch(roots.map((entry) => entry.root))

  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const attempts = new Map<string, number>()
  // One reload per plugin at a time. A save that settles while that plugin is
  // still reloading is remembered and replayed once, after it finishes: running
  // it alongside would overlap two teardown/activation sequences of the same
  // plugin, and dropping it would leave the edit unloaded.
  const reloading = new Set<string>()
  const changedDuringReload = new Set<string>()
  let stopped = false

  const unlisten = await deps.listen(FILE_CHANGE_EVENT, (payload) => {
    if (stopped) return
    const root = resolveWatchedRoot(roots, payload.path)
    if (!root || isInstallSwap(root, payload.path)) return
    const pluginId = root.pluginId

    const existing = pending.get(pluginId)
    if (existing) clearTimeout(existing)
    pending.set(
      pluginId,
      setTimeout(() => {
        pending.delete(pluginId)
        if (reloading.has(pluginId)) {
          changedDuringReload.add(pluginId)
          return
        }
        void runReload(pluginId)
      }, deps.debounceMs)
    )
  })

  async function runReload(pluginId: string): Promise<void> {
    if (stopped) return
    reloading.add(pluginId)
    try {
      await reloadOnce(pluginId)
    } finally {
      reloading.delete(pluginId)
    }
    if (!stopped && changedDuringReload.delete(pluginId)) void runReload(pluginId)
  }

  async function reloadOnce(pluginId: string): Promise<void> {
    const attempt = (attempts.get(pluginId) ?? 0) + 1
    attempts.set(pluginId, attempt)
    deps.record({
      pluginId,
      source: APP_WATCH_SOURCE,
      kind: "hot-reload",
      status: "in-progress",
      timestamp: deps.now(),
    })
    try {
      const root = roots.find((entry) => entry.pluginId === pluginId)
      if (root?.via === "dev-folder") await deps.syncDevFolder(root.root)
      if (root?.via === "unpacked-source") await deps.syncUnpackedSource(pluginId, root.root)
      const result = await deps.reload(pluginId, attempt, deps.sessionId)
      deps.record({
        pluginId,
        source: APP_WATCH_SOURCE,
        kind: "hot-reload",
        status: result.ok ? "success" : "failed",
        timestamp: deps.now(),
        ...(result.error ? { note: result.error.message } : {}),
      })
    } catch (error) {
      // A throw here is the watcher failing, not the plugin. Recording it as a
      // failed row is what tells the author the difference between "my plugin
      // is broken" and "nothing is watching any more".
      const message = error instanceof Error ? error.message : String(error)
      loggers.hotReload.warn(`[file-watch] reload threw for ${pluginId}`, { error: message })
      deps.record({
        pluginId,
        source: APP_WATCH_SOURCE,
        kind: "hot-reload",
        status: "failed",
        timestamp: deps.now(),
        note: message,
      })
    }
  }

  return {
    watchedPluginIds: roots.map((entry) => entry.pluginId),
    roots: roots.map((entry) => ({ ...entry })),
    stop: async () => {
      stopped = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      changedDuringReload.clear()
      unlisten()
      await deps.stopWatch()
    },
  }
}

function defaultDependencies(): PluginFileWatchDependencies {
  return {
    isDesktop: isTauri,
    startWatch: async (paths) => {
      const { invoke } = await import("@tauri-apps/api/core")
      // `plugin_watch_start(app, args: WatchStartArgs)` takes a single struct
      // parameter, so Tauri reads it from the `args` key. The module this
      // replaces sent a flat `{ paths }`, which leaves `args` absent and the
      // command rejects before any watcher is created.
      await invoke("plugin_watch_start", { args: { paths } })
    },
    stopWatch: async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_watch_stop")
    },
    listen: async (event, handler) => {
      const { listen } = await import("@tauri-apps/api/event")
      const { safeUnlisten } = await import("@/lib/tauri/safe-unlisten")
      const off = await listen<PluginFileChangePayload>(event, (e) => handler(e.payload))
      return () => safeUnlisten(off)
    },
    reload: (pluginId, attempt, sessionId) =>
      pluginDevReload({
        schemaVersion: 1,
        sessionId,
        attempt,
        pluginId,
        // The app does not build, so there is no content hash to send. This
        // marks which filesystem change triggered the reload, and it is what
        // the workbench shows in place of a built artifact revision.
        artifactRevision: `local-fs:${Date.now()}`,
        activate: true,
      }),
    devFolders,
    syncDevFolder: async (path) => {
      const { installPluginFromDirectory } =
        await import("@/lib/plugin/local/install-from-directory")
      await installPluginFromDirectory(path)
    },
    unpackedSources: async (pluginIds) => {
      const { listWatchableUnpackedSources } = await import("@/lib/plugin/local/unpacked-sources")
      return listWatchableUnpackedSources(pluginIds)
    },
    syncUnpackedSource: async (pluginId, sourceDir) => {
      const installed = usePluginStore.getState().plugins[pluginId]?.manifest
      if (!installed) throw new Error(`Plugin not found: ${pluginId}`)
      const { resyncUnpackedSource } = await import("@/lib/plugin/local/unpacked-sources")
      await resyncUnpackedSource(pluginId, sourceDir, installed)
    },
    record: recordHotReloadEvent,
    now: () => Date.now(),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    sessionId: `app-watch:${Math.random().toString(36).slice(2)}`,
  }
}
