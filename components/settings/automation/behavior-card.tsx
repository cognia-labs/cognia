// Model-behavior settings (Settings → UI Automation → Behavior).
//
// Surfaces the "model view" knobs the Rust side honors:
//   - picture-in-picture visibility
//   - screenshot down-scaling (on by default; 1280×800 WXGA)
//   - screenshot dedup ("screen unchanged" text instead of duplicate frames)
//   - clipboard-paste threshold for long `type` actions (0 disables)
//   - how long a per-call consent prompt waits
//
// Reads and writes through the section's `AutomationSettingsProvider`, whose
// queue serializes every save and re-reads the host first, so a toggle here
// can never write back a stale `enabled` flag from before the status strip
// resumed the engine.

"use client"

import { useEffect } from "react"

import { KeyboardIcon, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import type { AutomationSettings } from "@/lib/automation/client"
import {
  MAX_CONSENT_TIMEOUT_MS,
  MIN_CONSENT_TIMEOUT_MS,
  clampConsentTimeoutMs,
} from "@/lib/automation/consent-durations"
import { setComputerUsePipAlwaysHidden } from "@/lib/automation/computer-use-pip"

import { useAutomationSettings } from "./automation-settings-context"

export function BehaviorCard() {
  const t = useTranslations("automation.behavior")
  const { settings, loadError, update } = useAutomationSettings()
  const pipHidden = settings?.alwaysHidePictureInPicture

  // The PiP host reads a module flag, not these settings. Following what the
  // provider holds (optimistic value, then the host's after a failed save)
  // keeps the two from disagreeing.
  useEffect(() => {
    if (pipHidden !== undefined) setComputerUsePipAlwaysHidden(pipHidden)
  }, [pipHidden])

  if (!settings) {
    return loadError ? (
      <p className="font-mono text-xs text-destructive" role="alert">
        {loadError}
      </p>
    ) : (
      <Skeleton className="h-48 w-full" />
    )
  }

  const save = (patch: (current: AutomationSettings) => Partial<AutomationSettings>) =>
    void update((current) => ({ ...current, ...patch(current) }))

  const scaling = settings.screenshotScaling

  // A fragment, not a stack: the Behavior panel puts these blocks in the same
  // `SettingsStack` as the screen-off block so the hairlines line up.
  return (
    <>
      <SettingsBlock
        icon={<Sparkles />}
        title={t("title")}
        description={t("description")}
        headingLevel={4}
        settingId="automation-behavior"
      >
        <SettingsField
          htmlFor="behavior-hide-pip"
          label={t("pictureInPicture.label")}
          description={t("pictureInPicture.help")}
        >
          <Switch
            id="behavior-hide-pip"
            checked={settings.alwaysHidePictureInPicture}
            onCheckedChange={(v) => save(() => ({ alwaysHidePictureInPicture: Boolean(v) }))}
          />
        </SettingsField>

        <SettingsField
          htmlFor="behavior-dedup"
          label={t("dedup.label")}
          description={t("dedup.help")}
        >
          <Switch
            id="behavior-dedup"
            checked={settings.screenshotDedup}
            onCheckedChange={(v) => save(() => ({ screenshotDedup: Boolean(v) }))}
          />
        </SettingsField>

        <SettingsField
          htmlFor="behavior-scaling"
          label={t("scaling.label")}
          description={t("scaling.help")}
        >
          <Switch
            id="behavior-scaling"
            checked={scaling.enabled}
            onCheckedChange={(v) =>
              save((current) => ({
                screenshotScaling: { ...current.screenshotScaling, enabled: Boolean(v) },
              }))
            }
          />
        </SettingsField>
        {scaling.enabled && (
          <div className="-mt-2 grid grid-cols-2 gap-2 @md/settings-stack:max-w-xs">
            <div className="space-y-1">
              <Label htmlFor="behavior-scaling-w" className="text-xs">
                {t("scaling.maxWidth")}
              </Label>
              <Input
                id="behavior-scaling-w"
                type="number"
                min={320}
                max={3840}
                value={scaling.maxWidth}
                onChange={(e) => {
                  const maxWidth = Math.min(3840, Math.max(320, Number(e.target.value) || 1280))
                  save((current) => ({
                    screenshotScaling: { ...current.screenshotScaling, maxWidth },
                  }))
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="behavior-scaling-h" className="text-xs">
                {t("scaling.maxHeight")}
              </Label>
              <Input
                id="behavior-scaling-h"
                type="number"
                min={240}
                max={2400}
                value={scaling.maxHeight}
                onChange={(e) => {
                  const maxHeight = Math.min(2400, Math.max(240, Number(e.target.value) || 800))
                  save((current) => ({
                    screenshotScaling: { ...current.screenshotScaling, maxHeight },
                  }))
                }}
              />
            </div>
          </div>
        )}
      </SettingsBlock>

      <SettingsBlock
        icon={<KeyboardIcon />}
        title={t("inputTitle")}
        description={t("inputDescription")}
        headingLevel={4}
        settingId="automation-input"
      >
        <SettingsField
          htmlFor="behavior-paste-threshold"
          label={t("pasteThreshold.label")}
          description={t("pasteThreshold.help")}
        >
          <Input
            id="behavior-paste-threshold"
            type="number"
            min={0}
            max={100000}
            className="w-28"
            value={settings.pasteThresholdChars}
            onChange={(e) => {
              const pasteThresholdChars = Math.max(0, Number(e.target.value) || 0)
              save(() => ({ pasteThresholdChars }))
            }}
          />
        </SettingsField>

        {/* Consent wait. Seconds in the UI, ms on the wire. The ceiling keeps
            the window inside the sidecar's plugin-tool budget so an answer
            never lands on a call that already timed out. */}
        <SettingsField
          htmlFor="behavior-consent-timeout"
          label={t("consentTimeout.label")}
          description={t("consentTimeout.help")}
        >
          <Input
            id="behavior-consent-timeout"
            type="number"
            min={Math.ceil(MIN_CONSENT_TIMEOUT_MS / 1000)}
            max={Math.floor(MAX_CONSENT_TIMEOUT_MS / 1000)}
            className="w-28"
            value={Math.round(clampConsentTimeoutMs(settings.consentTimeoutMs) / 1000)}
            onChange={(e) => {
              const consentTimeoutMs = clampConsentTimeoutMs(Number(e.target.value) * 1000)
              save(() => ({ consentTimeoutMs }))
            }}
          />
        </SettingsField>
      </SettingsBlock>
    </>
  )
}
