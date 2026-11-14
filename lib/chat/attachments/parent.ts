import type { UIMessage } from "ai"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { videoAttachmentInfoOfPart } from "./video/attachment-info"

export type ParentAttachmentFile =
  { file: File; reason?: never } | { file?: never; reason: "missingBytes" | "readFailed" }

/** Local originals/data URLs use composer restoration; canonical media is the only fallback. No network. */
export async function restoreParentAttachment(
  parentId: string,
  message: UIMessage,
  partIndex: number
): Promise<ParentAttachmentFile> {
  const part = message.parts[partIndex]
  if (part?.type !== "file") return { reason: "missingBytes" }
  try {
    const { composerRestoreFromMessage } = await import("@/lib/chat/composer-restore")
    const restored = await composerRestoreFromMessage(parentId, { parts: [part] })
    if (restored.files[0]) return { file: restored.files[0] }
    // A video poster is not the original video.
    if (videoAttachmentInfoOfPart(part)) return { reason: "missingBytes" }
    const { getMessageMedia, isMediaRef } = await import("@/lib/db/message-media")
    if (!isMediaRef(part.url)) return { reason: "missingBytes" }
    const media = await getMessageMedia(part.url)
    if (!media || media.canonicalAvailable === false) return { reason: "missingBytes" }
    return {
      file: new File([media.blob], part.filename || "attachment", { type: media.mediaType }),
    }
  } catch {
    return { reason: "readFailed" }
  }
}

/** Check local presence without decoding or retaining every attachment in the picker. */
export async function parentAttachmentUnavailableReason(
  parentId: string,
  message: UIMessage,
  partIndex: number
) {
  const part = message.parts[partIndex]
  if (part?.type !== "file") return "missingBytes" as const
  try {
    const extraction = readAttachmentExtractedContent(
      (part as { extractedContent?: unknown }).extractedContent
    )
    if (extraction) {
      const { getSessionAssetMetadata } = await import("@/lib/db/session-assets")
      if ((await getSessionAssetMetadata(parentId, extraction.attachmentId))?.sourceAvailable)
        return undefined
    }
    if (videoAttachmentInfoOfPart(part)) return "missingBytes" as const
    if (part.url?.startsWith("data:")) return undefined
    const { parseMediaRef, isMediaRef } = await import("@/lib/db/message-media")
    if (isMediaRef(part.url)) {
      // Presence checks run in a live query: touching lastUsedAt here would retrigger it forever.
      const { getDb } = await import("@/lib/db/schema")
      const media = await getDb().messageMedia.get(parseMediaRef(part.url)!)
      if (media && media.canonicalAvailable !== false) return undefined
    }
    return "missingBytes" as const
  } catch {
    return "readFailed" as const
  }
}
