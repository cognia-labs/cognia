/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  __resetSessionRecordingsForTesting,
  releaseSessionRecording,
  startSessionRecording,
} from "@/lib/terminal/recording/session-recordings"

import { useSessionRecording, useSessionRecordings } from "./use-session-recording"

const session = {
  id: "s-1",
  isExited: false,
  tapData: () => () => undefined,
  onExit: () => () => undefined,
}

beforeEach(() => __resetSessionRecordingsForTesting())

describe("useSessionRecording", () => {
  it("follows a session's recording as it starts and is released", () => {
    const { result } = renderHook(() => useSessionRecording("s-1"))
    expect(result.current).toBeNull()
    act(() => {
      startSessionRecording({ session, title: "zsh" })
    })
    expect(result.current).toMatchObject({ status: "recording", title: "zsh" })
    act(() => releaseSessionRecording("s-1"))
    expect(result.current).toBeNull()
  })

  it("lists every recording", () => {
    const { result } = renderHook(() => useSessionRecordings())
    act(() => {
      startSessionRecording({ session, title: "zsh" })
    })
    expect([...result.current.keys()]).toEqual(["s-1"])
  })
})
