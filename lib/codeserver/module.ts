import { defineHostModule } from "@/lib/modules/define"

// The Pro IDE (ADR-0088): the embedded code-server, its pane and client, and
// the agent's editor tools.
export default defineHostModule({
  id: "codeserver",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["appearance", "browser", "canvas", "data", "editor", "issues", "theme"],
  // The pane manager, hooks and web embed the editor's Pro IDE panes mount,
  // the project opener the diff pane and issue panel use, the root resolver
  // the workflow editor node reads, the remote relay the runtime environment
  // uses, and the agent's tools.
  api: [
    "hooks/codeserver/use-code-server-broker-issues.ts",
    "hooks/codeserver/use-code-server-broker-progress.ts",
    "hooks/codeserver/use-code-server-broker-status.ts",
    "hooks/codeserver/use-code-server-chat-bridge.ts",
    "hooks/codeserver/use-code-server-editor-events.ts",
    "hooks/codeserver/use-code-server-locale-sync.ts",
    "hooks/codeserver/use-code-server-pane.ts",
    "hooks/codeserver/use-code-server-project-opener.ts",
    "hooks/codeserver/use-code-server-settings-sync.ts",
    "hooks/codeserver/use-code-server-supported.ts",
    "hooks/codeserver/use-code-server-workspace-navigation.ts",
    "hooks/codeserver/use-code-server-workspace-sync.ts",
    "lib/codeserver/agent-tools.ts",
    "lib/codeserver/client.ts",
    "lib/codeserver/error-messages.ts",
    "lib/codeserver/pane-manager.ts",
    "lib/codeserver/remote-relay.ts",
    "lib/codeserver/resolve-root.ts",
    "lib/codeserver/web-embed.ts",
  ],
  // The agent's editor tools (ADR-0088 phase 3). Reading the active editor
  // has no tier: the run's own approval decides, as it always has. Offered on
  // nearly every desktop turn with a workspace, it adds no rule to those
  // turns' rulesets. Four write tools only move the user's
  // viewport or reflect an edit already on disk, so they are allowed;
  // `save_editor_buffers` forces the user's own unsaved edits to disk, so it
  // asks. None of the runners takes a cancel signal.
  tools: {
    declare: {
      read_active_editor: { consent: "default", effect: "read", cancellable: false },
      open_in_editor: { consent: "allow", effect: "write", cancellable: false },
      reveal_in_editor: { consent: "allow", effect: "write", cancellable: false },
      show_editor_diff: { consent: "allow", effect: "write", cancellable: false },
      apply_editor_edit: { consent: "allow", effect: "write", cancellable: false },
      save_editor_buffers: { consent: "ask", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
