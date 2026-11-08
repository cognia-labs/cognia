import { defineHostModule } from "@/lib/modules/define"

// Employee Digital Twin (ADR-0003): a person's knowledge, style and
// playbooks, distilled from their sources, retrieved per turn and spoken in
// their voice. Its distillation, reranking and system-template prompts reach
// the Prompt Center as its prompt contribution, and its identity section is
// its context contribution.
export default defineHostModule({
  id: "twin",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["modules", "plugin", "rag", "share"],
  // Scanned sources fall back to OCR, a deleted twin's memories are retired
  // by the memory module and the persona tab's benchmark is built by the
  // eval module. Each copes without a provider.
  requires: ["ocr?", "memory-namespaces?", "eval-benchmarks?"],
  api: [
    "components/twin/source-content-preview.tsx",
    "components/twin/twin-source-preview-dialog.tsx",
    "lib/twin/distill/llm.ts",
    "lib/twin/export-provenance.ts",
    "lib/twin/ingest/chunk.ts",
    "lib/twin/ingest/embed.ts",
    "lib/twin/ingest/lark-doc-fetcher.ts",
    "lib/twin/ingest/ocr-fallback.ts",
    "lib/twin/ingest/parse.ts",
    "lib/twin/ingest/persist.ts",
    "lib/twin/ingest/redaction-key.ts",
    "lib/twin/ingest/url-fetcher.ts",
    "lib/twin/outbound-disclosure.ts",
    "lib/twin/profile-summary.ts",
    "lib/twin/runtime/apply-twin-context.ts",
    "lib/twin/runtime/build-deps.ts",
    "lib/twin/runtime/inject-log.ts",
    "lib/twin/runtime/reranker.ts",
  ],
  prompts: () => import("./prompts"),
  // The twin's identity: it stands in for a twin-bound agent's base prompt.
  context: { load: () => import("./context") },
})
