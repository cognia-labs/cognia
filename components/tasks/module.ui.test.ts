import tasksUi from "./module.ui"

jest.mock("./tasks-dock-panel", () => ({
  __esModule: true,
  default: function TasksDockPanel() {
    return null
  },
}))

describe("the tasks UI manifest", () => {
  it("mounts the Tasks dock panel as an effect", async () => {
    expect(tasksUi.id).toBe("tasks")
    expect(tasksUi.effects?.map((effect) => effect.name)).toEqual(["tasks-dock-panel"])
    const loaded = await tasksUi.effects![0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
