"use client"

import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

/**
 * The `/issues` surface — the total board.
 *
 * Reads through the `IssueSourceRegistry`, not straight from Dexie, so the
 * GitHub mirror and agent-task sources light up by registering an adapter with
 * no change here. Reactivity comes from a Dexie live query on the local table:
 * any local write re-emits, which re-runs the registry fan-out. Federated
 * sources refresh on their own cadence and are picked up by the same fan-out.
 *
 * LAYOUT — three bands, and each one exists because the previous single-slot
 * version broke:
 *
 *   - The RAIL (`leftPane`) owns views, delivery containers and labels. All of
 *     that used to sit in `FeaturePageHeader`'s `controls` slot, which renders
 *     inside `overflow-x-auto` with the scrollbar hidden — so on a narrow
 *     window the view tabs and the create button scrolled off the right edge
 *     with nothing on screen to say they were there.
 *   - The HEADER is back to one row: identity, counts, and the primary action.
 *   - The FILTER BAR sits above the board and, crucially, renders a chip per
 *     engaged filter. A count badge on a closed menu is not evidence.
 *
 * Display preferences live in `stores/issues/issue-view-store.ts`, per view.
 * They used to be `useState`, so leaving the route and coming back reset the
 * board every time.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  getIssueSyncProvidersRevision,
  subscribeIssueSyncProviders,
} from "@/lib/issues/sync/registry"
import { useTranslations } from "next-intl"
import { CircleDotIcon, PanelLeftIcon, PlusIcon, RefreshCwIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

import {
  FeaturePageHeader,
  type FeatureHeaderStatus,
} from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { useBreakpoint } from "@/hooks/ui"
import { useIssueSyncAvailability } from "./kept-copy-source-state"
import { useAssigneeOptions } from "@/hooks/issues/use-assignee-options"
import { collabSelfUserIdOf, useCollabSelf } from "@/hooks/issues/use-collab-self"
import { useIssueSelection } from "@/hooks/issues/use-issue-selection"
import { useIssueShortcuts } from "@/hooks/issues/use-issue-shortcuts"
import { useUnifiedIssues } from "@/hooks/issues/use-unified-issues"
import { moveIssueRecord, reorderIssueRecords } from "@/lib/issues/service"
import { followQueuedCreate } from "@/lib/issues/shared-create"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { buildPlanningHints } from "@/lib/issues/planning-hints"
import { cycleProgress } from "@/lib/issues/project-progress"
import { listLabels } from "@/lib/db/labels"
import {
  actorKey,
  applyIssueFilter,
  buildIssueColumns,
  buildIssueGroups,
  issueRunHint,
  reorderIssueColumn,
  type IssueBoardFilter,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import {
  applyIssueBulkAction,
  canApplyBulkAction,
  type BulkActionContext,
  type IssueBulkAction,
} from "@/lib/issues/bulk-actions"
import { buildIssueLabelCatalogue } from "@/lib/issues/github-label-display"
import { computeProgressFromIssues } from "@/lib/issues/project-progress"
import {
  listRunningIssueIds,
  listSquadRunsByIssue,
  loadIssueViewerContext,
  SELF_ACTOR_KEY,
  type SquadRunRef,
} from "@/lib/issues/run/running"
import { summarizeWakeupCues, type IssueWakeupCue } from "@/lib/issues/wakeups/model"
import { listWorkspaceIssueWakeups } from "@/lib/issues/wakeups/service"
import { getGithubEventIssueRefresher } from "@/lib/issues/github-event-refresh"
import { isSyncedResource } from "@/lib/issues/sync/bindings"
import { summarizeSync, syncSummaryMessage } from "@/lib/issues/sync/describe"
import { runWorkspaceIssueSync } from "@/lib/issues/sync/runner"
import { setSoleFilterValue, toggleFilterValue } from "@/lib/issues/filter-chips"
import {
  applyIssueSort,
  applyViewScope,
  BUILTIN_ISSUE_VIEWS,
  countIssuesPerView,
  findIssueView,
  resolveIssueViewPreferences,
  type IssueViewerContext,
} from "@/lib/issues/views"
import { useIssueViewStore } from "@/stores/issues/issue-view-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueCycle, IssueActor, IssueStatus } from "@/types/issues"
import type { IssueSourceKind, UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, parseUnifiedIssueId } from "@/types/issues/unified"
import { DeleteIssueDialog } from "./delete-issue-dialog"
import { IssueContextMenu } from "./issue-context-menu"
import { IssueBoard } from "./board/issue-board"
import { IssueFilterBar } from "./filter-bar/issue-filter-bar"
import { IssueBulkToolbar } from "./list/issue-bulk-toolbar"
import { IssueList } from "./list/issue-list"
import { ManageLabelsDialog } from "./rail/manage-labels-dialog"
import { ManageCyclesDialog } from "./rail/manage-cycles-dialog"
import { useTrackerHeaderTabs } from "./tracker-tabs"
import { IssueRail } from "./rail/issue-rail"
import { IssueDetailPanel } from "./issue-detail-panel"
import { CreateIssuePage } from "./create-issue-page"
import { CollabConflictsPanel } from "./collab-conflicts-panel"
import { SyncConflictsPanel } from "./sync-conflicts-panel"
import { ImportIssuesDialog } from "./import/import-issues-dialog"
import { useCollabRefreshStale } from "./collab-refresh-stale-badge"

/** Stable empty reference, so the no-workspace path cannot churn memos. */
const EMPTY_ITEMS: UnifiedIssueItem[] = []

/**
 * The local human has no id — see `IssueActor`. `agentKeys` is filled in from
 * the Character table and the AgentTeam store at runtime
 * (`loadIssueViewerContext`); this is only the pre-load value.
 */
const INITIAL_VIEWER: IssueViewerContext = { selfKey: SELF_ACTOR_KEY, agentKeys: [] }

export interface IssueConsoleProps {
  /** Deep-linked issue (`/issues?id=…`), since a static export has no `[id]`. */
  initialSelectedId?: string
  /**
   * Which source the deep-linked id belongs to (`/issues?…&source=…`). Absent
   * means a local issue; a collaboration notification (ADR-0207) names
   * `collab`, whose ids look the same as local ones.
   */
  initialSelectedSource?: IssueSourceKind
  /**
   * Deep-linked container filter (`/issues?project=…`), which is what the
   * projects console's "view these issues" produces.
   */
  initialProjectId?: string
  /** Deep-linked cycle (`/issues?cycle=…`), from the Cycles tab. */
  initialCycleId?: string
  /**
   * Deep-linked assignee (`/issues?assignee=agent:…`), an `actorKey`; what an
   * agent's profile produces for "view in Issues".
   */
  initialAssignee?: string
}

export function IssueConsole({
  initialSelectedId,
  initialSelectedSource,
  initialProjectId,
  initialCycleId,
  initialAssignee,
}: IssueConsoleProps) {
  const t = useTranslations("issues")
  useSyncExternalStore(
    subscribeIssueSyncProviders,
    getIssueSyncProvidersRevision,
    getIssueSyncProvidersRevision
  )
  const projectId = useProjectStore((s) => s.activeProjectId)

  const viewId = useIssueViewStore((s) => s.viewId)
  const overrides = useIssueViewStore((s) => s.overrides[s.viewId])
  const railCollapsed = useIssueViewStore((s) => s.railCollapsed)
  const setViewId = useIssueViewStore((s) => s.setViewId)
  const setRailCollapsed = useIssueViewStore((s) => s.setRailCollapsed)
  // Collapsing is a column's affordance. Below `lg` the shell turns the rail
  // into a drawer with its own trigger at the head of the header, so the
  // collapse toggle would be a second control for the same pane, and a
  // collapsed rail would take the drawer's trigger away with it.
  const railIsColumn = useBreakpoint() === "desktop"
  const railShown = !railIsColumn || !railCollapsed
  const setFilter = useIssueViewStore((s) => s.setFilter)
  const setLayout = useIssueViewStore((s) => s.setLayout)
  const setGroupBy = useIssueViewStore((s) => s.setGroupBy)
  const setSort = useIssueViewStore((s) => s.setSort)
  const setDensity = useIssueViewStore((s) => s.setDensity)
  const toggleColumnCollapsed = useIssueViewStore((s) => s.toggleColumnCollapsed)
  const resetView = useIssueViewStore((s) => s.resetView)

  const view = findIssueView(viewId) ?? BUILTIN_ISSUE_VIEWS[0]
  const prefs = useMemo(() => resolveIssueViewPreferences(view, overrides), [view, overrides])

  /**
   * Apply `?project=` once, then never again.
   *
   * It writes to the persisted view store rather than to React state, so it
   * has to be a one-shot: re-applying on every render would make the container
   * filter impossible to take off. The ref is written inside the effect, not
   * during render.
   */
  const deepLinkApplied = useRef(false)
  useEffect(() => {
    if (deepLinkApplied.current || (!initialProjectId && !initialCycleId && !initialAssignee)) {
      return
    }
    deepLinkApplied.current = true
    const current = useIssueViewStore.getState()
    const active = resolveIssueViewPreferences(
      findIssueView(current.viewId) ?? BUILTIN_ISSUE_VIEWS[0],
      current.overrides[current.viewId]
    )
    let filter = active.filter
    if (initialProjectId) filter = setSoleFilterValue(filter, "issueProjectIds", initialProjectId)
    if (initialCycleId) filter = setSoleFilterValue(filter, "cycleIds", initialCycleId)
    if (initialAssignee) filter = setSoleFilterValue(filter, "assignees", initialAssignee)
    current.setFilter(current.viewId, filter)
  }, [initialProjectId, initialCycleId, initialAssignee])

  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelectedId
      ? makeUnifiedIssueId(initialSelectedSource ?? "local", initialSelectedId)
      : undefined
  )

  /**
   * A shared-workspace create is queued before the server names the issue, so
   * it is followed to delivery and opened then — unless the person has moved
   * on to another issue meanwhile, which a late jump would yank them out of.
   * The ref mirrors the selection for the subscription; written in an effect,
   * not during render.
   */
  const selectedIdRef = useRef(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  const sharedCreateFollows = useRef(new Set<() => void>())
  useEffect(() => {
    const follows = sharedCreateFollows.current
    return () => {
      for (const stop of follows) stop()
      follows.clear()
    }
  }, [])
  const followSharedCreate = useCallback(
    (operationId: string) => {
      toast.info(t("create.sharedQueued"))
      const selectedAtQueue = selectedIdRef.current
      const stop = followQueuedCreate(operationId, (outcome) => {
        sharedCreateFollows.current.delete(stop)
        if (outcome.kind !== "delivered") return
        if (selectedIdRef.current !== selectedAtQueue) return
        setSelectedId(makeUnifiedIssueId("collab", outcome.entityId))
      })
      sharedCreateFollows.current.add(stop)
    },
    [t]
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const projects = useClientLiveQuery(
    () => (projectId ? listIssueProjects({ projectId }) : Promise.resolve([])),
    [projectId],
    []
  )
  const labels = useClientLiveQuery(() => listLabels("issue"), [], [])
  const cycles = useClientLiveQuery(
    () => (projectId ? listIssueCycles({ projectId }) : Promise.resolve([])),
    [projectId],
    [] as IssueCycle[]
  )

  /**
   * Every source's rows, live. One subscription feeds the board, the counts,
   * progress and the conflicts panel, so a federated change (an Agent Team
   * task moving, a collaboration pull, a mirror refresh) reaches all of them
   * without a local write to wake it.
   */
  const unified = useUnifiedIssues(projectId ?? undefined)
  const sourceErrors = unified.errors.length
  /** Who counts as "my agents and squads" — every local Character and AgentTeam. */
  const [viewer, setViewer] = useState<IssueViewerContext>(INITIAL_VIEWER)
  /** Local issue ids with an active run — the "N agents working" pill. */
  const runningIds = useClientLiveQuery(
    () => (projectId ? listRunningIssueIds(projectId) : Promise.resolve(new Set<string>())),
    [projectId],
    new Set<string>()
  )
  /** Local issue id to the Squad run that owns it, for the board's squad chip. */
  const squadRuns = useClientLiveQuery(
    () =>
      projectId ? listSquadRunsByIssue(projectId) : Promise.resolve(new Map<string, SquadRunRef>()),
    [projectId],
    new Map<string, SquadRunRef>()
  )
  /**
   * Local issue id to its wakeup cue. Wakeups are scheduler rows in the same
   * database, so this live query follows a rule pausing itself mid-session.
   */
  const wakeupCues = useClientLiveQuery(
    async () =>
      projectId
        ? summarizeWakeupCues(await listWorkspaceIssueWakeups(projectId))
        : new Map<string, IssueWakeupCue>(),
    [projectId],
    new Map<string, IssueWakeupCue>()
  )
  useEffect(() => {
    let cancelled = false
    void loadIssueViewerContext()
      .then((context) => {
        if (!cancelled) setViewer(context)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId])

  /** Federated rows are only meaningful inside a workspace. */
  const visibleFederated = projectId ? unified.items : EMPTY_ITEMS
  /** The local source's rows: progress, cycle tallies and identifiers count only these. */
  const localItems = useMemo(
    () => visibleFederated.filter((item) => item.kind === "local"),
    [visibleFederated]
  )

  /**
   * Local labels PLUS ephemeral rows for GitHub's namespaced ids. Without the
   * second half, `github:bug` resolved to nothing, every chip was filtered out
   * and the filter menu showed the user the literal id.
   */
  const labelsById = useMemo(
    () => buildIssueLabelCatalogue(labels ?? [], visibleFederated),
    [labels, visibleFederated]
  )
  /**
   * The rail's label list is the MERGED catalogue: filtering by a GitHub label
   * is legitimate, so its projections belong here.
   */
  const railLabels = useMemo(
    () => [...labelsById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [labelsById]
  )
  /**
   * Every WRITE menu gets local labels only. A GitHub projection is not a row
   * in the `labels` table, so offering to apply one would write a synthetic
   * `github:<name>` id into a local issue's `labelIds` — an id that resolves
   * only while that GitHub issue happens to be on the board.
   */
  const writableLabels = useMemo(
    () => [...(labels ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [labels]
  )
  const projectNamesById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects]
  )
  const cyclesById = useMemo(
    () => new Map((cycles ?? []).map((cycle) => [cycle.id, cycle])),
    [cycles]
  )
  const cycleNamesById = useMemo(
    () => new Map((cycles ?? []).map((cycle) => [cycle.id, cycle.name])),
    [cycles]
  )

  const scoped = useMemo(
    () => applyViewScope(visibleFederated, view.scope, viewer),
    [visibleFederated, view.scope, viewer]
  )
  const filtered = useMemo(() => applyIssueFilter(scoped, prefs.filter), [scoped, prefs.filter])
  const sorted = useMemo(() => applyIssueSort(filtered, prefs.sort), [filtered, prefs.sort])

  const runHint = useMemo(
    () =>
      issueRunHint(
        sorted,
        // `issueRunHint` keys on `unifiedId`; the run index holds local issue ids.
        new Set([...(runningIds ?? [])].map((id) => makeUnifiedIssueId("local", id)))
      ),
    [sorted, runningIds]
  )

  const trackerTabs = useTrackerHeaderTabs("issues")
  const collabStale = useCollabRefreshStale()
  /**
   * The header draws one status chip, so the board's states are ranked: a
   * source that failed to load outranks a stale mirror, which outranks agents
   * at work. Whatever is left follows the description, so nothing goes unsaid.
   */
  const headerFacts: FeatureHeaderStatus[] = [
    ...(sourceErrors > 0
      ? [
          {
            label: t("source.degraded", { count: sourceErrors }),
            tone: "danger" as const,
            testId: "issue-source-errors",
          },
        ]
      : []),
    ...(collabStale
      ? [{ label: t("freshness.stale"), tone: "warning" as const, testId: "collab-refresh-stale" }]
      : []),
    ...(runHint.running > 0
      ? [
          {
            label: t("board.agentsWorking", { count: runHint.running }),
            tone: "active" as const,
            testId: "issue-agents-working",
          },
        ]
      : []),
  ]
  const [headerStatus, ...headerContextFacts] = headerFacts
  const headerContext =
    headerContextFacts.length > 0 ? (
      <span className="inline-flex items-center gap-1.5" data-testid="issue-header-context">
        {headerContextFacts.map((fact, index) => (
          <span key={fact.testId} className="inline-flex items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <span data-testid={fact.testId}>{fact.label}</span>
          </span>
        ))}
      </span>
    ) : undefined
  /** The board and the list both speak `unifiedId`; the run index does not. */
  const runningUnifiedIds = useMemo(
    () => new Set([...(runningIds ?? [])].map((id) => makeUnifiedIssueId("local", id))),
    [runningIds]
  )
  const squadRunsByUnifiedId = useMemo(
    () =>
      new Map(
        [...(squadRuns ?? [])].map(([id, ref]) => [makeUnifiedIssueId("local", id), ref] as const)
      ),
    [squadRuns]
  )
  const wakeupCuesByUnifiedId = useMemo(
    () =>
      new Map(
        [...(wakeupCues ?? [])].map(([id, cue]) => [makeUnifiedIssueId("local", id), cue] as const)
      ),
    [wakeupCues]
  )
  const groups = useMemo(() => buildIssueGroups(sorted, prefs.groupBy), [sorted, prefs.groupBy])

  /** Rail tallies come from the unfiltered scope — a filter must not hide its own count. */
  const viewCounts = useMemo(
    () => countIssuesPerView(visibleFederated, viewer),
    [visibleFederated, viewer]
  )
  /**
   * `actorKey` → cached display name, for the list's assignee group headings
   * and anywhere else a bare key would otherwise surface.
   */
  const assigneeLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const item of scoped) {
      const key = actorKey(item.assignee)
      if (key && item.assignee && !labels.has(key)) {
        labels.set(key, item.assignee.label ?? t(`actor.${item.assignee.kind}`))
      }
    }
    return labels
  }, [scoped, t])
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of scoped) {
      for (const labelId of item.labelIds) counts.set(labelId, (counts.get(labelId) ?? 0) + 1)
    }
    return counts
  }, [scoped])
  const projectProgress = useMemo(
    () =>
      computeProgressFromIssues(
        (projects ?? []).map((project) => project.id),
        localItems
      ),
    [projects, localItems]
  )
  /** Blocked, sub-issue progress and due state, once per board pass. */
  const planningHints = useMemo(
    () => buildPlanningHints(visibleFederated, cyclesById),
    [visibleFederated, cyclesById]
  )
  const cycleTallies = useMemo(
    () =>
      new Map(
        (cycles ?? []).map((cycle) => [cycle.id, cycleProgress(cycle.id, localItems)] as const)
      ),
    [cycles, localItems]
  )

  const selected = sorted.find((item) => item.unifiedId === selectedId)
  /**
   * Repos bound to the selected issue's own container. Scoped rather than
   * workspace-wide because the GitHub loop runs against the container's repo,
   * so offering another container's would produce a ref the adapter refuses.
   */
  const selectedGithubRepos = useMemo(() => {
    if (!selected?.issueProjectId) return []
    const container = (projects ?? []).find((project) => project.id === selected.issueProjectId)
    return (container?.resources ?? [])
      .filter((resource) => resource.kind === "github-repo")
      .map((resource) => resource.repoFullName)
  }, [selected, projects])

  /**
   * The rows a bulk action would reach, in display order. Built from the same
   * `groups` the list renders so shift-range selects what the eye sees rather
   * than what an unrendered sort produced.
   */
  const orderedIds = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => item.unifiedId)),
    [groups]
  )
  const selection = useIssueSelection(orderedIds)
  const assigneeOptions = useAssigneeOptions()
  const knownAssigneeLabels = useMemo(
    () =>
      new Map(
        assigneeOptions.map((option) => [
          option.key,
          option.actor.label ?? t(`actor.${option.actor.kind}`),
        ])
      ),
    [assigneeOptions, t]
  )
  const itemsById = useMemo(() => new Map(sorted.map((item) => [item.unifiedId, item])), [sorted])
  const checkedItems = useMemo(
    () =>
      [...selection.selectedIds]
        .map((id) => itemsById.get(id))
        .filter((item): item is UnifiedIssueItem => Boolean(item)),
    [selection.selectedIds, itemsById]
  )
  const [deleteTargets, setDeleteTargets] = useState<readonly UnifiedIssueItem[]>([])
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false)
  const [manageCyclesOpen, setManageCyclesOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const syncAvailability = useIssueSyncAvailability(projects)
  /** Any container bound to something the sync engine or the mirror refreshes. */
  const hasSyncedBinding = (projects ?? []).some((project) =>
    project.resources.some(isSyncedResource)
  )
  /** Local issue id to its printed identifier, for the conflicts panel. */
  const identifiersById = useMemo(
    () => new Map(localItems.map((item) => [item.sourceId, item.identifier])),
    [localItems]
  )

  /**
   * One button for every binding: the GitHub mirror, imported repositories,
   * Lark tasklists and Bitables. Bypasses the watermark, because the reason a
   * user reaches for it is almost always a suspicion that the incremental
   * path missed something.
   */
  async function syncNow() {
    if (!projectId || syncAvailability.reason) return
    setSyncing(true)
    try {
      const result = await runWorkspaceIssueSync({
        projectId,
        full: true,
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      })
      const { level, message } = syncSummaryMessage(summarizeSync(result), t)
      toast[level](message)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
    }
  }

  const [createOpen, setCreateOpen] = useState(false)
  const [createStatus, setCreateStatus] = useState<IssueStatus>("backlog")
  /** Set when "Add sub-issue" opened the dialog; cleared when it closes. */
  const [createParent, setCreateParent] = useState<
    { id: string; identifier: string; issueProjectId: string } | undefined
  >(undefined)
  const openCreate = useCallback((status: IssueStatus = "backlog") => {
    setCreateParent(undefined)
    setCreateStatus(status)
    setCreateOpen(true)
  }, [])
  const openCreateSubIssue = useCallback((parent: UnifiedIssueItem) => {
    if (parent.kind !== "local" || !parent.issueProjectId) return
    setCreateParent({
      id: parent.sourceId,
      identifier: parent.identifier,
      issueProjectId: parent.issueProjectId,
    })
    setCreateStatus("backlog")
    setCreateOpen(true)
  }, [])

  useIssueShortcuts({
    create: () => {
      if (projectId) openCreate()
    },
    focusSearch: () => searchRef.current?.focus(),
    next: () => selection.moveCursor(1),
    previous: () => selection.moveCursor(-1),
    open: () => {
      if (selection.cursorId) setSelectedId(selection.cursorId)
    },
    toggleSelect: () => {
      if (selection.cursorId) selection.toggle(selection.cursorId)
    },
    clearSelection: () => {
      if (selection.selectedIds.size > 0) selection.clear()
      else setSelectedId(undefined)
    },
  })

  const updateFilter = useCallback(
    (next: IssueBoardFilter) => setFilter(viewId, next),
    [setFilter, viewId]
  )

  /**
   * Run one action over a set of issues and say what actually happened.
   *
   * The outcome is reported rather than assumed: a selection mixing local and
   * GitHub rows cannot all be written, and "12 updated" when four were skipped
   * is a claim the user has no way to check.
   */
  // Who "Me" is on a shared board; shared rows refuse an assignee the
  // collaboration plane cannot name (ADR-0149 §10).
  const collabSelfUserId = collabSelfUserIdOf(useCollabSelf())
  const bulkContext = useMemo<BulkActionContext>(
    () => (collabSelfUserId === undefined ? {} : { collabSelfUserId }),
    [collabSelfUserId]
  )

  const runBulk = useCallback(
    async (targets: readonly UnifiedIssueItem[], action: IssueBulkAction) => {
      const by: IssueActor = { kind: "human" }
      // A shared-actor refusal is a skip without a state-machine reason, so
      // name it here when it is why nothing landed.
      const collabRefusal = targets
        .map((item) =>
          canApplyBulkAction(item, action, runningUnifiedIds.has(item.unifiedId), bulkContext)
        )
        .find((verdict) => !verdict.ok && verdict.reason === "collab-actor")
      const outcome = await applyIssueBulkAction(
        targets,
        action,
        by,
        runningUnifiedIds,
        bulkContext
      )
      if (outcome.failed > 0) {
        toast.error(t("bulk.failed", { count: outcome.failed }))
      } else if (outcome.applied === 0) {
        // Nothing landed: explain with the guard's own reason when there is one.
        toast.error(
          outcome.reason
            ? t(`board.denied.${outcome.reason}`, { source: t("source.local") })
            : collabRefusal && !collabRefusal.ok && collabRefusal.reason === "collab-actor"
              ? t(`assignee.sharedRefusal.${collabRefusal.refusal}`)
              : t("bulk.nothing")
        )
      } else if (outcome.skipped > 0) {
        toast.warning(t("bulk.skipped", { count: outcome.applied, skipped: outcome.skipped }))
      } else {
        toast.success(t("bulk.applied", { count: outcome.applied }))
      }
    },
    [runningUnifiedIds, bulkContext, t]
  )

  /**
   * The shared right-click menu, wrapped around every row and every card. One
   * menu, one action vocabulary (`IssueBulkAction`) and one capability gate,
   * whether it fires on a single issue or on a selection.
   */
  const renderItemMenu = useCallback(
    (item: UnifiedIssueItem, children: ReactNode) => (
      <IssueContextMenu
        key={item.unifiedId}
        item={item}
        running={runningUnifiedIds.has(item.unifiedId)}
        labels={writableLabels}
        projects={projects ?? []}
        assigneeOptions={assigneeOptions}
        cycles={cycles ?? []}
        collabSelfUserId={collabSelfUserId}
        onAction={(action) => void runBulk([item], action)}
        onOpen={() => setSelectedId(item.unifiedId)}
        onRequestDelete={() => setDeleteTargets([item])}
      >
        {children}
      </IssueContextMenu>
    ),
    [
      runningUnifiedIds,
      writableLabels,
      projects,
      assigneeOptions,
      cycles,
      collabSelfUserId,
      runBulk,
    ]
  )

  /**
   * Pull the change we just made back down from GitHub; the mirror write it
   * makes reaches the board through the GitHub source's subscription.
   * Round-tripping rather than patching the row locally is
   * deliberate: GitHub is the source of truth for these rows, and a local
   * optimistic edit would be a second one. Only the written repository is
   * read, from its checkpoint (D20), not the whole workspace.
   */
  async function handleWritebackCompleted(repoFullName: string) {
    // The write itself already landed; a refresh that fails only leaves the
    // mirror stale until the next sync, which the person should know.
    await getGithubEventIssueRefresher()
      .refreshAfterWrite(repoFullName, { localAuthorization: LOCAL_PERSON_RUN })
      .catch((cause: unknown) =>
        toast.warning(
          t("writeback.refreshFailed", {
            error: cause instanceof Error ? cause.message : String(cause),
          })
        )
      )
  }

  /**
   * Apply a board drop. Denials come back from the pure reducer already
   * classified, so this only has to localize them — the legality decision was
   * made in `lib/issues/board-model.ts`, and `moveIssue` re-checks it at the
   * write boundary so an IM callback or a stale drag can't slip past.
   */
  async function handleDrop(action: IssueDropAction) {
    if (action.type === "denied") {
      const item = sorted.find((candidate) => candidate.unifiedId === action.unifiedId)
      toast.error(
        t(`board.denied.${action.reason}`, {
          source: item ? t(`source.${item.kind}`) : t("source.local"),
        })
      )
      return
    }

    const parsed = parseUnifiedIssueId(action.unifiedId)
    if (parsed?.kind !== "local") return

    if (action.type === "move") {
      try {
        const denial = await moveIssueRecord({
          id: parsed.sourceId,
          to: action.to,
          by: { kind: "human" },
        })
        if (denial && denial !== "issue-not-found") {
          toast.error(t(`board.denied.${denial}`, { source: t("source.local") }))
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      }
      return
    }

    const item = sorted.find((candidate) => candidate.unifiedId === action.unifiedId)
    if (!item) return
    // The whole column, not the lane the drop happened in: a swimlane shows
    // a slice of it, and the order written must place the card among all of it.
    const column = buildIssueColumns(sorted).find((candidate) => candidate.status === item.status)
    if (!column) return
    const targetIndex = column.items.findIndex(
      (candidate) => candidate.unifiedId === action.overUnifiedId
    )
    if (targetIndex === -1) return
    try {
      await reorderIssueRecords(reorderIssueColumn(column.items, action.unifiedId, targetIndex))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Shared props for the `CreateIssuePage` surface. */
  const createSurfaceProps = {
    open: createOpen,
    onOpenChange: (open: boolean) => {
      setCreateOpen(open)
      if (!open) setCreateParent(undefined)
    },
    projectId: projectId ?? "",
    projects: projects ?? [],
    status: createStatus,
    parent: createParent,
    onCreated: (issueId: string) => setSelectedId(makeUnifiedIssueId("local", issueId)),
    onSharedQueued: followSharedCreate,
  }

  return (
    <FeaturePageShell
      storageId="issues"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<CircleDotIcon />}
          title={t("title")}
          description={t("pageDescription")}
          context={headerContext}
          summary={t("summary", { count: sorted.length })}
          tabs={trackerTabs}
          status={headerStatus}
          // A leading pane toggle, where Devices and Scheduler draw theirs.
          breadcrumb={
            railIsColumn ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={railCollapsed ? t("rail.show") : t("rail.hide")}
                title={railCollapsed ? t("rail.show") : t("rail.hide")}
                aria-pressed={!railCollapsed}
                onClick={() => setRailCollapsed(!railCollapsed)}
                data-testid="issue-rail-toggle"
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            ) : undefined
          }
          primaryAction={{
            id: "create",
            label: t("create.trigger"),
            icon: PlusIcon,
            onSelect: () => openCreate(),
            disabled: !projectId,
            testId: "issue-create-trigger",
          }}
          secondaryActions={[
            {
              id: "import",
              label: t("import.trigger"),
              icon: UploadIcon,
              onSelect: () => setImportOpen(true),
              disabled: !projectId || (projects ?? []).length === 0,
              testId: "issue-import-trigger",
            },
            {
              id: "sync",
              label: syncAvailability.reason
                ? t(syncAvailability.reason)
                : syncing
                  ? t("sync.running")
                  : t("sync.now"),
              icon: RefreshCwIcon,
              onSelect: () => void syncNow(),
              disabled: !projectId || syncing || !hasSyncedBinding || !syncAvailability.canSync,
              testId: "issue-sync-now",
            },
          ]}
        />
      }
      leftPane={
        !railShown
          ? undefined
          : {
              label: t("rail.label"),
              content: (
                <IssueRail
                  viewId={viewId}
                  viewCounts={viewCounts}
                  onSelectView={setViewId}
                  projects={projects ?? []}
                  projectProgress={projectProgress}
                  activeProjectIds={prefs.filter.issueProjectIds}
                  onToggleProject={(id) =>
                    updateFilter(toggleFilterValue(prefs.filter, "issueProjectIds", id))
                  }
                  labels={railLabels}
                  labelCounts={labelCounts}
                  activeLabelIds={prefs.filter.labelIds}
                  onToggleLabel={(id) =>
                    updateFilter(toggleFilterValue(prefs.filter, "labelIds", id))
                  }
                  onManageLabels={() => setManageLabelsOpen(true)}
                  cycles={cycles ?? []}
                  cycleProgress={cycleTallies}
                  activeCycleIds={prefs.filter.cycleIds ?? []}
                  onToggleCycle={(id) =>
                    updateFilter(toggleFilterValue(prefs.filter, "cycleIds", id))
                  }
                  onManageCycles={() => setManageCyclesOpen(true)}
                />
              ),
            }
      }
      rightPane={
        selected
          ? {
              label: t("detail.properties"),
              // Below `lg` this pane is a Sheet, and an uncontrolled Sheet only
              // opens from its own trigger, so selecting a card in a narrow
              // window used to tick the row and show nothing. The pane exists
              // only while something is selected, so "selected" IS "open", and
              // dismissing the overlay is how that window says "done with this
              // one".
              open: true,
              onOpenChange: (open: boolean) => {
                if (!open) setSelectedId(undefined)
              },
              content: (
                <IssueDetailPanel
                  item={selected}
                  collabSelfUserId={collabSelfUserId}
                  labelsById={labelsById}
                  projectNamesById={projectNamesById}
                  labels={writableLabels}
                  projects={projects ?? []}
                  assigneeOptions={assigneeOptions}
                  cycles={cycles ?? []}
                  items={visibleFederated}
                  onOpenIssue={setSelectedId}
                  onCreateSubIssue={() => openCreateSubIssue(selected)}
                  running={runningUnifiedIds.has(selected.unifiedId)}
                  githubRepos={selectedGithubRepos}
                  onAction={(action) => void runBulk([selected], action)}
                  onRequestDelete={() => setDeleteTargets([selected])}
                  onClose={() => setSelectedId(undefined)}
                  onWritebackCompleted={handleWritebackCompleted}
                />
              ),
            }
          : undefined
      }
      centerClassName="min-h-0"
    >
      <IssueFilterBar
        items={scoped}
        filter={prefs.filter}
        onFilterChange={updateFilter}
        layout={prefs.layout}
        onLayoutChange={(layout) => setLayout(viewId, layout)}
        groupBy={prefs.groupBy}
        onGroupByChange={(groupBy) => setGroupBy(viewId, groupBy)}
        sort={prefs.sort}
        onSortChange={(sort) => setSort(viewId, sort)}
        density={prefs.density}
        onDensityChange={(density) => setDensity(viewId, density)}
        onResetView={() => resetView(viewId)}
        labelsById={labelsById}
        projectNamesById={projectNamesById}
        cycleNamesById={cycleNamesById}
        knownAssigneeLabels={knownAssigneeLabels}
        searchRef={searchRef}
      />

      <IssueBulkToolbar
        items={checkedItems}
        runningIds={runningUnifiedIds}
        labels={writableLabels}
        projects={projects ?? []}
        assigneeOptions={assigneeOptions}
        cycles={cycles ?? []}
        bulkContext={bulkContext}
        onAction={(action) => void runBulk(checkedItems, action)}
        onRequestDelete={() => setDeleteTargets(checkedItems)}
        onToggleAll={selection.toggleAll}
        visibleCount={orderedIds.length}
        onClear={selection.clear}
      />

      {prefs.layout === "board" ? (
        <IssueBoard
          items={sorted}
          groupBy={prefs.groupBy}
          density={prefs.density}
          assigneeLabels={assigneeLabels}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          runningIds={runningUnifiedIds}
          squadRuns={squadRunsByUnifiedId}
          wakeupCues={wakeupCuesByUnifiedId}
          planningHints={planningHints}
          columnCollapse={prefs.columnCollapse}
          onToggleColumnCollapsed={(status) => toggleColumnCollapsed(viewId, status)}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDrop={handleDrop}
          onAddIssue={openCreate}
          renderItemMenu={renderItemMenu}
        />
      ) : (
        <IssueList
          groups={groups}
          groupBy={prefs.groupBy}
          density={prefs.density}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          runningIds={runningUnifiedIds}
          planningHints={planningHints}
          assigneeLabels={assigneeLabels}
          selectedId={selectedId}
          onSelect={(id) => {
            // Clicking a row also moves the keyboard cursor, so `j`/`k`
            // continue from where the eye already is rather than from the top.
            selection.setCursorId(id)
            setSelectedId(id)
          }}
          checkedIds={selection.selectedIds}
          onToggleCheck={(id, modifiers) =>
            modifiers.shiftKey ? selection.extendTo(id) : selection.toggle(id)
          }
          cursorId={selection.cursorId}
          renderItemMenu={renderItemMenu}
        />
      )}

      <ManageLabelsDialog
        open={manageLabelsOpen}
        onOpenChange={setManageLabelsOpen}
        labels={writableLabels}
      />

      {projectId ? (
        <ManageCyclesDialog
          open={manageCyclesOpen}
          onOpenChange={setManageCyclesOpen}
          projectId={projectId}
          cycles={cycles ?? []}
          projects={projects ?? []}
          progress={cycleTallies}
        />
      ) : null}

      <CollabConflictsPanel />
      <SyncConflictsPanel
        projectId={projectId}
        identifiersById={identifiersById}
        onOpenIssue={(id) => setSelectedId(makeUnifiedIssueId("local", id))}
      />

      <DeleteIssueDialog
        open={deleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets([])
        }}
        items={deleteTargets}
        onConfirm={async () => {
          await runBulk(deleteTargets, { kind: "delete" })
          // A deleted row must not stay in the inspector or the selection.
          if (deleteTargets.some((item) => item.unifiedId === selectedId)) {
            setSelectedId(undefined)
          }
          selection.clear()
        }}
      />

      {projectId ? (
        <ImportIssuesDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          projectId={projectId}
          projects={projects ?? []}
          cycles={cycles ?? []}
          initialProjectId={prefs.filter.issueProjectIds[0]}
        />
      ) : null}

      {projectId ? (
        <CreateIssuePage
          {...createSurfaceProps}
          labels={writableLabels}
          cycles={cycles ?? []}
          issues={sorted}
        />
      ) : null}
    </FeaturePageShell>
  )
}
