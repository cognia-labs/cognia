import type { SendContent } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { HostRuntimeSnapshot } from "@/lib/runtime/operation-availability"
import type { AttachmentUploadCall } from "./attachment-upload-client"
import {
  MEMBER_ATTACHMENT_UPLOAD_OPERATIONS,
  MemberAttachmentUploadError,
  memberTurnAttachments,
  uploadMemberTurnAttachments,
} from "./member-turn-attachments"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

function blob(text: string, type: string): Blob {
  return new Blob([text], { type })
}

function host(overrides: Partial<HostRuntimeSnapshot> = {}): HostRuntimeSnapshot {
  return {
    compatible: true,
    operations: [...MEMBER_ATTACHMENT_UPLOAD_OPERATIONS, "host_state_submit"],
    grants: [],
    personPartition: true,
    ...overrides,
  }
}

const image: AttachmentManifestEntry = {
  filename: "shot.png",
  mediaType: "image/png",
  kind: "image",
  original: blob("png-bytes", "image/png"),
}
const pdf: AttachmentManifestEntry = {
  filename: "report.pdf",
  mediaType: "application/pdf",
  kind: "document",
  original: blob("%PDF-1.7", "application/pdf"),
}
const imageBlock = {
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
}

describe("memberTurnAttachments", () => {
  it("is none for a turn without attachments", () => {
    expect(memberTurnAttachments("hi", undefined, 0, host())).toEqual({ kind: "none" })
    expect(memberTurnAttachments("hi", [], 0, host())).toEqual({ kind: "none" })
  })

  it("takes the distinct files of an attachments-then-request turn, OCR blocks included", () => {
    const content: SendContent = [
      imageBlock,
      { type: "text", text: "ocr of the screenshot" },
      { type: "text", text: "extracted report" },
      { type: "text", text: "what changed?" },
    ]
    expect(memberTurnAttachments(content, [image, image, pdf], 0, host())).toEqual({
      kind: "files",
      files: [
        { name: "shot.png", mediaType: "image/png", original: image.original },
        { name: "report.pdf", mediaType: "application/pdf", original: pdf.original },
      ],
    })
  })

  it("takes a file sent with no text", () => {
    const result = memberTurnAttachments([imageBlock], [image], 0, host())
    expect(result.kind).toBe("files")
  })

  it("refuses content the intent cannot carry: leading lines, or anything after the request", () => {
    const content: SendContent = [imageBlock, { type: "text", text: "q" }]
    expect(memberTurnAttachments(content, [image], 1, host())).toEqual({
      kind: "unsupported",
      reason: "shape",
    })
    expect(
      memberTurnAttachments(
        [...content, { type: "text", text: "fetched link context" }],
        [image],
        0,
        host()
      )
    ).toEqual({ kind: "unsupported", reason: "shape" })
    expect(memberTurnAttachments("q", [image], 0, host())).toEqual({
      kind: "unsupported",
      reason: "shape",
    })
  })

  it("refuses when the Host does not take uploads", () => {
    const content: SendContent = [imageBlock, { type: "text", text: "q" }]
    expect(
      memberTurnAttachments(content, [image], 0, host({ operations: ["host_state_submit"] }))
    ).toEqual({ kind: "unsupported", reason: "uploads-unavailable" })
    expect(memberTurnAttachments(content, [image], 0, undefined)).toEqual({
      kind: "unsupported",
      reason: "uploads-unavailable",
    })
  })

  it("refuses a video, a file with no original, and a type or size the Host does not take", () => {
    const block = { type: "text" as const, text: "q" }
    const video: AttachmentManifestEntry = {
      filename: "clip.mp4",
      mediaType: "video/mp4",
      kind: "video",
      original: blob("v", "video/mp4"),
    }
    expect(memberTurnAttachments([imageBlock, block], [video], 0, host()).kind).toBe("unsupported")
    expect(memberTurnAttachments([imageBlock, block], [video], 0, host())).toMatchObject({
      reason: "video",
    })
    expect(
      memberTurnAttachments([imageBlock, block], [{ ...image, original: undefined }], 0, host())
    ).toMatchObject({ reason: "no-original" })
    expect(
      memberTurnAttachments(
        [{ type: "text", text: "doc" }, block],
        [pdf],
        0,
        host({ limits: { attachmentAcceptTypes: ["image/*"] } as HostRuntimeSnapshot["limits"] })
      )
    ).toMatchObject({ reason: "type" })
    expect(
      memberTurnAttachments(
        [imageBlock, block],
        [image],
        0,
        host({ limits: { attachmentMaxBytes: 3 } as HostRuntimeSnapshot["limits"] })
      )
    ).toMatchObject({ reason: "too-large" })
    expect(
      memberTurnAttachments(
        [imageBlock, { type: "text", text: "doc" }, block],
        [image, pdf],
        0,
        host({ limits: { attachmentMaxPerMessage: 1 } as HostRuntimeSnapshot["limits"] })
      )
    ).toMatchObject({ reason: "too-many" })
    expect(
      memberTurnAttachments(
        [imageBlock, block],
        [{ ...image, original: blob("", "image/png") }],
        0,
        host()
      )
    ).toMatchObject({ reason: "empty" })
  })

  it("matches accept tokens by extension, wildcard and exact type", () => {
    const limits = (accept: string[]) =>
      host({ limits: { attachmentAcceptTypes: accept } as HostRuntimeSnapshot["limits"] })
    const content: SendContent = [
      { type: "text", text: "doc" },
      { type: "text", text: "q" },
    ]
    expect(memberTurnAttachments(content, [pdf], 0, limits([".pdf"])).kind).toBe("files")
    expect(memberTurnAttachments(content, [pdf], 0, limits(["application/pdf"])).kind).toBe("files")
    expect(memberTurnAttachments(content, [pdf], 0, limits(["application/*"])).kind).toBe("files")
  })
})

function fakeHost(options: { failOn?: string; held?: string[] } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let next = 0
  const call: AttachmentUploadCall = async (name, args) => {
    calls.push({ name, args })
    if (name === options.failOn) throw new Error("attachment_too_many")
    switch (name) {
      case "session_attachment_upload_init": {
        next += 1
        const held = options.held?.includes(args.name as string) ?? false
        return {
          uploadId: `upl_${next}`,
          chunkSize: 1024,
          resumeOffset: held ? (args.size as number) : 0,
          complete: held,
          ref: held ? `cognia-upload:upl_${next}` : null,
        }
      }
      case "session_attachment_upload_chunk":
        return { receivedBytes: atob(args.dataBase64 as string).length, complete: false }
      case "session_attachment_upload_commit":
        return {
          ref: `cognia-upload:${args.uploadId as string}`,
          name: "renamed-by-host",
          mediaType: "image/jpeg",
          size: 9,
          hash: "a".repeat(64),
        }
      default:
        return null
    }
  }
  return { call, calls }
}

describe("uploadMemberTurnAttachments", () => {
  const files = [
    { name: "shot.png", mediaType: "image/png", original: blob("png-bytes", "image/png") },
    { name: "report.pdf", mediaType: "application/pdf", original: blob("%PDF", "application/pdf") },
  ]

  it("uploads in order and returns the refs the Host minted, with its corrections", async () => {
    const wire = fakeHost()
    const refs = await uploadMemberTurnAttachments("ses-1", files, { call: wire.call })

    expect(
      wire.calls.filter((c) => c.name === "session_attachment_upload_init").map((c) => c.args.name)
    ).toEqual(["shot.png", "report.pdf"])
    expect(refs).toEqual([
      {
        name: "renamed-by-host",
        mediaType: "image/jpeg",
        size: 9,
        hash: "a".repeat(64),
        ref: "cognia-upload:upl_1",
      },
      {
        name: "renamed-by-host",
        mediaType: "image/jpeg",
        size: 9,
        hash: "a".repeat(64),
        ref: "cognia-upload:upl_2",
      },
    ])
  })

  it("aborts only what it opened when an upload fails, and says the upload failed", async () => {
    const wire = fakeHost({ failOn: "session_attachment_upload_commit", held: ["report.pdf"] })
    const reversed = [files[1]!, files[0]!]

    await expect(
      uploadMemberTurnAttachments("ses-1", reversed, { call: wire.call })
    ).rejects.toBeInstanceOf(MemberAttachmentUploadError)
    // report.pdf was already held (another queued message may name it); only
    // the screenshot's fresh upload is dropped.
    expect(
      wire.calls.filter((c) => c.name === "session_attachment_upload_abort").map((c) => c.args)
    ).toEqual([{ uploadId: "upl_2" }])
  })
})
