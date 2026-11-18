import os from "node:os"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"
import path from "node:path"
import type { PluginManifest } from "@/types/plugin"
import {
  __resetAuthRegistryForTesting,
  getProvider,
  registerAuthenticationProvider,
  setAuthProviderOwnershipStore,
} from "@/lib/plugin/auth/auth-provider-registry"
import {
  listHostPlugins,
  reloadPlugin,
  replaceDiskPlugin,
  registerDiskPlugins,
  uninstallHostPlugin,
  defaultDiscoverDiskPlugins,
  type HostManager,
  type DiskPluginEntry,
} from "./host"

function manifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "",
    type: "frontend",
    main: "main.js",
    capabilities: [],
  } as unknown as PluginManifest
}

function fakeManager() {
  const events: string[] = []
  const mgr: HostManager & { events: string[] } = {
    events,
    registerDiskPlugin: jest.fn(async (m: PluginManifest, dir: string) => {
      events.push(`register:${m.id}@${dir}`)
    }),
    loadPlugin: jest.fn(async (id: string) => void events.push(`load:${id}`)),
    enablePlugin: jest.fn(async (id: string) => void events.push(`enable:${id}`)),
    disablePlugin: jest.fn(async (id: string) => void events.push(`disable:${id}`)),
    suspendPlugin: jest.fn(async (id: string) => void events.push(`suspend:${id}`)),
    reloadPlugin: jest.fn(
      async (id: string, reason: string) => void events.push(`reload:${id}:${reason}`)
    ),
    withPluginPackageMutation: jest.fn(async (id: string, operation: () => Promise<unknown>) => {
      events.push(`mutate:${id}`)
      return operation()
    }) as HostManager["withPluginPackageMutation"],
    reservePluginRuntimeGraph: jest.fn((id: string) => {
      events.push(`reserve:${id}`)
      return { managerId: "m", pluginId: id, token: Symbol(id) } as never
    }),
    releasePluginRuntimeGraph: jest.fn(() => void events.push("release")),
    setPluginIntent: jest.fn(
      async (id: string, intent: "enabled" | "disabled") =>
        void events.push(`intent:${id}:${intent}`)
    ),
    unloadPlugin: jest.fn(async (id: string) => void events.push(`unload:${id}`)),
    list: jest.fn(() => [
      {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        type: "frontend",
        path: "/home/u/.cognia/plugins/demo",
        status: "enabled",
        tools: [{ name: "t" }],
      },
      {
        id: "wt",
        name: "Web",
        version: "1.0.0",
        type: "frontend",
        path: "builtin://web-tools",
        status: "enabled",
        tools: [],
      },
    ]),
  }
  return mgr
}

const entry = (id: string, dir: string, supported = true): DiskPluginEntry => ({
  id,
  dir,
  manifest: manifest(id),
  supported,
})

describe("registerDiskPlugins", () => {
  it("registers, loads, and enables disk frontend plugins not in the disabled set", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/home/u/.cognia/plugins/demo")],
      disabled: new Set<string>(),
      notify: () => {},
    })
    expect(mgr.events).toEqual([
      "register:demo@/home/u/.cognia/plugins/demo",
      "load:demo",
      "enable:demo",
    ])
  })

  it("registers but does not enable a plugin in the disabled set", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/d")],
      disabled: new Set(["demo"]),
      notify: () => {},
    })
    expect(mgr.events).toEqual(["register:demo@/d"])
  })

  it("skips unsupported (non-frontend) plugins entirely", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("py", "/p", false)],
      disabled: new Set<string>(),
      notify: () => {},
    })
    expect(mgr.events).toEqual([])
  })

  it("notifies and continues when a plugin fails to load", async () => {
    const mgr = fakeManager()
    mgr.loadPlugin = jest.fn(async () => {
      throw new Error("boom")
    })
    const notes: string[] = []
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/d")],
      disabled: new Set<string>(),
      notify: (m) => notes.push(m),
    })
    expect(notes[0]).toMatch(/demo.*boom/)
  })
})

describe("listHostPlugins", () => {
  it("maps the manager store to rows with origin labels and tool counts", () => {
    const rows = listHostPlugins({ manager: fakeManager() })
    expect(rows.find((r) => r.id === "demo")?.origin).toBe("disk")
    expect(rows.find((r) => r.id === "wt")?.origin).toBe("builtin")
    expect(rows.find((r) => r.id === "demo")?.toolCount).toBe(1)
    expect(rows.find((r) => r.id === "wt")?.toolCount).toBe(0)
  })

  it("treats a row with no tools array as zero tools", () => {
    const mgr = fakeManager()
    mgr.list = jest.fn(() => [
      { id: "x", name: "X", version: "1.0.0", type: "frontend", path: "/d/x", status: "enabled" },
    ])
    expect(listHostPlugins({ manager: mgr })[0].toolCount).toBe(0)
  })
})

describe("reloadPlugin", () => {
  it("delegates to the manager's state-preserving reload (PL18)", async () => {
    const mgr = fakeManager()
    await reloadPlugin("demo", { manager: mgr })
    // Never a blind enable: the manager re-activates only what was active.
    expect(mgr.events).toEqual(["reload:demo:cli-reload"])
  })
})

describe("replaceDiskPlugin", () => {
  function managerWith(status: string | undefined) {
    const mgr = fakeManager()
    ;(mgr.list as jest.Mock).mockReturnValue(
      status === undefined
        ? []
        : [
            {
              id: "demo",
              name: "Demo",
              version: "1.0.0",
              type: "frontend",
              path: "/p/demo",
              status,
              tools: [],
            },
          ]
    )
    return mgr
  }
  const staged = (commit = jest.fn(async () => undefined)) => ({
    id: "demo",
    dir: "/p/demo",
    manifest: { ...manifest("demo"), version: "2.0.0" } as PluginManifest,
    commit,
  })

  it.each([
    [
      "enabled",
      [
        "reserve:demo",
        "disable:demo",
        "unload:demo",
        "mutate:demo",
        "register:demo@/p/demo",
        "enable:demo",
        "release",
      ],
    ],
    [
      "suspended",
      [
        "reserve:demo",
        "disable:demo",
        "unload:demo",
        "mutate:demo",
        "register:demo@/p/demo",
        "enable:demo",
        "suspend:demo",
        "release",
      ],
    ],
    [
      "loaded",
      [
        "reserve:demo",
        "unload:demo",
        "mutate:demo",
        "register:demo@/p/demo",
        "load:demo",
        "release",
      ],
    ],
    [
      "disabled",
      ["reserve:demo", "unload:demo", "mutate:demo", "register:demo@/p/demo", "release"],
    ],
  ])("returns a %s plugin to the state it was in (PL18)", async (status, events) => {
    const mgr = managerWith(status)
    await replaceDiskPlugin(staged(), { manager: mgr })
    expect(mgr.events).toEqual(events)
  })

  it("registers the new manifest before restarting, so the new tree loads", async () => {
    const mgr = managerWith("enabled")
    await replaceDiskPlugin(staged(), { manager: mgr })
    expect(mgr.registerDiskPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2.0.0" }),
      "/p/demo"
    )
  })

  it("brings the old runtime back when the swap fails", async () => {
    const mgr = managerWith("enabled")
    const commit = jest.fn(async () => {
      throw new Error("EXDEV")
    })
    await expect(replaceDiskPlugin(staged(commit), { manager: mgr })).rejects.toThrow("EXDEV")
    expect(mgr.events).toEqual([
      "reserve:demo",
      "disable:demo",
      "unload:demo",
      "mutate:demo",
      "enable:demo",
      "release",
    ])
    expect(mgr.registerDiskPlugin).not.toHaveBeenCalled()
  })

  it("reports both failures when the old runtime cannot be brought back", async () => {
    const mgr = managerWith("enabled")
    ;(mgr.enablePlugin as jest.Mock).mockRejectedValueOnce(new Error("trust refused"))
    const commit = jest.fn(async () => {
      throw new Error("EXDEV")
    })
    await expect(replaceDiskPlugin(staged(commit), { manager: mgr })).rejects.toThrow(
      /EXDEV; restoring the previous runtime also failed: trust refused/
    )
  })

  it("installs a plugin the manager does not know yet without touching its runtime", async () => {
    const mgr = managerWith(undefined)
    await replaceDiskPlugin(staged(), { manager: mgr })
    expect(mgr.events).toEqual(["mutate:demo", "register:demo@/p/demo"])
  })
})

describe("uninstallHostPlugin", () => {
  beforeEach(() => {
    let owners: string | null = null
    setAuthProviderOwnershipStore({
      read: () => owners,
      write: (value) => {
        owners = value
      },
    })
    __resetAuthRegistryForTesting()
  })
  afterEach(() => {
    __resetAuthRegistryForTesting()
    setAuthProviderOwnershipStore(null)
  })

  const registerOwner = (pluginId: string) =>
    registerAuthenticationProvider({
      id: "acme",
      label: "Acme",
      pluginId,
      getSessions: async () => [],
      createSession: async () => {
        throw new Error("No interactive session in this fixture")
      },
      removeSession: async () => {},
    })

  it("unloads then removes the plugin directory", async () => {
    const mgr = fakeManager()
    const removed: string[] = []
    await uninstallHostPlugin("demo", "/home/u/.cognia/plugins/demo", {
      manager: mgr,
      rm: async (p) => void removed.push(p),
    })
    expect(mgr.events).toEqual(["unload:demo"])
    expect(removed).toEqual(["/home/u/.cognia/plugins/demo"])
  })

  it("removes the real directory via the default rm when none is injected", async () => {
    const mgr = fakeManager()
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-uninstall-"))
    nodeFs.writeFileSync(path.join(dir, "plugin.json"), "{}")
    await uninstallHostPlugin("demo", dir, { manager: mgr })
    expect(nodeFs.existsSync(dir)).toBe(false)
  })

  it("releases active and persisted ownership only after files are removed", async () => {
    registerOwner("demo")
    await uninstallHostPlugin("demo", "/plugins/demo", {
      manager: fakeManager(),
      rm: async () => {
        expect(() => registerOwner("squatter")).toThrow(/owned by another plugin/)
      },
    })
    expect(getProvider("acme")).toBeUndefined()
    expect(() => registerOwner("squatter")).not.toThrow()
  })

  it.each(["unload", "remove"])("retains ownership when %s fails", async (step) => {
    registerOwner("demo")()
    const manager = fakeManager()
    if (step === "unload") {
      manager.unloadPlugin = async () => {
        throw new Error("Uninstall failed")
      }
    }
    const rm = jest.fn(async () => {
      if (step === "remove") throw new Error("Uninstall failed")
    })
    await expect(uninstallHostPlugin("demo", "/plugins/demo", { manager, rm })).rejects.toThrow(
      "Uninstall failed"
    )
    if (step === "unload") expect(rm).not.toHaveBeenCalled()
    expect(() => registerOwner("squatter")).toThrow(/owned by another plugin/)
  })
})

describe("defaultDiscoverDiskPlugins", () => {
  it("enumerates dirs and reads each full manifest via the injected fs", async () => {
    const full = JSON.stringify({
      id: "demo",
      name: "Demo",
      version: "2.0.0",
      type: "frontend",
      main: "entry.js",
      capabilities: ["tools"],
    })
    const fs = {
      async exists(p: string) {
        return p.includes("plugins") || p.endsWith("plugin.json")
      },
      async readDir() {
        return ["demo"]
      },
      async readText() {
        return full
      },
    }
    const entries = await defaultDiscoverDiskPlugins(["/proj"], fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe("demo")
    expect(entries[0].supported).toBe(true)
    expect(entries[0].manifest.main).toBe("entry.js")
    expect(entries[0].manifest.capabilities).toEqual(["tools"])
  })

  it("skips a discovered plugin whose manifest fails to parse", async () => {
    const fs = {
      async exists() {
        return true
      },
      async readDir() {
        return ["demo"]
      },
      // discoverPlugins parses this first (valid), then defaultDiscover re-reads
      // the SAME path — return valid for the scan, invalid is simulated by a
      // second reader. Simplest: return a manifest discoverPlugins accepts but
      // that JSON.parse later rejects is impossible, so force the re-read to throw.
      readText: jest
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", type: "frontend" })
        )
        .mockRejectedValueOnce(new Error("vanished")),
    }
    const entries = await defaultDiscoverDiskPlugins(["/proj"], fs)
    expect(entries).toEqual([])
  })

  it("reads through the real default fs when none is injected", async () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-discover-"))
    try {
      const dir = path.join(root, ".cognia", "plugins", "demo")
      nodeFs.mkdirSync(dir, { recursive: true })
      nodeFs.writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          type: "frontend",
          main: "main.js",
        })
      )
      const entries = await defaultDiscoverDiskPlugins([root])
      expect(entries.map((e) => e.id)).toEqual(["demo"])
      expect(entries[0].manifest.main).toBe("main.js")
    } finally {
      await nodeFsP.rm(root, { recursive: true, force: true })
    }
  })
})
