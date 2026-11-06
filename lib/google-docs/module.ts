import { defineHostModule } from "@/lib/modules/define"

// Google Docs (ADR-0134): Docs, Sheets and Slides read through a Google Host
// connection, desktop only. It is one member of the `docs-provider`
// collection port (`types/modules/ports/docs-provider.ts`, ADR-0250 §14 M3):
// the framework in `lib/docs-providers/` loads it and registers it, and no
// other module imports its provider. Its URL scheme stays in the framework's
// catalog so a Google link is recognised before this module loads.
export default defineHostModule({
  id: "google-docs",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  provides: [{ port: "docs-provider", load: () => import("./port") }],
})
