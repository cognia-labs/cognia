/**
 * Turn registered in-app references in chat text into links
 * (`lib/chat/inline-links.ts`).
 *
 * Runs after sanitization in both Markdown pipelines, so the links it adds are
 * the app's own and keep their `data-inline-*` marks. Text inside an existing
 * link, inline code or a code block is left alone: a reference there is
 * either already a link or literal code. Each generated link carries its
 * kind and reference, and `ChatLink` decides on render whether it is a link
 * (`accepts`) or plain text again.
 */

import { findInlineLinks } from "@/lib/chat/inline-links"

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIPPED = new Set(["a", "code", "pre", "kbd", "samp", "script", "style", "textarea"])

function linkify(text: string): HastNode[] | undefined {
  const matches = findInlineLinks(text)
  if (matches.length === 0) return undefined
  const nodes: HastNode[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) nodes.push({ type: "text", value: text.slice(cursor, match.start) })
    nodes.push({
      type: "element",
      tagName: "a",
      properties: {
        href: match.kind.href(match.text),
        dataInlineLink: match.kind.id,
        dataInlineRef: match.text,
      },
      children: [{ type: "text", value: match.text }],
    })
    cursor = match.end
  }
  if (cursor < text.length) nodes.push({ type: "text", value: text.slice(cursor) })
  return nodes
}

function visit(node: HastNode): void {
  if (!node.children) return
  if (node.type === "element" && SKIPPED.has(node.tagName ?? "")) return
  const next: HastNode[] = []
  let changed = false
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const replaced = linkify(child.value)
      if (replaced) {
        next.push(...replaced)
        changed = true
        continue
      }
    } else {
      visit(child)
    }
    next.push(child)
  }
  if (changed) node.children = next
}

export function rehypeInlineLinks() {
  return (tree: unknown) => visit(tree as HastNode)
}
