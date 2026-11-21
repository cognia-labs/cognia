/**
 * E2E: trigger.chat.message — add to canvas, save, assert the saved draft
 * carries the trigger node. The draft graph is the only store a trigger
 * lives in; the chat trigger index reads the published version's nodes.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — trigger.chat.message config", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("adding trigger.chat.message + saving persists the node in the draft", async ({ page }) => {
    const id = await seedAndOpenWorkflow(page, "manual-ai")

    await page.getByTestId("wf-sidebar-trigger.chat.message").first().click()
    await expect(page.getByTestId("wf-node-trigger.chat.message").first()).toBeVisible()
    await page.getByTestId("wf-node-trigger.chat.message").first().click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()

    // Save without filling characterId (defaults to "any chat").
    await page.getByTestId("workflow-save").click()
    await expect(page.getByTestId("workflow-save")).toBeDisabled({ timeout: 10_000 })

    const chatTriggers = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      const row = await getDb().workflows.get(workflowId)
      return (row?.nodes ?? []).filter((node) => node.type === "trigger.chat.message").length
    }, id)
    expect(chatTriggers).toBe(1)
  })
})
