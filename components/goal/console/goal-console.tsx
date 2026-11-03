"use client"

/**
 * The Goals console (`/goals`, ADR-0019).
 *
 *   ┌ header ─ Goals · Overview  History  Analytics  Configure ·  [plugins] [+ New goal] ┐
 *   │ center: one section at a time                     │ inspector: the selected goal │
 *   └───────────────────────────────────────────────────┴──────────────────────────────┘
 *
 * Built on `FeaturePageShell` like the other management routes: the header
 * carries the tabs inline, the center scrolls one section, and a selected goal
 * opens beside the list as the inspector pane (`GoalDetailPanel`) — or, below
 * the shell's desktop tier, as a sheet over it. Selecting from Overview or
 * History does the same thing, where History used to open a modal and the
 * Overview a sheet per card.
 *
 * Where you are is an address: `?tab=` (with `?section=` on Configure) and
 * `?goal=` for the inspector. The console reads them through its props
 * (`location`, `selectedGoalId`) and writes them back with `onNavigate`, so
 * Back closes what a click opened and a scheduler run or a conversation row can
 * link to one goal. Old `?tab=templates|defaults|tracker` links land on the
 * matching Configure panel.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon, TargetIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { useBreakpoint } from "@/hooks/ui"
import { getGoal, listAllGoals, listOpenGoals } from "@/lib/db/goals"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import {
  GOAL_CONSOLE_TABS,
  isGoalConsoleTab,
  type GoalConfigSection as GoalConfigSectionId,
  type GoalConsoleLocation,
  type GoalConsoleTab,
} from "@/lib/goal/console-prefs"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import { useGoalCreate } from "@/hooks/goal/use-goal-create"
import { splitOpenGoals } from "@/lib/goal/overview-filter"

import { GoalAnalyticsPanel } from "../analytics/goal-analytics-panel"
import { GoalDetailPanel } from "../goal-detail-panel"
import { GoalDetailSheet } from "../goal-detail-sheet"
import { GoalQuickCreateDialog } from "../goal-quick-create-dialog"
import { GoalConfigSection } from "./goal-config-section"
import { ALL_GOAL_STATUSES, GoalHistorySection } from "./goal-history-section"
import { GoalOverviewSection } from "./goal-overview-section"

/** Goals read for the lifetime numbers and the charts. */
const ANALYTICS_WINDOW = 500

export interface GoalConsolePlace {
  tab: GoalConsoleTab
  section?: GoalConfigSectionId
  goalId?: string | null
}

export interface GoalConsoleProps {
  /** Tab (and Configure panel) from the address; `null` → the user's default tab. */
  location: GoalConsoleLocation | null
  /** `?goal=` — the goal the inspector shows. */
  selectedGoalId: string | null
  /** Write a new place to the address. `replace` for selection moves. */
  onNavigate: (place: GoalConsolePlace, options?: { replace?: boolean }) => void
}

export function GoalConsole({ location, selectedGoalId, onNavigate }: GoalConsoleProps) {
  const t = useTranslations("goal")
  const { prefs } = useGoalConsolePrefs()
  const overlay = useBreakpoint() !== "desktop"

  const tab = location?.tab ?? prefs.defaultTab
  const section = location?.section ?? "defaults"

  const openGoals = useLiveQuery(() => listOpenGoals(), [])
  const recentGoals = useLiveQuery(() => listAllGoals(ANALYTICS_WINDOW), [])
  const analytics = useMemo(() => computeGoalAnalytics(recentGoals ?? []), [recentGoals])
  const awaitingCount = useMemo(() => splitOpenGoals(openGoals ?? []).awaiting.length, [openGoals])

  // History's status filter lives here so the lifetime strip's "Completed"
  // cell can open History already filtered.
  const [historyStatus, setHistoryStatus] = useState<string>(ALL_GOAL_STATUSES)

  // The header draws "New goal" as its primary button and the dialog opens
  // from it. Same gate the dialog's own trigger used: a phone without the
  // remote-control grant gets no button.
  const goalCreate = useGoalCreate()
  const [createOpen, setCreateOpen] = useState(false)

  const go = useCallback(
    (next: Partial<GoalConsolePlace>, options?: { replace?: boolean }) =>
      onNavigate(
        {
          tab: next.tab ?? tab,
          // A panel only belongs to Configure; other tabs carry none.
          section: (next.tab ?? tab) === "config" ? (next.section ?? section) : undefined,
          goalId: next.goalId === undefined ? selectedGoalId : next.goalId,
        },
        options
      ),
    [onNavigate, tab, section, selectedGoalId]
  )

  const select = useCallback((goalId: string) => go({ goalId }, { replace: true }), [go])
  const clearSelection = useCallback(() => go({ goalId: null }, { replace: true }), [go])
  const dropIfSelected = useCallback(
    (goalId: string) => {
      if (goalId === selectedGoalId) clearSelection()
    },
    [clearSelection, selectedGoalId]
  )

  const header = (
    <FeaturePageHeader
      icon={<TargetIcon />}
      title={t("console.title")}
      description={t("console.subtitle")}
      // Visible from every tab: something is waiting on a verdict. The chip
      // says it in words; the Overview tab carries the same count.
      status={
        awaitingCount > 0
          ? {
              label: t("console.needsYouCount", { count: awaitingCount }),
              tone: "warning",
              title: t("console.needsYouHint"),
              testId: "goal-console-needs-you-badge",
            }
          : undefined
      }
      tabs={{
        ariaLabel: t("console.sectionsAria"),
        value: tab,
        onValueChange: (value) => {
          if (isGoalConsoleTab(value)) go({ tab: value })
        },
        items: GOAL_CONSOLE_TABS.map((id) => ({
          value: id,
          label: t(`console.tabs.${id}`),
          count: id === "overview" && awaitingCount > 0 ? awaitingCount : undefined,
          testId: `goal-console-tab-${id}`,
        })),
      }}
      // Plugin contributions are arbitrary components, not plain buttons.
      actions={
        <PluginExtensionSlot
          point="goal.toolbar"
          className="flex items-center gap-2 empty:hidden"
        />
      }
      primaryAction={
        goalCreate.allowed
          ? {
              id: "new-goal",
              label: t("quickCreate.trigger"),
              icon: PlusIcon,
              onSelect: () => setCreateOpen(true),
              testId: "goal-quick-create-trigger",
            }
          : undefined
      }
      testId="goal-console-header"
    />
  )

  // The inspector beside the list on desktop; a sheet over it below that.
  const inspectorOpen = selectedGoalId !== null && tab !== "config"
  const inspectorPane =
    inspectorOpen && !overlay
      ? {
          label: t("inspector.title"),
          content: (
            <GoalDetailPanel
              key={selectedGoalId}
              goalId={selectedGoalId}
              initialGoal={openGoals?.find((goal) => goal.id === selectedGoalId)}
              onClose={clearSelection}
              onDeleted={clearSelection}
            />
          ),
          defaultSize: 34,
          minSize: 26,
          maxSize: 48,
        }
      : undefined

  const scrollBody = (children: React.ReactNode) => (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl p-4 md:p-6">{children}</div>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-testid="goal-console">
      <FeaturePageShell
        storageId="goals"
        header={header}
        centerClassName="min-h-0"
        rightPane={inspectorPane}
      >
        {tab === "overview" ? (
          scrollBody(
            <GoalOverviewSection
              openGoals={openGoals}
              analytics={analytics}
              analyticsLoading={recentGoals === undefined}
              selectedGoalId={selectedGoalId}
              onSelect={select}
              onDeleted={dropIfSelected}
              onOpenCompleted={() => {
                setHistoryStatus("completed")
                go({ tab: "history" })
              }}
              onOpenAnalytics={() => go({ tab: "analytics" })}
            />
          )
        ) : tab === "history" ? (
          scrollBody(
            <GoalHistorySection
              selectedGoalId={selectedGoalId}
              onSelect={select}
              onDeleted={dropIfSelected}
              statusFilter={historyStatus}
              onStatusFilterChange={setHistoryStatus}
            />
          )
        ) : tab === "analytics" ? (
          scrollBody(
            <GoalAnalyticsPanel goals={recentGoals ?? []} loading={recentGoals === undefined} />
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
            <GoalConfigSection
              section={section}
              onSectionChange={(next) => go({ tab: "config", section: next }, { replace: true })}
            />
          </div>
        )}
      </FeaturePageShell>

      <GoalQuickCreateDialog open={createOpen} onOpenChange={setCreateOpen} showTrigger={false} />

      {inspectorOpen && overlay ? (
        <OverlayInspector goalId={selectedGoalId} onClose={clearSelection} />
      ) : null}
    </div>
  )
}

/** Below the desktop tier: the selected goal as a sheet over the console. */
function OverlayInspector({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const goal = useLiveQuery(() => getGoal(goalId), [goalId])
  if (!goal) return null
  return (
    <GoalDetailSheet
      goal={goal}
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      onDeleted={onClose}
    />
  )
}

GoalConsole.displayName = "GoalConsole"
