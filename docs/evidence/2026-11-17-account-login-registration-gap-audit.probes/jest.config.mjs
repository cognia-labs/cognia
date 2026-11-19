import buildConfig from "../../../jest.config.ts"

const config = await buildConfig()
const jsdom = config.projects.find((project) => project.displayName === "jsdom")

const auditConfig = {
  ...config,
  cacheDirectory: "<rootDir>/.cache/account-registration-audit/jest-cache",
  rootDir: process.cwd(),
  projects: [
    {
      ...jsdom,
      rootDir: process.cwd(),
      displayName: "account-cloud-audit",
      testMatch: [
        "<rootDir>/docs/evidence/2026-11-17-account-login-registration-gap-audit.probes/*.probe.{ts,tsx}",
      ],
      testPathIgnorePatterns: jsdom.testPathIgnorePatterns.filter(
        (pattern) => !pattern.includes(".cache")
      ),
      modulePathIgnorePatterns: jsdom.modulePathIgnorePatterns.filter(
        (pattern) => !pattern.includes(".cache")
      ),
    },
  ],
}

export default auditConfig
