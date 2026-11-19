// Explicit audit-only discovery; counterexamples do not enter normal CI suites.
import buildAuditConfig from "./2026-11-17-notification-system-gap-audit.jest.config.ts"

const buildAdversarialConfig = async () => {
  const root = await buildAuditConfig()
  return {
    ...root,
    projects: root.projects.map((project) => ({
      ...project,
      displayName: "notification-adversarial",
      testMatch: [
        "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.egress-probes.ts",
        "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.routing-probes.ts",
        "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.permission-probes.ts",
        "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.runner-probes.ts",
        "<rootDir>/docs/reports/2026-11-17-notification-system-gap-audit/2026-11-17-notification-system-gap-audit.ui-probes.tsx",
      ],
    })),
  }
}
export default buildAdversarialConfig
