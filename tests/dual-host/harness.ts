import type { Page, TestInfo } from "@playwright/test"
import type { LedgerProjection } from "./ledger"
import { test as desktopTest } from "./hosts/desktop"
import { test as webHeadlessTest } from "./hosts/web-headless"

export interface DualHost {
  kind: "desktop" | "web-headless"
  openNewChat(): Promise<void>
  send(prompt: string): Promise<void>
  waitForAssistantText(re: RegExp): Promise<void>
  waitForIdle(): Promise<void>
  readLedger(sessionId?: string): Promise<LedgerProjection[]>
  activeSessionId(): Promise<string>
}

export function defineDualHostBehaviour(
  title: string,
  body: (host: DualHost, context: { page: Page; testInfo: TestInfo }) => Promise<void>
): void {
  // Project grep selects exactly one registration, without skip placeholders.
  // Each registration retains its host's real page/context fixtures.
  desktopTest(`desktop: ${title}`, async ({ host, page }, testInfo) => {
    await body(host, { page, testInfo })
  })
  webHeadlessTest(`web-headless: ${title}`, async ({ host, page }, testInfo) => {
    await body(host, { page, testInfo })
  })
}
