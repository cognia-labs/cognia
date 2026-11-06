import speechModule from "./module"

describe("speech module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(speechModule).toMatchObject({ id: "speech", kind: "module", stage: "stable" })
    expect(speechModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("provides the speech port from its own implementation file", async () => {
    expect(speechModule.provides?.map((provision) => provision.port)).toEqual(["speech"])
    jest.doMock("./port", () => ({ port: { marker: true } }))
    const loaded = await speechModule.provides![0].load()
    expect(loaded.port).toEqual({ marker: true })
  })

  it("owns read-aloud and live voice, with their UI and native bridge", () => {
    expect(speechModule.owns).toEqual(
      expect.arrayContaining(["lib/tts/", "lib/voice/", "hooks/voice/", "lib/tauri/voice-live.ts"])
    )
  })

  it("lists as public only what other modules open: live voice, the voice test, its settings and keys", () => {
    expect(speechModule.api).toEqual([
      "components/chat/composer/live-voice-dialog.tsx",
      "components/settings/speech/test-tts-button.tsx",
      "lib/speech/provider-keys.ts",
      "lib/speech/settings.ts",
    ])
  })

  it("claims every read-aloud, voice input and live voice key for its settings section", () => {
    const keys = speechModule.settings.keys
    expect("section" in speechModule.settings).toBe(false)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(
      expect.arrayContaining([
        "ttsEnabled",
        "ttsProvider",
        "sttLanguage",
        "liveVoice",
        "ttsCustomSSML",
        "ttsPronunciationDictionary",
      ])
    )
  })
})
