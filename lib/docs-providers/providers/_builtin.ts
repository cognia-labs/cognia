/**
 * The built-in document providers `lib/docs-providers/index.ts` registers. May
 * import only `<provider>/index.ts` (`pnpm audit:modules`, G8).
 */
import type { DocsProvider } from "@/lib/docs-providers/types"
import { larkDocsProvider } from "./lark"
import { googleDocsProvider } from "./google"

export const BUILTIN_DOCS_PROVIDERS: readonly DocsProvider[] = [
  larkDocsProvider,
  googleDocsProvider,
]
