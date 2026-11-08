import squadsUi from "./module.ui"

jest.mock("./room-handoff/room-handoff-card-effect", () => ({
  __esModule: true,
  default: function RoomHandoffCardEffect() {
    return null
  },
}))
jest.mock("@/components/settings/squads/squads-section", () => ({
  __esModule: true,
  default: function SquadsSection() {
    return null
  },
}))

describe("squads UI manifest", () => {
  it("puts the Squads section after Subagents in the Agents group, owning its scroll", () => {
    const [section] = squadsUi.settingsSections
    expect(section).toMatchObject({
      id: "squads",
      group: "agents",
      icon: "Users",
      label: "squads.settingsSection.label",
      description: "squads.settingsSection.description",
      after: "subagents",
      layout: "fill",
    })
    expect(section.keywords).toEqual(expect.arrayContaining(["squad", "小队", "multi-agent"]))
  })

  it("loads the section component lazily, as a default export", async () => {
    const loaded = await squadsUi.settingsSections[0].load()
    expect(typeof loaded.default).toBe("function")
  })

  it("contributes the room hand-off card as an effect", async () => {
    expect(squadsUi.effects.map((effect) => effect.name)).toEqual(["room-handoff-card"])
    const loaded = await squadsUi.effects[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
