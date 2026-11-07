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
  // The agent's vector tools, opt-in through `selfInvokeTools.vector`. None
  // has a tier: the run's own approval decides, which asks unless a grant,
  // the mode or a person's rule allows it (the opt-in seeds the plugin
  // permissions, not a tool rule). The runner honours the turn's abort, but a
  // store write already sent to the native side is not undone, so none is
  // offered to live voice.
  tools: {
    declare: {
      vector_search: { consent: "default", effect: "read", cancellable: false },
      vector_add_document: { consent: "default", effect: "write", cancellable: false },
      vector_delete_document: { consent: "default", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
