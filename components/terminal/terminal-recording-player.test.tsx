/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockTerminals: MockTerminal[] = []
class MockTerminal {
  options: Record<string, unknown>
  written: string[] = []
  open = jest.fn()
  reset = jest.fn(() => {
    this.written.push("<reset>")
  })
  resize = jest.fn()
  dispose = jest.fn()
  constructor(options: Record<string, unknown>) {
    this.options = options
    mockTerminals.push(this)
  }
  write(data: string) {
    this.written.push(data)
  }
}
jest.mock("@xterm/xterm", () => ({ Terminal: MockTerminal }))
jest.mock("@xterm/xterm/css/xterm.css", () => ({}))

import type { TerminalRecording } from "@/lib/terminal/recording/types"

import { TerminalRecordingPlayer } from "./terminal-recording-player"

class MockResizeObserver {
  observe = jest.fn()
  unobserve = jest.fn()
  disconnect = jest.fn()
}
;(global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver

function recording(overrides: Partial<TerminalRecording> = {}): TerminalRecording {
  return {
    id: "r1",
    sessionId: "s-1",
    title: "zsh session",
    header: { version: 2, width: 100, height: 30, duration: 1 },
    frames: [
      [0, "o", "first"],
      [0.5, "r", "120x40"],
      [1, "o", "second"],
    ],
    duration: 1,
    createdAt: 0,
    sizeBytes: 10,
    ...overrides,
  }
}

beforeEach(() => {
  mockTerminals.length = 0
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe("TerminalRecordingPlayer", () => {
  it("is closed without a recording", () => {
    render(<TerminalRecordingPlayer recording={null} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("terminal-recording-player")).toBeNull()
  })

  it("plays the recording in a terminal sized to it, following resizes", async () => {
    render(<TerminalRecordingPlayer recording={recording()} onOpenChange={jest.fn()} />)
    await waitFor(() => expect(mockTerminals).toHaveLength(1))
    await flush()
    const term = mockTerminals[0]
    expect(term.options).toMatchObject({ cols: 100, rows: 30, disableStdin: true })
    expect(term.written).toEqual(["first"])
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })
    expect(term.resize).toHaveBeenCalledWith(120, 40)
    expect(term.written).toEqual(["first", "second"])
    expect(screen.getByTestId("terminal-recording-player-time")).toHaveTextContent(
      'position:{"current":"0:01","total":"0:01"}'
    )
    expect(screen.getByText("zsh session")).toBeInTheDocument()
  })

  it("pauses and resumes from the toggle", async () => {
    render(<TerminalRecordingPlayer recording={recording()} onOpenChange={jest.fn()} />)
    await waitFor(() => expect(mockTerminals).toHaveLength(1))
    await flush()
    const toggle = screen.getByTestId("terminal-recording-player-toggle")
    expect(toggle).toHaveAttribute("aria-label", "player.pause")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-label", "player.play")
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    // Paused: the second frame never drew.
    expect(mockTerminals[0].written).toEqual(["first"])
  })

  it("changes the playback speed", async () => {
    render(<TerminalRecordingPlayer recording={recording()} onOpenChange={jest.fn()} />)
    await waitFor(() => expect(mockTerminals).toHaveLength(1))
    await flush()
    fireEvent.click(screen.getByTestId("terminal-recording-player-speed-4"))
    await act(async () => {
      jest.advanceTimersByTime(260)
    })
    expect(mockTerminals[0].written).toEqual(["first", "second"])
  })

  it("says so when a recording has no output", async () => {
    render(
      <TerminalRecordingPlayer
        recording={recording({ frames: [], duration: 0 })}
        onOpenChange={jest.fn()}
      />
    )
    expect(screen.getByText("player.empty")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-recording-player-toggle")).toBeDisabled()
  })

  it("disposes the terminal when closed", async () => {
    const { rerender } = render(
      <TerminalRecordingPlayer recording={recording()} onOpenChange={jest.fn()} />
    )
    await waitFor(() => expect(mockTerminals).toHaveLength(1))
    await flush()
    rerender(<TerminalRecordingPlayer recording={null} onOpenChange={jest.fn()} />)
    expect(mockTerminals[0].dispose).toHaveBeenCalled()
  })
})
