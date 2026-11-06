import radarModule from "./module"

describe("radar module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(radarModule).toMatchObject({ id: "radar", kind: "module", stage: "stable" })
    expect(radarModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("claims its report table and builds on the scheduler and the twin", () => {
    expect(radarModule.tables).toEqual(["radarReports"])
    expect(radarModule.dependsOn).toEqual(["scheduler", "twin"])
  })

  it("contributes no destination of its own: its panel lives in the pet console", () => {
    expect("nav" in radarModule).toBe(false)
    expect(radarModule.messages).toBe("radar")
  })
})
