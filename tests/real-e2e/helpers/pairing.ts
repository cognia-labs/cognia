import { expect, type Page } from "@playwright/test"

export const vaultPassword = "cognia-real-e2e-password"

export async function createBrowserAccount(page: Page, label: string): Promise<void> {
  // Create the account on the destination route. A full navigation after
  // creation intentionally locks the browser vault again, so pairing must
  // continue in the same unlocked document.
  await page.goto("/pair")
  const accountForm = page.locator("form")
  await accountForm.locator('input:not([type="password"])').fill(label)
  await accountForm.locator('input[type="password"]').fill(vaultPassword)
  await accountForm.locator('button[type="submit"]').click()

  const recovery = page.getByTestId("account-vault-recovery")
  await expect(recovery).toBeVisible()
  await recovery.getByRole("checkbox").check()
  await page.getByTestId("account-vault-recovery-continue").click()
}

export async function pairThroughUi(page: Page, payload: string): Promise<void> {
  await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  await page.getByTestId("pair-payload").fill(payload)
  await page.getByTestId("pair-submit").click()
  await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
  await page.waitForFunction(() => window.__cogniaE2ECompanion?.connectionState() === "connected")
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.__cogniaE2ECompanion?.runtime())?.targetId ?? null)
    )
    .not.toBe("web-standalone")
}

export async function createPairedAccount(
  page: Page,
  label: string,
  payload: string
): Promise<void> {
  await createBrowserAccount(page, label)
  await pairThroughUi(page, payload)
}
