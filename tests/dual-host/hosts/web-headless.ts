import { test as webTest } from "@playwright/test"
import { createPairedAccount } from "../../real-e2e/helpers/pairing"
import { composerHost } from "./composer"
import type { DualHost } from "../harness"

export const test = webTest.extend<{ host: DualHost }>({
  host: async ({ page }, provide) => {
    await provide(
      composerHost(page, "web-headless", async () => {
        const payload = process.env.COGNIA_REAL_PAIR_PAYLOAD
        if (!payload)
          throw new Error("COGNIA_REAL_PAIR_PAYLOAD must contain a fresh cgnp3 invitation")
        await createPairedAccount(page, "Dual Host Tool Turn", payload)
        // Keep the unlocked account in the same document, as the existing pairing flow requires.
        await page.getByTestId("pair-continue-cta").click()
      })
    )
  },
})
