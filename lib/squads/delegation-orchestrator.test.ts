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

const dispatchOnTeamDelegationStart = jest.fn()
const dispatchOnTeamDelegationComplete = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnTeamDelegationStart,
    dispatchOnTeamDelegationComplete,
  })),
}))

jest.mock("@/lib/connectors/outbound-runner", () => ({
  isInQuietHours: jest.fn(() => false),
}))
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
const isInQuietHoursMock = isInQuietHours as unknown as jest.Mock

// Rows that exist in the ledger, and the live Squad run of each team.
const rows = new Set<string>()
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: async (id: string) => (rows.has(id) ? { id } : undefined),
}))
const liveRuns: Record<string, string> = {}
jest.mock("./squad/squad-run-records", () => ({
  findLiveSquadRun: async (teamId: string) =>
    liveRuns[teamId] ? { id: liveRuns[teamId] } : undefined,
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

import type { LaunchChildRunInput } from "@/lib/execution/launch-child-run"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import {
  __resetPendingDelegationRunsForTesting,
  approveDelegation,
  cancelDelegation,
  delegateToBackground,
  delegateToExternal,
  delegateToTeam,
  delegateToTwin,
  wouldCreateTeamCycle,
} from "./delegation-orchestrator"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type { AgentTeam } from "@/types/agent/agent-team"

/** Flush pending microtasks + a macrotask so async launches settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const lastLaunch = () => children[children.length - 1]

function resetLauncher() {
  launchMock.mockClear()
  children.length = 0
  autoOutcome = { status: "completed", text: "ok" }
  launchRefusal = undefined
  launchGate = undefined
  rows.clear()
  for (const key of Object.keys(liveRuns)) delete liveRuns[key]
}

/** A live Squad run of `teamId` whose `execution:team:` row exists. */
function liveRun(teamId: string, runId = `run_team_${teamId}`): string {
  liveRuns[teamId] = runId
  rows.add(`execution:team:${runId}`)
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
    resetLauncher()
  })

  describe("delegateToBackground", () => {
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
      rows.add("execution:workflow:wf-1")
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

    it("respects awaitingApproval and keeps the delegation in that status", async () => {
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "needs review",
        awaitingApproval: true,
      })
      expect(delegation.status).toBe("awaiting_approval")
      const settled = await completionPromise
      expect(settled.status).toBe("awaiting_approval")
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
      await completionPromise
      expect(launchMock).not.toHaveBeenCalled()
      approveDelegation(delegation.id)
      await flush()
      expect(lastLaunch().input.target).toMatchObject({ kind: "twin", twinId: "tw1" })
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
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
      await flush()
      expect(lastLaunch().input.target).toMatchObject({
        kind: "agent",
        prompt: "investigate later",
      })
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
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
    it("stops the running child, flips the record to cancelled and fires one hook", async () => {
      autoOutcome = null
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      await flush()
      const { input } = lastLaunch()
      expect(input.signal?.aborted).toBe(false)

      const after = cancelDelegation(delegation.id)

      expect(after?.status).toBe("cancelled")
      expect(input.signal?.aborted).toBe(true)
      expect((await completionPromise).status).toBe("cancelled")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledTimes(1)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "cancelled",
      })
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
      await completionPromise
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
      expect((await completionPromise).status).toBe("awaiting_approval")
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
    expect((await completionPromise).status).toBe("awaiting_approval")
    expect(launchMock).not.toHaveBeenCalled()

    approveDelegation(delegation.id)
    await flush()
    expect(lastLaunch().input.target).toMatchObject({ kind: "squad", squadId: "b" })
    expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
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
    expect(lastLaunch().input.signal?.aborted).toBe(true)

    const settled = await completionPromise
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

  it("persists a secret-free HandoffEnvelope with identity chain and depth", () => {
    autoOutcome = null
    const { delegation } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "task-9",
      targetTeamId: "b",
      reason: "split the work",
    })
    expect(delegation.envelope).toMatchObject({
      envelopeVersion: 1,
      identity: {
        parentRunId: "a",
        childRunId: delegation.id,
        taskId: "task-9",
        depth: 1,
        parentChain: ["a"],
      },
      task: { prompt: "split the work" },
      execution: { mode: "orchestrated" },
    })
    expect(JSON.stringify(delegation.envelope)).not.toMatch(/sk-[a-z0-9]{6,}|api[_-]?key/i)
  })

  it("depths 0/1/2 may delegate; a depth-2 source is refused with the typed code", async () => {
    // Active chain: root → a → b, so b sits at delegation depth 2.
    seedActiveEdge("d-root-a", "root", "a")
    seedActiveEdge("d-a-b", "a", "b")
    autoOutcome = null

    // From depth-1 team "a": child would be depth 2 — allowed.
    const fromA = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "c",
      reason: "ok",
    })
    expect(fromA.delegation.status).toBe("active")
    expect(fromA.delegation.envelope?.identity.depth).toBe(2)
    await flush()

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
