/**
 * Browser E2E: the issue tracker's state flow (ADR-0132 §8).
 *
 * Proves from the board what the 2026-11 revision promised:
 *   - a workspace's first project and its first issue are created together
 *     from the create sheet, and the card moves between columns by keyboard
 *     drag.
 *   - while a run holds an issue, the runtime owns its column: a drag greys
 *     every other column out and the drop is refused, and the card's status
 *     menu offers no other column.
 *   - a cancelled run hands the issue back to the column it came from (not a
 *     fixed `todo`), says so, and records the run as cancelled; a finished
 *     run parks the issue in In Review.
 *   - a federated agent-task row follows its engine live, without a reload.
 *   - grouping the board by priority draws swimlanes, and ungrouping removes
 *     them.
 *   - `?identifier=` opens the issue it names, and says so when none has it.
 *
 * The run engine is the one seam: `window.__cogniaE2EIssues` swaps the
 * agent-task ENGINE for a fake the spec finishes on cue
 * (`lib/dev/issue-fixtures.ts`). The bridge between the click and the engine
 * (claim, bind, run lock, settle-and-move, cancel hand-back) is production
 * code.
 */

import { expect, test, type Locator, type Page } from "@/tests/e2e/fixtures/test"
import type { E2EIssueFixtures } from "@/lib/dev/issue-fixtures"

import { resetCogniaDb, waitForTestGlobals } from "../helpers/db-reset"

declare global {
  interface Window {
    __cogniaE2EIssues?: E2EIssueFixtures
  }
}

const PROJECT_NAME = "Mercury"
const PROJECT_KEY = "MERC"
/** The first issue filed in a fresh project. */
const FIRST_IDENTIFIER = `${PROJECT_KEY}-1`

/** Provision the account and open the board with the fake run engine in place. */
async function bootBoard(page: Page, route = "/issues"): Promise<void> {
  await page.goto("/")
  await resetCogniaDb(page)
  await page.goto("about:blank")
  await page.goto(route, { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page)
  await page.evaluate(() => window.__cogniaE2EIssues!.installFakeRunEngine())
  await expect(page.getByTestId("issue-board")).toBeVisible()
}

/** The board card of a local issue, by its title. */
function localCard(page: Page, title: string): Locator {
  return page.locator('[data-testid^="issue-card-local:"]').filter({ hasText: title })
}

function column(page: Page, status: string): Locator {
  return page.getByTestId(`issue-column-${status}`)
}

/**
 * File the workspace's first issue. With no project yet, the create sheet asks
 * for one inline and writes both in one transaction.
 */
async function createFirstIssue(page: Page, title: string): Promise<Locator> {
  await page.getByTestId("issue-create-trigger").click()
  await page.getByTestId("create-issue-title").fill(title)
  await page.getByTestId("create-issue-project-name").fill(PROJECT_NAME)
  await page.getByTestId("create-issue-project-key").fill(PROJECT_KEY)
  await page.getByTestId("create-issue-submit").click()
  const card = localCard(page, title)
  await expect(card).toBeVisible()
  await expect(card).toContainText(FIRST_IDENTIFIER)
  return card
}

/** Open the card's detail panel and start a run on the (fake) agent-task engine. */
async function startRun(page: Page, card: Locator): Promise<Locator> {
  await card.click()
  const detail = page.getByTestId("issue-detail-panel")
  await expect(detail).toBeVisible()
  await detail.getByTestId("issue-run-trigger").click()
  const dialog = page.getByTestId("run-issue-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByTestId("run-issue-adapter-agent-task").click()
  await dialog.getByTestId("run-issue-submit").click()
  await expect(dialog).toBeHidden()
  await expect(detail.getByTestId("issue-run-running")).toBeVisible()
  return detail
}

test.describe("issues — state flow", () => {
  test("creates the first project with its first issue, then drags the card", async ({ page }) => {
    await bootBoard(page)
    const card = await createFirstIssue(page, "Fix the flaky sync")
    await expect(column(page, "backlog").locator(card)).toBeVisible()

    // Keyboard drag: Space picks up, the arrow crosses one column, Space drops.
    await card.focus()
    await page.keyboard.press("Space")
    await expect(page.getByTestId("issue-drag-overlay")).toBeVisible()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Space")
    await expect(page.getByTestId("issue-drag-overlay")).toBeHidden()
    await expect(column(page, "todo").locator(localCard(page, "Fix the flaky sync"))).toBeVisible()

    // The move is durable: it survives a reload.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(column(page, "todo").locator(localCard(page, "Fix the flaky sync"))).toBeVisible()
  })

  test("a run owns the column, a cancel hands the issue back, a finish parks it in review", async ({
    page,
  }) => {
    await bootBoard(page)
    const card = await createFirstIssue(page, "Audit the release evidence")
    await expect(column(page, "backlog").locator(card)).toBeVisible()

    const detail = await startRun(page, card)
    const running = column(page, "in_progress").locator(card)
    await expect(running).toBeVisible()
    await expect(page.locator('[data-testid^="issue-card-running-local:"]')).toBeVisible()

    // A drag greys every other column out and the drop is refused.
    await card.focus()
    await page.keyboard.press("Space")
    await expect(page.getByTestId("issue-drag-overlay")).toBeVisible()
    await expect(column(page, "todo")).toHaveAttribute("data-dimmed", "true")
    await expect(column(page, "in_review")).toHaveAttribute("data-dimmed", "true")
    await expect(column(page, "in_progress")).not.toHaveAttribute("data-dimmed", "true")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("Space")
    await expect(page.getByTestId("issue-drag-overlay")).toBeHidden()
    await expect(running).toBeVisible()

    // The status menu offers no other column while the run holds the issue.
    await card.click({ button: "right" })
    await page.getByTestId("issue-context-status").hover()
    await expect(page.getByTestId("issue-context-status-todo")).toHaveAttribute("data-disabled", "")
    await expect(page.getByTestId("issue-context-status-done")).toHaveAttribute("data-disabled", "")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    // Cancel: back to Backlog, where the run took it from, not a fixed Todo.
    await detail.getByTestId("issue-run-cancel").click()
    await expect(page.getByText("Run cancelled")).toBeVisible()
    await expect(detail.getByTestId("issue-run-cancelled")).toBeVisible()
    await expect(column(page, "backlog").locator(card)).toBeVisible()
    await expect(page.locator('[data-testid^="issue-card-running-local:"]')).toHaveCount(0)

    // A second run that finishes advances to In Review and stops there.
    await startRun(page, card)
    await expect(column(page, "in_progress").locator(card)).toBeVisible()
    await page.evaluate(
      (identifier) => window.__cogniaE2EIssues!.finishActiveRun(identifier, "succeeded"),
      FIRST_IDENTIFIER
    )
    await expect(column(page, "in_review").locator(card)).toBeVisible()
    await expect(detail.getByTestId("issue-run-succeeded")).toBeVisible()
    await expect(detail.getByTestId("issue-run-trigger")).toBeEnabled()
  })

  test("a federated agent task follows its engine live", async ({ page }) => {
    await bootBoard(page)
    const taskId = await page.evaluate(async () => {
      const agentId = await window.__cogniaSeedCharacter!({ name: "Release agent" })
      return window.__cogniaE2EIssues!.seedAgentTask({ agentId, title: "Collect the changelog" })
    })
    const row = page
      .locator('[data-testid^="issue-card-agent-task:"]')
      .filter({ hasText: "Collect the changelog" })
    await expect(column(page, "backlog").locator(row)).toBeVisible()

    // The engine cancels the task; the board follows without a reload.
    await page.evaluate((id) => window.__cogniaE2EIssues!.moveAgentTask(id, "cancelled"), taskId)
    await expect(column(page, "canceled").locator(row)).toBeVisible()
    await expect(column(page, "backlog").locator(row)).toHaveCount(0)
  })

  test("grouping by priority draws swimlanes, and ungrouping removes them", async ({ page }) => {
    await bootBoard(page)
    const card = await createFirstIssue(page, "Group me")
    const board = page.getByTestId("issue-board")

    await page.getByTestId("issue-toolbar-display").click()
    await page.getByTestId("issue-group-by-priority").click()
    await page.keyboard.press("Escape")
    await expect(board).toHaveAttribute("data-group-by", "priority")
    const lane = page.locator('[data-testid^="issue-lane-board-"]').filter({ has: card })
    await expect(lane).toHaveCount(1)

    await page.getByTestId("issue-toolbar-display").click()
    await page.getByTestId("issue-group-by-status").click()
    await page.keyboard.press("Escape")
    await expect(board).not.toHaveAttribute("data-group-by", "priority")
    await expect(page.locator('[data-testid^="issue-lane-board-"]')).toHaveCount(0)
    await expect(column(page, "backlog").locator(card)).toBeVisible()
  })

  test("?identifier= opens the issue it names and says when none has it", async ({ page }) => {
    await bootBoard(page)
    await createFirstIssue(page, "Linked from chat")

    await page.goto(`/issues?identifier=${FIRST_IDENTIFIER.toLowerCase()}`, {
      waitUntil: "domcontentloaded",
    })
    const detail = page.getByTestId("issue-detail-panel")
    await expect(detail).toBeVisible()
    await expect(detail).toContainText("Linked from chat")

    await page.goto(`/issues?identifier=${PROJECT_KEY}-404`, { waitUntil: "domcontentloaded" })
    await expect(page.getByText(`No issue is identified as ${PROJECT_KEY}-404.`)).toBeVisible()
    await expect(page.getByTestId("issue-detail-panel")).toBeHidden()
  })
})
