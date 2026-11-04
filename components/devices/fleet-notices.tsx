"use client"

/**
 * What the console has to say about the fleet as a whole, rather than about
 * the device that is open.
 *
 * These used to sit above the device masthead in the detail pane, which made
 * them read as facts about the selected device and pushed its name down the
 * screen. They are about the list: "this is the local record, not the host's"
 * qualifies every row's lifecycle state, and "only this machine" is the empty
 * state of the fleet. So they now live in the rail, which is also the half of
 * the console the phone shell shows first, and which previously showed
 * neither: the phone body never rendered these at all.
 */

import { useTranslations } from "next-intl"
import { LaptopIcon, XIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

/**
 * Without the host, lifecycle state and the raw capability sets come from the
 * local mirror, so `partial` grants and CLI-side suspensions cannot be seen.
 * Stated rather than swallowed.
 */
export function HostUnreachableNotice() {
  const t = useTranslations("devices")
  return (
    <Alert className="px-3 py-2" data-testid="device-host-unreachable">
      <AlertTitle className="text-xs">{t("hostUnreachableTitle")}</AlertTitle>
      <AlertDescription className="text-[11px] leading-snug">
        {t("hostUnreachableBody")}
      </AlertDescription>
    </Alert>
  )
}

/**
 * A `?device=` link naming a device this fleet does not have.
 *
 * Revoked, removed, or from another account: the console shows this machine
 * instead, and without this the link looks broken rather than stale.
 */
export function MissingDeviceLinkNotice({
  deviceRef,
  onDismiss,
}: {
  deviceRef: string
  onDismiss: () => void
}) {
  const t = useTranslations("devices")
  return (
    <Alert className="relative px-3 py-2 pr-8" data-testid="device-link-missing">
      <AlertTitle className="text-xs">{t("missingLinkTitle")}</AlertTitle>
      <AlertDescription className="text-[11px] leading-snug">
        <span className="block">{t("missingLinkBody")}</span>
        <code className="mt-1 block truncate font-mono text-[10px]">{deviceRef}</code>
      </AlertDescription>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5 size-6"
        aria-label={t("missingLinkDismiss")}
        onClick={onDismiss}
        data-testid="device-link-missing-dismiss"
      >
        <XIcon className="size-3.5" />
      </Button>
    </Alert>
  )
}

/**
 * The standalone console: no host of our own and none paired.
 *
 * This is the surface contract's `standalone: "explain"` state. The console
 * keeps working for this machine and says which half is missing, instead of
 * rendering a one-row "fleet" with nothing to explain it. Under the single
 * row rather than above the device pane, because it is the list's empty state.
 *
 * It explains and does not act: pairing and adding a host are already the
 * header's labelled actions (the phone's + menu), and repeating them here put
 * two copies of the same two buttons on one screen.
 */
export function StandaloneFleetCard() {
  const t = useTranslations("devices")
  return (
    <div
      className="flex gap-2.5 rounded-lg border border-dashed px-3 py-2.5"
      data-testid="devices-requires-host"
      data-reason={standaloneDevicesRequiresHost.reason}
    >
      <LaptopIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium">{t("standaloneTitle")}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {t("standaloneBody")}
        </p>
      </div>
    </div>
  )
}
