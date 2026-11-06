import larkDocsModule from "./module"

describe("lark-docs module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(larkDocsModule).toMatchObject({ id: "lark-docs", kind: "module", stage: "stable" })
    expect(larkDocsModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("reads documents through twin's Lark fetcher", () => {
    expect(larkDocsModule.dependsOn).toEqual(["twin"])
  })

  it("adds one member to the docs-provider collection port from its own port file", async () => {
    expect(larkDocsModule.provides?.map((provision) => provision.port)).toEqual(["docs-provider"])
    jest.doMock("./port", () => ({ port: { marker: true } }))
    const loaded = await larkDocsModule.provides![0].load()
    expect(loaded.port).toEqual({ marker: true })
  })
})
