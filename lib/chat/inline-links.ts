/**
 * In-app references in plain chat text (D16, D23–D25).
 *
 * A subsystem whose objects have a printable reference (an issue's `MERC-12`)
 * registers its syntax here once at boot. Both sanitized Markdown pipelines
 * then turn matching text into a link to that object's in-app address
 * (`components/chat/markdown/rehype-inline-links.ts`), and `ChatLink` renders
 * it. The chat kernel never imports the subsystem itself: the registry is the
 * seam (ADR-0250 §14, G2), the same way plugin link matchers are.
 *
 * Matching is split in two on purpose. `pattern` is syntax and runs when a
 * message is parsed. `accepts` is the subsystem's current knowledge (whether
 * `MERC` is a project in this workspace) and runs on every render, so a link
 * appears or reverts to text when that knowledge changes without re-parsing
 * the message. A kind calls `notifyInlineLinksChanged` when it does.
 *
 * Addresses are always relative in-app paths, so a reference in text a third
 * party wrote can never point outside the app (D25).
 */

export interface InlineLinkKind {
  /** Stable id, carried on the generated link as `data-inline-link`. */
  id: string
  /** Global pattern for candidate references; each whole match is one candidate. */
  pattern: RegExp
  /** Whether a candidate the pattern found is a well-formed reference at all. */
  matches(text: string): boolean
  /** The candidate's in-app address: a relative path starting with `/`. */
  href(text: string): string
  /** The reference an address names, when it is one of this kind's. */
  parseHref(href: string): string | undefined
  /** Whether a candidate refers to something that exists right now. */
  accepts(text: string): boolean
}

export interface InlineLinkMatch {
  kind: InlineLinkKind
  text: string
  start: number
  end: number
}

const kinds = new Map<string, InlineLinkKind>()
const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Register a kind; the returned disposer removes exactly this registration. */
export function registerInlineLinkKind(kind: InlineLinkKind): () => void {
  if (!kind.pattern.global) throw new Error(`Inline link pattern "${kind.id}" must be global`)
  kinds.set(kind.id, kind)
  changed()
  return () => {
    if (kinds.get(kind.id) !== kind) return
    kinds.delete(kind.id)
    changed()
  }
}

export function getInlineLinkKind(id: string): InlineLinkKind | undefined {
  return kinds.get(id)
}

/** The kind whose address this is, with the reference it names. */
export function resolveInlineLinkHref(
  href: string
): { kind: InlineLinkKind; text: string } | undefined {
  for (const kind of kinds.values()) {
    const text = kind.parseHref(href)
    if (text !== undefined) return { kind, text }
  }
  return undefined
}

/**
 * Every well-formed candidate in `text`, in order. Where two kinds' matches
 * overlap, the earlier match wins, then the earlier registration.
 */
export function findInlineLinks(text: string): InlineLinkMatch[] {
  const found: InlineLinkMatch[] = []
  for (const kind of kinds.values()) {
    for (const match of text.matchAll(kind.pattern)) {
      const start = match.index ?? 0
      if (!kind.matches(match[0])) continue
      found.push({ kind, text: match[0], start, end: start + match[0].length })
    }
  }
  found.sort((a, b) => a.start - b.start)
  const kept: InlineLinkMatch[] = []
  for (const match of found) {
    const previous = kept.at(-1)
    if (previous && match.start < previous.end) continue
    kept.push(match)
  }
  return kept
}

/** A kind's knowledge changed: rendered links re-check `accepts`. */
export function notifyInlineLinksChanged(): void {
  changed()
}

export function subscribeInlineLinks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getInlineLinksRevision(): number {
  return revision
}
