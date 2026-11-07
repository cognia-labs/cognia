import playbooksModule from "./module"

describe("playbooks module manifest", () => {
  it("declares a beta module whose real-world smoke is still owed", () => {
    expect(playbooksModule).toMatchObject({ id: "playbooks", kind: "module", stage: "beta" })
    expect(playbooksModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("imports no module and exposes only the derived-workflow sync", () => {
    expect(playbooksModule.dependsOn).toEqual([])
    expect(playbooksModule.api).toEqual(["lib/playbooks/derived-workflow.ts"])
  })
})
