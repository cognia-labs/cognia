/**
 * An active goal's share of every run in its session, as the goal module's
 * capability contribution (ADR-0198 amendment, ADR-0250 §14 M3).
 *
 * Two parts, folded with the run's other grants by `resolveSendOptions`:
 * - the goal's system section (Codex-style `<objective>` wrap and injection
 *   warning) as an instruction, appended after the agent's own prompt;
 * - the goal's per-turn USD ceiling as the run's budget, so a runaway turn
 *   halts (subtype `error_max_budget_usd`) instead of burning cost until the
 *   renderer-side turn and token budget catches it after the turn.
 *
 * Only an `active` goal contributes: paused, inactive and terminal goals are
 * skipped, so the model sees goal context only while it is being driven. The
 * budget narrows the run, so a failure here fails the resolution rather than
 * letting the turn run without its ceiling.
 */

import type { Goal } from "@/types/goal"
import type {
  CapabilityContribution,
  ContributedCapabilityGrant,
} from "@/lib/modules/manifest-types"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { renderGoalSystemSection } from "./prompts"
import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"

/** What an active goal adds to a run of its session; `null` for any other goal. */
export function goalCapabilityGrant(
  goal: Readonly<Goal> | null | undefined,
  /** The run's frozen Prompt Center snapshot (ADR-0236). */
  snapshot?: PromptOverrideSnapshot | null
): ContributedCapabilityGrant | null {
  if (!goal || goal.status !== "active") return null
  const grant: ContributedCapabilityGrant = {}
  const section = renderGoalSystemSection(goal, snapshot !== undefined ? { snapshot } : {})
  // PII red-line: the goal text is human-editable and flows straight into the
  // outbound system prompt. Leave the section out if it carries leaking PII
  // rather than send it to the model (matches the connector auto-mode
  // safe-send gate). The budget still applies.
  if (hasNoLeakingPii(section)) grant.instructions = [section]
  else loggers.agent.warn("Goal context carries PII; skipping system-prompt injection")
  const budget = goal.config?.maxBudgetUsd
  if (typeof budget === "number" && budget > 0) grant.maxBudgetUsd = budget
  return grant.instructions || grant.maxBudgetUsd !== undefined ? grant : null
}

export const contributions: readonly CapabilityContribution[] = [
  {
    id: "active-goal",
    // The budget narrows the run: never let it silently disappear.
    failure: "refuse-turn",
    produce: ({ activeGoal, prompts }) => goalCapabilityGrant(activeGoal, prompts.snapshot),
  },
]
