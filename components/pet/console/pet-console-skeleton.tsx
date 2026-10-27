// Loading placeholders for the /pet console, drawn in the shape of what they
// stand for.
//
// The console used to say "Waking up your pet…" in the top-left corner and
// then jump into a header, a rail and a two-column pane; tabs with their own
// live queries rendered their empty state first ("No characters yet",
// greyed-out achievements) and then the real rows. Each placeholder here
// keeps the final layout's geometry, so nothing moves when the data lands,
// and announces itself once, politely, through the region rather than per
// block (the `Skeleton` contract).

"use client"

import { useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

function LoadingStatus({ label }: { label: string }) {
  return <span className="sr-only">{label}</span>
}

/** The whole console while the profile loads: header band, nav row, Home. */
export function PetConsoleSkeleton() {
  const t = useTranslations("pet")
  return (
    <div
      data-testid="pet-console-loading"
      role="status"
      aria-busy="true"
      className="flex h-full min-h-0 flex-col"
    >
      <LoadingStatus label={t("console.loading")} />
      <div className="shrink-0 border-b border-border/70">
        <div className="flex min-h-[var(--chrome-h-tall)] items-center gap-2.5 px-3 py-2 md:px-4">
          <Skeleton className="size-9 rounded-xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
          <Skeleton className="size-8 md:w-40" />
          <Skeleton className="size-8 md:w-36" />
        </div>
        <div
          data-testid="pet-console-loading-nav"
          className="flex min-h-[var(--chrome-h)] items-center gap-1.5 border-t border-border/55 px-3 py-1.5 md:px-4"
        >
          {/* One per place: Home, Chat, Shop, Collection, Activity. */}
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} data-skeleton-tab className="h-7 w-20 shrink-0" />
          ))}
        </div>
      </div>
      <div className="@container/pet-pane min-w-0 px-4 py-5 md:px-6 md:py-6">
        <PetHomeSkeleton />
      </div>
    </div>
  )
}

/** Home's two columns: pet + vitals, then next step + actions + backpack. */
function PetHomeSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 @3xl/pet-pane:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-4">
        <Skeleton className="h-48 w-full rounded-xl" />
        <div className="flex w-full flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-2.5 w-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-4 w-20" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}

export interface PetTabSkeletonProps {
  /** Which list shape to stand in for. */
  variant?: "list" | "grid" | "report"
  /** Placeholder rows (list) or tiles (grid). */
  count?: number
  testId?: string
  className?: string
}

/**
 * One console tab's own loading state, shaped like its rows or tiles. Each
 * row, tile or report section carries `data-skeleton-item`, so `count` can be
 * checked without leaning on the classes that draw it.
 */
export function PetTabSkeleton({
  variant = "list",
  count = 6,
  testId,
  className,
}: PetTabSkeletonProps) {
  const t = useTranslations("pet")
  return (
    <div
      data-testid={testId}
      data-skeleton={variant}
      role="status"
      aria-busy="true"
      className={cn("mx-auto w-full max-w-3xl", className)}
    >
      <LoadingStatus label={t("console.tabLoading")} />
      {variant === "grid" ? (
        <div className="grid grid-cols-3 gap-3 @sm/pet-pane:grid-cols-4 @lg/pet-pane:grid-cols-6">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} data-skeleton-item className="flex flex-col items-center gap-1.5 p-2">
              <Skeleton className="size-14" />
              <Skeleton className="h-2.5 w-12" />
            </div>
          ))}
        </div>
      ) : variant === "report" ? (
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
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} data-skeleton-item className="flex items-center gap-3 py-3">
              <Skeleton className="size-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
              <Skeleton className="h-8 w-16 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
