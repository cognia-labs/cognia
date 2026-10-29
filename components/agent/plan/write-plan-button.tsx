"use client"

/**
 * "Write a plan" — hand-author a plan (`PlanSource` "manual") for a session.
 * One entry, two hosts: the plan-mode banner above the composer, and the
 * Tasks panel's empty state. Both open the same {@link PlanComposerDialog}.
 *
 * The session's agent is read when the dialog opens, so the created plan keeps
 * the same avatar continuity as a captured one without every host having to
 * thread the session record through.
 */

import { useState } from "react"
import { PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { getSession } from "@/lib/db/sessions"
import { cn } from "@/lib/utils"
import { PlanComposerDialog } from "./plan-composer-dialog"

export interface WritePlanButtonProps {
  sessionId: string
  className?: string
  variant?: "ghost" | "outline"
}

export function WritePlanButton({ sessionId, className, variant = "ghost" }: WritePlanButtonProps) {
  const t = useTranslations("plan.composer")
  const [open, setOpen] = useState(false)
  const [characterId, setCharacterId] = useState<string | undefined>(undefined)

  const openDialog = async () => {
    const session = await getSession(sessionId).catch(() => undefined)
    setCharacterId(session?.characterId ?? undefined)
    setOpen(true)
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={variant}
        className={cn("h-6 gap-1 px-2 text-[11px]", className)}
        onClick={() => void openDialog()}
        data-testid="plan-composer-open"
      >
        <PlusIcon className="size-3" aria-hidden />
        {t("openLabel")}
      </Button>
      <PlanComposerDialog
        sessionId={sessionId}
        {...(characterId ? { characterId } : {})}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}
