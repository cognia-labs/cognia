/**
 * The built-in providers' document URL schemes, in recognition order. May
 * import only `<provider>/document-url.ts` (`pnpm audit:modules`, G8).
 */
import type { DocumentUrlScheme } from "@/lib/docs-providers/types"
import { larkDocumentUrls } from "./lark/document-url"
import { googleDocumentUrls } from "./google/document-url"

export const BUILTIN_DOCUMENT_URLS: readonly DocumentUrlScheme[] = [
  larkDocumentUrls,
  googleDocumentUrls,
]
