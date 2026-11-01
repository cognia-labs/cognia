/**
 * One composer-driven behaviour on desktop (Tauri/WebView2) and Web + Headless.
 * Both compare the renderer execution journal to the same committed projection.
 * Brain possession of the run is observed only: it is an ADR-0250 phase 1 question.
 */
import { defineConfig } from "@playwright/test"
import mainConfig, { tauriHarness } from "./playwright.config"
import webHeadlessConfig from "./playwright.web-headless.config"

const desktopEnabled = process.env.PLAYWRIGHT_TAURI === "1"

export default defineConfig({
  testDir: "./tests/dual-host",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: webHeadlessConfig.timeout,
  expect: webHeadlessConfig.expect,
  outputDir: ".cache/test-results/dual-host",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: ".cache/playwright-report/dual-host" }],
  ],
  globalSetup: desktopEnabled ? tauriHarness.globalSetup : undefined,
  // Native specs navigate the existing CDP page to mainConfig.use.baseURL.
  // Reuse its server lifecycle as well as its launcher; Web + Headless uses Caddy.
  webServer: desktopEnabled ? mainConfig.webServer : undefined,
  projects: [
    ...(desktopEnabled
      ? [
          {
            name: "desktop",
            ...tauriHarness.project,
            grep: /desktop: /,
            use: mainConfig.use,
          },
        ]
      : []),
    {
      name: "web-headless",
      grep: /web-headless: /,
      use: webHeadlessConfig.use,
    },
  ],
})
