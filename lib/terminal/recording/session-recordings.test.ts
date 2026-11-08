import {
  __resetSessionRecordingsForTesting,
  FALLBACK_SIZE,
  getReportedTerminalSize,
  getSessionRecording,
  getSessionRecordingsSnapshot,
  releaseSessionRecording,
  reportTerminalSize,
  sessionLeftDock,
  startSessionRecording,
  stopSessionRecording,
  subscribeSessionRecordings,
} from "./session-recordings"

function fakeSession(id = "s-1", isExited = false) {
  const taps = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(code: number | null) => void>()
  return {
    id,
    isExited,
    tapData: jest.fn((cb: (bytes: Uint8Array) => void) => {
      taps.add(cb)
      return () => taps.delete(cb)
    }),
    onExit: jest.fn((cb: (code: number | null) => void) => {
      exits.add(cb)
      return () => exits.delete(cb)
    }),
    emit(text: string) {
      const bytes = new TextEncoder().encode(text)
      for (const cb of [...taps]) cb(bytes)
    },
    emitBytes(bytes: Uint8Array) {
      for (const cb of [...taps]) cb(bytes)
    },
    exit() {
      for (const cb of [...exits]) cb(0)
    },
    listeners: () => taps.size + exits.size,
  }
}

let clock = 0
const now = () => clock

beforeEach(() => {
  __resetSessionRecordingsForTesting()
  clock = 1_000_000
  jest.useFakeTimers()
})

afterEach(() => {
  __resetSessionRecordingsForTesting()
  jest.useRealTimers()
})

describe("session recordings", () => {
  it("records what the session prints, at the size it last reported", () => {
    const session = fakeSession()
    reportTerminalSize("s-1", 132, 43)
    expect(startSessionRecording({ session, title: "zsh", now })).toBe(true)
    clock += 500
    session.emit("hello\r\n")
    clock += 500
    const recording = stopSessionRecording("s-1")!
    expect(recording.header).toMatchObject({ width: 132, height: 43, title: "zsh" })
    expect(recording.frames).toEqual([[0.5, "o", "hello\r\n"]])
    expect(recording.duration).toBe(1)
    // Stopping detaches from the session but holds the take until released.
    expect(session.listeners()).toBe(0)
    expect(getSessionRecording("s-1")).toMatchObject({ status: "finished", reason: "stopped" })
    releaseSessionRecording("s-1")
    expect(getSessionRecording("s-1")).toBeNull()
  })

  it("starts at the fallback size when the session never reported one", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now })
    expect(stopSessionRecording("s-1")!.header).toMatchObject({
      width: FALLBACK_SIZE.cols,
      height: FALLBACK_SIZE.rows,
    })
  })

  it("records a resize while recording as a frame", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now })
    clock += 200
    reportTerminalSize("s-1", 90, 20)
    reportTerminalSize("s-1", 90, 20)
    expect(stopSessionRecording("s-1")!.frames).toEqual([[0.2, "r", "90x20"]])
    expect(getReportedTerminalSize("s-1")).toEqual({ cols: 90, rows: 20 })
  })

  it("decodes a multi-byte character split across chunks", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now })
    const bytes = new TextEncoder().encode("你")
    session.emitBytes(bytes.slice(0, 1))
    session.emitBytes(bytes.slice(1))
    expect(
      stopSessionRecording("s-1")!
        .frames.map((f) => f[2])
        .join("")
    ).toBe("你")
  })

  it("refuses a second recording, or one of an exited session", () => {
    const session = fakeSession()
    expect(startSessionRecording({ session, title: "t", now })).toBe(true)
    expect(startSessionRecording({ session, title: "t", now })).toBe(false)
    stopSessionRecording("s-1")
    // A held, unsaved take still blocks a new one.
    expect(startSessionRecording({ session, title: "t", now })).toBe(false)
    expect(startSessionRecording({ session: fakeSession("s-2", true), title: "t", now })).toBe(
      false
    )
  })

  it("ends and holds the take when the session exits", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now })
    session.emit("bye")
    session.exit()
    expect(getSessionRecording("s-1")).toMatchObject({ status: "finished", reason: "exited" })
    // Stopping afterwards hands back the held take.
    expect(stopSessionRecording("s-1")!.frames).toHaveLength(1)
  })

  it("ends and holds the take at the duration cap", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now, maxDurationSec: 2 })
    clock += 2000
    jest.advanceTimersByTime(2000)
    const state = getSessionRecording("s-1")
    expect(state).toMatchObject({ status: "finished", reason: "limit" })
    expect(state?.status === "finished" && state.recording.duration).toBe(2)
    expect(session.listeners()).toBe(0)
  })

  it("ends a recording whose tab left the dock, and forgets its size", () => {
    const session = fakeSession()
    reportTerminalSize("s-1", 100, 30)
    startSessionRecording({ session, title: "t", now })
    sessionLeftDock("s-1")
    expect(getSessionRecording("s-1")).toMatchObject({ status: "finished", reason: "exited" })
    expect(getReportedTerminalSize("s-1")).toBeNull()
  })

  it("discards a live recording without producing a take", () => {
    const session = fakeSession()
    startSessionRecording({ session, title: "t", now })
    releaseSessionRecording("s-1")
    expect(getSessionRecording("s-1")).toBeNull()
    expect(session.listeners()).toBe(0)
    expect(stopSessionRecording("s-1")).toBeNull()
  })

  it("publishes a fresh snapshot on every change", () => {
    const listener = jest.fn()
    subscribeSessionRecordings(listener)
    const before = getSessionRecordingsSnapshot()
    startSessionRecording({ session: fakeSession(), title: "t", now })
    const during = getSessionRecordingsSnapshot()
    expect(during).not.toBe(before)
    expect(during.get("s-1")?.status).toBe("recording")
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
