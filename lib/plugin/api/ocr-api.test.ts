let mockOcrPort: Record<string, jest.Mock> | null = null
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => (id === "ocr" ? mockOcrPort : null),
}))

import { __resetSharedOcrRegistry, getSharedOcrRegistry } from "@cognia/ocr/registry"
import { __resetOcrApiForTesting, clearOcrProvidersForPlugin, createOcrAPI } from "./ocr-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { OcrProvider, OcrInput, OcrProviderContext, OcrResult } from "@/types/ocr"

function makeProvider(id: string): OcrProvider {
  return {
    id,
    label: `Provider ${id}`,
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: false },
    credentialKeys: [],
    extract: async (_input: OcrInput, _ctx: OcrProviderContext): Promise<OcrResult> => ({
      pages: [],
      providerId: id,
      combinedMarkdown: "",
      combinedText: "",
      languages: [],
      durationMs: 0,
      cached: false,
    }),
  }
}

describe("createOcrAPI", () => {
  beforeEach(() => {
    __resetOcrApiForTesting()
    __resetSharedOcrRegistry()
    resetPermissionGuard()
    // `confirmDangerousByDefault: false` keeps the guard on its synchronous
    // path — the consent overlay itself is covered by the guard's own suite.
    const guard = getPermissionGuard({ confirmDangerousByDefault: false })
    // Extraction is permission-gated; registration is not.
    for (const pluginId of ["p", "my-plugin"]) {
      guard.registerPlugin(pluginId, [
        "media:image:read",
        "database:write",
        "native:filesystem",
        "native:screen",
        "automation:screenshot",
      ])
    }
  })

  it("registers a provider under the prefixed plugin id", () => {
    const api = createOcrAPI("my-plugin")
    const reg = api.registerProvider(makeProvider("baidu"))
    expect(reg.providerId).toBe("my-plugin:baidu")
    expect(getSharedOcrRegistry().has("my-plugin:baidu")).toBe(true)
  })

  it("rejects a second registration with the same unprefixed id from the same plugin", () => {
    const api = createOcrAPI("p")
    api.registerProvider(makeProvider("dup"))
    expect(() => api.registerProvider(makeProvider("dup"))).toThrow(/already registered/i)
  })

  it("allows two plugins to register the same unprefixed id", () => {
    createOcrAPI("a").registerProvider(makeProvider("baidu"))
    createOcrAPI("b").registerProvider(makeProvider("baidu"))
    expect(getSharedOcrRegistry().has("a:baidu")).toBe(true)
    expect(getSharedOcrRegistry().has("b:baidu")).toBe(true)
  })

  it("unregister() removes the provider from the shared registry", () => {
    const api = createOcrAPI("p")
    const reg = api.registerProvider(makeProvider("x"))
    reg.unregister()
    expect(getSharedOcrRegistry().has("p:x")).toBe(false)
  })

  it("unregister() is idempotent", () => {
    const api = createOcrAPI("p")
    const reg = api.registerProvider(makeProvider("x"))
    reg.unregister()
    expect(() => reg.unregister()).not.toThrow()
  })

  it("clearOcrProvidersForPlugin drops every provider the plugin owns", () => {
    const api = createOcrAPI("p")
    api.registerProvider(makeProvider("a"))
    api.registerProvider(makeProvider("b"))
    expect(api.listRegistered()).toHaveLength(2)
    clearOcrProvidersForPlugin("p")
    expect(api.listRegistered()).toHaveLength(0)
    expect(getSharedOcrRegistry().has("p:a")).toBe(false)
    expect(getSharedOcrRegistry().has("p:b")).toBe(false)
  })

  it("delegates extraction, file, screen, and slash operations to the host runtime", async () => {
    const result = {
      pages: [],
      providerId: "mock",
      combinedMarkdown: "text",
      combinedText: "text",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    } as OcrResult
    const runtime = {
      listAvailableProviders: jest.fn(() => ["mock"]),
      extract: jest.fn(async () => result),
      extractFile: jest.fn(async () => result),
      extractScreen: jest.fn(async () => result),
      runSlashCommand: jest.fn(async () => ({ system: "text", result })),
    }
    const api = createOcrAPI("p", runtime)
    const input = {
      source: { kind: "data-url", dataUrl: "data:image/png;base64,AA==" },
    } as OcrInput

    expect(api.isReady()).toBe(true)
    expect(api.listAvailableProviders()).toEqual(["mock"])
    await expect(api.extract(input)).resolves.toBe(result)
    await expect(api.extractFile("/tmp/a.png", { languages: ["en"] })).resolves.toBe(result)
    await expect(api.extractScreen({ languages: ["en"] })).resolves.toBe(result)
    await expect(api.runSlashCommand('"/tmp/a.png"')).resolves.toEqual({ system: "text", result })

    expect(runtime.extract).toHaveBeenCalledWith(input)
    expect(runtime.extractFile).toHaveBeenCalledWith("/tmp/a.png", { languages: ["en"] })
  })

  it("refuses extraction for a plugin that declared no permissions", () => {
    getPermissionGuard().registerPlugin("unprivileged", [])
    const api = createOcrAPI("unprivileged")

    // `extractFile` reads an arbitrary path and `extractScreen` captures the
    // desktop; neither may run off an undeclared manifest.
    expect(() => api.extractFile("/etc/hosts")).toThrow(/Permission denied/i)
    expect(() => api.extractScreen()).toThrow(/Permission denied/i)
    // Registration stays open — it only touches this plugin's own registry slice.
    expect(() => api.listRegistered()).not.toThrow()
  })

  describe("the host runtime, through the ocr port", () => {
    const portResult = {
      pages: [],
      providerId: "host",
      combinedMarkdown: "**port**",
      combinedText: "port",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    } as OcrResult
    const settings = { defaultProviderId: "auto" }
    const input = {
      source: { kind: "data-url", dataUrl: "data:image/png;base64,AA==" },
    } as OcrInput

    beforeEach(() => {
      mockOcrPort = {
        loadSettings: jest.fn(async () => settings),
        deps: jest.fn((options: Record<string, unknown>) => ({ built: options })),
        extract: jest.fn(async () => portResult),
      }
    })

    it("extracts with the person's settings", async () => {
      await expect(createOcrAPI("p").extract(input)).resolves.toBe(portResult)
      expect(mockOcrPort!.deps).toHaveBeenCalledWith({ settings })
      expect(mockOcrPort!.extract).toHaveBeenCalledWith(input, { built: { settings } })
    })

    it("reads a file path through the desktop file resolver", async () => {
      await createOcrAPI("p").extractFile("/tmp/a.png", { languages: ["en"] })
      const [request, deps] = mockOcrPort!.extract.mock.calls[0]
      expect(request).toEqual({
        languages: ["en"],
        source: { kind: "file-path", path: "/tmp/a.png" },
      })
      expect(deps.built).toEqual({ settings, filePathResolver: expect.any(Function) })
    })

    it("runs /ocr with the port's extract", async () => {
      const out = await createOcrAPI("p").runSlashCommand('"/tmp/a.png"')
      expect(out.result).toBe(portResult)
      expect(mockOcrPort!.extract).toHaveBeenCalledTimes(1)
    })

    it("fails with a typed error where no module provides OCR", async () => {
      mockOcrPort = null
      await expect(createOcrAPI("p").extract(input)).rejects.toMatchObject({
        name: "OcrError",
        code: "unsupported_shell",
      })
    })
  })
})
