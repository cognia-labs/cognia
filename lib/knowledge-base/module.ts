import { defineHostModule } from "@/lib/modules/define"

// Reusable knowledge bases an agent binds (independent of any project or
// Twin): ingest, revisions, retrieval, and progressive reading. The turn's
// retrieved excerpts and the conversation's reading scope are its context
// contributions; the `knowledge_*` reads are its tool contribution.
export default defineHostModule({
  id: "knowledge-base",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["rag", "twin", "workflow"],
  // Ingest and revisions for the settings manager and workflow apps; the
  // reader, its settings and the captured scope for nested dispatch, the
  // workflow knowledge node and the plugin project API.
  api: [
    "lib/knowledge-base/ingest/ingest-source.ts",
    "lib/knowledge-base/ingest/persist.ts",
    "lib/knowledge-base/revisions.ts",
    "lib/knowledge-base/runtime/apply-agent-knowledge-context.ts",
    "lib/knowledge-base/runtime/progressive-reading.ts",
    "lib/knowledge-base/runtime/reading-settings.ts",
    "lib/knowledge-base/runtime/session-reader.ts",
  ],
  // Reads only, offered only to a run whose `reader` contribution built a
  // reader. No rule of their own: they keep the default permission path the
  // plugin-manifest entries had.
  tools: {
    declare: {
      knowledge_list_documents: { consent: "default", effect: "read" },
      knowledge_read_outline: { consent: "default", effect: "read" },
      knowledge_read_original: { consent: "default", effect: "read" },
      knowledge_locate: { consent: "default", effect: "read" },
    },
    load: () => import("./agent-tools"),
  },
  // The reading scope (session state, no text) and the retrieved excerpts.
  context: { load: () => import("./context") },
  // Pinning a workflow deployment to index generations, which the workflow
  // engine asks for through a port rather than importing the knowledge base.
  provides: [{ port: "knowledge-base-revisions", load: () => import("./ports/revisions") }],
  // Its workflow nodes (ADR-0250 §14 `workflowNodes`): the knowledge ingestion pipeline and
  // retrieval. The workflow engine loads them before it looks an executor up.
  workflowNodes: { load: () => import("./workflow-nodes") },
})
