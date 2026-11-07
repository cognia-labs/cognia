import { defineHostModule } from "@/lib/modules/define"

// Long-term memory (ADR-0069, ADR-0115, ADR-0202): what the app remembers
// about the user and their projects, how it is written (extraction,
// consolidation, project mining, distillation), governed and recalled. Its
// writing and reranking prompts reach the Prompt Center as its prompt
// contribution; the turn's recall and project continuity are its context
// contributions, and `project_history_search` its tool contribution.
export default defineHostModule({
  id: "memory",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: [
    "chat",
    "data",
    "editor",
    "external-bridge",
    "git",
    "governance",
    "inbound",
    "inbox",
    "project-knowledge",
    "rag",
    "twin",
  ],
  api: [
    "components/memory/add-memory-dialog.tsx",
    "components/memory/memory-delete-confirm.tsx",
    "components/memory/memory-row.tsx",
    "hooks/memory/use-memory-command.ts",
    "hooks/memory/use-message-memories.ts",
    "lib/memory/api/as-of.ts",
    "lib/memory/api/caller.ts",
    "lib/memory/api/mutate-memory.ts",
    "lib/memory/api/read-memory.ts",
    "lib/memory/api/search-memory.ts",
    "lib/memory/api/store-memory.ts",
    "lib/memory/api/wire.ts",
    "lib/memory/control-plane/manage.ts",
    "lib/memory/control-plane/policy.ts",
    "lib/memory/control-plane/routed-manage.ts",
    "lib/memory/external/discover.ts",
    "lib/memory/external/home.ts",
    "lib/memory/history-filter.ts",
    "lib/memory/memory-event-bus.ts",
    "lib/memory/retrieve/retriever.ts",
    "lib/memory/run-turn-memory.ts",
    "lib/memory/runtime/apply-memory-context.ts",
    "lib/memory/runtime/build-deps.ts",
    "lib/memory/write/remember-fact.ts",
  ],
  prompts: () => import("./prompts"),
  // Retiring a deleted twin's memories, for the twin module.
  provides: [{ port: "memory-namespaces", load: () => import("./namespaces-port") }],
  // The deep path of project continuity, on the same switch as the section.
  tools: {
    declare: {
      project_history_search: { consent: "default", effect: "read", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // Personal recall (`memory` slot) and project continuity (`continuity`
  // slot, after recall, borrowing its unspent budget).
  context: { load: () => import("./context") },
})
