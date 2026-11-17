/**
 * Message Markdown as standalone HTML, for the places a message leaves the app
 * as markup: the HTML export, a shared conversation page and the rich
 * clipboard (D11). Block Markdown renders as blocks (headings, lists, tables,
 * fenced code), so a shared answer reads the way it did in the chat.
 *
 * The output is safe to drop into a page another person opens: raw HTML in the
 * source is shown as text, never parsed, and a link or image keeps its target
 * only for a scheme that cannot run script. Pure and synchronous.
 */

import { Marked, type Tokens } from "marked"

const LINK_SCHEMES = /^(https?:|mailto:)/i
const IMAGE_SCHEMES = /^(https?:|data:image\/)/i

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    // Block and inline raw HTML both arrive here: shown, never interpreted.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens)
      if (!LINK_SCHEMES.test(href.trim())) return label
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
      return `<a href="${escapeHtml(href.trim())}"${titleAttr} target="_blank" rel="noreferrer">${label}</a>`
    },
    image({ href, text, title }: Tokens.Image) {
      if (!IMAGE_SCHEMES.test(href.trim())) return escapeHtml(text)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
      return `<img src="${escapeHtml(href.trim())}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy">`
    },
  },
})

/** Render Markdown to HTML with raw HTML escaped and unsafe targets dropped. */
export function markdownToSafeHtml(markdown: string): string {
  return (marked.parse(markdown) as string).trim()
}
