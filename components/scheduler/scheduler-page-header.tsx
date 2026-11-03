"use client"

/**
 * The scheduler's header (ADR-0179 §5).
 *
 * `FeaturePageHeader` in its management variant, the band every feature
 * route uses. `summary` names the host whose schedule is on screen; `status`
 * is the app scheduler's own state, and `context` says when that schedule is
 * suspended or only ticks while the app is open. "Create task" is the split
 * primary action whose menu offers every kind. The host switch and the timing
 * authority wait in a Popover beside the refresh glyph. It used to sit in
 * the header's second (controls) row, which it had to itself: a full band of
 * height spent on one small button, above a pane that is short on height.
 *
 * The breadcrumb leaf that used to repeat the selected item's name is gone:
 * the item's own masthead names it.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  CalendarClockIcon,
  CogIcon,
  DownloadIcon,
  LayoutGridIcon,
  PlugIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react"

import {
  FeaturePageHeader,
  type FeatureHeaderAction,
  type FeatureHeaderStatusTone,
} from "@/components/feature-shell/feature-page-header"
import { SidebarTrigger } from "@/components/ui/sidebar"
import type { SchedulerStatus } from "@/stores/scheduler/scheduler-store"

import {
  SchedulerHostPopover,
  SchedulerHostSummaryLine,
  useSchedulerHostSummary,
} from "./scheduler-host-popover"

export interface SchedulerPageHeaderProps {
  schedulerStatus: SchedulerStatus
  isRefreshing?: boolean
  /** Renders the list-pane toggle; needs a `SidebarProvider` above. */
  showListTrigger?: boolean
  onCreate: () => void
  onCreateSystemTask?: () => void
  onCreateWorkflowTrigger?: () => void
  onOpenBackupSettings?: () => void
  onOpenPluginSettings?: () => void
  onRefresh: () => void
  onExport: () => void
  onImport: () => void
  onOpenTemplates: () => void
  onCleanup: () => void
}

/**
 * The scheduler's own state as the header's one status chip. `running` is the
 * healthy steady state of a service that is on (not a run in progress), so it
 * reads as `success`; a stopped scheduler is the thing to notice.
 */
const STATUS_TONE: Record<SchedulerStatus, FeatureHeaderStatusTone> = {
  running: "success",
  idle: "neutral",
  stopped: "warning",
}

const STATUS_KEY: Record<
  SchedulerStatus,
  "schedulerRunning" | "schedulerIdle" | "schedulerStopped"
> = {
  running: "schedulerRunning",
  idle: "schedulerIdle",
  stopped: "schedulerStopped",
}

export function SchedulerPageHeader({
  schedulerStatus,
  isRefreshing = false,
  showListTrigger = true,
  onCreate,
  onCreateSystemTask,
  onCreateWorkflowTrigger,
  onOpenBackupSettings,
  onOpenPluginSettings,
  onRefresh,
  onExport,
  onImport,
  onOpenTemplates,
  onCleanup,
}: SchedulerPageHeaderProps) {
  const t = useTranslations("scheduler")
  const summary = useSchedulerHostSummary()

  /**
   * The header carries one chip, the scheduler's state. Whether this device's
   * schedule is stood down or only ticks while the app is open is the second
   * fact, so it follows the description as plain text (the popover still
   * shows it as a badge beside the host switch).
   */
  const hostState = summary.suspended ? (
    <span data-testid="scheduler-host-suspended">{t("hostBar.localSuspended")}</span>
  ) : summary.onlyWhileOpen ? (
    <span data-testid="scheduler-host-only-open">{t("hostBar.localOnlyWhileOpen")}</span>
  ) : undefined

  const createMenu: FeatureHeaderAction[] = [
    {
      id: "app",
      label: t("kindFilter.app"),
      icon: CalendarClockIcon,
      onSelect: onCreate,
      testId: "scheduler-new-app-task",
    },
  ]
  if (onCreateWorkflowTrigger) {
    createMenu.push({
      id: "workflow",
      label: t("kindFilter.workflow"),
      icon: WorkflowIcon,
      onSelect: onCreateWorkflowTrigger,
      testId: "scheduler-new-workflow-trigger",
    })
  }
  if (onOpenBackupSettings) {
    createMenu.push({
      id: "backup",
      label: t("kindFilter.backup"),
      icon: ArchiveIcon,
      onSelect: onOpenBackupSettings,
      testId: "scheduler-open-backup-settings",
    })
  }
  if (onOpenPluginSettings) {
    createMenu.push({
      id: "plugin",
      label: t("kindFilter.plugin"),
      icon: PlugIcon,
      onSelect: onOpenPluginSettings,
      testId: "scheduler-open-plugin-settings",
    })
  }
  if (onCreateSystemTask) {
    createMenu.push({
      id: "system",
      label: t("kindFilter.system"),
      icon: CogIcon,
      onSelect: onCreateSystemTask,
      // System tasks are their own group, below the user-facing kinds.
      separatorBefore: true,
      testId: "scheduler-new-system-task",
    })
  }

  return (
    <FeaturePageHeader
      variant="management"
      icon={<CalendarClockIcon />}
      title={t("title")}
      description={t("subtitle")}
      context={hostState}
      breadcrumb={showListTrigger ? <SidebarTrigger className="size-7 shrink-0" /> : undefined}
      summary={<SchedulerHostSummaryLine summary={summary} />}
      status={{
        label: t(STATUS_KEY[schedulerStatus]),
        tone: STATUS_TONE[schedulerStatus],
        testId: "scheduler-status-badge",
      }}
      refresh={{
        label: t("refresh"),
        onSelect: onRefresh,
        busy: isRefreshing,
        testId: "scheduler-refresh-button",
      }}
      // The host switch and timing authority are a popover, not a button.
      actions={<SchedulerHostPopover />}
      overflowLabel={t("moreOptions")}
      overflowActions={[
        {
          id: "templates",
          label: t("templateGallery.title"),
          icon: LayoutGridIcon,
          onSelect: onOpenTemplates,
        },
        { id: "export", label: t("exportTasks"), icon: DownloadIcon, onSelect: onExport },
        { id: "import", label: t("importTasks"), icon: UploadIcon, onSelect: onImport },
        { id: "cleanup", label: t("cleanupOldExecutions"), icon: Trash2Icon, onSelect: onCleanup },
      ]}
      primaryAction={{
        id: "create",
        label: t("createTask"),
        icon: PlusIcon,
        onSelect: onCreate,
        testId: "scheduler-new-task-button",
        menu: createMenu,
        menuLabel: t("createTaskKind"),
      }}
    />
  )
}
