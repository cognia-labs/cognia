/**
 * Ensemble — run the same target N times (optionally each with a distinct
 * "lens" / perspective), then aggregate the samples with a bundled policy:
 * majority-vote-on-field, threshold-count, best-of-by-score, or
 * synthesize-by-final-agent. The signature harness pattern (N-vote /
 * adversarial-verify) that neither n8n nor Dify ships as a first-class node.
 *
 * Generalizes `lib/ai/council/run-council`: the council fans ONE prompt across
 * DIFFERENT models then synthesizes; the ensemble runs ONE target N times then
 * applies a configurable reducer. The per-sample runner and the synthesizer are
 * injected (`deps`) so the workflow node adapter binds them to `agent.turn` /
 * sub-workflow / the routing engine, and tests stay provider-free.
 *
 * Bundled aggregation means this does NOT depend on `data.aggregate` (D6③).
 * The rules every aggregating surface shares (what counts as an answer, how a
 * tie breaks, how an unscored sample ranks) come from
 * `@cognia/agent-orchestration/aggregate`.
 */

import { boundedFanOut, type FanOutOutcome } from "@cognia/primitives/bounded-fan-out"
import {
  answerText,
  bestByScore,
  isAnswer,
  leader,
  quorumMet,
  rankByScore,
  tally,
  valueKey,
} from "@cognia/agent-orchestration/aggregate"

export type EnsembleAggregation =
  | { kind: "majority-vote-on-field"; field?: string }
  | { kind: "threshold-count"; field?: string; equals?: unknown; threshold: number }
  | { kind: "best-of-by-score"; scoreField: string }
  | { kind: "synthesize-by-final-agent"; instructions?: string }

export interface EnsembleSampleResult {
  index: number
  lens?: string
  status: "completed" | "failed"
  text?: string
  object?: unknown
  error?: string
  /**
   * Set when the sample was stopped (its deadline passed, or the run was
   * cancelled) and had not finished when its stop grace ran out: its slot was
   * given back while its work may still be going.
   */
  stopUnconfirmed?: true
}

export interface EnsembleResult {
  /** Aggregated answer; shape depends on the policy (never throws on empty). */
  result: unknown
  /** Which aggregation policy produced `result`. */
  aggregation: EnsembleAggregation["kind"]
  samples: EnsembleSampleResult[]
  respondedCount: number
  totalCount: number
}

export interface RunEnsembleSampleInput {
  index: number
  lens?: string
  /**
   * Aborts when this sample's deadline passes or the ensemble is stopped. A
   * sample keeps its concurrency slot until it settles, so a runner that
   * honours this signal is what keeps the in-flight count at the limit.
   */
  signal: AbortSignal
}

export interface RunEnsembleSampleOutput {
  text?: string
  /** Parsed/validated object when the target produced typed output (D3). */
  object?: unknown
}

export interface RunEnsembleDeps {
  /** Run one sample (the target). May throw — failures become `failed` samples. */
  runSample: (input: RunEnsembleSampleInput) => Promise<RunEnsembleSampleOutput>
  /** Final synthesizer for `synthesize-by-final-agent`. Required for that policy. */
  synthesize?: (
    samples: EnsembleSampleResult[],
    instructions: string | undefined,
    signal: AbortSignal | undefined
  ) => Promise<{ text: string }>
  log?: (level: "info" | "warn", message: string) => void
}

export interface EnsembleOptions {
  /** Number of samples to run (≥1). */
  n: number
  /** Optional per-sample steering prompts; cycled when shorter than `n`. */
  lens?: string[]
  aggregation: EnsembleAggregation
  /** Max concurrent samples. Default 4 (council parity). */
  iterationConcurrency?: number
  /** Per-sample timeout (ms). Default 180000. */
  timeoutMs?: number
  /** How long a stopped sample may take to settle before its slot is given back. */
  stopGraceMs?: number
  /** Stops the ensemble: running samples are aborted, no new one starts, nothing is synthesized. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_CONCURRENCY = 4

/** Read the value a policy votes/scores on: `object[field]`, or the text. */
function readField(sample: EnsembleSampleResult, field?: string): unknown {
  if (field && field.length > 0) {
    if (sample.object && typeof sample.object === "object") {
      return (sample.object as Record<string, unknown>)[field]
    }
    return undefined
  }
  return sample.object ?? sample.text
}

function aggregate(
  samples: EnsembleSampleResult[],
  policy: EnsembleAggregation,
  synthesized?: string
): unknown {
  const completed = samples.filter((s) => s.status === "completed")
  switch (policy.kind) {
    case "majority-vote-on-field": {
      // The most common answer with its count; deciding whether that is
      // enough is `threshold-count`'s job.
      if (completed.length === 0) return null
      const best = leader(tally(completed.map((s) => ({ key: readField(s, policy.field) }))))
      return { value: best?.key ?? null, count: best?.count ?? 0, total: completed.length }
    }
    case "threshold-count": {
      const count = completed.filter((s) => {
        const v = readField(s, policy.field)
        return "equals" in policy ? valueKey(v) === valueKey(policy.equals) : Boolean(v)
      }).length
      return {
        passed: quorumMet({ kind: "at-least", count: policy.threshold }, count, completed.length),
        count,
        threshold: policy.threshold,
      }
    }
    case "best-of-by-score": {
      const best = bestByScore(rankByScore(completed, (s) => [readField(s, policy.scoreField)]))
      if (!best || best.mean === null) return null
      return {
        winner: best.item.object ?? best.item.text,
        score: best.mean,
        index: best.item.index,
      }
    }
    case "synthesize-by-final-agent":
      return synthesized ?? null
    default:
      return null
  }
}

export async function runEnsemble(
  opts: EnsembleOptions,
  deps: RunEnsembleDeps
): Promise<EnsembleResult> {
  const n = Math.floor(opts.n)
  if (!Number.isFinite(n) || n < 1) throw new Error("runEnsemble: n must be ≥ 1")
  if (!opts.aggregation) throw new Error("runEnsemble: an aggregation policy is required")
  if (opts.aggregation.kind === "synthesize-by-final-agent" && !deps.synthesize) {
    throw new Error("runEnsemble: synthesize-by-final-agent requires deps.synthesize")
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency = opts.iterationConcurrency ?? DEFAULT_CONCURRENCY
  const lenses = opts.lens && opts.lens.length > 0 ? opts.lens : undefined

  deps.log?.(
    "info",
    `ensemble: ${n} samples (concurrency ${concurrency}, ${opts.aggregation.kind})`
  )

  const indices = Array.from({ length: n }, (_, i) => i)
  const outcomes = await boundedFanOut(
    indices,
    async (i, _position, signal): Promise<RunEnsembleSampleOutput> =>
      deps.runSample({ index: i, ...lensFor(lenses, i), signal }),
    {
      concurrency,
      timeoutMs,
      timeoutLabel: "ensemble sample",
      ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
  )
  // A stopped ensemble reports nothing: its samples were cut short, and a
  // synthesis over them would spend a call nobody is waiting for.
  opts.signal?.throwIfAborted()
  const samples = outcomes.map((outcome, i) => sampleOf(i, lensFor(lenses, i).lens, outcome, deps))

  const respondedCount = samples.filter((s) => s.status === "completed").length

  let synthesized: string | undefined
  if (
    opts.aggregation.kind === "synthesize-by-final-agent" &&
    deps.synthesize &&
    respondedCount > 0
  ) {
    const out = await deps.synthesize(samples, opts.aggregation.instructions, opts.signal)
    synthesized = out.text
  }

  return {
    result: aggregate(samples, opts.aggregation, synthesized),
    aggregation: opts.aggregation.kind,
    samples,
    respondedCount,
    totalCount: samples.length,
  }
}

function lensFor(lenses: string[] | undefined, index: number): { lens?: string } {
  return lenses ? { lens: lenses[index % lenses.length] } : {}
}

/** One sample's result from its fan-out outcome. A blank reply is a failed sample, not a vote. */
function sampleOf(
  index: number,
  lens: string | undefined,
  outcome: FanOutOutcome<RunEnsembleSampleOutput>,
  deps: RunEnsembleDeps
): EnsembleSampleResult {
  const base = { index, ...(lens ? { lens } : {}) }
  if (outcome.status === "skipped") {
    return { ...base, status: "failed", error: "not started: the ensemble was stopped" }
  }
  if (outcome.status === "rejected") {
    const message =
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "aborted")
    deps.log?.(
      "warn",
      outcome.stopped
        ? `ensemble sample ${index} failed: ${message}`
        : `ensemble sample ${index} failed: ${message}; it had not stopped when its slot was released`
    )
    return {
      ...base,
      status: "failed",
      error: message,
      ...(outcome.stopped ? {} : { stopUnconfirmed: true as const }),
    }
  }
  const out = outcome.value
  const text = answerText(out.text)
  if (!isAnswer({ text, object: out.object })) {
    deps.log?.("warn", `ensemble sample ${index} failed: empty response`)
    return { ...base, status: "failed", error: "empty response" }
  }
  return {
    ...base,
    status: "completed",
    ...(text !== undefined ? { text } : {}),
    ...(out.object !== undefined ? { object: out.object } : {}),
  }
}
