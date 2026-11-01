import { test as tauriTest } from "../../e2e/tauri/fixtures"
import { resetCogniaDb } from "../../e2e/helpers/db-reset"
import { composerHost } from "./composer"
import type { DualHost } from "../harness"

// The existing fixture owns the WebView2 connection and lifecycle.
export const test = tauriTest.extend<{ host: DualHost }>({
  host: async ({ page }, provide) => {
    await provide(
      composerHost(page, "desktop", async () => {
        await page.goto("/")
        await resetCogniaDb(page)
        await page.goto("/")
      })
    )
  },
})
