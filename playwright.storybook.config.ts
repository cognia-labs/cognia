import { defineConfig, devices } from "@playwright/test"

const staticRoot =
  process.env.STORYBOOK_FULL_CATALOG === "1" ? ".cache/storybook-full" : ".cache/storybook-static"

export default defineConfig({
  testDir: "./tests/e2e/storybook",
  testMatch: "**/*.spec.ts",
  outputDir: ".cache/storybook-test-results",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{projectName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  failOnFlakyTests: true,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 15_000, toHaveScreenshot: { animations: "disabled" } },
  reporter: [
    ["list"],
    ["html", { outputFolder: ".cache/storybook-playwright-report", open: "never" }],
    ["json", { outputFile: ".cache/storybook-playwright-report/results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:6007",
    viewport: { width: 1280, height: 800 },
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "en-light",
      metadata: { locale: "en", theme: "light" },
      use: { locale: "en-US", colorScheme: "light" },
    },
    {
      name: "zh-dark",
      metadata: { locale: "zh-CN", theme: "dark" },
      use: { locale: "zh-CN", colorScheme: "dark" },
    },
    {
      name: "narrow",
      metadata: { locale: "en", theme: "light" },
      use: { locale: "en-US", colorScheme: "light", viewport: { width: 390, height: 844 } },
    },
  ],
  // A fresh static workshop, not the app's AccountGate/mock-fleet bootstrap.
  webServer: {
    command: `node scripts/e2e/serve-out.mjs --root ${staticRoot} --port 6007 --host 127.0.0.1 --skip-e2e-marker-check`,
    url: "http://127.0.0.1:6007/index.json",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
