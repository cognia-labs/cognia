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
import { checkNotificationPermission } from "@/lib/tauri/notification"
import { checkPermission } from "@/lib/capacitor/local-notifications"
import { notify } from "@/lib/notifications/notify"
import { resolvePreferences } from "@/lib/notifications/preferences"

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
