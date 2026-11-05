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
  // What the Squad screens build on (G4 checks this equals what they import).
  dependsOn: [
    "agent",
    "agent-runs",
    "agent-team",
    "data",
    "fleet",
    "plugin",
    "share",
    "templates",
    "usage",
  ],
  // The Squad review count the chat composer and the context workbench show.
  api: ["hooks/squads/use-pending-squad-reviews.ts"],
  searchProviders: () => import("./search-provider"),
  // The ordered Squad bootstrap (ADR-0169) on every host, from one
  // host-neutral adapter. It replaced the desktop's `SquadBootstrapInitializer`
  // and the brain roster's own registration; the name stays the one brain
  // operators restart it by.
  runtimes: [
    {
      name: "agent-team-runtime",
      criticality: "optional",
      boot: "knowledge-agents",
      adapters: {
        brain: { module: "./runtime/squad-bootstrap", hosts: ["brain"] },
        desktop: "./runtime/squad-bootstrap",
        mobile: "./runtime/squad-bootstrap",
      },
    },
  ],
  // Pinned on the rail by default (`DEFAULT_PINNED_IDS`) and on a fresh
  // phone's grid (`DEFAULT_GLANCE_MOBILE_SHORTCUTS`): both are layouts over
  // ids, which stay valid while the destination lives here.
  nav: [
    {
      id: "squads",
      route: "/squads",
      label: "squads.nav.label",
      icon: "Users",
      spotIcon: "agent-teams",
      group: "feature",
      category: "agents",
      after: "agents",
      goMenuAfter: "plugins",
      fullViewport: true,
      mobileShortcut: { after: "twin" },
    },
  ],
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
