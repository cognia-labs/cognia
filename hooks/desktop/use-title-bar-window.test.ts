import { act, renderHook, waitFor } from "@testing-library/react"

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
    },
  },
}))

const isTauri = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

const minimize = jest.fn()
const toggleMaximize = jest.fn()
const close = jest.fn()
const isMaximized = jest.fn()
const isFullscreen = jest.fn()
const setFullscreen = jest.fn()
const setAlwaysOnTop = jest.fn()
const isAlwaysOnTop = jest.fn()
const onResized = jest.fn()
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    isFullscreen,
    setFullscreen,
    setAlwaysOnTop,
    isAlwaysOnTop,
    onResized,
  }),
}))

import { useTitleBarWindow } from "./use-title-bar-window"

beforeEach(() => {
  jest.clearAllMocks()
  isTauri.mockReturnValue(true)
  isMaximized.mockResolvedValue(false)
  isFullscreen.mockResolvedValue(false)
  isAlwaysOnTop.mockResolvedValue(false)
  onResized.mockResolvedValue(() => {})
  for (const fn of [minimize, toggleMaximize, close, setFullscreen, setAlwaysOnTop]) {
    fn.mockResolvedValue(undefined)
  }
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true })
})

test("outside Tauri it reports no platform and touches no window", async () => {
  isTauri.mockReturnValue(false)
  const { result } = renderHook(() => useTitleBarWindow())
  await act(async () => {})
  expect(result.current.platform).toBe("")
  expect(isMaximized).not.toHaveBeenCalled()
})

test("reads the platform, maximized and always-on-top state on mount", async () => {
  isMaximized.mockResolvedValue(true)
  isAlwaysOnTop.mockResolvedValue(true)
  const { result } = renderHook(() => useTitleBarWindow())
  await waitFor(() => expect(result.current.platform).toBe("win32"))
  expect(result.current.maximized).toBe(true)
  expect(result.current.alwaysOnTop).toBe(true)
})

test("a resize refreshes the maximized state", async () => {
  let onResize: (() => Promise<void>) | undefined
  onResized.mockImplementation(async (cb: () => Promise<void>) => {
    onResize = cb
    return () => {}
  })
  const { result } = renderHook(() => useTitleBarWindow())
  await waitFor(() => expect(onResize).toBeDefined())
  isMaximized.mockResolvedValue(true)
  await act(async () => {
    await onResize!()
  })
  expect(result.current.maximized).toBe(true)
})

test("releases the resize listener on unmount", async () => {
  const dispose = jest.fn()
  onResized.mockResolvedValue(dispose)
  const { result, unmount } = renderHook(() => useTitleBarWindow())
  await waitFor(() => expect(result.current.platform).toBe("win32"))
  unmount()
  expect(dispose).toHaveBeenCalled()
})

test("logs a structured warning when setup fails", async () => {
  isMaximized.mockRejectedValue("nope")
  renderHook(() => useTitleBarWindow())
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith("title-bar window setup failed", { error: "nope" })
  )
})

test("window commands route to the Tauri window API", async () => {
  const { result } = renderHook(() => useTitleBarWindow())
  await act(async () => {
    await result.current.minimize()
    await result.current.toggleMaximize()
    await result.current.close()
  })
  expect(minimize).toHaveBeenCalled()
  expect(toggleMaximize).toHaveBeenCalled()
  expect(close).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("title-bar minimize")
  expect(logInfo).toHaveBeenCalledWith("title-bar close")
})

test("a failing command logs instead of throwing", async () => {
  minimize.mockRejectedValue(new Error("denied"))
  const { result } = renderHook(() => useTitleBarWindow())
  await act(async () => {
    await result.current.minimize()
  })
  expect(logError).toHaveBeenCalledWith("title-bar minimize failed", expect.any(Error))
})

test("toggleFullscreen flips the current fullscreen state", async () => {
  isFullscreen.mockResolvedValue(true)
  const { result } = renderHook(() => useTitleBarWindow())
  await act(async () => {
    await result.current.toggleFullscreen()
  })
  expect(setFullscreen).toHaveBeenCalledWith(false)
})

test("toggleAlwaysOnTop pins the window and reports it", async () => {
  const { result } = renderHook(() => useTitleBarWindow())
  // Let the mount-time read settle first, or it lands after the toggle.
  await waitFor(() => expect(result.current.platform).toBe("win32"))
  await act(async () => {
    await result.current.toggleAlwaysOnTop()
  })
  expect(setAlwaysOnTop).toHaveBeenCalledWith(true)
  expect(result.current.alwaysOnTop).toBe(true)
})
