// The radar report's loading state, drawn in the report's shape: the
// history picker's row, then one block per section, so nothing moves when the
// report lands. It announces itself once, through the region.

"use client"

import { useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export interface RadarReportSkeletonProps {
  /** Placeholder report sections. */
  count?: number
  testId?: string
  className?: string
}

export function RadarReportSkeleton({ count = 3, testId, className }: RadarReportSkeletonProps) {
  const t = useTranslations("radar")
  return (
    <div
      data-testid={testId}
      data-skeleton="report"
      role="status"
      aria-busy="true"
      className={cn("mx-auto w-full max-w-3xl", className)}
    >
      <span className="sr-only">{t("panel.loading")}</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: count }, (_, i) => (
          <div key={i} data-skeleton-item className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  )
}
