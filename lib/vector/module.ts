import { defineHostModule } from "@/lib/modules/define"

// Project-scoped vector memory for the agent: the native vector service, its
// collection namespace, permissions and audit ring, and the agent's tools.
export default defineHostModule({
  id: "vector",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["agent-trace"],
  api: ["lib/vector/agent-tools.ts"],
  // No key of its own; the view reads the kernel's provider settings.
  settings: { keys: [] },
  // The agent's vector tools, opt-in through `selfInvokeTools.vector`. All
  // three ask, as they did before they had a tier of their own: a tool with
  // no rule falls through to a human approval, and the opt-in seeds the
  // plugin permissions, not a tool rule. A user rule lifts any of them. The
  // runner honours the turn's abort, but a store write already sent to the
  // native side is not undone, so none is offered to live voice.
  tools: {
    declare: {
      vector_search: { consent: "ask", effect: "read", cancellable: false },
      vector_add_document: { consent: "ask", effect: "write", cancellable: false },
      vector_delete_document: { consent: "ask", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
