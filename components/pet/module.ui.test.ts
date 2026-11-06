import petUi from "./module.ui"

jest.mock("@/components/settings/pet/pet-section", () => ({
  __esModule: true,
  default: function PetSection() {
    return null
  },
}))
jest.mock("./pet-mount", () => ({
  __esModule: true,
  default: function PetMount() {
    return null
  },
}))

describe("pet UI manifest", () => {
  it("puts the Pet section after Discover in Appearance, on the desktop only", () => {
    const [section] = petUi.settingsSections
    expect(section).toMatchObject({
      id: "pet",
      group: "appearance",
      icon: "PawPrint",
      label: "pet.settingsSection.label",
      description: "pet.settingsSection.description",
      after: "discover",
      profiles: ["desktop"],
    })
    expect(section.keywords).toEqual(expect.arrayContaining(["mascot", "桌宠"]))
  })

  it("mounts the pet controller as its one effect", async () => {
    expect(petUi.effects.map((effect) => effect.name)).toEqual(["pet-mount"])
    const loaded = await petUi.effects[0].load()
    expect(typeof loaded.default).toBe("function")
  })

  it("loads the settings section lazily, as a default export", async () => {
    const loaded = await petUi.settingsSections[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
