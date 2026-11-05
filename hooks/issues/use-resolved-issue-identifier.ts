"use client"

/**
 * Resolve `/issues?identifier=MERC-12` to the issue it names (D24).
 *
 * Links built from text carry the printable identifier, never a row id, so
 * they can be drawn without a lookup; the page does the lookup once, here.
 * Identifiers are case-insensitive, like everywhere else they are typed.
 * Something that is not an identifier at all resolves to "missing" without a
 * read.
 */

import { useEffect, useState } from "react"

import { getIssueByIdentifier } from "@/lib/db/issues"
import { isCanonicalIssueIdentifier } from "@/lib/issues/identifier"

export type ResolvedIssueIdentifier =
  | { status: "none" }
  | { status: "loading" }
  | { status: "found"; issueId: string }
  | { status: "missing"; identifier: string }

const NONE: ResolvedIssueIdentifier = { status: "none" }
const LOADING: ResolvedIssueIdentifier = { status: "loading" }

type Lookup = (identifier: string) => Promise<{ id: string } | undefined>

export function useResolvedIssueIdentifier(
  identifier: string | undefined,
  lookup: Lookup = getIssueByIdentifier
): ResolvedIssueIdentifier {
  const [result, setResult] = useState<{ identifier: string; issueId?: string }>()
  const canonical = identifier?.trim().toUpperCase()

  useEffect(() => {
    if (!identifier || !canonical) return
    let live = true
    // Keep the previous answer when nothing changed, so a caller passing a
    // fresh `lookup` each render does not re-render forever.
    const settle = (issueId?: string) => {
      if (!live) return
      setResult((previous) =>
        previous?.identifier === identifier && previous.issueId === issueId
          ? previous
          : { identifier, ...(issueId ? { issueId } : {}) }
      )
    }
    const read = isCanonicalIssueIdentifier(canonical)
      ? lookup(canonical)
      : Promise.resolve(undefined)
    read.then(
      (issue) => settle(issue?.id),
      () => settle()
    )
    return () => {
      live = false
    }
  }, [identifier, canonical, lookup])

  if (!identifier || !canonical) return NONE
  if (result?.identifier !== identifier) return LOADING
  return result.issueId
    ? { status: "found", issueId: result.issueId }
    : { status: "missing", identifier: canonical }
}
