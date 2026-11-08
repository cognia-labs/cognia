import { defineHostModule } from "@/lib/modules/define"

// Platform connectors (ADR-0009, ADR-0025, ADR-0131): the IM adapters, the
// connector bus and runtime, inbound jobs, the outbound queue and delivery
// gateway, the inbox and its relay, HITL cards in chats, and the Lark and IM
// built-in skills. It is the IM channel of the `conversation-channel` port,
// so the kernel and other modules ask a conversation's channel instead of
// importing this module.
export default defineHostModule({
  id: "connectors",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The Lark workbench route, the IM and Lark built-in skills, and the data
  // files only the connectors read.
  owns: [
    "app/lark/",
    "lib/db/connector-cleanup-jobs.ts",
    "lib/db/conversation-labels.ts",
    "lib/db/feishu-principals.ts",
    "lib/db/lark-chat-surfaces.ts",
    "lib/db/lark-message-imports.ts",
    "lib/skills/built-in/im/",
    "lib/skills/built-in/lark/",
  ],
  // What the connectors build on (G4 checks this equals what they import):
  // IM turns run goals, Squads, workflows and slash commands, recall memory
  // and the twin. Nothing below imports the connectors back.
  dependsOn: [
    "account-sync",
    "audio",
    "background-tasks",
    "bot",
    "collab",
    "device",
    "goal",
    "governance",
    "host-consent",
    "inbox",
    "issues",
    "loop",
    "memory",
    "rag",
    "share",
    "slash-commands",
    "squads",
    "twin",
    "updates",
    "workflow",
    "workspace",
  ],
  // What the kernel, the shells and other modules still import: the bus,
  // delivery and outbound runner, the inbox writes and hooks the inbox and
  // chat screens use, adapter metadata, and the run-presentation helpers.
  api: [
    "components/connectors/capability-notice.tsx",
    "components/connectors/identity-merge-dialog.tsx",
    "components/connectors/platform-icons/index.tsx",
    "hooks/connectors/use-adapter-health.ts",
    "hooks/connectors/use-adapter-instance.ts",
    "hooks/connectors/use-canned-responses.ts",
    "hooks/connectors/use-conversation-activity.ts",
    "hooks/connectors/use-conversation-assignment-events.ts",
    "hooks/connectors/use-conversation-labels.ts",
    "hooks/connectors/use-conversation-overrides.ts",
    "hooks/connectors/use-degraded-adapters.ts",
    "hooks/connectors/use-draft-approval.ts",
    "hooks/connectors/use-history-hydration.ts",
    "hooks/connectors/use-im-effective-config.ts",
    "hooks/connectors/use-im-room-reply-mode.ts",
    "hooks/connectors/use-im-room-team.ts",
    "hooks/connectors/use-inbound-recovery-jobs.ts",
    "hooks/connectors/use-last-inbound.ts",
    "hooks/connectors/use-latest-outbound-job.ts",
    "hooks/connectors/use-outbound-saturation.ts",
    "hooks/connectors/use-pending-approval-count.ts",
    "hooks/connectors/use-pending-drafts.ts",
    "hooks/connectors/use-platform-avatar.ts",
    "hooks/connectors/use-resolved-binding.ts",
    "lib/connectors/a2ui-bridge/a2ui-to-segments.ts",
    "lib/connectors/adapter-metadata.ts",
    "lib/connectors/adapters/_shared/inbound-a2ui-normalize.ts",
    "lib/connectors/adapters/_shared/inbound-a2ui-types.ts",
    "lib/connectors/adapters/_shared/inbound-markdown.ts",
    "lib/connectors/assignment/notify-assignment.ts",
    "lib/connectors/audit-export.ts",
    "lib/connectors/audit.ts",
    "lib/connectors/bus.ts",
    "lib/connectors/callback-authorization.ts",
    "lib/connectors/canned-interpolate.ts",
    "lib/connectors/capability-availability.ts",
    "lib/connectors/composition/im-mode-presets.ts",
    "lib/connectors/composition/mode-projection.ts",
    "lib/connectors/conversation-admission.ts",
    "lib/connectors/delivery-gateway.ts",
    "lib/connectors/effective-capabilities.ts",
    "lib/connectors/effective-config.ts",
    "lib/connectors/escalation/policy.ts",
    "lib/connectors/hitl/plan-approval.ts",
    "lib/connectors/inbox-writes/index.ts",
    "lib/connectors/inbox-writes/local.ts",
    "lib/connectors/inbox-writes/use-inbox-write-route.ts",
    "lib/connectors/instance-transfer.ts",
    "lib/connectors/lifecycle.ts",
    "lib/connectors/media-model-gate.ts",
    "lib/connectors/mode-router.ts",
    "lib/connectors/platform-avatar.ts",
    "lib/connectors/policy-eval.ts",
    "lib/connectors/policy-resolve.ts",
    "lib/connectors/scheduled-outbound.ts",
    "lib/connectors/session-bindings.ts",
    "lib/connectors/sla.ts",
    "lib/connectors/trigger-policy-draft.ts",
  ],
  // Inbound images are read and voice notes transcribed through ports.
  // `room-squad-handoff`: the IM room hand-off card decides through it.
  requires: ["ocr", "speech", "room-squad-handoff?"],
  // The IM channel (`./ports/conversation-channel.ts`), and the vendors'
  // principal registries a sign-in reaches (`./ports/identity-principal-links.ts`).
  provides: [
    { port: "conversation-channel", load: () => import("./ports/conversation-channel") },
    { port: "identity-principal-links", load: () => import("./ports/identity-principal-links") },
  ],
  // The per-channel capability wording an IM-bound run is told.
  prompts: () => import("./prompts"),
  // Send, draft, react to, delete and forward IM messages, and wait for a
  // reply, as workflow nodes.
  workflowNodes: { load: () => import("./workflow-nodes") },
  // The Lark and IM built-in skill families, with the lark-cli availability
  // gate, registered when the skill tier loads them.
  builtinSkills: { load: () => import("./builtin-skills") },
  // Scheduled pushes into a bound IM conversation.
  taskExecutors: { types: ["im-push"], load: () => import("./scheduler/task-executors") },
  // The conversation-override pull, which keeps this client's in-flight
  // relayed mutations from being reverted by an older host row.
  syncHandlers: {
    tables: ["conversationOverrides"],
    load: () => import("./sync/sync-handlers"),
  },
})
