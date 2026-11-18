import { createLocalDirectoryClient } from "./local-directory-client"

jest.mock("./install-from-directory", () => ({
  previewLocalManifest: jest.fn(),
  installPluginFromDirectory: jest.fn(),
}))

import { previewLocalManifest, installPluginFromDirectory } from "./install-from-directory"

const mockPreview = previewLocalManifest as jest.MockedFunction<typeof previewLocalManifest>
const mockInstall = installPluginFromDirectory as jest.MockedFunction<
  typeof installPluginFromDirectory
>

beforeEach(() => {
  mockPreview.mockReset()
  mockInstall.mockReset()
})

describe("createLocalDirectoryClient", () => {
  it("getPlugin reads the manifest via previewLocalManifest", async () => {
    mockPreview.mockResolvedValueOnce({
      id: "demo",
      name: "Demo Plugin",
      version: "1.0.0",
      type: "frontend",
    } as never)
    const client = createLocalDirectoryClient("C:/plugins/demo")
    const result = await client.getPlugin("anything")
    expect(result).toMatchObject({
      manifest: { id: "demo", name: "Demo Plugin" },
      name: "Demo Plugin",
    })
    expect(mockPreview).toHaveBeenCalledWith("C:/plugins/demo")
  })

  it("getPlugin returns null when the manifest can't be read", async () => {
    mockPreview.mockRejectedValueOnce(new Error("nope"))
    const client = createLocalDirectoryClient("C:/plugins/missing")
    const result = await client.getPlugin("demo")
    expect(result).toBeNull()
  })

  it("installPlugin binds the install to the reviewed id and manifest (PL02)", async () => {
    const reviewed = {
      id: "demo",
      name: "Demo Plugin",
      version: "1.0.0",
      type: "frontend",
    }
    mockPreview.mockResolvedValueOnce(reviewed as never)
    mockInstall.mockResolvedValueOnce({ pluginId: "demo", warnings: [] })
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await client.getPlugin("demo")
    const receipt = await client.installPlugin("demo", "1.0.0")
    expect(mockInstall).toHaveBeenCalledWith("C:/plugins/demo", {
      pluginName: "Demo Plugin",
      version: "1.0.0",
      generatedFiles: undefined,
      expectedPluginId: "demo",
      expectedManifest: reviewed,
    })
    expect(receipt).toMatchObject({ pluginId: "demo" })
  })

  it("keeps the first manifest read, so a later read cannot replace what was reviewed", async () => {
    mockPreview
      .mockResolvedValueOnce({ id: "demo", name: "Demo", version: "1.0.0" } as never)
      .mockResolvedValueOnce({ id: "other", name: "Other", version: "9.0.0" } as never)
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await client.getPlugin("demo")
    expect(await client.getPlugin("demo")).toMatchObject({ manifest: { id: "demo" } })
    expect(mockPreview).toHaveBeenCalledTimes(1)
  })

  it("refuses to install a directory nobody reviewed", async () => {
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await expect(client.installPlugin("demo")).rejects.toThrow(/not reviewed/)
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("refuses an install request for another id or version than the review", async () => {
    mockPreview.mockResolvedValueOnce({ id: "demo", name: "Demo", version: "1.0.0" } as never)
    const client = createLocalDirectoryClient("C:/plugins/demo")
    await client.getPlugin("demo")
    await expect(client.installPlugin("other")).rejects.toThrow(/review was of demo@1.0.0/)
    await expect(client.installPlugin("demo", "2.0.0")).rejects.toThrow(/review was of/)
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("binds a converted bundle by id; its manifest is the overlay it sends", async () => {
    const manifest = { id: "claude-review", name: "Review", version: "1.0.0" }
    mockInstall.mockResolvedValueOnce({ pluginId: "claude-review", warnings: [] })
    const client = createLocalDirectoryClient("C:/plugins/claude", {
      manifest: manifest as never,
      generatedFiles: { "plugin.json": "{}" },
    })
    await client.getPlugin("claude-review")
    await client.installPlugin("claude-review", "1.0.0")
    expect(mockInstall).toHaveBeenCalledWith("C:/plugins/claude", {
      pluginName: "Review",
      version: "1.0.0",
      generatedFiles: { "plugin.json": "{}" },
      expectedPluginId: "claude-review",
    })
  })
})
