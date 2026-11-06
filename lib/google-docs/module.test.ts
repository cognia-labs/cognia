import googleDocsModule from "./module"

describe("google-docs module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(googleDocsModule).toMatchObject({ id: "google-docs", kind: "module", stage: "stable" })
    expect(googleDocsModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("adds one member to the docs-provider collection port from its own port file", async () => {
    expect(googleDocsModule.provides?.map((provision) => provision.port)).toEqual(["docs-provider"])
    jest.doMock("./port", () => ({ port: { marker: true } }))
    const loaded = await googleDocsModule.provides![0].load()
    expect(loaded.port).toEqual({ marker: true })
  })
})
