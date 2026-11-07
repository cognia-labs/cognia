import { parseCouncilArgs, resolveCouncilRoster } from "./roster"

describe("parseCouncilArgs", () => {
  it("returns the prompt when no flags are present", () => {
    expect(parseCouncilArgs("how do we scale?")).toEqual({
      prompt: "how do we scale?",
      models: undefined,
      synth: undefined,
    })
  })

  it("extracts --models and --synth and leaves the prompt", () => {
    const p = parseCouncilArgs("--models fast,smart  pick a db --synth judge")
    expect(p.models).toEqual(["fast", "smart"])
    expect(p.synth).toBe("judge")
    expect(p.prompt).toBe("pick a db")
  })

  it("trims empty model entries", () => {
    expect(parseCouncilArgs("--models a,,b q").models).toEqual(["a", "b"])
  })
})

describe("resolveCouncilRoster", () => {
  it("uses explicit --models and a distinct synthesizer from available aliases", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a", "b"] }, ["a", "b", "c"])
    expect("councillors" in r && r.councillors.map((c) => c.modelAlias)).toEqual(["a", "b"])
    expect("councillors" in r && r.synthesizerAlias).toBe("c")
  })

  it("auto-selects councillors from configured aliases (capped at 3)", () => {
    const r = resolveCouncilRoster({ prompt: "q" }, ["a", "b", "c", "d"])
    expect("councillors" in r && r.councillors.length).toBe(3)
  })

  it("falls back to a councillor alias as synthesizer when none is distinct", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a"] }, ["a"])
    expect("councillors" in r && r.synthesizerAlias).toBe("a")
  })

  it("dedupes councillor aliases", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a", "a", "b"] }, [])
    expect("councillors" in r && r.councillors.map((c) => c.modelAlias)).toEqual(["a", "b"])
  })

  it("errors when there is nothing to convene", () => {
    const r = resolveCouncilRoster({ prompt: "q" }, [])
    expect("error" in r && r.error).toMatch(/No models to convene/)
  })
})
