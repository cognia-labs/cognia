import { act, renderHook } from "@testing-library/react"

import {
  __resetPortsForTesting,
  __setPortForTesting,
  __setPortModulesForTesting,
} from "@/lib/modules/ports"
import type { SpeechPort } from "@/types/modules/ports/speech"

import { useReadAloudStatus } from "./use-read-aloud-status"

// A stand-in for the speech port's one player: state plus subscribers, driven
// the way the orchestrator drives its own (every change notifies).
type PlayerState = Record<string, unknown>
let state: PlayerState = {}
const listeners = new Set<(s: PlayerState) => void>()
const setState = (patch: PlayerState) => {
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener(state)
}
const speech = {
  readAloud: {
    getState: () => state,
    subscribe: (listener: (s: PlayerState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: () => setState({ activeSourceId: undefined, playbackState: "idle" }),
  },
} as unknown as SpeechPort
const player = speech.readAloud

beforeEach(() => {
  __resetPortsForTesting()
  __setPortForTesting("speech", speech)
  listeners.clear()
  state = { activeSourceId: undefined, playbackState: "idle", progress: 0 }
})

describe("useReadAloudStatus", () => {
  it("reports inactive/idle by default", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    expect(result.current.isActive).toBe(false)
    expect(result.current.playbackState).toBe("idle")
    expect(result.current.isPlaying).toBe(false)
  })

  it("activates only for the matching message id", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-2", playbackState: "playing" }))
    expect(result.current.isActive).toBe(false)
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing" }))
    expect(result.current.isActive).toBe(true)
    expect(result.current.isPlaying).toBe(true)
  })

  it("tracks paused / loading sub-states for the active message", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-1", playbackState: "loading" }))
    expect(result.current.isLoading).toBe(true)
    act(() => setState({ playbackState: "paused" }))
    expect(result.current.isPaused).toBe(true)
  })

  it("does NOT re-render on progress-only updates (perf guard)", () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useReadAloudStatus("msg-1")
    })
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing", progress: 0.1 }))
    const after = renders
    expect(result.current.isPlaying).toBe(true)
    // A progress-only change keeps the (active, playbackState) snapshot string
    // identical → useSyncExternalStore bails out → no extra render.
    act(() => setState({ progress: 0.5 }))
    act(() => setState({ progress: 0.9 }))
    expect(renders).toBe(after)
  })

  it("clears when playback stops", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    act(() => setState({ activeSourceId: "msg-1", playbackState: "playing" }))
    expect(result.current.isActive).toBe(true)
    act(() => player.stop())
    expect(result.current.isActive).toBe(false)
  })

  it("is available while the speech port is provided", () => {
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    expect(result.current.available).toBe(true)
  })

  it("is unavailable and idle where no module provides the speech port", () => {
    __setPortForTesting("speech", null)
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    expect(result.current.available).toBe(false)
    expect(result.current.isActive).toBe(false)
    expect(result.current.playbackState).toBe("idle")
  })

  it("reads as idle until the port has loaded", () => {
    __resetPortsForTesting()
    __setPortModulesForTesting([
      {
        id: "speech",
        kind: "module",
        stage: "stable",
        provides: [{ port: "speech", load: () => new Promise(() => {}) }],
      },
    ])
    const { result } = renderHook(() => useReadAloudStatus("msg-1"))
    expect(result.current.playbackState).toBe("idle")
  })
})
