/**
 * `pattern.judge-panel` — generate N independent attempts from different angles
 * (e.g. MVP-first, risk-first, user-first), score each with a panel of
 * independent judges, and surface the winner plus the full ranking. Beats
 * one-attempt-iterated when the solution space is wide.
 *
 * The ranking is the shared one (`@cognia/agent-orchestration/aggregate`): an
 * attempt no judge scored ranks after every scored one and cannot win, and a
 * tie goes to the earlier attempt.
 */

import { bestByScore, rankByScore } from "@cognia/agent-orchestration/aggregate"
import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  attemptSchema,
  judgeScoreSchema,
  type Attempt,
  type JudgePanelParams,
  type JudgeScore,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../teammate/structured-dispatch"
import { fanoutLimit, getTeamCtxOrThrow, mapSettled, nonRetryable } from "./_shared"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  freezePatternPromptScope,
  JUDGE_ATTEMPT_PROMPT,
  JUDGE_ATTEMPT_SCHEMA_HINT_PROMPT,
  JUDGE_SCORE_PROMPT,
  JUDGE_SCORE_SCHEMA_HINT_PROMPT,
} from "./pattern-prompts"

export const JUDGE_PANEL_KIND = "pattern.judge-panel" as const

export interface RankedAttempt {
  attempt: Attempt
  scores: JudgeScore[]
  /** The mean of `scores`; 0 for an attempt no judge scored (`scores` is empty). */
  avgScore: number
}

/** Rank attempts by their judges' mean score; `undefined` winner when nobody scored. */
export function rankAttempts(
  attempts: readonly Attempt[],
  scoresByAttempt: ReadonlyMap<number, JudgeScore[]>
): { ranked: RankedAttempt[]; winner: RankedAttempt | undefined } {
  const order = rankByScore(attempts, (_attempt, ai) =>
    (scoresByAttempt.get(ai) ?? []).map((s) => s.score)
  )
  const ranked = order.map(({ item, index, mean }) => ({
    attempt: item,
    scores: scoresByAttempt.get(index) ?? [],
    avgScore: mean ?? 0,
  }))
  return { ranked, winner: bestByScore(order) ? ranked[0] : undefined }
}

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<JudgePanelParams>
  const objective = params.objective?.trim()
  const angles = (params.angles ?? []).map((a) => a?.trim()).filter((a): a is string => !!a)
  const judgesPerAttempt = Math.max(1, Math.floor(params.judgesPerAttempt ?? 3))
  if (!objective) throw nonRetryable("pattern.judge-panel requires 'objective'")
  if (angles.length === 0)
    throw nonRetryable("pattern.judge-panel requires at least one 'angles' entry")

  ctx.log("info", `judge-panel: ${angles.length} attempts × ${judgesPerAttempt} judges`)
  // One snapshot for the whole step (ADR-0236): both phases read the same text.
  const promptScope = await freezePatternPromptScope(teamCtx)
  ctx.signal?.throwIfAborted()

  // Phase 1 — produce one attempt per angle, in parallel.
  const attemptResults = await mapSettled(
    angles,
    fanoutLimit(teamCtx),
    async (angle, i) => {
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:attempt:${i}`,
          prompt: resolvePrompt(JUDGE_ATTEMPT_PROMPT, {
            ...promptScope,
            values: { objective, angle },
          }).text,
          signal: ctx.signal,
        },
        attemptSchema,
        { schemaHint: resolvePrompt(JUDGE_ATTEMPT_SCHEMA_HINT_PROMPT).text }
      )
      return r.value
    },
    (err, angle, i) => ctx.log("warn", `attempt ${i} (${angle}) failed: ${String(err)}`)
  )
  const attempts = attemptResults.filter((a): a is Attempt => a !== null)
  if (attempts.length === 0) {
    throw nonRetryable("pattern.judge-panel: every attempt failed to produce output")
  }

  // Phase 2 — every judge scores every attempt, all under one concurrency bound.
  const jobs = attempts.flatMap((attempt, ai) =>
    Array.from({ length: judgesPerAttempt }, (_, ji) => ({ attempt, ai, ji }))
  )
  const scoreResults = await mapSettled(
    jobs,
    fanoutLimit(teamCtx),
    async (job, _idx) => {
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:judge:${job.ai}:${job.ji}`,
          prompt: resolvePrompt(JUDGE_SCORE_PROMPT, {
            ...promptScope,
            values: { objective, angle: job.attempt.angle, content: job.attempt.content },
          }).text,
          signal: ctx.signal,
        },
        judgeScoreSchema,
        { schemaHint: resolvePrompt(JUDGE_SCORE_SCHEMA_HINT_PROMPT).text }
      )
      return { ai: job.ai, score: r.value }
    },
    (err, job, idx) =>
      ctx.log("warn", `judge job ${idx} (attempt ${job.ai}) failed: ${String(err)}`)
  )

  const scoresByAttempt = new Map<number, JudgeScore[]>()
  for (const res of scoreResults) {
    if (!res) continue
    const list = scoresByAttempt.get(res.ai) ?? []
    list.push(res.score)
    scoresByAttempt.set(res.ai, list)
  }

  const { ranked, winner } = rankAttempts(attempts, scoresByAttempt)
  if (!winner) {
    throw nonRetryable("pattern.judge-panel: every judge failed to score an attempt")
  }
  ctx.log(
    "info",
    `judge-panel complete: winner "${winner.attempt.angle}" @ ${winner.avgScore.toFixed(2)}`
  )

  return { output: { winner, ranked, attempts } }
}

export const judgePanelNode: NodeExecutorRegistration = {
  kind: JUDGE_PANEL_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(judgePanelNode)
