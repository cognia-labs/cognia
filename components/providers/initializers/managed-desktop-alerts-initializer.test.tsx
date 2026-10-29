jest.mock("@/lib/runtime/exclusive-web-lock", () => ({ acquireExclusiveWebLock: jest.fn() }))
jest.mock("@/lib/automation/managed-desktop-alerts", () => ({
  startManagedDesktopAlerts: jest.fn(),
}))
import { render, waitFor } from "@testing-library/react"
import { acquireExclusiveWebLock } from "@/lib/runtime/exclusive-web-lock"
import { startManagedDesktopAlerts } from "@/lib/automation/managed-desktop-alerts"
import {
  MANAGED_DESKTOP_ALERTS_LOCK,
  ManagedDesktopAlertsInitializer,
} from "./managed-desktop-alerts-initializer"

beforeEach(() => jest.clearAllMocks())

test("the lock holder starts the watcher and stops it on unmount", async () => {
  const stop = jest.fn()
  ;(acquireExclusiveWebLock as jest.Mock).mockResolvedValue(true)
  ;(startManagedDesktopAlerts as jest.Mock).mockReturnValue(stop)
  const { unmount } = render(<ManagedDesktopAlertsInitializer />)
  await waitFor(() => expect(startManagedDesktopAlerts).toHaveBeenCalled())
  expect(acquireExclusiveWebLock).toHaveBeenCalledWith(
    MANAGED_DESKTOP_ALERTS_LOCK,
    expect.any(AbortSignal)
  )
  unmount()
  expect(stop).toHaveBeenCalled()
})

test("another webview holding the lock means no second watcher", async () => {
  ;(acquireExclusiveWebLock as jest.Mock).mockResolvedValue(false)
  render(<ManagedDesktopAlertsInitializer />)
  await waitFor(() => expect(acquireExclusiveWebLock).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(startManagedDesktopAlerts).not.toHaveBeenCalled()
})
