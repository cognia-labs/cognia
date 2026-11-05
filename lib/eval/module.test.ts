import evalModule from "./module"

describe("eval module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(evalModule).toMatchObject({ id: "eval", kind: "module", stage: "stable" })
    expect(evalModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("claims the paths the ownership table used to split out for it", () => {
    expect(evalModule.owns).toEqual([
      "lib/ai/eval/",
      "lib/plugin/eval/",
      "components/settings/eval/",
      // No other module uses it, so it moved with eval (ADR-0250 §14, G4).
      "lib/db/eval-dataset-versions.ts",
    ])
  })

  it("claims every eval table, and only those", () => {
    expect(evalModule.tables?.length).toBe(20)
    for (const table of evalModule.tables ?? []) expect(table).toMatch(/^eval[A-Z]/)
  })

  it("contributes no search provider or slash command", () => {
    expect("searchProviders" in evalModule).toBe(false)
    expect("slashCommands" in evalModule).toBe(false)
  })
})
