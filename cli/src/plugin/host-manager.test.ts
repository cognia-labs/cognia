import type { PluginManifest } from "@/types/plugin"
import { makeHostManager } from "./host-manager"

function manifest(id: string, tools?: unknown[]): PluginManifest {
  return {
    id,
    name: `${id}-name`,
    version: "1.0.0",
    description: "",
    type: "frontend",
    ...(tools ? { tools } : {}),
  } as unknown as PluginManifest
}

describe("makeHostManager", () => {
  it("delegates lifecycle calls to the injected manager", async () => {
    const calls: string[] = []
    const hm = makeHostManager({
      manager: {
        registerDiskPlugin: async (m, dir) => void calls.push(`register:${m.id}@${dir}`),
        loadPlugin: async (id) => void calls.push(`load:${id}`),
        enablePlugin: async (id, reason) => void calls.push(`enable:${id}:${reason}`),
        disablePlugin: async (id, reason) => void calls.push(`disable:${id}:${reason}`),
        suspendPlugin: async (id, reason) => void calls.push(`suspend:${id}:${reason}`),
        setPluginIntent: async (id, intent) => void calls.push(`intent:${id}:${intent}`),
        unloadPlugin: async (id) => void calls.push(`unload:${id}`),
        reloadPlugin: async (id, reason) => void calls.push(`reload:${id}:${reason}`),
        withPluginPackageMutation: async (id, operation) => {
          calls.push(`mutate:${id}`)
          return operation()
        },
        reservePluginRuntimeGraph: (id) => {
          calls.push(`reserve:${id}`)
          return { managerId: "m", pluginId: id, token: Symbol(id) } as never
        },
        releasePluginRuntimeGraph: () => {
          calls.push("release")
          return true
        },
      },
      getPlugins: () => ({}),
    })
    await hm.registerDiskPlugin(manifest("x"), "/d/x")
    await hm.loadPlugin("x")
    await hm.enablePlugin("x", "r1")
    await hm.disablePlugin("x", "r2")
    await hm.suspendPlugin("x", "r3")
    await hm.setPluginIntent("x", "disabled")
    await hm.unloadPlugin("x")
    await hm.reloadPlugin("x", "cli-reload")
    expect(await hm.withPluginPackageMutation("x", async () => 7)).toBe(7)
    hm.releasePluginRuntimeGraph(hm.reservePluginRuntimeGraph("x"))
    expect(calls).toEqual([
      "register:x@/d/x",
      "load:x",
      "enable:x:r1",
      "disable:x:r2",
      "suspend:x:r3",
      "intent:x:disabled",
      "unload:x",
      "reload:x:cli-reload",
      "mutate:x",
      "reserve:x",
      "release",
    ])
  })

  it("projects the store plugin map into list rows (tool count from manifest)", () => {
    const hm = makeHostManager({
      manager: {} as never,
      getPlugins: () => ({
        a: {
          manifest: manifest("a", [{ name: "t1" }, { name: "t2" }]),
          path: "/d/a",
          status: "enabled",
        },
        b: { manifest: manifest("b"), path: "builtin://b", status: "disabled" },
      }),
    })
    const rows = hm.list()
    expect(rows.find((r) => r.id === "a")).toMatchObject({
      name: "a-name",
      version: "1.0.0",
      type: "frontend",
      path: "/d/a",
      status: "enabled",
    })
    expect(rows.find((r) => r.id === "a")?.tools).toHaveLength(2)
    expect(rows.find((r) => r.id === "b")?.tools).toEqual([])
  })
})
