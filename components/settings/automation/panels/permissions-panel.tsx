"use client"

/**
 * UI Automation → Permissions: who may drive the screen, and how freely.
 *
 * Laid out in the order the Rust gate decides (`PermissionGate::evaluate`):
 * the default tier, then a per-source override, then — for plugins — a
 * per-plugin override. The chat copilot comes last because the gate handles it
 * apart from all of that (its own two behaviours, its own list).
 *
 * A source set to `off` does not mean "off": `effective_tier` reads it as
 * "inherit the default tier". The tab strip labelled that choice "Off" beside
 * a default of Whitelist, so the user saw "Off" on a source the gate was
 * allowing. Here a source's `off` is shown as what it does — follow the
 * default — and the default itself is the only place "Off" means deny.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ArrowRightIcon } from "lucide-react"

import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { AutomationSettings, Surface, Tier } from "@/lib/automation/client"

import { useAutomationSettings } from "../automation-settings-context"
import { ChatCopilotCaptureCard } from "../chat-copilot-capture-card"
import type { AutomationPanelId } from "../nav-config"
import { TierSegmentedControl, type SegmentOption } from "../tier-segmented-control"

/**
 * Sandbox is an audit-only tag (calls go through `sandbox_exec`, never the
 * gate) and the chat copilot has its own block, so neither gets a row.
 */
type ConfigurableSurface = Exclude<Surface, "sandbox" | "chatCopilot">

const SURFACES: readonly ConfigurableSurface[] = ["workflow", "computerUse", "mcp", "plugin"]

const SURFACE_LABEL_KEY: Record<ConfigurableSurface, string> = {
  workflow: "surfaceWorkflow",
  computerUse: "surfaceComputerUse",
  mcp: "surfaceMcp",
  plugin: "surfacePlugin",
}

/** The tier a source actually runs at, as `effective_tier` resolves it. */
export function effectiveTier(settings: AutomationSettings, surfaceTier: Tier): Tier {
  return surfaceTier === "off" ? settings.defaultTier : surfaceTier
}

export interface PermissionsPanelProps {
  onNavigate: (panel: AutomationPanelId) => void
}

export function PermissionsPanel({ onNavigate }: PermissionsPanelProps) {
  const t = useTranslations("automation.permissions")
  const tTier = useTranslations("automation.permissions.tier")
  const tSurface = useTranslations("automation.audit.filters")
  const { settings, saving, update } = useAutomationSettings()

  if (!settings) return <Skeleton className="h-64 w-full" />

  const tierOptions: SegmentOption<Tier>[] = [
    { value: "off", label: tTier("off") },
    { value: "whitelist", label: tTier("whitelist") },
    { value: "perCall", label: tTier("perCall") },
  ]
  const inheritLabel = t("inheritDefault", { tier: tTier(settings.defaultTier) })
  const sourceOptions: SegmentOption<Tier>[] = [
    { value: "off", label: inheritLabel },
    { value: "whitelist", label: tTier("whitelist") },
    { value: "perCall", label: tTier("perCall") },
  ]

  // A Whitelist tier with nothing on the list admits every app without asking.
  const admitEmpty =
    settings.whitelist.processNames.length === 0 &&
    settings.whitelist.windowTitlePatterns.length === 0
  const anyWhitelist = SURFACES.some(
    (surface) => effectiveTier(settings, settings.perSurface[surface].tier) === "whitelist"
  )

  const setSurfaceTier = (surface: ConfigurableSurface, tier: Tier) =>
    void update((current) => ({
      ...current,
      perSurface: {
        ...current.perSurface,
        [surface]: { ...current.perSurface[surface], tier },
      },
    }))

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("defaultTier")}
        description={t("defaultTierDescription")}
        headingLevel={4}
        settingId="automation-default-tier"
      >
        <TierSegmentedControl
          value={settings.defaultTier}
          options={tierOptions}
          ariaLabel={t("defaultTier")}
          disabled={saving}
          testid="automation-default-tier"
          onChange={(tier) => void update((current) => ({ ...current, defaultTier: tier }))}
        />
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs @md/settings-stack:grid-cols-[max-content_1fr]">
          {tierOptions.map((option) => (
            <div key={option.value} className="contents">
              <dt className="font-medium">{option.label}</dt>
              <dd className="text-pretty text-muted-foreground">
                {t(`tierExplain.${option.value}`)}
              </dd>
            </div>
          ))}
        </dl>
        {anyWhitelist && admitEmpty ? (
          <Alert data-testid="automation-whitelist-empty-warning">
            <AlertTriangleIcon aria-hidden className="size-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-pretty">{t("whitelistEmptyWarning")}</span>
              <Button variant="outline" size="sm" onClick={() => onNavigate("accessRules")}>
                {t("openAccessRules")}
                <ArrowRightIcon aria-hidden className="size-4" />
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </SettingsBlock>

      <SettingsBlock
        title={t("perSurface")}
        description={t("perSurfaceDescription")}
        headingLevel={4}
        settingId="automation-per-surface"
      >
        {SURFACES.map((surface) => {
          const tier = settings.perSurface[surface].tier
          return (
            <SettingsField
              key={surface}
              label={tSurface(SURFACE_LABEL_KEY[surface])}
              description={t(`surfaces.${surface}Description`)}
              testid={`automation-surface-${surface}`}
            >
              <TierSegmentedControl
                value={tier}
                options={sourceOptions}
                ariaLabel={tSurface(SURFACE_LABEL_KEY[surface])}
                disabled={saving}
                testid={`automation-surface-${surface}-tier`}
                onChange={(next) => setSurfaceTier(surface, next)}
              />
            </SettingsField>
          )
        })}
        <PerPluginOverrides settings={settings} saving={saving} />
      </SettingsBlock>

      <ChatCopilotCaptureCard
        settings={settings}
        saving={saving}
        onChange={(next) =>
          update((current) => ({
            ...current,
            perSurface: { ...current.perSurface, chatCopilot: next.perSurface.chatCopilot },
          }))
        }
      />
    </SettingsStack>
  )
}

/**
 * ADR-0020 W2 — every enabled plugin that declares `native:input` or
 * `native:screen` gets its own tier. Without an override a plugin runs at the
 * Plugin source's tier; an override's `off` follows the default tier, exactly
 * like a source's (`effective_tier(over.tier)`), so it is offered as such.
 */
function PerPluginOverrides({
  settings,
  saving,
}: {
  settings: AutomationSettings
  saving: boolean
}) {
  const t = useTranslations("automation.permissions.perPlugin")
  const tTier = useTranslations("automation.permissions.tier")
  const { update } = useAutomationSettings()
  const [eligible, setEligible] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)

  // Late-import the plugin store so this panel is safe to mount in jsdom /
  // Storybook contexts where the Zustand store would explode on a missing IDB
  // shim.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
        // `native:*` permissions are declared by plugins (e.g. computer-use) but
        // smuggled past `PluginPermission` via an `as never` cast in their
        // manifest. Compare against a string set so the union doesn't reject
        // the lookup at compile time.
        const NATIVE_AUTOMATION_PERMS: ReadonlySet<string> = new Set([
          "native:input",
          "native:screen",
        ])
        const rows = Object.values(usePluginStore.getState().plugins)
          .filter((p) => p.status === "enabled")
          .filter((p) =>
            (p.manifest.permissions ?? []).some((perm) => NATIVE_AUTOMATION_PERMS.has(perm))
          )
          .map((p) => ({ id: p.manifest.id, name: p.manifest.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (!cancelled) setEligible(rows)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const overrides = settings.perSurface.plugin.perPluginOverrides ?? {}
  const pluginSourceTier = settings.perSurface.plugin.tier
  const inheritLabel = t("inheritSource")

  type OverrideChoice = "inherit" | Tier
  const options: SegmentOption<OverrideChoice>[] = [
    { value: "inherit", label: inheritLabel },
    { value: "off", label: t("followDefault", { tier: tTier(settings.defaultTier) }) },
    { value: "whitelist", label: tTier("whitelist") },
    { value: "perCall", label: tTier("perCall") },
  ]

  const writeOverride = (pluginId: string, choice: OverrideChoice) =>
    void update((current) => {
      const nextOverrides = { ...(current.perSurface.plugin.perPluginOverrides ?? {}) }
      if (choice === "inherit") delete nextOverrides[pluginId]
      else nextOverrides[pluginId] = { ...nextOverrides[pluginId], tier: choice }
      return {
        ...current,
        perSurface: {
          ...current.perSurface,
          plugin: { ...current.perSurface.plugin, perPluginOverrides: nextOverrides },
        },
      }
    })

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      collapsible
      defaultOpen={Object.keys(overrides).length > 0}
      badge={
        Object.keys(overrides).length > 0 ? (
          <Badge variant="secondary" className="text-[10px]">
            {t("overrideCount", { count: Object.keys(overrides).length })}
          </Badge>
        ) : undefined
      }
      testid="automation-per-plugin"
      className="rounded-md border bg-muted/20 p-3"
    >
      {loading ? (
        <Skeleton className="h-12 w-full" />
      ) : eligible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        eligible.map((plugin) => {
          const override = overrides[plugin.id]
          return (
            <SettingsField
              key={plugin.id}
              label={plugin.name}
              description={
                override
                  ? t("rowOverridden", {
                      tier: tTier(effectiveTier(settings, override.tier)),
                    })
                  : t("rowInheriting", {
                      tier: tTier(effectiveTier(settings, pluginSourceTier)),
                    })
              }
              testid={`automation-plugin-${plugin.id}`}
            >
              <TierSegmentedControl<OverrideChoice>
                value={override ? override.tier : "inherit"}
                options={options}
                ariaLabel={plugin.name}
                disabled={saving}
                testid={`automation-plugin-${plugin.id}-tier`}
                onChange={(choice) => writeOverride(plugin.id, choice)}
              />
            </SettingsField>
          )
        })
      )}
    </SettingsBlock>
  )
}
