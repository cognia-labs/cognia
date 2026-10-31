"use client"

/**
 * One health-assessment row for the session insights view: a localized label,
 * a level badge, a score bar tinted by severity, and the localized reasoning
 * sentence. Reused once per {@link Assessment}. Presentational — props in only.
 */

import { useTranslations } from "next-intl"
import { Progress } from "@/components/ui/progress"

import { cn } from "@/lib/utils"
import type { Assessment, AssessmentLevel } from "@/lib/analysis/session-report"

const LEVEL_TEXT: Record<AssessmentLevel, string> = {
  critical: "text-red-500",
  warning: "text-amber-500",
  info: "text-sky-500",
  healthy: "text-emerald-500",
}

const LEVEL_FILL: Record<AssessmentLevel, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
  healthy: "bg-emerald-500",
}

export function AssessmentCard({ assessment }: { assessment: Assessment }) {
  const t = useTranslations("sessionInsights")
  const { id, level, score, reasoningKey, params } = assessment
  return (
    <div className="space-y-1.5 rounded-md border p-2.5" data-testid={`assessment-${id}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{t(`assessments.label.${id}`)}</span>
        <span className={cn("font-medium", LEVEL_TEXT[level])} data-testid="assessment-level">
          {t(`assessments.level.${level}`)}
        </span>
      </div>
      <Progress
        className="h-1.5 w-full overflow-hidden rounded bg-muted"
        value={Math.round(score * 100)}
        aria-label={t(`assessments.label.${id}`)}
        data-testid="assessment-score"
        indicatorClassName={cn("rounded", LEVEL_FILL[level])}
      />
      <p className="text-[11px] text-muted-foreground">
        {t(`assessments.reasoning.${reasoningKey}`, params)}
      </p>
    </div>
  )
}
