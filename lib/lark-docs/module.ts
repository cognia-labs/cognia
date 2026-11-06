import { defineHostModule } from "@/lib/modules/define"

// Lark Docs (ADR-0134): docs, wiki pages, sheets and bitables read through a
// Feishu / Lark Host connection, desktop only. It is one member of the
// `docs-provider` collection port (`types/modules/ports/docs-provider.ts`,
// ADR-0250 §14 M3): the framework in `lib/docs-providers/` loads it and
// registers it, and no other module imports its provider. Its URL scheme stays
// in the framework's catalog so a Lark link is recognised before this module
// loads.
export default defineHostModule({
  id: "lark-docs",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // Twin's Lark fetcher reads a document's blocks for both Twin ingest and
  // this provider, under one provenance.
  dependsOn: ["twin"],
  provides: [{ port: "docs-provider", load: () => import("./port") }],
})
