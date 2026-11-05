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
    ])
  })

  it("contributes no search provider or slash command", () => {
    expect("searchProviders" in evalModule).toBe(false)
    expect("slashCommands" in evalModule).toBe(false)
  })
})
