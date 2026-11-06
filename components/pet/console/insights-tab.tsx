// The console's "Insights" segment: the capture settings, in a headed section
// that names what they feed. The Attention Radar report they feed is the
// radar module's, in the console's Extensions tab (`pet.console.tab`,
// `components/radar/module.ui.ts`), so the pet imports no radar code.

"use client"

import { useTranslations } from "next-intl"
import { CaptureSettingsPanel } from "@/components/capture/capture-settings-panel"

export function InsightsTab() {
  const t = useTranslations("pet")
  return (
    <div data-testid="pet-insights-tab" className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <section aria-labelledby="pet-insights-capture-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="pet-insights-capture-heading" className="text-base font-semibold">
            {t("console.insights.captureTitle")}
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            {t("console.insights.captureDescription")}
          </p>
        </div>
        <CaptureSettingsPanel />
      </section>
    </div>
  )
}
