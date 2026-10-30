import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/bot-e2e",
  testMatch: "**/*.spec.mjs",
  globalSetup: "./tests/bot-e2e/global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: ".cache/test-results/bots",
  reporter: [
    ["list"],
    ["html", { outputFolder: ".cache/playwright-report/bots", open: "never" }],
    ["json", { outputFile: ".cache/test-results/bots/results.json" }],
    ["junit", { outputFile: ".cache/test-results/bots/junit.xml" }],
  ],
})
