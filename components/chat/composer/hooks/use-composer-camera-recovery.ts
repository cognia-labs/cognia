"use client"

import { useCameraRecovery } from "@/hooks/use-camera-recovery"

import type { useAttachmentIntake } from "./use-attachment-intake"

export interface ComposerCameraRecoveryInput {
  /**
   * The mobile composer's `attachmentToFiles`. Passed in so this hook does not
   * import the mobile shell; the composer already does.
   */
  attachmentToFiles: (
    attachment:
      | { kind: "photo"; base64?: string; uri?: string; mime: string }
      | { kind: "photos"; items: Array<{ uri: string; mime: string }> }
  ) => Promise<File[]>
  sessionId: string | null
  persistDrafts: boolean
  draftHydratedFor: string | null
  acceptFiles: ReturnType<typeof useAttachmentIntake>["acceptFiles"]
}

/**
 * Stages the photos a camera capture returned after the app was backgrounded
 * (and possibly killed) while the camera was open. Subscribes only once this
 * conversation's draft has hydrated (when drafts persist), so the recovered
 * photos land in the restored draft.
 */
export function useComposerCameraRecovery({
  attachmentToFiles,
  sessionId,
  persistDrafts,
  draftHydratedFor,
  acceptFiles,
}: ComposerCameraRecoveryInput): void {
  useCameraRecovery(
    sessionId && (!persistDrafts || draftHydratedFor === sessionId)
      ? { kind: "chat", id: sessionId }
      : null,
    async (result, isCurrent) => {
      const files = await attachmentToFiles(
        result.kind === "photo"
          ? { kind: "photo", ...result.photo, mime: `image/${result.photo.format}` }
          : {
              kind: "photos",
              items: result.photos.map((photo) => ({
                uri: photo.uri,
                mime: `image/${photo.format}`,
              })),
            }
      )
      if (!isCurrent() || files.length === 0) return false
      const accepted = await acceptFiles(files, { isCurrent })
      return isCurrent() && accepted.length > 0
    }
  )
}
