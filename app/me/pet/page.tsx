"use client"

/**
 * `/me/pet` — Settings → Pet on the phone (ADR-0058 D16, ADR-0219).
 *
 * The phone's home for the Pet settings section, which is the pet's whole
 * console: a phone cares for its paired desktop's pet from here. It renders
 * the same section component the desktop's Settings page does, under the Me
 * sub-page chrome, because a phone's `/settings` is an ordinary scrolling
 * route that would collapse the console's own scrolling pane, while `/me/*`
 * gets a definite height (`lib/shell/full-viewport-routes.ts`).
 *
 * The console explains an unpaired phone and a desktop too old to share its
 * pet itself; the Me row is offered only while the paired host advertises
 * `pet_get` (`components/mobile/me/me-entries.ts`).
 */

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { PetSection } from "@/components/settings/pet/pet-section"

export default function MobilePetPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      settingsPanel
      title={t("petRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-pet-page"
      // The section owns its scroll; the inset only keeps the console's
      // "Places" trigger off the screen edge.
      bodyClassName="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-0"
    >
      <PetSection />
    </SubPageShell>
  )
}
