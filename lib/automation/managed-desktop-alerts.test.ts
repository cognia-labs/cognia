jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(),
}))
jest.mock("@/lib/remote-host/target-transport", () => ({ PAIRED_HOST_REF_PREFIX: "companion:" }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
  subscribeRuntimeTargetContext: jest.fn(),
}))
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: jest.fn() }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))
jest.mock("./managed-desktop-client", () => ({ watchManagedDesktopMonitor: jest.fn() }))

import { isTauri } from "@/lib/platform/detect"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { useAccountStore } from "@/stores/account/account-store"
import { watchManagedDesktopMonitor, type ManagedDesktopMonitor } from "./managed-desktop-client"
import {
  announceManagedDesktopAlerts,
  managedDesktopAlertKey,
  managedDesktopAlertTarget,
  MANAGED_DESKTOP_SETTINGS_HREF,
  startManagedDesktopAlerts,
} from "./managed-desktop-alerts"

const monitor = (alerts: ManagedDesktopMonitor["alerts"]): ManagedDesktopMonitor => ({
  observedAt: 1_000_000,
  billedDesktops: 1,
  maximumExposureMicros: { USD: 10 },
  oldestPendingCreateAt: null,
  oldestPendingDeleteAt: 400_000,
  alerts,
})
const pastDeadline = {
  kind: "pastDeadline" as const,
  subjectId: "desk-1",
  providerConfigId: "byo",
  since: 820_000,
}
const stalled = {
  kind: "cleanupStalled" as const,
  subjectId: "desk-1",
  providerConfigId: "byo",
  since: 400_000,
}

function deps() {
  return {
    notify: jest.fn().mockResolvedValue("id"),
    translate: jest.fn((key: string, values?: Record<string, string | number>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    locked: false,
    unlockedAccountId: "acct",
  })
  ;(useAccountStore.subscribe as jest.Mock).mockReturnValue(jest.fn())
  ;(subscribeRuntimeTargetContext as jest.Mock).mockReturnValue(jest.fn())
  ;(watchManagedDesktopMonitor as jest.Mock).mockReturnValue(jest.fn())
})

test("announces each alert episode once, as an error past the deadline", async () => {
  const d = deps()
  const announced = new Set<string>()
  await announceManagedDesktopAlerts(monitor([pastDeadline, stalled]), announced, d)
  expect(d.notify).toHaveBeenCalledTimes(2)
  expect(d.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "system",
      level: "error",
      title: "pastDeadline.title",
      body: 'pastDeadline.body:{"subject":"desk-1","config":"byo","minutes":3}',
      href: MANAGED_DESKTOP_SETTINGS_HREF,
      dedupeKey: managedDesktopAlertKey(pastDeadline),
      directed: true,
    })
  )
  expect(d.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "warning", title: "cleanupStalled.title" })
  )
  await announceManagedDesktopAlerts(monitor([pastDeadline, stalled]), announced, d)
  expect(d.notify).toHaveBeenCalledTimes(2)
  // A new episode of the same kind (another start time) is announced again.
  await announceManagedDesktopAlerts(monitor([{ ...pastDeadline, since: 900_000 }]), announced, d)
  expect(d.notify).toHaveBeenCalledTimes(3)
})

test("an alert whose notification failed is retried on the next read", async () => {
  const d = deps()
  d.notify.mockRejectedValueOnce(new Error("db closed"))
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  const announced = new Set<string>()
  await announceManagedDesktopAlerts(monitor([stalled]), announced, d)
  expect(announced.size).toBe(0)
  await announceManagedDesktopAlerts(monitor([stalled]), announced, d)
  expect(d.notify).toHaveBeenCalledTimes(2)
  expect(announced.has(managedDesktopAlertKey(stalled))).toBe(true)
  warn.mockRestore()
})

test("the desktop watches its own Host; other shells the /pair Host they drive", () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  expect(managedDesktopAlertTarget()).toEqual({ kind: "local" })
  ;(isTauri as jest.Mock).mockReturnValue(false)
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({ targetId: "host-a" })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue({ targetId: "host-a" })
  expect(managedDesktopAlertTarget()).toEqual({ kind: "remote", hostId: "companion:host-a" })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue({ targetId: "host-b" })
  expect(managedDesktopAlertTarget()).toBeNull()
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue(null)
  expect(managedDesktopAlertTarget()).toBeNull()
})

test("follows the driven Host and the unlocked account", () => {
  let target: { kind: "remote"; hostId: string } | null = { kind: "remote", hostId: "companion:a" }
  const stops: jest.Mock[] = []
  ;(watchManagedDesktopMonitor as jest.Mock).mockImplementation(() => {
    const stop = jest.fn()
    stops.push(stop)
    return stop
  })
  const stop = startManagedDesktopAlerts(deps(), () => target)
  expect(watchManagedDesktopMonitor).toHaveBeenCalledTimes(1)
  const onRoute = (subscribeRuntimeTargetContext as jest.Mock).mock.calls[0][0]
  const onAccount = (useAccountStore.subscribe as jest.Mock).mock.calls[0][0]
  onRoute()
  expect(watchManagedDesktopMonitor).toHaveBeenCalledTimes(1)
  target = { kind: "remote", hostId: "companion:b" }
  onRoute()
  expect(stops[0]).toHaveBeenCalled()
  expect((watchManagedDesktopMonitor as jest.Mock).mock.calls[1][0]).toEqual(target)
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    locked: true,
    unlockedAccountId: null,
  })
  onAccount()
  expect(stops[1]).toHaveBeenCalled()
  expect(watchManagedDesktopMonitor).toHaveBeenCalledTimes(2)
  stop()
})

test("announces what the watcher reads", async () => {
  const d = deps()
  startManagedDesktopAlerts(d, () => ({ kind: "local" }))
  const onMonitor = (watchManagedDesktopMonitor as jest.Mock).mock.calls[0][1]
  onMonitor(monitor([stalled]))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "cleanupStalled.title" }))
})
