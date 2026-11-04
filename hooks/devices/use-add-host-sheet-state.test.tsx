import { act, renderHook } from "@testing-library/react"

import { useAddHostSheetState } from "./use-add-host-sheet-state"

let searchParams = new URLSearchParams()
const pushMock = jest.fn()
const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))
let tauri = true
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauri,
}))

beforeEach(() => {
  searchParams = new URLSearchParams()
  tauri = true
  pushMock.mockReset()
  replaceMock.mockReset()
})

describe("useAddHostSheetState — desktop registry sheet", () => {
  it("starts closed without a hand-off", () => {
    const { result } = renderHook(() => useAddHostSheetState())
    expect(result.current.open).toBe(false)
    expect(result.current.seededBaseUrl).toBeUndefined()
  })

  it("opens from a /servers hand-off and seeds the address", () => {
    searchParams = new URLSearchParams("addHost=1&baseUrl=https%3A%2F%2Fbox%3A27890")
    const { result } = renderHook(() => useAddHostSheetState())
    expect(result.current.open).toBe(true)
    expect(result.current.seededBaseUrl).toBe("https://box:27890")
  })

  it("stays closed once dismissed, though the URL still says open", () => {
    searchParams = new URLSearchParams("addHost=1")
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    act(() => result.current.setOpen(false))
    rerender()
    expect(result.current.open).toBe(false)
  })

  it("does not shut a sheet the user opened when the param is cleared", () => {
    searchParams = new URLSearchParams("addHost=1")
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    act(() => result.current.setOpen(false))
    act(() => result.current.setOpen(true))
    searchParams = new URLSearchParams()
    rerender()
    expect(result.current.open).toBe(true)
  })

  it("opens again for a new hand-off", () => {
    const { result, rerender } = renderHook(() => useAddHostSheetState())
    searchParams = new URLSearchParams("addHost=2")
    rerender()
    expect(result.current.open).toBe(true)
  })
})

describe("useAddHostSheetState — browser and phone", () => {
  // Off the desktop the sheet filed Hosts in the registry while every other
  // "Add host" wrote the companion credential book: one label, two stores.
  beforeEach(() => {
    tauri = false
  })

  it("routes Add host to /pair instead of opening the registry sheet", () => {
    const { result } = renderHook(() => useAddHostSheetState())
    act(() => result.current.request())
    expect(pushMock).toHaveBeenCalledWith("/pair?mode=add")
    expect(result.current.open).toBe(false)
  })

  it("never opens the sheet, even when asked directly", () => {
    const { result } = renderHook(() => useAddHostSheetState())
    act(() => result.current.setOpen(true))
    expect(result.current.open).toBe(false)
  })

  it("redirects a /servers hand-off to /pair without opening the sheet", () => {
    searchParams = new URLSearchParams("addHost=1&baseUrl=https%3A%2F%2Fbox%3A27890")
    const { result } = renderHook(() => useAddHostSheetState())
    expect(result.current.open).toBe(false)
    expect(replaceMock).toHaveBeenCalledWith("/pair?mode=add")
  })
})

describe("useAddHostSheetState — desktop request", () => {
  it("opens the sheet and stays on the page", () => {
    const { result } = renderHook(() => useAddHostSheetState())
    act(() => result.current.request())
    expect(result.current.open).toBe(true)
    expect(pushMock).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
