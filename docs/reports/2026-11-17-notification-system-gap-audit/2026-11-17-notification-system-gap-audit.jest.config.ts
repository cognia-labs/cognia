// Audit-only counterexamples, explicitly excluded from normal test discovery
// by using a non-test filename. Run from the repository root via pnpm test.
import buildConfig from "../../../jest.config.ts"

const buildAuditConfig = async () => {
  const root = await buildConfig()
  const project = root.projects?.find(
    (candidate) =>
      typeof candidate !== "string" &&
      (typeof candidate.displayName === "string"
        ? candidate.displayName
        : candidate.displayName?.name) === "jsdom"
  )
  if (!project || typeof project === "string")
    throw new Error("The repository jsdom project is unavailable")
  return {
    ...root,
    rootDir: process.cwd(),
    projects: [
      {
        ...project,
        displayName: "notification-audit",
        rootDir: process.cwd(),
        testMatch: [
          "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.delivery-probes.ts",
        ],
        testPathIgnorePatterns: ["/node_modules/"],
      },
    ],
  }
}

export default buildAuditConfig
