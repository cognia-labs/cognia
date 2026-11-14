"use client"

/**
 * LocalEngineTargetNotice — names the machine whose local inference engines
 * the panel manages when that is not this device.
 *
 * A paired browser or phone, and a desktop driving a remote Host, run their
 * chat turns on the Host, so the local-engine panel manages the Host's engines
 * (`lib/ai/local-engine/client.ts`): `localhost` in the base URL is the Host,
 * and installing, starting or pulling models happens there. Renders nothing
 * while this device manages its own engines.
 */

import { Server } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsAlert } from "@/components/settings/common/settings-section"
import type { LocalEngineTarget } from "@/lib/ai/local-engine/client"

export interface LocalEngineTargetNoticeProps {
  target: LocalEngineTarget
  className?: string
}

export function LocalEngineTargetNotice({ target, className }: LocalEngineTargetNoticeProps) {
  const t = useTranslations("providers")
  if (target.kind !== "host") return null
  const title = target.label
    ? t("localEngineTarget.hostTitle", { host: target.label })
    : t("localEngineTarget.unnamedHostTitle")
  return (
    <SettingsAlert icon={<Server className="h-4 w-4" />} title={title} className={className}>
      <span data-testid="local-engine-target-notice">{t("localEngineTarget.hostBody")}</span>
    </SettingsAlert>
  )
}

export default LocalEngineTargetNotice
