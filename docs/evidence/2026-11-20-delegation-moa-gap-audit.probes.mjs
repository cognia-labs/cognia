import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const directory = path.join(root, ".cache", "delegation-moa-gap-audit")
mkdirSync(directory, { recursive: true })

// Reuse the existing Jest fixtures in the ignored cache. A witness passes
// when the current behavior appears, including the reported gaps.
function fixture(name, original, scenario) {
  const base = path.posix.dirname(original)
  const source = readFileSync(path.join(root, original), "utf8").replace(
    /(["'])(\.\.?\/[^"'\n]+)\1/g,
    (_, quote, relative) => quote + "@/" + path.posix.normalize(base + "/" + relative) + quote
  )
  const file = path.join(directory, `${name}.audit.ts`)
  writeFileSync(file, source + "\n" + scenario)
  return file
}

const files = [
  fixture(
    "api",
    "lib/router-fusion/api/run-api.test.ts",
    String.raw`
it("Audit witness F01: two concurrent creates with one key both launch", async () => {
  const h = harness()
  const request = { actor: KEY_A, body: body(), idempotencyKey: "audit-d01" }
  const [first, second] = await Promise.all([
    createRunFromApi(h.deps, request),
    createRunFromApi(h.deps, request),
  ])
  expect(first).toMatchObject({ ok: true, value: { replayed: false } })
  expect(second).toMatchObject({ ok: true, value: { replayed: false } })
  expect(h.createRun).toHaveBeenCalledTimes(2)
  expect(h.sessions.size).toBe(2)
  expect(new Set(h.started).size).toBe(2)
  const replay = await createRunFromApi(h.deps, request)
  expect(replay).toMatchObject({
    ok: true, value: { replayed: true, accepted: { run_id: h.started.at(-1) } },
  })
  expect(h.started).toHaveLength(2)
})
`
  ),
  fixture(
    "squad-approval",
    "lib/squads/delegation-orchestrator.test.ts",
    String.raw`
it("Audit witness F03: a Squad approval cannot be reconstructed from persisted state", async () => {
  useAgentTeamStore.getState().reset()
  __resetPendingDelegationRunsForTesting()
  resetLauncher()
  const { delegation, completionPromise } = delegateToBackground({
    sourceTeamId: "audit-team", sourceTaskId: "audit-task", prompt: "Check a fixture",
    reason: "Requires review", awaitingApproval: true,
  })
  expect(await completionPromise).toMatchObject({ status: "awaiting_approval" })
  const storageKey = useAgentTeamStore.persist.getOptions().name
  const saved = localStorage.getItem(storageKey)
  expect(saved).toBeTruthy()
  expect(JSON.parse(saved!).state).not.toHaveProperty("delegations")
  __resetPendingDelegationRunsForTesting()
  useAgentTeamStore.setState({ delegations: {} })
  localStorage.setItem(storageKey, saved!)
  await useAgentTeamStore.persist.rehydrate()
  expect(approveDelegation(delegation.id)).toBeUndefined()
  expect(launchMock).not.toHaveBeenCalled()
})
`
  ),
  fixture(
    "squad-result",
    "lib/squads/ports/squad-launch.test.ts",
    String.raw`
it.each([undefined, "report from previous run"])(
  "Audit witness F04: a completed child returns the team field %s without checking its run",
  async (previousReport) => {
    startSquadRunMock.mockResolvedValue(launched)
    awaitSettlementMock.mockResolvedValue("completed")
    teams["squad-2"] = previousReport ? { finalResult: previousReport } : {}
    const result = await port.start({ squadId: "squad-2", brief: "current work", origin: "delegation" })
    if (!result.started) throw new Error("expected a started run")
    await expect(result.outcome).resolves.toEqual({
      status: "completed", ...(previousReport ? { text: previousReport } : {}),
    })
    expect(awaitSettlementMock).toHaveBeenCalledWith(launched.executionRunId)
  }
)
`
  ),
  fixture(
    "orchestrator",
    "lib/router-fusion/runtime/orchestrator-delegate.test.ts",
    String.raw`
it("Audit witness F02: a real delegate run seals failed and loses the lead's question", async () => {
  const h = harness()
  await createRun(h)
  const question = "Which list should change?"
  const { deps: d, requests } = deps(h, {
    lead: [plan({ status: "need_input", subtasks: [], questions: [question] })],
  })
  const outcome = await executeFusionRun(d, { runId: RUN_ID })
  expect(outcome).toEqual({
    kind: "failed",
    code: "DELEGATE_NEEDS_INPUT",
    message: "the lead needs more information before the work can be delegated",
  })
  expect(requests.map(({ role }) => role)).toEqual(["lead"])
  const run = await h.store.getRun(RUN_ID)
  expect(run?.status).toBe("failed")
  expect(JSON.stringify(run?.error)).not.toContain(question)
  const attempt = (await h.db.fusionCallAttempts.where("runId").equals(RUN_ID).toArray())[0]
  expect(attempt).toMatchObject({ state: "SUCCEEDED", logicalStepId: "delegate:plan" })
  const transcript = await h.store.artifactStore(RUN_ID).get(attempt.resultArtifactId!)
  expect(transcript?.content).toContain(question)
  expect(await h.store.resumeRun(RUN_ID, { kind: "input" })).toEqual({
    ok: false, code: "RUN_NOT_WAITING",
  })
})

it("Audit witness F11: retry cannot resume after the approval write commits alone", async () => {
  const { decideApproval } = await import("@/lib/router-fusion/db/delegate-store")
  const { recoverStaleFusionRuns } = await import("@/lib/router-fusion/chat/chat-runs")
  const h = harness()
  await createRun(h)
  const { deps: d } = deps(h, {
    lead: [plan()], worker: [write("tests/users/list.test.ts"), done()],
  })
  const parked = await executeFusionRun(d, { runId: RUN_ID })
  if (parked.kind !== "waiting") throw new Error("expected approval wait")
  const approvalId = parked.approval.approvalId
  const before = (await h.store.getRun(RUN_ID))!
  // The first write is real. Stop here to simulate interruption before resumeRun.
  expect(await decideApproval(h.db, {
    runId: RUN_ID, approvalId, decision: "approve", now: Date.now(),
  })).toMatchObject({ ok: true, row: { status: "approved" } })
  expect(await decideFusionApproval(h.store, {
    runId: RUN_ID, approvalId, decision: "approve", expectedVersion: before.lastSeq,
  })).toMatchObject({ ok: false, code: "RUN_NOT_WAITING" })
  const resumeOrchestrated = jest.fn(() => true)
  expect(await recoverStaleFusionRuns({
    store: async () => h.store, appliers, leaseOwner: "audit-new-worker",
    now: () => before.leaseExpiresAt + 60_000, resumeOrchestrated,
  })).toBe(0)
  expect(resumeOrchestrated).not.toHaveBeenCalled()
  expect((await h.store.getRun(RUN_ID))?.status).toBe("waiting_for_approval")
  expect(await pendingApprovalOf(h.db, RUN_ID)).toBeUndefined()
})
`
  ),
  fixture(
    "orchestrator-seal",
    "lib/router-fusion/runtime/orchestrator-host.test.ts",
    String.raw`
it("Audit witness F12: an accepted cancel wins the journal while execute returns success", async () => {
  const { readRunResult } = await import("@/lib/router-fusion/api/run-api")
  const { store } = harness()
  const runId = "audit-cancel-at-seal"
  expect(await store.createRun(runInput(runId))).toMatchObject({ ok: true })
  const finalize = store.finalizeRun.bind(store)
  const boundary = jest.spyOn(store, "finalizeRun").mockImplementationOnce(async (...args) => {
    expect(args[2].status).toBe("succeeded")
    expect((await store.cancelRun(runId))?.status).toBe("cancelling")
    return finalize(...args)
  })
  try {
    expect(await executeFusionRun(deps(store, { cancelPollMs: 1_000_000 }), {
      runId, messages: MESSAGES,
    })).toMatchObject({ kind: "succeeded", result: { answer: "the answer" } })
    const row = (await store.getRun(runId))!
    expect(row.status).toBe("cancelled")
    expect((await store.listEvents(runId)).map(({ type }) => type)).not.toContain("answer.completed")
    expect(await readRunResult(store, row)).toMatchObject({ result: { answer: "the answer" } })
  } finally {
    boundary.mockRestore()
  }
})

it("Audit witness F13: boot seals a handoff awaiting reconciliation as a lost run", async () => {
  const { recoverStaleFusionRuns } = await import("@/lib/router-fusion/chat/chat-runs")
  let now = 1_800_000_000_000
  const { store } = harness(() => now)
  const runId = "audit-reconciling-at-boot"
  expect(await store.createRun(runInput(runId, {
    driver: "orchestrator", actionId: "delegate_code",
    roleDeployments: { lead: "fake-baseline", worker: "fake-economy" },
  }))).toMatchObject({ ok: true })
  const lease = await store.acquireLease(runId, "audit-old-worker", 60_000)
  if (!lease.ok) throw new Error(lease.code)
  expect(await store.startRun(runId, lease.fencingToken)).toMatchObject({ ok: true })
  expect(await store.reconcileRun(runId, lease.fencingToken, {
    code: "SIDE_EFFECT_OUTCOME_UNKNOWN", logicalStepId: "apply-fixture", sideEffect: "apply_patch",
  })).toEqual({ ok: true })
  expect((await store.getRun(runId))?.status).toBe("reconciling")
  now += 61_000
  const resumeOrchestrated = jest.fn(() => true)
  expect(await recoverStaleFusionRuns({
    store: async () => store, appliers, leaseOwner: "audit-new-worker", now: () => now,
    resumeOrchestrated,
  })).toBe(1)
  expect(resumeOrchestrated).not.toHaveBeenCalled()
  expect(await store.getRun(runId)).toMatchObject({ status: "failed", error: { code: "RUN_LOST" } })
  expect((await store.listEvents(runId)).map(({ type }) => type)).toContain("reconciliation.required")
})
`
  ),
  fixture(
    "delegation-steer",
    "lib/execution/steer.test.ts",
    String.raw`
it("Audit witness F06: queued-only child becomes delivered at the delegation boundary", async () => {
  __resetSteerForTesting()
  runs.clear()
  run("audit-delegation", { kind: "delegation" })
  run("audit-child", { kind: "team", parentRunId: "audit-delegation" })
  const child = jest.fn(async () => ({ status: "queued" as const, entryId: "audit-queued" }))
  const detach = registerRunSteerEngine("team", child)
  try {
    await expect(steerRun({
      target: { runId: "audit-delegation" }, origin: "person", content: "Pause the next stage",
    })).resolves.toEqual({ status: "delivered", receiptIds: [] })
    expect(child).toHaveBeenCalledTimes(1)
  } finally {
    detach()
  }
})
`
  ),
  fixture(
    "router",
    "packages/router-fusion/src/routing/action-router.test.ts",
    String.raw`
it("Audit witness F07: a feasible distinct panel is refused when the first role picks collide", () => {
  const registry = fakeTierRegistry()
  const shared = registry.deployments.find((d) => d.id === "fake-economy")!
  registry.deployments = registry.deployments.map((deployment) =>
    deployment.id === "fake-independent"
      ? { ...deployment, modelRevision: shared.modelRevision }
      : deployment
  )
  registry.aliases.balanced = ["fake-independent", "fake-baseline"]
  const config = fakeCompiledConfig({ registry })
  const request = fixtureRouteRequest({ requestedMode: "panel", allowedModes: ["panel"] })
  const result = routeAction(config, request)
  expect(result.details.find((detail) => detail.actionId === "panel_review")?.roles).toMatchObject({
    panel_a: "fake-economy", panel_b: "fake-independent",
  })
  expect(candidate(result, "panel_review").exclusion_reasons).toContain("PANEL_SAME_REVISION")
  expect(result.decision.selected_action_id).toBeNull()
  const alternative = routeAction(config, {
    ...request,
    roleDeploymentOverrides: { panel_b: "fake-baseline" },
  })
  expect(alternative.decision.selected_action_id).toBe("panel_review")
})
`
  ),
  fixture(
    "panel-host-route",
    "lib/router-fusion/routing/run-route.test.ts",
    String.raw`
it("Audit witness F07: host routing refuses a feasible panel until the alias order changes", async () => {
  const { host } = makeHost({ aliases: { fast: [MINI], balanced: [MINI, SONNET], powerful: [GPT] } })
  const rejected = await routeRunRequest(host, input())
  expect(rejected).toMatchObject({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
  if (rejected.kind !== "refused") throw new Error("expected no solution")
  expect(rejected.reasons).toContain("panel_review:PANEL_SAME_REVISION")
  const reordered = makeHost({ aliases: { fast: [MINI], balanced: [SONNET, MINI], powerful: [GPT] } })
  expect(await routeRunRequest(reordered.host, input())).toMatchObject({
    kind: "selected", roles: { panel_a: "openai::gpt-5-mini", panel_b: "anthropic::claude-sonnet-5" },
  })
})
`
  ),
  fixture(
    "ensemble",
    "lib/ai/ensemble/run-ensemble.test.ts",
    String.raw`
it("Audit witness F08: a timed-out sample keeps running past a concurrency limit of one", async () => {
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  let active = 0
  let peak = 0
  try {
    const outcome = await runEnsemble(
      { n: 2, iterationConcurrency: 1, timeoutMs: 20, aggregation: { kind: "majority-vote-on-field" } },
      {
        async runSample({ index }) {
          active += 1
          peak = Math.max(peak, active)
          if (index === 0) await first
          active -= 1
          return { text: String(index) }
        },
      }
    )
    expect(outcome.samples.map(({ status }) => status)).toEqual(["failed", "completed"])
    expect(peak).toBe(2)
    expect(active).toBe(1)
  } finally {
    releaseFirst()
    await first
  }
})
`
  ),
  fixture(
    "panel-degradation",
    "packages/router-fusion/src/workflows/panel.test.ts",
    String.raw`
it("Audit witness F15: a degraded coding panel is reported as not degraded on compat", async () => {
  const { chatResponseOf } = await import("@cognia/router-fusion")
  const store = new MemoryArtifactStore()
  const healthy = healthyScript(await evidence(store))
  const h = harness((request) => request.logicalStepId === "panel:member:panel_b:1"
    ? { kind: "invalid_json" }
    : healthy(request), { store })
  const outcome = await runPanel(h.ports, input({ task: "code.debug", allowDegraded: true }))
  expect(outcome.degradedToSingle).toBe(true)
  expect(outcome.result).toMatchObject({ mode_executed: "direct", quality_status: "unknown" })
  expect(h.events.some(({ type }) => type === "run.degraded")).toBe(true)
  const response = chatResponseOf({
    runId: RUN, model: "cognia/panel", createdAtMs: 0, result: outcome.result,
    usage: { promptTokens: 0, completionTokens: 0 },
    billing: {
      budget_cap_microusd: 100_000, spent_microusd: 0, active_step_reservations_microusd: 0,
      tenant_hold_microusd: 0, status: "actual", overspend_microusd: 0, model_calls: 0,
    },
  })
  expect(response.routing).toMatchObject({ mode_executed: "direct", degraded: false })
})
`
  ),
  fixture(
    "workflow-council",
    "lib/workflow/nodes/ai/ai-council.test.ts",
    String.raw`
it("Audit witness F14: cancelling a Council workflow still starts the next member and synthesis", async () => {
  const controller = new AbortController()
  const { ctx } = makeCtx({ ...baseParams, executionMode: "serial" }, { signal: controller.signal })
  const starts: Array<{ alias: string; aborted: boolean }> = []
  const outcome = await executeAiCouncil(ctx, async () => ({
    async runPrompt({ modelAlias }) {
      starts.push({ alias: modelAlias, aborted: controller.signal.aborted })
      if (modelAlias === "fast") controller.abort()
      return { completion: "fixture answer" }
    },
  }))
  expect(starts).toEqual([
    { alias: "fast", aborted: false },
    { alias: "smart", aborted: true },
    { alias: "synth", aborted: true },
  ])
  expect(outcome.output).toMatchObject({ respondedCount: 2, markdown: "fixture answer" })
})
`
  ),
  fixture(
    "council",
    "lib/ai/council/run-council.test.ts",
    String.raw`
it("Audit witness F09: Council delivers unanimous confidence with zero replies", async () => {
  const runPrompt = jest.fn(async (input: { modelAlias: string }) => {
    if (input.modelAlias !== "synth") throw new Error("fixture: member unavailable")
    return { completion: "Unsupported synthesis\n\nConfidence: unanimous" }
  })
  const outcome = await runCouncil({
    prompt: "Compare two choices",
    councillors: [{ name: "a", modelAlias: "a" }, { name: "b", modelAlias: "b" }],
    synthesizerAlias: "synth",
  }, { runPrompt })
  expect(runPrompt).toHaveBeenCalledTimes(3)
  expect(outcome).toMatchObject({
    respondedCount: 0, totalCount: 2, confidence: "unanimous",
  })
  expect(outcome.markdown).toContain("Unsupported synthesis")
})
`
  ),
]

const config = path.join(directory, "jest.audit.config.mjs")
writeFileSync(
  config,
  String.raw`
import buildConfig from "../../jest.config.ts"
import { fileURLToPath } from "node:url"

export default async () => {
  const config = await buildConfig()
  const node = config.projects.find(({ displayName }) => (displayName.name ?? displayName) === "node")
  return {
    ...config,
    rootDir: process.cwd(),
    projects: [{
      ...node,
      rootDir: process.cwd(),
      roots: [fileURLToPath(new URL(".", import.meta.url))],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: node.modulePathIgnorePatterns.filter((pattern) => !pattern.includes(".cache")),
      testMatch: ["**/*.audit.ts"],
    }],
  }
}
`
)
const outcome = spawnSync(
  "pnpm",
  [
    "test",
    "--",
    "--config",
    config,
    "--runInBand",
    "--runTestsByPath",
    ...files,
    "-t",
    "Audit witness",
  ],
  { cwd: root, stdio: "inherit", timeout: 60_000 }
)
if (outcome.error) console.error(outcome.error.message)
process.exitCode = outcome.status ?? 1
