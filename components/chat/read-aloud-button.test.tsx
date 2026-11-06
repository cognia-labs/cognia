import * as React from "react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

jest.mock("@/components/ai-elements/message", () => ({
  MessageAction: ({
    children,
    onClick,
    tooltip,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    tooltip?: string
    className?: string
  }) => React.createElement("button", { onClick, "aria-label": tooltip, className }, children),
}))

const mockStatus = { available: true, isActive: false, isLoading: false }
jest.mock("@/hooks/chat/use-read-aloud-status", () => ({
  useReadAloudStatus: () => mockStatus,
}))

const speakChatMessage = jest.fn().mockResolvedValue(undefined)
const stop = jest.fn()
const speech = {
  readAloud: {
    speakChatMessage: (...args: unknown[]) => speakChatMessage(...args),
    stop: () => stop(),
  },
} as unknown as SpeechPort

jest.mock("@cognia/logging", () => ({ loggers: { tts: { warn: jest.fn() } } }))

import { act, render, screen, fireEvent } from "@testing-library/react"
import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { SpeechPort } from "@/types/modules/ports/speech"
import { ReadAloudButton } from "./read-aloud-button"

/** Let the speech port's (already resolved) load hand over to the click. */
const flush = () => act(async () => {})

beforeEach(() => {
  __resetPortsForTesting()
  __setPortForTesting("speech", speech)
  mockStatus.available = true
  speakChatMessage.mockClear()
  stop.mockClear()
  mockStatus.isActive = false
  mockStatus.isLoading = false
})

describe("ReadAloudButton", () => {
  it("shows the read-aloud affordance and speaks on click when idle", async () => {
    render(<ReadAloudButton messageId="m1" text="hello world" character={null} />)
    const btn = screen.getByRole("button", { name: "readAloud" })
    fireEvent.click(btn)
    await flush()
    expect(speakChatMessage).toHaveBeenCalledWith({
      messageId: "m1",
      text: "hello world",
      character: null,
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it("forwards the character for per-character voice", async () => {
    const character = { voiceProfile: { provider: "openai" as const, voiceId: "nova" } }
    render(<ReadAloudButton messageId="m2" text="hi" character={character} />)
    fireEvent.click(screen.getByRole("button"))
    await flush()
    expect(speakChatMessage).toHaveBeenCalledWith({ messageId: "m2", text: "hi", character })
  })

  it("shows a stop affordance and stops playback when active", async () => {
    mockStatus.isActive = true
    render(<ReadAloudButton messageId="m1" text="hello" character={null} />)
    const btn = screen.getByRole("button", { name: "stopReading" })
    fireEvent.click(btn)
    await flush()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("logs and does not throw when synthesis rejects", async () => {
    speakChatMessage.mockRejectedValueOnce(new Error("boom"))
    render(<ReadAloudButton messageId="m1" text="hi" character={null} />)
    expect(() => fireEvent.click(screen.getByRole("button"))).not.toThrow()
    await flush()
    expect(speakChatMessage).toHaveBeenCalled()
  })

  it("renders a loading affordance while synthesizing", () => {
    mockStatus.isActive = true
    mockStatus.isLoading = true
    const { container } = render(<ReadAloudButton messageId="m1" text="hi" character={null} />)
    // The spinner uses animate-spin; assert it is present.
    expect(container.querySelector(".animate-spin")).not.toBeNull()
  })

  it("is not drawn where no module provides the speech port", () => {
    mockStatus.available = false
    const { container } = render(<ReadAloudButton messageId="m1" text="hi" character={null} />)
    expect(container.firstChild).toBeNull()
  })
})
