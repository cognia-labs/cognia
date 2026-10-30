/** Shared entry routing; every open retains the chat that owns the entry. */
import { openDockDocument, type DockDocumentOpenRequest } from "./dock-documents"
import {
  cloudDocumentTargetFromRef,
  classifyCloudDocumentUrl,
} from "@/lib/docs-providers/document-url"
import { parseRemoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import { useChatStore } from "@/stores/chat"

export function isDocumentPrimaryClick(event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

export function openChatDocument(request: Omit<DockDocumentOpenRequest, "reveal">): void {
  openDockDocument({
    ...request,
    reveal: useChatStore.getState().activeSessionId === request.sessionId,
  })
}

export function openCloudDocumentLink(
  url: string,
  sessionId: string | null | undefined,
  entry: "link" | "source"
): boolean {
  const target = classifyCloudDocumentUrl(url)
  if (!target || !sessionId) return false
  openChatDocument({ sessionId, target, entry, view: "live" })
  return true
}

export function openAttachedDocument({
  provenance: value,
  sessionId,
  text,
  mediaType,
  assetId,
  messageId,
  origin,
}: {
  provenance: unknown
  sessionId: string
  text: string
  mediaType?: string
  assetId?: string
  messageId?: string
  origin: "sent" | "staged"
}): boolean {
  const provenance = parseRemoteDocumentProvenance(value)
  if (!provenance) return false
  const target = cloudDocumentTargetFromRef(provenance.providerId, {
    providerId: provenance.providerId,
    kind: provenance.resourceKind,
    id: provenance.resourceId,
    title: provenance.title,
    url: provenance.url,
    sourceType: provenance.sourceType,
  })
  if (!target) return false
  openChatDocument({
    sessionId,
    target,
    entry: origin === "sent" ? "sent-attachment" : "staged-attachment",
    view: "snapshot",
    // Never fall back to the part body when a sent asset has been deleted.
    snapshot: assetId
      ? { kind: "asset", assetId, messageId }
      : {
          kind: "inline",
          content: {
            title: provenance.title,
            text,
            format: /csv/i.test(mediaType ?? "")
              ? "csv"
              : /markdown/i.test(mediaType ?? "")
                ? "markdown"
                : "text",
            fetchedAt: provenance.fetchedAt,
            completeness: provenance.completeness,
            truncated: provenance.truncated,
            origin,
          },
        },
  })
  return true
}
