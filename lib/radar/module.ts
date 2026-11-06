import { defineHostModule } from "@/lib/modules/define"

// Attention Radar (ADR-0060): the periodic info-diet report over what the user
// captured and read. Its report panel fills the pet console's Extensions tab
// from `components/radar/module.ui.ts` (ADR-0250 §14, M2), so the pet no
// longer imports radar code; the pet's event sources only read the shared
// radar types.
export default defineHostModule({
  id: "radar",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The report runs as a scheduled task and links its runs' artifacts
  // (scheduler); the twin's model call writes it.
  dependsOn: ["scheduler", "twin"],
  tables: ["radarReports"],
  messages: "radar",
})
