"use client"

/**
 * Title-bar quick-actions cluster — one-click access to the desktop pet,
 * screen OCR, and content capture. Each control reuses an existing entry
 * point: the pet toggle is the same "show / put away the desktop pet" as the
 * /pet console header and the popup (`toggleDesktopPetWindow`, which persists
 * `PetSettings.desktopPet.enabled`); OCR opens its settings section via the
 * shared `requestOpenSettings` request; capture opens the pet console's
 * Insights (Activity), which is the only place `CaptureSettingsPanel` is
 * mounted. Gated by the parent (`barItems.quickActions`).
 *
 * The pet toggle used to flip `usePetStore.minimized`, which only the in-app
 * widget read; that widget was never mounted, so the button changed nothing.
 *
 * The pet and capture controls are desktop-shell only, like the pet itself
 * (ADR-0058 D9): the title bar also renders in the web shell, where the pet
 * console only explains that. The pet toggle further needs the pet switched
 * on: switching it on is the master switch's job in Appearance & settings.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ClipboardIcon, PawPrintIcon, ScanTextIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import { petConsoleHref } from "@/lib/pet/console-tabs"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"

function QuickButton({
  label,
  testId,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  testId: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-sm text-muted-foreground transition-colors hover:text-foreground",
        "motion-safe:transition-transform motion-safe:active:scale-90",
        active ? "text-foreground" : undefined
      )}
    >
      {children}
    </Button>
  )
}

export function TitleBarQuickActions({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar.quickActions")
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const petSettings = useSettingsStore((s) => s.settings?.petSettings ?? DEFAULT_PET_SETTINGS)
  const petEnabled = petSettings.enabled
  const onDesktop = (petSettings.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY).enabled
  const [toggling, setToggling] = useState(false)
  const router = useRouter()
  const desktopShell = usePlatform() === "tauri"

  const toggleDesktopPet = async () => {
    setToggling(true)
    try {
      const opened = await toggleDesktopPetWindow()
      // Asked to show it and it is still not out: say so instead of nothing.
      if (!onDesktop && !opened) toast.error(t("petToggleFailed"))
    } catch {
      toast.error(t("petToggleFailed"))
    } finally {
      setToggling(false)
    }
  }

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      data-testid="title-bar-quick-actions"
    >
      {desktopShell && petEnabled ? (
        <QuickButton
          label={onDesktop ? t("hidePet") : t("showPet")}
          testId="quick-action-pet"
          active={onDesktop}
          disabled={toggling}
          onClick={() => void toggleDesktopPet()}
        >
          <PawPrintIcon className="size-4" aria-hidden />
        </QuickButton>
      ) : null}
      <QuickButton
        label={t("ocr")}
        testId="quick-action-ocr"
        onClick={() => requestOpenSettings("ocr")}
      >
        <ScanTextIcon className="size-4" aria-hidden />
      </QuickButton>
      {desktopShell ? (
        <QuickButton
          label={t("capture")}
          testId="quick-action-capture"
          onClick={() => router.push(petConsoleHref("insights"))}
        >
          <ClipboardIcon className="size-4" aria-hidden />
        </QuickButton>
      ) : null}
    </div>
  )
}
