/** @jest-environment jsdom */
/**
 * Delegation orchestrator tests.
 *
 * The orchestrator keeps a Squad's delegation policy (quiet hours, approval,
 * depth, cycles), the record and the hooks; every target runs through
 * `launchChildRun`. The launcher is replaced by a controllable fake here (its
 * engines are covered by `lib/execution/launch-child-run.test.ts`), so these
 * tests assert what the orchestrator asks it for and how it settles the record
 * from what comes back.
 */

import "fake-indexeddb/auto"
import { preparePersonalDerivedHistory } from "@/lib/execution/personal-visibility"
jest.mock("@/lib/execution/personal-visibility", () => ({
  preparePersonalDerivedHistory: jest.fn(async (_sessionId: unknown, messages: unknown[]) => ({
    messages,
    withheldMessageIds: [],
    visibilityDigest: "delegation-test",
    readers: [],
  })),
}))

const dispatchOnTeamDelegationStart = jest.fn()
const dispatchOnTeamDelegationComplete = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnTeamDelegationStart,
    dispatchOnTeamDelegationComplete,
  })),
}))

// `undefined` defers to the real PII check; a test forces a verdict.
const mockLeakCheck = jest.fn<boolean | undefined, [string]>(() => undefined)
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    hasNoLeakingPii: (text: string) => mockLeakCheck(text) ?? actual.hasNoLeakingPii(text),
  }
})

jest.mock("@/lib/notifications/policy/quiet-hours", () => ({
  isInQuietRange: jest.fn(() => false),
}))
import { isInQuietRange } from "@/lib/notifications/policy/quiet-hours"
const isInQuietHoursMock = isInQuietRange as unknown as jest.Mock

// Rows that exist in the ledger (the run tree walks their `parentRunId`), the
// live Squad run of each team, and the Squad each `team` row runs.
interface FakeRow {
  id: string
  kind: string
  sourceId: string
  parentRunId?: string
}
const rows = new Map<string, FakeRow>()
function addRow(id: string, patch: Partial<FakeRow> = {}): void {
  rows.set(id, { id, kind: "workflow", sourceId: id, ...patch })
}
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: async (id: string) => rows.get(id),
  listChildExecutionRuns: async (parentRunId: string) =>
    [...rows.values()].filter((row) => row.parentRunId === parentRunId),
}))
const liveRuns: Record<string, string> = {}
const squadOfRun: Record<string, string> = {}
jest.mock("./squad/squad-run-records", () => ({
  findLiveSquadRun: async (teamId: string) =>
    liveRuns[teamId] ? { id: liveRuns[teamId] } : undefined,
  squadIdForTeamRun: async (run: { sourceId: string }) => squadOfRun[run.sourceId],
}))

interface FakeChild {
  input: LaunchChildRunInput
  executionRunId: string
  settle: (outcome: ChildRunOutcome) => void
}
const children: FakeChild[] = []
/** Settles every child at once unless a test takes over (`null`). */
let autoOutcome: ChildRunOutcome | null
let launchRefusal: { reason: string; detail?: string } | undefined
/** Holds the launch open until released, to cancel while it is in flight. */
let launchGate: Promise<void> | undefined
const launchMock = jest.fn(async (input: LaunchChildRunInput) => {
  if (launchGate) await launchGate
  if (input.signal?.aborted) return { started: false, reason: "cancelled" }
  if (launchRefusal) return { started: false, ...launchRefusal }
  let settle!: (outcome: ChildRunOutcome) => void
  const outcome = new Promise<ChildRunOutcome>((resolve) => (settle = resolve))
  const childId = input.childId ?? `child-${children.length + 1}`
  const executionRunId =
    input.target.kind === "squad" ? `execution:team:run_${childId}` : `execution:job:${childId}`
  input.signal?.addEventListener("abort", () =>
    settle({ status: "cancelled", error: "Cancelled." })
  )
  children.push({ input, executionRunId, settle })
  if (autoOutcome) settle(autoOutcome)
  return { started: true, childId, executionRunId, outcome }
})
jest.mock("@/lib/execution/launch-child-run", () => ({
  launchChildRun: (input: LaunchChildRunInput) => launchMock(input),
}))
// The one tree stop: it stops a launched fake child as its kind's handler
// would (its outcome settles `cancelled`), unless a test says it missed.
let treeStopMisses = false
const stopRunTreeMock = jest.fn(async (runId: string) => {
  const child = children.find((c) => c.executionRunId === runId)
  if (treeStopMisses || !child) return { stopped: false, descendantsStopped: 0 }
  child.settle({ status: "cancelled", error: "Cancelled." })
  return { stopped: true, descendantsStopped: 0 }
})
jest.mock("@/lib/execution/run-control", () => ({
  stopRunTree: (runId: string) => stopRunTreeMock(runId),
}))

import type { LaunchChildRunInput } from "@/lib/execution/launch-child-run"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import {
  __resetPendingDelegationRunsForTesting,
  approveDelegation,
  DELEGATION_RUN_LOST,
  DELEGATION_TAKEN_ELSEWHERE,
  cancelDelegation,
  delegateToBackground,
  delegateToExternal,
  delegateToTeam,
  delegateToTwin,
  restoreParkedDelegations,
  wouldCreateTeamCycle,
} from "./delegation-orchestrator"
import { DELEGATION_RUN_WITHHELD } from "./parked-delegations"
import { getDb } from "@/lib/db/schema"
import {
  claimParkedDelegation,
  listParkedDelegations,
  putParkedDelegation,
  type SquadParkedDelegationRow,
} from "@/lib/db/squad-parked-delegations"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type { AgentTeam } from "@/types/agent/agent-team"

/** Flush pending microtasks + a macrotask so async launches settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Whether `promise` is still unsettled once pending work has run. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await flush()
  await flush()
  return !settled
}

const lastLaunch = () => children[children.length - 1]

/** The parked row kept for `id`, read as a restart would. */
async function parkedRow(id: string): Promise<SquadParkedDelegationRow | undefined> {
  return (await listParkedDelegations(getDb())).find((row) => row.id === id)
}

/** Wait until `read` reports what `done` expects; parked writes land asynchronously. */
async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await flush()
  }
  throw new Error("condition never held")
}

/** What a restart leaves behind: no records in the store, no params in memory, the database. */
function simulateRestart(): void {
  useAgentTeamStore.setState({ delegations: {} })
  __resetPendingDelegationRunsForTesting()
}

// Parked rows outlive a test in the shared database; start each one clean.
beforeEach(async () => {
  await flush()
  await getDb().squadParkedDelegations.clear()
  mockLeakCheck.mockReset().mockReturnValue(undefined)
})

function resetLauncher() {
  launchMock.mockClear()
  children.length = 0
  autoOutcome = { status: "completed", text: "ok" }
  launchRefusal = undefined
  launchGate = undefined
  rows.clear()
  stopRunTreeMock.mockClear()
  treeStopMisses = false
  for (const key of Object.keys(liveRuns)) delete liveRuns[key]
  for (const key of Object.keys(squadOfRun)) delete squadOfRun[key]
}

/**
 * A live Squad run of `teamId` whose `execution:team:` row exists, hanging
 * under `parentRunId` when given (a Squad another one launched).
 */
function liveRun(teamId: string, parentRunId?: string, runId = `run_team_${teamId}`): string {
  liveRuns[teamId] = runId
  squadOfRun[runId] = teamId
  addRow(`execution:team:${runId}`, {
    kind: "team",
    sourceId: runId,
    ...(parentRunId ? { parentRunId } : {}),
  })
  return `execution:team:${runId}`
}

const quietPolicy = {
  approval: { requirePlanApproval: false, requireDelegationApproval: false },
  budget: {
    tokenBudget: 0,
    warningThreshold: 0.8,
    criticalThreshold: 0.95,
    onCritical: "notify" as const,
  },
  escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
  delivery: { quietHours: { from: "00:00", to: "23:59", tz: "UTC" } },
}

function seedTeamWithQuietHours(): string {
  const team = useAgentTeamStore.getState().createTeam({ name: "Quiet", task: "t" })
  useAgentTeamStore.setState((s) => {
    const existing = s.teams[team.id]
    const updated: AgentTeam = {
      ...existing,
      config: { ...existing.config, governancePolicy: quietPolicy },
    }
    return { teams: { ...s.teams, [team.id]: updated } }
  })
  return team.id
}

describe("delegation-orchestrator", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    __resetPendingDelegationRunsForTesting()
    dispatchOnTeamDelegationStart.mockReset()
    dispatchOnTeamDelegationComplete.mockReset()
    isInQuietHoursMock.mockReturnValue(false)
    jest.mocked(preparePersonalDerivedHistory).mockClear()
    resetLauncher()
  })

  describe("delegateToBackground", () => {
    it("retains the Host reader across approval and ignores forged record metadata", async () => {
      const { delegation } = delegateToBackground(
        {
          sourceTeamId: "team-1",
          sourceTaskId: "task-1",
          prompt: "private prompt",
          systemPrompt: "private system",
          reason: "test",
          awaitingApproval: true,
          metadata: { personalExecutionRunId: "forged-run" },
        },
        { executionRunId: "host-root" }
      )
      const placeholder = "[Withheld: personal content of Host owner]"
      jest
        .mocked(preparePersonalDerivedHistory<{ id: string; content: string }>)
        .mockResolvedValueOnce({
          messages: [{ id: `delegation-prompt:${delegation.id}`, content: placeholder }],
          withheldMessageIds: [delegation.id],
          visibilityDigest: "withheld",
          readers: [],
        })
      approveDelegation(delegation.id)
      // The approval takes the parked row off disk before it launches.
      await eventually(
        () => launchMock.mock.calls.length,
        (count) => count === 1
      )
      expect(preparePersonalDerivedHistory).toHaveBeenLastCalledWith(
        undefined,
        [expect.objectContaining({ content: expect.stringContaining("private prompt") })],
        { runIds: ["host-root"], executionRunId: "host-root" }
      )
      expect(lastLaunch().input.target).toMatchObject({ kind: "agent", prompt: placeholder })
      expect(lastLaunch().input.target).not.toHaveProperty("systemPrompt")
    })

    it("creates an active delegation and fires onTeamDelegationStart", async () => {
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "Investigate",
        reason: "Investigate offline",
      })
      expect(delegation.status).toBe("active")
      expect(delegation.targetType).toBe("background")
      expect(delegation.targetId).toMatch(/^bg_/)
      expect(useAgentTeamStore.getState().delegations[delegation.id]).toBeDefined()
      expect(dispatchOnTeamDelegationStart).toHaveBeenCalledWith(
        expect.objectContaining({
          delegationId: delegation.id,
          sourceTeamId: "team-1",
          sourceTaskId: "task-1",
          targetType: "background",
        })
      )
      await completionPromise
    })

    it("launches an agent child of the source team's live run and settles from its outcome", async () => {
      const parent = liveRun("team-1")
      autoOutcome = { status: "completed", text: "background result" }
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "Investigate",
        systemPrompt: "be careful",
        reason: "offline",
      })
      const settled = await completionPromise
      expect(lastLaunch().input).toEqual({
        parentRunId: parent,
        target: {
          kind: "agent",
          prompt: "Investigate",
          systemPrompt: "be careful",
          background: { label: `team-delegation:${delegation.id}`, kind: "team-delegation" },
        },
        title: `team-delegation:${delegation.id}`,
        // The record's target is the Job Center entry and the child row.
        childId: delegation.targetId,
        surface: "agent-team",
        signal: expect.any(AbortSignal),
      })
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("background result")
      expect(settled.metadata?.executionRunId).toBe(`execution:job:${delegation.targetId}`)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "completed",
      })
    })

    it("launches unparented when the source team has no live run", async () => {
      await delegateToBackground({
        sourceTeamId: "team-idle",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      }).completionPromise
      expect(lastLaunch().input.parentRunId).toBeUndefined()
    })

    it("hangs the child under the run that asked when it exists, else the live run", async () => {
      const live = liveRun("team-1")
      addRow("execution:workflow:wf-1")
      await delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
        parentRunId: "execution:workflow:wf-1",
      }).completionPromise
      expect(lastLaunch().input.parentRunId).toBe("execution:workflow:wf-1")

      await delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
        parentRunId: "execution:workflow:not-projected-yet",
      }).completionPromise
      expect(lastLaunch().input.parentRunId).toBe(live)
    })

    it("settles to failed with the child's error", async () => {
      autoOutcome = { status: "failed", error: "boom" }
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      const settled = await completionPromise
      expect(settled.status).toBe("failed")
      expect(settled.result).toBe("boom")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "failed",
      })
    })

    it("fails a delegation the launcher refuses, saying why", async () => {
      launchRefusal = { reason: "journal_failed", detail: "disk full" }
      const settled = await delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      }).completionPromise
      expect(settled.status).toBe("failed")
      expect(settled.result).toBe("background delegation refused: journal_failed (disk full)")
    })

    it("respects awaitingApproval and is not complete while it waits for one (F03)", async () => {
      // A workflow step with awaitCompletion used to continue on the parked
      // record, before anything ran.
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "needs review",
        awaitingApproval: true,
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(await isPending(completionPromise)).toBe(true)
      expect(launchMock).not.toHaveBeenCalled()
      approveDelegation(delegation.id)
      await expect(completionPromise).resolves.toMatchObject({
        id: delegation.id,
        status: "completed",
      })
      expect(launchMock).toHaveBeenCalledTimes(1)
    })

    it("completes a parked delegation as cancelled when it is cancelled or removed", async () => {
      const first = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "needs review",
        awaitingApproval: true,
      })
      cancelDelegation(first.delegation.id)
      await expect(first.completionPromise).resolves.toMatchObject({ status: "cancelled" })

      const second = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "needs review",
        awaitingApproval: true,
      })
      useAgentTeamStore.getState().reset()
      await expect(second.completionPromise).resolves.toMatchObject({
        id: second.delegation.id,
        status: "cancelled",
      })
      expect(launchMock).not.toHaveBeenCalled()
    })
  })

  describe("delegateToTwin", () => {
    it("launches a twin child registered in the Job Center and settles with its answer", async () => {
      autoOutcome = { status: "completed", text: "twin answer" }
      const { delegation, completionPromise } = delegateToTwin({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        twinId: "tw1",
        prompt: "analyze the incident",
        systemPrompt: "BASE",
        reason: "ask the domain expert",
      })
      expect(delegation.targetType).toBe("twin")
      expect(delegation.targetId).toMatch(/^bg_/)
      expect((delegation.metadata as { twinId?: string } | undefined)?.twinId).toBe("tw1")
      expect(dispatchOnTeamDelegationStart).toHaveBeenCalledWith(
        expect.objectContaining({ delegationId: delegation.id, targetType: "twin" })
      )
      const settled = await completionPromise
      expect(lastLaunch().input).toMatchObject({
        target: {
          kind: "twin",
          twinId: "tw1",
          question: "analyze the incident",
          systemPrompt: "BASE",
          background: { label: `team-delegation:${delegation.id}`, kind: "team-delegation" },
        },
        childId: delegation.targetId,
      })
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("twin answer")
    })

    it("defers to awaiting_approval and launches on approval", async () => {
      const { delegation, completionPromise } = delegateToTwin({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        twinId: "tw1",
        prompt: "p",
        reason: "needs review",
        awaitingApproval: true,
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(await isPending(completionPromise)).toBe(true)
      expect(launchMock).not.toHaveBeenCalled()
      approveDelegation(delegation.id)
      await expect(completionPromise).resolves.toMatchObject({ status: "completed" })
      expect(lastLaunch().input.target).toMatchObject({ kind: "twin", twinId: "tw1" })
    })
  })

  describe("delegateToExternal", () => {
    it("launches an external child in the team's working directory and settles completed", async () => {
      const team = useAgentTeamStore.getState().createTeam({ name: "Ext", task: "t" })
      useAgentTeamStore.setState((s) => ({
        teams: {
          ...s.teams,
          [team.id]: {
            ...s.teams[team.id],
            config: { ...s.teams[team.id].config, workingDir: "/repo" },
          },
        },
      }))
      autoOutcome = { status: "completed", text: "external result" }
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: team.id,
        sourceTaskId: "task-1",
        targetAgentId: "claude-code",
        prompt: "do the thing",
        reason: "use external",
        timeoutMs: 1_000,
      })
      expect(delegation.status).toBe("active")
      expect(delegation.targetType).toBe("sub_agent")
      expect(delegation.targetId).toBe("claude-code")
      const settled = await completionPromise
      const { input } = lastLaunch()
      expect(input.target).toEqual({
        kind: "external",
        agentId: "claude-code",
        prompt: "do the thing",
        workingDirectory: "/repo",
        timeoutMs: 1_000,
      })
      // Not a Job Center entry; the launcher mints the child id.
      expect(input.childId).toBeUndefined()
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("external result")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "completed",
      })
    })

    it("settles to failed with the agent's error", async () => {
      autoOutcome = { status: "failed", error: "agent exploded" }
      const settled = await delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "x",
        reason: "y",
      }).completionPromise
      expect(settled.status).toBe("failed")
      expect(settled.result).toBe("agent exploded")
    })

    it("settles to timeout when the child's deadline ended it", async () => {
      autoOutcome = { status: "failed", error: "external agent timed out", timedOut: true }
      const settled = await delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "x",
        reason: "y",
        timeoutMs: 5,
      }).completionPromise
      expect(settled.status).toBe("timeout")
    })
  })

  describe("approveDelegation", () => {
    it("flips awaiting_approval to active AND launches the background run", async () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "investigate later",
        reason: "y",
        awaitingApproval: true,
      })
      expect(launchMock).not.toHaveBeenCalled()
      const after = approveDelegation(delegation.id)
      expect(after?.status).toBe("active")
      await eventually(
        () => useAgentTeamStore.getState().delegations[delegation.id].status,
        (status) => status === "completed"
      )
      expect(lastLaunch().input.target).toMatchObject({
        kind: "agent",
        prompt: "investigate later",
      })
    })

    it("launches a deferred external run on approval", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation } = delegateToExternal({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        targetAgentId: "claude-code",
        prompt: "handoff payload",
        reason: "handoff",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(launchMock).not.toHaveBeenCalled()
      approveDelegation(delegation.id)
      await flush()
      expect(lastLaunch().input.target).toMatchObject({
        kind: "external",
        agentId: "claude-code",
        prompt: "handoff payload",
      })
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
    })

    it("fails an approval this process holds no run for, instead of reading active (F03)", async () => {
      // Another window's delegation, or one whose params were dropped: an
      // approval used to flip it to active with nothing running.
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
        awaitingApproval: true,
      })
      __resetPendingDelegationRunsForTesting()
      const after = approveDelegation(delegation.id)
      expect(after).toMatchObject({ status: "failed", result: DELEGATION_RUN_LOST })
      await expect(completionPromise).resolves.toMatchObject({ status: "failed" })
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "failed",
      })
      expect(launchMock).not.toHaveBeenCalled()
    })

    it("no-ops on non-awaiting delegations", async () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
        awaitingApproval: true,
      })
      autoOutcome = null
      // Approve once (→ active), then approving again is a no-op.
      approveDelegation(delegation.id)
      const after = approveDelegation(delegation.id)
      expect(after?.status).toBe("active")
      await flush()
      expect(launchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("cancelDelegation", () => {
    it("stops the running child's tree, flips the record to cancelled and fires one hook", async () => {
      autoOutcome = null
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      await flush()
      const { input, executionRunId } = lastLaunch()

      const after = cancelDelegation(delegation.id)

      expect(after?.status).toBe("cancelled")
      expect((await completionPromise).status).toBe("cancelled")
      // The one stop, on the child's run; the launch signal is not used.
      expect(stopRunTreeMock).toHaveBeenCalledWith(executionRunId)
      expect(input.signal?.aborted).toBe(false)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "cancelled",
      })
    })

    it("falls back to the launch signal when the tree stop cannot reach the child", async () => {
      autoOutcome = null
      treeStopMisses = true
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      await flush()
      cancelDelegation(delegation.id)
      expect((await completionPromise).status).toBe("cancelled")
      expect(lastLaunch().input.signal?.aborted).toBe(true)
    })

    it("stops a child still being launched, and it never runs", async () => {
      let release!: () => void
      launchGate = new Promise<void>((resolve) => (release = resolve))
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "p",
        reason: "y",
      })
      await flush()
      cancelDelegation(delegation.id)
      release()

      const settled = await completionPromise
      expect(settled.status).toBe("cancelled")
      expect(children).toHaveLength(0)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
    })

    it("keeps a cancelled delegation cancelled when a late result arrives", async () => {
      autoOutcome = null
      launchMock.mockImplementationOnce(async (input: LaunchChildRunInput) => {
        // An engine that finished before the stop reached it.
        let settle!: (outcome: ChildRunOutcome) => void
        const outcome = new Promise<ChildRunOutcome>((resolve) => (settle = resolve))
        children.push({ input, executionRunId: "execution:job:late", settle })
        return { started: true, childId: "late", executionRunId: "execution:job:late", outcome }
      })
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "p",
        reason: "y",
      })
      await flush()
      cancelDelegation(delegation.id)
      lastLaunch().settle({ status: "completed", text: "late answer" })

      const settled = await completionPromise
      expect(settled.status).toBe("cancelled")
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("cancelled")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
      expect(dispatchOnTeamDelegationComplete).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" })
      )
    })

    it("never launches a deferred delegation cancelled before its approval", async () => {
      const { delegation } = delegateToTwin({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        twinId: "tw1",
        prompt: "p",
        reason: "r",
        awaitingApproval: true,
      })
      cancelDelegation(delegation.id)
      expect(useAgentTeamStore.getState().delegations[delegation.id]!.status).toBe("cancelled")
      approveDelegation(delegation.id)
      await flush()
      expect(launchMock).not.toHaveBeenCalled()
    })

    it("no-ops on already-settled delegations", async () => {
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "x",
        prompt: "p",
        reason: "y",
      })
      await completionPromise
      const after = cancelDelegation(delegation.id)
      expect(after?.status).toBe("completed")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
    })

    it("returns undefined for unknown delegationId", () => {
      expect(cancelDelegation("missing")).toBeUndefined()
    })
  })

  describe("quiet-hours gating", () => {
    it("defers a background delegation to awaiting_approval during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        prompt: "Investigate",
        reason: "offline",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(delegation.metadata?.quietHoursDeferred).toBe(true)
      expect(await isPending(completionPromise)).toBe(true)
      expect(launchMock).not.toHaveBeenCalled()
    })

    it("force=true launches a background delegation even during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        prompt: "Investigate",
        reason: "offline",
        force: true,
      })
      expect(delegation.status).toBe("active")
      await completionPromise
      expect(launchMock).toHaveBeenCalledTimes(1)
    })

    it("defers an external delegation to awaiting_approval during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        targetAgentId: "claude-code",
        prompt: "handoff payload",
        reason: "handoff",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(delegation.metadata?.quietHoursDeferred).toBe(true)
      expect(await isPending(completionPromise)).toBe(true)
      expect(launchMock).not.toHaveBeenCalled()
    })

    it("does not gate when no quiet-hours policy is configured", async () => {
      isInQuietHoursMock.mockReturnValue(true) // predicate would say yes, but no policy
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-no-policy",
        sourceTaskId: "task-1",
        prompt: "Go",
        reason: "r",
      })
      expect(delegation.status).toBe("active")
      await completionPromise
    })
  })
})

describe("delegateToTeam (team → team)", () => {
  function seedTeam(id: string, patch: Record<string, unknown> = {}) {
    useAgentTeamStore.setState((s) => ({
      teams: {
        ...s.teams,
        [id]: { id, name: id, teammateIds: [], status: "idle", ...patch } as never,
      },
    }))
  }

  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    __resetPendingDelegationRunsForTesting()
    dispatchOnTeamDelegationStart.mockReset()
    dispatchOnTeamDelegationComplete.mockReset()
    isInQuietHoursMock.mockReturnValue(false)
    jest.mocked(preparePersonalDerivedHistory).mockClear()
    resetLauncher()
  })

  it("rejects self-delegation as a cycle", async () => {
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "loop",
    })
    expect(delegation.status).toBe("failed")
    expect(delegation.metadata?.error).toMatch(/cycle/)
    expect((await completionPromise).status).toBe("failed")
    expect(launchMock).not.toHaveBeenCalled()
  })

  it("detects a multi-hop cycle in the active delegation graph", () => {
    // Active edge b → a already exists; delegating a → b would close the cycle.
    useAgentTeamStore.setState((s) => ({
      delegations: {
        d1: {
          id: "d1",
          sourceTeamId: "b",
          sourceTaskId: "t",
          targetType: "team",
          targetId: "a",
          status: "active",
          reason: "r",
          manual: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        ...s.delegations,
      },
    }))
    expect(wouldCreateTeamCycle("a", "b")).toBe(true)
    expect(wouldCreateTeamCycle("a", "c")).toBe(false)
  })

  it("launches a Squad child of the source team's live run and settles with its result", async () => {
    const parent = liveRun("a")
    autoOutcome = { status: "completed", text: "team B output" }
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "split work",
      ultracode: true,
    })
    expect(delegation.status).toBe("active")
    expect(dispatchOnTeamDelegationStart).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "team", targetId: "b" })
    )
    const settled = await completionPromise
    expect(lastLaunch().input).toMatchObject({
      parentRunId: parent,
      // A team delegation runs the target Squad on its own objective.
      target: { kind: "squad", squadId: "b", brief: "", origin: "delegation", ultracode: true },
      surface: "agent-team",
    })
    expect(settled.status).toBe("completed")
    expect(settled.result).toBe("team B output")
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    )
  })

  it("fails when the target team is not found", async () => {
    launchRefusal = { reason: "engine_refused", detail: "squad_not_found" }
    const settled = await delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "ghost",
      reason: "x",
    }).completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.result).toBe("target team not found: ghost")
  })

  it("fails when the target team is already running", async () => {
    launchRefusal = { reason: "engine_refused", detail: "already_running" }
    const settled = await delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    }).completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.result).toBe("team delegation refused: engine_refused (already_running)")
  })

  it("fails when the target team run fails", async () => {
    autoOutcome = { status: "failed", error: "lead gave up" }
    const settled = await delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    }).completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.result).toBe("lead gave up")
  })

  it("defers to awaiting_approval inside quiet hours and runs once approved", async () => {
    isInQuietHoursMock.mockReturnValue(true)
    seedTeam("a", {
      config: {
        governancePolicy: { delivery: { quietHours: { from: "22:00", to: "07:00", tz: "UTC" } } },
      },
    })
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    })
    expect(delegation.status).toBe("awaiting_approval")
    expect(await isPending(completionPromise)).toBe(true)
    expect(launchMock).not.toHaveBeenCalled()

    approveDelegation(delegation.id)
    await expect(completionPromise).resolves.toMatchObject({ status: "completed" })
    expect(lastLaunch().input.target).toMatchObject({ kind: "squad", squadId: "b" })
  })

  it("cancelDelegation stops the target team run and keeps the record cancelled", async () => {
    autoOutcome = null
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    })
    await flush()
    cancelDelegation(delegation.id)

    const settled = await completionPromise
    // The Squad child is stopped with the one tree stop, as any run is.
    expect(stopRunTreeMock).toHaveBeenCalledWith(lastLaunch().executionRunId)
    expect(settled.status).toBe("cancelled")
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
      delegationId: delegation.id,
      status: "cancelled",
    })
  })

  // ── ADR-0090 Phase 7: HandoffEnvelope + maxTeamDelegationDepth ─────────────

  function seedActiveEdge(id: string, sourceTeamId: string, targetId: string) {
    useAgentTeamStore.setState((s) => ({
      delegations: {
        ...s.delegations,
        [id]: {
          id,
          sourceTeamId,
          sourceTaskId: "t",
          targetType: "team",
          targetId,
          status: "active",
          reason: "r",
          manual: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
      },
    }))
  }

  it("attaches a secret-free HandoffEnvelope whose ends are real runs (X7)", async () => {
    const root = liveRun("root")
    const parent = liveRun("a", root)
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "task-9",
      targetTeamId: "b",
      reason: "split the work",
    })
    // No envelope before launch: the child run it names does not exist yet.
    expect(delegation.envelope).toBeUndefined()
    await completionPromise
    const linked = useAgentTeamStore.getState().delegations[delegation.id]
    expect(linked.envelope).toMatchObject({
      envelopeVersion: 1,
      identity: {
        parentRunId: parent,
        childRunId: lastLaunch().executionRunId,
        teamId: "a",
        taskId: "task-9",
        depth: 2,
        parentChain: [root, parent],
      },
      task: { prompt: "split the work" },
      execution: { mode: "orchestrated" },
    })
    expect(linked.metadata).toMatchObject({
      executionRunId: lastLaunch().executionRunId,
      delegationDepth: 2,
      delegationChain: ["root", "a"],
    })
    expect(JSON.stringify(linked.envelope)).not.toMatch(/sk-[a-z0-9]{6,}|api[_-]?key/i)
  })

  it("attaches no envelope to a delegation with no parent run", async () => {
    const { delegation, completionPromise } = delegateToBackground({
      sourceTeamId: "idle",
      sourceTaskId: "t",
      prompt: "x",
      reason: "y",
    })
    await completionPromise
    const linked = useAgentTeamStore.getState().delegations[delegation.id]
    expect(linked.envelope).toBeUndefined()
    expect(linked.metadata).toMatchObject({ delegationDepth: 1, delegationChain: ["idle"] })
  })

  it("depths 0/1/2 may delegate; a depth-2 source is refused with the typed code", async () => {
    // Pending chain (not launched yet): root → a → b, so b sits at depth 2.
    seedActiveEdge("d-root-a", "root", "a")
    seedActiveEdge("d-a-b", "a", "b")

    // From depth-1 team "a": child would be depth 2 — allowed.
    const fromA = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "c",
      reason: "ok",
    })
    expect(fromA.delegation.status).toBe("active")
    await fromA.completionPromise
    expect(useAgentTeamStore.getState().delegations[fromA.delegation.id].metadata).toMatchObject({
      delegationDepth: 2,
    })

    // From depth-2 team "b": child would be depth 3 — refused before dispatch.
    launchMock.mockClear()
    const fromB = delegateToTeam({
      sourceTeamId: "b",
      sourceTaskId: "t",
      targetTeamId: "d",
      reason: "too deep",
    })
    expect(fromB.delegation.status).toBe("failed")
    expect(fromB.delegation.metadata?.errorCode).toBe("delegation-depth-exceeded")
    expect((await fromB.completionPromise).status).toBe("failed")
    expect(launchMock).not.toHaveBeenCalled()
  })

  it("counts the Squad runs above the source on the run tree", async () => {
    // b's live run hangs under a's, which hangs under root's: b is at depth 2.
    const rootRun = liveRun("root")
    const aRun = liveRun("a", rootRun)
    liveRun("b", aRun)
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "b",
      sourceTaskId: "t",
      targetTeamId: "d",
      reason: "too deep",
    })
    // Nothing in the store says so: the tree refuses it at launch.
    expect(delegation.status).toBe("active")
    const settled = await completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.metadata).toMatchObject({
      errorCode: "delegation-depth-exceeded",
      depth: 3,
      maxDepth: 2,
    })
    expect(launchMock).not.toHaveBeenCalled()
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
      delegationId: delegation.id,
      status: "failed",
    })
  })

  it("refuses a target that is already above the source on the run tree", async () => {
    // a launched b; b delegating back to a would close the loop.
    const aRun = liveRun("a")
    liveRun("b", aRun)
    const settled = await delegateToTeam({
      sourceTeamId: "b",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "loop",
    }).completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.metadata?.error).toMatch(/cycle/)
    expect(launchMock).not.toHaveBeenCalled()
  })

  it("does not count a settled delegation's runs above an unrelated source", async () => {
    // a once launched b, but c runs on its own: c → a is not a cycle.
    const aRun = liveRun("a")
    liveRun("b", aRun)
    liveRun("c")
    const settled = await delegateToTeam({
      sourceTeamId: "c",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "fine",
    }).completionPromise
    expect(settled.status).toBe("completed")
  })

  it("re-checks a deferred delegation on the tree and fails one that can never run", async () => {
    isInQuietHoursMock.mockReturnValue(true)
    seedTeam("b", {
      config: {
        governancePolicy: { delivery: { quietHours: { from: "22:00", to: "07:00", tz: "UTC" } } },
      },
    })
    const aRun = liveRun("a")
    liveRun("b", aRun)
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "b",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "loop later",
    })
    expect(delegation.status).toBe("awaiting_approval")
    const settled = await completionPromise
    expect(settled.status).toBe("failed")
    expect(settled.metadata?.error).toMatch(/cycle/)
    // An approval afterwards launches nothing.
    approveDelegation(delegation.id)
    await flush()
    expect(launchMock).not.toHaveBeenCalled()
  })

  it("counts a delegation awaiting approval as an edge for the cycle check", async () => {
    isInQuietHoursMock.mockReturnValue(true)
    seedTeam("b", {
      config: {
        governancePolicy: { delivery: { quietHours: { from: "22:00", to: "07:00", tz: "UTC" } } },
      },
    })
    const deferred = delegateToTeam({
      sourceTeamId: "b",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "later",
    })
    expect(await isPending(deferred.completionPromise)).toBe(true)
    expect(useAgentTeamStore.getState().delegations[deferred.delegation.id]?.status).toBe(
      "awaiting_approval"
    )
    isInQuietHoursMock.mockReturnValue(false)
    const { delegation } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "loop",
    })
    expect(delegation.status).toBe("failed")
    expect(delegation.metadata?.error).toMatch(/cycle/)
  })

  it("honors a per-team maxTeamDelegationDepth override", () => {
    seedTeam("a", { config: { maxTeamDelegationDepth: 0 } })
    const { delegation } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "never allowed",
    })
    expect(delegation.status).toBe("failed")
    expect(delegation.metadata?.errorCode).toBe("delegation-depth-exceeded")
    expect(delegation.metadata?.maxDepth).toBe(0)
  })
})

describe("parked delegations survive a restart (F03)", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    __resetPendingDelegationRunsForTesting()
    dispatchOnTeamDelegationStart.mockReset()
    dispatchOnTeamDelegationComplete.mockReset()
    isInQuietHoursMock.mockReturnValue(false)
    resetLauncher()
  })

  const squad = () => useAgentTeamStore.getState().createTeam({ name: "Parked", task: "t" }).id

  function park(teamId: string, prompt = "Email ops@example.com the release notes") {
    return delegateToBackground({
      sourceTeamId: teamId,
      sourceTaskId: "task-p",
      prompt,
      systemPrompt: "You draft release mail",
      reason: "Needs a release mail",
      awaitingApproval: true,
    })
  }

  it("keeps a parked delegation on disk with its texts through the PII gate", async () => {
    const teamId = squad()
    const { delegation } = park(teamId)
    const row = await eventually(() => parkedRow(delegation.id), Boolean)
    expect(row).toMatchObject({
      sourceTeamId: teamId,
      sourceTaskId: "task-p",
      targetType: "background",
      targetId: delegation.targetId,
      reason: "Needs a release mail",
      redacted: true,
      run: {
        kind: "background",
        targetId: delegation.targetId,
        systemPrompt: "You draft release mail",
      },
    })
    expect(row?.run?.prompt).not.toContain("ops@example.com")
    expect(row?.run?.prompt).toMatch(/<EMAIL_\d{3,}>/)
  })

  it("writes nothing for a delegation that runs at once", async () => {
    const { delegation, completionPromise } = delegateToBackground({
      sourceTeamId: squad(),
      sourceTaskId: "task-now",
      prompt: "now",
      reason: "immediate",
    })
    await completionPromise
    await flush()
    expect(await parkedRow(delegation.id)).toBeUndefined()
  })

  it("comes back awaiting approval after a restart, and approving it runs the redacted copy", async () => {
    const teamId = squad()
    const { delegation } = park(teamId)
    await eventually(() => parkedRow(delegation.id), Boolean)
    dispatchOnTeamDelegationStart.mockClear()

    simulateRestart()
    // Before the restore there is nothing to approve: the old behavior.
    expect(approveDelegation(delegation.id)).toBeUndefined()

    await expect(restoreParkedDelegations()).resolves.toMatchObject({ restored: 1, withheld: 0 })
    const restored = useAgentTeamStore.getState().delegations[delegation.id]
    expect(restored).toMatchObject({
      status: "awaiting_approval",
      sourceTeamId: teamId,
      reason: "Needs a release mail",
      metadata: { restoredRedacted: true },
    })
    // It was started before the restart; restoring it is not a second start.
    expect(dispatchOnTeamDelegationStart).not.toHaveBeenCalled()

    expect(approveDelegation(delegation.id)?.status).toBe("active")
    await eventually(
      () => launchMock.mock.calls.length,
      (count) => count === 1
    )
    const target = lastLaunch().input.target as { prompt: string; systemPrompt?: string }
    expect(target.prompt).not.toContain("ops@example.com")
    expect(target.prompt).toMatch(/^Email <EMAIL_\d{3,}> the release notes$/)
    expect(target.systemPrompt).toBe("You draft release mail")
    expect(lastLaunch().input.childId).toBe(delegation.targetId)
    await eventually(
      () => useAgentTeamStore.getState().delegations[delegation.id]?.status,
      (status) => status === "completed"
    )
    // Approved once: the row is taken, so a further restart offers nothing.
    expect(await parkedRow(delegation.id)).toBeUndefined()
  })

  it("runs the original text when approved in the process that parked it", async () => {
    const { delegation } = park(squad())
    await eventually(() => parkedRow(delegation.id), Boolean)
    approveDelegation(delegation.id)
    await eventually(
      () => launchMock.mock.calls.length,
      (count) => count === 1
    )
    expect(lastLaunch().input.target).toMatchObject({
      prompt: "Email ops@example.com the release notes",
    })
    await eventually(
      () => parkedRow(delegation.id),
      (row) => row === undefined
    )
  })

  it("forgets the row when the parked delegation is cancelled", async () => {
    const { delegation } = park(squad())
    await eventually(() => parkedRow(delegation.id), Boolean)
    cancelDelegation(delegation.id)
    await eventually(
      () => parkedRow(delegation.id),
      (row) => row === undefined
    )
    simulateRestart()
    await expect(restoreParkedDelegations()).resolves.toMatchObject({ restored: 0 })
    expect(useAgentTeamStore.getState().delegations[delegation.id]).toBeUndefined()
  })

  it("parks a quiet-hours team delegation, and forgets it once the tree refuses it", async () => {
    isInQuietHoursMock.mockReturnValue(true)
    const source = seedTeamWithQuietHours()
    const parked = delegateToTeam({
      sourceTeamId: source,
      sourceTaskId: "task-t",
      targetTeamId: "target-squad",
      reason: "later",
      ultracode: true,
    })
    expect(parked.delegation.status).toBe("awaiting_approval")
    await expect(eventually(() => parkedRow(parked.delegation.id), Boolean)).resolves.toMatchObject(
      {
        targetType: "team",
        run: { kind: "team", prompt: "", targetId: "target-squad", ultracode: true },
      }
    )

    // The target already runs above the source: it can never run.
    const targetRun = liveRun("loop-target")
    liveRun(source, targetRun)
    const refused = delegateToTeam({
      sourceTeamId: source,
      sourceTaskId: "task-t",
      targetTeamId: "loop-target",
      reason: "loop later",
    })
    expect(refused.delegation.status).toBe("awaiting_approval")
    await expect(refused.completionPromise).resolves.toMatchObject({ status: "failed" })
    await eventually(
      () => parkedRow(refused.delegation.id),
      (row) => row === undefined
    )
  })

  it("brings back a delegation whose run could not be kept as failed, saying why", async () => {
    mockLeakCheck.mockImplementation((text) => (text.includes("secret-code") ? false : undefined))
    const teamId = squad()
    const { delegation } = park(teamId, "Use secret-code 7 for the vault")
    const row = await eventually(() => parkedRow(delegation.id), Boolean)
    expect(row?.run).toBeUndefined()
    expect(row?.redacted).toBe(false)

    simulateRestart()
    await expect(restoreParkedDelegations()).resolves.toMatchObject({ restored: 0, withheld: 1 })
    expect(useAgentTeamStore.getState().delegations[delegation.id]).toMatchObject({
      status: "failed",
      result: DELEGATION_RUN_WITHHELD,
    })
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
      delegationId: delegation.id,
      status: "failed",
    })
    expect(launchMock).not.toHaveBeenCalled()
    await eventually(
      () => parkedRow(delegation.id),
      (kept) => kept === undefined
    )
  })

  it("still runs a withheld delegation from memory in the process that parked it", async () => {
    mockLeakCheck.mockImplementation((text) => (text.includes("secret-code") ? false : undefined))
    const { delegation } = park(squad(), "Use secret-code 7 for the vault")
    await eventually(() => parkedRow(delegation.id), Boolean)
    approveDelegation(delegation.id)
    await eventually(
      () => launchMock.mock.calls.length,
      (count) => count === 1
    )
    expect(lastLaunch().input.target).toMatchObject({ prompt: "Use secret-code 7 for the vault" })
  })

  it("drops a parked row whose source Squad is gone", async () => {
    const db = getDb()
    await putParkedDelegation(db, {
      id: "orphan",
      sourceTeamId: "deleted-squad",
      sourceTaskId: "t",
      targetType: "background",
      targetId: "bg_orphan",
      reason: "left behind",
      manual: true,
      createdAt: 1,
      run: { kind: "background", prompt: "p", targetId: "bg_orphan" },
      redacted: false,
    })
    await expect(restoreParkedDelegations(db)).resolves.toMatchObject({ dropped: 1 })
    expect(useAgentTeamStore.getState().delegations.orphan).toBeUndefined()
    expect(await parkedRow("orphan")).toBeUndefined()
  })

  it("leaves a delegation this process still holds alone", async () => {
    const { delegation } = park(squad())
    await eventually(() => parkedRow(delegation.id), Boolean)
    await expect(restoreParkedDelegations()).resolves.toMatchObject({ restored: 0 })
    expect(useAgentTeamStore.getState().delegations[delegation.id].metadata).toBeUndefined()
    approveDelegation(delegation.id)
    await eventually(
      () => launchMock.mock.calls.length,
      (count) => count === 1
    )
    expect(lastLaunch().input.target).toMatchObject({
      prompt: "Email ops@example.com the release notes",
    })
  })

  it("runs only the first of two windows' approvals", async () => {
    const { delegation, completionPromise } = park(squad())
    await eventually(() => parkedRow(delegation.id), Boolean)
    // The other window, which restored the same row, approves it first.
    await expect(claimParkedDelegation(getDb(), delegation.id)).resolves.toMatchObject({
      id: delegation.id,
    })
    expect(approveDelegation(delegation.id)?.status).toBe("active")
    await expect(completionPromise).resolves.toMatchObject({
      status: "failed",
      result: DELEGATION_TAKEN_ELSEWHERE,
    })
    expect(launchMock).not.toHaveBeenCalled()
  })
})
