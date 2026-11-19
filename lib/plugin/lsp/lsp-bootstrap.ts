"use client"

/**
 * App-startup bootstrap for the standalone-LSP pathway (Phase B of
 * the VS Code LSP reuse work — see
 * `~/.claude/plans/vscode-lsp-mighty-robin.md`).
 *
 * Wiring sequence:
 *
 *   1. Construct the production `LspClientAdapter` (Tauri) + a thin
 *      `LspBridgeAdapter` over the existing `monaco-bridge.setDiagnostics`.
 *   2. Call `configureLspRegistry({ client, bridge, ... })`.
 *   3. Subscribe to the settings store so any change to `settings.lsp`
 *      triggers `syncUserLspServers`.
 *   4. Apply the initial settings snapshot once on bootstrap.
 *
 * The bootstrap is idempotent — repeated calls return the same
 * disposer. Production code calls it once during app init; tests
 * exercise individual layers in isolation.
 *
 * Why we depend on `monaco-bridge` indirectly (via `setDiagnostics`):
 * the bridge is already configured during the VS Code loader's
 * `ensureDispatcherConfigured` step (see `lib/plugin/core/vscode-loader.ts`).
 * The LSP registry hands diagnostics directly to that exported
 * function — no second `configureMonacoBridge` call.
 */

import {
  getEditorById,
  onEditorChange,
  setDiagnostics,
} from "@/lib/plugin/vscode-shim/monaco-bridge"
import { listWorkspaceFolders } from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import { isWorkspaceRestricted } from "@/lib/workspace/trust-gate"
import { watchRoot } from "@/lib/plugin/vscode-shim/root-watchers"
import { liveQuery } from "dexie"
import { listTrustedWorkspaces } from "@/lib/db/trusted-workspaces"
import type { LspServerConfig } from "@/types/lsp/config"
import { configureLspRegistry, type LspBridgeAdapter, type LspClientAdapter } from "./lsp-registry"
import { editorEligibleServers, syncUserLspServers } from "./lsp-user-servers"
import { getSystemLspClient } from "./lsp-client-adapter-tauri"

interface BootstrapDeps {
  /** Override the production adapter — used by tests. */
  client?: LspClientAdapter
  /** Override the bridge — used by tests. */
  bridge?: LspBridgeAdapter
  /**
   * Override the resolved editor-server list source — used by tests. Returns
   * the already-filtered list the editor should run (see
   * `editorEligibleServers`).
   */
  resolveEditorServers?: () => Promise<LspServerConfig[]>
  /**
   * Override the change subscription — used by tests. Fires the callback
   * whenever `settings.lsp` or the active project changes.
   */
  subscribeChanges?: (cb: () => void) => () => void
  /** Override the workspace-folder resolver — used by tests. */
  resolveWorkspaceFolders?: () => Array<{ uri: string; name: string }>
  /** Override `Date.now()` — used by tests. */
  now?: () => number
}

let installed = false
let disposers: Array<() => void> = []
let refreshServers: ((restart?: boolean) => Promise<void>) | undefined

/** Reconcile on the newly authorized host while keeping open document state. */
export async function refreshEditorLspServers(restart = false): Promise<void> {
  await refreshServers?.(restart)
}

/**
 * Wire the LSP pipeline. Returns a disposer that tears down every
 * registration; production never tears it down (one-shot at boot).
 *
 * Calling twice without disposing first is a no-op — the previous
 * disposer is returned.
 */
export function bootstrapLspRegistry(deps: BootstrapDeps = {}): () => void {
  if (installed) {
    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* swallow */
        }
      }
      disposers = []
      installed = false
    }
  }

  const client =
    deps.client ??
    (() => {
      const a = getSystemLspClient()
      a.install()
      return a
    })()

  const bridge: LspBridgeAdapter = deps.bridge ?? {
    setDiagnostics: (input) => {
      setDiagnostics({
        extensionId: input.extensionId,
        uri: input.uri,
        markers: input.markers,
      })
    },
    onEditorChange,
    getEditorById,
  }

  const resolveWorkspaceFolders =
    deps.resolveWorkspaceFolders ??
    (() => listWorkspaceFolders().map((f) => ({ uri: f.uri, name: f.name })))

  const registryDispose = configureLspRegistry({
    client,
    bridge,
    resolveWorkspaceFolders,
    now: deps.now ?? Date.now,
  })
  disposers.push(() => {
    void registryDispose()
  })

  // Unified LSP → editor sync. Resolve the layered server list (builtin ←
  // user ← project), keep the editor-eligible ones, and converge the
  // registry. Re-run whenever settings.lsp or the active project changes.
  const resolveEditorServers = deps.resolveEditorServers ?? defaultResolveEditorServers
  let revision = 0
  let applying = Promise.resolve()
  let restartRequested = false

  const applyEditorServers = (restart = false) => {
    restartRequested ||= restart
    const ticket = ++revision
    return resolveEditorServers()
      .then((servers) => {
        applying = applying
          .catch(() => undefined)
          .then(async () => {
            if (ticket !== revision) return
            if (restartRequested) {
              restartRequested = false
              await syncUserLspServers([])
            }
            if (ticket === revision) await syncUserLspServers(servers)
          })
        return applying
      })
      .catch(() => {
        /* resolution / registration failures are non-fatal */
      })
  }

  refreshServers = applyEditorServers
  void applyEditorServers()

  const subscribeFn = deps.subscribeChanges ?? defaultSubscribeChanges
  const unsubscribe = subscribeFn(() => {
    void applyEditorServers()
  })
  disposers.push(() => {
    revision += 1
    refreshServers = undefined
    unsubscribe()
  })

  installed = true
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* swallow */
      }
    }
    disposers = []
    installed = false
  }
}

/** Primary root dir of the active project, or undefined when none is active. */
function activeProject() {
  const { projects, activeProjectId } = useProjectStore.getState()
  return projects.find((p) => p.id === activeProjectId)
}

/** Production resolver: layer builtin ← settings.lsp ← project `.cognia/lsp.json`. */
async function defaultResolveEditorServers(): Promise<LspServerConfig[]> {
  const settings = useSettingsStore.getState().settings
  // `settings.lsp.enabled` is the master toggle for the WHOLE subsystem (agent
  // tools + editor). `lib/claude/build-options.ts` already gates the agent
  // runtime on it; the editor plane used to ignore it, so switching the
  // subsystem off in Settings → Language Servers still left every editor
  // server running.
  //
  // Only an EXPLICIT `false` stops the editor. `undefined` keeps the editor's
  // long-standing default (servers run for Skills / Canvas / Artifact editors)
  // — the agent's `?? builtinTools.lsp ?? false` ladder is about handing LSP
  // *tools to the model*, and borrowing that default here would have silently
  // switched editor completion and diagnostics off for every existing user.
  if (settings?.lsp?.enabled === false) return []
  const project = activeProject()
  if (
    await isWorkspaceRestricted(project, {
      enabled: settings?.workspaceTrust?.enabled !== false,
      onWeb: false,
    })
  )
    return []
  const resolved = await resolveLspServers({
    rootDir: project ? primaryRootOf(project)?.path : undefined,
    userServers: settings?.lsp?.servers,
    readProjectFile: readProjectLspFile,
  })
  return editorEligibleServers(resolved)
}

/** Default subscription — fires the callback whenever `settings.lsp` or the
 *  active project changes. Reference equality tracks "did the user edit"
 *  because the settings store re-creates the object on every save. */
function defaultSubscribeChanges(cb: () => void): () => void {
  let prevLsp = useSettingsStore.getState().settings?.lsp
  let prevTrust = useSettingsStore.getState().settings?.workspaceTrust?.enabled
  let prevProject = activeProject()
  let stopWatching: (() => void) | undefined
  const rebindWatcher = () => {
    stopWatching?.()
    const root = prevProject && primaryRootOf(prevProject)?.path
    stopWatching = root
      ? watchRoot(root, ({ path }) => {
          if (path.endsWith("/.cognia/lsp.json") || path.endsWith("/.cognia")) cb()
        })
      : undefined
  }
  rebindWatcher()
  const trust = liveQuery(listTrustedWorkspaces).subscribe({ next: cb, error: () => cb() })
  const unsubSettings = useSettingsStore.subscribe((state) => {
    const nextLsp = state.settings?.lsp
    const nextTrust = state.settings?.workspaceTrust?.enabled
    if (nextLsp !== prevLsp || nextTrust !== prevTrust) {
      prevLsp = nextLsp
      prevTrust = nextTrust
      cb()
    }
  })
  const unsubProject = useProjectStore.subscribe(() => {
    const project = activeProject()
    if (project !== prevProject) {
      prevProject = project
      rebindWatcher()
      cb()
    }
  })
  return () => {
    unsubSettings()
    unsubProject()
    stopWatching?.()
    trust.unsubscribe()
  }
}

/** Test helper — clears `installed`. Production never resets. */
export function __resetLspBootstrapForTesting(): void {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* swallow */
    }
  }
  disposers = []
  installed = false
}
