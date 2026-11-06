import ocrUi from "./module.ui"

jest.mock("@/components/settings/ocr/ocr-section-persisted", () => ({
  __esModule: true,
  default: function OcrSectionPersisted() {
    return null
  },
}))

describe("OCR UI manifest", () => {
  it("keeps the OCR section where it was: after Memory in Capabilities, filling the pane", () => {
    const [section] = ocrUi.settingsSections
    expect(section).toMatchObject({
      id: "ocr",
      group: "capabilities",
      icon: "ScrollText",
      label: "settings.tabs.ocr",
      description: "settings.descriptions.ocr",
      after: "memory",
      layout: "fill",
    })
    expect(section.keywords).toEqual(
      expect.arrayContaining(["tesseract", "mistral ocr", "apple vision", "光学字符识别"])
    )
  })

  it("is offered on every host, as the built-in section was", () => {
    const [section] = ocrUi.settingsSections
    expect("profiles" in section).toBe(false)
    expect("requires" in section).toBe(false)
  })

  it("loads the persisted settings section lazily, as a default export", async () => {
    const loaded = await ocrUi.settingsSections[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
