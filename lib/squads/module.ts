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
  // from here, with the Squad templates panel only that section embeds, and
  // the `/agent-teams` redirect to `/squads` until its removal (ADR-0252 P9).
  owns: [
    "app/agent-teams/",
    "components/settings/agent/agent-team-templates-section",
    "components/settings/squads/",
  ],
  // What the Squad screens build on (G4 checks this equals what they import).
  dependsOn: [
    "agent",
    "agent-runs",
    "background-tasks",
    "board",
    "chat",
    "context-workbench",
    "data",
    "fleet",
    "git",
    "github",
    "icons",
    "integrations",
    "issues",
    "knowledge-base",
    "memory",
    "plugin",
    "router-fusion",
    "routing",
    "scm",
    "share",
    "stack",
    "templates",
    "terminal",
    "twin",
    "usage",
    "workflow",
  ],
  // What other modules may import: the Squad review count the chat composer
  // and the context workbench show, the launch seam and run context, template
  // and readiness helpers, and the Squad widgets other screens embed.
  api: [
    "components/squads/activity-report/report-kpi-cards.tsx",
    "components/squads/activity-report/report-plugin-slot.tsx",
    "components/squads/activity-report/report-taskline.tsx",
    "components/squads/activity-report/report-token-burn.tsx",
    "components/squads/agent-mention-picker.tsx",
    "components/squads/agent-team-avatar.tsx",
    "components/squads/auto-compose-dialog.tsx",
    "components/squads/consensus-panel.tsx",
    "components/squads/delegations-panel.tsx",
    "components/squads/durable-operations.tsx",
    "components/squads/members.tsx",
    "components/squads/runtime-badge.tsx",
    "components/squads/settings.tsx",
    "components/squads/tasks.tsx",
    "components/squads/team-run-controls.tsx",
    "hooks/squads/use-pending-squad-reviews.ts",
    "lib/squads/agent-team-runtime.ts",
    "lib/squads/apply-squad-template.ts",
    "lib/squads/binding-candidates.ts",
    "lib/squads/bootstrap.ts",
    "lib/squads/collaboration-tools.ts",
    "lib/squads/create-squad.ts",
    "lib/squads/durable/durable-control.ts",
    "lib/squads/durable/durable-dispatch.ts",
    "lib/squads/durable/durable-runtime.ts",
    "lib/squads/file-activity.ts",
    "lib/squads/gates/decide-pending-gate.ts",
    "lib/squads/gates/message-guard.ts",
    "lib/squads/pr-feedback/binding.ts",
    "lib/squads/pr-feedback/observer.ts",
    "lib/squads/pr-feedback/publish.ts",
    "lib/squads/pr-feedback/reactions.ts",
    "lib/squads/pr-feedback/resolvers.ts",
    "lib/squads/project-plugin-template.ts",
    "lib/squads/publish-template-to-platform.ts",
    "lib/squads/runtime-targets.ts",
    "lib/squads/squad-readiness.ts",
    "lib/squads/squad-template-platform.ts",
    "lib/squads/squad/build-start-input.ts",
    "lib/squads/squad/lead-execution.ts",
    "lib/squads/squad/resolve-turn-squad.ts",
    "lib/squads/squad/run-squad-to-end.ts",
    "lib/squads/squad/squad-control.ts",
    "lib/squads/squad/squad-run-records.ts",
    "lib/squads/squad/squad-run-steps.ts",
    "lib/squads/squad/start-squad-run.ts",
    "lib/squads/squad/watch-squad-run.ts",
    "lib/squads/team-run-context.ts",
    "lib/squads/team-wave-runner.ts",
    "lib/squads/team-workflow-id.ts",
    "lib/squads/teammate/execution-binding-resolver.ts",
    "stores/squads/agent-team-store/selectors.ts",
    "stores/squads/agent-team-store/store.ts",
  ],
  searchProviders: () => import("./search-provider"),
  prompts: () => import("./prompts"),
  // The agent's tools, three kinds in one family (`./agent-tools.ts`). None
  // of the runners takes a cancel signal.
  //
  // The collaboration tools a teammate uses during its own dispatch turn,
  // opted in by `selfInvokeTools.teamCollaboration`. They never had a tier,
  // so the run's own approval decides (`"default"`). `team_post_to_chat`
  // delivers into the run's IM conversation or a sibling one; it is declared
  // `write`, not `outbound`, because the risk classifier must not count it as
  // external-send (every headless IM team run would fail closed, ADR-0070).
  // The outbound engine still reviews it by name (`OUTBOUND_TOOLS_OUTSIDE_RISK`).
  //
  // The Squad template tools, switched on with the template tools by
  // `selfInvokeTools.templates`. Listing is free. Applying and saving a
  // template ask the plugin consent broker inside the runner, under the
  // template tools' subject, so the tier allows them rather than asking
  // twice.
  //
  // The room hand-off a character-team room's member proposes (ADR-0252 §4).
  // The card a person answers, or the room's own `auto` setting, is the
  // consent, so the tier allows the call; the Squad run it starts keeps its
  // own approval gates and risk policy.
  tools: {
    declare: {
      team_send_message: { consent: "default", effect: "write", cancellable: false },
      team_publish_memory: { consent: "default", effect: "write", cancellable: false },
      team_read_memory: { consent: "default", effect: "read", cancellable: false },
      team_request_consensus: { consent: "default", effect: "write", cancellable: false },
      team_vote: { consent: "default", effect: "write", cancellable: false },
      team_delegate: { consent: "default", effect: "write", cancellable: false },
      team_list_members: { consent: "default", effect: "read", cancellable: false },
      task_add_comment: { consent: "default", effect: "write", cancellable: false },
      task_get: { consent: "default", effect: "read", cancellable: false },
      twin_knowledge_search: { consent: "default", effect: "read", cancellable: false },
      team_post_to_chat: { consent: "default", effect: "write", cancellable: false },
      team_propose_decision: { consent: "default", effect: "write", cancellable: false },
      squad_list: { consent: "allow", effect: "read", cancellable: false },
      squad_apply_template: { consent: "allow", effect: "write", cancellable: false },
      squad_save_as_template: { consent: "allow", effect: "write", cancellable: false },
      room_handoff_to_squad: { consent: "allow", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // The engines `launchChildRun` (ADR-0252 §3) asks for: a Squad run launched
  // by another run, and a twin answering as a child run. The twin's moves to
  // the twin module once that module has a manifest; the contract stays.
  // And the Squad side of the template platform, which templates reaches
  // through `squad-templates` because squads builds on templates.
  provides: [
    { port: "squad-launch", load: () => import("./ports/squad-launch") },
    // Deciding a room member's hand-off to a Squad, for the Host's write arm
    // a paired device decides through (ADR-0252 §4).
    { port: "room-squad-handoff", load: () => import("./ports/room-squad-handoff") },
    { port: "twin-answer", load: () => import("./ports/twin-answer") },
    { port: "squad-templates", load: () => import("./ports/squad-templates") },
  ],
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
