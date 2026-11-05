"use client"

/**
 * Plain text with its in-app references linked (D23): the same references,
 * addresses and rule as chat Markdown (`lib/chat/inline-links.ts`), for text
 * that is never parsed as Markdown — issue descriptions and comments, commit
 * messages, a quoted IM reply.
 *
 * A reference is a link only while its kind `accepts` it (an issue key that
 * exists in this workspace); the component follows the registry, so links
 * appear and revert as that changes. Whitespace is the caller's: this renders
 * text runs and links inline, nothing else.
 */

import Link from "next/link"
import { Fragment, useSyncExternalStore } from "react"

import {
  findInlineLinks,
  getInlineLinksRevision,
  subscribeInlineLinks,
} from "@/lib/chat/inline-links"
import { cn } from "@/lib/utils"

export interface InlineLinkedTextProps {
  text: string
  linkClassName?: string
}

export function InlineLinkedText({ text, linkClassName }: InlineLinkedTextProps) {
  // The registry's change signal: `accepts` reads live state, so re-render.
  useSyncExternalStore(subscribeInlineLinks, getInlineLinksRevision, getInlineLinksRevision)
  const matches = findInlineLinks(text).filter((match) => match.kind.accepts(match.text))
  if (matches.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start))
    parts.push(
      <Link
        key={`${match.start}:${match.text}`}
        href={match.kind.href(match.text)}
        data-inline-link={match.kind.id}
        className={cn("text-primary font-medium underline-offset-2 hover:underline", linkClassName)}
      >
        {match.text}
      </Link>
    )
    cursor = match.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? <Fragment key={`t${index}`}>{part}</Fragment> : part
      )}
    </>
  )
}
