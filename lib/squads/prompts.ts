// The Squad's code-owned prompts (ADR-0236), as its manifest contributes them
// to the prompt catalog (ADR-0250 §14, M3): auto-compose, lead planning and
// review, teammate turns, the progress ledger, replanning, ultracode, the PR
// reviewer, the rate-limit nudge and the orchestration patterns. Each
// definition stays with the code that resolves it; this file only lists them
// for the Prompt Center and the CLI.

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { ASSESS_ROUTING_PROMPT } from "./auto/assess-routing"
import { CLARIFY_OBJECTIVE_PROMPT } from "./auto/clarify-objective"
import { COMPOSE_ROSTER_PROMPT } from "./auto/compose-roster"
import { DECOMPOSE_TASKS_PROMPT } from "./auto/decompose-tasks"
import { NUDGE_CONTINUE_PROMPT } from "./durable/rate-limit-resume"
import { PATTERN_PROMPTS } from "./patterns/pattern-prompts"
import { REVIEWER_SYSTEM_PROMPT, REVIEWER_TASK_PROMPT } from "./pr-feedback/reviewer"
import { LEAD_REVIEW_PROMPT } from "./squad/lead-review"
import {
  LEAD_PLANNING_PROMPT,
  LEAD_PLANNING_SYSTEM_PROMPT,
  PROGRESS_LEDGER_JUDGE_PROMPT,
  PROGRESS_LEDGER_SCHEMA_HINT_PROMPT,
  REPLAN_LEAD_PROMPT,
  REVIEW_REVISION_REQUEST_PROMPT,
  STRUCTURED_JSON_INSTRUCTION_PROMPT,
  STRUCTURED_RETRY_NOTE_PROMPT,
  TEAMMATE_TASK_PROMPT,
  TEAMMATE_UPSTREAM_RESULTS_PROMPT,
  ULTRACODE_PLAN_HINT_PROMPT,
  ULTRACODE_PLANNER_PROMPT,
} from "./team-prompts"
import { DEFAULT_TEAMMATE_IDENTITY_PROMPT } from "./teammate/teammate-character"

export const prompts: ModulePromptsModule["prompts"] = [
  CLARIFY_OBJECTIVE_PROMPT,
  ASSESS_ROUTING_PROMPT,
  COMPOSE_ROSTER_PROMPT,
  DECOMPOSE_TASKS_PROMPT,
  LEAD_REVIEW_PROMPT,
  LEAD_PLANNING_SYSTEM_PROMPT,
  LEAD_PLANNING_PROMPT,
  TEAMMATE_TASK_PROMPT,
  TEAMMATE_UPSTREAM_RESULTS_PROMPT,
  REVIEW_REVISION_REQUEST_PROMPT,
  STRUCTURED_JSON_INSTRUCTION_PROMPT,
  STRUCTURED_RETRY_NOTE_PROMPT,
  PROGRESS_LEDGER_JUDGE_PROMPT,
  PROGRESS_LEDGER_SCHEMA_HINT_PROMPT,
  REPLAN_LEAD_PROMPT,
  ULTRACODE_PLANNER_PROMPT,
  ULTRACODE_PLAN_HINT_PROMPT,
  DEFAULT_TEAMMATE_IDENTITY_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_TASK_PROMPT,
  NUDGE_CONTINUE_PROMPT,
  ...PATTERN_PROMPTS,
]
