"use client"

/**
 * The heading for one group of issues: a list section or a board swimlane.
 *
 * Both layouts group by the same keys (`buildIssueGroups`), so they share one
 * label too; two copies would let a lane read "agent" while the list section
 * for the same key names the agent.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import type { IssueGroupBy } from "@/lib/issues/board-model"
import type { IssuePriority, IssueStatus } from "@/types/issues"

export interface IssueGroupLabelSources {
  /** Delivery-container id to its name, for the project grouping. */
  projectNamesById?: ReadonlyMap<string, string>
  /**
   * `actorKey` to display name, for the assignee grouping. Without it a group
   * headed by an agent or a squad shows only the actor kind.
   */
  assigneeLabels?: ReadonlyMap<string, string>
}

/** Localize a raw group key. `""` is the catch-all group. */
export function useIssueGroupLabel(
  groupBy: IssueGroupBy,
  { projectNamesById, assigneeLabels }: IssueGroupLabelSources
): (key: string) => string {
  const t = useTranslations("issues")
  return useCallback(
    (key: string) => {
      if (key === "") {
        return groupBy === "assignee" ? t("actor.unassigned") : t("toolbar.groupBy.none")
      }
      switch (groupBy) {
        case "status":
          return t(`status.${key as IssueStatus}`)
        case "priority":
          return t(`priority.${key as IssuePriority}`)
        case "project":
          return projectNamesById?.get(key) ?? key
        case "assignee":
          if (key.startsWith("human:")) return t("actor.human")
          // The cached display name, then the actor kind — never the raw id,
          // which is what a bare `key.split(":")[1]` used to render.
          return assigneeLabels?.get(key) ?? t(`actor.${key.split(":")[0] as "agent" | "team"}`)
        default:
          return key
      }
    },
    [groupBy, projectNamesById, assigneeLabels, t]
  )
}
