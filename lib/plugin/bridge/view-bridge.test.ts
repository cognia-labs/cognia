import { registerViewsForPlugin, unregisterViewsForPlugin } from "./view-bridge"
import { getViewSnapshot, __resetViewsForTesting } from "@/lib/plugin/registries/tree-view-registry"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { TreeDataProvider } from "@/types/plugin/plugin-view"

function manifest(views: PluginManifest["views"]): PluginManifest {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    capabilities: ["tree-view"],
    views,
  } as PluginManifest
}

const provider: TreeDataProvider = { getChildren: () => [{ id: "a", label: "A" }] }
const ReactView = () => null

describe("view-bridge", () => {
  afterEach(() => __resetViewsForTesting())

  it("resolves a tree provider export (object) and registers it", async () => {
    const importer = jest.fn(async () => ({ filesProvider: provider }))
    const result = await registerViewsForPlugin(
      manifest([
        {
          id: "files",
          containerId: "explorer",
          type: "tree",
          entry: "v.js",
          export: "filesProvider",
        },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(1)
    expect(importer).toHaveBeenCalledWith("/root/v.js")
    const [v] = getViewSnapshot()
    expect(v).toMatchObject({ kind: "tree", containerId: "p:explorer", viewId: "files" })
  })

  it("resolves a tree provider FACTORY export and invokes it", async () => {
    const factory = jest.fn(() => provider)
    const importer = jest.fn(async () => ({ makeProvider: factory }))
    await registerViewsForPlugin(
      manifest([
        { id: "t", containerId: "c", type: "tree", entry: "v.js", export: "makeProvider" },
      ]),
      "/root",
      { importer }
    )
    expect(factory).toHaveBeenCalled()
    expect(getViewSnapshot()).toHaveLength(1)
  })

  it("resolves a react component export", async () => {
    const importer = jest.fn(async () => ({ Panel: ReactView }))
    await registerViewsForPlugin(
      manifest([{ id: "p1", containerId: "c", type: "react", entry: "v.js", export: "Panel" }]),
      "/root",
      { importer }
    )
    const [v] = getViewSnapshot()
    expect(v.kind).toBe("react")
  })

  it("records an error for a missing export and keeps going", async () => {
    const importer = jest.fn(async () => ({ Panel: ReactView }))
    const result = await registerViewsForPlugin(
      manifest([
        { id: "bad", containerId: "c", type: "tree", entry: "v.js", export: "nope" },
        { id: "ok", containerId: "c", type: "react", entry: "v.js", export: "Panel" },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].viewId).toBe("bad")
  })

  it("rejects a tree export that is not a provider", async () => {
    const importer = jest.fn(async () => ({ notAProvider: { foo: 1 } }))
    const result = await registerViewsForPlugin(
      manifest([
        { id: "x", containerId: "c", type: "tree", entry: "v.js", export: "notAProvider" },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/TreeDataProvider/)
  })

  it("clears prior views on re-register (no double-register)", async () => {
    const importer = jest.fn(async () => ({ p: provider }))
    const m = manifest([{ id: "v", containerId: "c", type: "tree", entry: "v.js", export: "p" }])
    await registerViewsForPlugin(m, "/root", { importer })
    await registerViewsForPlugin(m, "/root", { importer })
    expect(getViewSnapshot()).toHaveLength(1)
  })

  it("no-ops for a manifest without views", async () => {
    const result = await registerViewsForPlugin(manifest(undefined), "/root", {})
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it("unregisterViewsForPlugin drops the plugin's views", async () => {
    const importer = jest.fn(async () => ({ p: provider }))
    await registerViewsForPlugin(
      manifest([{ id: "v", containerId: "c", type: "tree", entry: "v.js", export: "p" }]),
      "/root",
      { importer }
    )
    unregisterViewsForPlugin("p")
    expect(getViewSnapshot()).toHaveLength(0)
  })
})

it("R11 tree change subscription returns a synchronous cold disposer", async () => {
  const { bindPluginCallbacks } = await import("@/lib/plugin/core/invocation-identity")
  const { configurePersonalDispatchFence } = await import("@/lib/execution/personal-operation")
  const restore = configurePersonalDispatchFence(() => undefined)
  const subscribe = jest.fn((_listener: unknown) => () => undefined)
  try {
    const result = await registerViewsForPlugin(
      manifest([
        { id: "cold", containerId: "explorer", type: "tree", entry: "v.js", export: "tree" },
      ]),
      "/root",
      {
        importer: async () => ({ tree: { getChildren: () => [], onDidChangeTreeData: subscribe } }),
      }
    )
    expect(result.errors).toEqual([])
    const off = bindPluginCallbacks("p", subscribe, () => ({ executionRunId: "r11-cold" }))(
      () => undefined
    )
    expect(off).not.toBeInstanceOf(Promise)
    expect(off()).toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})

it("R11 actual registered raw Component export and class subscription stay synchronous while cold", async () => {
  const { bindPluginCallbacks } = await import("@/lib/plugin/core/invocation-identity")
  const { bindPersonalOperationSources, configurePersonalDispatchFence } =
    await import("@/lib/execution/personal-operation")
  const restore = configurePersonalDispatchFence(() => undefined)
  const guest = jest.fn(() => null),
    subscribed = jest.fn()
  const source = bindPersonalOperationSources({}, [
    { executionRunId: "r11-a" },
    { executionRunId: "r11-b" },
  ])
  class Provider {
    getChildren() {
      return []
    }
    onDidChangeTreeData() {
      subscribed()
      return () => undefined
    }
  }
  try {
    const imported = bindPluginCallbacks(
      "p",
      { Component: guest, tree: new Provider() },
      () => source
    )
    const result = await registerViewsForPlugin(
      manifest([
        { id: "r", containerId: "explorer", type: "react", entry: "v.js", export: "Component" },
        { id: "t", containerId: "explorer", type: "tree", entry: "v.js", export: "tree" },
      ]),
      "/root",
      { importer: async () => imported }
    )
    expect(result.errors).toEqual([])
    const views = getViewSnapshot()
    const react = views.find((view) => view.viewId === "r")!
    if (react.kind !== "react") throw new Error("Missing React registration")
    expect((react.component as () => unknown)()).toBeNull()
    expect(guest).not.toHaveBeenCalled()
    const tree = views.find((view) => view.viewId === "t")!
    if (tree.kind !== "tree") throw new Error("Missing tree registration")
    const off = tree.provider.onDidChangeTreeData!(() => undefined)
    expect(off).not.toBeInstanceOf(Promise)
    expect(off()).toBeUndefined()
    expect(subscribed).not.toHaveBeenCalled()
  } finally {
    unregisterViewsForPlugin("p")
    restore()
  }
})
