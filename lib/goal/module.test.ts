import goalModule from "./module"
import { prompts } from "./prompts"

describe("goal module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(goalModule).toMatchObject({ id: "goal", kind: "module", stage: "stable" })
    expect(goalModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("opens the runtime, its drivers and the composer's status pill to other modules", () => {
    expect(goalModule.api).toEqual(
      expect.arrayContaining([
        "lib/goal/runtime.ts",
        "lib/goal/turn-driver.ts",
        "components/goal/goal-status-pill.tsx",
      ])
    )
    expect(goalModule.api).not.toContain("lib/goal/context-injector.ts")
  })

  it("contributes its prompts to the catalog", async () => {
    expect((await goalModule.prompts()).prompts).toBe(prompts)
    expect(prompts.map((def) => def.id)).toHaveLength(6)
  })
})
