import { prompts } from "./prompts"

describe("workflow prompt contributions", () => {
  it("lists the AI-node and editor Copilot prompts once each", () => {
    const ids = prompts.map((prompt) => prompt.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining(["developer.workflow.slash.run", "developer.workflow.slash.delegate"])
    )
    expect(ids.length).toBeGreaterThanOrEqual(15)
  })
})
