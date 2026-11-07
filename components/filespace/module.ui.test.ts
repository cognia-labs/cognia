import filespaceUi from "./module.ui"

jest.mock("./files-dock-panel", () => ({
  __esModule: true,
  default: function FilesDockPanel() {
    return null
  },
}))

describe("the filespace UI manifest", () => {
  it("contributes the Files dock panel as an effect", async () => {
    expect(filespaceUi.effects.map((effect) => effect.name)).toEqual(["files-dock-panel"])
    const loaded = await filespaceUi.effects[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
