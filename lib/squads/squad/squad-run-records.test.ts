/** @jest-environment jsdom */
import { contractChild } from "@cognia/agent-orchestration/store-contract"
import "fake-indexeddb/auto"
jest.mock("@/lib/connectors/tauri/commands", () => ({
  ...jest.requireActual("@/lib/connectors/tauri/commands"),
  connectorsLarkUserAuth: jest.fn(async () => ({ configured: false })),
}))

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { admitPersonalCredential } from "@/lib/execution/personal-credential"
import { assertLarkActingIdentity } from "@/lib/skills/built-in/lark/acting-identity"
import {
  registerTeamDispatchContext,
  clearTeamDispatchContext,
} from "@/lib/claude/agents/dispatch-context-registry"
import {
  createSquadRunRecords,
  findLiveSquadRun,
  parkActiveSquadRun,
  squadIdForTeamRun,
  type SquadRunSeed,
} from "./squad-run-records"

const seed: SquadRunSeed = {
  runId: "run_team_abc",
  teamId: "team-1",
  projectId: "ws-1",
  sessionId: "s-1",
  objective: "Ship the thing",
  origin: "chat",
  priority: 2,
  environmentVersionId: "env:v3",
  startedAt: 1_000,
}

describe("createSquadRunRecords", () => {
  it.each(["ui", "interactive"])(
    "refuses caller-supplied plugin runTeam origin %s",
    async (origin) => {
      const result = await createSquadRunRecords({
        ...seed,
        origin,
        executionConstraints: { triggeredFrom: { source: "ui" } } as never,
      })
      expect(result.executionRun.actingIdentity?.trigger).toBe("external-event")
      await getDb().sessions.put({ id: seed.sessionId } as never)
      await expect(
        assertLarkActingIdentity("a1", {
          sessionId: seed.sessionId!,
          executionRunId: result.executionRunId,
        })
      ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
    }
  )

  it.each(["ui", "api"])(
    "admits desktop/paired manual Squad source %s only with host proof, including a session-less member",
    async (source) => {
      const result = await createSquadRunRecords({
        ...seed,
        sessionId: undefined,
        localAuthorization: LOCAL_PERSON_RUN,
        executionConstraints: { triggeredFrom: { source } } as never,
      })
      expect(result.executionRun.actingIdentity).toMatchObject({
        trigger: "local",
        authorizingPrincipal: { kind: "local-person" },
      })
      expect(
        await admitPersonalCredential(
          { executionRunId: result.executionRunId },
          { source: "github-user" }
        )
      ).toMatchObject({ ok: true })
      expect(
        await admitPersonalCredential(
          { executionRunId: result.executionRunId, sessionId: "unrelated" },
          { source: "github-user" }
        )
      ).toMatchObject({ ok: false, reason: "missing-identity" })
      await getDb().sessions.put({
        id: "member",
        kind: "team",
        programmaticCreator: "team-teammate",
      } as never)
      registerTeamDispatchContext("member", {
        teamId: seed.teamId,
        runId: seed.runId,
        teammateId: "m",
        teammateName: "M",
      })
      try {
        const child = await startToolExecutionRun("member", { parentRunId: result.executionRunId })
        await expect(
          assertLarkActingIdentity("a1", { sessionId: "member", executionRunId: child.id })
        ).resolves.toBeUndefined()
      } finally {
        clearTeamDispatchContext("member")
      }
    }
  )
  it("records an automatic Squad with no human provenance as external-event", async () => {
    const result = await createSquadRunRecords({ ...seed, origin: "automation" })
    expect(result.executionRun.actingIdentity).toMatchObject({
      trigger: "external-event",
      rootRunId: result.executionRunId,
      requesters: [],
    })
  })

  it("records an explicitly scheduled Squad even without frozen constraints", async () => {
    const result = await createSquadRunRecords({ ...seed, origin: "schedule" })
    expect(result.executionRun.actingIdentity?.trigger).toBe("schedule")
  })
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

  it("creates the durable run and the execution run together, with the opening event", async () => {
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(true)
    expect(result.executionRunId).toBe("execution:team:run_team_abc")

    const run = await getDb().agentTeamRuns.get("run_team_abc")
    expect(run).toMatchObject({
      teamId: "team-1",
      projectId: "ws-1",
      objective: "Ship the thing",
      status: "queued",
      priority: 2,
      environmentVersionId: "env:v3",
      queueEnteredAt: 1_000,
    })

    const execution = await getDb().executionRuns.get("execution:team:run_team_abc")
    expect(execution).toMatchObject({
      kind: "team",
      sourceId: "run_team_abc",
      sessionId: "s-1",
      projectId: "ws-1",
      title: "Ship the thing",
      status: "running",
      currentRevision: 1,
    })
    const events = await getDb().executionRunEvents.where("runId").equals(execution!.id).toArray()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: { teamId: "team-1", origin: "chat" },
    })
  })

  /** An idempotency key that is replayed must find the run, never fork it. */
  it("is idempotent for the same run id", async () => {
    const first = await createSquadRunRecords(seed)
    const second = await createSquadRunRecords({ ...seed, startedAt: 9_999 })
    expect(second.created).toBe(false)
    expect(second.run).toEqual(first.run)
    expect(await getDb().agentTeamRuns.count()).toBe(1)
    expect(await getDb().executionRuns.count()).toBe(1)
    expect(await getDb().executionRunEvents.count()).toBe(1)
  })

  it("admits only one concurrent start for the same Squad inside the transaction", async () => {
    const results = await Promise.allSettled([
      createSquadRunRecords(seed),
      createSquadRunRecords({ ...seed, runId: "run_team_racing" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(await getDb().agentTeamRuns.count()).toBe(1)
  })

  it("atomically replaces a parked run and preserves terminal history on replay", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    const replacement = await createSquadRunRecords({
      ...seed,
      runId: "replacement",
      parentRunId: `execution:team:${seed.runId}`,
    })
    expect(replacement.replacedRunId).toBe(seed.runId)
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("cancelled")
    expect((await getDb().executionRuns.get(`execution:team:${seed.runId}`))?.status).toBe(
      "cancelled"
    )
    expect((await createSquadRunRecords(seed)).created).toBe(false)
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("cancelled")
  })

  it.each([false, true])(
    "admits replacement records with stop proof alone (unsafe=%s)",
    async (unsafe) => {
      await createSquadRunRecords(seed)
      await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
      await getDb().agentTeamChildRuns.add(
        contractChild({
          id: "stopped-child",
          runId: seed.runId,
          teamId: seed.teamId,
          taskId: "old-task",
          status: "needs_input",
          dispatchEpoch: 1,
          startedAt: 1,
          stop: {
            state: "confirmed",
            epoch: 1,
            requestedAt: 1,
            proof: { kind: "ack", epoch: 1, at: 2 },
          },
        })
      )
      if (unsafe)
        await getDb().agentTeamCheckpoints.add({
          id: "old-checkpoint",
          runId: seed.runId,
          childRunId: "stopped-child",
          trajectorySequence: 0,
          decisionVersion: 0,
          replay: "needs_input",
          sideEffects: [{ id: "write", kind: "Write", state: "unknown", replay: "unknown" }],
          createdAt: 2,
        })
      const replacement = await createSquadRunRecords({
        ...seed,
        runId: "replacement",
        parentRunId: `execution:team:${seed.runId}`,
      })
      expect(replacement.created).toBe(true)
      expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("cancelled")
    }
  )

  it("does not replace an actively executing run", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "running" })
    await expect(
      createSquadRunRecords({
        ...seed,
        runId: "replacement",
        parentRunId: `execution:team:${seed.runId}`,
      })
    ).rejects.toThrow(/already has a live run/)
    expect(await getDb().agentTeamRuns.count()).toBe(1)
  })

  it("does not reopen finalized parent rows when replacement admission refuses stop proof", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "cancelled" })
    await getDb().executionRuns.update(`execution:team:${seed.runId}`, { status: "cancelled" })
    await getDb().agentTeamChildRuns.add(
      contractChild({
        runId: seed.runId,
        teamId: seed.teamId,
        dispatchEpoch: 1,
        remoteDispatchEpoch: 1,
        startedAt: 1,
        stop: { state: "unconfirmed", epoch: 1, requestedAt: 2 },
      })
    )
    await expect(
      createSquadRunRecords({
        ...seed,
        runId: "replacement",
        parentRunId: `execution:team:${seed.runId}`,
      })
    ).rejects.toThrow("already has a live run")
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("cancelled")
    expect((await getDb().executionRuns.get(`execution:team:${seed.runId}`))?.status).toBe(
      "cancelled"
    )
  })

  it("does not park a durable row after its canonical execution is terminal", async () => {
    await createSquadRunRecords(seed)
    await getDb().executionRuns.update(`execution:team:${seed.runId}`, { status: "cancelled" })
    await expect(parkActiveSquadRun(seed.runId, "stop_unconfirmed", 2_000)).resolves.toBe(false)
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("queued")
  })

  it.each(["requested", "unconfirmed", "confirmed"] as const)(
    "does not park a retry assessment over a %s stop, even with unchanged timestamps",
    async (state) => {
      const { run } = await createSquadRunRecords(seed)
      await getDb().agentTeamRuns.update(seed.runId, {
        stop: { state, epoch: 1, requestedAt: 2_000 },
      })
      await expect(parkActiveSquadRun(seed.runId, "stop_unconfirmed", 3_000, run)).resolves.toBe(
        false
      )
      const current = (await getDb().agentTeamRuns.get(seed.runId))!
      // A gate that starts after the stop must also leave it alone.
      await expect(
        parkActiveSquadRun(seed.runId, "stop_unconfirmed", 3_000, current)
      ).resolves.toBe(false)
      expect(await getDb().agentTeamRuns.get(seed.runId)).toEqual(current)
    }
  )

  it("does not park a retry assessment after another durable transition", async () => {
    const { run } = await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "paused", updatedAt: 2_000 })
    await expect(parkActiveSquadRun(seed.runId, "stop_unconfirmed", 3_000, run)).resolves.toBe(
      false
    )
    expect(await getDb().agentTeamRuns.get(seed.runId)).toMatchObject({
      status: "paused",
      updatedAt: 2_000,
    })
  })

  it("reuses a settled replacement when the same parent restart is delivered again", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    const parentRunId = `execution:team:${seed.runId}`
    const first = await createSquadRunRecords({ ...seed, runId: "first-replacement", parentRunId })
    await getDb().agentTeamRuns.update(first.runId, { status: "completed" })
    const replay = await createSquadRunRecords({
      ...seed,
      runId: "second-replacement",
      parentRunId,
    })
    expect(replay).toMatchObject({
      created: false,
      runId: first.runId,
      executionRunId: first.executionRunId,
    })
    expect(await getDb().agentTeamRuns.count()).toBe(2)
  })

  it("links a launched Squad run to the run that launched it, without replacing anything", async () => {
    const parent = await createSquadRunRecords(seed)
    const launched = await createSquadRunRecords({
      ...seed,
      runId: "run_team_child",
      teamId: "team-2",
      launchedByRunId: parent.executionRunId,
      startedAt: 2_000,
    })
    expect(launched.created).toBe(true)
    expect(launched.replacedRunId).toBeUndefined()
    // It acts as the run that launched it: same root, same trigger.
    expect(launched.executionRun).toMatchObject({
      parentRunId: parent.executionRunId,
      actingIdentity: expect.objectContaining({
        rootRunId: parent.executionRunId,
        trigger: parent.executionRun.actingIdentity?.trigger,
      }),
    })
    // The launching run keeps running.
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("queued")
  })

  it("does not take a launched child of another Squad for the parent's replacement", async () => {
    const parent = await createSquadRunRecords(seed)
    await createSquadRunRecords({
      ...seed,
      runId: "run_team_child",
      teamId: "team-2",
      launchedByRunId: parent.executionRunId,
      startedAt: 2_000,
    })
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    const replacement = await createSquadRunRecords({
      ...seed,
      runId: "replacement",
      parentRunId: parent.executionRunId,
      startedAt: 3_000,
    })
    expect(replacement).toMatchObject({ created: true, replacedRunId: seed.runId })
  })

  it("prefers the replaced run over the launcher when a replacement names both", async () => {
    const parent = await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    const replacement = await createSquadRunRecords({
      ...seed,
      runId: "replacement",
      parentRunId: parent.executionRunId,
      launchedByRunId: "execution:team:someone-else",
      startedAt: 3_000,
    })
    expect(replacement.executionRun.parentRunId).toBe(parent.executionRunId)
  })

  it("converges concurrent restart deliveries onto one replacement", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    const results = await Promise.all(
      ["replacement-a", "replacement-b"].map((runId) =>
        createSquadRunRecords({ ...seed, runId, parentRunId: `execution:team:${seed.runId}` })
      )
    )
    expect(new Set(results.map((result) => result.runId)).size).toBe(1)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(await getDb().agentTeamRuns.count()).toBe(2)
  })

  it("converges when only one of the two rows already exists", async () => {
    await getDb().agentTeamRuns.add({
      id: seed.runId,
      teamId: seed.teamId,
      objective: "older",
      status: "running",
      priority: 0,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(false)
    expect(result.run.objective).toBe("older")
    expect(await getDb().executionRuns.get(result.executionRunId)).toBeDefined()
  })

  it("refuses to attach a run id that belongs to another Squad", async () => {
    await createSquadRunRecords(seed)
    await expect(createSquadRunRecords({ ...seed, teamId: "team-2" })).rejects.toThrow(
      /belongs to another Squad/
    )
    expect(await getDb().executionRuns.count()).toBe(1)
  })

  it("restores a missing execution row without resurrecting terminal history", async () => {
    await getDb().agentTeamRuns.add({
      id: seed.runId,
      teamId: seed.teamId,
      objective: "finished",
      status: "terminated",
      priority: 0,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    })
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(false)
    expect(result.executionRun.status).toBe("cancelled")
  })

  it("ignores late recovery failures after cancellation", async () => {
    await createSquadRunRecords(seed)
    expect(await parkActiveSquadRun(seed.runId, "launch_failed", 2_000)).toBe(true)
    await getDb().agentTeamRuns.update(seed.runId, { status: "cancelled" })
    expect(await parkActiveSquadRun(seed.runId, "reentry_failed", 3_000)).toBe(false)
    expect((await getDb().agentTeamRuns.get(seed.runId))?.status).toBe("cancelled")
  })

  it("requires a real local pause before replacement while a control is still live", async () => {
    const { createDurableTeamCoordinator } = await import("../durable/durable-runtime")
    const { beginDurableDispatch } = await import("../durable/durable-dispatch")
    const { sidecarSessionControl } = await import("../teammate/child-controls")
    const parent = await createSquadRunRecords(seed)
    const coordinator = createDurableTeamCoordinator()
    const team = {
      id: seed.teamId,
      leadId: "lead",
      task: seed.objective,
      config: { repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }] },
    } as import("@/types/agent/agent-team").AgentTeam
    await coordinator.prepareRun(team, seed.runId)
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: seed.runId,
      teammateId: "mate",
      taskId: "task",
      repositoryId: "primary",
      access: "read",
    })
    let release!: () => void
    const execute = async () => {
      await dispatch.attachControl(
        sidecarSessionControl(
          {
            steerSession: async () => {},
            interruptSession: async () => {
              release()
            },
            closeSession: async () => {
              release()
            },
          },
          "local-session"
        )
      )
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const execution = dispatch.run(() => {
      const pending = execute()
      dispatch.trackLocalStop(
        pending.then(
          () => undefined,
          () => undefined
        )
      )
      return pending
    })
    const observed = execution.catch(() => undefined)
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    await getDb().agentTeamRuns.update(seed.runId, { status: "paused" })
    const replacement = { ...seed, runId: "replacement", parentRunId: parent.executionRunId }
    try {
      await expect(createSquadRunRecords(replacement)).rejects.toThrow("live run")
      expect(await getDb().agentTeamRuns.get("replacement")).toBeUndefined()
      expect(
        (await getDb().executionRunEvents.toArray()).some((event) => event.type === "run.cancelled")
      ).toBe(false)
      await coordinator.pauseChild(dispatch.childRunId)
      expect((await getDb().agentTeamChildRuns.get(dispatch.childRunId))?.stop?.proof?.kind).toBe(
        "ack"
      )
      await expect(createSquadRunRecords(replacement)).resolves.toMatchObject({ created: true })
    } finally {
      release()
      await observed
      dispatch.dispose()
    }
  })

  it("refuses replacement records without a stop proof even for a queued old child", async () => {
    await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.update(seed.runId, { status: "needs_input" })
    await getDb().agentTeamChildRuns.add(
      contractChild({
        runId: seed.runId,
        status: "queued",
        startedAt: 1,
        dispatchEpoch: 1,
        remoteDispatchEpoch: 1,
      })
    )
    await expect(
      createSquadRunRecords({
        ...seed,
        runId: "replacement",
        parentRunId: `execution:team:${seed.runId}`,
      })
    ).rejects.toThrow("live run")
    expect(await getDb().agentTeamRuns.get("replacement")).toBeUndefined()
    expect((await getDb().agentTeamRuns.get(seed.runId))?.recoveryReason).toBe("stop_unconfirmed")
    expect(
      (await getDb().executionRunEvents.toArray()).some((event) => event.type === "run.cancelled")
    ).toBe(false)
  })

  it("links a replacement to the run it replaces", async () => {
    const result = await createSquadRunRecords({ ...seed, parentRunId: "execution:team:old" })
    expect(result.executionRun.parentRunId).toBe("execution:team:old")
    expect(result.executionRun.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "child",
      requesters: [],
    })
  })

  it("copies the parent's fixed identity and meets a child's resolved ceiling", async () => {
    const actingIdentity = {
      schemaVersion: 1 as const,
      rootRunId: "execution:team:old",
      lane: "legacy" as const,
      trigger: "requester" as const,
      requesters: [{ kind: "local-person" as const, accountId: "owner" }],
      authorityRevision: 3,
      bindingId: "binding",
    }
    const pools = {
      rootRunId: "execution:team:old",
      tokenBudget: 100,
      costUsd: 2,
      deadlineMs: 5000,
    }
    await getDb().executionRuns.add({
      id: "execution:team:old",
      kind: "team",
      sourceId: "old",
      title: "Parent",
      status: "completed",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
      actingIdentity,
      authority: {
        schemaVersion: 1,
        permissionMode: "default",
        tools: { allow: ["Read", "Write"], deny: ["Bash"] },
        maxTurns: 8,
        pools,
      },
    })
    const result = await createSquadRunRecords({
      ...seed,
      parentRunId: "execution:team:old",
      executionConstraints: {
        version: 1,
        origin: "chat",
        triggeredFrom: { source: "chat" },
        requirePlanApprovalFloor: false,
        permissionCeiling: {
          permissionMode: "plan",
          allowedTools: ["Read", "Bash"],
          disallowedTools: ["Write"],
        },
      },
    })
    expect(result.executionRun.actingIdentity).toEqual(actingIdentity)
    expect(result.executionRun.authority).toEqual({
      schemaVersion: 1,
      permissionMode: "plan",
      tools: { allow: ["Read"], deny: ["Bash", "Write"] },
      maxTurns: 8,
      pools,
    })
  })

  /**
   * Fail closed: when the transaction cannot commit, neither row exists. A
   * caller that gets a throw starts nothing.
   */
  it("leaves nothing behind when the transaction fails", async () => {
    await getDb().executionRuns.add({
      id: "execution:team:run_team_abc",
      kind: "team",
      sourceId: "run_team_abc",
      title: "settled",
      status: "completed",
      currentRevision: 3,
      startedAt: 1,
      updatedAt: 2,
    })
    // The execution row exists and is terminal, so the durable row is created
    // and no event is appended: converge, do not throw.
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(false)
    expect(result.run.status).toBe("completed")

    // Now force a real failure: a broken table write.
    const spy = jest
      .spyOn(getDb().agentTeamRuns, "add")
      .mockRejectedValueOnce(new Error("quota exceeded"))
    await getDb().agentTeamRuns.clear()
    await getDb().executionRuns.clear()
    await getDb().executionRunEvents.clear()
    await expect(createSquadRunRecords(seed)).rejects.toThrow(/quota exceeded/)
    expect(await getDb().executionRuns.count()).toBe(0)
    spy.mockRestore()
  })
})

describe("findLiveSquadRun", () => {
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

  it("returns the newest live run and ignores terminal ones", async () => {
    const base = { teamId: "t", objective: "o", priority: 0, decisionVersion: 0, createdAt: 1 }
    await getDb().agentTeamRuns.bulkAdd([
      { ...base, id: "done", status: "completed", updatedAt: 50 },
      { ...base, id: "old-paused", status: "paused", updatedAt: 10 },
      { ...base, id: "live", status: "running", updatedAt: 20 },
    ])
    expect((await findLiveSquadRun("t"))?.id).toBe("live")
    expect(await findLiveSquadRun("other")).toBeUndefined()
  })
})

describe("squadIdForTeamRun", () => {
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

  it("reads the Squad from the run record", async () => {
    const { executionRun } = await createSquadRunRecords(seed)
    await expect(squadIdForTeamRun(executionRun)).resolves.toBe("team-1")
  })

  it("falls back to the opening event when the record is gone", async () => {
    const { executionRun } = await createSquadRunRecords(seed)
    await getDb().agentTeamRuns.delete(seed.runId)
    await expect(squadIdForTeamRun(executionRun)).resolves.toBe("team-1")
  })

  it("answers undefined for a row that names no Squad", async () => {
    await expect(
      squadIdForTeamRun({ id: "execution:team:nobody", sourceId: "nobody" })
    ).resolves.toBeUndefined()
  })
})
