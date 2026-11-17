// Self-contained HTML export. Inlines all styles + a tiny client-side script
// for collapsible sections; no external network requests at view time.

import type { UIMessage } from "ai"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { THEMES, type ThemeId, type ThemeTokens } from "./syntax-themes"
import { getStylePreset } from "./style-presets"
import { buildWallpaperBackdropCss } from "./theme-wallpaper"
import { renderPartHtml, type PartRenderContext } from "@/lib/chat/parts/descriptors"
import { escapeHtml } from "@/lib/chat/parts/markdown-html"
import type { ExportLabels } from "@/lib/export/labels"
import {
  promptPreambleInnerText,
  promptPreambleOfParts,
  stripPromptPreambleFromParts,
} from "@/lib/chat/prompt-preamble"

export interface BeautifulHtmlOptions {
  session: ChatSession
  messages: StoredMessage[]
  exportedAt: Date
  labels: ExportLabels
  theme?: ThemeId
  /** Inline custom theme tokens — overrides `theme` when provided. */
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  /** Show <details> blocks for tool calls / reasoning. Default true. */
  expandDetails?: boolean
  /**
   * Inlined theme wallpaper data-URL. When present, a photo backdrop (with a
   * legibility scrim) is laid behind the export. Resolved by the caller via
   * `resolveThemeWallpaper` so this module stays pure/sync.
   */
  wallpaperDataUrl?: string
}

export function exportToBeautifulHtml(options: BeautifulHtmlOptions): string {
  const {
    session,
    messages,
    exportedAt,
    labels,
    theme = "light",
    customTheme,
    includeMetadata = true,
    includeTimestamps = true,
    expandDetails = true,
    wallpaperDataUrl,
  } = options
  const tokens = customTheme ?? THEMES[theme]
  const preset = getStylePreset(theme)
  const banner = preset?.bannerText
    ? `<div class="preset-banner">${escapeHtml(preset.bannerText)}</div>\n`
    : ""
  const footerTag = preset?.footerText ? ` · ${escapeHtml(preset.footerText)}` : ""
  // Wallpaper backdrop is appended LAST so its transparent-body rule wins over
  // the base `body{background:${t.bg}}` while the preset chrome layers on top.
  const wallpaperCss = wallpaperDataUrl ? buildWallpaperBackdropCss(wallpaperDataUrl, tokens) : ""

  return `<!DOCTYPE html>
<html lang="${escapeHtml(labels.locale)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(session.title)}</title>
<style>${stylesheet(tokens)}${preset ? preset.css(tokens) : ""}${wallpaperCss}</style>
</head>
<body>
<main class="container">
${banner}${renderHeader(session, exportedAt, includeMetadata, labels)}
<section class="conversation">
${messages.map((m) => renderMessage(m, { includeTimestamps, expandDetails, labels })).join("\n")}
</section>
<footer class="exported">${escapeHtml(labels.footer(exportedAt.toLocaleString()))}${footerTag}</footer>
</main>
</body>
</html>`
}

// ---------------------------------------------------------------------------

function renderHeader(
  session: ChatSession,
  exportedAt: Date,
  includeMetadata: boolean,
  labels: ExportLabels
): string {
  if (!includeMetadata) {
    return `<header><h1>${escapeHtml(session.title)}</h1></header>`
  }
  return `<header>
  <h1>${escapeHtml(session.title)}</h1>
  <dl class="meta">
    <dt>${escapeHtml(labels.date)}</dt><dd>${escapeHtml(new Date(session.createdAt).toLocaleDateString())}</dd>
    ${session.model ? `<dt>${escapeHtml(labels.model)}</dt><dd>${escapeHtml(session.model)}</dd>` : ""}
    ${session.kind ? `<dt>${escapeHtml(labels.kind)}</dt><dd>${escapeHtml(session.kind)}</dd>` : ""}
    <dt>${escapeHtml(labels.exported)}</dt><dd>${escapeHtml(exportedAt.toLocaleString())}</dd>
  </dl>
  ${session.systemPrompt ? `<details><summary>${escapeHtml(labels.systemPrompt)}</summary><pre>${escapeHtml(session.systemPrompt)}</pre></details>` : ""}
</header>`
}

const ROLE_ICONS: Record<string, string> = { user: "👤", assistant: "🤖", system: "⚙️" }

function renderMessage(
  message: StoredMessage,
  opts: { includeTimestamps: boolean; expandDetails: boolean; labels: ExportLabels }
): string {
  const role = message.role
  const ts = opts.includeTimestamps
    ? `<time>${escapeHtml(new Date(message.createdAt).toLocaleString())}</time>`
    : ""
  const icon = ROLE_ICONS[role]
  const roleText = icon ? `${icon} ${opts.labels.role(role)}` : opts.labels.role(role)
  const ctx: PartRenderContext = { labels: opts.labels.parts, expandDetails: opts.expandDetails }
  return `<article class="message message-${escapeHtml(role)}">
  <header>
    <span class="role">${escapeHtml(roleText)}</span>
    ${ts}
  </header>
  <div class="parts">
    ${renderAttachedContext(message.parts, opts.expandDetails, opts.labels)}${stripPromptPreambleFromParts(
      message.parts
    )
      .map((p) => renderPartHtml(p, ctx))
      .filter(Boolean)
      .join("\n")}
  </div>
</article>`
}

/** What the composer attached to a turn, folded — not printed as the user's words. */
function renderAttachedContext(
  parts: UIMessage["parts"],
  expandDetails: boolean,
  labels: ExportLabels
): string {
  const preamble = promptPreambleOfParts(parts)
  if (!preamble) return ""
  return `<details ${expandDetails ? "open" : ""} class="attached-context">
      <summary>📎 ${escapeHtml(labels.attachedContext)}</summary>
      <pre>${escapeHtml(promptPreambleInnerText(preamble))}</pre>
    </details>\n`
}

function stylesheet(t: ThemeTokens): string {
  return `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: ${t.bg}; color: ${t.text}; line-height: 1.6; }
.container { max-width: 920px; margin: 0 auto; padding: 32px 24px 80px; }
header h1 { margin: 0 0 8px; font-size: 28px; color: ${t.accent}; }
header dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0 0; font-size: 13px; color: ${t.muted}; }
header dl.meta dt { font-weight: 600; }
header dl.meta dd { margin: 0; }
header details summary { cursor: pointer; margin: 12px 0 6px; color: ${t.muted}; font-size: 13px; }
header details pre { background: ${t.codeBg}; color: ${t.codeText}; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
.conversation { margin-top: 24px; }
.message { background: ${t.surface}; border: 1px solid ${t.border}; border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
.message-user { background: ${t.userBg}; }
.message-assistant { background: ${t.assistantBg}; }
.message > header { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 13px; }
.message .role { font-weight: 600; color: ${t.accent}; }
.message time { color: ${t.muted}; }
.parts > * { margin: 6px 0; }
.text, .commentary, .part-card { overflow-wrap: anywhere; }
.text > :first-child, .part-card > :first-child, .commentary > :first-child { margin-top: 0; }
.text > :last-child, .part-card > :last-child, .commentary > :last-child { margin-bottom: 0; }
.text a, .part-card a, .sources a, .commentary a { color: ${t.accent}; }
.text table { border-collapse: collapse; margin: 8px 0; }
.text th, .text td { border: 1px solid ${t.border}; padding: 4px 8px; text-align: left; }
.text blockquote, .commentary { margin: 8px 0; padding-left: 12px; border-left: 3px solid ${t.border}; color: ${t.muted}; }
.text :not(pre) > code { background: ${t.codeBg}; color: ${t.codeText}; padding: 1px 4px; border-radius: 4px; font-size: 0.9em; }
.text img { max-width: 100%; }
.part-card, .sources { background: ${t.detailBg}; border: 1px solid ${t.border}; border-radius: 6px; padding: 8px 12px; }
.part-card-title { margin: 0; font-weight: 500; }
.part-card-title + * { margin-top: 6px; }
.part-not-exported .part-card-title, .part-a2ui .part-card-title, .part-withheld .part-card-title, .sources .note { color: ${t.muted}; font-style: italic; }
.sources ul { margin: 6px 0 0; padding-left: 20px; }
.image { margin: 10px 0; }
.image img { display: block; max-width: 100%; max-height: 720px; border-radius: 8px; object-fit: contain; }
.image figcaption { margin-top: 4px; color: ${t.muted}; font-size: 12px; }
pre { background: ${t.codeBg}; color: ${t.codeText}; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.45; }
details.tool, details.reasoning { background: ${t.detailBg}; border: 1px solid ${t.border}; border-radius: 6px; padding: 8px 12px; }
details summary { cursor: pointer; font-weight: 500; }
details summary .state { color: ${t.muted}; font-weight: 400; margin-left: 6px; }
details h4 { margin: 8px 0 4px; font-size: 13px; }
details .error { color: #dc2626; margin: 6px 0 0; }
.file, .source { font-size: 14px; color: ${t.accent}; }
.exported { margin-top: 32px; text-align: center; color: ${t.muted}; font-size: 12px; }
@media (max-width: 600px) { .container { padding: 16px; } header h1 { font-size: 22px; } }
`
}
