"use client"

/**
 * The mobile editor's runs: the top bar's Run, and the editor store's
 * "Run from here" / "Run only this node" requests that the long-press sheet
 * and the Inspector's Run step make (WF-10, WF-15).
 *
 * Those requests used to be consumed only by the desktop canvas, which the
 * mobile editor never mounts, so on a phone they closed the sheet and did
 * nothing. This hook consumes them the way the desktop canvas does, and runs
 * every one as a draft preview through `startEditorPreviewRun`: on the Host's
 * saved copy when the phone is paired, locally on a standalone phone. A run
 * that started opens its run detail.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { impact } from "@/lib/capacitor/haptics"
import type { EditorStore } from "@/lib/workflow/editor/store"
import {
  startEditorPreviewRun,
  type EditorPreviewRequest,
} from "@/lib/workflow/remote/editor-preview-run"
import { workflowRunHref } from "@/lib/workflow/runs/run-href"

export interface UseMobilePreviewRunOptions {
  /** Blocking diagnostics stopped the run; show where they are. */
  onBlocked?: () => void
}

export interface MobilePreviewRun {
  running: boolean
  run: (request: EditorPreviewRequest) => Promise<void>
}

export function useMobilePreviewRun(
  store: EditorStore,
  options: UseMobilePreviewRunOptions = {}
): MobilePreviewRun {
  const t = useTranslations("mobile.workflow.editor")
  const tDiag = useTranslations("workflows.diagnostics")
  const router = useRouter()
  const [running, setRunning] = useState(false)
  // The state drives the button; the ref refuses a second run started in the
  // same tick, before React has re-rendered with `running`.
  const runningRef = useRef(false)
  const onBlockedRef = useRef(options.onBlocked)
  useEffect(() => {
    onBlockedRef.current = options.onBlocked
  }, [options.onBlocked])

  const run = useCallback(
    async (request: EditorPreviewRequest) => {
      if (runningRef.current) return
      runningRef.current = true
      setRunning(true)
      try {
        const outcome = await startEditorPreviewRun(store, request)
        switch (outcome.status) {
          case "blocked":
            toast.error(tDiag("blockedRunTitle"), {
              description: tDiag("blockedRunSummary", { count: outcome.errorCount }),
            })
            store.getState().requestProblemsPanel()
            onBlockedRef.current?.()
            return
          case "host-pending":
            toast.message(t("previewHostPending"))
            return
          case "refused":
            toast.error(
              outcome.reason === "host_write_refused"
                ? t("previewSaveRefused", { detail: outcome.detail })
                : t("previewRefused", { detail: outcome.detail })
            )
            return
          case "started":
            if (outcome.warningCount > 0) {
              toast.warning(tDiag("runWithWarnings", { count: outcome.warningCount }))
            }
            void impact("light")
            toast.success(t("previewStarted"))
            router.push(workflowRunHref(outcome.workflowId, outcome.runId))
            return
        }
      } catch (err) {
        toast.error(t("previewFailed", { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [store, router, t, tDiag]
  )

  // Each request is cleared before it runs, so the slot is free for the next
  // one; a request made while a run is starting is dropped, as on desktop.
  const requestedRunFromStepId = store((s) => s.requestedRunFromStepId)
  useEffect(() => {
    if (!requestedRunFromStepId) return
    store.getState().clearRequestedRunFromStep()
    void run({ mode: "from-step", stepId: requestedRunFromStepId })
  }, [requestedRunFromStepId, store, run])

  const requestedRunSingleStepId = store((s) => s.requestedRunSingleStepId)
  useEffect(() => {
    if (!requestedRunSingleStepId) return
    store.getState().clearRequestedRunSingleStep()
    void run({ mode: "single-step", stepId: requestedRunSingleStepId })
  }, [requestedRunSingleStepId, store, run])

  return { running, run }
}
