import { render, screen } from "@testing-library/react"

const bootstrapLogger = jest.fn()
const installGlobalErrorHandlers = jest.fn()
const uninstallGlobalErrorHandlers = jest.fn()
const initTauriLogBridge = jest.fn()
const cleanupTauriLogBridge = jest.fn()
const getNativeLoggingReadiness = jest.fn()
const isTauri = jest.fn()

jest.mock("@/lib/logging", () => ({ bootstrapLogger: () => bootstrapLogger() }))
jest.mock("@cognia/logging/global-error-handlers", () => ({
  installGlobalErrorHandlers: () => installGlobalErrorHandlers(),
}))
jest.mock("@/lib/native/tauri-log-bridge", () => ({
  initTauriLogBridge: () => initTauriLogBridge(),
  cleanupTauriLogBridge: () => cleanupTauriLogBridge(),
}))
jest.mock("@/lib/native/native-logging", () => ({
  getNativeLoggingReadiness: () => getNativeLoggingReadiness(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

import { LoggerProvider } from "./logger-provider"

beforeEach(() => {
  jest.clearAllMocks()
  installGlobalErrorHandlers.mockReturnValue(uninstallGlobalErrorHandlers)
  initTauriLogBridge.mockResolvedValue(undefined)
  cleanupTauriLogBridge.mockResolvedValue(undefined)
  getNativeLoggingReadiness.mockResolvedValue(undefined)
})

describe("LoggerProvider", () => {
  it("bootstraps logging once and installs the global error handlers", () => {
    isTauri.mockReturnValue(false)
    const { rerender, unmount } = render(
      <LoggerProvider>
        <span>child</span>
      </LoggerProvider>
    )
    rerender(
      <LoggerProvider>
        <span>child</span>
      </LoggerProvider>
    )

    expect(screen.getByText("child")).toBeInTheDocument()
    expect(bootstrapLogger).toHaveBeenCalledTimes(1)
    expect(installGlobalErrorHandlers).toHaveBeenCalledTimes(1)
    expect(initTauriLogBridge).not.toHaveBeenCalled()

    unmount()
    expect(uninstallGlobalErrorHandlers).toHaveBeenCalledTimes(1)
  })

  it("bridges native logs on Tauri and tears the bridge down on unmount", async () => {
    isTauri.mockReturnValue(true)
    const { unmount } = render(
      <LoggerProvider>
        <span>child</span>
      </LoggerProvider>
    )

    expect(initTauriLogBridge).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(getNativeLoggingReadiness).toHaveBeenCalledTimes(1)

    unmount()
    expect(cleanupTauriLogBridge).toHaveBeenCalledTimes(1)
  })
})
