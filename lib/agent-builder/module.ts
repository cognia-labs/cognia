import { defineHostModule } from "@/lib/modules/define"

// "Build with AI" on /agents (ADR-0220): the builder conversation, its draft
// and the agent tools that read and write it, the live draft the model reads
// every turn, and the setup, workspace and drafts views the agents page
// mounts.
export default defineHostModule({
  id: "agent-builder",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["agent", "chat", "skills"],
  // The setup and workspace views the agents page mounts, the drafts list
  // its create chooser shows, and the tool names.
  api: [
    "components/agent-builder/agent-builder-drafts.tsx",
    "components/agent-builder/agent-builder-setup.tsx",
    "components/agent-builder/agent-builder-workspace.tsx",
    "lib/agent-builder/agent-tools.ts",
  ],
  // The user watches the draft change beside the conversation and can edit or
  // discard it, so reading, listing and writing it are allowed. Creating the
  // agent makes something that outlives the conversation, so it asks: the
  // approval the builder protocol promises. No runner honours a cancel signal.
  tools: {
    declare: {
      agent_builder_get_draft: { consent: "allow", effect: "read", cancellable: false },
      agent_builder_list_catalog: { consent: "allow", effect: "read", cancellable: false },
      agent_builder_update_draft: { consent: "allow", effect: "write", cancellable: false },
      agent_builder_create_agent: { consent: "ask", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // The live draft, a turn section in the dynamic tail.
  context: { load: () => import("./context") },
})
