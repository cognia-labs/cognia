import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/bot-e2e",
  testMatch: "matrix-persistence.browser.mjs",
  globalSetup: "./tests/bot-e2e/matrix-browser-setup.mjs",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: ".cache/test-results/matrix-browser",
  reporter: [["list"], ["json", { outputFile: ".cache/test-results/matrix-browser/results.json" }]],
})
