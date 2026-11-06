/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/lib/speech/settings", () => ({
  useSpeechSettingsView: <T,>(selector: (settings: Record<string, unknown>) => T): T =>
    selector({ realtimeVoice: "marin", realtimeModel: "gpt-realtime" }),
  speechSettingsView: { update: (patch: unknown) => saveMock(patch) },
}))
jest.mock("@/lib/speech/provider-keys", () => ({
  useSpeechProviderKeys: <T,>(selector: (keys: Record<string, string>) => T): T => selector({}),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./api-key-input", () => ({
  ApiKeyInput: ({ label }: { label: string }) => <div data-testid="api-key">{label}</div>,
}))

import {
  ElevenLabsConfig,
  LocalOpenAiCompatibleConfig,
  MistralConfig,
  PROVIDER_CONFIG_COMPONENTS,
} from "./provider-config"

beforeEach(() => {
  saveMock.mockClear()
})

describe("MistralConfig", () => {
  it("registers in the provider component map", () => {
    expect(PROVIDER_CONFIG_COMPONENTS.mistral).toBe(MistralConfig)
  })

  it("persists the reusable voice id once, on blur, not per keystroke", async () => {
    render(<MistralConfig />)
    const input = screen.getByPlaceholderText("mistralVoiceIdPlaceholder")
    fireEvent.change(input, { target: { value: "voice" } })
    fireEvent.change(input, { target: { value: "voice-123" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ mistralVoiceId: "voice-123" })
  })
})

describe("ElevenLabsConfig", () => {
  it("persists a typed voice id once, on Enter, not per keystroke", async () => {
    render(<ElevenLabsConfig />)
    const input = screen.getByPlaceholderText("elevenVoiceIdPlaceholder")
    fireEvent.change(input, { target: { value: "a" } })
    fireEvent.change(input, { target: { value: "adam" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ elevenlabsVoice: "adam" })
  })
})

describe("LocalOpenAiCompatibleConfig", () => {
  it("registers one generic local provider and persists its endpoint", () => {
    expect(PROVIDER_CONFIG_COMPONENTS["local-openai-compatible"]).toBe(LocalOpenAiCompatibleConfig)
    render(<LocalOpenAiCompatibleConfig />)
    fireEvent.change(screen.getByPlaceholderText("localEndpointPlaceholder"), {
      target: { value: "http://127.0.0.1:8880/v1" },
    })
    expect(saveMock).toHaveBeenCalledWith({
      localOpenaiBaseUrl: "http://127.0.0.1:8880/v1",
    })
    expect(screen.getByTestId("api-key")).toHaveTextContent("label.local-openai-compatible")
  })
})
