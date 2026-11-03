/** @jest-environment jsdom */

import { act, render, renderHook, screen } from "@testing-library/react"

import { CollabRefreshStaleBadge, useCollabRefreshStale } from "./collab-refresh-stale-badge"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct-1" }))

let stale = false
let state = { lastSuccessAt: 1, lastAttemptAt: 1, failures: 0, inFlight: false }
const listeners = new Set<() => void>()
const mockIsStale = jest.fn((_accountId: string) => stale)
jest.mock("@/lib/collab/refresh-scheduler", () => ({
  subscribeCollabRefreshState: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getCollabRefreshState: () => state,
  isCollabRefreshStale: (accountId: string) => mockIsStale(accountId),
}))

beforeEach(() => {
  stale = false
  state = { lastSuccessAt: 1, lastAttemptAt: 1, failures: 0, inFlight: false }
  listeners.clear()
  mockIsStale.mockClear()
})

it("reads fresh while the collaboration mirror is fresh", () => {
  const { result } = renderHook(() => useCollabRefreshStale())
  expect(result.current).toBe(false)
  expect(mockIsStale).toHaveBeenCalledWith("acct-1")
})

it("reads stale when the last successful refresh is older than the threshold", () => {
  stale = true
  const { result } = renderHook(() => useCollabRefreshStale())
  expect(result.current).toBe(true)
})

it("re-reads when the scheduler publishes a new state", () => {
  const { result } = renderHook(() => useCollabRefreshStale())
  expect(result.current).toBe(false)
  act(() => {
    stale = true
    state = { ...state, failures: 1 }
    for (const listener of listeners) listener()
  })
  expect(result.current).toBe(true)
})

describe("CollabRefreshStaleBadge", () => {
  it("stays hidden while the collaboration mirror is fresh", () => {
    render(<CollabRefreshStaleBadge />)
    expect(screen.queryByTestId("collab-refresh-stale")).not.toBeInTheDocument()
  })

  it("shows when the last successful refresh is older than five minutes", () => {
    stale = true
    render(<CollabRefreshStaleBadge />)
    expect(screen.getByTestId("collab-refresh-stale")).toHaveTextContent("stale")
  })
})
