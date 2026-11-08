/** @jest-environment jsdom */
/** Service facade — progress fan-out + gate verdicts over runConfiguredEval. */
import {
  runEvalService,
  listDatasetSummaries,
  getRunDetail,
  createEvalDataset,
  personalEvalCaseForRun,
} from "./service"
import type { RunConfiguredDeps } from "./run-config"
import type { EvalCase, EvalDataset, Scorer } from "@/types/eval/eval"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  startToolExecutionRun,
  finishToolExecutionRun,
  LOCAL_PERSON_RUN,
} from "@/lib/execution/acting-authority"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

jest.mock("@/lib/db/eval-datasets", () => ({
  createDataset: jest.fn(),
  listDatasets: jest.fn(async () => [
    { id: "d1", name: "DS", capability: "chat", version: 3, createdAt: 1, updatedAt: 2 },
  ]),
  listCases: jest.fn(async () => [{ id: "c1" }, { id: "c2" }]),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  getRun: jest.fn(async (id: string) =>
    id === "r1" ? { runId: "r1", datasetId: "d1", passAt1: 1 } : undefined
  ),
  listRunsByDataset: jest.fn(async () => [
    { runId: "r1", passAt1: 1, createdAt: 9, targetLabel: "m" },
  ]),
}))
jest.mock("@/lib/db/eval-run-cases", () => ({
  listCaseResults: jest.fn(async () => [
    { id: "r1::c1", runId: "r1", caseId: "c1", scores: {}, passAt1: true },
  ]),
}))
// Default-wiring seam: the no-deps path goes through buildConfiguredRunDeps.
const buildConfiguredRunDeps = jest.fn()
jest.mock("./browser-deps", () => ({
  buildConfiguredRunDeps: (...a: unknown[]) => buildConfiguredRunDeps(...(a as [])),
}))

const dataset: EvalDataset = {
  id: "d1",
  name: "DS",
  capability: "chat",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  gate: { minPassAt1: 0.99 },
}
const cases: EvalCase[] = [
  {
    id: "c1",
    datasetId: "d1",
    input: "hi",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "c2",
    datasetId: "d1",
    input: "yo",
    capability: "chat",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
  },
]
const passScorer: Scorer = {
  id: "assertion",
  dimension: "response-quality",
  requiresLlm: false,
  gating: true,
  score: () => ({
    scorerId: "assertion",
    dimension: "response-quality",
    status: "scored",
    value: 1,
    passed: true,
  }),
}

function makeDeps(): RunConfiguredDeps {
  let n = 0
  return {
    loadDataset: async () => dataset,
    loadCases: async () => cases,
    snapshot: async () => ({ id: "v1", datasetId: "d1", version: 3, createdAt: 1, cases }) as never,
    buildTarget: () => ({
      label: "t",
      run: async () => ({
        output: "ok",
        toolCalls: [],
        retrievedChunks: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0,
        latencyMs: 1,
        stepCount: 1,
        degraded: false,
      }),
    }),
    allScorers: [passScorer],
    saveRun: async () => {},
    saveCaseResult: async () => {},
    now: () => 123,
    newRunId: () => `run_${++n}`,
  }
}

describe("runEvalService", () => {
  it("selects original capability labels before withholding the case envelope", async () => {
    const deps = makeDeps()
    deps.loadCases = async () => [{ ...cases[0], capability: "private-capability" }]
    const run = jest.fn(async () => ({
      output: "ok",
      toolCalls: [],
      retrievedChunks: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      stepCount: 1,
      degraded: false,
    }))
    deps.buildTarget = () => ({ label: "t", run })
    const result = await runEvalService({
      datasetId: "d1",
      config: {
        targets: [{ kind: "chat", label: "t", model: "m" }],
        scorerIds: [],
        k: 1,
        subset: { capabilities: ["private-capability"] },
      },
      appSettings: null,
      deps,
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.reports[0].caseCount).toBe(1)
    expect(JSON.stringify(run.mock.calls)).not.toContain("private-capability")
  })
  it("withholds a trace-derived case as a whole, including fallback snapshots and golden tools", async () => {
    const db = getDb()
    await db.sessions.put({
      id: "private-source",
      title: "PRIVATE TITLE",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    await db.messages.put({
      id: "private-row",
      sessionId: "private-source",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "PRIVATE PROMPT" }],
      metadata: {
        personalMarks: [{ person: { kind: "local-person" }, source: "read", markedAt: 1 }],
      },
    } as never)
    const source = await startToolExecutionRun("private-source", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await finishToolExecutionRun(source.id)
    await db.agentTraces.put({
      id: "trace-span",
      traceId: "private-trace",
      startTime: 1,
      sessionId: "private-source",
      runId: source.id,
    } as never)
    const row: EvalCase = {
      ...cases[0],
      source: "real-trace",
      sourceTraceId: "private-trace",
      input: "PRIVATE PREVIEW",
      history: [{ role: "assistant", content: "PRIVATE PRIOR" }],
      reference: { expectedTools: ["PrivateTool"] },
      contentParts: [{ type: "text", text: "PRIVATE PART" }],
      notes: "PRIVATE NOTE",
    }
    const filtered = await personalEvalCaseForRun(row)
    expect(filtered.input).toContain("[Withheld: personal content of")
    expect(JSON.stringify(filtered)).not.toMatch(/PRIVATE|PrivateTool/)
    const owner = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
    expect(await personalEvalCaseForRun(row, owner.id)).toEqual(row)
    await finishToolExecutionRun(owner.id)
    await db.agentTraces.clear()
    expect((await personalEvalCaseForRun(row)).input).toContain("[Withheld: personal content of")
  })

  it("blocks unproven sample tool outputs and retrieved chunks before model-backed judging", async () => {
    const judge = jest.fn(passScorer.score)
    const deps = makeDeps()
    deps.allScorers = [{ ...passScorer, requiresLlm: true, score: judge }]
    deps.buildTarget = () => ({
      label: "private-child",
      run: async () => ({
        output: "PRIVATE OUTPUT",
        toolCalls: [{ name: "PrivateTool", args: { secret: "PRIVATE ARG" }, index: 0 }],
        retrievedChunks: [{ text: "PRIVATE DOCUMENT" }],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0,
        latencyMs: 1,
        stepCount: 1,
        degraded: false,
      }),
    })
    await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps,
    })
    expect(judge).toHaveBeenCalled()
    expect(JSON.stringify(judge.mock.calls)).not.toMatch(/PRIVATE|PrivateTool/)
    expect(judge.mock.calls[0][0].output).toContain("[Withheld: personal content of")
  })
  it("runs, reports progress per case, and gates each report", async () => {
    const ticks: Array<{ done: number; total: number; passing: number }> = []
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps: makeDeps(),
      onProgress: (p) => ticks.push({ ...p }),
    })
    expect(res.reports).toHaveLength(1)
    expect(ticks).toEqual([
      { done: 1, total: 2, passing: 1, ungraded: 0 },
      { done: 2, total: 2, passing: 2, ungraded: 0 },
    ])
    expect(res.gates?.["run_1"]?.passed).toBe(true)
    expect(res.gatePassed).toBe(true)
  })

  it("throws on unknown dataset", async () => {
    const deps = { ...makeDeps(), loadDataset: async () => undefined }
    await expect(
      runEvalService({
        datasetId: "ghost",
        config: { targets: [], scorerIds: [], k: 1 },
        appSettings: null,
        deps,
      })
    ).rejects.toThrow(/not found/)
  })

  it("omits gates when the dataset has no thresholds", async () => {
    const deps = { ...makeDeps(), loadDataset: async () => ({ ...dataset, gate: undefined }) }
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps,
    })
    expect(res.gates).toBeUndefined()
    expect(res.gatePassed).toBeUndefined()
  })

  it("falls back to buildConfiguredRunDeps (with judgeModel) when no deps are injected", async () => {
    buildConfiguredRunDeps.mockReturnValue({ deps: makeDeps(), deterministicOnly: true })
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      judgeModel: "judge-x",
    })
    expect(buildConfiguredRunDeps).toHaveBeenCalledWith({
      appSettings: null,
      judgeModel: "judge-x",
    })
    expect(res.deterministicOnly).toBe(true)
    expect(res.reports).toHaveLength(1)
  })

  it("omits judgeModel from the default wiring when not given", async () => {
    buildConfiguredRunDeps.mockReturnValue({ deps: makeDeps(), deterministicOnly: false })
    await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
    })
    expect(buildConfiguredRunDeps).toHaveBeenLastCalledWith({ appSettings: null })
  })

  it("flags gatePassed=false when any report misses a threshold", async () => {
    const failingDataset = { ...dataset, gate: { minPassAt1: 2 } }
    const deps = { ...makeDeps(), loadDataset: async () => failingDataset }
    const res = await runEvalService({
      datasetId: "d1",
      config: { targets: [{ kind: "chat", label: "t", model: "m" }], scorerIds: [], k: 1 },
      appSettings: null,
      deps,
    })
    expect(res.gatePassed).toBe(false)
    expect(res.gates?.["run_1"]?.failures.length).toBeGreaterThan(0)
  })
})

describe("queries", () => {
  it("listDatasetSummaries folds case count and latest run", async () => {
    const rows = await listDatasetSummaries()
    expect(rows).toEqual([
      expect.objectContaining({
        id: "d1",
        caseCount: 2,
        latestRun: expect.objectContaining({ runId: "r1" }),
      }),
    ])
  })

  it("omits latestRun when a dataset has no runs", async () => {
    const { listRunsByDataset } = jest.requireMock("@/lib/db/eval-runs") as {
      listRunsByDataset: jest.Mock
    }
    listRunsByDataset.mockResolvedValueOnce([])
    const rows = await listDatasetSummaries()
    expect(rows[0]).not.toHaveProperty("latestRun")
  })

  it("getRunDetail joins report and per-case rows", async () => {
    const detail = await getRunDetail("r1")
    expect(detail?.report.runId).toBe("r1")
    expect(detail?.cases).toHaveLength(1)
    expect(await getRunDetail("nope")).toBeUndefined()
  })
})

jest.mock("./runtime-context", () => ({ loadEvalAppSettings: jest.fn() }))

describe("createEvalDataset", () => {
  const { createDataset } = jest.requireMock("@/lib/db/eval-datasets") as {
    createDataset: jest.Mock
  }
  const { loadEvalAppSettings } = jest.requireMock("./runtime-context") as {
    loadEvalAppSettings: jest.Mock
  }

  beforeEach(() => {
    createDataset.mockReset().mockResolvedValue(dataset)
    loadEvalAppSettings.mockReset().mockResolvedValue(null)
  })

  it("normalizes form fields and stamps the current configured gate", async () => {
    const gate = { minPassAt1: 0.8 }
    loadEvalAppSettings.mockResolvedValueOnce({ evalSettings: { defaultGate: gate } })
    await expect(createEvalDataset({ name: " Set A ", capability: " chat " })).resolves.toBe(
      dataset
    )
    expect(createDataset).toHaveBeenCalledWith({ name: "Set A", capability: "chat", gate })
    loadEvalAppSettings.mockResolvedValueOnce({
      evalSettings: { defaultGate: { minPassAt1: 0.9 } },
    })
    await createEvalDataset({ name: "Set B", capability: "chat" })
    expect(createDataset).toHaveBeenLastCalledWith({
      name: "Set B",
      capability: "chat",
      gate: { minPassAt1: 0.9 },
    })
  })

  it("creates without a gate when settings have none", async () => {
    await createEvalDataset({ name: "Set", capability: "chat" })
    expect(createDataset).toHaveBeenCalledWith({ name: "Set", capability: "chat" })
  })

  it.each([
    { name: " ", capability: "chat" },
    { name: "Set", capability: " " },
  ])("rejects blank fields before persistence: %j", async (input) => {
    await expect(createEvalDataset(input)).rejects.toThrow(TypeError)
    expect(createDataset).not.toHaveBeenCalled()
  })

  it("propagates persistence failure without reporting a created dataset", async () => {
    createDataset.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(createEvalDataset({ name: "Set", capability: "chat" })).rejects.toThrow(
      "database unavailable"
    )
  })
})
