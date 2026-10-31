"use client"

/**
 * The quota fill bar, shared by `WindowGaugeCard` (Overview / Usage grids) and
 * `MeterRow` (Codex + OpenCode panels and the desktop status-bar popover).
 *
 * These were two copies of the same markup with different transitions —
 * `duration-500` here, Tailwind's ~150ms default there — so the same "quota bar
 * fills in" affordance animated at two speeds depending on which provider you
 * were looking at. One component means they can't drift again.
 */

import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

import type { LimitsMeterStatus } from "@/types/subscription"

const STATUS_BAR: Record<LimitsMeterStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-destructive",
  exceeded: "bg-destructive",
  unknown: "bg-muted-foreground",
}

export interface QuotaBarProps {
  /** Clamped 0-100, or null when the meter has no reading yet. */
  pct: number | null
  status: LimitsMeterStatus
  /** Accessible name — the meter's resolved label. */
  label: string
  className?: string
}

export function QuotaBar({ pct, status, label, className }: QuotaBarProps) {
  return (
    <Progress
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      value={pct}
      aria-label={label}
      indicatorClassName={cn("rounded-full duration-500", STATUS_BAR[status])}
    />
  )
}
