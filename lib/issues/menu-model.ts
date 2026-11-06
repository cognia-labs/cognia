/**
 * What the issue context menu offers, as data.
 *
 * The menu used to build its own entries inline, which put six capability
 * decisions inside JSX where ADR-0132 explicitly says they must not live
 * ("all board decision logic lives here; the components stay thin render
 * shells"). It also made them untestable: Radix nested submenus do not fire
 * their selection events under jsdom, so a component test can prove an entry
 * renders and is disabled but never that it carries the right action.
 *
 * With the entries as data, the capability gating and the action payloads are
 * exhaustively unit-tested here, and the component only has to render them.
 */

import { actorKey } from "./board-model"
import { canApplyBulkAction, type BulkActionContext, type IssueBulkAction } from "./bulk-actions"
import { collabAssigneeKey } from "./collab-actor"
import type { AssigneeOption } from "@/components/issues/assignee-picker"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"
import type { IssueCycle, IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { CollabActorRefusal } from "@/types/issues/collab"
import type { LabelRow } from "@/types/labels"

/** A menu section's identity, also its i18n key suffix and test-id stem. */
export type IssueMenuSectionId = "status" | "priority" | "assignee" | "labels" | "project" | "cycle"

export interface IssueMenuEntry {
  /** Stable within its section; used for the React key and the test id. */
  id: string
  action: IssueBulkAction
  /** Refused by capabilities or by the state machine. Rendered, not hidden. */
  disabled: boolean
  /** The issue already has this value. */
  checked: boolean
  /** Set when a shared row refuses this assignee; the menu shows why. */
  collabRefusal?: CollabActorRefusal
}

export interface IssueMenuSection {
  id: IssueMenuSectionId
  entries: IssueMenuEntry[]
}

export interface IssueMenuInput {
  item: UnifiedIssueItem
  running: boolean
  labels: readonly LabelRow[]
  projects: readonly IssueProject[]
  assigneeOptions: readonly AssigneeOption[]
  /** Cycles and milestones of the workspace. Omitted means no cycle section. */
  cycles?: readonly IssueCycle[]
  /**
   * The signed-in person "Me" resolves to on the collaboration plane (`null`:
   * nobody). On a shared row it greys out assignees the plane cannot name and
   * ticks "Me" for the person's own `usr_…`. Absent: unknown.
   */
  collabSelfUserId?: string | null
}

function entry(
  id: string,
  action: IssueBulkAction,
  item: UnifiedIssueItem,
  running: boolean,
  checked: boolean,
  context: BulkActionContext = {}
): IssueMenuEntry {
  const verdict = canApplyBulkAction(item, action, running, context)
  return {
    id,
    action,
    disabled: !verdict.ok,
    checked,
    ...(!verdict.ok && verdict.reason === "collab-actor" ? { collabRefusal: verdict.refusal } : {}),
  }
}

/**
 * Every section the menu can show, in display order.
 *
 * Sections with no entries to offer are omitted — a "Labels" submenu that
 * opens onto nothing is worse than no submenu. Individual entries are never
 * omitted for being refused; they render disabled, because a menu whose shape
 * changes per row is a menu users stop trusting.
 */
export function buildIssueMenuSections({
  item,
  running,
  labels,
  projects,
  assigneeOptions,
  cycles = [],
  collabSelfUserId,
}: IssueMenuInput): IssueMenuSection[] {
  const shared = item.kind === "collab"
  const currentAssignee = shared
    ? collabAssigneeKey(item.assignee, collabSelfUserId, actorKey)
    : actorKey(item.assignee)
  const assigneeContext: BulkActionContext =
    collabSelfUserId === undefined ? {} : { collabSelfUserId }

  const sections: IssueMenuSection[] = [
    {
      id: "status",
      entries: ISSUE_STATUSES.map((status) =>
        entry(status, { kind: "status", to: status }, item, running, item.status === status)
      ),
    },
    {
      id: "priority",
      entries: ISSUE_PRIORITIES.map((priority) =>
        entry(
          priority,
          { kind: "priority", to: priority },
          item,
          running,
          item.priority === priority
        )
      ),
    },
    {
      id: "assignee",
      entries: [
        entry(
          "none",
          { kind: "assignee", to: null },
          item,
          running,
          currentAssignee === null,
          assigneeContext
        ),
        ...assigneeOptions.map((option) =>
          entry(
            option.key,
            { kind: "assignee", to: option.actor },
            item,
            running,
            currentAssignee === option.key,
            assigneeContext
          )
        ),
      ],
    },
    {
      id: "labels",
      entries: labels.map((label) => {
        const applied = item.labelIds.includes(label.id)
        return entry(
          label.id,
          applied
            ? { kind: "removeLabel", labelId: label.id }
            : { kind: "addLabel", labelId: label.id },
          item,
          running,
          applied
        )
      }),
    },
    {
      id: "project",
      entries: projects.map((project) =>
        entry(
          project.id,
          { kind: "project", issueProjectId: project.id },
          item,
          running,
          item.issueProjectId === project.id
        )
      ),
    },
    {
      id: "cycle",
      // Only cycles the row may join: workspace-wide ones, and those bound to
      // the row's own container. A milestone of another repository is not an
      // option a menu should offer and then have the write refuse.
      entries:
        cycles.length === 0
          ? []
          : [
              entry("none", { kind: "cycle", cycleId: null }, item, running, !item.cycleId),
              ...cycles
                .filter(
                  (cycle) => !cycle.issueProjectId || cycle.issueProjectId === item.issueProjectId
                )
                .map((cycle) =>
                  entry(
                    cycle.id,
                    { kind: "cycle", cycleId: cycle.id },
                    item,
                    running,
                    item.cycleId === cycle.id
                  )
                ),
            ],
    },
  ]

  return sections.filter((section) => section.entries.length > 0)
}

/** Whether deleting this issue is offered at all. */
export function canDeleteIssue(item: UnifiedIssueItem, running: boolean): boolean {
  return canApplyBulkAction(item, { kind: "delete" }, running).ok
}
