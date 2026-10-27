// A console section that holds more than one view: Collection (dex,
// achievements) and Activity (journal, insights). One small segmented tablist
// at the top of the pane, then the chosen segment.
//
// The segment is controlled by the console, so a deep link (`?tab=insights`)
// lands on the right one and switching sections keeps each section's last
// choice. A desktop-only segment on a paired phone stays selectable with the
// same "Desktop" badge the section tabs use (ADR-0219, CLAUDE.md rule 7).

"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export interface PetConsoleSegment<Id extends string> {
  id: Id
  label: string
  /** Renders the desktop-only badge on the segment trigger. */
  desktopOnly?: boolean
  content: () => ReactNode
}

export interface PetConsoleSegmentsProps<Id extends string> {
  /** Accessible name of the segment list. */
  label: string
  segments: readonly PetConsoleSegment<Id>[]
  value: Id
  onValueChange: (id: Id) => void
  testId?: string
}

export function PetConsoleSegments<Id extends string>({
  label,
  segments,
  value,
  onValueChange,
  testId,
}: PetConsoleSegmentsProps<Id>) {
  const t = useTranslations("pet")
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const match = segments.find((segment) => segment.id === next)
        if (match) onValueChange(match.id)
      }}
      data-testid={testId}
      className="mx-auto flex w-full max-w-5xl flex-col gap-5"
    >
      <TabsList aria-label={label} data-testid={testId ? `${testId}-segments` : undefined}>
        {segments.map((segment) => (
          <TabsTrigger
            key={segment.id}
            value={segment.id}
            data-segment={segment.id}
            data-desktop-only={segment.desktopOnly || undefined}
            className="min-h-8 px-3"
          >
            {segment.label}
            {segment.desktopOnly ? (
              <span
                data-testid="pet-console-desktop-badge"
                className="rounded-sm bg-muted px-1 py-px text-[10px] leading-none font-medium text-muted-foreground"
              >
                {t("console.desktopOnly.badge")}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {segments.map((segment) => (
        <TabsContent key={segment.id} value={segment.id} className="min-w-0">
          {segment.id === value ? segment.content() : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}
