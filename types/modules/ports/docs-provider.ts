// The `docs-provider` capability port (ADR-0134, ADR-0250 §14 M3): a cloud
// document source the composer, the dock, kept copies and Twin read through.
// It is a collection port: every vendor that implements it is its own module
// (Google Docs in `lib/google-docs/`, Lark Docs in `lib/lark-docs/`), and each
// providing module adds one member. Plugins add theirs at runtime through
// `ctx.docsProviders`.
//
// The kernel declares it here; the framework in `lib/docs-providers/` collects
// the members into its registry (`loadPortCollection("docs-provider")`) and is
// the only reader, so no module imports a vendor's implementation. What must
// hold before any member loads, each built-in's document URL scheme, stays in
// the framework's catalog (`lib/docs-providers/providers/_document-urls.ts`).

import type { DocsProvider } from "@/lib/docs-providers/types"

declare module "@/lib/modules/ports" {
  interface PortCollectionMap {
    "docs-provider": DocsProvider
  }
}

export type DocsProviderPort = DocsProvider
