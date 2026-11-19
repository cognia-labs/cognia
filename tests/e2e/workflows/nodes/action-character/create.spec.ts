/**
 * E2E: action.character.create — real executor writes a Dexie row.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { readDexieRow, resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  readLatestRun,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.character.create", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("edits character fields and restores saved values after reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-create")
    await assertNodeOnCanvas(page, { kind: "action.character.create", label: "Create" })
    await openNodeInspector(page, "action.character.create")
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("E2E Char")
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue(
      "Be helpful"
    )
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Edited E2E Character")
    await page
      .getByRole("textbox", { name: "System prompt", exact: true })
      .fill("Persist this workflow prompt")
    await expect(page.getByTestId("workflow-save")).toBeEnabled()
    await saveWorkflow(page)
    await expect(page.getByText("Workflow saved", { exact: true })).toBeVisible()
    await reopenAndAssertNode(page, wfId, { kind: "action.character.create" })
    await openNodeInspector(page, "action.character.create")
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
      "Edited E2E Character"
    )
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue(
      "Persist this workflow prompt"
    )
  })

  test("@critical manual run creates a character that survives reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-create")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    const run = await readLatestRun(page, wfId)
    const completed = run?.events.find(
      (event) => event.type === "step_completed" && event.stepId === "n_create"
    )
    const output = (completed?.payload as { output?: { characterId?: string } } | undefined)?.output
    expect(output?.characterId).toMatch(/^char_/)
    const characterId = output!.characterId!
    const expected = { name: "E2E Char", description: "demo", systemPrompt: "Be helpful" }
    await expect
      .poll(() => readDexieRow(page, { table: "characters", key: characterId }))
      .toMatchObject(expected)
    await page.reload()
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    expect(await readDexieRow(page, { table: "characters", key: characterId })).toMatchObject(
      expected
    )
  })
})
