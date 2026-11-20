import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@cognia/logging", () => ({ loggers: { tts: { info: jest.fn() } } }))

const save = jest.fn()
let settings: Record<string, unknown> | null = { sttLanguage: "en-US", language: "en" }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ settings, save }),
}))

import { SttCard } from "./stt-card"

const enumerateDevices = jest.fn()

beforeEach(() => {
  settings = { sttLanguage: "en-US", language: "en" }
  enumerateDevices.mockReset().mockResolvedValue([])
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices },
  })
  delete (window as { SpeechRecognition?: unknown }).SpeechRecognition
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
})

describe("SttCard", () => {
  it("is a flat settings block titled as a section heading, not a card", async () => {
    const { container } = render(<SttCard />)
    expect(screen.getByRole("heading", { level: 2, name: "title" })).toBeInTheDocument()
    expect(screen.getByText("description")).toBeInTheDocument()
    expect(container.querySelector("section")).not.toBeNull()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
  })

  it("flags a browser without the Web Speech API", async () => {
    render(<SttCard />)
    expect(screen.getByText("notSupported")).toBeInTheDocument()
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
  })

  it("shows no flag where the Web Speech API exists", async () => {
    ;(window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = function () {}
    render(<SttCard />)
    expect(screen.queryByText("notSupported")).not.toBeInTheDocument()
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
  })

  it("asks for microphone permission while no microphone is listed", async () => {
    render(<SttCard />)
    await waitFor(() => expect(screen.getByText("micPermissionHint")).toBeInTheDocument())
  })

  it("says the microphone choice reaches live voice only, not dictation", async () => {
    render(<SttCard />)
    expect(screen.getByTestId("stt-microphone-scope")).toHaveTextContent("microphoneLiveOnly")
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
  })

  it.each(["en", "zh-CN"])(
    "%s copy no longer promises that the picker drives dictation",
    (locale) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const stt = require(`@/i18n/messages/${locale}/settings/speech.json`).stt as Record<
        string,
        string
      >
      expect(stt.microphoneLiveOnly).toBeTruthy()
      expect(stt.description).not.toMatch(/microphone|麦克风/i)
    }
  )

  it("stops hinting once a microphone is listed", async () => {
    enumerateDevices.mockResolvedValue([
      { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
      { kind: "videoinput", deviceId: "cam-1", label: "Camera" },
    ])
    render(<SttCard />)
    await waitFor(() => expect(screen.queryByText("micPermissionHint")).not.toBeInTheDocument())
  })
})
