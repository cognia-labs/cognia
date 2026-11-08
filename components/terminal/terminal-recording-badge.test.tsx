/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import {
  __resetSessionRecordingsForTesting,
  startSessionRecording,
  stopSessionRecording,
} from "@/lib/terminal/recording/session-recordings"

import { TerminalRecordingBadge } from "./terminal-recording-badge"

function fakeSession(id: string) {
  return {
    id,
    isExited: false,
    tapData: () => () => undefined,
    onExit: () => () => undefined,
  }
}

let clock = 0
const now = () => clock

beforeEach(() => {
  __resetSessionRecordingsForTesting()
  clock = 10_000
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  __resetSessionRecordingsForTesting()
})

describe("TerminalRecordingBadge", () => {
  it("renders nothing for a tab that is not recorded", () => {
    render(<TerminalRecordingBadge sessionId="s-1" now={now} />)
    expect(screen.queryByTestId("terminal-recording-badge")).toBeNull()
  })

  it("shows a live recording with its elapsed time, ticking", () => {
    startSessionRecording({ session: fakeSession("s-1"), title: "zsh", now })
    render(<TerminalRecordingBadge sessionId="s-1" now={now} />)
    const badge = screen.getByTestId("terminal-recording-badge")
    expect(badge).toHaveAttribute("data-state", "recording")
    expect(badge).toHaveTextContent("0:00")
    act(() => {
      clock += 65_000
      jest.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId("terminal-recording-badge")).toHaveTextContent("1:05")
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", 'recording:{"time":"1:05"}')
  })

  it("marks a take that ended but is not saved", () => {
    startSessionRecording({ session: fakeSession("s-1"), title: "zsh", now })
    act(() => {
      stopSessionRecording("s-1")
    })
    render(<TerminalRecordingBadge sessionId="s-1" now={now} />)
    const badge = screen.getByTestId("terminal-recording-badge")
    expect(badge).toHaveAttribute("data-state", "unsaved")
    expect(badge).toHaveAttribute("aria-label", "unsaved")
  })
})
