/**
 * E2E: configure a trigger.cron node and assert the saved draft carries it.
 *
 * The draft graph is the only store a trigger lives in: the native cron
 * daemon and the Scheduler list read the published version's own nodes, so
 * there is no separate trigger table to check (firing requires the Tauri
 * scheduler and a publish).
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — trigger.cron config", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("adding trigger.cron + saving persists its expression in the draft", async ({ page }) => {
    const id = await seedAndOpenWorkflow(page, "manual-ai")

    // Drop a trigger.cron node onto the canvas via the sidebar click affordance.
    await page.getByTestId("wf-sidebar-trigger.cron").first().click()
    await expect(page.getByTestId("wf-node-trigger.cron").first()).toBeVisible()

    // Open the inspector for the new node + configure the cron expression.
    await page.getByTestId("wf-node-trigger.cron").first().click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()
    const cronInput = page.locator("#cron-expr")
    await expect(cronInput).toBeVisible()
    await cronInput.fill("*/5 * * * *")

    // Save and wait for the dirty flag to clear.
    await page.getByTestId("workflow-save").click()
    await expect(page.getByTestId("workflow-save")).toBeDisabled({ timeout: 10_000 })

    const crons = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      const row = await getDb().workflows.get(workflowId)
      return (row?.nodes ?? [])
        .filter((node) => node.type === "trigger.cron")
        .map((node) => (node.data.params as { cron?: string }).cron)
    }, id)
    expect(crons).toEqual(["*/5 * * * *"])
  })
})
