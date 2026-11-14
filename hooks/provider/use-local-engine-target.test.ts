/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

let mockActiveHost: { kind: string; transport: unknown; label: string; scopeKey: string } | null =
  null
const mockListeners = new Set<() => void>()
jest.mock("@/lib/ai/execution-host", () => ({
  getRemoteExecutionHost: () => mockActiveHost,
  isSameExecutionHost: (host: unknown) => host === mockActiveHost,
  subscribeExecutionHost: (listener: () => void) => {
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  },
}))

import { useLocalEngineTarget } from "./use-local-engine-target"

function switchHost(next: typeof mockActiveHost) {
  mockActiveHost = next
  for (const listener of [...mockListeners]) listener()
}

beforeEach(() => {
  mockActiveHost = null
  mockListeners.clear()
})

it("reports this device until a Host executes the turns, then that Host", () => {
  const { result } = renderHook(() => useLocalEngineTarget())
  expect(result.current).toEqual({ kind: "this-device" })
  act(() =>
    switchHost({ kind: "desktop-remote", transport: {}, label: "Build box", scopeKey: "box" })
  )
  expect(result.current).toEqual({ kind: "host", label: "Build box", scopeKey: "box" })
  act(() => switchHost(null))
  expect(result.current).toEqual({ kind: "this-device" })
})

it("keeps one snapshot for an unchanged route and unsubscribes on unmount", () => {
  switchHost({ kind: "paired-client", transport: {}, label: "Studio", scopeKey: "studio" })
  const { result, rerender, unmount } = renderHook(() => useLocalEngineTarget())
  const first = result.current
  rerender()
  expect(result.current).toBe(first)
  unmount()
  expect(mockListeners.size).toBe(0)
})
