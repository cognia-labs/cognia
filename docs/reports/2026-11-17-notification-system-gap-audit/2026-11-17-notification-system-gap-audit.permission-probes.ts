/** @jest-environment jsdom */
// Preserve the real platform wrappers; only the final native plugin rejects.
jest.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: jest.fn(async () => {
    throw new Error("bridge down")
  }),
  requestPermission: jest.fn(),
  sendNotification: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import { sendNotification } from "@tauri-apps/plugin-notification"
import { checkNotificationPermission, notify as notifyDesktop } from "@/lib/tauri/notification"
import { transport } from "@/lib/tauri/transport-instance"
import { checkPermission } from "@/lib/capacitor/local-notifications"
import { explicitHostPersonalSinkContext } from "@/lib/execution/personal-sink"
import { notify } from "@/lib/notifications/notify"
import { resolvePreferences } from "@/lib/notifications/preferences"
import { publishRemoteNotification } from "@/lib/notifications/runtime"
import type { NotificationRecord } from "@/types/notifications"
import { Buffer } from "node:buffer"

test("real desktop and mobile permission wrappers turn bridge exceptions into denied fan-out, preserving history and push", async () => {
  const mobile = await checkPermission(
    async () =>
      ({
        checkPermissions: async () => {
          throw new Error("bridge down")
        },
      }) as never
  )
  expect(mobile).toMatchObject({ kind: "error", message: "bridge down" })
  const records: unknown[] = []
  const push = jest.fn()
  await notify(
    { source: "system", level: "error", title: "Audit" },
    {
      now: Date.now,
      loadPrefs: () =>
        resolvePreferences({ globalDefaultChannels: ["center", "toast", "os", "push"] }),
      db: {
        findByDedupeKey: async () => undefined,
        putNotification: async (row) => {
          records.push(row)
        },
        patchNotification: async () => {},
        pruneNotifications: async () => [],
      },
      toast: jest.fn(),
      osNotify: jest.fn(),
      push,
      // The exact conversion checkHostNotificationPermission uses for Tauri.
      isOsPermitted: async () => (await checkNotificationPermission()) === "granted",
    },
    { personalContext: {} }
  )
  expect(records).toHaveLength(1)
  expect(push).toHaveBeenCalledTimes(1)
  console.log(
    "ADVERSARIAL-REAL-PERMISSION",
    JSON.stringify({
      centerRows: records.length,
      pushCalls: push.mock.calls.length,
      bridgeFailureCaught: true,
    })
  )
})

test("the real desktop wrapper converts a thrown native send into an OS delivery in history", async () => {
  jest.mocked(sendNotification).mockImplementationOnce(() => {
    throw new Error("synthetic native send failure")
  })
  const putNotification = jest.fn(async (_record: NotificationRecord) => {})
  await notify(
    { source: "system", level: "warning", title: "Audit", channels: ["center", "os"] },
    {
      now: Date.now,
      loadPrefs: () => resolvePreferences(),
      db: {
        findByDedupeKey: async () => undefined,
        putNotification,
        patchNotification: async () => {},
        pruneNotifications: async () => [],
      },
      isOsPermitted: async () => true,
      osNotify: notifyDesktop,
    },
    { personalContext: {} }
  )

  expect(sendNotification).toHaveBeenCalledTimes(1)
  expect(putNotification).toHaveBeenCalledWith(
    expect.objectContaining({ deliveredVia: ["center", "os"] })
  )
})

test("the real headless publisher emits CJK fields beyond the Rust RPC byte limits", async () => {
  await publishRemoteNotification({
    id: "audit-utf8",
    source: "scheduler",
    level: "warning",
    title: "测".repeat(54),
    body: "测".repeat(667),
    createdAt: 1,
    updatedAt: 1,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    personalContext: explicitHostPersonalSinkContext("fixed-notice"),
  })

  const [command, args] = jest.mocked(transport.call).mock.lastCall!
  const payload = args as { title: string; body: string }
  expect(command).toBe("remote_notification_publish")
  expect([payload.title.length, payload.body.length]).toEqual([54, 667])
  // The Rust RPC uses String::len (UTF-8 bytes) with limits 160 and 2000.
  expect([Buffer.byteLength(payload.title), Buffer.byteLength(payload.body)]).toEqual([162, 2001])
})
