/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { dexieTeamRunStore } from "@/lib/db/agent-team-runtime"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRunRecord,
} from "@/types/agent/agent-team-runtime"
import { assessStoredRunRecovery } from "@cognia/agent-orchestration/coordinator"
import { guardSquadRunResume } from "./squad-control"
import { createSquadRunRecords } from "./squad-run-records"

const RUN = "run_team_ctl01"

async function seedRun(status: "queued" | "running" | "paused" | "completed" | "needs_input") {
  await createSquadRunRecords({
    runId: RUN,
    teamId: "team-1",
    objective: "o",
    origin: "chat",
    executionConstraints: {
      version: 1,
      teamConfig: {},
      origin: "chat",
      triggeredFrom: { source: "ui" },
      requirePlanApprovalFloor: false,
    },
    startedAt: 1_000,
  })
  await getDb().agentTeamRuns.update(RUN, { status })
}

function child(id: string, status: AgentTeamChildRun["status"]): AgentTeamChildRun {
  return {
    id,
    runId: RUN,
    teamId: "team-1",
    teammateId: "m1",
    taskId: `task-${id}`,
    repositoryId: "primary",
    status,
    ...(status !== "queued" ? { startedAt: 1 } : { dispatchEpoch: 0 }),
    attempt: 1,
    resourceUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      wallTimeMs: 0,
      toolTimeMs: 0,
      attempts: status === "queued" ? 0 : 1,
      failures: 0,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function checkpoint(
  childRunId: string,
  replay: "safe" | "needs_input",
  sideEffects: AgentTeamCheckpoint["sideEffects"] = []
): AgentTeamCheckpoint {
  return {
    id: `cp-${childRunId}-${replay}`,
    runId: RUN,
    childRunId,
    trajectorySequence: 1,
    decisionVersion: 0,
    replay,
    sideEffects,
    createdAt: 2,
  }
}

async function current(): Promise<AgentTeamRunRecord> {
  return (await getDb().agentTeamRuns.get(RUN))!
}

let disableDbRuntime: (() => void) | undefined
beforeEach(async () => {
  disableDbRuntime = __enableDbRuntimeForTesting()
  await getDb().delete()
  __resetDbForTesting()
})
afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  disableDbRuntime?.()
})

describe("guardSquadRunResume", () => {
  const ready = async () => ({ blocked: false })

  it("admits a run with its authority snapshot and nothing uncertain", async () => {
    await seedRun("paused")
    expect(
      await guardSquadRunResume(await current(), { reentry: true }, { readiness: ready })
    ).toEqual({ kind: "admit" })
  })

  it("refuses a backfilled legacy run before anything else", async () => {
    await seedRun("needs_input")
    await getDb().agentTeamRuns.update(RUN, {
      recoveryReason: "legacy_run_not_resumable",
      executionConstraints: undefined,
    })
    expect(await guardSquadRunResume(await current(), { reentry: true })).toEqual({
      kind: "legacy",
    })
  })

  it("refuses a run without its frozen authority snapshot", async () => {
    await seedRun("paused")
    await getDb().agentTeamRuns.update(RUN, { executionConstraints: undefined })
    expect(await guardSquadRunResume(await current(), { reentry: false })).toEqual({
      kind: "missing_constraints",
    })
  })

  it("names the children whose last checkpoint cannot be trusted", async () => {
    await seedRun("paused")
    await getDb().agentTeamChildRuns.add({
      ...child("c1", "running"),
      stop: {
        state: "confirmed",
        epoch: 0,
        requestedAt: 1,
        proof: { kind: "ack", epoch: 0, at: 2 },
      },
    })
    await getDb().agentTeamCheckpoints.add(
      checkpoint("c1", "safe", [{ id: "e1", kind: "Bash", state: "unknown", replay: "unknown" }])
    )
    expect(await guardSquadRunResume(await current(), { reentry: false })).toEqual({
      kind: "uncertain",
      reason: "uncertain_side_effect",
      uncertainChildIds: ["c1"],
    })
  })

  it("asks the readiness guard only for a re-entry", async () => {
    await seedRun("paused")
    const readiness = jest.fn(async () => ({ blocked: true }))
    expect(await guardSquadRunResume(await current(), { reentry: false }, { readiness })).toEqual({
      kind: "admit",
    })
    expect(readiness).not.toHaveBeenCalled()
    expect(await guardSquadRunResume(await current(), { reentry: true }, { readiness })).toEqual({
      kind: "unready",
    })
    expect(readiness).toHaveBeenCalledWith("team-1", RUN)
  })
})

/** The package's run gate over the Dexie store: the guard's replay step. */
describe("assessStoredRunRecovery over the Dexie store", () => {
  const assess = (runId: string) => assessStoredRunRecovery(dexieTeamRunStore, runId, Date.now())

  it("is safe with no children, with settled children, and with never-started ones", async () => {
    expect(await assess(RUN)).toEqual({ safe: true, uncertainChildIds: [] })
    await getDb().agentTeamChildRuns.bulkAdd([child("done", "completed"), child("fresh", "queued")])
    await getDb().agentTeamCheckpoints.add(checkpoint("done", "safe"))
    expect(await assess(RUN)).toMatchObject({
      safe: false,
      reason: "stop_unconfirmed",
    })
    await getDb().agentTeamChildRuns.update("done", {
      settledEpoch: 0,
      stop: {
        state: "confirmed",
        epoch: 0,
        requestedAt: 1,
        proof: { kind: "ack", epoch: 0, at: 2 },
      },
    })
    expect(await assess(RUN)).toEqual({ safe: true, uncertainChildIds: [] })
  })

  it("does not mistake a queued previous dispatch for work that never started", async () => {
    await getDb().agentTeamChildRuns.add({
      ...child("queued-old", "queued"),
      startedAt: 1,
      dispatchEpoch: 1,
      remoteDispatchEpoch: 1,
    })
    await getDb().agentTeamCheckpoints.add(checkpoint("queued-old", "safe"))
    expect(await assess(RUN)).toMatchObject({
      safe: false,
      reason: "stop_unconfirmed",
    })
    await getDb().agentTeamChildRuns.update("queued-old", {
      stop: {
        state: "confirmed",
        epoch: 1,
        requestedAt: 1,
        proof: { kind: "ack", epoch: 1, at: 2 },
      },
    })
    expect(await assess(RUN)).toEqual({ safe: true, uncertainChildIds: [] })
  })

  it("names every child whose last checkpoint cannot be trusted", async () => {
    await getDb().agentTeamChildRuns.bulkAdd([
      child("no-cp", "running"),
      child("needs", "paused"),
      child("intent", "running"),
      {
        ...child("ok", "paused"),
        stop: {
          state: "confirmed",
          epoch: 0,
          requestedAt: 1,
          proof: { kind: "ack", epoch: 0, at: 2 },
        },
      },
    ])
    await getDb().agentTeamCheckpoints.bulkAdd([
      checkpoint("needs", "needs_input"),
      checkpoint("intent", "safe", [{ id: "e", kind: "Write", state: "intent", replay: "unsafe" }]),
      checkpoint("ok", "safe", [{ id: "e", kind: "Read", state: "completed", replay: "safe" }]),
    ])
    const assessment = await assess(RUN)
    expect(assessment.safe).toBe(false)
    expect([...assessment.uncertainChildIds].sort()).toEqual(["intent", "needs", "no-cp"])
  })

  it("requires review for a remote event not covered by the safe checkpoint", async () => {
    await getDb().agentTeamChildRuns.add({ ...child("remote", "paused"), remoteDispatchEpoch: 1 })
    await getDb().agentTeamCheckpoints.add(checkpoint("remote", "safe"))
    await getDb().agentTeamTrajectory.add({
      id: "remote-tail",
      runId: RUN,
      childRunId: "remote",
      sequence: 2,
      kind: "remote_event",
      correlationId: "remote-tail",
      createdAt: 3,
    })
    expect(await assess(RUN)).toEqual({
      safe: false,
      uncertainChildIds: ["remote"],
      reason: "stop_unconfirmed",
    })
  })
})
