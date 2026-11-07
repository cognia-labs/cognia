import { assertWorkflowWritable, isWorkflowReadOnly, WorkflowReadOnlyError } from "./read-only"

describe("read-only workflows", () => {
  it("treats only an explicit readOnly: true as read-only", () => {
    expect(isWorkflowReadOnly({ readOnly: true })).toBe(true)
    expect(isWorkflowReadOnly({ readOnly: false })).toBe(false)
    expect(isWorkflowReadOnly({})).toBe(false)
  })

  it("lets an ordinary write through", () => {
    expect(() => assertWorkflowWritable({ id: "wf-1" })).not.toThrow()
    expect(() => assertWorkflowWritable({ id: "wf-1", readOnly: false })).not.toThrow()
  })

  it("refuses a write to a read-only row with a typed error", () => {
    let caught: unknown
    try {
      assertWorkflowWritable({ id: "wf-derived", readOnly: true })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkflowReadOnlyError)
    const error = caught as WorkflowReadOnlyError
    expect(error.code).toBe("workflow_read_only")
    expect(error.workflowId).toBe("wf-derived")
    expect(error.name).toBe("WorkflowReadOnlyError")
    expect(error.message).toContain("wf-derived")
  })
})
