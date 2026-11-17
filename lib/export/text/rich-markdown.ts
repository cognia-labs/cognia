// Markdown, JSON and plain-text export for a single chat session. Each part is
// written by its descriptor (`lib/chat/parts/descriptors.ts`), so a part type
// renders the same way in every exporter and none is dropped silently; every
// label comes from the caller's resolved `ExportLabels`.

import { projectRemoteDocumentData } from "@/lib/chat/attachments/remote-document"
import type { UIMessage } from "ai"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

import {
  markdownFence,
  renderPartMarkdown,
  renderPartText,
  type PartRenderContext,
} from "@/lib/chat/parts/descriptors"
import { escapeHtml } from "@/lib/chat/parts/markdown-html"
import {
  promptPreambleInnerText,
  promptPreambleOfParts,
  stripPromptPreambleFromParts,
} from "@/lib/chat/prompt-preamble"
import type { ExportLabels } from "@/lib/export/labels"

export interface RichExportData {
  session: ChatSession
  messages: StoredMessage[]
  exportedAt: Date
  labels: ExportLabels
  includeMetadata?: boolean
  includeTokens?: boolean
}

/** Convert a session + its messages to a portable Markdown string. */
export function exportToRichMarkdown(data: RichExportData): string {
  const {
    session,
    messages,
    exportedAt,
    labels,
    includeMetadata = true,
    includeTokens = false,
  } = data
  const lines: string[] = []
  const ctx: PartRenderContext = { labels: labels.parts }

  lines.push(`# ${session.title}`)
  lines.push("")

  if (includeMetadata) {
    lines.push(`## ${labels.conversationInfo}`)
    lines.push("")
    lines.push(`| ${labels.property} | ${labels.value} |`)
    lines.push("|----------|-------|")
    lines.push(`| **${labels.date}** | ${new Date(session.createdAt).toLocaleDateString()} |`)
    lines.push(`| **${labels.kind}** | ${session.kind ?? "direct"} |`)
    if (session.model) lines.push(`| **${labels.model}** | ${session.model} |`)
    if (session.workingDir) {
      lines.push(`| **${labels.workingDir}** | \`${session.workingDir}\` |`)
    }
    lines.push(`| **${labels.messages}** | ${messages.length} |`)
    lines.push(`| **${labels.exported}** | ${exportedAt.toLocaleString()} |`)
    lines.push("")
  }

  if (session.systemPrompt) {
    const fence = markdownFence(session.systemPrompt)
    lines.push(`## ${labels.systemPrompt}`)
    lines.push("")
    lines.push(fence)
    lines.push(session.systemPrompt)
    lines.push(fence)
    lines.push("")
  }

  lines.push(`## ${labels.conversation}`)
  lines.push("")
  lines.push("---")
  lines.push("")

  for (const message of messages) {
    lines.push(`### ${roleHeading(message.role, labels)}`)
    lines.push(`<sub>${new Date(message.createdAt).toLocaleString()}</sub>`)
    lines.push("")

    if (includeTokens && message.metadata?.usage) {
      lines.push(`<details><summary>${escapeHtml(labels.tokenUsage)}</summary>`)
      lines.push("")
      lines.push("```json")
      lines.push(JSON.stringify(message.metadata.usage, null, 2))
      lines.push("```")
      lines.push("")
      lines.push("</details>")
      lines.push("")
    }

    lines.push(renderMessageParts(message.parts, labels, ctx))
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  lines.push("")
  lines.push(`*${labels.footer(exportedAt.toLocaleString())}*`)
  return lines.join("\n")
}

/** A pretty-printed JSON snapshot — full lossless dump of session + messages. */
export function exportToRichJSON(
  data: Pick<RichExportData, "session" | "messages" | "exportedAt">
): string {
  const { session: fullSession, messages, exportedAt } = data
  // The Host binding names this device's Host registry; it never leaves it.
  const { hostBinding: _hostBinding, ...session } = fullSession
  return JSON.stringify(
    {
      version: "cognia-next-1.0",
      exportedAt: exportedAt.toISOString(),
      session,
      messages: projectRemoteDocumentData(messages, true),
      statistics: {
        totalMessages: messages.length,
        userMessages: messages.filter((m) => m.role === "user").length,
        assistantMessages: messages.filter((m) => m.role === "assistant").length,
        hasToolCalls: messages.some((m) =>
          m.parts.some((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool")
        ),
      },
    },
    null,
    2
  )
}

/** Plain-text export: every part's plain representation, no formatting. */
export function exportToPlainText(data: RichExportData): string {
  const { session, messages, labels } = data
  const ctx: PartRenderContext = { labels: labels.parts }
  const lines: string[] = [session.title, ""]
  for (const message of messages) {
    lines.push(`[${labels.role(message.role)}] ${new Date(message.createdAt).toLocaleString()}`)
    if (promptPreambleOfParts(message.parts)) lines.push(labels.attachedContextOmitted)
    for (const part of stripPromptPreambleFromParts(message.parts)) {
      const text = renderPartText(part, ctx)
      if (text) lines.push(text)
    }
    lines.push("")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------

const ROLE_ICONS: Record<string, string> = { user: "👤", assistant: "🤖", system: "⚙️" }

function roleHeading(role: string, labels: ExportLabels): string {
  const icon = ROLE_ICONS[role]
  return icon ? `${icon} **${labels.role(role)}**` : `**${labels.role(role)}**`
}

function renderMessageParts(
  parts: UIMessage["parts"],
  labels: ExportLabels,
  ctx: PartRenderContext
): string {
  const out: string[] = []
  // What the composer attached to a turn is kept, folded, rather than printed
  // as though the user had typed it.
  const preamble = promptPreambleOfParts(parts)
  if (preamble) {
    const inner = promptPreambleInnerText(preamble)
    const fence = markdownFence(inner)
    out.push(
      [
        `<details><summary>📎 ${escapeHtml(labels.attachedContext)}</summary>`,
        "",
        fence,
        inner,
        fence,
        "",
        "</details>",
      ].join("\n")
    )
  }
  for (const part of stripPromptPreambleFromParts(parts)) {
    out.push(renderPartMarkdown(part, ctx))
  }
  return out.filter(Boolean).join("\n\n")
}
