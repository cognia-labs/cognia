/** Feishu/Lark document addresses for dock tabs (`lib/docs-providers/document-url.ts`). */
import type { DocumentUrlScheme } from "@/lib/docs-providers/types"
import { LARK_HOST_SUFFIXES, parseLarkResourceUrl } from "./url"

export const larkDocumentUrls: DocumentUrlScheme = {
  providerId: "lark",
  // Lark folds legacy docs and docx into `doc`; opaque picker tokens need the hint.
  keepsSourceType: true,
  target(url) {
    if (
      !LARK_HOST_SUFFIXES.some(
        (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix)
      )
    )
      return null
    const ref = parseLarkResourceUrl(url.href)
    if (!ref || ref.lowConfidence) return null
    return {
      resourceKind: ref.kind === "docx" ? "doc" : ref.kind,
      resourceId: ref.token,
      url: `${url.origin}${url.pathname}`,
    }
  },
}
