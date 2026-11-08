import type { BestOfNGroup } from "@/types/best-of-n"
import type { BestOfNInput } from "./core"
import type { SendOptions } from "@cognia/agent-config-types"

const prepareRun = jest.fn()
const store = { getRun: jest.fn(), updateRunIfCurrent: jest.fn() }
const dispatch = {
  setWorkspace: jest.fn(),
  attachControl: jest.fn(),
  run: jest.fn((op) => op()),
  capture: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn(),
  dispose: jest.fn(),
}
const begin = jest.fn<Promise<typeof dispatch>, unknown[]>(async () => dispatch)
const bundle = {
  bundleId: "bundle",
  state: "active",
  ownerRef: "session",
  leases: [
    { role: "primary", logicalRootId: "repo", workspaceId: "workspace", aliasPath: "/alias" },
  ],
}
const acquire = jest.fn<Promise<typeof bundle>, unknown[]>(async () => bundle)
const settle = jest.fn()
const options: SendOptions = Object.freeze({
  model: "chosen",
  maxBudgetUsd: 2,
  execution: { runtimeAdapter: "claude-agent-sdk" } as SendOptions["execution"],
})
const resolve = jest.fn<Promise<SendOptions>, unknown[]>(async () => options)
const capture = jest.fn()
const run = jest.fn()
const sessions = { get: jest.fn(), add: jest.fn() }
jest.mock("@/lib/squads/durable/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ prepareRun, store }),
}))
jest.mock("@/lib/squads/durable/durable-dispatch", () => ({
  beginDurableDispatch: (...args: unknown[]) => begin(...args),
}))
jest.mock("@/lib/squads/durable/durable-control", () => ({ controlDurableRun: jest.fn() }))
jest.mock("@/lib/task-workspace/client", () => ({
  acquireWorkspaceBundle: (...args: unknown[]) => acquire(...args),
  getWorkspaceBundle: async () => bundle,
  ensureWorkspacePortLease: async () => ({ canonicalRoot: "/physical" }),
}))
jest.mock("@/lib/task-workspace/run-lease", () => ({
  openWorkspaceBundleTurnLease: async () => ({ settle }),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: (_name: string, op: () => unknown) => op(),
}))
jest.mock("@/lib/scm/host", () => ({
  createScmHost: () => ({ captureChangeset: (...args: unknown[]) => capture(...args) }),
  scmErrorCode: (error: { code: string }) => error.code,
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions,
    transaction: (_mode: string, _table: unknown, op: () => unknown) => op(),
  }),
}))
jest.mock("@/lib/db/characters", () => ({ getCharacter: async () => ({ id: "agent" }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: async () => ({}) }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...args: unknown[]) => resolve(...args),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...args: unknown[]) => run(...args),
}))
jest.mock("@/lib/claude/ipc", () => ({ interruptSession: jest.fn() }))
const recordSurfaceUsage = jest.fn(async (..._args: unknown[]) => null as unknown)
jest.mock("@/lib/db/session-usage", () => ({
  ...jest.requireActual("@/lib/db/session-usage"),
  recordSurfaceUsage: (...args: unknown[]) => recordSurfaceUsage(...args),
}))
const external = jest.fn()
jest.mock("./external", () => ({
  runExternalCandidate: (...args: unknown[]) => external(...args),
}))
// The launcher as a passthrough: it runs the caller's engine and settles the
// way the real one does, a throw being a failed outcome.
interface LaunchInput {
  childId: string
  target: { engine: { run: (signal: AbortSignal) => Promise<unknown> } }
}
const launchChildRun = jest.fn(async (input: LaunchInput) => ({
  started: true as const,
  childId: input.childId,
  executionRunId: `execution:job:${input.childId}`,
  outcome: input.target.engine
    .run(new AbortController().signal)
    .catch((error: unknown) => ({ status: "failed", error: String(error) })),
}))
jest.mock("@/lib/execution/launch-child-run", () => ({
  launchChildRun: (...args: unknown[]) => launchChildRun(...(args as [LaunchInput])),
  childJobExecutionRunId: (id: string) => `execution:job:${id}`,
}))
const getExecutionRow = jest.fn(async (_id: string): Promise<unknown> => undefined)
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: (id: string) => getExecutionRow(id),
}))
const ensureGroupRow = jest.fn(async (..._args: unknown[]) => "execution:best-of-n:team")
const settleGroupRow = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/execution/best-of-n-bridge", () => ({
  bestOfNExecutionRunId: (id: string) => `execution:best-of-n:${id}`,
  ensureBestOfNExecutionRun: (...args: unknown[]) => ensureGroupRow(...args),
  settleBestOfNExecutionRun: (...args: unknown[]) => settleGroupRow(...args),
}))
const settleTeamRow = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  agentTeamExecutionRunId: (id: string) => `execution:team:${id}`,
  settleAgentTeamExecutionRun: (...args: unknown[]) => settleTeamRow(...args),
}))
import { bestOfNTeam, candidateRowTitle, createBestOfNExecution } from "./runtime"
import { BestOfNCandidateStoppedError, candidateGrant } from "./core"
import { interruptSession } from "@/lib/claude/ipc"
import {
  __resetClaimedTurnUsageForTesting,
  isTurnUsageClaimed,
} from "@/lib/usage/claimed-turn-usage"

const candidate = {
  candidateId: "candidate",
  index: 0,
  agent: { agentId: "agent", model: "chosen" },
  childSessionId: "session",
}
const group = {
  groupId: "group",
  teamRunId: "team",
  repositoryId: "repo",
  sourceRoot: "/source",
  baseSha: "frozen",
  targetRef: "refs/heads/result",
  n: 2,
  budgetPolicy: { maxCostUsd: 4, maxDurationMs: 10000 },
  createdAt: Date.now(),
  candidates: [candidate],
} as BestOfNGroup
const request = {
  prompt: "Fix this",
  projectId: "project",
  sessionId: "source-chat",
  requiredChecks: ["approved-test"],
} as BestOfNInput

beforeEach(() => {
  jest.clearAllMocks()
  resolve.mockResolvedValue(options)
  sessions.get.mockResolvedValue(undefined)
  capture.mockResolvedValue({
    changesetId: "change",
    headSha: "head",
    files: [{ path: "a.ts", excluded: false }],
  })
  run.mockResolvedValue({ text: "done", resultSubtype: "success" })
  recordSurfaceUsage.mockResolvedValue(null)
  __resetClaimedTurnUsageForTesting()
})

it("binds a valid durable team without a planning or cross-candidate evidence gate", async () => {
  const team = bestOfNTeam(group, request)
  expect(team.config.repositories).toEqual([
    { id: "repo", path: "/source", role: "primary", writable: true },
  ])
  expect(team.config.evidencePolicy).toMatchObject({
    requireCodeDiff: false,
    requireVerification: false,
  })
  expect(team.config.enableMessaging).toBe(false)
  await createBestOfNExecution().prepare(group, request)
  expect(prepareRun).toHaveBeenCalledWith(team, "team")
  // The group's own row first, so the team journal writes no `team` row.
  expect(ensureGroupRow).toHaveBeenCalledWith({
    groupId: "group",
    teamRunId: "team",
    prompt: "Fix this",
    sessionId: "source-chat",
    projectId: "project",
    at: expect.any(Number),
  })
  expect(ensureGroupRow.mock.invocationCallOrder[0]).toBeLessThan(
    prepareRun.mock.invocationCallOrder[0]!
  )
})

it("hands the group's stop to the candidate's checkout", async () => {
  const controller = new AbortController()
  await createBestOfNExecution().acquire(group, group.candidates[0], request, controller.signal)
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ ownerRef: "session" }), {
    signal: controller.signal,
  })
})

it("acquires the frozen base for the Host-assigned child, reusing its port block", async () => {
  const workspace = await createBestOfNExecution().acquire(group, group.candidates[0], request)
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      base: { kind: "gitRef", gitRef: "frozen" },
      ownerType: "session",
      ownerRef: "session",
    })
  )
  expect(workspace.physicalRoot).toBe("/physical")
})

async function execute(executionGroup = group, executionCandidate = group.candidates[0]) {
  return createBestOfNExecution().execute({
    group: executionGroup,
    candidate: executionCandidate,
    request,
    workspace: { bundleId: "bundle", workspaceId: "workspace", physicalRoot: "/physical" },
    grant: candidateGrant(executionGroup, executionCandidate),
    signal: new AbortController().signal,
  })
}

it("runs only the child through the resolver and ordinary capture gate, without editing options", async () => {
  expect(await execute()).toEqual({
    changesetId: "change",
    headSha: "head",
    hasChanges: true,
    costUsd: null,
  })
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      capabilityGrants: [expect.objectContaining({ model: "chosen", maxBudgetUsd: 2 })],
      session: expect.objectContaining({
        workingDir: "/physical",
        workspaceConfinementEnabled: true,
      }),
      activeProject: expect.objectContaining({
        roots: [{ id: "repo", path: "/physical", isPrimary: true }],
      }),
    })
  )
  // The resolved options reach the capture unedited; only this turn's id is added.
  expect(run).toHaveBeenCalledWith(
    "session",
    "Fix this",
    { ...options, turnId: expect.any(String) },
    expect.any(Object)
  )
  expect(options).not.toHaveProperty("turnId")
  expect(run).toHaveBeenCalledTimes(1)
  expect(begin).toHaveBeenCalledWith(expect.objectContaining({ isolateFailure: true }))
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({ requiredChecks: ["approved-test"], targetRef: "refs/heads/result" })
  )
  expect(settle).toHaveBeenCalledWith("ready")
})

describe("candidates as child runs", () => {
  it("runs each candidate as a child of the group's run, in its own conversation", async () => {
    const signal = new AbortController().signal
    await createBestOfNExecution().execute({
      group,
      candidate: group.candidates[0],
      request,
      workspace: { bundleId: "bundle", workspaceId: "workspace", physicalRoot: "/physical" },
      grant: candidateGrant(group, group.candidates[0]),
      signal,
    })
    expect(launchChildRun).toHaveBeenCalledTimes(1)
    const [input] = launchChildRun.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(input).toMatchObject({
      parentRunId: "execution:best-of-n:team",
      sessionId: "session",
      childId: "candidate",
      title: "Best-of-N 1/2 · agent (chosen)",
      surface: "agent-team",
      signal,
      target: { kind: "agent", label: "agent" },
    })
    // The grant reaches the resolver; the caller's engine applies none.
    expect(input).not.toHaveProperty("grants")
    expect(input.title).not.toContain("Fix this")
  })

  it("admits the attempt's turn under the candidate's own row, so the live leg stands in for it", async () => {
    await execute()
    const [, , , capture] = run.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ]
    expect(capture.execution).toEqual({
      kind: "team",
      label: "Best-of-N 1/2 · agent (chosen)",
      runId: "execution:job:candidate",
      taskId: "candidate",
    })
  })

  it("starts no attempt when the child run is refused, and fails the dispatch", async () => {
    launchChildRun.mockResolvedValueOnce({
      started: false,
      reason: "parent_not_found",
      detail: "execution:team:team",
    } as never)
    await expect(execute()).rejects.toThrow("parent_not_found")
    expect(dispatch.run).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(dispatch.fail).toHaveBeenCalled()
    expect(dispatch.dispose).toHaveBeenCalled()
  })

  it("reports a stop that came before the child run started as the stop", async () => {
    launchChildRun.mockResolvedValueOnce({ started: false, reason: "cancelled" } as never)
    await expect(execute()).rejects.toThrow("cancelled before it started")
    expect(dispatch.run).not.toHaveBeenCalled()
  })

  it("stops only this attempt when its own row is stopped, interrupting its session", async () => {
    const rowStop = new AbortController()
    launchChildRun.mockImplementationOnce(async (input: LaunchInput) => ({
      started: true as const,
      childId: input.childId,
      executionRunId: `execution:job:${input.childId}`,
      outcome: input.target.engine
        .run(rowStop.signal)
        .catch((error: unknown) => ({ status: "cancelled", error: String(error) })),
    }))
    run.mockImplementationOnce(
      (_session: string, _prompt: string, _options: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          queueMicrotask(() => rowStop.abort(new Error("stopped from the run monitor")))
        })
    )
    const error = await execute().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BestOfNCandidateStoppedError)
    expect(interruptSession).toHaveBeenCalledWith("session")
    expect(dispatch.fail).toHaveBeenCalled()
  })

  it("rethrows the attempt's own error after the child run settles", async () => {
    run.mockResolvedValueOnce({ text: "", resultSubtype: "error_max_turns" })
    const failure = execute()
    await expect(failure).rejects.toThrow("Candidate execution ended: error_max_turns")
    expect(launchChildRun).toHaveBeenCalledTimes(1)
  })
})

describe("finish", () => {
  const record = { id: "team", status: "running", updatedAt: 1 }
  it.each([
    ["awaitingSelection", "completed", "completed"],
    ["cancelled", "cancelled", "cancelled"],
    ["recoveryRequired", "needs_input", "recovery_required"],
  ] as const)(
    "settles the group's row as well as its durable record (%s)",
    async (phase, durable, row) => {
      store.getRun.mockResolvedValue(record)
      await createBestOfNExecution().finish({ ...group, phase })
      expect(store.updateRunIfCurrent).toHaveBeenCalledWith(
        "team",
        record,
        expect.objectContaining({ status: durable })
      )
      expect(settleGroupRow).toHaveBeenCalledWith("team", row, expect.any(Number))
      expect(settleTeamRow).not.toHaveBeenCalled()
    }
  )

  it("settles the team row a group started before it had a row of its own, and never creates one", async () => {
    store.getRun.mockResolvedValue(record)
    settleGroupRow.mockResolvedValue(false)
    getExecutionRow.mockResolvedValueOnce({ id: "execution:team:team" })
    await createBestOfNExecution().finish({ ...group, phase: "cancelled" })
    expect(getExecutionRow).toHaveBeenCalledWith("execution:team:team")
    expect(settleTeamRow).toHaveBeenCalledWith(record, "cancelled", expect.any(Number))
    settleTeamRow.mockClear()
    getExecutionRow.mockResolvedValueOnce(undefined)
    await createBestOfNExecution().finish({ ...group, phase: "cancelled" })
    expect(settleTeamRow).not.toHaveBeenCalled()
    settleGroupRow.mockResolvedValue(true)
  })

  it("settles nothing for a group whose durable run is gone", async () => {
    store.getRun.mockResolvedValue(undefined)
    await createBestOfNExecution().finish({ ...group, phase: "awaitingSelection" })
    expect(settleGroupRow).not.toHaveBeenCalled()
    expect(settleTeamRow).not.toHaveBeenCalled()
  })

  it("never fails the group because its row could not be settled", async () => {
    store.getRun.mockResolvedValue(record)
    settleGroupRow.mockRejectedValueOnce(new Error("journal down"))
    await expect(
      createBestOfNExecution().finish({ ...group, phase: "awaitingSelection" })
    ).resolves.toBeUndefined()
  })
})

it("records a no-change success without inventing a cost", async () => {
  capture.mockRejectedValue({ code: "nothing_to_capture" })
  expect(await execute()).toEqual({ hasChanges: false, costUsd: null })
  expect(dispatch.complete).toHaveBeenCalledWith({ text: "done" })
})

it("does not turn provider budget or turn-limit failures into publishable success", async () => {
  run.mockResolvedValue({ text: "incomplete", resultSubtype: "error_max_budget_usd" })
  await expect(execute()).rejects.toThrow("error_max_budget_usd")
  expect(capture).not.toHaveBeenCalled()
  expect(dispatch.fail).toHaveBeenCalled()
})

it.each(["ai-sdk", undefined])(
  "rejects a monetary cap when the resolved runtime is %s before sending",
  async (runtimeAdapter) => {
    resolve.mockResolvedValue({
      ...options,
      execution: runtimeAdapter ? ({ runtimeAdapter } as SendOptions["execution"]) : undefined,
    })
    await expect(execute()).rejects.toThrow("cannot enforce the best-of-N cost budget")
    expect(run).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  }
)

it.each([undefined, 3, Number.POSITIVE_INFINITY])(
  "rejects an absent or widened resolved per-candidate cap %s",
  async (maxBudgetUsd) => {
    resolve.mockResolvedValue({ ...options, maxBudgetUsd })
    await expect(execute()).rejects.toThrow("cannot enforce the best-of-N cost budget")
    expect(run).not.toHaveBeenCalled()
  }
)

it("keeps an AI-SDK zero wire cost unknown for duration-only attempts", async () => {
  resolve.mockResolvedValue({
    ...options,
    execution: { runtimeAdapter: "ai-sdk" } as SendOptions["execution"],
  })
  run.mockResolvedValue({ text: "done", usage: { totalCostUsd: 0 } })
  const result = await execute({ ...group, budgetPolicy: { maxDurationMs: 10_000 } })
  expect(result.costUsd).toBeNull()
  expect(dispatch.complete).toHaveBeenCalledWith(
    expect.not.objectContaining({ costUsd: expect.anything() })
  )
})

it("preserves a reported zero from the Claude SDK cost authority", async () => {
  run.mockResolvedValue({ text: "done", usage: { totalCostUsd: 0 } })
  expect((await execute()).costUsd).toBe(0)
})

const codex = {
  ...candidate,
  agent: { agentId: "agent", provider: "cognia:external-agent:codex-1", model: "gpt-5" },
} as BestOfNGroup["candidates"][number]
const durationOnly = { ...group, budgetPolicy: { maxDurationMs: 10_000 } } as BestOfNGroup

it("runs an external candidate in its own workspace root and keeps its cost unknown", async () => {
  external.mockResolvedValue({ text: "external done" })
  expect(await execute(durationOnly, codex)).toEqual({
    changesetId: "change",
    headSha: "head",
    hasChanges: true,
    costUsd: null,
  })
  expect(resolve).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(external).toHaveBeenCalledWith(
    expect.objectContaining({
      configId: "codex-1",
      model: "gpt-5",
      prompt: "Fix this",
      workingDirectory: "/physical",
      onCapture: dispatch.capture,
    })
  )
  expect(sessions.add).toHaveBeenCalledWith(
    expect.objectContaining({
      providerOverride: "cognia:external-agent:codex-1",
      model: "gpt-5",
      programmaticCreator: "best-of-n",
    })
  )
  expect(dispatch.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "external done" }))
  expect(dispatch.complete).toHaveBeenCalledWith(
    expect.not.objectContaining({ costUsd: expect.anything() })
  )
})

it("refuses a dollar cap for an external candidate before it starts", async () => {
  await expect(execute(group, codex)).rejects.toThrow("cannot enforce the best-of-N cost budget")
  expect(external).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
})

it("routes a Cognia agent whose resolved runtime is external through the same lane", async () => {
  resolve.mockResolvedValue({ ...options, provider: "cognia:external-agent:claude-1", model: "m" })
  external.mockResolvedValue({ text: "ok" })
  await execute(durationOnly)
  expect(external).toHaveBeenCalledWith(
    expect.objectContaining({ configId: "claude-1", model: "m" })
  )
  expect(run).not.toHaveBeenCalled()
})

it("refuses the legacy unscoped external marker instead of guessing an agent", async () => {
  await expect(
    execute(durationOnly, {
      ...codex,
      agent: { agentId: "agent", provider: "cognia:external-agent" },
    })
  ).rejects.toThrow("unscoped external agent")
  expect(external).not.toHaveBeenCalled()
})

describe("usage ledger booking", () => {
  const usage = {
    inputTokens: 200,
    outputTokens: 80,
    cacheReadInputTokens: 1_000,
    cacheCreationInputTokens: 30,
    totalCostUsd: 0.05,
    durationMs: 4_000,
  }

  it("books a Cognia candidate once, under its child session, team run and provider", async () => {
    resolve.mockResolvedValue({ ...options, provider: "anthropic" })
    run.mockResolvedValue({ text: "done", resultSubtype: "success", usage })
    await execute()
    const [, , sent] = run.mock.calls[0] as [string, string, SendOptions]
    // The chat runtime that also ingests the child's stream leaves this turn alone.
    expect(isTurnUsageClaimed("session", sent.turnId)).toBe(true)
    expect(recordSurfaceUsage).toHaveBeenCalledTimes(1)
    expect(recordSurfaceUsage).toHaveBeenCalledWith({
      surface: "agent-team",
      operationId: "best-of-n:group:candidate",
      sessionId: "session",
      usage: expect.objectContaining({
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 30,
        costUsd: 0.05,
        durationMs: 4_000,
        model: "chosen",
        providerId: "anthropic",
        runId: "team",
        projectId: "project",
        turnId: sent.turnId,
      }),
    })
  })

  it("books what a failed attempt streamed before it ended", async () => {
    run.mockImplementation(async (...args: unknown[]) => {
      const cap = args[3] as { onEvent: (event: unknown) => void }
      cap.onEvent({ type: "usage", usage: { inputTokens: 40, outputTokens: 2 } })
      throw new Error("sidecar exited")
    })
    await expect(execute()).rejects.toThrow("sidecar exited")
    expect(recordSurfaceUsage.mock.calls[0][0]).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 2, runId: "team" },
    })
    // The capture stream still reaches the durable child.
    expect(dispatch.capture).toHaveBeenCalledWith(expect.objectContaining({ type: "usage" }))
  })

  it("treats a Claude SDK zero as a real figure and leaves an AI-SDK zero to be priced", async () => {
    run.mockResolvedValue({ text: "done", usage: { inputTokens: 5, totalCostUsd: 0 } })
    await execute()
    expect(recordSurfaceUsage.mock.calls[0][0]).toMatchObject({
      usage: { costUsd: 0, costSource: "sdk", costKnown: true },
    })
    resolve.mockResolvedValue({
      ...options,
      execution: { runtimeAdapter: "ai-sdk" } as SendOptions["execution"],
    })
    await execute({ ...group, budgetPolicy: { maxDurationMs: 10_000 } })
    const priced = (recordSurfaceUsage.mock.calls[1][0] as { usage: Record<string, unknown> }).usage
    expect(priced).not.toHaveProperty("costSource")
  })

  it("books nothing when the attempt reported no usage", async () => {
    await execute()
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })

  it("never fails a candidate because the booking could not be written", async () => {
    run.mockResolvedValue({ text: "done", resultSubtype: "success", usage })
    recordSurfaceUsage.mockRejectedValue(new Error("db closed"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(execute()).resolves.toMatchObject({ hasChanges: true })
    } finally {
      warn.mockRestore()
    }
  })

  it("books an external candidate's own report without a provider bucket", async () => {
    external.mockImplementation(async (input: { onUsage: (usage: unknown) => void }) => {
      input.onUsage({ promptTokens: 300, completionTokens: 90, totalTokens: 390 })
      return { text: "external done" }
    })
    await execute(durationOnly, codex)
    const booked = recordSurfaceUsage.mock.calls[0][0] as {
      operationId: string
      sessionId: string
      usage: Record<string, unknown>
    }
    expect(booked).toMatchObject({
      surface: "agent-team",
      operationId: "best-of-n:group:candidate",
      sessionId: "session",
      usage: {
        inputTokens: 300,
        outputTokens: 90,
        model: "gpt-5",
        runId: "team",
        costSource: "unknown",
        costKnown: false,
        usageBasis: "provider-reported",
      },
    })
    expect(booked.usage).not.toHaveProperty("providerId")
  })

  it("books an external candidate's report even when the run failed", async () => {
    external.mockImplementation(async (input: { onUsage: (usage: unknown) => void }) => {
      input.onUsage({
        promptTokens: 10,
        completionTokens: 1,
        totalTokens: 11,
        providerCost: { amount: 0.02, currency: "USD" },
      })
      throw new Error("External agent codex-1 returned a failure")
    })
    await expect(execute(durationOnly, codex)).rejects.toThrow("returned a failure")
    expect(recordSurfaceUsage.mock.calls[0][0]).toMatchObject({
      usage: { costUsd: 0.02, costSource: "sdk", costKnown: true },
    })
  })
})

describe("candidateRowTitle", () => {
  it("names the attempt, the group size and who made it", () => {
    const agent = { agentId: "agent-7", model: null }
    expect(candidateRowTitle({ n: 3 }, { index: 1, agent }, "Reviewer")).toBe(
      "Best-of-N 2/3 · Reviewer"
    )
    expect(candidateRowTitle({ n: 3 }, { index: 0, agent }, " ")).toBe("Best-of-N 1/3 · agent-7")
    expect(
      candidateRowTitle({ n: 2 }, { index: 0, agent: { agentId: "a", model: "m" } }, undefined)
    ).toBe("Best-of-N 1/2 · a (m)")
  })
})
