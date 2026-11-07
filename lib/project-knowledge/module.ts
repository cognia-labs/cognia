import { defineHostModule } from "@/lib/modules/define"

// A workspace's own knowledge files (`Project.knowledgeBase`): ingest into the
// project's vector collection and retrieval for the workspace's runs. The
// turn's excerpts are its context contribution.
export default defineHostModule({
  id: "project-knowledge",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["rag", "twin"],
  // Content hashing and source formats for memory, the knowledge managers and
  // the plugin project API; the ingest controller the shell mounts; the
  // retrieval runtime builder and collection naming the project scope reads.
  api: [
    "lib/project-knowledge/ingest/ingest-file.ts",
    "lib/project-knowledge/ingest/persist.ts",
    "lib/project-knowledge/runtime/build-deps.ts",
    "lib/project-knowledge/wire-ingest.ts",
  ],
  // The workspace excerpts, a turn section in the `project-knowledge` slot.
  context: { load: () => import("./context") },
})
