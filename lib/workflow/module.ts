import { defineHostModule } from "@/lib/modules/define"

// Visual workflows (ADR-0011): the graph model, the editor and its Copilot,
// the engine (orchestrator, step executor, triggers, deployments and apps)
// and the built-in node families. Node families a feature module owns are that
// module's `workflowNodes` contribution, loaded by the engine
// (`./nodes/module-nodes.ts`), so the engine imports none of them.
export default defineHostModule({
  id: "workflow",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The published-app portal route and the app, conversation and stats data
  // files only workflow reads.
  owns: [
    "app/portal/",
    "lib/db/workflow-apps.ts",
    "lib/db/workflow-conversations.ts",
    "lib/db/workflow-stats.ts",
  ],
  // What the engine, the editor and the built-in node families build on (G4
  // checks this equals what they import).
  dependsOn: [
    "a2ui",
    "automation",
    "bot",
    "browser",
    "capture",
    "chat",
    "codeserver",
    "connectors",
    "context-workbench",
    "device",
    "durable",
    "git",
    "governance",
    "images",
    "issues",
    "media",
    "memory",
    "playbooks",
    "plugin",
    "rag",
    "router-fusion",
    "scheduler",
    "share",
    "stack",
    "twin",
    "webhooks",
  ],
  // What other modules may import: the engine's entry points (starting,
  // cancelling and resuming runs, triggers, deployments), the node registry
  // and the helpers node families share, the editor's store and Copilot
  // commands, and the widgets other screens embed.
  api: [
    "components/workflow/editor/chat/workflow-proposal-card.tsx",
    "components/workflow/editor/inspector/data/data-json-view.tsx",
    "components/workflow/editor/inspector/forms/shared/entity-picker.tsx",
    "components/workflow/editor/inspector/forms/shared/multi-entity-picker.tsx",
    "components/workflow/runs/run-status-pill.tsx",
    "hooks/workflow/use-debounced-callback.ts",
    "hooks/workflow/use-raf-throttle.ts",
    "lib/workflow/api/workflow-api-service.ts",
    "lib/workflow/copilot-templates/index.ts",
    "lib/workflow/definition/migrate.ts",
    "lib/workflow/definition/read-only.ts",
    "lib/workflow/editor/copilot-slash-commands.ts",
    "lib/workflow/editor/store.ts",
    "lib/workflow/editor/use-mentionable-workflow-elements.ts",
    "lib/workflow/editor/workflow-editor-context.tsx",
    "lib/workflow/knowledge/access.ts",
    "lib/workflow/knowledge/artifacts.ts",
    "lib/workflow/library/lookup.ts",
    "lib/workflow/node-groups/materialize.ts",
    "lib/workflow/nodes/ai/ai-prompt-routed.ts",
    "lib/workflow/nodes/ai/pii-gate.ts",
    "lib/workflow/nodes/ai/schema-validate.ts",
    "lib/workflow/nodes/catalog.ts",
    "lib/workflow/nodes/registry.ts",
    "lib/workflow/nodes/shared/executor-support.ts",
    "lib/workflow/nodes/teams/team-runtime-port.ts",
    "lib/workflow/publish/publication-lifecycle.ts",
    "lib/workflow/runs/step-breakdown.ts",
    "lib/workflow/runs/usage-aggregate.ts",
    "lib/workflow/runtime/cancel-run.ts",
    "lib/workflow/runtime/companion-run-events.ts",
    "lib/workflow/runtime/concurrency-controller.ts",
    "lib/workflow/runtime/event-log.ts",
    "lib/workflow/runtime/execution-authority.ts",
    "lib/workflow/runtime/model-preference-controller.ts",
    "lib/workflow/runtime/orchestrator.ts",
    "lib/workflow/runtime/resume-controller.ts",
    "lib/workflow/runtime/run-resources.ts",
    "lib/workflow/runtime/start-from-im.ts",
    "lib/workflow/runtime/trigger-bridge.ts",
    "lib/workflow/runtime/trigger-subscriptions.ts",
    "lib/workflow/runtime/webhook-bridge.ts",
    "lib/workflow/triggers/registry.ts",
  ],
  // The OCR node reads through the `ocr` port; pinning a deployment to
  // knowledge-base generations goes through `knowledge-base-revisions`, which
  // fails the deployment when no module provides it.
  requires: ["ocr", "knowledge-base-revisions?"],
  // The Workflow Copilot a conversation in the editor runs as, which the send
  // resolver asks for by the session kind.
  provides: [{ port: "workflow-editor-session", load: () => import("./ports/editor-session") }],
  // The AI nodes' prompts and the editor Copilot's identity, quick actions and
  // slash-command turns.
  prompts: () => import("./prompts"),
  // The typed runner (`./agent-tools.ts`), offered to a run with a
  // graph-bodied skill or at the ultracode tier. It stands in for the
  // `cognia-workflow-ai` plugin's own registration, which answers first when
  // it exists (`precedence: "fallback"`). It never had a tier of its own, so
  // the run's approval decides; it starts a workflow run and takes no cancel
  // signal.
  tools: {
    declare: {
      wf_run_workflow_typed: {
        consent: "default",
        effect: "write",
        cancellable: false,
        precedence: "fallback",
      },
    },
    load: () => import("./agent-tools"),
  },
})
