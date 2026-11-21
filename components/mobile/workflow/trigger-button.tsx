"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlayIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { useLibraryRun, type LibraryRunTarget } from "./use-library-run"

export interface TriggerButtonProps {
  /** The synced library row; its `published` decides what Run can do. */
  workflow: LibraryRunTarget
  /** Optional className applied to the button. */
  className?: string
}

/**
 * Mobile workflow Run button (Wave 3.1).
 *
 * Runs the published workflow through `useLibraryRun`: queued to the paired
 * Host, which answers with the run or a refusal, or run here on a standalone
 * phone. A workflow that is not published is not queued, and a run already
 * waiting for the Host is not joined by a second one.
 */
export function TriggerButton({ workflow, className }: TriggerButtonProps) {
  const t = useTranslations("mobile.workflow")
  const runFromLibrary = useLibraryRun()
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      await runFromLibrary(workflow)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={busy}
      size="sm"
      // Mobile touch target floor (iOS HIG 44px) — `min-h-11` wins over the
      // `size="sm"` height without changing the desktop visual weight.
      className={cn("min-h-11", className)}
      data-testid={`workflow-trigger-${workflow.id}`}
    >
      <PlayIcon className="size-3.5" aria-hidden="true" />
      <span className="ml-1">{t("runButton")}</span>
    </Button>
  )
}
