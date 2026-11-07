import { prompts } from "./prompts"

describe("slash-commands prompt contributions", () => {
  it("lists the workflow Copilot turns once each, in the catalog's former order", () => {
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "developer.workflow.slash.run",
      "developer.workflow.slash.run-from-step",
      "developer.workflow.slash.debug",
      "developer.workflow.slash.refactor",
      "developer.workflow.slash.delegate",
    ])
  })
})
