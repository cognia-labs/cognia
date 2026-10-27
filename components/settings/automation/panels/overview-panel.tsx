"use client"

/**
 * UI Automation → Overview: is anything stopping automation from working, what
 * has it done lately, and what is it allowed to do.
 *
 * Every row answers from live state and links to the panel that changes it, so
 * the overview is a place to start from rather than a fifth copy of the
 * settings. The configuration itself lives in the Configure panels; the old
 * Overview tab stacked the behaviour form, the screen-off driver and the kill
 * switch here as well, which is why nothing on it read as more important than
 * anything else.
 */

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertOctagonIcon,
  ArrowRightIcon,
  BoxIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  missingOsPermissions,
  type AutomationHostStatus,
  type AutomationOsPermissionKey,
} from "@/hooks/automation/use-automation-host-status"
import { listAuditRows } from "@/lib/automation/audit"
import {
  relativeAge,
  summarizeAuditWindow,
  type AuditWindowSummary,
} from "@/lib/automation/audit-summary"
import type { AutomationSettings, Tier } from "@/lib/automation/client"
import { deviceConsoleHref } from "@/lib/devices/device-console-href"
import { repairSelectionToolbarPermission } from "@/lib/tauri/selection-toolbar"
import { cn } from "@/lib/utils"

import { useAutomationSettings } from "../automation-settings-context"
import { engineStateOf } from "../automation-status-strip"
import type { AutomationPanelId } from "../nav-config"
import { effectiveTier } from "./permissions-panel"

const METRICS_REFRESH_MS = 60_000

/** The pane the macOS System Settings deep link opens; UI Automation has none. */
const SYSTEM_SETTINGS_PANE: Partial<
  Record<AutomationOsPermissionKey, "accessibility" | "screenRecording">
> = {
  accessibility: "accessibility",
  screenRecording: "screenRecording",
}

export interface OverviewPanelProps {
  host: AutomationHostStatus
  onNavigate: (panel: AutomationPanelId) => void
}

export function OverviewPanel({ host, onNavigate }: OverviewPanelProps) {
  return (
    <SettingsStack>
      <SetupChecklist host={host} onNavigate={onNavigate} />
      <ActivitySummary onNavigate={onNavigate} />
      <PolicySummary onNavigate={onNavigate} />
      <SandboxEntry />
    </SettingsStack>
  )
}

/* ── Setup checklist ────────────────────────────────────────────────────── */

type Gap =
  | { kind: "initFailure"; platform: string; error: string }
  | { kind: "engine"; state: "off" | "stopped" }
  | { kind: "permission"; key: AutomationOsPermissionKey }
  | { kind: "capabilities" }
  | { kind: "allDenied" }

/**
 * What stands between this machine and a working automation call, most
 * blocking first: a backend that never started beats a switch that is off,
 * which beats an OS permission, which beats a policy that denies everything.
 */
export function setupGaps(
  host: Pick<AutomationHostStatus, "caps" | "permissions" | "initFailure">,
  settings: AutomationSettings,
  killSwitchEngaged: boolean
): Gap[] {
  const gaps: Gap[] = []
  if (host.initFailure) gaps.push({ kind: "initFailure", ...host.initFailure })
  const engine = engineStateOf(settings.enabled, killSwitchEngaged)
  if (engine !== "running") gaps.push({ kind: "engine", state: engine })
  for (const key of missingOsPermissions(host.permissions)) gaps.push({ kind: "permission", key })
  if (host.caps === null) gaps.push({ kind: "capabilities" })
  const surfaces = [
    settings.perSurface.workflow.tier,
    settings.perSurface.computerUse.tier,
    settings.perSurface.mcp.tier,
    settings.perSurface.plugin.tier,
  ]
  if (surfaces.every((tier) => effectiveTier(settings, tier) === "off")) {
    gaps.push({ kind: "allDenied" })
  }
  return gaps
}

function SetupChecklist({ host, onNavigate }: OverviewPanelProps) {
  const t = useTranslations("automation.overview.setup")
  const tPermission = useTranslations("automation.osPermissions")
  const { settings, killSwitchEngaged, setEnabled, saving } = useAutomationSettings()
  const [rechecking, setRechecking] = useState(false)

  if (!settings) return <Skeleton className="h-24 w-full" />

  const gaps = setupGaps(host, settings, killSwitchEngaged)

  const recheck = async () => {
    setRechecking(true)
    try {
      await host.refreshPermissions()
    } finally {
      setRechecking(false)
    }
  }

  return (
    <SettingsBlock
      icon={<ClipboardCheckIcon />}
      title={t("title")}
      description={gaps.length === 0 ? t("readyDescription") : t("gapsDescription")}
      headingLevel={4}
      badge={
        gaps.length === 0 ? (
          <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2Icon aria-hidden className="size-3" />
            {t("ready")}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-amber-700 dark:text-amber-400">
            {t("gapCount", { count: gaps.length })}
          </Badge>
        )
      }
      testid="automation-setup-checklist"
    >
      {gaps.length === 0 ? null : (
        <ul className="space-y-2" data-testid="automation-setup-gaps">
          {gaps.map((gap) => {
            if (gap.kind === "initFailure") {
              return (
                <li key="initFailure">
                  <Alert variant="destructive">
                    <AlertOctagonIcon className="size-4" />
                    <AlertTitle>{t("initFailure.title")}</AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>{t("initFailure.body", { platform: gap.platform, error: gap.error })}</p>
                      <Button size="sm" variant="outline" onClick={host.dismissInitFailure}>
                        {t("initFailure.dismiss")}
                      </Button>
                    </AlertDescription>
                  </Alert>
                </li>
              )
            }
            const row = (() => {
              switch (gap.kind) {
                case "engine":
                  return {
                    key: "engine",
                    label: t(`engine.${gap.state}`),
                    action: (
                      <Button
                        size="sm"
                        onClick={() => void setEnabled(true)}
                        disabled={saving}
                        data-testid="automation-setup-enable"
                      >
                        {gap.state === "stopped" ? t("resume") : t("enable")}
                      </Button>
                    ),
                  }
                case "permission": {
                  const pane = SYSTEM_SETTINGS_PANE[gap.key]
                  return {
                    key: `permission-${gap.key}`,
                    label: t("permissionMissing", { permission: tPermission(gap.key) }),
                    action: (
                      <div className="flex flex-wrap gap-2">
                        {pane ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void repairSelectionToolbarPermission(pane)}
                          >
                            {t("openSystemSettings")}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void recheck()}
                          disabled={rechecking}
                        >
                          <RefreshCwIcon aria-hidden className="size-4" />
                          {t("recheck")}
                        </Button>
                      </div>
                    ),
                  }
                }
                case "capabilities":
                  return {
                    key: "capabilities",
                    label: t("capabilitiesFailed"),
                    action: (
                      <Button size="sm" variant="outline" onClick={() => onNavigate("diagnostics")}>
                        {t("openDiagnostics")}
                      </Button>
                    ),
                  }
                case "allDenied":
                  return {
                    key: "allDenied",
                    label: t("allDenied"),
                    action: (
                      <Button size="sm" variant="outline" onClick={() => onNavigate("permissions")}>
                        {t("openPermissions")}
                      </Button>
                    ),
                  }
              }
            })()
            return (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-sm text-pretty">{row.label}</span>
                <div className="shrink-0">{row.action}</div>
              </li>
            )
          })}
        </ul>
      )}
    </SettingsBlock>
  )
}

/* ── Activity ───────────────────────────────────────────────────────────── */

interface LoadedSummary extends AuditWindowSummary {
  // Captured with the snapshot, not at render: `Date.now()` during render
  // trips React Compiler's purity rule.
  loadedAt: number
}

function ActivitySummary({ onNavigate }: Pick<OverviewPanelProps, "onNavigate">) {
  const t = useTranslations("automation.overview.metrics")
  const [summary, setSummary] = useState<LoadedSummary | null>(null)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    try {
      // Newest-first; 5000 is the LRU cap, so this is the whole retained log.
      const rows = await listAuditRows({ limit: 5000 })
      const now = Date.now()
      setSummary({ ...summarizeAuditWindow(rows, now), loadedAt: now })
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    // Deferred so the first fetch is scheduled like the interval's —
    // calling reload() in the effect body trips react-hooks/set-state-in-effect.
    const initialId = window.setTimeout(() => void reload(), 0)
    const intervalId = window.setInterval(() => void reload(), METRICS_REFRESH_MS)
    return () => {
      window.clearTimeout(initialId)
      window.clearInterval(intervalId)
    }
  }, [reload])

  let lastScreenshot: string | null = null
  if (summary) {
    if (summary.lastScreenshotTs === null) lastScreenshot = t("lastScreenshotNever")
    else {
      const age = relativeAge(summary.lastScreenshotTs, summary.loadedAt)
      lastScreenshot =
        age.unit === "seconds"
          ? t("lastScreenshotRelative", { seconds: age.value })
          : age.unit === "minutes"
            ? t("lastScreenshotMinutes", { minutes: age.value })
            : t("lastScreenshotHours", { hours: age.value })
    }
  }

  return (
    <SettingsBlock
      icon={<ActivityIcon />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      action={
        <Button variant="ghost" size="sm" onClick={() => onNavigate("audit")}>
          {t("openAudit")}
          <ArrowRightIcon aria-hidden className="size-4" />
        </Button>
      }
      testid="automation-activity"
    >
      {loadError ? (
        <p className="text-xs text-destructive">{t("loadFailed")}</p>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-2 @md/settings-stack:grid-cols-4">
            <CounterCell label={t("total")} value={summary.total} />
            <CounterCell label={t("allow")} value={summary.allow} accent="success" />
            <CounterCell label={t("deny")} value={summary.deny} accent="destructive" />
            <CounterCell label={t("consent")} value={summary.consent} accent="warning" />
          </div>
          <div className="grid grid-cols-1 gap-4 @md/settings-stack:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("topFailingTitle")}</p>
              {summary.topFailing.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("topFailingEmpty")}</p>
              ) : (
                <ul className="space-y-1 text-xs" data-testid="automation-top-failing">
                  {summary.topFailing.map((entry) => (
                    <li key={entry.command} className="flex items-center justify-between gap-2">
                      <code className="min-w-0 truncate font-mono">{entry.command}</code>
                      <Badge variant="destructive" className="text-[10px]">
                        {entry.count}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("lastScreenshotTitle")}</p>
              <p className="text-xs text-muted-foreground">{lastScreenshot}</p>
            </div>
          </div>
        </>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </SettingsBlock>
  )
}

function CounterCell({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "success" | "destructive" | "warning"
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          accent === "success" && "text-emerald-600 dark:text-emerald-400",
          accent === "destructive" && "text-destructive",
          accent === "warning" && "text-amber-600 dark:text-amber-400"
        )}
      >
        {value}
      </p>
    </div>
  )
}

/* ── Policy ─────────────────────────────────────────────────────────────── */

function PolicySummary({ onNavigate }: Pick<OverviewPanelProps, "onNavigate">) {
  const t = useTranslations("automation.overview.policy")
  const tTier = useTranslations("automation.permissions.tier")
  const tSurface = useTranslations("automation.audit.filters")
  const { settings } = useAutomationSettings()

  if (!settings) return null

  const sources: Array<{ key: string; label: string; tier: Tier; inherited: boolean }> = (
    [
      ["workflow", "surfaceWorkflow"],
      ["computerUse", "surfaceComputerUse"],
      ["mcp", "surfaceMcp"],
      ["plugin", "surfacePlugin"],
    ] as const
  ).map(([surface, labelKey]) => {
    const own = settings.perSurface[surface].tier
    return {
      key: surface,
      label: tSurface(labelKey),
      tier: effectiveTier(settings, own),
      inherited: own === "off",
    }
  })
  const admitCount =
    settings.whitelist.processNames.length + settings.whitelist.windowTitlePatterns.length
  const copilotAllowListed = settings.perSurface.chatCopilot.tier === "whitelist"

  return (
    <SettingsBlock
      icon={<ShieldCheckIcon />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      testid="automation-policy-summary"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm @md/settings-stack:grid-cols-2">
        <SummaryRow
          label={t("defaultTier")}
          value={tTier(settings.defaultTier)}
          onClick={() => onNavigate("permissions")}
        />
        {sources.map((source) => (
          <SummaryRow
            key={source.key}
            label={source.label}
            value={
              source.inherited ? t("inherited", { tier: tTier(source.tier) }) : tTier(source.tier)
            }
            onClick={() => onNavigate("permissions")}
          />
        ))}
        <SummaryRow
          label={t("admitRules")}
          value={admitCount === 0 ? t("admitEmpty") : t("admitCount", { count: admitCount })}
          onClick={() => onNavigate("accessRules")}
        />
        <SummaryRow
          label={t("chatCopilot")}
          value={copilotAllowListed ? t("chatCopilotAllowListed") : t("chatCopilotAsk")}
          onClick={() => onNavigate("permissions")}
        />
      </dl>
    </SettingsBlock>
  )
}

function SummaryRow({
  label,
  value,
  onClick,
}: {
  label: string
  value: string
  onClick: () => void
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 pb-2">
      <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <Button
          variant="link"
          size="sm"
          className="h-auto truncate p-0 text-foreground"
          onClick={onClick}
        >
          {value}
        </Button>
      </dd>
    </div>
  )
}

/* ── Sandbox entry ──────────────────────────────────────────────────────── */

/**
 * The sandbox registry used to be a sixth tab here. It is a set of machines,
 * not a policy, and Devices → this device → Sandbox already mounts the same
 * component, so it lives there now and this block is how people who look for
 * it here find it.
 */
function SandboxEntry() {
  const t = useTranslations("automation.overview.sandboxes")
  return (
    <SettingsBlock
      icon={<BoxIcon />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href={deviceConsoleHref("local", "sandbox")} data-testid="automation-sandbox-link">
            {t("open")}
            <ArrowRightIcon aria-hidden className="size-4" />
          </Link>
        </Button>
      }
      testid="automation-sandbox-entry"
      // Header-only: the description and the link are the whole block.
      contentClassName="hidden"
    >
      {null}
    </SettingsBlock>
  )
}
