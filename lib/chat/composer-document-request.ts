/** Explicit dock → owning composer request. Preview never invokes this seam. */
import { cloudDocumentTargetFromRef } from "@/lib/docs-providers/document-url"
import type { RemoteDocRef } from "@/lib/docs-providers/types"

export const COMPOSER_DOCUMENT_REQUEST_EVENT = "cognia:composer:document"
export interface ComposerDocumentRequest {
  sessionId: string
  doc: RemoteDocRef
}

export function requestComposerDocument(request: ComposerDocumentRequest): boolean {
  if (typeof window === "undefined") return false
  const detail = { ...request, claimed: false }
  window.dispatchEvent(new CustomEvent(COMPOSER_DOCUMENT_REQUEST_EVENT, { detail }))
  return detail.claimed
}

export function onComposerDocumentRequest(
  sessionId: string | undefined,
  handler: (doc: RemoteDocRef) => void
): () => void {
  if (typeof window === "undefined" || !sessionId) return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerDocumentRequest & { claimed: boolean }>).detail
    const doc = detail?.doc
    if (
      detail?.claimed ||
      detail?.sessionId !== sessionId ||
      !doc ||
      !["doc", "wiki", "sheet", "bitable", "resource"].includes(doc.kind) ||
      typeof doc.id !== "string" ||
      typeof doc.title !== "string" ||
      typeof doc.accountBinding?.accountId !== "string" ||
      !doc.accountBinding.accountId ||
      typeof doc.accountBinding.authorizationEpoch !== "string" ||
      !doc.accountBinding.authorizationEpoch ||
      !cloudDocumentTargetFromRef(doc.providerId, doc)
    )
      return
    detail.claimed = true
    handler(doc)
  }
  window.addEventListener(COMPOSER_DOCUMENT_REQUEST_EVENT, listener)
  return () => window.removeEventListener(COMPOSER_DOCUMENT_REQUEST_EVENT, listener)
}
