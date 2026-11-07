import { ASSESS_ROUTING_PROMPT } from "./auto/assess-routing"
import { NUDGE_CONTINUE_PROMPT } from "./durable/rate-limit-resume"
import squadsModule from "./module"
import { PATTERN_PROMPTS } from "./patterns/pattern-prompts"
import { prompts } from "./prompts"
import { LEAD_PLANNING_PROMPT, ULTRACODE_PLANNER_PROMPT } from "./team-prompts"

describe("squads prompts", () => {
  it("lists every Squad prompt once", () => {
    expect(new Set(prompts.map((def) => def.id)).size).toBe(prompts.length)
    for (const def of [
      ASSESS_ROUTING_PROMPT,
      LEAD_PLANNING_PROMPT,
      ULTRACODE_PLANNER_PROMPT,
      NUDGE_CONTINUE_PROMPT,
      ...PATTERN_PROMPTS,
    ])
      expect(prompts).toContain(def)
  })

  it("is what the manifest contributes to the prompt catalog", async () => {
    expect((await squadsModule.prompts!()).prompts).toBe(prompts)
  })
})
