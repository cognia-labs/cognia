"use client"

import RouteBody from "./route-body"

/**
 * `/issues` — the total issue board.
 *
 * Deep links use `?id=` read through `useSearchParams()` inside `<Suspense>`,
 * not a dynamic `[id]` route: this app is a Next.js static export consumed by
 * Tauri and Capacitor, so `[id]` segments do not exist at runtime. Same idiom
 * as `app/memory/page.tsx` and `app/goals/page.tsx`.
 *
 * `?identifier=MERC-12` is what text links to (D24). It is resolved here, so
 * both the desktop console and the phone body open the issue selected; an
 * identifier no issue has opens the board and says so.
 */

import { Suspense, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useResolvedIssueIdentifier } from "@/hooks/issues/use-resolved-issue-identifier"
import {
  ISSUE_ASSIGNEE_PARAM,
  ISSUE_IDENTIFIER_PARAM,
  ISSUE_SOURCE_PARAM,
} from "@/lib/issues/hrefs"
import { ISSUE_SOURCE_KINDS, type IssueSourceKind } from "@/types/issues/unified"

/** The `?source=` of a deep link, when it names a source this build knows. */
function readSelectedSource(value: string | null): IssueSourceKind | undefined {
  return ISSUE_SOURCE_KINDS.find((kind) => kind === value)
}

function IssuesPageInner() {
  const t = useTranslations("issues")
  const params = useSearchParams()
  const selectedId = params.get("id") ?? undefined
  // An explicit `?id=` wins; the identifier is only read without one.
  const resolved = useResolvedIssueIdentifier(
    selectedId ? undefined : (params.get(ISSUE_IDENTIFIER_PARAM) ?? undefined)
  )
  const missing = resolved.status === "missing" ? resolved.identifier : undefined
  useEffect(() => {
    if (missing) toast.error(t("identifier.notFound", { identifier: missing }))
  }, [missing, t])

  // Wait for the lookup rather than open the board unselected and jump.
  if (resolved.status === "loading") return null
  const initialSelectedId = resolved.status === "found" ? resolved.issueId : selectedId
  const initialSelectedSource =
    resolved.status === "found" ? "local" : readSelectedSource(params.get(ISSUE_SOURCE_PARAM))

  return (
    <RouteBody
      initialSelectedId={initialSelectedId}
      initialSelectedSource={initialSelectedSource}
      initialProjectId={params.get("project") ?? undefined}
      initialCycleId={params.get("cycle") ?? undefined}
      initialAssignee={params.get(ISSUE_ASSIGNEE_PARAM) ?? undefined}
    />
  )
}

export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesPageInner />
    </Suspense>
  )
}
