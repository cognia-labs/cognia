/** @jest-environment node */

import {
  packageOwnerOf,
  replacePluginPackage,
  replacePluginPackages,
  type PackageReplacementOwner,
} from "./replace-package"

type Status = "installed" | "loaded" | "enabled" | "disabled" | "suspended"

function owner(
  initial: Record<string, Status>,
  intents: Record<string, "auto" | "enabled" | "disabled"> = {}
) {
  const status: Record<string, Status | undefined> = { ...initial }
  const events: string[] = []
  const record =
    (name: string, next?: Status) =>
    async (pluginId: string): Promise<void> => {
      events.push(`${name}:${pluginId}`)
      if (next && status[pluginId] !== undefined) status[pluginId] = next
    }
  const fake: PackageReplacementOwner & { events: string[]; status: typeof status } = {
    events,
    status,
    statusOf: (pluginId) => status[pluginId],
    intentOf: async (pluginId) => intents[pluginId] ?? "auto",
    enablePlugin: jest.fn(async (pluginId: string) => {
      events.push(`enable:${pluginId}`)
      status[pluginId] = "enabled"
    }),
    disablePlugin: jest.fn(record("disable", "disabled")),
    suspendPlugin: jest.fn(record("suspend", "suspended")),
    loadPlugin: jest.fn(record("load", "loaded")),
    unloadPlugin: jest.fn(record("unload", "installed")),
    reservePluginRuntimeGraph: jest.fn((pluginId: string) => {
      events.push(`reserve:${pluginId}`)
      return { pluginId } as never
    }),
    releasePluginRuntimeGraph: jest.fn((reservation: { pluginId: string }) => {
      events.push(`release:${reservation.pluginId}`)
      return true
    }) as PackageReplacementOwner["releasePluginRuntimeGraph"],
    withPluginPackageMutation: jest.fn(
      async <T>(pluginId: string, operation: () => Promise<T>) => {
        events.push(`lock:${pluginId}`)
        return operation()
      }
    ),
  }
  return fake
}

const register = (o: ReturnType<typeof owner>) => async (pluginId: string) => {
  o.events.push(`register:${pluginId}`)
  if (o.status[pluginId] === undefined) o.status[pluginId] = "installed"
}

describe("replacePluginPackage", () => {
  it("returns each runtime state to what it was", async () => {
    for (const [before, after] of [
      ["enabled", "enabled"],
      ["suspended", "suspended"],
      ["loaded", "loaded"],
      ["installed", "installed"],
    ] as const) {
      const o = owner({ demo: before })
      const outcome = await replacePluginPackage(o, {
        pluginId: "demo",
        commit: async () => "v2",
        register: () => register(o)("demo"),
        reason: "test",
      })
      expect(o.status.demo).toBe(after)
      expect(outcome.result).toBe("v2")
    }
  })

  it("never starts a plugin whose durable intent is disabled", async () => {
    const o = owner({ demo: "enabled" }, { demo: "disabled" })
    const outcome = await replacePluginPackage(o, {
      pluginId: "demo",
      commit: async () => undefined,
      register: () => register(o)("demo"),
      reason: "test",
    })
    expect(outcome.runtime).toBe("stopped")
    expect(o.enablePlugin).not.toHaveBeenCalled()
  })

  it("brings a new plugin up in whenNew, without reserving a graph it is not in", async () => {
    const o = owner({})
    await replacePluginPackage(o, {
      pluginId: "demo",
      commit: async () => undefined,
      register: () => register(o)("demo"),
      whenNew: "enabled",
      reason: "test",
    })
    expect(o.events).toEqual(["lock:demo", "register:demo", "enable:demo"])
  })

  it("puts back what was running when the commit fails, and says when that fails too", async () => {
    const o = owner({ demo: "enabled" })
    await expect(
      replacePluginPackage(o, {
        pluginId: "demo",
        commit: async () => {
          throw new Error("EXDEV")
        },
        register: () => register(o)("demo"),
        reason: "test",
      })
    ).rejects.toThrow("EXDEV")
    expect(o.status.demo).toBe("enabled")
    expect(o.enablePlugin).toHaveBeenCalledWith("demo", "test-restore")

    const stuck = owner({ demo: "enabled" })
    ;(stuck.enablePlugin as jest.Mock).mockRejectedValueOnce(new Error("trust refused"))
    await expect(
      replacePluginPackage(stuck, {
        pluginId: "demo",
        commit: async () => {
          throw new Error("EXDEV")
        },
        register: () => register(stuck)("demo"),
        reason: "test",
      })
    ).rejects.toThrow("EXDEV; restoring the previous runtime also failed: trust refused")
  })
})

describe("replacePluginPackages", () => {
  it("stops every plugin, commits once under every lock, and restores each", async () => {
    const o = owner({ b: "enabled", a: "loaded" })
    const outcome = await replacePluginPackages(o, {
      pluginIds: ["b", "a", "c"],
      commit: async () => ["a", "b", "c"],
      replaced: (result) => result,
      register: register(o),
      whenNew: "enabled",
      reason: "test",
    })
    expect(o.events).toEqual([
      "reserve:b",
      "reserve:a",
      "disable:b",
      "unload:b",
      "unload:a",
      // Locks are taken in a stable order whatever the request's order.
      "lock:a",
      "lock:b",
      "lock:c",
      "register:b",
      "enable:b",
      "register:a",
      "load:a",
      "register:c",
      "enable:c",
      "release:b",
      "release:a",
    ])
    expect(outcome.runtime).toEqual({ a: "loaded", b: "enabled", c: "enabled" })
    expect(outcome.failures).toEqual([])
  })

  it("restores a plugin the commit left alone, and reports one that cannot start", async () => {
    const o = owner({ kept: "enabled", moved: "enabled" })
    ;(o.enablePlugin as jest.Mock).mockImplementation(async (pluginId: string) => {
      if (pluginId === "moved") throw new Error("activation failed")
      o.status[pluginId] = "enabled"
    })
    const outcome = await replacePluginPackages(o, {
      pluginIds: ["kept", "moved"],
      commit: async () => ["moved"],
      replaced: (result) => result,
      register: register(o),
      reason: "test",
    })
    expect(o.status.kept).toBe("enabled")
    expect(outcome.runtime).toEqual({})
    expect(outcome.failures.map((failure) => failure.pluginId)).toEqual(["moved"])
  })
})

describe("packageOwnerOf", () => {
  it("reads status from the store projection and intent from the lifecycle record", async () => {
    const manager = {
      getPlugin: jest.fn(() => ({ status: "suspended" as const })),
      getPluginLifecycleState: jest.fn(async () => ({ intent: "disabled" as const })),
      enablePlugin: jest.fn(),
      disablePlugin: jest.fn(),
      suspendPlugin: jest.fn(),
      loadPlugin: jest.fn(),
      unloadPlugin: jest.fn(),
      reservePluginRuntimeGraph: jest.fn(),
      releasePluginRuntimeGraph: jest.fn(),
      withPluginPackageMutation: jest.fn(),
    }
    const adapted = packageOwnerOf(manager)
    expect(adapted.statusOf("demo")).toBe("suspended")
    await expect(adapted.intentOf?.("demo")).resolves.toBe("disabled")
  })
})
