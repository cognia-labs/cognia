import type { UIMessage } from "ai"

import { decodeDataUrl } from "@/lib/utils/image-bytes"
import { renderSafeInlineMarkdown } from "@/lib/export/html/safe-inline-markdown"
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

interface FilePart {
  type: "file"
  url?: string
  mediaType?: string
  filename?: string
}

interface SourceUrlPart {
  type: "source-url"
  url: string
  title?: string
}

interface SourceDocumentPart {
  type: "source-document"
  title?: string
  mediaType?: string
}

/** Build one ordered, portable projection for message copy and native sharing. */
export function buildMessageShareContent(message: UIMessage): MessageShareContent {
  // Rows only need availability until the user invokes an action. Preparing
  // HTML and decoding every screenshot into Files during a streaming render
  // duplicates megabytes of data even when nothing is ever copied or shared.
  const parts = stripPromptPreambleFromParts(message.parts)
  const hasContent = parts.some((part) =>
    part.type === "text"
      ? Boolean((part as { text?: string }).text) && videoAttachmentInfoOfPart(part) === null
      : part.type === "file" || part.type === "source-url" || part.type === "source-document"
  )
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

  // Copy and share hand over what the user wrote, not the context envelope the
  // composer put in front of it (`lib/chat/prompt-preamble.ts`).
  for (const part of parts) {
    if (part.type === "text") {
      // A video's description is the model's reading of it, not message text.
      if (videoAttachmentInfoOfPart(part) !== null) continue
      const text = (part as { text?: string }).text ?? ""
      if (text) {
        plainParts.push(text)
        nativeShareParts.push(text)
        htmlParts.push(
          `<div>${renderSafeInlineMarkdown(escapeHtml(text)).replace(/\n/g, "<br>")}</div>`
        )
      }
      continue
    }

    if (part.type === "file") {
      const file = part as FilePart
      const label = file.filename || file.mediaType || "file"
      const isImage = Boolean(file.mediaType?.startsWith("image/"))
      if (file.url) {
        const markdownPart = isImage
          ? `![${escapeMarkdownLabel(label)}](${file.url})`
          : `[${escapeMarkdownLabel(label)}](${file.url})`
        plainParts.push(markdownPart)
        nativeShareParts.push(isImage && file.url.startsWith("data:image/") ? label : markdownPart)
        if (isSafeShareUrl(file.url, isImage)) {
          htmlParts.push(
            isImage
              ? `<figure><img src="${escapeHtml(file.url)}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`
              : `<p><a href="${escapeHtml(file.url)}">${escapeHtml(label)}</a></p>`
          )
        } else {
          htmlParts.push(`<p>${escapeHtml(label)}</p>`)
        }

        if (isImage) {
          const decoded = tryDecodeDataUrl(file.url)
          if (decoded && typeof File !== "undefined") {
            imageIndex += 1
            shareFiles.push(
              new File(
                [decoded.bytes as BlobPart],
                imageFilename(file.filename, decoded.mimeType, imageIndex),
                {
                  type: decoded.mimeType,
                }
              )
            )
          }
        }
      } else {
        plainParts.push(label)
        nativeShareParts.push(label)
        htmlParts.push(`<p>${escapeHtml(label)}</p>`)
      }
      continue
    }

    if (part.type === "source-url") {
      const source = part as SourceUrlPart
      const label = source.title || source.url
      plainParts.push(`[${escapeMarkdownLabel(label)}](${source.url})`)
      nativeShareParts.push(`[${escapeMarkdownLabel(label)}](${source.url})`)
      htmlParts.push(
        isSafeShareUrl(source.url, false)
          ? `<p><a href="${escapeHtml(source.url)}">${escapeHtml(label)}</a></p>`
          : `<p>${escapeHtml(label)}</p>`
      )
      continue
    }

    if (part.type === "source-document") {
      const source = part as SourceDocumentPart
      const label = source.title || source.mediaType || "source"
      plainParts.push(label)
      nativeShareParts.push(label)
      htmlParts.push(`<p>${escapeHtml(label)}</p>`)
    }
  }

  const plainText = plainParts.join("\n\n")
  return {
    plainText,
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

function isSafeShareUrl(url: string, image: boolean): boolean {
  const lower = url.trim().toLowerCase()
  if (/^(https?:|mailto:|blob:)/.test(lower) || lower.startsWith("/") || lower.startsWith("#")) {
    return true
  }
  return image && lower.startsWith("data:image/")
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
