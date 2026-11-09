import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, readDexieRows, setCogniaSettings } from "../helpers/db-reset"

// Create work through the product, then prove that keyboard sorting writes
// durable order and cancellation reaches the shared runtime door.
test("Agent task board persists keyboard ordering and cancellation @critical", async ({
  page,
}, testInfo) => {
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Your desktop, with an agent in it.", exact: true })
  ).toBeVisible()
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-11-09T00:00:00.000Z" },
  })
  const agentId = await page.evaluate(async () => {
    if (!window.__cogniaSeedCharacter) throw new Error("Character seed bridge unavailable")
    return window.__cogniaSeedCharacter({ name: "Board regression agent" })
  })
  await page.goto(`/agents?id=${encodeURIComponent(agentId)}&mode=tasks`, {
    waitUntil: "domcontentloaded",
  })
  await expect(page.getByTestId("agent-task-board")).toBeVisible()
  for (const title of ["First task", "Second task", "Third task"]) {
    await page.getByTestId("agent-assign-work").click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("textbox", { name: "Task title", exact: true }).fill(title)
    await dialog.getByRole("button", { name: "Add task", exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible()
  }
  const first = page.getByRole("button", { name: "First task", exact: true })
  await first.focus()
  await page.keyboard.press("Space")
  await expect(page.getByTestId("agent-task-overlay")).toBeVisible()
  // KeyboardSensor attaches its document listener on the next browser task.
  // Let the pickup frame finish before issuing a separate movement gesture.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await page.keyboard.press("ArrowDown")
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: "Second task", exact: true })
        .locator("..")
        .evaluate((element) => {
          const transform = getComputedStyle(element).transform
          return transform === "none" ? 0 : new DOMMatrix(transform).m42
        })
    )
    .toBeLessThan(0)
  await page.keyboard.press("Space")
  const pendingOrder = async () =>
    (
      await readDexieRows<{ title: string; status: string; order: number; updatedAt: number }>(
        page,
        {
          table: "agentTasks",
        }
      )
    )
      .filter((row) => row.status === "pending")
      .sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt)
      .map((row) => row.title)
  await expect.poll(pendingOrder).toEqual(["Second task", "First task", "Third task"])
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(
    page
      .getByTestId("agent-task-column-pending")
      .getByRole("button", { name: /^(First|Second|Third) task$/ })
  ).toHaveText(["Second task", "First task", "Third task"])
  const handle = page.getByRole("button", { name: "First task", exact: true })
  await handle.locator("..").getByRole("button", { name: "Cancel", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await readDexieRows<{ title: string; status: string }>(page, { table: "agentTasks" })
        ).find((row) => row.title === "First task")?.status
    )
    .toBe("cancelled")
  await expect(
    page
      .getByTestId("agent-task-column-cancelled")
      .getByRole("button", { name: "First task", exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("agent-task-board.png"),
    animations: "disabled",
  })
})
