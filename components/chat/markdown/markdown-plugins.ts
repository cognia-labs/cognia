/**
 * The remark/rehype steps and text preprocessing both chat Markdown engines
 * share (`MarkdownRenderer` and the Streamdown branches), plus the heading-id
 * registry that keeps fragment ids identical when a message is rendered as
 * more than one tree.
 *
 * Pure data and tree transforms only; `chat-markdown-config.ts` assembles them
 * into each engine's plugin lists.
 */

import { marked, type Token, type Tokens } from "marked"
import type { Options as ReactMarkdownOptions } from "react-markdown"

/** One remark/rehype plugin entry, as both engines accept it. */
export type MarkdownPluggable = NonNullable<ReactMarkdownOptions["rehypePlugins"]>[number]

interface MarkdownAstNode {
  type?: string
  tagName?: string
  value?: string
  lang?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
}

/** Flatten external nesting before recursive Markdown-to-HTML conversion and React commit. */
export function limitUntrustedMarkdownDepth(tree: unknown, source: string): void {
  if (!tree || typeof tree !== "object") return
  const root = tree as MarkdownAstNode
  const pending = [{ node: root, depth: 0 }]
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > 64) {
      // Preserve the complete source as literal text, rather than truncating
      // a quote or leaving a deeply nested DOM that cannot be safely unmounted.
      root.children = [{ type: "code", lang: "text", value: source }]
      return
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 })
  }
}

export function remarkLimitUntrustedDepth() {
  return (tree: unknown, file: { toString(): string }) =>
    limitUntrustedMarkdownDepth(tree, file.toString())
}

function markdownNodeText(node: MarkdownAstNode): string {
  if (node.type === "text") return node.value ?? ""
  return node.children?.map(markdownNodeText).join("") ?? ""
}

/** GitHub-style slug: lower case, letters/numbers/`-`/`_`, spaces to dashes. */
export function markdownHeadingSlug(value: string): string {
  return value
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * What one tree's headings consumed from the id namespace, in order: an id the
 * author wrote (`{ id }`) or a slug base the transform numbered (`{ base }`).
 * Replaying it rebuilds the dedupe state a later tree continues from.
 */
export type HeadingIdEntry = { id: string } | { base: string }

function replay(entries: readonly HeadingIdEntry[], seen: Map<string, number>): void {
  for (const entry of entries) {
    if ("id" in entry) seen.set(entry.id, Math.max(seen.get(entry.id) ?? 0, 1))
    else seen.set(entry.base, (seen.get(entry.base) ?? 0) + 1)
  }
}

/**
 * Add GitHub-style ids to Markdown headings so fragment links work without a
 * runtime dependency: `setup`, then `setup-1` for the second "Setup". Runs
 * after sanitization. `seen` carries the numbering of trees rendered before
 * this one (see {@link createHeadingIdRegistry}); the entries this tree
 * consumed are returned so the next tree can continue from them.
 */
export function addMarkdownHeadingIds(
  tree: unknown,
  seen: Map<string, number> = new Map()
): HeadingIdEntry[] {
  const entries: HeadingIdEntry[] = []
  if (!tree || typeof tree !== "object") return entries

  const visit = (node: MarkdownAstNode) => {
    if (/^h[1-6]$/.test(node.tagName ?? "")) {
      const existingId = typeof node.properties?.id === "string" ? node.properties.id : undefined
      if (existingId) {
        entries.push({ id: existingId })
        seen.set(existingId, Math.max(seen.get(existingId) ?? 0, 1))
      } else {
        const base = markdownHeadingSlug(markdownNodeText(node))
        if (base) {
          const duplicateIndex = seen.get(base) ?? 0
          node.properties = {
            ...node.properties,
            id: duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`,
          }
          entries.push({ base })
          seen.set(base, duplicateIndex + 1)
        }
      }
    }
    node.children?.forEach(visit)
  }

  visit(tree as MarkdownAstNode)
  return entries
}

/** Dedupe state carried into a tree: each id or slug base, and how often it was used. */
export type HeadingIdSeed = ReadonlyArray<readonly [string, number]>

export interface HeadingIdOptions {
  /** What the trees before this one consumed (see {@link headingIdSeed}). */
  seed?: HeadingIdSeed
}

/**
 * The heading-id step. Alone it numbers one tree from scratch; as
 * `[rehypeMarkdownHeadingIds, { seed }]` it continues the numbering of the
 * trees before it. The seed travels as an option, not in a closure, because
 * Streamdown caches a processor per plugin name and JSON options: plugins that
 * differ only by closure would share the first one's processor.
 */
export function rehypeMarkdownHeadingIds(options?: HeadingIdOptions) {
  return (tree: unknown) => {
    addMarkdownHeadingIds(tree, new Map(options?.seed ?? []))
  }
}

/** A name `@Name` may refer to, with the colour its mention is drawn in. */
export interface MarkdownMention {
  name: string
  color?: string
}

export interface MentionOptions {
  mentions: readonly MarkdownMention[]
}

/** Elements whose text is literal: a mention inside stays text. */
const MENTION_OPAQUE = new Set(["a", "code", "pre", "kbd", "script", "style"])

const mentionMatchers = new WeakMap<
  readonly MarkdownMention[],
  { pattern: RegExp; byName: Map<string, MarkdownMention> } | null
>()

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function mentionMatcher(mentions: readonly MarkdownMention[]) {
  if (mentionMatchers.has(mentions)) return mentionMatchers.get(mentions)!
  const names = mentions
    .map((mention) => mention.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const matcher = names.length
    ? {
        // Longest name first, so `@Alice Smith` wins over `@Alice`. A name
        // ends at a non-letter, which `\b` cannot tell for a CJK name.
        pattern: new RegExp(`@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "giu"),
        byName: new Map(mentions.map((mention) => [mention.name.toLowerCase(), mention])),
      }
    : null
  mentionMatchers.set(mentions, matcher)
  return matcher
}

/**
 * Draw `@Name` for each known name as a mention chip inside the Markdown
 * instead of replacing the Markdown with plain text. Runs after sanitization
 * (it adds its own `span`s); text inside links, code and keyboard keys stays
 * literal.
 */
export function rehypeMarkdownMentions(options?: MentionOptions) {
  return (tree: unknown) => {
    const matcher = options && mentionMatcher(options.mentions)
    if (!matcher || !tree || typeof tree !== "object") return
    const visit = (node: MarkdownAstNode) => {
      if (!node.children) return
      const next: MarkdownAstNode[] = []
      for (const child of node.children) {
        if (child.type === "element") {
          if (!MENTION_OPAQUE.has(child.tagName ?? "")) visit(child)
          next.push(child)
          continue
        }
        if (child.type !== "text" || !child.value) {
          next.push(child)
          continue
        }
        const text = child.value
        let last = 0
        for (const match of text.matchAll(matcher.pattern)) {
          const index = match.index ?? 0
          if (index > last) next.push({ type: "text", value: text.slice(last, index) })
          const mention = matcher.byName.get(match[1].toLowerCase())
          next.push({
            type: "element",
            tagName: "span",
            properties: {
              className: ["chat-mention", "rounded", "bg-muted", "px-1", "font-medium"],
              dataMention: mention?.name ?? match[1],
              ...(mention?.color ? { style: `color: ${mention.color}` } : {}),
            },
            children: [{ type: "text", value: match[0] }],
          })
          last = index + match[0].length
        }
        if (last === 0) next.push(child)
        else if (last < text.length) next.push({ type: "text", value: text.slice(last) })
      }
      node.children = next
    }
    visit(tree as MarkdownAstNode)
  }
}

/**
 * Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$` so remark-math (and
 * Streamdown's math plugin) accept the wider variety of LaTeX delimiters
 * models emit. Only complete pairs are rewritten: an open `\[` still streaming
 * stays text until its `\]` arrives.
 */
export function preprocessLatex(content: string): string {
  let processed = content
  if (processed.includes("\\[")) {
    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_match, eq) => `$$${eq}$$`)
  }
  if (processed.includes("\\(")) {
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, eq) => `$${eq}$`)
  }
  return processed
}

const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, dec: string, hex: string, named: string) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return NAMED_ENTITIES[named.toLowerCase()] ?? match
  })
}

function inlineTokenText(tokens: readonly Token[] | undefined): string {
  let text = ""
  for (const token of tokens ?? []) {
    // A tag carries no text; the text between tags is its own token.
    if (token.type === "html") continue
    const nested = (token as { tokens?: Token[] }).tokens
    text += nested?.length
      ? inlineTokenText(nested)
      : decodeEntities((token as { text?: string }).text ?? "")
  }
  return text
}

const HTML_HEADING_ID = /<h[1-6]\b[^>]*?\bid\s*=\s*["']([^"']+)["']/gi
/** `rehype-sanitize`'s default `clobberPrefix`, which the chat schema keeps. */
const HTML_ID_CLOBBER_PREFIX = "user-content-"

/**
 * The heading entries a Markdown source would produce, read from `marked`'s
 * tokens instead of the rendered tree. The fallback for a tree that has not
 * rendered yet (see {@link createHeadingIdRegistry}); it matches the rendered
 * text for headings built from text, emphasis, code spans, links, escapes,
 * entities, inline HTML and math, and the dedupe numbering only depends on
 * the slug.
 */
export function headingEntriesFromSource(source: string): HeadingIdEntry[] {
  const entries: HeadingIdEntry[] = []
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "html") {
        // Raw heading tags keep the id their author wrote, under the sanitize
        // schema's clobber prefix; a raw heading without one gets no id.
        for (const match of (token as Tokens.HTML).text.matchAll(HTML_HEADING_ID)) {
          entries.push({ id: `${HTML_ID_CLOBBER_PREFIX}${match[1]}` })
        }
        continue
      }
      if (token.type === "heading") {
        const base = markdownHeadingSlug(inlineTokenText((token as Tokens.Heading).tokens))
        if (base) entries.push({ base })
        continue
      }
      const nested =
        (token as { tokens?: Token[] }).tokens ??
        (token as { items?: Array<{ tokens: Token[] }> }).items?.flatMap((item) => item.tokens)
      if (nested && token.type !== "paragraph") walk(nested)
    }
  }
  walk(marked.lexer(source))
  return entries
}

/**
 * The seed tree `index` starts from: what the trees before it consumed, read
 * from their sources.
 */
export function headingIdSeed(
  sources: readonly string[],
  index: number,
  entriesOf: (source: string) => readonly HeadingIdEntry[] = headingEntriesFromSource
): HeadingIdSeed {
  const seen = new Map<string, number>()
  for (let earlier = 0; earlier < index; earlier++) {
    const source = sources[earlier]
    if (source !== undefined) replay(entriesOf(source), seen)
  }
  return [...seen]
}

/**
 * Heading ids across the trees one message is drawn as: Streamdown's blocks
 * while a reply streams, or the lazily mounted sections of a long finished
 * reply. Each tree's heading step is seeded with what the trees before it
 * consumed, read from their sources through {@link headingEntriesFromSource},
 * so ids match what one tree would have produced (`setup`, `setup-1`) in any
 * mount order.
 */
export interface HeadingIdRegistry {
  /**
   * `plugins` plus tree `index`'s seeded heading step. Stable for the same
   * list and seed, so a block whose earlier blocks did not change keeps its
   * props.
   */
  withPlugins<T extends readonly MarkdownPluggable[]>(
    plugins: T,
    index: number
  ): MarkdownPluggable[]
  /** Register every tree's source. */
  setSources(sources: readonly string[]): void
  /**
   * Register one tree's source, for trees that only see their own (a
   * Streamdown block). Idempotent; call before {@link withPlugins}.
   */
  setSource(index: number, source: string): void
}

export function createHeadingIdRegistry(): HeadingIdRegistry {
  let sources: string[] = []
  const parsed = new Map<string, HeadingIdEntry[]>()
  const lists = new WeakMap<object, Map<string, MarkdownPluggable[]>>()

  const entriesOf = (source: string): readonly HeadingIdEntry[] => {
    let entries = parsed.get(source)
    if (!entries) {
      entries = headingEntriesFromSource(source)
      parsed.set(source, entries)
    }
    return entries
  }

  return {
    withPlugins(list, index) {
      const seed = headingIdSeed(sources, index, entriesOf)
      const key = JSON.stringify(seed)
      let bySeed = lists.get(list)
      if (!bySeed) {
        bySeed = new Map()
        lists.set(list, bySeed)
      }
      let combined = bySeed.get(key)
      if (!combined) {
        combined = [
          ...list,
          seed.length ? [rehypeMarkdownHeadingIds, { seed }] : rehypeMarkdownHeadingIds,
        ]
        bySeed.set(key, combined)
      }
      return combined
    },
    setSources(next) {
      sources = [...next]
    },
    setSource(index, source) {
      sources[index] = source
    },
  }
}
