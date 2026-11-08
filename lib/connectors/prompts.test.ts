import { CONNECTOR_CAPABILITY_PROMPTS } from "./a2ui-bridge/capability-evaluator"
import { prompts } from "./prompts"

describe("connectors prompt contributions", () => {
  it("lists every channel capability prompt once", () => {
    const ids = prompts.map((prompt) => prompt.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(
      Object.values(CONNECTOR_CAPABILITY_PROMPTS)
        .map((prompt) => prompt.id)
        .sort()
    )
    expect(ids.length).toBeGreaterThan(0)
  })
})
