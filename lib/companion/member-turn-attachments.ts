/**
 * A member's attachments, staged into their person partition (ADR-0253 §9,
 * G25).
 *
 * A member device may not dispatch a turn itself: `message.enqueue` is its
 * only way in, and the intent carries refs, never bytes. So a member's files
 * cross as uploads into the partition's own staging store first, and the Host
 * builds the prompt from them the way it does for any remote attachment
 * (`resolveOutboundAttachments`): extraction, redaction and token budgeting
 * run there, once, for both member turn kinds.
 *
 * What crosses is each file's ORIGINAL bytes, not the blocks this device
 * built for its own preview: a downscaled image or a selected excerpt would
 * be extracted a second time from something that is no longer the file.
 *
 * Two halves:
 *  - {@link memberTurnAttachments} decides, without I/O, whether the turn's
 *    content is exactly its attachments followed by the request text and
 *    whether this Host takes every file. Anything else is refused with a
 *    reason, before a row is written, so the composer gets the turn back.
 *  - {@link uploadMemberTurnAttachments} uploads them in order and returns
 *    the refs the intent names. A failure aborts what this send opened.
 */

import type { SendContent } from "@cognia/agent-config-types"
import type { HostStateAttachmentRef } from "@cognia/agent-config-types/host-state"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import {
  COMPOSER_MAX_ATTACHMENT_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  isSupportedAttachmentDescriptor,
} from "@/lib/chat/attachments/prepare"
import type { HostRuntimeSnapshot } from "@/lib/runtime/operation-availability"
import {
  abortSessionAttachmentUpload,
  uploadSessionAttachment,
  type AttachmentUploadCall,
} from "./attachment-upload-client"

/** The upload operations a Host must advertise for a member to attach files. */
export const MEMBER_ATTACHMENT_UPLOAD_OPERATIONS = [
  "session_attachment_upload_init",
  "session_attachment_upload_chunk",
  "session_attachment_upload_commit",
  "session_attachment_upload_abort",
] as const

/** One file of a member's turn, as it will be uploaded. */
export interface MemberTurnFile {
  name: string
  mediaType: string
  original: Blob
}

/** Why a member's attachments cannot ride the intent. */
export type MemberAttachmentRefusal =
  /** Something besides the attachments and the request rides the content. */
  | "shape"
  /** The Host does not advertise the upload operations. */
  | "uploads-unavailable"
  /** A video: the Host prepares attachments from files it can extract. */
  | "video"
  /** The composer kept no original bytes for the file. */
  | "no-original"
  /** The Host does not accept the file's type. */
  | "type"
  | "empty"
  | "too-large"
  | "too-many"

export type MemberTurnAttachments =
  | { kind: "none" }
  | { kind: "files"; files: MemberTurnFile[] }
  | { kind: "unsupported"; reason: MemberAttachmentRefusal }

/**
 * The files a member's turn carries, or why it cannot carry them.
 *
 * `content` is the turn as the provider pipeline left it and `manifest` is
 * parallel to its first blocks after `leadingCount`. An OCR'd image is two
 * blocks of one entry, so files are the distinct entries in order.
 */
export function memberTurnAttachments(
  content: SendContent,
  manifest: readonly AttachmentManifestEntry[] | undefined,
  leadingCount: number,
  host: HostRuntimeSnapshot | undefined
): MemberTurnAttachments {
  if (!manifest?.length) return { kind: "none" }
  if (typeof content === "string" || leadingCount !== 0) return refuse("shape")
  if (content.length < manifest.length) return refuse("shape")
  // The request may be empty (a file sent on its own); nothing may follow it.
  const tail = content.slice(manifest.length)
  if (tail.length > 1 || (tail.length === 1 && tail[0]?.type !== "text")) return refuse("shape")
  if (!MEMBER_ATTACHMENT_UPLOAD_OPERATIONS.every((name) => host?.operations.includes(name)))
    return refuse("uploads-unavailable")

  const entries: AttachmentManifestEntry[] = []
  for (const entry of manifest) if (!entries.includes(entry)) entries.push(entry)
  const limits = host?.limits
  if (entries.length > (limits?.attachmentMaxPerMessage ?? COMPOSER_MAX_ATTACHMENTS))
    return refuse("too-many")
  const maxBytes = limits?.attachmentMaxBytes ?? COMPOSER_MAX_ATTACHMENT_BYTES
  const files: MemberTurnFile[] = []
  for (const entry of entries) {
    if (entry.kind === "video" || entry.video) return refuse("video")
    if (!entry.original) return refuse("no-original")
    const mediaType = entry.mediaType || entry.original.type
    if (
      !mediaType ||
      !isSupportedAttachmentDescriptor({ name: entry.filename, mediaType }) ||
      !acceptedBy(limits?.attachmentAcceptTypes, entry.filename, mediaType)
    )
      return refuse("type")
    if (entry.original.size === 0) return refuse("empty")
    if (entry.original.size > maxBytes) return refuse("too-large")
    files.push({ name: entry.filename, mediaType, original: entry.original })
  }
  return { kind: "files", files }
}

function refuse(reason: MemberAttachmentRefusal): MemberTurnAttachments {
  return { kind: "unsupported", reason }
}

/** An `accept` list (`image/*`, `application/pdf`, `.docx`) admits the file. */
function acceptedBy(accept: readonly string[] | undefined, name: string, mediaType: string) {
  if (!accept) return true
  const lowerName = name.toLowerCase()
  const lowerType = mediaType.toLowerCase()
  return accept.some((token) => {
    const rule = token.trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith(".")) return lowerName.endsWith(rule)
    if (rule.endsWith("/*")) return lowerType.startsWith(rule.slice(0, -1))
    return lowerType === rule
  })
}

/** An upload of a member's turn failed; the turn was not sent. */
export class MemberAttachmentUploadError extends Error {
  readonly code = "member_attachment_upload_failed"
  constructor(readonly failure: unknown) {
    super("member_attachment_upload_failed")
    this.name = "MemberAttachmentUploadError"
  }
}

/**
 * Upload a member turn's files into the session's partition, in order, and
 * return the refs its `message.enqueue` names.
 *
 * One at a time: the Host counts staged files per session and device, and the
 * order is the order the prompt lists them in. On a failure every upload this
 * call opened is aborted, so a resend starts from a clean staging area; one
 * the Host already held is left alone, because another queued message of the
 * session may still name it.
 */
export async function uploadMemberTurnAttachments(
  sessionId: string,
  files: readonly MemberTurnFile[],
  options: { call?: AttachmentUploadCall } = {}
): Promise<HostStateAttachmentRef[]> {
  const opened: string[] = []
  const refs: HostStateAttachmentRef[] = []
  try {
    for (const file of files) {
      const bytes = new Uint8Array(await file.original.arrayBuffer())
      const uploaded = await uploadSessionAttachment(
        sessionId,
        { name: file.name, mediaType: file.mediaType, bytes },
        {
          ...(options.call ? { call: options.call } : {}),
          onStarted: (upload) => {
            if (!upload.complete) opened.push(upload.uploadId)
          },
        }
      )
      refs.push({
        name: uploaded.name,
        mediaType: uploaded.mediaType,
        size: uploaded.size,
        hash: uploaded.hash,
        ref: uploaded.ref,
      })
    }
    return refs
  } catch (error) {
    await Promise.all(
      opened.map((uploadId) =>
        abortSessionAttachmentUpload(uploadId, options.call ? { call: options.call } : {})
      )
    )
    throw new MemberAttachmentUploadError(error)
  }
}
