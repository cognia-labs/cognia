import { defineHostModule } from "@/lib/modules/define"

// Playbooks (ADR-0254): a skill composed of other skills whose
// `references/flow.yaml` also compiles to a read-only workflow. The flow
// format, parser and compiler are pure and live in the skills kernel
// (`lib/skills/playbook/`); this module keeps each playbook's derived
// workflow stored and current. It reads skills and writes workflows through
// the data layer, so it imports no other module.
//
// Stage: beta until the default playbooks ship and the run surfaces land
// (plan WP4, WP9).
export default defineHostModule({
  id: "playbooks",
  kind: "module",
  stage: "beta",
  acceptance: { realSmoke: "pending" },
  dependsOn: [],
  // "Open as workflow" in the skill detail calls the sync.
  api: ["lib/playbooks/derived-workflow.ts"],
})
