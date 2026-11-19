/**
 * E2E: app notification queue, cancellation, and tap navigation.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — local notifications", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      initialNotifications: [
        { id: 42, title: "Backup reminder", body: "Backup is due" },
        { id: 43, title: "Keep this reminder", body: "Still pending" },
      ],
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-11-10T00:00:00.000Z",
      },
    })
    await page.goto("/me/notifications")
    await expect(page.getByTestId("mobile-notifications-page")).toBeVisible()
  })

  test("@critical lists pending notifications and preserves cancellation on refresh", async ({ page }) => {
    await page.getByTestId("mobile-settings-notifications-queue-entry").click()
    const queue = page.getByTestId("notifications-queue-sheet")
    await expect(queue.getByText("Backup reminder", { exact: true })).toBeVisible()
    await expect(queue.getByText("Backup is due", { exact: true })).toBeVisible()
    await queue.getByTestId("notifications-queue-cancel-42").click()
    await expect(queue.getByText("Keep this reminder", { exact: true })).toBeVisible()
    await expect(queue.getByTestId("notifications-queue-refresh")).toBeEnabled()
    await expect(queue.getByText("Backup reminder", { exact: true })).toHaveCount(0)
    await queue.getByTestId("notifications-queue-refresh").click()
    await expect(queue.getByText("Keep this reminder", { exact: true })).toBeVisible()
    await expect(queue.getByTestId("notifications-queue-refresh")).toBeEnabled()
    await expect(queue.getByText("Backup reminder", { exact: true })).toHaveCount(0)
  })

  test("@critical routes a notification tap to the backup screen", async ({ page }) => {
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { pushLocalNotificationAction: (p: unknown) => void }
        }
      ).__cogniaCapMock.pushLocalNotificationAction({
        actionId: "tap",
        notification: { id: 42, extra: { route: "/me/backup" } },
      })
    })
    await expect(page).toHaveURL(/\/me\/backup\/?$/)
    await expect(page.getByTestId("backup-export")).toBeVisible()
  })
})
