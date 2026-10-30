/** Durable panel metadata and serializer lifecycle; HTML/resources stay with their existing owners. */
import {
  addWebview,
  getSelectedWebview,
  getWebview,
  listWebviews,
  removeWebview,
  setWebviewState,
  subscribeWebviewMutations,
  updateWebview,
  DEFAULT_WEBVIEW_OPTIONS,
  type VscodeWebviewRecord,
} from "./webview-bridge"
import { appendVscodeLog } from "./vscode-log-buffer"
import { useProjectStore } from "@/stores/project/project-store"

interface SavedPanel {
  id: string
  viewType: string
  title: string
  state?: unknown
}
export interface WebviewRestorationDependencies {
  pluginIds(): string[]
  workspaceKey(): string
  subscribeWorkspace(listener: () => void): () => void
  wantsEnabled(pluginId: string): Promise<boolean>
  activate(event: `onWebviewPanel:${string}`): Promise<void>
  read(pluginId: string, workspace: string): Promise<unknown>
  write(pluginId: string, workspace: string, panels: SavedPanel[]): Promise<void>
  callProvider(
    pluginId: string,
    method: string,
    payload: unknown,
    signal: AbortSignal
  ): Promise<unknown>
  timeoutMs?: number
}

export function createWebviewRestorationDependencies(
  input: Pick<WebviewRestorationDependencies, "pluginIds" | "wantsEnabled" | "activate">
): WebviewRestorationDependencies {
  const storage = async (id: string) =>
    (await import("@/lib/plugin/api/storage-api")).createStorageAPI(id)
  // Capture the workspace at mutation time so switching projects cannot move panel state.
  return {
    ...input,
    workspaceKey: () => useProjectStore.getState().activeProjectId ?? "global",
    subscribeWorkspace: (listener) =>
      useProjectStore.subscribe((next, previous) => {
        if (next.activeProjectId !== previous.activeProjectId) listener()
      }),
    read: async (id, workspace) => (await storage(id)).get(`vscode:webview-panels:${workspace}`),
    write: async (id, workspace, panels) =>
      (await storage(id)).set(`vscode:webview-panels:${workspace}`, { version: 1, panels }),
    callProvider: async (...args) =>
      (await import("@/lib/plugin/core/vscode-loader")).callVscodeProvider(...args),
  }
}

let deps: WebviewRestorationDependencies | undefined
let stop: (() => void) | undefined
const serializers = new Map<string, { token: string }>()
const queues = new Map<string, Promise<void>>()
const scopes = new Map<string, string>()
const removedPanels = new Set<string>()
const restoring = new Map<
  string,
  {
    pluginId: string
    workspace: string
    panelId: string
    viewType: string
    controller: AbortController
    done: Promise<void>
  }
>()
const keyOf = (pluginId: string, viewType: string) => JSON.stringify([pluginId, viewType])
const queueKey = (pluginId: string, workspace: string) => JSON.stringify([pluginId, workspace])

function saved(value: unknown): SavedPanel[] {
  const record = value as { version?: unknown; panels?: unknown } | undefined
  if (record?.version !== 1 || !Array.isArray(record.panels)) return []
  return record.panels
    .filter(
      (panel): panel is SavedPanel =>
        panel &&
        typeof panel === "object" &&
        typeof panel.id === "string" &&
        panel.id.length > 0 &&
        typeof panel.viewType === "string" &&
        panel.viewType.length > 0 &&
        typeof panel.title === "string"
    )
    .slice(0, 32)
}

function warn(pluginId: string, error: unknown): void {
  appendVscodeLog(pluginId, {
    level: "warn",
    kind: "webview",
    message: `Webview restoration failed: ${error instanceof Error ? error.message : String(error)}`,
  })
}

function mutate(
  d: WebviewRestorationDependencies,
  pluginId: string,
  workspace: string,
  change: (panels: SavedPanel[]) => SavedPanel[]
): void {
  const key = queueKey(pluginId, workspace)
  const next = (queues.get(key) ?? Promise.resolve())
    .then(async () => {
      const panels = saved(await d.read(pluginId, workspace))
      await d.write(pluginId, workspace, change(panels).slice(-32))
    })
    .catch((error: unknown) => warn(pluginId, error))
  queues.set(key, next)
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
}

function snapshot(record: VscodeWebviewRecord): SavedPanel {
  return structuredClone({
    id: record.restorationId ?? record.handle,
    viewType: record.viewType,
    title: record.title,
    state: record.state,
  })
}

async function restorePanel(
  d: WebviewRestorationDependencies,
  pluginId: string,
  workspace: string,
  panel: SavedPanel,
  activate: boolean
): Promise<void> {
  const key = JSON.stringify([pluginId, workspace, panel.id])
  const existing = restoring.get(key)
  if (existing) return existing.done
  const controller = new AbortController()
  const current = () =>
    deps === d &&
    workspace === d.workspaceKey() &&
    !controller.signal.aborted &&
    !removedPanels.has(key)
  const entry = {
    pluginId,
    workspace,
    panelId: panel.id,
    viewType: panel.viewType,
    controller,
    done: Promise.resolve(),
  }
  restoring.set(key, entry)
  entry.done = (async () => {
    if (!(await d.wantsEnabled(pluginId)) || !current()) return
    if (activate && !serializers.has(keyOf(pluginId, panel.viewType)))
      await d.activate(`onWebviewPanel:${panel.viewType}`)
    if (!(await d.wantsEnabled(pluginId)) || !current()) return
    const serializer = serializers.get(keyOf(pluginId, panel.viewType))
    if (
      !serializer ||
      listWebviews().some(
        (view) => view.pluginId === pluginId && (view.restorationId ?? view.handle) === panel.id
      )
    )
      return
    const handle = `restored:${globalThis.crypto.randomUUID()}`
    scopes.set(handle, workspace)
    addWebview(
      {
        handle,
        pluginId,
        kind: "panel",
        viewType: panel.viewType,
        title: panel.title,
        html: "",
        options: { ...DEFAULT_WEBVIEW_OPTIONS },
        resolved: false,
        restorationId: panel.id,
      },
      { select: false }
    )
    setWebviewState(handle, panel.state)
    const timer = setTimeout(
      () => controller.abort(new DOMException("Webview restoration timed out", "TimeoutError")),
      d.timeoutMs ?? 30_000
    )
    try {
      await d.callProvider(
        pluginId,
        "deserializeWebviewPanel",
        {
          token: serializer.token,
          handle,
          viewType: panel.viewType,
          title: panel.title,
          state: panel.state,
          visible: getSelectedWebview() === handle,
          active: getSelectedWebview() === handle,
        },
        controller.signal
      )
      controller.signal.throwIfAborted()
      if (
        !(await d.wantsEnabled(pluginId)) ||
        !current() ||
        serializers.get(keyOf(pluginId, panel.viewType)) !== serializer
      )
        throw new Error("Webview serializer was replaced or disabled")
      updateWebview(handle, { resolved: true })
    } catch (error) {
      if (getWebview(handle)) removeWebview(handle, true)
      throw error
    } finally {
      clearTimeout(timer)
    }
  })()
    .catch((error: unknown) => warn(pluginId, error))
    .finally(() => {
      if (restoring.get(key) === entry) restoring.delete(key)
    })
  return entry.done
}

export async function restoreVscodeWebviewPanelsForPlugin(
  pluginId: string,
  activate = true
): Promise<void> {
  const d = deps
  if (!d) return
  const workspace = d.workspaceKey()
  await queues.get(queueKey(pluginId, workspace))
  const panels = saved(await d.read(pluginId, workspace))
  await Promise.all(panels.map((panel) => restorePanel(d, pluginId, workspace, panel, activate)))
}

export function registerVscodeWebviewSerializer(
  pluginId: string,
  viewType: string,
  token: string
): void {
  const key = keyOf(pluginId, viewType)
  if (serializers.has(key)) throw new Error(`Webview serializer already registered for ${viewType}`)
  serializers.set(key, { token })
  // Never wait on activation from inside its own registration ACK.
  queueMicrotask(() => {
    void restoreVscodeWebviewPanelsForPlugin(pluginId, false).catch((error) =>
      warn(pluginId, error)
    )
  })
}

export function unregisterVscodeWebviewSerializer(
  pluginId: string,
  viewType: string,
  token: string
): void {
  const key = keyOf(pluginId, viewType)
  if (serializers.get(key)?.token !== token) return
  serializers.delete(key)
  for (const entry of restoring.values())
    if (entry.pluginId === pluginId && entry.viewType === viewType) entry.controller.abort()
}

export function clearVscodeWebviewSerializersForPlugin(pluginId: string): void {
  for (const [key, value] of serializers) {
    const [owner, type] = JSON.parse(key) as [string, string]
    if (owner === pluginId) unregisterVscodeWebviewSerializer(pluginId, type, value.token)
  }
}

export function installVscodeWebviewRestoration(next: WebviewRestorationDependencies): () => void {
  stop?.()
  deps = next
  const restore = () => {
    for (const entry of restoring.values())
      if (entry.workspace !== next.workspaceKey()) entry.controller.abort()
    for (const id of next.pluginIds())
      void restoreVscodeWebviewPanelsForPlugin(id).catch((error) => warn(id, error))
  }
  const detach = subscribeWebviewMutations(({ kind, record }) => {
    if (record.kind !== "panel") return
    const workspace = scopes.get(record.handle) ?? next.workspaceKey()
    scopes.set(record.handle, workspace)
    const panel = snapshot(record)
    if (kind === "detach") {
      scopes.delete(record.handle)
      return
    }
    if (kind === "remove") {
      removedPanels.add(JSON.stringify([record.pluginId, workspace, panel.id]))
      for (const entry of restoring.values())
        if (entry.pluginId === record.pluginId && entry.panelId === panel.id)
          entry.controller.abort()
      scopes.delete(record.handle)
      mutate(next, record.pluginId, workspace, (panels) =>
        panels.filter((item) => item.id !== panel.id)
      )
    } else {
      removedPanels.delete(JSON.stringify([record.pluginId, workspace, panel.id]))
      mutate(next, record.pluginId, workspace, (panels) => [
        ...panels.filter((item) => item.id !== panel.id),
        panel,
      ])
    }
  })
  const detachWorkspace = next.subscribeWorkspace(restore)
  const dispose = () => {
    detach()
    detachWorkspace()
    for (const entry of restoring.values()) entry.controller.abort()
    if (deps === next) deps = undefined
  }
  stop = dispose
  // Startup extensions may already have opened a panel before this coordinator installs.
  // Adopt those live panels instead of relying on a future HTML/state mutation.
  for (const record of listWebviews())
    if (record.kind === "panel") {
      const workspace = scopes.get(record.handle) ?? next.workspaceKey()
      scopes.set(record.handle, workspace)
      const panel = snapshot(getWebview(record.handle) ?? record)
      mutate(next, record.pluginId, workspace, (panels) => [
        ...panels.filter((item) => item.id !== panel.id),
        panel,
      ])
    }
  restore()
  return () => {
    if (stop === dispose) {
      dispose()
      stop = undefined
    }
  }
}

export async function __settleWebviewRestorationForTesting(): Promise<void> {
  await Promise.all([...queues.values(), ...[...restoring.values()].map((entry) => entry.done)])
}
export function __resetWebviewRestorationForTesting(): void {
  stop?.()
  stop = undefined
  serializers.clear()
  scopes.clear()
  restoring.clear()
  queues.clear()
  removedPanels.clear()
}
