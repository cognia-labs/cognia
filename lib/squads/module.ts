import { defineHostModule } from "@/lib/modules/define"

// Squads (ADR-0140): agent teams a conversation can be handed to. The first
// module on the generated registries (ADR-0250 §14, phase M1): its settings
// section, search provider and slash command reach their shells from these
// manifests, not from a hand-written list.
export default defineHostModule({
  id: "squads",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The settings section stays where the plugin contract's `agent.team.panel`
  // slot names it (`components/settings/squads/squad-detail-panel.tsx`), owned
  // from here, with the Squad templates panel only that section embeds.
  owns: ["components/settings/squads/", "components/settings/agent/agent-team-templates-section"],
  searchProviders: () => import("./search-provider"),
  slashCommands: [
    {
      name: "squad",
      description:
        "Address the Squad running this conversation: status, roster board, and start / pause / resume / stop (ADR-0140).",
      category: "goal",
      argumentHint: "<status | list | run [objective] | pause | resume | stop | tasks>",
      argumentOptions: ["status", "list", "run", "pause", "resume", "stop", "tasks"],
      load: () => import("./slash-command"),
    },
  ],
  messages: "squads",
})
