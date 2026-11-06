import radarUi from "./module.ui"

jest.mock("./pet-console-tab", () => ({
  __esModule: true,
  default: function RadarPetConsoleTab() {
    return null
  },
}))

describe("radar UI manifest", () => {
  it("fills the pet console's Extensions tab and nothing else", () => {
    expect(Object.keys(radarUi.slots ?? {})).toEqual(["pet.console.tab"])
    expect("settingsSections" in radarUi).toBe(false)
    expect("effects" in radarUi).toBe(false)
  })

  it("loads the tab lazily, as a default export", async () => {
    const loaded = await radarUi.slots!["pet.console.tab"]!()
    expect(typeof loaded.default).toBe("function")
  })
})
