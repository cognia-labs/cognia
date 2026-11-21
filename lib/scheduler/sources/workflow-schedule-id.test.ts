import { parseWorkflowScheduleSourceId, workflowScheduleSourceId } from "./workflow-schedule-id"

describe("workflow schedule source ids", () => {
  it("round-trips workflow and trigger ids, escaping separators", () => {
    const id = workflowScheduleSourceId("wf:a", "t/1")
    expect(id).toBe("wf%3Aa:t%2F1")
    expect(parseWorkflowScheduleSourceId(id)).toEqual({ workflowId: "wf:a", triggerId: "t/1" })
  })

  it("refuses a bare node id, extra separators and malformed escapes", () => {
    expect(parseWorkflowScheduleSourceId("bare-node-id")).toBeUndefined()
    expect(parseWorkflowScheduleSourceId("a:b:c")).toBeUndefined()
    expect(parseWorkflowScheduleSourceId(":b")).toBeUndefined()
    expect(parseWorkflowScheduleSourceId("%E0%A4%A:b")).toBeUndefined()
  })
})
