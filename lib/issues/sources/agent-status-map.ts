/**
 * Status projections for the two agent-side federated sources.
 *
 * Both engines have eight statuses where the board has six, so the mapping is
 * lossy by design and follows the rule `github-source.ts` established: map to
 * the *category* the board keys everything off, and preserve the "we decided
 * not to" (`canceled`) vs "we finished" (`done`) distinction.
 *
 *   pending                → backlog      (unstarted — nobody has queued it yet)
 *   blocked / claimed      → todo         (unstarted — it is next, but not running)
 *   in_progress / paused   → in_progress  (started — paused still owns its slot)
 *   review                 → in_review    (started — waiting on the human)
 *   completed              → done
 *   failed / cancelled     → canceled     (an engine that gave up is not "done")
 *
 * `failed → canceled` is the deliberate choice: on the issue board a failed
 * agent task must not inflate any project's progress bar, and the card badge
 * plus deep link carry the engine's own status for the detail.
 */

import type { AgentTaskPriority, AgentTaskStatus } from "@/types/agent/agent-task"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type { IssuePriority, IssueStatus } from "@/types/issues"

export function agentTaskStatusToIssueStatus(status: AgentTaskStatus): IssueStatus {
  switch (status) {
    case "pending":
      return "backlog"
    case "blocked":
      return "todo"
    case "in_progress":
    case "paused":
      return "in_progress"
    case "review":
      return "in_review"
    case "completed":
      return "done"
    case "failed":
    case "cancelled":
      return "canceled"
  }
}

export function teamTaskStatusToIssueStatus(status: TeamTaskStatus): IssueStatus {
  switch (status) {
    case "pending":
      return "backlog"
    case "blocked":
    case "claimed":
      return "todo"
    case "in_progress":
      return "in_progress"
    case "review":
      return "in_review"
    case "completed":
      return "done"
    case "failed":
    case "cancelled":
      return "canceled"
  }
}

// ── priority: one two-way table per engine scale ────────────────────────────
//
// An issue has five priorities and an agent task four, so no table alone can
// carry every value there and back. The table makes the engine's default,
// `normal`, read as `none` ("nobody set one"), which is what a task the board
// did not create means. A task the board dispatched remembers its issue: when
// that issue's priority still maps to the task's, the row shows the issue's,
// so `medium` sent out comes back `medium` and `none` comes back `none`.

/** `IssuePriority` → engine priority. `medium` and `none` both send `normal`. */
const ISSUE_TO_ENGINE_PRIORITY = {
  urgent: "critical",
  high: "high",
  medium: "normal",
  low: "low",
  none: "normal",
} as const satisfies Record<IssuePriority, AgentTaskPriority>

/** Engine priority → `IssuePriority`, for a row with no issue of its own. */
const ENGINE_TO_ISSUE_PRIORITY = {
  critical: "urgent",
  high: "high",
  normal: "none",
  low: "low",
} as const satisfies Record<AgentTaskPriority, IssuePriority>

/** `IssuePriority` → `AgentTaskPriority`, for a dispatch. */
export function issuePriorityToAgentTaskPriority(priority: IssuePriority): AgentTaskPriority {
  return ISSUE_TO_ENGINE_PRIORITY[priority]
}

/**
 * `IssuePriority` → `SubAgentPriority`, for a team task. The same table: the
 * team scale's extra `background` is never chosen on the issue's behalf.
 */
export function issuePriorityToSubAgentPriority(priority: IssuePriority): SubAgentPriority {
  return ISSUE_TO_ENGINE_PRIORITY[priority]
}

/**
 * `AgentTaskPriority` → `IssuePriority`. `originPriority` is the dispatching
 * issue's, when the row has one: it wins while it still maps to this value.
 */
export function agentTaskPriorityToIssuePriority(
  priority: AgentTaskPriority,
  originPriority?: IssuePriority
): IssuePriority {
  if (originPriority && ISSUE_TO_ENGINE_PRIORITY[originPriority] === priority) {
    return originPriority
  }
  return ENGINE_TO_ISSUE_PRIORITY[priority]
}

/** `SubAgentPriority` → `IssuePriority`; `background` has no board meaning → `none`. */
export function subAgentPriorityToIssuePriority(
  priority: SubAgentPriority,
  originPriority?: IssuePriority
): IssuePriority {
  if (priority === "background") return "none"
  return agentTaskPriorityToIssuePriority(priority, originPriority)
}
