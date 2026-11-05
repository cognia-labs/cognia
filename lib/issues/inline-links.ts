/**
 * Issue identifiers in chat text (D16, D23–D25).
 *
 * Registers `MERC-12` with the chat's inline-link seam
 * (`lib/chat/inline-links.ts`), so both Markdown pipelines link it to
 * `/issues?identifier=MERC-12`. A candidate is a link only while its project
 * key exists in the workspace on screen (D24); this follows that workspace's
 * keys and tells the chat when they change, so drawn messages re-check
 * without being parsed again.
 *
 * The chat kernel cannot import the issues module (ADR-0250 §14, G2); the
 * issue tracker's initializer installs this instead.
 */

import { notifyInlineLinksChanged, registerInlineLinkKind } from "@/lib/chat/inline-links"
import { issueIdentifierHref, parseIssueIdentifierHref } from "./hrefs"
import {
  ISSUE_IDENTIFIER_TEXT_PATTERN,
  isCanonicalIssueIdentifier,
  parseIssueIdentifier,
} from "./identifier"
import { issueProjectKeysStore, type IssueProjectKeysStore } from "./project-keys"

export const ISSUE_INLINE_LINK_KIND = "issue"

/** The workspace on screen, and a way to hear that it changed. */
export interface IssueInlineLinkWorkspace {
  current(): string | null
  subscribe(listener: () => void): () => void
}

export function installIssueInlineLinks(
  workspace: IssueInlineLinkWorkspace,
  storeFor: (projectId: string | null) => IssueProjectKeysStore = issueProjectKeysStore
): () => void {
  let projectId = workspace.current()
  let store = storeFor(projectId)
  let stopKeys = store.subscribe(notifyInlineLinksChanged)

  const unregister = registerInlineLinkKind({
    id: ISSUE_INLINE_LINK_KIND,
    pattern: ISSUE_IDENTIFIER_TEXT_PATTERN,
    matches: isCanonicalIssueIdentifier,
    href: issueIdentifierHref,
    parseHref: parseIssueIdentifierHref,
    accepts: (text) => {
      const parsed = parseIssueIdentifier(text)
      return parsed !== undefined && store.getSnapshot().has(parsed.projectKey)
    },
  })

  const stopWorkspace = workspace.subscribe(() => {
    const next = workspace.current()
    if (next === projectId) return
    projectId = next
    stopKeys()
    store = storeFor(projectId)
    stopKeys = store.subscribe(notifyInlineLinksChanged)
    notifyInlineLinksChanged()
  })

  return () => {
    stopWorkspace()
    stopKeys()
    unregister()
  }
}
