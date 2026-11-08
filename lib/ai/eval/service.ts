/**
 * Eval service facade — the ONE entry the UI, the `eval.run`/`eval.gate`
 * workflow nodes, and the `cognia-eval` plugin tools call. Composes the
 * existing engine (`runConfiguredEval` over `buildConfiguredRunDeps`) and the
 * gate (`evaluateGate` against the dataset's stored thresholds), and fans
 * per-case saves out into an `onProgress` callback. Engine untouched.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalCase, EvalDataset, EvalReport } from "@/types/eval/eval"
import type { EvalRunConfig } from "@/types/eval/run-config"
import type { GateResult } from "@/types/eval/gate"
import { evaluateGate } from "@cognia/eval-core"
import { filterCases, runConfiguredEval, type RunConfiguredDeps } from "./run-config"
import { buildConfiguredRunDeps } from "./browser-deps"
import { loadEvalAppSettings } from "./runtime-context"
import { resolveEvalSettings } from "./settings"
import { queryByTrace } from "@/lib/db/agent-traces"
import {
  preparePersonalHistory,
  preparePersonalDerivedHistory,
} from "@/lib/execution/personal-visibility"
import {
  mergePersonalMarks,
  type PersonalMarkV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { personalEvalSampleForRun } from "./targets/chat"
import type { EvalDatasetSummary, EvalRunDetail } from "@cognia/plugin-contract/lib/ai/eval/service"
export type { EvalDatasetSummary, EvalRunDetail } from "@cognia/plugin-contract/lib/ai/eval/service"

export interface EvalProgress {
  done: number
  total: number
  /** Cases that passed every scored scorer on repetition 1 so far. */
  passing: number
  /**
   * Cases no selected scorer could grade so far. Reported separately because a
   * live "0 passing" that is really "nothing is being graded" is the single
   * most misleading thing this progress bar can say.
   */
  ungraded: number
}

export interface RunEvalServiceInput {
  datasetId: string
  config: EvalRunConfig
  appSettings: AppSettings | null
  /** Override the cross-model judge. */
  judgeModel?: string
  /** Skip the LLM judge tier — deterministic scorers only. */
  forceDeterministic?: boolean
  signal?: AbortSignal
  onProgress?: (p: EvalProgress) => void
  /** Test / caller seam — defaults to the browser/Dexie wiring. */
  deps?: RunConfiguredDeps
  /** Host admission correlation; never sourced from an eval case or trace. */
  executionRunId?: string
}

/** Stored cases can contain full trace snapshots, golden tool names and prior
 * turns. Check their canonical source as one unit before any target or judge. */
export async function personalEvalCaseForRun(
  evalCase: EvalCase,
  executionRunId?: string
): Promise<EvalCase> {
  const record = evalCase as EvalCase & {
    personalMarks?: PersonalMarkV1[]
    metadata?: { personalMarks?: PersonalMarkV1[] }
  }
  const metadata = {
    personalMarks: mergePersonalMarks(record.personalMarks, record.metadata?.personalMarks),
  }
  const probes = []
  if (evalCase.sourceTraceId) {
    const spans = await queryByTrace(evalCase.sourceTraceId)
    const sources = new Map(
      spans.map((span) => [JSON.stringify([span.sessionId, span.runId]), span])
    )
    for (const span of sources.values()) {
      const result = await preparePersonalDerivedHistory(
        undefined,
        [{ id: evalCase.id, text: evalCase.input, metadata }],
        {
          sessionId: span.sessionId || undefined,
          ...(span.runId ? { runIds: [span.runId] } : {}),
          executionRunId,
        }
      )
      probes.push(result)
    }
    if (sources.size === 0) {
      // Deleted provenance cannot turn an old private preview into public input.
      probes.push(
        await preparePersonalHistory(
          undefined,
          [
            {
              id: evalCase.id,
              text: evalCase.input,
              metadata: {
                personalMarks: [
                  {
                    person: { kind: "service", ref: "unavailable-eval-source" },
                    source: "lost-eval-trace",
                    markedAt: 0,
                  },
                ],
              },
            },
          ],
          { executionRunId }
        )
      )
    }
  } else {
    probes.push(
      await preparePersonalDerivedHistory(
        undefined,
        [{ id: evalCase.id, text: evalCase.input, metadata }],
        { executionRunId }
      )
    )
  }
  const denied = probes.find((result) => result.withheldMessageIds.length > 0)
  if (!denied) return evalCase
  return {
    id: evalCase.id,
    datasetId: evalCase.datasetId,
    input: denied.messages[0].text,
    capability: "withheld",
    source: evalCase.source,
    createdAt: evalCase.createdAt,
    updatedAt: evalCase.updatedAt,
  }
}

export interface RunEvalServiceResult {
  reports: EvalReport[]
  /** Per-run gate verdicts; only set when the dataset has thresholds. */
  gates?: Record<string, GateResult>
  /** AND across all reports; undefined when no gate is configured. */
  gatePassed?: boolean
  /** True when no judge client resolved — deterministic scorers only. */
  deterministicOnly: boolean
}

export async function runEvalService(input: RunEvalServiceInput): Promise<RunEvalServiceResult> {
  let deterministicOnly = false
  let deps = input.deps
  if (!deps) {
    const wired = buildConfiguredRunDeps({
      appSettings: input.appSettings,
      ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
      ...(input.forceDeterministic ? { forceDeterministic: true } : {}),
    })
    deps = wired.deps
    deterministicOnly = wired.deterministicOnly
  }

  const dataset = await deps.loadDataset(input.datasetId)
  if (!dataset) throw new Error(`runEvalService: dataset "${input.datasetId}" not found`)

  const loadCases = deps.loadCases.bind(deps)
  const rawCases = filterCases(await loadCases(input.datasetId), input.config.subset)
  const originals = new Map(rawCases.map((row) => [row.id, row]))
  const visibleCases = await Promise.all(
    rawCases.map((row) => personalEvalCaseForRun(row, input.executionRunId))
  )
  const caseCount = visibleCases.length
  const total = caseCount * Math.max(1, input.config.targets.length)
  let done = 0
  let passing = 0
  let ungraded = 0
  const baseSave = deps.saveCaseResult.bind(deps)
  const progressDeps: RunConfiguredDeps = {
    ...deps,
    loadCases: async () => visibleCases,
    buildTarget: (spec) => {
      const target = deps.buildTarget(spec)
      return {
        ...target,
        run: async (row, signal) =>
          target.run(
            await personalEvalCaseForRun(originals.get(row.id) ?? row, input.executionRunId),
            signal
          ),
      }
    },
    allScorers: deps.allScorers.map((scorer) => ({
      ...scorer,
      score: async (sample, row) =>
        scorer.score(
          scorer.requiresLlm
            ? await personalEvalSampleForRun(sample, input.executionRunId)
            : sample,
          await personalEvalCaseForRun(originals.get(row.id) ?? row, input.executionRunId)
        ),
    })),
    saveCaseResult: async (row) => {
      await baseSave(row)
      done += 1
      if (row.verdict === "ungraded") ungraded += 1
      else if (row.verdict === "pass") passing += 1
      input.onProgress?.({ done, total, passing, ungraded })
    },
  }

  const reports = await runConfiguredEval(
    input.datasetId,
    { ...input.config, subset: { caseIds: visibleCases.map((row) => row.id) } },
    progressDeps,
    input.signal
  )

  if (!dataset.gate) return { reports, deterministicOnly }
  const gates: Record<string, GateResult> = {}
  for (const r of reports) gates[r.runId] = evaluateGate(r, dataset.gate)
  return {
    reports,
    gates,
    gatePassed: Object.values(gates).every((g) => g.passed),
    deterministicOnly,
  }
}

// ── Read-side queries (browser/Dexie wired — thin, mirrors browser-deps) ─────

export async function listDatasetSummaries(): Promise<EvalDatasetSummary[]> {
  const { listDatasets, listCases } = await import("@/lib/db/eval-datasets")
  const { listRunsByDataset } = await import("@/lib/db/eval-runs")
  const datasets = await listDatasets()
  return Promise.all(
    datasets.map(async (d) => {
      const [cases, runs] = await Promise.all([listCases(d.id), listRunsByDataset(d.id)])
      const latest = runs[0]
      return {
        id: d.id,
        name: d.name,
        capability: d.capability,
        version: d.version,
        caseCount: cases.length,
        ...(latest
          ? {
              latestRun: {
                runId: latest.runId,
                passAt1: latest.passAt1,
                createdAt: latest.createdAt,
                targetLabel: latest.targetLabel,
              },
            }
          : {}),
      }
    })
  )
}

export async function getRunDetail(runId: string): Promise<EvalRunDetail | undefined> {
  const { getRun } = await import("@/lib/db/eval-runs")
  const { listCaseResults } = await import("@/lib/db/eval-run-cases")
  const report = await getRun(runId)
  if (!report) return undefined
  return { report, cases: await listCaseResults(runId) }
}

/** Create a user dataset using the host's current default gate. */
export async function createEvalDataset(input: {
  name: string
  capability: string
}): Promise<EvalDataset> {
  const name = input.name.trim()
  const capability = input.capability.trim()
  if (!name || !capability) throw new TypeError("Dataset name and capability are required")
  const { defaultGate } = resolveEvalSettings(await loadEvalAppSettings())
  const { createDataset } = await import("@/lib/db/eval-datasets")
  return createDataset({ name, capability, ...(defaultGate ? { gate: defaultGate } : {}) })
}
