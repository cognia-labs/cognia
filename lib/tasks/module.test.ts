import { SPAWN_TASK_TOOL_NAME } from "./spawn-task-core"
import tasksModule from "./module"

describe("the tasks manifest", () => {
  it("declares spawn_task as a write under the run's approval that cannot be cancelled", () => {
    expect(tasksModule.tools!.declare).toEqual({
      [SPAWN_TASK_TOOL_NAME]: { consent: "default", effect: "write", cancellable: false },
    })
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await tasksModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
