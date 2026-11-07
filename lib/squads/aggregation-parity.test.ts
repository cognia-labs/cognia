/**
 * The four surfaces that aggregate several agents' answers, run on the same
 * inputs (ADR-0252 §8, P5): the Squad consensus vote, the workflow ensemble,
 * the judge panel and the council.
 *
 * Each case feeds one input to every surface that can take it and pins what
 * each one answers, so an agreement stays an agreement and every kept
 * difference is visible here, not only in a comment. Written before the four
 * moved onto `@cognia/agent-orchestration/aggregate`; the cases the move
 * changed say what the surface did before.
 */

import { leader, tally } from "@cognia/agent-orchestration/aggregate"
import { computeWinner, tallyVotes } from "./consensus-orchestrator"
import { judgePanelNode } from "./patterns/judge-panel"
import {
  registerTeamRunContext,
  __resetTeamRunContextForTesting,
  type TeamRunContext,
} from "./team-run-context"
import { runEnsemble, type EnsembleAggregation } from "@/lib/ai/ensemble/run-ensemble"
import { runCouncil } from "@/lib/ai/council/run-council"
import type { ConsensusVote } from "@/types/agent/agent-team"
import type { StepExecutionContext } from "@/types/workflow/visual"

const dispatchStructured = jest.fn()
jest.mock("./teammate/structured-dispatch", () => ({
  dispatchStructured: (...a: unknown[]) => dispatchStructured(...a),
}))
jest.mock("@/lib/prompts/resolve", () => ({
  resolvePrompt: () => ({ text: "prompt" }),
  resolvePromptAsync: async () => ({ text: "synthesize" }),
}))
jest.mock("./patterns/pattern-prompts", () => ({
  freezePatternPromptScope: async () => ({}),
  JUDGE_ATTEMPT_PROMPT: {},
  JUDGE_ATTEMPT_SCHEMA_HINT_PROMPT: {},
  JUDGE_SCORE_PROMPT: {},
  JUDGE_SCORE_SCHEMA_HINT_PROMPT: {},
}))

afterEach(() => __resetTeamRunContextForTesting())
beforeEach(() => dispatchStructured.mockReset())

const votes = (indices: number[]): ConsensusVote[] =>
  indices.map((optionIndex, i) => ({
    voterId: `v${i}`,
    voterName: `v${i}`,
    optionIndex,
    votedAt: new Date(0),
  }))

async function ensemble(
  outputs: Array<{ text?: string; object?: unknown }>,
  policy: EnsembleAggregation
) {
  return runEnsemble(
    { n: outputs.length, aggregation: policy, iterationConcurrency: 1 },
    { runSample: async ({ index }) => outputs[index]! }
  )
}

/** Run the judge panel over attempts whose judges return `scores[i]` (`null` = the judge failed). */
async function judgePanel(scores: Array<Array<number | null>>) {
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    team: { name: "Team" },
    concurrency: { get: () => 1 },
  } as unknown as TeamRunContext)
  for (let i = 0; i < scores.length; i += 1)
    dispatchStructured.mockResolvedValueOnce({ value: { angle: `a${i}`, content: `c${i}` } })
  for (const judges of scores)
    for (const score of judges)
      if (score === null) dispatchStructured.mockRejectedValueOnce(new Error("judge failed"))
      else dispatchStructured.mockResolvedValueOnce({ value: { score, rationale: "r" } })
  const ctx = {
    runId: "run1",
    stepId: "judge1",
    params: {
      objective: "o",
      angles: scores.map((_, i) => `a${i}`),
      judgesPerAttempt: scores[0]!.length,
    },
    upstream: {},
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
  return judgePanelNode.execute(ctx)
}

async function council(completions: string[]) {
  const runPrompt = jest.fn(async (input: { systemPrompt?: string; modelAlias: string }) =>
    input.systemPrompt
      ? { completion: "## Council Response\nok\nConfidence: majority" }
      : { completion: completions[Number(input.modelAlias)]! }
  )
  return runCouncil(
    {
      prompt: "q",
      councillors: completions.map((_, i) => ({ name: `c${i}`, modelAlias: String(i) })),
      synthesizerAlias: "synth",
      maxConcurrency: 1,
    },
    { runPrompt }
  )
}

describe("aggregation across surfaces", () => {
  it("breaks a tie for the most votes to the first option in order, on both vote surfaces", async () => {
    // y, x, x, y, z: x and y tie at two. A weighted Squad vote with a heavier
    // x ballot and a heavier y ballot shows which option the tie leans to.
    const weighted = votes([1, 0, 0, 1, 2]).map((vote, i) => ({
      ...vote,
      weight: i === 0 || i === 1 ? 5 : 1,
    }))
    expect(computeWinner(weighted, ["x", "y", "z"], "weighted", 5)).toBeNull()
    expect(tallyVotes(weighted, ["x", "y", "z"], "weighted")).toEqual([6, 6, 1])
    expect(
      leader(
        tally(
          weighted.map((v) => ({ key: v.optionIndex, weight: v.weight })),
          {
            candidates: [0, 1, 2],
          }
        )
      )?.key
    ).toBe(0)
    const result = await ensemble(
      ["x", "y", "y", "x", "z"].map((text) => ({ text })),
      { kind: "majority-vote-on-field" }
    )
    expect(result.result).toEqual({ value: "x", count: 2, total: 5 })
  })

  it("decides a quorum only for the Squad vote; the ensemble reports the most common answer", async () => {
    // Two of five agree, three differ. A Squad vote needs a majority of its
    // voters; the ensemble's "majority vote" returns the mode with its count.
    expect(computeWinner(votes([0, 0, 1, 2, 3]), ["a", "b", "c", "d"], "majority", 5)).toBeNull()
    const result = await ensemble(
      ["a", "a", "b", "c", "d"].map((text) => ({ text })),
      { kind: "majority-vote-on-field" }
    )
    expect(result.result).toEqual({ value: "a", count: 2, total: 5 })
  })

  // Before, the ensemble counted both blank samples as responses (3).
  it("does not count an empty answer as an answer", async () => {
    const ensembled = await ensemble([{ text: "yes" }, { text: "  " }, {}], {
      kind: "majority-vote-on-field",
    })
    const counciled = await council(["yes", "  ", ""])
    expect(counciled.respondedCount).toBe(1)
    expect(ensembled.respondedCount).toBe(1)
  })

  // Before, the ensemble split "yes" and "yes\n" into two answers (count 1).
  it("compares answers without their surrounding whitespace", async () => {
    const ensembled = await ensemble([{ text: "yes" }, { text: "yes\n" }, { text: "no" }], {
      kind: "majority-vote-on-field",
    })
    const counciled = await council(["yes\n"])
    expect(counciled.councillors[0]!.text).toBe("yes")
    expect(ensembled.result).toEqual({ value: "yes", count: 2, total: 3 })
  })

  // Before, the judge panel ranked the unscored attempt 0 as a zero and,
  // first among equal zeros, named it the winner.
  it("never lets an attempt nobody scored win over one that was scored", async () => {
    // Attempt 0's judge failed, attempt 1 scored 0, attempt 2's judge failed.
    const judged = await judgePanel([[null], [0], [null]])
    const ensembled = await ensemble([{ object: {} }, { object: { score: 0 } }, { object: {} }], {
      kind: "best-of-by-score",
      scoreField: "score",
    })
    expect(ensembled.result).toMatchObject({ index: 1, score: 0 })
    expect((judged.output as { winner: { attempt: { angle: string } } }).winner.attempt.angle).toBe(
      "a1"
    )
  })

  // Before, the judge panel named attempt 0 the winner at an average of 0.
  it("names no winner when nothing was scored", async () => {
    const ensembled = await ensemble([{ object: {} }, { object: {} }], {
      kind: "best-of-by-score",
      scoreField: "score",
    })
    expect(ensembled.result).toBeNull()
    await expect(judgePanel([[null], [null]])).rejects.toThrow(/every judge failed/)
  })

  it("breaks a score tie to the first candidate, on both score surfaces", async () => {
    const judged = await judgePanel([[5], [5]])
    const ensembled = await ensemble([{ object: { score: 5 } }, { object: { score: 5 } }], {
      kind: "best-of-by-score",
      scoreField: "score",
    })
    expect(ensembled.result).toMatchObject({ index: 0 })
    expect((judged.output as { winner: { attempt: { angle: string } } }).winner.attempt.angle).toBe(
      "a0"
    )
  })
})
