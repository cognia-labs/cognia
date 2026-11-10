"use client"

// Visual storage breakdown — a stacked bar with per-category colors plus a
// collapsible detail list with optional clear-button. Adapted from
// D:\Project\Cognia\components\settings\data\storage-breakdown.tsx. The
// per-category icon + colour tables live in `storage-category-visuals.ts` so
// the mobile `/me/storage` page draws the same segments.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { getCleanupCategoryAvailability } from "@/lib/storage"
import type { StorageCategory, StorageCategoryInfo } from "@/lib/storage"
import { CATEGORY_COLORS, CATEGORY_ICONS, OTHER_SEGMENT_COLOR } from "./storage-category-visuals"

interface StorageBreakdownProps {
  categories: StorageCategoryInfo[]
  totalSize: number
  formatBytes: (bytes: number) => string
  onClearCategory?: (category: StorageCategory) => void
  isClearing?: boolean
  className?: string
}

export function StorageBreakdown({
  categories,
  totalSize,
  formatBytes,
  onClearCategory,
  isClearing = false,
  className,
}: StorageBreakdownProps) {
  const t = useTranslations("settings.data.breakdown")

  const sortedCategories = useMemo(() => {
    return [...categories].filter((c) => c.totalSize > 0).sort((a, b) => b.totalSize - a.totalSize)
  }, [categories])

  const indexedCategories = sortedCategories.filter((category) => category.category !== "vector")
  const topCategories = indexedCategories.slice(0, 5)
  const otherCategories = indexedCategories.slice(5)
  const otherTotal = otherCategories.reduce<number>((sum, c) => sum + c.totalSize, 0)
  const denominator = Math.max(
    totalSize,
    indexedCategories.reduce((s, c) => s + c.totalSize, 0)
  )

  if (sortedCategories.length === 0) {
    return (
      <div className={cn("py-4 text-center text-sm text-muted-foreground", className)}>
        {t("noData")}
      </div>
    )
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {topCategories.map((cat) => {
          const percentage =
            denominator > 0 ? Math.min(100, (cat.totalSize / denominator) * 100) : 0
          return (
            <Tooltip key={cat.category}>
              <TooltipTrigger asChild>
                <div
                  className={cn(CATEGORY_COLORS[cat.category], "h-full transition-all")}
                  style={{ width: `${percentage}%` }}
                  data-testid={`breakdown-bar-${cat.category}`}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{t(`categories.${cat.category}`)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(cat.totalSize)} ({percentage.toFixed(1)}%)
                </p>
              </TooltipContent>
            </Tooltip>
          )
        })}
        {otherTotal > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(OTHER_SEGMENT_COLOR, "h-full transition-all")}
                style={{ width: `${(otherTotal / denominator) * 100}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{t("other")}</p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(otherTotal)} ({((otherTotal / denominator) * 100).toFixed(1)}%)
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
        {topCategories.map((cat) => {
          const Icon = CATEGORY_ICONS[cat.category]
          return (
            <div key={cat.category} className="flex min-w-0 items-center gap-1">
              <div className={cn("size-2 shrink-0 rounded-full", CATEGORY_COLORS[cat.category])} />
              <Icon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{t(`categories.${cat.category}`)}</span>
            </div>
          )
        })}
        {otherTotal > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <div className={cn("size-2 shrink-0 rounded-full", OTHER_SEGMENT_COLOR)} />
            <span className="truncate">{t("other")}</span>
          </div>
        )}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-xs text-muted-foreground hover:text-foreground">
          <span>{t("viewDetails")}</span>
          <ChevronDownIcon className="size-3" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1.5 pt-2">
          {sortedCategories.map((cat) => {
            const Icon = CATEGORY_ICONS[cat.category]
            const availability = getCleanupCategoryAvailability(cat.category, cat.sources)
            const percentage =
              denominator > 0 ? Math.min(100, (cat.totalSize / denominator) * 100) : 0
            return (
              <div
                key={cat.category}
                className="flex items-center gap-2 rounded-md border p-1.5 text-xs"
              >
                <div
                  className={cn(
                    "flex size-6 items-center justify-center rounded",
                    CATEGORY_COLORS[cat.category]
                  )}
                >
                  <Icon className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium">{t(`categories.${cat.category}`)}</span>
                    <span className="ml-2 text-muted-foreground">
                      {formatBytes(cat.totalSize)} · {cat.itemCount}
                    </span>
                  </div>
                  {cat.category === "vector" ? (
                    <p className="mt-0.5 text-muted-foreground">{t("nativeStore")}</p>
                  ) : (
                    <Progress value={percentage} className="mt-0.5 h-1" />
                  )}
                  {(availability === "host-managed" || availability === "local-only") && (
                    <p className="mt-0.5 text-muted-foreground">
                      {t(availability === "host-managed" ? "hostManaged" : "hostManagedLocalOnly")}
                    </p>
                  )}
                </div>
                {onClearCategory &&
                  cat.totalSize > 0 &&
                  (availability === "cleanable" || availability === "local-only") && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          onClick={() => onClearCategory(cat.category)}
                          disabled={isClearing}
                          aria-label={t("clearCategory")}
                        >
                          <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("clearCategory")}</TooltipContent>
                    </Tooltip>
                  )}
              </div>
            )
          })}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
