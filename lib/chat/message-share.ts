import type { UIMessage } from "ai"

import { decodeDataUrl } from "@/lib/utils/image-bytes"
import { isShareablePart, partShare } from "@/lib/chat/parts/descriptors"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { videoAttachmentInfoOfPart } from "@/lib/chat/attachments/video/attachment-info"
import { shareContent, type ShareOutcome } from "@/lib/capacitor/share"

export interface MessageShareContent {
  plainText: string
  nativeShareText: string
  html: string
  shareFiles: File[]
  hasContent: boolean
}

/** Copy rich message content when supported, with a plain-text fallback. */
export async function writeMessageToClipboard(content: MessageShareContent): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  if (!clipboard) return false

  if (typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([content.plainText], { type: "text/plain" }),
          "text/html": new Blob([content.html], { type: "text/html" }),
        }),
      ])
      return true
    } catch {
      // Some WebViews expose Clipboard.write but reject text/html. Continue
      // through the portable text path instead of surfacing a false success.
    }
  }

  if (typeof clipboard.writeText !== "function") return false
  try {
    await clipboard.writeText(content.plainText)
    return true
  } catch {
    return false
  }
}

/**
 * What the user typed: the text parts, without the context envelope the
 * composer put in front of them and without a video's description, which is
 * what the model read, not what the user wrote. Edit, quote, resend and read
 * aloud hand this over, on every shell. Reasoning is never part of it.
 */
export function messageTypedText(message: UIMessage): string {
  return stripPromptPreambleFromParts(message.parts)
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .filter((p) => videoAttachmentInfoOfPart(p) === null)
    .map((p) => p.text)
    .join("\n\n")
}

/**
 * Copy a message: rich (HTML beside plain text) when it carries more than its
 * typed text, such as images or sources, plain otherwise. `writePlain` is the
 * shell's own text clipboard, used for plain copies and when the rich write is
 * not available. `rich` says which one landed, for the "copied with media"
 * feedback.
 */
export async function copyMessageContent(
  content: MessageShareContent,
  typedText: string,
  writePlain: (text: string) => Promise<boolean>
): Promise<{ ok: boolean; rich: boolean }> {
  if (!content.hasContent) return { ok: false, rich: false }
  if (content.plainText !== typedText && (await writeMessageToClipboard(content))) {
    return { ok: true, rich: true }
  }
  return { ok: await writePlain(content.plainText), rich: false }
}

export type MessageShareResult =
  { kind: "shared" | "cancelled" | "copied" } | { kind: "failed"; message?: string }

/**
 * Share a message through the shell's share sheet, images included. Where
 * there is no share surface for it, hand it over through the clipboard instead
 * (`copied`), so the caller never reports a share that did not happen.
 */
export async function shareMessageContent(
  content: MessageShareContent,
  options: {
    dialogTitle?: string
    share?: (opts: Parameters<typeof shareContent>[0]) => Promise<ShareOutcome>
  } = {}
): Promise<MessageShareResult> {
  if (!content.hasContent) return { kind: "failed" }
  const files = content.shareFiles
  const text = files.length > 0 ? content.nativeShareText : content.plainText
  const out = await (options.share ?? shareContent)({
    ...(text.trim() ? { text } : {}),
    files,
    ...(options.dialogTitle ? { dialogTitle: options.dialogTitle } : {}),
  })
  if (out.kind === "shared" || out.kind === "cancelled") return { kind: out.kind }
  if (out.kind === "error") return { kind: "failed", message: out.message }
  return (await writeMessageToClipboard(content)) ? { kind: "copied" } : { kind: "failed" }
}

/** Build one ordered, portable projection for message copy and native sharing. */
export function buildMessageShareContent(message: UIMessage): MessageShareContent {
  // Rows only need availability until the user invokes an action. Preparing
  // HTML and decoding every screenshot into Files during a streaming render
  // duplicates megabytes of data even when nothing is ever copied or shared.
  // Copy and share hand over what the user wrote, not the context envelope the
  // composer put in front of it (`lib/chat/prompt-preamble.ts`).
  const parts = stripPromptPreambleFromParts(message.parts)
  const hasContent = parts.some(isShareablePart)
  let prepared: MessageShareContent | undefined
  const prepare = () => (prepared ??= materializeMessageShareContent(parts))
  return {
    hasContent,
    get plainText() {
      return prepare().plainText
    },
    get nativeShareText() {
      return prepare().nativeShareText
    },
    get html() {
      return prepare().html
    },
    get shareFiles() {
      return prepare().shareFiles
    },
  }
}

function materializeMessageShareContent(
  parts: readonly UIMessage["parts"][number][]
): MessageShareContent {
  const plainParts: string[] = []
  const nativeShareParts: string[] = []
  const htmlParts: string[] = []
  const shareFiles: File[] = []
  let imageIndex = 0

  // What each part hands over is its descriptor's (`lib/chat/parts/descriptors.ts`).
  for (const part of parts) {
    const share = partShare(part)
    if (!share) continue
    plainParts.push(share.plain)
    nativeShareParts.push(share.native)
    htmlParts.push(share.html)
    if (share.image && typeof File !== "undefined") {
      const decoded = tryDecodeDataUrl(share.image.url)
      if (decoded) {
        imageIndex += 1
        shareFiles.push(
          new File(
            [decoded.bytes as BlobPart],
            imageFilename(share.image.filename, decoded.mimeType, imageIndex),
            { type: decoded.mimeType }
          )
        )
      }
    }
  }

  return {
    plainText: plainParts.join("\n\n"),
    nativeShareText: nativeShareParts.join("\n\n"),
    html: htmlParts.join("\n"),
    shareFiles,
    hasContent: plainParts.length > 0,
  }
}

function tryDecodeDataUrl(url: string): ReturnType<typeof decodeDataUrl> {
  try {
    return decodeDataUrl(url)
  } catch {
    return null
  }
}

function imageFilename(filename: string | undefined, mediaType: string, index: number): string {
  if (filename?.trim()) return filename
  const extension = mediaType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "img"
  return `image-${index}.${extension}`
}
