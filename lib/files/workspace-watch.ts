// Desktop filesystem watcher for the project editor. Reuses the exact
// `plugin_fs_watch` contract the plugin runtime uses (`lib/plugin/core/
// context.ts`): a recursive `notify` watch keyed by `watchId`, emitting
// `plugin-fs-watch:<watchId>` CustomEvents on `window` with a `{ kind, path }`
// detail. Desktop-only — on web/mobile there is no local disk to watch, so the
// watcher is a no-op and the file tree relies on manual refresh.

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

const log = createLogger("workspace-watch")

export interface WorkspaceFsChange {
  kind: "create" | "modify" | "delete" | "any"
  /** Absolute path of the changed entry. */
  path: string
}

export interface WatchWorkspaceOptions {
  /** Fired if native watcher registration fails so callers can degrade to polling. */
  onError?: (error: unknown) => void
}

/** Reserved owner id — `plugin_fs_watch` only uses it for log namespacing. */
const WATCH_OWNER = "__project-editor__"

let watchCounter = 0

/**
 * Watch `root` recursively for filesystem changes (agents / terminal writing
 * into the project). `onChange` fires per changed path under `root`. Returns a
 * disposer that stops the watch. No-op (returns a no-op disposer) off desktop.
 */
export function watchWorkspace(
  root: string,
  onChange: (change: WorkspaceFsChange) => void,
  options?: WatchWorkspaceOptions
): () => void {
  if (!isTauri() || isRemoteHostActive() || typeof window === "undefined") return () => {}

  watchCounter += 1
  const watchId = `${WATCH_OWNER}:${root}:${watchCounter}`

  let disposed = false
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<WorkspaceFsChange>).detail
    const path = typeof detail?.path === "string" ? detail.path.replace(/\\/g, "/") : null
    if (
      !disposed &&
      !isRemoteHostActive() &&
      path !== null &&
      (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`))
    ) {
      onChange(detail)
    }
  }
  window.addEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)

  // Register the listener before starting the native watch. Teardown waits
  // for registration: unwatching first can otherwise leak a late-created watch.
  const started = invoke("plugin_fs_watch", { pluginId: WATCH_OWNER, path: root, watchId }).then(
    () => true,
    (error: unknown) => {
      window.removeEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)
      if (!disposed) {
        log.warn("workspace fs watch registration failed; degrading to polling", {
          error: String(error),
        })
        options?.onError?.(error)
      }
      return false
    }
  )

  return () => {
    if (disposed) return
    disposed = true
    window.removeEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)
    void started.then((registered) => {
      if (registered) return invoke("plugin_fs_unwatch", { watchId }).catch(() => {})
    })
  }
}
