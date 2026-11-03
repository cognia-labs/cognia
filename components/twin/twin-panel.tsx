"use client"

/**
 * Top-level twin workbench. Renders five tabs, listed in the page header's
 * view bar:
 *
 *   • Sources  — registered raw artefacts (upload + status badges)
 *   • Jobs     — ingest / distill jobs in flight or recently finished
 *   • Drafts   — synth output queue, sorted with low-quality first
 *   • Persona  — the distilled profile the twin speaks from
 *   • Settings — twin-level config (vector backend, RAG topK, etc.)
 *
 * The panel selects the active twin from a hook-derived list of distinct
 * `twinId`s seen across the user's characters. Single-twin users see no
 * chooser; multi-twin users get a select at the top.
 *
 * Tab state syncs to the URL `?tab=...` so refreshing or sharing a deep
 * link lands the user on the same view. The empty-state and worker-status
 * strings use next-intl so the page behaves the same in zh-CN as it does
 * in en.
 */

import { Suspense, useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { BotIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { observeTwins, backfillTwinRegistryFromUsage, type DeleteTwinResult } from "@/lib/db/twins"
import type { Twin } from "@/types/twin"
import { TwinSourcesTab } from "./twin-sources-tab"
import { TwinJobsTab } from "./twin-jobs-tab"
import { TwinDraftsTab } from "./twin-drafts-tab"
import { TwinPersonaTab } from "./twin-persona-tab"
import { TwinSettingsTab } from "./twin-settings-tab"
import { TwinSelector } from "./twin-selector"
import { TwinCreationWizard } from "./twin-creation-wizard"
import { useTwinWorkerStatus } from "./use-twin-worker"
import { TwinHeaderPluginSlot } from "./twin-plugin-slots"

type TabKey = "sources" | "jobs" | "drafts" | "persona" | "settings"
const VALID_TABS: TabKey[] = ["sources", "jobs", "drafts", "persona", "settings"]

/**
 * The main entry point. Wraps the actual panel in a `<Suspense>` boundary
 * because `useSearchParams` requires it under Next 16 with `output: "export"`.
 */
export function TwinPanel() {
  return (
    <Suspense fallback={null}>
      <TwinPanelInner />
    </Suspense>
  )
}

function TwinPanelInner() {
  const t = useTranslations("twin.panel")
  // The `twins` registry (schema v34) is the single source of truth. `undefined`
  // means the live query hasn't resolved yet (loading); `[]` means no twins.
  const twins = useLiveQuery(() => observeTwins(), [], undefined)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [wizardOpen, setWizardOpen] = useState(false)

  // Absorb any legacy `character.twinId` that lacks a registry row (e.g. bound
  // via the character settings after the v34 migration ran). Idempotent and
  // best-effort — the live query above picks up the newly-created rows.
  useEffect(() => {
    void backfillTwinRegistryFromUsage().catch(() => {})
  }, [])

  const twinList: Twin[] = twins ?? []

  // Resolve the active twin id: prefer ?twinId=…, else fall back to the
  // first known twin. Lets characters/the binding deep-link straight into
  // their twin's workbench.
  const requestedTwinId = searchParams?.get("twinId") ?? null
  const [activeTwinId, setActiveTwinId] = useState<string | null>(null)
  const effectiveTwinId =
    activeTwinId ??
    (requestedTwinId && twinList.some((tw) => tw.id === requestedTwinId)
      ? requestedTwinId
      : null) ??
    twinList[0]?.id ??
    null

  // Local state drives the active tab so clicks render synchronously, even
  // when the router mock in tests no-ops `replace`. Initial value comes from
  // the URL so deep links land on the right tab; subsequent writes mirror
  // back to the URL for shareability.
  const [tab, setTabState] = useState<TabKey>((): TabKey => {
    const fromUrl = (searchParams?.get("tab") ?? "sources") as TabKey
    return VALID_TABS.includes(fromUrl) ? fromUrl : "sources"
  })

  const setTab = useCallback(
    (next: string) => {
      const tabKey = (VALID_TABS.includes(next as TabKey) ? next : "sources") as TabKey
      setTabState(tabKey)
      const params = new URLSearchParams(searchParams?.toString() ?? "")
      params.set("tab", tabKey)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  // Selecting a twin mirrors ?twinId= so deep links survive reloads / shares.
  const selectTwin = useCallback(
    (id: string) => {
      setActiveTwinId(id)
      const params = new URLSearchParams(searchParams?.toString() ?? "")
      params.set("twinId", id)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  // The guided wizard creates the twin in step 1, so by the time it finishes
  // the registry row already exists — just select it and land on Sources.
  const handleWizardCreated = useCallback(
    (twin: Twin) => {
      selectTwin(twin.id)
      setTab("sources")
    },
    [selectTwin, setTab]
  )

  const handleAfterDelete = useCallback(
    (_id: string, _result: DeleteTwinResult, name: string) => {
      toast.success(t("twinDeleted", { name }))
    },
    [t]
  )

  // External URL changes (back/forward, shared link opened in same tab)
  // drive the local state — render-time setState gated on a prev tracker.
  const urlTab = searchParams?.get("tab") as TabKey | null
  const [prevUrlTab, setPrevUrlTab] = useState(urlTab)
  if (prevUrlTab !== urlTab) {
    setPrevUrlTab(urlTab)
    if (urlTab && VALID_TABS.includes(urlTab) && urlTab !== tab) {
      setTabState(urlTab)
    }
  }

  // Status-only — the actual job worker runs app-wide via
  // `TwinWorkerInitializer` (mounted in the root layout), so the workbench
  // doesn't start its own loop. This just reports whether that worker is live
  // for the active twin.
  const workerStatus = useTwinWorkerStatus(effectiveTwinId)

  // Rendered ONCE at a stable tree position (always the second child of the
  // shell's center slot, after the branch `<div>`) across every branch below.
  // Creating the first twin flips `effectiveTwinId` null→non-null in the
  // middle of the wizard flow, swapping the empty-state branch for the main
  // branch; keeping the wizard at the same reconciliation position means
  // React PRESERVES it instead of unmounting + remounting it — a remount
  // would reset it to step 1 and orphan the just-created twin.
  const wizard = (
    <TwinCreationWizard
      open={wizardOpen}
      onOpenChange={setWizardOpen}
      onCreated={handleWizardCreated}
    />
  )

  let center: React.ReactNode
  if (twins === undefined) {
    center = (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      </div>
    )
  } else if (!effectiveTwinId) {
    center = (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">{t("noTwinTitle")}</h2>
            <p className="text-muted-foreground text-sm">{t("noTwinHint")}</p>
          </div>
          <Button onClick={() => setWizardOpen(true)} data-testid="twin-empty-create">
            {t("createFirst")}
          </Button>
        </Card>
      </div>
    )
  } else {
    // The tab list is the header's view bar; the body renders the open tab
    // only, so there is no second `Tabs` root to keep in step with it.
    center = (
      <div className="flex h-full flex-col overflow-y-auto p-4 @md/twin:p-6">
        <div className="flex-1 overflow-auto" data-testid={`twin-tab-${tab}`}>
          <AnimatedTabContent tabKey={tab} active={tab}>
            {tab === "sources" ? (
              <TwinSourcesTab twinId={effectiveTwinId} />
            ) : tab === "jobs" ? (
              <TwinJobsTab twinId={effectiveTwinId} />
            ) : tab === "drafts" ? (
              <TwinDraftsTab twinId={effectiveTwinId} />
            ) : tab === "persona" ? (
              <TwinPersonaTab twinId={effectiveTwinId} />
            ) : (
              <TwinSettingsTab twinId={effectiveTwinId} />
            )}
          </AnimatedTabContent>
        </div>
      </div>
    )
  }

  // The twin the header's controls act on: none while loading or empty.
  const headerTwinId = twins !== undefined ? effectiveTwinId : null

  return (
    <FeaturePageShell
      storageId="twin"
      centerClassName="@container/twin"
      header={
        <FeaturePageHeader
          icon={<BotIcon />}
          title={t("title")}
          description={t("description")}
          testId="twin-toolbar"
          status={
            headerTwinId
              ? {
                  label: workerStatus.active ? t("workerActive") : t("workerIdle"),
                  tone: workerStatus.active ? "success" : "neutral",
                  ...(workerStatus.reasonKey
                    ? { title: t(`workerStatus.${workerStatus.reasonKey}`) }
                    : {}),
                  testId: "twin-worker-status",
                }
              : undefined
          }
          tabs={
            headerTwinId
              ? {
                  items: VALID_TABS.map((key) => ({
                    value: key,
                    label: t(`tabs.${key}`),
                    testId: `twin-tab-trigger-${key}`,
                  })),
                  value: tab,
                  onValueChange: setTab,
                  ariaLabel: t("tabsLabel"),
                }
              : undefined
          }
          actions={
            headerTwinId ? (
              <div className="flex min-w-0 items-center gap-2">
                <TwinSelector
                  twins={twinList}
                  activeTwinId={headerTwinId}
                  onSelect={selectTwin}
                  onAfterCreate={(twin) => selectTwin(twin.id)}
                  onAfterDelete={handleAfterDelete}
                  onGuidedCreate={() => setWizardOpen(true)}
                />
                <TwinHeaderPluginSlot twinId={headerTwinId} tab={tab} />
              </div>
            ) : undefined
          }
        />
      }
    >
      {center}
      {wizard}
    </FeaturePageShell>
  )
}

/**
 * Fade tab content in when it becomes the active tab. Suppresses motion when
 * the OS reports `prefers-reduced-motion`. The `key` swap forces a fresh
 * animation each time the user lands on this tab.
 */
function AnimatedTabContent({
  tabKey,
  active,
  children,
}: {
  tabKey: string
  active: string
  children: React.ReactNode
}) {
  const prefersReducedMotion = useReducedMotion()
  if (prefersReducedMotion || tabKey !== active) {
    return <>{children}</>
  }
  return (
    <motion.div
      key={active}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}
