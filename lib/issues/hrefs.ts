/**
 * Where an issue lives on screen.
 *
 * `/issues` reads `?id=` through `useSearchParams()` (see `app/issues/page.tsx`)
 * and seeds the console's selection from it, so this is the one link that
 * lands on an issue with it selected. Query param, never a `[id]` route: the
 * app is a static export consumed by Tauri and Capacitor. Kept free of any
 * Dexie import so a chip on the Squad board can link back without dragging
 * the issue tables into its bundle.
 */

import type { IssueSourceKind } from "@/types/issues/unified"
import { isCanonicalIssueIdentifier } from "./identifier"

export const ISSUES_HREF = "/issues"

/**
 * Which source the `?id=` names. Absent means a local issue, which is what
 * every link built before other sources could be deep-linked meant. Needed
 * because ids alone are ambiguous across sources: a shared (collaboration)
 * issue and a local one both read `iss_…`.
 */
export const ISSUE_SOURCE_PARAM = "source"

/**
 * Narrows the console to one assignee. The value is the board's `actorKey`
 * (`agent:<characterId>`, `human:<id>`), the same key the assignee filter
 * stores, so the link and the filter chip it produces cannot disagree.
 */
export const ISSUE_ASSIGNEE_PARAM = "assignee"

/** The console filtered to the issues (and agent tasks) assigned to one agent. */
export function agentIssuesHref(agentId: string): string {
  return `${ISSUES_HREF}?${ISSUE_ASSIGNEE_PARAM}=${encodeURIComponent(`agent:${agentId}`)}`
}

/** Deep link to an issue, selected. `source` defaults to a local issue. */
export function issueHref(issueId: string, source: IssueSourceKind = "local"): string {
  const base = `${ISSUES_HREF}?id=${encodeURIComponent(issueId)}`
  return source === "local" ? base : `${base}&${ISSUE_SOURCE_PARAM}=${encodeURIComponent(source)}`
}

/**
 * Names a local issue by its printable identifier (`MERC-12`). Text that
 * mentions an identifier links here (D24); the page resolves it to the issue,
 * so the link needs no lookup when it is drawn.
 */
export const ISSUE_IDENTIFIER_PARAM = "identifier"

export function issueIdentifierHref(identifier: string): string {
  return `${ISSUES_HREF}?${ISSUE_IDENTIFIER_PARAM}=${encodeURIComponent(identifier)}`
}

/**
 * The identifier an address names, only when it is exactly what
 * `issueIdentifierHref` builds. Anything else (extra parameters, another
 * path, a malformed identifier) is not one, so an untrusted sender cannot
 * smuggle a different in-app target through this shape.
 */
export function parseIssueIdentifierHref(href: string): string | undefined {
  const prefix = `${ISSUES_HREF}?${ISSUE_IDENTIFIER_PARAM}=`
  if (!href.startsWith(prefix)) return undefined
  const value = href.slice(prefix.length)
  return isCanonicalIssueIdentifier(value) ? value : undefined
}
