jest.mock("./im-push-executor", () => ({ executeImPushTask: jest.fn() }))

import { executeImPushTask } from "./im-push-executor"
import { taskExecutors } from "./task-executors"

describe("connectors task executors", () => {
  it("provides exactly the im-push executor", () => {
    expect(Object.keys(taskExecutors)).toEqual(["im-push"])
    expect(taskExecutors["im-push"]).toBe(executeImPushTask)
  })
})
