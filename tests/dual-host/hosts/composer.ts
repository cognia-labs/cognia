// Shared UI driver: host modules own boot/pairing, both send through the renderer controller.
import { expect, type Page } from "@playwright/test"
import { normalizeLedger } from "../ledger"
import type { DualHost } from "../harness"

export function composerHost(
  page: Page,
  kind: DualHost["kind"],
  open: () => Promise<void>
): DualHost {
  const composer = page.getByRole("textbox", { name: /message/i }).first()
  let lastPrompt: string | undefined
  return {
    kind,
    async openNewChat() {
      await open()
      await page.waitForFunction(() => typeof window.__cogniaReadExecutionRuns === "function")
      await expect(composer).toBeVisible()
    },
    async send(prompt) {
      lastPrompt = prompt
      await composer.fill(prompt)
      await composer.press("Enter")
    },
    async waitForAssistantText(re) {
      await expect(page.getByText(re).first()).toBeVisible({ timeout: 60_000 })
    },
    async waitForIdle() {
      await expect(page.getByRole("button", { name: /^stop$/i })).toHaveCount(0)
      await expect(composer).toBeEditable()
      const sessionId = await this.activeSessionId()
      await expect
        .poll(async () => {
          const runs = await this.readLedger(sessionId)
          return (
            runs.length > 0 &&
            runs.every((run) => ["succeeded", "failed", "cancelled"].includes(run.status))
          )
        })
        .toBe(true)
    },
    async activeSessionId() {
      // New-chat sessions are minted by the first send. Read that user's
      // persisted message through the cipher rather than guessing an IndexedDB row.
      if (lastPrompt === undefined)
        throw new Error("Send a prompt before reading the active session")
      const sessionIds = () =>
        page.evaluate(async (prompt) => {
          const messages = await window.__cogniaReadMessages!()
          return [
            ...new Set(
              messages
                .filter((message) => message.role === "user" && message.text === prompt)
                .map((message) => message.sessionId)
            ),
          ]
        }, lastPrompt)
      await expect.poll(sessionIds).toHaveLength(1)
      return (await sessionIds())[0]
    },
    async readLedger(sessionId) {
      const id = sessionId ?? (await this.activeSessionId())
      const runs = await page.evaluate((session) => window.__cogniaReadExecutionRuns!(session), id)
      return normalizeLedger(runs)
    },
  }
}
