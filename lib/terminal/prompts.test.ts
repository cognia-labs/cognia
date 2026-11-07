import { prompts } from "./prompts"

describe("terminal prompt contributions", () => {
  it("lists the completion and AI shell prompts once each", () => {
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "completion.terminal",
      "developer.ai-shell.plan",
      "developer.ai-shell.error-advisor",
    ])
  })
})
