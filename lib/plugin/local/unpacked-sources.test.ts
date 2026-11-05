import type { PluginManifest } from "@/types/plugin"
import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"
import type { LocalPluginInspection } from "./convert-local-source"
import {
  UNPACKED_SOURCES_STORAGE_KEY,
  forgetUnpackedSource,
  listWatchableUnpackedSources,
  readUnpackedSources,
  recordUnpackedSource,
  resyncUnpackedSource,
  type UnpackedSourceStorage,
} from "./unpacked-sources"

jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

function memoryStorage(initial?: string): UnpackedSourceStorage & { raw: () => string | null } {
  let value: string | null = initial ?? null
  return {
    getItem: (key) => (key === UNPACKED_SOURCES_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === UNPACKED_SOURCES_STORAGE_KEY) value = next
    },
    raw: () => value,
  }
}

function origin(
  pluginId: string,
  value: PluginInstallOriginRecord["origin"]
): PluginInstallOriginRecord {
  return { pluginId, version: "1.0.0", origin: value, recordedAt: 1 }
}

describe("unpacked source registry", () => {
  it("records, replaces and forgets a plugin's folder", () => {
    const storage = memoryStorage()
    recordUnpackedSource("demo", "/src/demo", { storage, now: () => 5 })
    expect(readUnpackedSources(storage)).toEqual({
      demo: { pluginId: "demo", sourceDir: "/src/demo", recordedAt: 5 },
    })
    recordUnpackedSource("demo", "/src/moved", { storage, now: () => 6 })
    expect(readUnpackedSources(storage).demo?.sourceDir).toBe("/src/moved")
    forgetUnpackedSource("demo", storage)
    expect(readUnpackedSources(storage)).toEqual({})
  })

  it("reads corrupt or mismatched entries as absent", () => {
    expect(readUnpackedSources(memoryStorage("{not json"))).toEqual({})
    const storage = memoryStorage(
      JSON.stringify({
        demo: { pluginId: "other", sourceDir: "/src/demo", recordedAt: 1 },
        empty: { pluginId: "empty", sourceDir: "", recordedAt: 1 },
        ok: { pluginId: "ok", sourceDir: "/src/ok", recordedAt: 1 },
      })
    )
    expect(Object.keys(readUnpackedSources(storage))).toEqual(["ok"])
  })

  it("works without storage", () => {
    expect(() => recordUnpackedSource("demo", "/src/demo", { storage: null })).not.toThrow()
    expect(readUnpackedSources(null)).toEqual({})
  })
})

describe("listWatchableUnpackedSources", () => {
  it("offers a folder only while the plugin's origin is still a local directory", async () => {
    const storage = memoryStorage()
    recordUnpackedSource("unpacked", "/src/unpacked", { storage })
    recordUnpackedSource("reinstalled", "/src/reinstalled", { storage })
    recordUnpackedSource("unknown", "/src/unknown", { storage })
    const origins: Record<string, PluginInstallOriginRecord | undefined> = {
      unpacked: origin("unpacked", { kind: "local", via: "directory" }),
      reinstalled: origin("reinstalled", {
        kind: "github",
        owner: "acme",
        repo: "reinstalled",
        commit: "a".repeat(40),
      }),
      unknown: undefined,
    }
    const result = await listWatchableUnpackedSources(
      ["unpacked", "reinstalled", "unknown", "never-recorded"],
      { storage, getOrigin: async (pluginId) => origins[pluginId] }
    )
    expect(result).toEqual([{ pluginId: "unpacked", sourceDir: "/src/unpacked" }])
  })

  it("skips a plugin whose origin cannot be read", async () => {
    const storage = memoryStorage()
    recordUnpackedSource("demo", "/src/demo", { storage })
    const result = await listWatchableUnpackedSources(["demo"], {
      storage,
      getOrigin: async () => {
        throw new Error("db closed")
      },
    })
    expect(result).toEqual([])
  })
})

describe("resyncUnpackedSource", () => {
  const installed: Pick<PluginManifest, "permissions" | "optionalPermissions" | "networkAccess"> = {
    permissions: ["workflow:read", "agent:control"] as PluginManifest["permissions"],
  }

  function inspection(
    manifest: Partial<PluginManifest> | undefined,
    extra: Partial<LocalPluginInspection> = {}
  ): LocalPluginInspection {
    return {
      sourceFormat: "cognia",
      report: {} as LocalPluginInspection["report"],
      manifest: manifest as PluginManifest | undefined,
      generatedFiles: {},
      convertible: true,
      native: true,
      ...extra,
    }
  }

  it("reinstalls a native folder with the same permission surface", async () => {
    const install = jest.fn(async () => ({ pluginId: "demo", warnings: [] }))
    await resyncUnpackedSource("demo", "/src/demo", installed, {
      inspect: async () =>
        inspection({
          id: "demo",
          name: "Demo",
          version: "1.1.0",
          // Order does not matter.
          permissions: ["agent:control", "workflow:read"] as PluginManifest["permissions"],
        }),
      install,
    })
    expect(install).toHaveBeenCalledWith("/src/demo", { pluginName: "Demo", version: "1.1.0" })
  })

  it("reinstalls a converted bundle with a fresh overlay", async () => {
    const install = jest.fn(async () => ({ pluginId: "demo", warnings: [] }))
    await resyncUnpackedSource("demo", "/src/claude", installed, {
      inspect: async () =>
        inspection(
          {
            id: "demo",
            version: "1.0.0",
            permissions: installed.permissions,
          },
          { native: false, sourceFormat: "claude-code", generatedFiles: { "plugin.json": "{}" } }
        ),
      install,
    })
    expect(install).toHaveBeenCalledWith("/src/claude", {
      pluginName: "demo",
      version: "1.0.0",
      generatedFiles: { "plugin.json": "{}" },
    })
  })

  it.each([
    [
      "a widened permission list",
      { id: "demo", permissions: ["workflow:read", "agent:control", "agent:dispatch"] },
      "changed its permissions",
    ],
    [
      "new network access",
      {
        id: "demo",
        permissions: ["workflow:read", "agent:control"],
        networkAccess: { allow: ["*"] },
      },
      "changed its permissions",
    ],
    [
      "new optional permissions",
      {
        id: "demo",
        permissions: ["workflow:read", "agent:control"],
        optionalPermissions: ["agent:external:read"],
      },
      "changed its permissions",
    ],
    [
      "a different plugin id",
      { id: "other", permissions: ["workflow:read", "agent:control"] },
      "declares plugin other",
    ],
  ])("refuses %s without installing", async (_label, manifest, message) => {
    const install = jest.fn()
    await expect(
      resyncUnpackedSource("demo", "/src/demo", installed, {
        inspect: async () => inspection(manifest as Partial<PluginManifest>),
        install,
      })
    ).rejects.toThrow(message)
    expect(install).not.toHaveBeenCalled()
  })

  it("refuses a folder that no longer converts", async () => {
    const install = jest.fn()
    await expect(
      resyncUnpackedSource("demo", "/src/demo", installed, {
        inspect: async () => inspection(undefined, { convertible: false }),
        install,
      })
    ).rejects.toThrow("can no longer be installed")
    expect(install).not.toHaveBeenCalled()
  })
})
