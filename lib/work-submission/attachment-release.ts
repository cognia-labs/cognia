/**
 * Release the staged uploads a settled turn held (ADR-0253 §9 G25).
 *
 * A member's turn keeps its upload refs' bytes from the hand-off until it
 * settles (`holdAttachmentRefs`), because a retry after a Host restart builds
 * the prompt from them again. Settlement is the one place every ending of a
 * turn passes through — a reply, a failure, a stop, a restart that will not
 * retry — so the bytes are released here rather than at each of them.
 *
 * Best-effort: the turn is already sealed, and a release that fails leaves
 * the bytes to the upload store's collector once the turn is settled.
 */

import { consumeAttachmentRefs, parseUploadRef } from "@/lib/db/session-attachment-uploads"
import { getWorkInputBatch } from "@/lib/db/work-submissions"

export interface AttachmentReleaseDeps {
  getBatch?: typeof getWorkInputBatch
  consume?: typeof consumeAttachmentRefs
  onError?: (error: unknown) => void
}

export async function releaseSettledSubmissionAttachments(
  submissionId: string,
  deps: AttachmentReleaseDeps = {}
): Promise<void> {
  try {
    const batch = await (deps.getBatch ?? getWorkInputBatch)(submissionId)
    const refs = (batch?.attachments ?? [])
      .map((attachment) => attachment.assetId)
      .filter((ref) => parseUploadRef(ref) !== null)
    if (refs.length === 0) return
    await (deps.consume ?? consumeAttachmentRefs)(refs)
  } catch (error) {
    ;(deps.onError ?? ((reason: unknown) => console.warn("attachment release failed", reason)))(
      error
    )
  }
}
