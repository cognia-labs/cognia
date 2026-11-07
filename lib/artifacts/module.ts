import { defineHostModule } from "@/lib/modules/define"

// Artifacts (ADR-0139, ADR-0158): the dock's artifacts and canvas documents,
// their store, renderers, exports and captures, and the agent's tools over
// both.
export default defineHostModule({
  id: "artifact",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: [
    "annotations",
    "appearance",
    "automation",
    "best-of-n",
    "browser",
    "canvas",
    "chat",
    "code-adoption",
    "codeserver",
    "context-workbench",
    "data",
    "diff",
    "docs-providers",
    "editor",
    "editor-workbench",
    "file-viewer",
    "git",
    "modules",
    "plugin",
    "review",
    "source-control",
    "task-workspace",
    "terminal",
    "workflow",
    "workspace",
  ],
  // The dock editor copies a conversation file's link through filespace's
  // port; filespace depends on this module, so it cannot be imported.
  requires: ["conversation-file-links?"],
  api: [
    "components/artifacts/artifact-create-button.tsx",
    "components/artifacts/artifact-dock-toggle.tsx",
    "components/artifacts/artifact-icons.tsx",
    "components/artifacts/artifact-list.tsx",
    "components/artifacts/artifact-preview.tsx",
    "components/artifacts/chart-plot.tsx",
    "components/artifacts/dock-panel-meta.ts",
    "components/artifacts/review-hunk-item.tsx",
    "components/artifacts/runtime-adapters.ts",
    "hooks/artifacts/use-session-panel-showing.ts",
    "lib/artifacts/agent-tools.ts",
    "lib/artifacts/chart-contract.ts",
    "lib/artifacts/constants.ts",
    "lib/artifacts/diff-view-model.ts",
    "lib/artifacts/diff.ts",
    "lib/artifacts/dock-pages.ts",
    "lib/artifacts/export/index.ts",
    "lib/artifacts/format-review-receipt.ts",
    "lib/artifacts/format-selection-context.ts",
    "lib/artifacts/open-chat-document.ts",
    "lib/artifacts/preview-utils.ts",
    "lib/artifacts/reveal.ts",
    "lib/artifacts/route-ai-revision.ts",
    "lib/artifacts/session-workbench-scope-key.ts",
    "lib/artifacts/utils.ts",
    "stores/artifact/artifact-dock-layout-store.ts",
    "stores/artifact/artifact-store.ts",
    "stores/artifact/dock-tabs-store.ts",
  ],
  // The agent's artifact and canvas tools. Creating, revising, reading,
  // capturing and opening are allowed: a new card lands beside the turn that
  // made it and is one click from deletion, and with the user's
  // review-before-apply setting on (the default) a revision stages a diff;
  // versions are kept either way. `artifact_delete` destroys work the user
  // has been iterating on, so it asks. An explicit user rule overrides either
  // way. The runner takes no cancel signal.
  tools: {
    declare: {
      artifact_create: { consent: "allow", effect: "write", cancellable: false },
      artifact_update: { consent: "allow", effect: "write", cancellable: false },
      artifact_read: { consent: "allow", effect: "read", cancellable: false },
      artifact_delete: { consent: "ask", effect: "write", cancellable: false },
      artifact_capture: { consent: "allow", effect: "read", cancellable: false },
      canvas_create: { consent: "allow", effect: "write", cancellable: false },
      canvas_update: { consent: "allow", effect: "write", cancellable: false },
      canvas_read: { consent: "allow", effect: "read", cancellable: false },
      canvas_open: { consent: "allow", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // Its workflow nodes (ADR-0250 §14 `workflowNodes`): the artifact and canvas actions. The
  // workflow engine loads them before it looks an executor up.
  workflowNodes: { load: () => import("./workflow-nodes") },
})
