// What a desktop-only place in the /pet console shows on a paired phone or
// browser (ADR-0219): what it is, why it does not run here, and where to do it.
//
// The UI axis of the console's intentional dormancy (CLAUDE.md rule 7). The
// place stays reachable, badged "Desktop" (the plugins tab, the insights
// segment, the header's appearance entry), so the reader learns the feature
// exists and where it lives; opening it lands here instead of on controls that
// would edit assets this device does not have. Which places are desktop-only
// is decided in `lib/pet/console/action-capabilities.ts`, never here.

"use client"

import { useTranslations } from "next-intl"
import { MonitorIcon } from "lucide-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { PetConsoleDestination } from "@/lib/pet/console-tabs"

/** The places that can be desktop-only. */
export type PetDesktopOnlyPlace = Extract<
  PetConsoleDestination,
  "appearance" | "insights" | "plugins"
>

/** What each desktop-only place is for, under `pet.console.desktopOnly.what`. */
const WHAT_KEYS: Record<PetDesktopOnlyPlace, string> = {
  appearance: "console.desktopOnly.what.appearance",
  insights: "console.desktopOnly.what.insights",
  plugins: "console.desktopOnly.what.plugins",
}

export interface DesktopOnlyNoticeProps {
  tab: PetDesktopOnlyPlace
}

export function DesktopOnlyNotice({ tab }: DesktopOnlyNoticeProps) {
  const t = useTranslations("pet")
  const label = t(`console.tabs.${tab}`)
  const what = WHAT_KEYS[tab]

  return (
    <Empty
      data-testid="pet-desktop-only-notice"
      data-tab={tab}
      className="mx-auto max-w-md border-none py-10"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t("console.desktopOnly.title", { tab: label })}</EmptyTitle>
        <EmptyDescription>{t(what)}</EmptyDescription>
        <EmptyDescription>{t("console.desktopOnly.why")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-sm text-muted-foreground">{t(`console.desktopOnly.remedy.${tab}`)}</p>
      </EmptyContent>
    </Empty>
  )
}
