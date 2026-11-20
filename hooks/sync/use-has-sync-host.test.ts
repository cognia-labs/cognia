/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const configMock = jest.fn((): object | null => null)
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => configMock(),
}))

import { COMPANION_CONFIG_EVENT, useHasSyncHost } from "./use-has-sync-host"

beforeEach(() => {
  configMock.mockReset()
  configMock.mockReturnValue(null)
})

describe("useHasSyncHost", () => {
  it("is false when no companion config is stored", () => {
    const { result } = renderHook(() => useHasSyncHost())
    expect(result.current).toBe(false)
  })

  it("is true when a companion config is stored", () => {
    configMock.mockReturnValue({ deviceId: "dev" })
    const { result } = renderHook(() => useHasSyncHost())
    expect(result.current).toBe(true)
  })

  it("re-reads the config when the companion config changes", () => {
    const { result } = renderHook(() => useHasSyncHost())
    expect(result.current).toBe(false)

    configMock.mockReturnValue({ deviceId: "dev" })
    act(() => {
      window.dispatchEvent(new Event(COMPANION_CONFIG_EVENT))
    })
    expect(result.current).toBe(true)

    configMock.mockReturnValue(null)
    act(() => {
      window.dispatchEvent(new Event(COMPANION_CONFIG_EVENT))
    })
    expect(result.current).toBe(false)
  })

  it("stops listening once unmounted", () => {
    const remove = jest.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useHasSyncHost())
    unmount()
    expect(remove).toHaveBeenCalledWith(COMPANION_CONFIG_EVENT, expect.any(Function))
    remove.mockRestore()
  })
})
