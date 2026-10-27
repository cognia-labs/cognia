import { careActionsFor, suggestPetCare } from "./suggest-care"

describe("careActionsFor", () => {
  it("ranks the restorers of each need from the controller's effect table", () => {
    expect(careActionsFor("energy")).toEqual(["slept", "fed"])
    expect(careActionsFor("mood")[0]).toBe("played")
    expect(careActionsFor("bond")[0]).toBe("petted")
  })

  it("never offers talk, which the speak pipeline owns", () => {
    for (const need of ["energy", "mood", "bond"] as const) {
      expect(careActionsFor(need)).not.toContain("talked")
    }
  })
})

describe("suggestPetCare", () => {
  it("picks the lowest need and its best restorer", () => {
    expect(suggestPetCare({ energy: 80, mood: 30, bond: 70 })).toEqual({
      status: "needs",
      need: "mood",
      value: 30,
      tone: "attention",
      action: "played",
      cooldownMs: 0,
    })
  })

  it("grades urgency against the care thresholds", () => {
    const tone = (energy: number) =>
      suggestPetCare({ energy, mood: 90, bond: 90 }).status === "needs"
        ? (suggestPetCare({ energy, mood: 90, bond: 90 }) as { tone: string }).tone
        : "content"
    expect(tone(10)).toBe("urgent")
    expect(tone(40)).toBe("attention")
    expect(tone(55)).toBe("suggest")
    expect(tone(75)).toBe("content")
  })

  it("is content when every need is comfortable", () => {
    expect(suggestPetCare({ energy: 60, mood: 61, bond: 99 })).toEqual({ status: "content" })
  })

  it("breaks ties in energy, mood, bond order", () => {
    const result = suggestPetCare({ energy: 20, mood: 20, bond: 20 })
    expect(result).toMatchObject({ need: "energy" })
  })

  it("skips an action that is cooling down", () => {
    const cooling = (kind: string) => (kind === "slept" ? 5_000 : 0)
    expect(suggestPetCare({ energy: 10, mood: 90, bond: 90 }, cooling)).toMatchObject({
      action: "fed",
      cooldownMs: 0,
    })
  })

  it("offers the best action with its cooldown when every one is cooling", () => {
    const cooling = (kind: string) => (kind === "slept" ? 4_000 : 9_000)
    expect(suggestPetCare({ energy: 10, mood: 90, bond: 90 }, cooling)).toMatchObject({
      action: "slept",
      cooldownMs: 4_000,
    })
  })

  it("rounds the reported value", () => {
    expect(suggestPetCare({ energy: 22.6, mood: 90, bond: 90 })).toMatchObject({ value: 23 })
  })
})
