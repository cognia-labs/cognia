// The /pet console's "Appearance & settings" sub-page: everything that shapes
// how the pet looks and behaves, in one place. The header opens it (with a
// breadcrumb back to the main view); it is not one of the console's tabs.
//
// Two parts:
//
//   - The customization workspace (`PetCustomizationWorkspace`): the pet's
//     master switch, look, appearance, interaction, sound, care, twin
//     awareness, desktop window and reset. Settings → Pet points here.
//   - Character binding (`BindingTab`): the per-character look overrides.
//
// A section index sits beside them on a wide pane and scrolls to a section by
// its `data-setting-id` anchor, the same anchor the settings finder resolves.
//
// On a paired phone (ADR-0219) the workspace is the desktop's (skins and
// models are desktop-local blobs, the window sliders shape a desktop window):
// it renders the desktop-only notice in its place, while the binding stays
// readable. Classified as `appearance.customize` and `binding.edit` in
// `lib/pet/console/action-capabilities.ts`.

"use client"

import { useEffect, useRef } from "react"
import { useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { CapabilityGate } from "@/components/platform/capability-gate"
import { PetCustomizationWorkspace } from "@/components/pet/settings/pet-customization-workspace"
import { cn } from "@/lib/utils"
import { BindingTab } from "./binding-tab"
import { DesktopOnlyNotice } from "./desktop-only-notice"

/** The anchor of the character-binding section. */
export const PET_BINDING_SECTION_ID = "pet-binding"

interface IndexEntry {
  id: string
  label: string
  /** Rendered only on hosts that draw the section (the desktop window block). */
  desktopProfileOnly?: boolean
}

export interface AppearanceViewProps {
  /** Whether the customization workspace runs here (false on a paired phone). */
  canCustomize: boolean
  /** Whether binding edits run here (false on a paired phone). */
  canEditBinding: boolean
  /** Scroll to this section once on open (`?tab=binding`). */
  focus?: "binding"
}

export function AppearanceView({ canCustomize, canEditBinding, focus }: AppearanceViewProps) {
  const t = useTranslations("pet")
  const ts = useTranslations("settings.pet")
  const tc = useTranslations("pet.customize")
  const reducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)

  const scrollTo = (id: string, smooth = true) => {
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)
    target?.scrollIntoView({
      behavior: smooth && !reducedMotion ? "smooth" : "auto",
      block: "start",
    })
  }

  // A `?tab=binding` link lands on the binding section rather than the top.
  useEffect(() => {
    if (focus !== "binding") return
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-setting-id="${PET_BINDING_SECTION_ID}"]`)
      ?.scrollIntoView({ block: "start" })
  }, [focus])

  const entries: IndexEntry[] = canCustomize
    ? [
        { id: "pet-enabled", label: ts("enabled.label") },
        { id: "pet-look", label: tc("look.title") },
        { id: "pet-appearance", label: tc("appearance.title") },
        { id: "pet-interaction", label: tc("interaction.title") },
        { id: "pet-sound", label: tc("sound.title") },
        { id: "pet-care", label: tc("care.title") },
        { id: "pet-twin-awareness", label: ts("twinAwareness.title") },
        { id: "pet-desktop", label: tc("desktop.title"), desktopProfileOnly: true },
        { id: "pet-reset", label: ts("reset.label") },
        { id: PET_BINDING_SECTION_ID, label: t("console.appearance.binding") },
      ]
    : []

  return (
    <div
      ref={rootRef}
      data-testid="pet-appearance-view"
      className={cn(
        "mx-auto grid w-full max-w-6xl gap-8",
        entries.length > 0 && "@4xl/pet-pane:grid-cols-[11rem_minmax(0,1fr)]"
      )}
    >
      {entries.length > 0 ? (
        <nav
          aria-label={t("console.appearance.index")}
          data-testid="pet-appearance-index"
          className="hidden @4xl/pet-pane:block"
        >
          <ul className="sticky top-0 flex flex-col gap-0.5">
            {entries.map((entry) => {
              const item = (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-index-target={entry.id}
                    onClick={() => scrollTo(entry.id)}
                    className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground motion-safe:transition-colors"
                  >
                    {entry.label}
                  </button>
                </li>
              )
              return entry.desktopProfileOnly ? (
                <CapabilityGate key={entry.id} profiles={["desktop"]}>
                  {item}
                </CapabilityGate>
              ) : (
                item
              )
            })}
          </ul>
        </nav>
      ) : null}

      <div className="flex min-w-0 flex-col gap-10">
        {canCustomize ? <PetCustomizationWorkspace /> : <DesktopOnlyNotice tab="appearance" />}

        <section
          data-setting-id={PET_BINDING_SECTION_ID}
          aria-labelledby="pet-appearance-binding-heading"
          className="flex scroll-mt-4 flex-col gap-4 border-t border-border/60 pt-8"
        >
          <div className="flex flex-col gap-1">
            <h2 id="pet-appearance-binding-heading" className="text-base font-semibold">
              {t("console.appearance.binding")}
            </h2>
            <p className="text-sm text-pretty text-muted-foreground">
              {t("console.appearance.bindingDescription")}
            </p>
          </div>
          <BindingTab readOnly={!canEditBinding} />
        </section>
      </div>
    </div>
  )
}
