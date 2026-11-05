import evalUi from "./module.ui"

jest.mock("@/components/settings/eval/eval-settings-section", () => ({
  __esModule: true,
  default: function EvalSettingsSection() {
    return null
  },
}))

describe("eval UI manifest", () => {
  it("puts the Evaluation section after Fleet in the Agents group", () => {
    const [section] = evalUi.settingsSections
    expect(section).toMatchObject({
      id: "eval",
      group: "agents",
      icon: "ClipboardCheck",
      label: "eval.settingsSection.label",
      description: "eval.settingsSection.description",
      after: "fleet",
    })
    expect("layout" in section).toBe(false)
    expect(section.keywords).toEqual(expect.arrayContaining(["judge", "评估", "calibration"]))
  })

  it("loads the section component lazily, as a default export", async () => {
    const loaded = await evalUi.settingsSections[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
