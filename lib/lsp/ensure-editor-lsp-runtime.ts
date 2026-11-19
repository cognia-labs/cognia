/**
 * Startup wiring for the editor LSP data plane.
 *
 * The editor-side `TauriLspClientAdapter` sends every `lsp:*` RPC over the
 * fixed channel `cognia.lsp-service` (`LSP_TAURI_CHANNEL_ID`). Two things must
 * be alive for that plane to work, and neither happens on a default install:
 *
 *   1. A sidecar registered under `cognia.lsp-service` in the Rust
 *      `VscodeExtensionState` — spawned by the `ensure_system_lsp_host`
 *      command (the headless `vscode-ext-host` process). Without it every
 *      `lsp:*` RPC returns `not_loaded`.
 *   2. The renderer dispatcher + monaco-bridge + LSP registry, wired by
 *      `ensureDispatcherConfigured()` — which otherwise runs ONLY when a real
 *      `.vsix` VS Code extension loads.
 *
 * This module brings both up once per execution host. It is
 * mounted via `EditorLspRuntimeInitializer` inside `DesktopOnlyInitializers`.
 * The agent-runtime LSP (the model's `lsp_*` tools) is a separate in-process
 * path in the sidecar and is unaffected by this wiring.
 */

import { isTauri, transport } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getRemoteLspTransport, waitForLspEventStream } from "@/lib/lsp/host-transport"
import { loggers } from "@cognia/logging"
import {
  authorizeRemoteLspHost,
  callLspHost,
  LSP_TAURI_CHANNEL_ID,
} from "@/lib/plugin/lsp/lsp-client-adapter-tauri"

const log = loggers.plugin.child("editor-lsp-runtime")

const LOCAL_HOST = Symbol("local-lsp-host")
let startedHost: unknown | null = null
let startup: { host: unknown; promise: Promise<void> } | null = null

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface EditorLspRuntimeDeps {
  /** Tauri command invoker — injected for tests. */
  invoke?: InvokeFn
  /** Renderer dispatcher/monaco/registry bootstrap — injected for tests. */
  ensureDispatcher?: () => Promise<void>
  /** Subscribe to a sidecar→renderer push channel — injected for tests. */
  subscribe?: (channelId: string) => Promise<() => void>
  /** Runtime host gate — injected for tests. */
  hostAvailable?: () => boolean
  /** Active execution-host identity — injected to verify remote route switches. */
  hostIdentity?: () => unknown
  /** Whether the active execution host is the remote Companion route. */
  remoteHostActive?: () => boolean
  /** Reconcile existing editor server registrations after binding a new host. */
  refreshServers?: (restart: boolean) => Promise<void>
}

/**
 * Ensure the editor LSP runtime is up on the active Host. A successful start
 * is reused until the target changes or the user explicitly reconnects.
 * A failed start is logged and leaves the guard open for a later retry.
 */
export async function ensureEditorLspRuntime(
  deps: EditorLspRuntimeDeps = {},
  reconnect = false
): Promise<void> {
  const hostAvailable =
    deps.hostAvailable ?? (() => isTauri() || isHeadlessHost() || Boolean(getRemoteLspTransport()))
  if (!hostAvailable()) return
  const activeHost = deps.hostIdentity ?? (() => getRemoteLspTransport() ?? LOCAL_HOST)
  const host = activeHost()
  if (startedHost === host && !reconnect) return
  const pendingStartup = startup
  if (pendingStartup && pendingStartup.host === host) {
    if (!reconnect) return pendingStartup.promise
    await pendingStartup.promise
    if (activeHost() === host) await ensureEditorLspRuntime(deps, true)
    return
  }

  const promise = (async () => {
    try {
      const invoke =
        deps.invoke ??
        (getRemoteLspTransport() ? callLspHost : (cmd, args) => transport.call(cmd, args))
      const ensureDispatcher =
        deps.ensureDispatcher ??
        (await import("@/lib/plugin/core/vscode-loader")).ensureDispatcherConfigured
      const subscribe =
        deps.subscribe ??
        (await import("@/lib/plugin/vscode-shim/rpc-dispatcher")).subscribeToVscodeEvents
      const remoteHostActive = deps.remoteHostActive ?? (() => Boolean(getRemoteLspTransport()))

      // Spawn on the currently-routed host before the registry emits lsp:start.
      if (activeHost() !== host) return
      await invoke(remoteHostActive() ? "lsp_host_ensure" : "ensure_system_lsp_host")
      if (activeHost() !== host) return
      await ensureDispatcher()
      // The system listener rebinds across desktop routing and browser pairing.
      await subscribe(LSP_TAURI_CHANNEL_ID)
      if (activeHost() !== host) return
      const remote = getRemoteLspTransport()
      if (remote && remote === host) await waitForLspEventStream(remote)
      if (activeHost() !== host) return
      const refresh =
        deps.refreshServers ??
        (deps.ensureDispatcher
          ? undefined
          : (await import("@/lib/plugin/lsp/lsp-bootstrap")).refreshEditorLspServers)
      await refresh?.(reconnect || (startedHost !== null && startedHost !== host))
      if (activeHost() !== host) return
      startedHost = host
    } catch (err) {
      log.warn("editor LSP runtime bootstrap failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (startup?.host === host) startup = null
    }
  })()
  startup = { host, promise }
  return promise
}

export async function connectRemoteEditorLsp(): Promise<void> {
  const host = getRemoteLspTransport()
  if (!host) return
  await authorizeRemoteLspHost()
  if (getRemoteLspTransport() !== host) throw new Error("remote LSP host changed")
  await ensureEditorLspRuntime({}, true)
  if (getRemoteLspTransport() !== host || startedHost !== host) {
    throw new Error("remote LSP host did not start")
  }
}

/** Test-only: clear the once-guard between cases. */
export function __resetEditorLspRuntimeForTesting(): void {
  startedHost = null
  startup = null
}
