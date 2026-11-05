"use client"

/**
 * The issue kanban.
 *
 * A thin shell over `components/board/kanban-board.tsx` and
 * `lib/issues/board-model.ts`: columns, drop resolution, drop preview and
 * legality all come from the model, so the rules are unit-tested without
 * React. Illegal drop targets grey out at drag start (via the board's
 * `isDimmed`) rather than accepting the drop and failing after. Drag, the
 * overlay portal and keyboard movement belong to the shared primitive; the
 * collapsed strip's issue-aware rail is injected through `renderCollapsed`
 * (`./issue-collapsed-rail.tsx`) while the board keeps the droppable shell.
 *
 * SWIMLANES. Grouping by assignee, priority or project draws one row of status
 * columns per group (`buildIssueSwimlanes`), in the list's group order. Each
 * lane is its own `KanbanBoard`, so a card moves between columns inside its
 * lane and never between lanes: a drop changes status and nothing else, the
 * same as the list's grouping, which only shows the field. A reorder carries
 * the card it was dropped on, and the console places it within the whole
 * column, because a lane holds only part of one.
 */

import { useCallback, useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import {
  KanbanBoard,
  type KanbanCollapsedContext,
  type KanbanColumnModel,
  type KanbanDragState,
} from "@/components/board/kanban-board"
import { useIssueGroupLabel } from "@/hooks/issues/use-issue-group-label"
import {
  buildIssueColumns,
  buildIssueSwimlanes,
  columnDropId,
  resolveIssueDrop,
  resolveIssueDropPreview,
  type IssueBoardColumn,
  type IssueDropAction,
  type IssueGroupBy,
} from "@/lib/issues/board-model"
import { allowedIssueMoveTargets } from "@/lib/issues/state-machine"
import type { IssuePlanningHint } from "@/lib/issues/planning-hints"
import type { SquadRunRef } from "@/lib/issues/run/running"
import type { IssueWakeupCue } from "@/lib/issues/wakeups/model"
import { resolveColumnCollapsed, type IssueListDensity } from "@/lib/issues/views"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueStatusIcon, STATUS_COLUMN_TINT } from "../issue-glyphs"
import { buildIssueDndAnnouncements } from "./dnd-announcements"
import { issueCollapsedRail } from "./issue-collapsed-rail"
import { IssueCard, IssueCardVisual } from "./issue-card"

type IssueColumn = KanbanColumnModel<IssueStatus, UnifiedIssueItem>
type IssueDrag = KanbanDragState<UnifiedIssueItem>

export interface IssueBoardProps {
  items: readonly UnifiedIssueItem[]
  /** Label catalogue, for resolving each card's `labelIds`. */
  labelsById?: ReadonlyMap<string, LabelRow>
  /** Delivery-container names, for the card's project chip. */
  projectNamesById?: ReadonlyMap<string, string>
  /** `unifiedId`s with an agent run currently in flight. */
  runningIds?: ReadonlySet<string>
  /** `unifiedId` to the Squad run that owns it, for the card's squad chip. */
  squadRuns?: ReadonlyMap<string, SquadRunRef>
  /** `unifiedId` to its wakeup cue, for the card's wakeup indicator. */
  wakeupCues?: ReadonlyMap<string, IssueWakeupCue>
  /** `unifiedId` to its planning hint (blocked, sub-issues, due). */
  planningHints?: ReadonlyMap<string, IssuePlanningHint>
  /** Per-column collapse overrides. Absent means expanded — columns only collapse explicitly. */
  columnCollapse?: Readonly<Partial<Record<IssueStatus, boolean>>>
  onToggleColumnCollapsed?: (status: IssueStatus) => void
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onDrop?: (action: IssueDropAction) => void
  onAddIssue?: (status: IssueStatus) => void
  /** Wraps each card, so the console can attach the shared context menu. */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
  /**
   * The view's grouping. `assignee`, `priority` and `project` draw swimlanes;
   * `status` and `none` draw the columns once.
   */
  groupBy?: IssueGroupBy
  /** Card size: `compact` drops the label row and tightens the card. */
  density?: IssueListDensity
  /** `actorKey` to display name, for the assignee lanes' headings. */
  assigneeLabels?: ReadonlyMap<string, string>
}

const itemId = (item: UnifiedIssueItem) => item.unifiedId
const itemLabel = (item: UnifiedIssueItem) => item.identifier

export function IssueBoard({
  groupBy = "status",
  density = "comfortable",
  assigneeLabels,
  ...props
}: IssueBoardProps) {
  const t = useTranslations("issues")
  const lanes = useMemo(() => buildIssueSwimlanes(props.items, groupBy), [props.items, groupBy])
  const allColumns = useMemo(
    () => (lanes ? null : buildIssueColumns(props.items)),
    [lanes, props.items]
  )
  const laneLabel = useIssueGroupLabel(groupBy, {
    projectNamesById: props.projectNamesById,
    assigneeLabels,
  })

  if (!lanes) {
    return (
      <IssueLaneBoard
        {...props}
        columns={allColumns ?? []}
        density={density}
        testId="issue-board"
        testIdPrefix="issue"
        className="h-full"
      />
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="issue-board"
      data-group-by={groupBy}
    >
      {lanes.map((lane) => {
        const slug = lane.key || "none"
        const label = laneLabel(lane.key)
        return (
          <section
            key={slug}
            aria-label={t("board.lane", { name: label, count: lane.itemCount })}
            data-testid={`issue-lane-${slug}`}
            className="border-b last:border-b-0"
          >
            <header className="sticky left-0 flex items-center gap-2 px-4 pt-3">
              <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </h2>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid={`issue-lane-${slug}-count`}
              >
                {lane.itemCount}
              </span>
            </header>
            <IssueLaneBoard
              {...props}
              columns={lane.columns}
              density={density}
              testId={`issue-lane-board-${slug}`}
              testIdPrefix={`issue-lane-${slug}`}
            />
          </section>
        )
      })}
    </div>
  )
}

interface IssueLaneBoardProps extends Omit<
  IssueBoardProps,
  "items" | "groupBy" | "density" | "assigneeLabels"
> {
  /** This lane's columns; every item a drop can name is in one of them. */
  columns: readonly IssueBoardColumn[]
  density: IssueListDensity
  testId: string
  testIdPrefix: string
  className?: string
}

/** One row of status columns: the whole board, or one swimlane of it. */
function IssueLaneBoard({
  columns: laneColumns,
  density,
  testId,
  testIdPrefix,
  className,
  labelsById,
  projectNamesById,
  runningIds,
  squadRuns,
  wakeupCues,
  planningHints,
  columnCollapse,
  onToggleColumnCollapsed,
  selectedId,
  onSelect,
  onDrop,
  onAddIssue,
  renderItemMenu,
}: IssueLaneBoardProps) {
  const t = useTranslations("issues")

  const columns = useMemo<IssueColumn[]>(
    () => laneColumns.map((column) => ({ id: column.status, items: column.items })),
    [laneColumns]
  )
  /** Only this lane's items: a drop or preview never reaches into another lane. */
  const itemsById = useMemo(
    () =>
      new Map(laneColumns.flatMap((column) => column.items.map((item) => [item.unifiedId, item]))),
    [laneColumns]
  )

  const isRunning = useCallback(
    (unifiedId: string) => runningIds?.has(unifiedId) ?? false,
    [runningIds]
  )

  const labelsOf = useCallback(
    (item: UnifiedIssueItem) =>
      item.labelIds
        .map((id) => labelsById?.get(id))
        .filter((label): label is LabelRow => Boolean(label)),
    [labelsById]
  )
  const projectNameOf = useCallback(
    (item: UnifiedIssueItem) =>
      item.issueProjectId ? projectNamesById?.get(item.issueProjectId) : undefined,
    [projectNamesById]
  )

  /** Which columns may legally receive the card currently being dragged. */
  const isDimmed = useCallback(
    (column: IssueColumn, drag: IssueDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return false
      return !allowedIssueMoveTargets(active.capabilities, active.status, {
        runActive: isRunning(active.unifiedId),
      }).includes(column.id)
    },
    [isRunning]
  )

  /**
   * Cross-column only: within a column the sortable strategy's own gap already
   * shows the insertion point.
   */
  const insertionIndex = useCallback(
    (column: IssueColumn, drag: IssueDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return null
      const preview = resolveIssueDropPreview(drag.activeId, drag.overId, itemsById, {
        runActive: isRunning(active.unifiedId),
      })
      return preview !== null && preview.status === column.id ? preview.index : null
    },
    [itemsById, isRunning]
  )

  const announcements = useMemo(
    () =>
      buildIssueDndAnnouncements({
        itemsById,
        columnSize: (status) => columns.find((column) => column.id === status)?.items.length ?? 0,
        statusLabel: (status) => t(`status.${status}`),
        preview: (active, over) =>
          resolveIssueDropPreview(active, over, itemsById, { runActive: isRunning(active) }),
        t: (key, values) => t(`board.dnd.${key}`, values),
      }),
    [itemsById, columns, isRunning, t]
  )

  const accessibility = useMemo(
    () => ({ announcements, screenReaderInstructions: { draggable: t("board.dnd.instructions") } }),
    [announcements, t]
  )

  const handleDrop = useCallback(
    (activeId: string, overId: string | null) => {
      const action = resolveIssueDrop(activeId, overId, itemsById, {
        runActive: isRunning(activeId),
      })
      if (action) onDrop?.(action)
    },
    [itemsById, isRunning, onDrop]
  )

  /**
   * The collapsed strip is an issue-aware rail: status glyph + count +
   * priority spine, with the label and clickable item rows in a hover card.
   * The board still owns the droppable `<section>` underneath it.
   */
  const renderCollapsed = useCallback(
    (ctx: KanbanCollapsedContext<IssueStatus, UnifiedIssueItem>) =>
      issueCollapsedRail(ctx, { runningIds, onSelect, renderItemMenu }),
    [runningIds, onSelect, renderItemMenu]
  )

  return (
    <KanbanBoard<IssueStatus, UnifiedIssueItem>
      columns={columns}
      itemId={itemId}
      itemLabel={itemLabel}
      columnLabel={(status) => t(`status.${status}`)}
      dropId={columnDropId}
      renderColumnIcon={(column) => <IssueStatusIcon status={column.id} />}
      columnClassName={(column) => STATUS_COLUMN_TINT[column.id]}
      renderCard={(item) => (
        <IssueCard
          item={item}
          density={density}
          hint={planningHints?.get(item.unifiedId)}
          labels={labelsOf(item)}
          projectName={projectNameOf(item)}
          selected={selectedId === item.unifiedId}
          running={isRunning(item.unifiedId)}
          squadRun={squadRuns?.get(item.unifiedId)}
          wakeupCue={wakeupCues?.get(item.unifiedId)}
          onSelect={onSelect}
        />
      )}
      renderOverlay={(item) => (
        <div className="w-66" data-testid="issue-drag-overlay">
          <IssueCardVisual
            item={item}
            density={density}
            hint={planningHints?.get(item.unifiedId)}
            labels={labelsOf(item)}
            projectName={projectNameOf(item)}
            running={isRunning(item.unifiedId)}
            squadRun={squadRuns?.get(item.unifiedId)}
            wakeupCue={wakeupCues?.get(item.unifiedId)}
            overlay
            draggable
          />
        </div>
      )}
      renderItemMenu={renderItemMenu}
      isCollapsed={(column) => resolveColumnCollapsed(column.id, columnCollapse ?? {})}
      renderCollapsed={renderCollapsed}
      onToggleCollapsed={onToggleColumnCollapsed}
      onAddItem={onAddIssue}
      isDimmed={isDimmed}
      insertionIndex={insertionIndex}
      onDrop={handleDrop}
      emptyText={t("board.empty")}
      accessibility={accessibility}
      testId={testId}
      testIdPrefix={testIdPrefix}
      className={className}
    />
  )
}
