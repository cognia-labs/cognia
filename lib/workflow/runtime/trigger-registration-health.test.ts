import {
  getWorkflowTriggerHealth,
  recordTriggerRegistration,
  recordMirrorPersistFailure,
  subscribeWorkflowTriggerHealth,
  resetWorkflowTriggerHealthForTest,
  REPORTED_MIRROR_RUNS_CAP,
} from "./trigger-registration-health"

beforeEach(resetWorkflowTriggerHealthForTest)

it("retains the latest outcome per workflow-scoped trigger and notifies subscribers", () => {
  const listener = jest.fn()
  const stop = subscribeWorkflowTriggerHealth(listener)
  recordTriggerRegistration({ workflowId: "a", triggerId: "t", status: "failed", error: "offline" })
  recordTriggerRegistration({ workflowId: "b", triggerId: "t", status: "registered" })
  recordTriggerRegistration({ workflowId: "a", triggerId: "t", status: "registered" })
  expect(getWorkflowTriggerHealth().registrations).toEqual([
    expect.objectContaining({ workflowId: "a", status: "registered" }),
    expect.objectContaining({ workflowId: "b", status: "registered" }),
  ])
  expect(getWorkflowTriggerHealth().registrations[0].error).toBeUndefined()
  expect(listener).toHaveBeenCalledTimes(3)
  stop()
  recordMirrorPersistFailure("run", "a", new Error("disk full"))
  expect(listener).toHaveBeenCalledTimes(3)
  expect(getWorkflowTriggerHealth().lastMirrorPersistFailure).toMatchObject({
    runId: "run",
    workflowId: "a",
    error: "disk full",
  })
})

it("records every mirror failure while leaving registration outcomes intact", () => {
  recordTriggerRegistration({ workflowId: "a", triggerId: "t", status: "failed", error: "offline" })
  recordMirrorPersistFailure("one", "a", "first")
  recordMirrorPersistFailure("two", "b", new Error("second"))
  expect(getWorkflowTriggerHealth().lastMirrorPersistFailure).toMatchObject({
    runId: "two",
    error: "second",
  })
  expect(getWorkflowTriggerHealth().registrations).toHaveLength(1)
})

it("does not let a broken observer turn a registration outcome into a runtime failure", () => {
  subscribeWorkflowTriggerHealth(() => {
    throw new Error("observer failed")
  })
  const listener = jest.fn()
  subscribeWorkflowTriggerHealth(listener)
  expect(() => recordMirrorPersistFailure("run", "wf", "disk full")).not.toThrow()
  expect(listener).toHaveBeenCalledTimes(1)
})

it("identifies only the first mirror failure for a run, across resumed invocations", () => {
  expect(recordMirrorPersistFailure("r", "wf", "first")).toBe(true)
  expect(recordMirrorPersistFailure("other", "wf", "first")).toBe(true)
  expect(recordMirrorPersistFailure("r", "wf", "again")).toBe(false)
  expect(getWorkflowTriggerHealth().lastMirrorPersistFailure?.error).toBe("again")
})

it("keeps a bounded set of reported runs, so a host whose mirror stays down does not grow", () => {
  expect(recordMirrorPersistFailure("first", "wf", "down")).toBe(true)
  for (let index = 0; index < REPORTED_MIRROR_RUNS_CAP; index += 1) {
    recordMirrorPersistFailure(`run-${index}`, "wf", "down")
  }
  // The oldest id was evicted and reports again; a recent one does not.
  expect(recordMirrorPersistFailure("first", "wf", "down")).toBe(true)
  expect(recordMirrorPersistFailure(`run-${REPORTED_MIRROR_RUNS_CAP - 1}`, "wf", "down")).toBe(
    false
  )
})
