"use client"

/**
 * Distinct plan-mode state banner above the composer (Claude Code parity: the
 * amber "plan mode" affordance is more than the tiny mode chip). Self-hides
 * outside plan mode. Pairs with the composer surface's amber tint.
 *
 * While the conversation has no open plan it also carries "Write a plan" —
 * hand-authoring is a plausible next step while planning, and an open plan
 * would be cancelled by a new one (one open plan per session), so the entry
 * leaves once a draft, approval or run owns the session.
 */

import { useTranslations } from "next-intl"
import { NotebookPenIcon } from "lucide-react"
import { WritePlanButton } from "@/components/agent/plan/write-plan-button"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { useShowKeyboardHints } from "@/hooks/ui/use-pointer"
import { useComposerPermissionMode } from "@/stores/chat"

import { useComposerSessionId } from "./composer/composer-session-context"

export function PlanModeBanner() {
  const t = useTranslations("chat.planMode")
  // The conversation whose composer this banner sits above, not the focused
  // one: rendered inside an unfocused split pane it announced plan mode for the
  // pane beside it, and hid it for its own.
  const sessionId = useComposerSessionId()
  const permissionMode = useComposerPermissionMode(sessionId)
  const openPlan = useSessionPlan(sessionId ?? undefined)
  // The chip names the Shift+Tab shortcut that leaves plan mode; without a
  // keyboard it is a key nobody can press.
  const showKeyboardHints = useShowKeyboardHints()
  if (permissionMode !== "plan") return null

  return (
    <div
      className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
      data-testid="plan-mode-banner"
    >
      <NotebookPenIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("banner")}</span>
      {sessionId && !openPlan ? (
        <WritePlanButton
          sessionId={sessionId}
          className="-my-0.5 shrink-0 text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-400"
        />
      ) : null}
      {showKeyboardHints ? (
        <kbd className="shrink-0 rounded border border-amber-500/40 px-1 font-mono text-[10px]">
          {t("hint")}
        </kbd>
      ) : null}
    </div>
  )
}
