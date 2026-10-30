/** @jest-environment jsdom */
import {
  __resetWebviewRestorationForTesting,
  __settleWebviewRestorationForTesting,
  installVscodeWebviewRestoration,
  registerVscodeWebviewSerializer,
  unregisterVscodeWebviewSerializer,
  clearVscodeWebviewSerializersForPlugin,
  restoreVscodeWebviewPanelsForPlugin,
  type WebviewRestorationDependencies,
  createWebviewRestorationDependencies,
} from "./webview-restoration"
import {
  addWebview,
  setWebviewState,
  removeWebview,
  listWebviews,
  updateWebview,
  __resetWebviewBridgeForTesting,
  DEFAULT_WEBVIEW_OPTIONS,
} from "./webview-bridge"

function fixture(initial?: unknown) {
  const data = new Map<string, unknown>()
  if (initial) data.set("ext:workspace-a", initial)
  let workspace = "workspace-a"
  let changed = () => {}
  const input: WebviewRestorationDependencies = {
    pluginIds: () => ["ext"],
    workspaceKey: () => workspace,
    subscribeWorkspace: (listener) => {
      changed = listener
      return () => {}
    },
    wantsEnabled: jest.fn(async () => true),
    activate: jest.fn(async () => {
      registerVscodeWebviewSerializer("ext", "preview", "serializer")
    }),
    read: jest.fn(async (id, scope) => {
      const value = data.get(`${id}:${scope}`)
      return value === undefined ? undefined : structuredClone(value)
    }),
    write: jest.fn(async (id, scope, panels) => {
      data.set(`${id}:${scope}`, structuredClone({ version: 1, panels }))
    }),
    callProvider: jest.fn(async (_id, _method, payload) => {
      updateWebview((payload as { handle: string }).handle, { html: "<p>restored</p>" })
    }),
    timeoutMs: 50,
  }
  const stop = installVscodeWebviewRestoration(input)
  return {
    input,
    data,
    stop,
    switchWorkspace: (value: string) => {
      workspace = value
      changed()
    },
  }
}
const saved = () => ({
  version: 1,
  panels: [{ id: "old-handle", viewType: "preview", title: "Saved preview", state: { count: 3 } }],
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
beforeEach(() => {
  __resetWebviewRestorationForTesting()
  __resetWebviewBridgeForTesting()
})
afterEach(async () => {
  await __settleWebviewRestorationForTesting()
  __resetWebviewRestorationForTesting()
  __resetWebviewBridgeForTesting()
})

it("adopts panels created during startup before persistence was installed", async () => {
  addWebview(
    {
      handle: "startup",
      pluginId: "ext",
      kind: "panel",
      title: "Startup",
      viewType: "preview",
      html: "startup HTML",
      options: DEFAULT_WEBVIEW_OPTIONS,
    },
    { select: true }
  )
  setWebviewState("startup", { value: "saved before coordinator" })
  const h = fixture()
  await __settleWebviewRestorationForTesting()
  expect(h.data.get("ext:workspace-a")).toEqual({
    version: 1,
    panels: [
      {
        id: "startup",
        title: "Startup",
        viewType: "preview",
        state: { value: "saved before coordinator" },
      },
    ],
  })
})

it("does not reopen a user-closed panel after an earlier storage read finishes", async () => {
  const h = fixture()
  await flush()
  registerVscodeWebviewSerializer("ext", "preview", "current")
  await flush()
  addWebview(
    {
      handle: "old-handle",
      pluginId: "ext",
      kind: "panel",
      title: "Saved preview",
      viewType: "preview",
      html: "",
      options: DEFAULT_WEBVIEW_OPTIONS,
    },
    { select: true }
  )
  setWebviewState("old-handle", { count: 3 })
  await __settleWebviewRestorationForTesting()
  let release!: (value: unknown) => void
  jest.mocked(h.input.read).mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const restoring = restoreVscodeWebviewPanelsForPlugin("ext", false)
  await flush()
  removeWebview("old-handle")
  release(saved())
  await restoring
  await __settleWebviewRestorationForTesting()
  expect(listWebviews()).toHaveLength(0)
  expect(h.input.callProvider).not.toHaveBeenCalled()
  expect(h.data.get("ext:workspace-a")).toEqual({ version: 1, panels: [] })
})

it("reloads real plugin storage through fresh production dependency instances", async () => {
  const { useProjectStore } = await import("@/stores/project/project-store")
  const pluginId = "webview-restoration-storage-test"
  const projectId = "webview-restoration-workspace-test"
  const key = `cognia:plugin:storage:${pluginId}:vscode:webview-panels:${projectId}`
  useProjectStore.setState({ activeProjectId: projectId })
  localStorage.removeItem(key)
  const input = {
    pluginIds: () => [pluginId],
    wantsEnabled: async () => true,
    activate: async () => {
      registerVscodeWebviewSerializer(pluginId, "preview", "fresh-serializer")
    },
  }
  try {
    const first = createWebviewRestorationDependencies(input)
    const stop = installVscodeWebviewRestoration(first)
    await flush()
    addWebview(
      {
        handle: "persisted",
        pluginId,
        kind: "panel",
        title: "Persisted",
        viewType: "preview",
        html: "not persisted",
        options: DEFAULT_WEBVIEW_OPTIONS,
      },
      { select: true }
    )
    setWebviewState("persisted", { count: 12 })
    await __settleWebviewRestorationForTesting()
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      version: 1,
      panels: [expect.objectContaining({ state: { count: 12 } })],
    })
    stop()
    removeWebview("persisted", true)
    const second = createWebviewRestorationDependencies(input)
    second.callProvider = jest.fn(async (_owner, _method, raw) => {
      updateWebview((raw as { handle: string }).handle, { html: "fresh renderer" })
    })
    installVscodeWebviewRestoration(second)
    await restoreVscodeWebviewPanelsForPlugin(pluginId)
    expect(second.callProvider).toHaveBeenCalledWith(
      pluginId,
      "deserializeWebviewPanel",
      expect.objectContaining({ state: { count: 12 } }),
      expect.any(AbortSignal)
    )
    expect(listWebviews()[0]?.html).toBe("fresh renderer")
  } finally {
    await __settleWebviewRestorationForTesting()
    localStorage.removeItem(key)
    useProjectStore.setState({ activeProjectId: null })
  }
})

it.each([true, false])("restores a dormant owner's panel with selected=%s", async (selected) => {
  if (!selected)
    addWebview(
      {
        handle: "other-panel",
        pluginId: "other",
        kind: "panel",
        title: "Other",
        viewType: "other",
        html: "",
        options: DEFAULT_WEBVIEW_OPTIONS,
      },
      { select: true }
    )
  const h = fixture(saved())
  await restoreVscodeWebviewPanelsForPlugin("ext")
  await flush()
  expect(h.input.activate).toHaveBeenCalledWith("onWebviewPanel:preview")
  expect(h.input.callProvider).toHaveBeenCalledTimes(1)
  expect(h.input.callProvider).toHaveBeenCalledWith(
    "ext",
    "deserializeWebviewPanel",
    expect.objectContaining({
      token: "serializer",
      state: { count: 3 },
      visible: selected,
      active: selected,
    }),
    expect.any(AbortSignal)
  )
  expect(listWebviews()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        html: "<p>restored</p>",
        resolved: true,
        restorationId: "old-handle",
      }),
    ])
  )
})

it("persists JSON state without HTML, retains it on Host detach, and removes it on user close", async () => {
  const h = fixture()
  await flush()
  addWebview(
    {
      handle: "live",
      pluginId: "ext",
      kind: "panel",
      title: "Preview",
      viewType: "preview",
      html: "private HTML",
      options: DEFAULT_WEBVIEW_OPTIONS,
    },
    { select: true }
  )
  setWebviewState("live", { count: 7 })
  removeWebview("live", true)
  await __settleWebviewRestorationForTesting()
  expect(h.data.get("ext:workspace-a")).toEqual({
    version: 1,
    panels: [{ id: "live", title: "Preview", viewType: "preview", state: { count: 7 } }],
  })
  await restoreVscodeWebviewPanelsForPlugin("ext")
  removeWebview(listWebviews()[0]!.handle)
  await __settleWebviewRestorationForTesting()
  expect(h.data.get("ext:workspace-a")).toEqual({ version: 1, panels: [] })
})

it("does not activate disabled owners or restore malformed snapshots", async () => {
  const h = fixture(saved())
  jest.mocked(h.input.wantsEnabled).mockResolvedValue(false)
  await restoreVscodeWebviewPanelsForPlugin("ext")
  expect(h.input.activate).not.toHaveBeenCalled()
  expect(h.input.callProvider).not.toHaveBeenCalled()
  h.data.set("ext:workspace-a", { version: 1, panels: [{ id: 4, viewType: "preview" }] })
  jest.mocked(h.input.wantsEnabled).mockResolvedValue(true)
  await restoreVscodeWebviewPanelsForPlugin("ext")
  expect(h.input.activate).not.toHaveBeenCalled()
})

it("keeps panel writes with their original workspace after switching projects", async () => {
  const h = fixture()
  await flush()
  addWebview(
    {
      handle: "live",
      pluginId: "ext",
      kind: "panel",
      title: "Preview",
      viewType: "preview",
      html: "",
      options: DEFAULT_WEBVIEW_OPTIONS,
    },
    { select: true }
  )
  h.switchWorkspace("workspace-b")
  setWebviewState("live", { count: 9 })
  await __settleWebviewRestorationForTesting()
  expect(h.data.get("ext:workspace-a")).toEqual(
    expect.objectContaining({ panels: [expect.objectContaining({ state: { count: 9 } })] })
  )
  expect(h.data.has("ext:workspace-b")).toBe(false)
})

it("ignores stale serializer disposal and never reopens a panel closed while restoring", async () => {
  const h = fixture()
  await flush()
  h.data.set("ext:workspace-a", saved())
  registerVscodeWebviewSerializer("ext", "preview", "current")
  unregisterVscodeWebviewSerializer("ext", "preview", "old")
  let finish!: () => void
  let signal!: AbortSignal
  jest
    .mocked(h.input.callProvider)
    .mockImplementationOnce(async (_id, _method, _payload, cancellation) => {
      signal = cancellation
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
  const restoring = restoreVscodeWebviewPanelsForPlugin("ext", false)
  await flush()
  expect(listWebviews()).toHaveLength(1)
  removeWebview(listWebviews()[0]!.handle)
  expect(signal.aborted).toBe(true)
  finish()
  await restoring
  expect(listWebviews()).toHaveLength(0)
})

it("aborts restoration on extension exit and preserves state for a later retry", async () => {
  const h = fixture()
  await flush()
  h.data.set("ext:workspace-a", saved())
  registerVscodeWebviewSerializer("ext", "preview", "current")
  jest
    .mocked(h.input.callProvider)
    .mockImplementationOnce(async (_id, _method, _payload, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    })
  const restoring = restoreVscodeWebviewPanelsForPlugin("ext", false)
  await flush()
  clearVscodeWebviewSerializersForPlugin("ext")
  await restoring
  expect(listWebviews()).toHaveLength(0)
  await __settleWebviewRestorationForTesting()
  expect(h.data.get("ext:workspace-a")).toEqual(saved())
})
