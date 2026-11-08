import a2uiModule from "./module"

describe("a2ui module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(a2uiModule).toMatchObject({ id: "a2ui", kind: "module", stage: "stable" })
    expect(a2uiModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("provides the system-prompt section and the interactive page from its own port files", async () => {
    expect(a2uiModule.provides?.map((provision) => provision.port)).toEqual([
      "a2ui-system-prompt",
      "interactive-page",
    ])
    jest.doMock("./ports/system-prompt", () => ({ port: { marker: "system-prompt" } }))
    jest.doMock("./ports/interactive-page", () => ({ port: { marker: "interactive-page" } }))
    const [systemPrompt, interactivePage] = await Promise.all(
      a2uiModule.provides!.map((provision) => provision.load())
    )
    expect(systemPrompt.port).toEqual({ marker: "system-prompt" })
    expect(interactivePage.port).toEqual({ marker: "interactive-page" })
  })

  it("contributes its prompts to the catalog", async () => {
    jest.doMock("./prompts-contribution", () => ({ prompts: ["marker"] }))
    const loaded = await a2uiModule.prompts!()
    expect(loaded.prompts).toEqual(["marker"])
  })

  it("owns the A2UI data files and does not depend on the connectors", () => {
    expect(a2uiModule.owns).toEqual([
      "lib/db/a2ui-apps.ts",
      "lib/db/a2ui-event-history.ts",
      "lib/db/a2ui-surfaces.ts",
    ])
    expect(a2uiModule.dependsOn).not.toContain("connectors")
  })

  it("lists concrete files, never the barrels, as its api", () => {
    expect(a2uiModule.api).toEqual(
      expect.arrayContaining(["components/a2ui/a2ui-surface.tsx", "stores/a2ui/a2ui-store.ts"])
    )
    expect(a2uiModule.api).not.toEqual(
      expect.arrayContaining(["components/a2ui/index.ts", "stores/a2ui/index.ts"])
    )
  })

  it("builds ctx.a2ui through its plugin API", async () => {
    expect(a2uiModule.pluginApi?.namespaces).toEqual(["a2ui"])
    const { pluginApi } = await a2uiModule.pluginApi!.load()
    expect(typeof pluginApi.namespaces?.a2ui).toBe("function")
    expect(typeof pluginApi.unload).toBe("function")
  })
})
