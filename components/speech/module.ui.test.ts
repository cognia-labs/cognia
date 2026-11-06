import speechUi from "./module.ui"

jest.mock("@/components/settings/speech-section", () => ({
  __esModule: true,
  default: function SpeechSection() {
    return null
  },
}))
jest.mock("@/components/tts/tts-now-playing-bar", () => ({
  __esModule: true,
  default: function TtsNowPlayingBar() {
    return null
  },
}))

describe("speech UI manifest", () => {
  it("keeps the Speech section where it was: after OCR in Capabilities", () => {
    const [section] = speechUi.settingsSections
    expect(section).toMatchObject({
      id: "speech",
      group: "capabilities",
      icon: "Volume2",
      label: "settings.tabs.speech",
      description: "settings.descriptions.speech",
      after: "ocr",
    })
    expect(section.keywords).toEqual(expect.arrayContaining(["tts", "elevenlabs", "朗读", "听写"]))
  })

  it("is offered on every host, as the built-in section was", () => {
    const [section] = speechUi.settingsSections
    expect("profiles" in section).toBe(false)
    expect("hostOperation" in section).toBe(false)
  })

  it("loads the settings section lazily, as a default export", async () => {
    const loaded = await speechUi.settingsSections[0].load()
    expect(typeof loaded.default).toBe("function")
  })

  it("mounts the read-aloud now-playing bar as an effect", async () => {
    expect(speechUi.effects.map((effect) => effect.name)).toEqual(["now-playing-bar"])
    const loaded = await speechUi.effects[0].load()
    expect(typeof loaded.default).toBe("function")
  })
})
