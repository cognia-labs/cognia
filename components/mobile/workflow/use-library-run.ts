"use client"

/**
 * The phone library's Run — the list's Run button, its swipe action, the
 * pinned cards and the row actions sheet all start a run through here, so
 * they say the same thing about it (WF-10).
 *
 * `runWorkflowFromLibrary` decides what a Run is on this phone (queued to the
 * paired Host, or run here on a standalone phone); this hook only turns its
 * outcome into the toast and, for a run that started here, a way to open it.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { impact } from "@/lib/capacitor/haptics"
import { runWorkflowFromLibrary, type LibraryRunOutcome } from "@/lib/workflow/remote/library-run"
import { workflowRunHref } from "@/lib/workflow/runs/run-href"
import type { VisualWorkflow } from "@/types/workflow/visual"

export type LibraryRunTarget = Pick<VisualWorkflow, "id" | "name" | "published">

export function useLibraryRun(): (workflow: LibraryRunTarget) => Promise<LibraryRunOutcome | null> {
  const t = useTranslations("mobile.workflow.libraryRun")
  const router = useRouter()
  return useCallback(
    async (workflow: LibraryRunTarget) => {
      const name = workflow.name
      try {
        const outcome = await runWorkflowFromLibrary(workflow)
        switch (outcome.status) {
          case "queued":
            void impact("light")
            toast.success(t("queued", { name }))
            break
          case "already-queued":
            // A run still waiting for the Host is not joined by a second one:
            // each tap used to queue another, and all of them fired on reconnect.
            toast.message(t("alreadyQueued", { name }))
            break
          case "not-published":
            toast.warning(t("notPublished", { name }))
            break
          case "started": {
            void impact("light")
            const href = workflowRunHref(outcome.workflowId, outcome.runId)
            toast.success(t("started", { name }), {
              action: { label: t("openRun"), onClick: () => router.push(href) },
            })
            break
          }
          case "handed-off":
            toast.success(t("handedOff", { name }))
            break
          case "refused":
            toast.error(t("refused", { name, detail: outcome.detail }))
            break
        }
        return outcome
      } catch (err) {
        toast.error(t("failed", { message: err instanceof Error ? err.message : String(err) }))
        return null
      }
    },
    [router, t]
  )
}
