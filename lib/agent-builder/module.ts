import { defineHostModule } from "@/lib/modules/define"

// The agent tools of "Build with AI" on /agents (ADR-0220): read the draft,
// list what it may reference, write fields, create the agent. The builder's
// session, draft and UI stay in the agent kernel, whose agents page mounts
// them; this module reaches them through the kernel's api files.
export default defineHostModule({
  id: "agent-builder",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: [],
  api: ["lib/agent-builder/agent-tools.ts"],
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
})
