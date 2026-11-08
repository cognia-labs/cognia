/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockToast = Object.assign(jest.fn(), {
  success: jest.fn(),
  error: jest.fn(),
  message: jest.fn(),
  dismiss: jest.fn(),
})
// A getter: the factory is hoisted above `mockToast`'s initialisation.
jest.mock("sonner", () => ({
  get toast() {
    return mockToast
  },
}))

const mockSaveFileAs = jest.fn(async (_opts: unknown): Promise<boolean> => true)
const mockPickAndReadFiles = jest.fn(
  async (_opts: unknown): Promise<Array<{ name: string; path: string; content: string }>> => []
)
jest.mock("@/lib/files/file-bridge", () => ({
  saveFileAs: (opts: unknown) => mockSaveFileAs(opts),
  pickAndReadFiles: (opts: unknown) => mockPickAndReadFiles(opts),
}))

const mockLive = new Map<string, unknown>()
jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: (id: string) => mockLive.get(id),
}))

import { closePlayback, getPlaybackRequest } from "@/lib/terminal/recording/playback-request"
import {
  __resetSessionRecordingsForTesting,
  getSessionRecording,
} from "@/lib/terminal/recording/session-recordings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { useTerminalRecordingActions } from "./use-terminal-recording-actions"

function liveSession(id: string) {
  const taps = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(code: number | null) => void>()
  const session = {
    id,
    isExited: false,
    info: { id, shell: "/bin/zsh" },
    tapData: (cb: (bytes: Uint8Array) => void) => {
      taps.add(cb)
      return () => taps.delete(cb)
    },
    onExit: (cb: (code: number | null) => void) => {
      exits.add(cb)
      return () => exits.delete(cb)
    },
    emit: (text: string) => {
      for (const cb of [...taps]) cb(new TextEncoder().encode(text))
    },
    exit: () => {
      for (const cb of [...exits]) cb(0)
    },
  }
  mockLive.set(id, session)
  useTerminalStore.getState().registerSession({
    id,
    projectId: null,
    extensionId: null,
    origin: "local",
    shell: "/bin/zsh",
  })
  return session
}

beforeEach(() => {
  __resetSessionRecordingsForTesting()
  useTerminalStore.getState().reset()
  mockLive.clear()
  closePlayback()
  jest.clearAllMocks()
  mockSaveFileAs.mockResolvedValue(true)
})

describe("useTerminalRecordingActions", () => {
  it("records a tab and saves the take as a .cast file", async () => {
    const session = liveSession("s-1")
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    expect(getSessionRecording("s-1")?.status).toBe("recording")
    session.emit("hello\r\n")
    await act(async () => {
      await result.current.stopAndSave("s-1")
    })
    const opts = mockSaveFileAs.mock.calls[0][0] as {
      defaultName: string
      content: string
      filters: unknown
    }
    expect(opts.defaultName).toMatch(/\.cast$/)
    expect(opts.content.split("\n")[0]).toContain('"version":2')
    expect(opts.content).toContain("hello")
    expect(getSessionRecording("s-1")).toBeNull()
    expect(mockToast.success).toHaveBeenCalledWith("saved", expect.anything())
  })

  it("keeps the take when the save dialog is cancelled", async () => {
    liveSession("s-1")
    mockSaveFileAs.mockResolvedValue(false)
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    await act(async () => {
      await result.current.stopAndSave("s-1")
    })
    expect(getSessionRecording("s-1")).toMatchObject({ status: "finished", reason: "stopped" })
    expect(mockToast.message).toHaveBeenCalledWith("saveCancelled")
    // A stopped-by-the-user take raises no "ended on its own" prompt.
    expect(mockToast.message).toHaveBeenCalledTimes(1)
  })

  it("reports a save that failed and keeps the take", async () => {
    liveSession("s-1")
    mockSaveFileAs.mockRejectedValue(new Error("disk full"))
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    await act(async () => {
      await result.current.stopAndSave("s-1")
    })
    expect(mockToast.error).toHaveBeenCalledWith('saveFailed:{"message":"disk full"}')
    expect(getSessionRecording("s-1")?.status).toBe("finished")
  })

  it("refuses to record a tab with no live session", () => {
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("ghost"))
    expect(mockToast.error).toHaveBeenCalledWith("startFailed")
  })

  it("discards a recording", () => {
    liveSession("s-1")
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    act(() => result.current.discard("s-1"))
    expect(getSessionRecording("s-1")).toBeNull()
  })

  it("prompts once to save a take that ended because the session exited", () => {
    const session = liveSession("s-1")
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    act(() => session.exit())
    const prompts = mockToast.message.mock.calls.filter(([key]) =>
      String(key).startsWith("ended.exited")
    )
    expect(prompts).toHaveLength(1)
    const options = prompts[0][1] as {
      id: string
      action: { onClick: () => void }
      cancel: { onClick: () => void }
    }
    expect(options.id).toBe("terminal-recording-ended:s-1")
    act(() => options.cancel.onClick())
    expect(getSessionRecording("s-1")).toBeNull()
    expect(mockToast.dismiss).toHaveBeenCalledWith("terminal-recording-ended:s-1")
  })

  it("ends the recording of a tab that left the dock and prompts to save it", () => {
    liveSession("s-1")
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    act(() => useTerminalStore.getState().removeSession("s-1"))
    expect(getSessionRecording("s-1")).toMatchObject({ status: "finished", reason: "exited" })
    expect(
      mockToast.message.mock.calls.some(([key]) => String(key).startsWith("ended.exited"))
    ).toBe(true)
  })

  it("opens a saved .cast file for playback", async () => {
    mockPickAndReadFiles.mockResolvedValue([
      {
        name: "demo.cast",
        path: "/tmp/demo.cast",
        content: `${JSON.stringify({ version: 2, width: 80, height: 24 })}\n[0.1,"o","x"]\n`,
      },
    ])
    const { result } = renderHook(() => useTerminalRecordingActions())
    await act(async () => {
      await result.current.openFile()
    })
    expect(result.current.playback?.title).toBe("demo")
    expect(getPlaybackRequest()?.frames).toEqual([[0.1, "o", "x"]])
    act(() => result.current.closePlayback())
    expect(result.current.playback).toBeNull()
  })

  it("names why a picked file cannot be played", async () => {
    mockPickAndReadFiles.mockResolvedValue([
      { name: "notes.cast", path: "/tmp/notes.cast", content: "just text" },
    ])
    const { result } = renderHook(() => useTerminalRecordingActions())
    await act(async () => {
      await result.current.openFile()
    })
    expect(mockToast.error).toHaveBeenCalledWith('openFailed:{"name":"notes.cast"}', {
      description: "fileError.not-json",
    })
    expect(result.current.playback).toBeNull()
  })

  it("plays a saved take from the success toast, opening the dock", async () => {
    liveSession("s-1")
    useTerminalStore.getState().setPanelOpen(false)
    const { result } = renderHook(() => useTerminalRecordingActions())
    act(() => result.current.start("s-1"))
    await act(async () => {
      await result.current.stopAndSave("s-1")
    })
    const options = mockToast.success.mock.calls[0][1] as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    expect(result.current.playback?.title).toBeTruthy()
  })
})
