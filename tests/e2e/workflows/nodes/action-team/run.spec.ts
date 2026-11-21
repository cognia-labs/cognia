/**
 * Editor contract for action.team.run: form fields and durable graph state.
 * The executor is implemented in lib/workflow/nodes/teams/index.ts.
 * These assertions do not claim runtime or real-provider acceptance.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  expectInspectorFieldValue,
  fillInspectorField,
  openNodeInspector,
  readLatestRun,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.team.run — editor persistence & runtime execution", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("@critical seeded team run renders, goal round-trips, and executing settles a durable workflow run", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-run")
    await assertNodeOnCanvas(page, { kind: "action.team.run", label: "Run" })
    await openNodeInspector(page, "action.team.run")
    await expect(page.locator("#ins-teamId, [data-field=teamId]").first()).toBeVisible()
    await expect(page.locator("#ins-goal, [data-field=goal]").first()).toBeVisible()
    await fillInspectorField(page, "goal", "e2e round-trip goal")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.team.run" })
    await openNodeInspector(page, "action.team.run")
    await expectInspectorFieldValue(page, "goal", "e2e round-trip goal")

    // Execute the workflow end-to-end and verify the `action.team.run` executor
    // runs and settles a durable workflowRuns row (failing cleanly because the
    // synthetic fixture teamId does not exist in the browser store).
    await triggerRun(page, { waitForStatus: false })
    await expect
      .poll(async () => {
        const latest = await readLatestRun(page, wfId)
        return latest && latest.status !== "running" ? latest.status : null
      })
      .toBe("failed")
    const settled = await readLatestRun(page, wfId)
    expect(settled?.events.length).toBeGreaterThan(0)
  })
})
