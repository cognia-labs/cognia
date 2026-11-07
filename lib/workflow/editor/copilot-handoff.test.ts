import { queueCopilotRequest, takeCopilotRequest } from "./copilot-handoff"

describe("copilot handoff", () => {
  it("hands a queued request to the editor once", () => {
    queueCopilotRequest("wf_a", "Draft this")
    expect(takeCopilotRequest("wf_a")).toBe("Draft this")
    expect(takeCopilotRequest("wf_a")).toBeUndefined()
  })

  it("keeps requests for different workflows apart", () => {
    queueCopilotRequest("wf_a", "A")
    queueCopilotRequest("wf_b", "B")
    expect(takeCopilotRequest("wf_b")).toBe("B")
    expect(takeCopilotRequest("wf_a")).toBe("A")
  })

  it("has nothing for a workflow nobody queued", () => {
    expect(takeCopilotRequest("wf_none")).toBeUndefined()
  })
})
