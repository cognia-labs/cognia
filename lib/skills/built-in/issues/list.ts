/**
 * `issue.list`: the board, as the assistant sees it. Read-only.
 *
 * Local rows only, matching `lib/global-search/providers/issues.ts`: federated
 * GitHub mirrors and agent-engine rows have their own tools and their own
 * surfaces, and returning them here would offer the model work items it has no
 * write path to.
 */

import { z } from "zod"

import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { resolveWorkspaceId, summariseIssue } from "./_core"

/** Rows returned when the model asks for no limit, and the most it may ask for. */
const ISSUE_LIST_DEFAULT_LIMIT = 25
const ISSUE_LIST_MAX_LIMIT = 100

const schema = z.object({
  status: z
    .array(z.enum(ISSUE_STATUSES))
    .optional()
    .describe("Keep only these board columns. Omit for every column."),
  priority: z.array(z.enum(ISSUE_PRIORITIES)).optional().describe("Keep only these priorities."),
  issueProject: z
    .string()
    .optional()
    .describe("Delivery container key or id. Omit to span every container in the workspace."),
  assignee: z
    .enum(["me", "agents", "unassigned", "any"])
    .optional()
    .describe(
      "Who the issue is on. 'agents' covers both agent and squad assignees. Defaults to 'any'."
    ),
  query: z.string().optional().describe("Case-insensitive match on identifier, title or body."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ISSUE_LIST_MAX_LIMIT)
    .optional()
    .describe(`Rows to return. Defaults to ${ISSUE_LIST_DEFAULT_LIMIT}.`),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.list",
  family: "issue",
  label: { en: "List issues", "zh-CN": "列出议题" },
  description: {
    en: "List issues on the local board for the active workspace, filtered by column, priority, container, assignee or free text. Returns identifiers (e.g. MERC-12) that every other issue tool accepts.",
    "zh-CN":
      "列出当前工作区本地看板上的议题，可按状态列、优先级、交付容器、负责人或关键词过滤。返回的编号（如 MERC-12）可直接用于其他议题工具。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "issue_list",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const [{ queryIssues }, { toUnifiedIssue }, { matchesViewScope }, { SELF_ACTOR_KEY }] =
      await Promise.all([
        import("@/lib/issues/service"),
        import("@/lib/issues/sources/local-source"),
        import("@/lib/issues/views"),
        import("@/lib/issues/run/running"),
      ])
    // "Me" is the local person, as the board's own "Assigned to me" scope reads it.
    const viewer = { selfKey: SELF_ACTOR_KEY, agentKeys: [] }
    const workspaceId = await resolveWorkspaceId(ctx)

    let issueProjectId: string | undefined
    if (args.issueProject) {
      const { resolveIssueProject } = await import("./_core")
      issueProjectId = (await resolveIssueProject(args.issueProject, workspaceId)).id
    }

    const priorities = args.priority?.length ? new Set<string>(args.priority) : undefined
    // The same query the MCP `issues_list` and the `/issue list` command run;
    // only the assignee and priority narrowing is this tool's own.
    const rows = (
      await queryIssues({
        projectId: workspaceId,
        ...(issueProjectId ? { issueProjectId } : {}),
        ...(args.status?.length ? { statuses: args.status } : {}),
        ...(args.query?.trim() ? { text: args.query } : {}),
      })
    ).filter((row) => {
      if (priorities && !priorities.has(row.priority)) return false
      switch (args.assignee) {
        case "me":
          return matchesViewScope(toUnifiedIssue(row), "assigned-to-me", viewer)
        case "agents":
          return row.assigneeKind === "agent" || row.assigneeKind === "team"
        case "unassigned":
          return row.assigneeKind === undefined
        default:
          return true
      }
    })

    const limit = args.limit ?? ISSUE_LIST_DEFAULT_LIMIT
    return {
      workspaceId,
      total: rows.length,
      returned: Math.min(rows.length, limit),
      issues: rows.slice(0, limit).map(summariseIssue),
    }
  },
}

registerBuiltInSkill(skill)
