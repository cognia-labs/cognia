"use client"

/**
 * The strip over a workflow compiled from a playbook (ADR-0254 §2). It says
 * where the graph comes from and why it cannot be edited, and offers the one
 * way to change it: detach a copy that no longer follows the playbook.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { LockIcon, Unlink2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { duplicateWorkflow } from "@/lib/db/workflows"
import type { VisualWorkflow } from "@/types/workflow/visual"

import { workflowEditorHref } from "./playbook-workflow-opener"

export function DerivedWorkflowBanner({
  workflow,
}: {
  workflow: Pick<VisualWorkflow, "id" | "derivedFrom">
}) {
  const t = useTranslations("workflows.playbook")
  const router = useRouter()
  const [detaching, setDetaching] = useState(false)
  if (!workflow.derivedFrom) return null

  const detach = async () => {
    setDetaching(true)
    try {
      const copy = await duplicateWorkflow(workflow.id)
      toast.success(t("detached", { name: copy.name }))
      router.push(workflowEditorHref(copy.id))
    } catch (error) {
      toast.error(
        t("detachFailed", { error: error instanceof Error ? error.message : String(error) })
      )
      setDetaching(false)
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm"
      data-testid="derived-workflow-banner"
      role="status"
    >
      <LockIcon className="size-3.5 text-muted-foreground" aria-hidden />
      <Badge variant="outline" className="h-5 text-[10px]">
        {t("badge")}
      </Badge>
      <span className="font-medium">{t("bannerTitle")}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {t("bannerBody", { skillId: workflow.derivedFrom.skillId })}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void detach()}
        disabled={detaching}
        data-testid="derived-workflow-detach"
      >
        <Unlink2Icon className="mr-1.5 size-3.5" />
        {t("detach")}
      </Button>
    </div>
  )
}
