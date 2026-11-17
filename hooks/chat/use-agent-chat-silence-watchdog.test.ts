/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { useAgentChatSilenceWatchdog } from "./use-agent-chat-silence-watchdog"

type Options = {
  onSilent: (sessionId: string, silentForMs: number) => void
  onRecovered: (sessionId: string) => void
}
let options: Options | null = null
const watchdog = { armed: jest.fn(() => ["s1"]), disarm: jest.fn(), dispose: jest.fn() }
jest.mock("@/lib/chat/silence-watchdog", () => ({
  createSilenceWatchdog: (o: Options) => {
    options = o
    return watchdog
  },
}))

type Session = { status: string; errorDiagnostic?: { code: string } | null }
let listener: ((state: unknown, previous?: unknown) => void) | null = null
const chat = {
  sessions: {} as Record<string, Session>,
  setSessionDiagnostic: jest.fn(),
}
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => chat,
    subscribe: (fn: (state: unknown, previous?: unknown) => void) => {
      listener = fn
      return () => {
        listener = null
      }
    },
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  chat.sessions = {}
})

it("warns about a silent running turn, never over a real failure or an idle one", () => {
  const { result } = renderHook(() => useAgentChatSilenceWatchdog())
  expect(result.current.silenceWatchdogRef.current).toBe(watchdog)

  chat.sessions = { s1: { status: "streaming" } }
  options?.onSilent("s1", 30_000)
  expect(chat.setSessionDiagnostic).toHaveBeenCalledWith(
    "s1",
    expect.objectContaining({ code: "turnSilent" })
  )

  chat.setSessionDiagnostic.mockClear()
  chat.sessions = { s1: { status: "streaming", errorDiagnostic: { code: "other" } } }
  options?.onSilent("s1", 30_000)
  chat.sessions = { s1: { status: "idle" } }
  options?.onSilent("s1", 30_000)
  expect(chat.setSessionDiagnostic).not.toHaveBeenCalled()
})

it("clears only its own warning on recovery", () => {
  renderHook(() => useAgentChatSilenceWatchdog())
  chat.sessions = { s1: { status: "streaming", errorDiagnostic: { code: "other" } } }
  options?.onRecovered("s1")
  expect(chat.setSessionDiagnostic).not.toHaveBeenCalled()

  chat.sessions = { s1: { status: "streaming", errorDiagnostic: { code: "turnSilent" } } }
  options?.onRecovered("s1")
  expect(chat.setSessionDiagnostic).toHaveBeenCalledWith("s1", null)
})

it("disarms an armed session once it settles or closes, and disposes on unmount", () => {
  const hook = renderHook(() => useAgentChatSilenceWatchdog())
  listener?.({ sessions: { s1: { status: "streaming" } } })
  expect(watchdog.disarm).not.toHaveBeenCalled()

  listener?.({ sessions: { s1: { status: "idle" } } })
  expect(watchdog.disarm).toHaveBeenCalledWith("s1")
  watchdog.disarm.mockClear()
  listener?.({ sessions: {} })
  expect(watchdog.disarm).toHaveBeenCalledWith("s1")

  const same = { s1: { status: "idle" } }
  watchdog.disarm.mockClear()
  listener?.({ sessions: same }, { sessions: same })
  expect(watchdog.disarm).not.toHaveBeenCalled()

  hook.unmount()
  expect(watchdog.dispose).toHaveBeenCalled()
  expect(listener).toBeNull()
})
