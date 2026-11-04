/**
 * The durable coordinator against the reference memory store and fake host
 * ports (ADR-0217). The app suite (`durable-runtime.test.ts`) covers the
 * app's bindings: Dexie, the execution-run journal, `@cognia/redact`, the
 * app's path semantics and the fleet session projection.
 */

import {
  createDurableTeamCoordinator,
  isStoredChildStopped,
  type DurableTeamCoordinator,
  type DurableTeamCoordinatorOptions,
  type DurableTeamSpec,
  type TeamPathPolicy,
} from "./coordinator"
import { createMemoryTeamRunStore } from "./memory-store"
import type { TeamRunStore } from "./store"

/** POSIX path semantics: absolute paths only, `..` resolved, never above `/`. */
function normalizePosix(path: string): string {
  if (!path.startsWith("/")) return ""
  const parts: string[] = []
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (parts.length === 0) return ""
      parts.pop()
    } else parts.push(segment)
  }
  return `/${parts.join("/")}`
}

const posixPaths: TeamPathPolicy = {
  normalize: normalizePosix,
  isWithinRoot(target, root) {
    const t = normalizePosix(target)
    const r = normalizePosix(root)
    if (!t || !r) return false
    return r === "/" || t === r || t.startsWith(`${r}/`)
  },
}

const spec = (overrides: Partial<DurableTeamSpec> = {}): DurableTeamSpec => ({
  id: "team-1",
  leadId: "lead-1",
  projectId: "project-1",
  objective: "Ship",
  writeMode: "single-writer",
  repositories: [
    { id: "primary", role: "primary", path: "/repo", writable: true },
    { id: "dep", role: "dependency", path: "/dep", writable: true },
  ],
  resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
  maxConcurrentTeammates: 2,
  ...overrides,
})

describe("durable AgentTeam coordinator", () => {
  let store: TeamRunStore
  const journal = { runPrepared: jest.fn(async () => undefined) }
  const releaseRemoteSession = jest.fn(async (_remoteSessionId: string) => undefined)
  const make = (overrides: Partial<DurableTeamCoordinatorOptions> = {}) =>
    createDurableTeamCoordinator({
      store,
      journal,
      redactForPersistence: (text) => text.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[EMAIL]"),
      paths: posixPaths,
      remoteSessions: { release: releaseRemoteSession },
      localSessions: { isStopped: async (runtime) => (runtime === "claude" ? true : undefined) },
      ...overrides,
    })

  beforeEach(() => {
    store = createMemoryTeamRunStore()
    journal.runPrepared.mockClear()
    releaseRemoteSession.mockClear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const register = async (coordinator: DurableTeamCoordinator, childRunId: string) =>
    coordinator.registerChild({
      runId: "run-admission",
      childRunId,
      teammateId: childRunId,
      taskId: childRunId,
      repositoryId: "primary",
      access: "read",
      runtime: "claude",
    })

  const waitUntil = async (ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (ready()) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("Condition did not settle")
  }

  it("recovers interrupted local execution from its checkpoint in a fresh coordinator", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
    await coordinator.checkpoint("local", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    const detach = coordinator.attachLiveControl("local", { steer: async () => {} })
    // Process loss removes its live handles; the durable checkpoint remains.
    detach()
    const restarted = make()
    await expect(restarted.recover()).resolves.toEqual([
      { runId: "run-admission", status: "recovering" },
    ])
    await expect(restarted.retryChild("local")).resolves.toMatchObject({ status: "queued" })
  })

  it.each(["live", "absent", "unknown", "error"] as const)(
    "uses host liveness after renderer state is lost: %s",
    async (mode) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "local")
      await store.updateChild("local", {
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
        sessionId: "surviving-session",
      })
      await coordinator.checkpoint("local", {
        replay: "safe",
        sideEffects: [],
        trajectorySequence: 0,
      })
      const restarted = make({
        localSessions: {
          isStopped: async (runtime, sessionId) => {
            expect(runtime).toBe("claude")
            expect(sessionId).toBe("surviving-session")
            if (mode === "error") throw new Error("Host unavailable")
            return mode === "unknown" ? undefined : mode === "absent"
          },
        },
      })
      await expect(restarted.recover()).resolves.toEqual([
        { runId: "run-admission", status: mode === "absent" ? "recovering" : "needs_input" },
      ])
      if (mode === "absent")
        await expect(restarted.retryChild("local")).resolves.toMatchObject({ status: "queued" })
      else {
        await expect(restarted.retryChild("local")).rejects.toThrow("stop_unconfirmed")
        await expect(restarted.terminateChild("local")).rejects.toThrow("stop_unconfirmed")
        expect((await store.getChild("local"))?.stop?.state).toBe("unconfirmed")
      }
    }
  )

  it("retains local activity beyond capture rejection until executor evidence arrives", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
    await coordinator.checkpoint("local", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    let stopped!: () => void
    const evidence = new Promise<void>((resolve) => {
      stopped = resolve
    })
    await expect(
      coordinator.trackChildExecution(
        "local",
        async () => {
          throw new Error("capture timeout")
        },
        () => evidence
      )
    ).rejects.toThrow("capture timeout")
    await expect(coordinator.assessTaskRecovery("run-admission", "local")).resolves.toMatchObject({
      eligible: false,
      reason: "stop_unconfirmed",
    })
    stopped()
    await evidence
    await expect(coordinator.assessTaskRecovery("run-admission", "local")).resolves.toEqual({
      eligible: true,
    })
  })

  it.each(["codex", "future-runtime", undefined])(
    "does not infer quiescence for an unqueryable runtime: %s",
    async (runtime) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "unconfirmed")
      await store.updateChild("unconfirmed", {
        runtime,
        status: "running",
        startedAt: 1,
        dispatchEpoch: 1,
      })
      const child = (await store.getChild("unconfirmed"))!
      await expect(isStoredChildStopped(store, child, 100)).resolves.toBe(false)
      await expect(coordinator.terminateChild(child.id)).rejects.toThrow("stop_unconfirmed")
    }
  )

  it.each(["failed", "paused"] as const)(
    "queries the Host for legacy %s children after release cleared sessionId",
    async (status) => {
      const isStopped = jest.fn(async () => false)
      const coordinator = make({ localSessions: { isStopped } })
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "legacy")
      await store.updateChild("legacy", {
        status,
        startedAt: undefined,
        dispatchEpoch: undefined,
        sessionId: undefined,
      })
      await store.appendTrajectory({
        runId: "run-admission",
        childRunId: "legacy",
        kind: "tool_result",
        correlationId: "executed",
        createdAt: 1,
      })
      await coordinator.checkpoint("legacy", {
        replay: "safe",
        sideEffects: [],
        trajectorySequence: 1,
      })
      await expect(coordinator.recover()).resolves.toEqual([
        expect.objectContaining({ status: "needs_input" }),
      ])
      expect(isStopped).toHaveBeenCalled()
      await expect(coordinator.terminateChild("legacy")).rejects.toThrow("stop_unconfirmed")
      expect((await store.getChild("legacy"))?.stop?.state).toBe("unconfirmed")
    }
  )

  it("requires disposal even for completed legacy rows without startup metadata", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "legacy-completed")
    await store.updateChild("legacy-completed", { status: "completed" })
    const child = (await store.getChild("legacy-completed"))!
    await expect(isStoredChildStopped(store, child, 100)).resolves.toBe(false)
    await expect(coordinator.assessTaskRecovery(child.runId, child.taskId)).resolves.toMatchObject({
      eligible: false,
      reason: "stop_unconfirmed",
    })
    for (let read = 0; read < 2; read++) {
      await coordinator.recover()
      await expect(coordinator.retryChild(child.id)).rejects.toThrow(
        "cannot be retried from completed"
      )
      await expect(
        coordinator.assessTaskRecovery(child.runId, child.taskId)
      ).resolves.toMatchObject({
        eligible: false,
        reason: "stop_unconfirmed",
      })
    }
  })

  it("does not convert an unproved completed turn into a stopped child via fence expiry", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "completed-fence")
    await store.updateChild("completed-fence", {
      status: "completed",
      dispatchEpoch: 1,
      remoteDispatchEpoch: 1,
      startedAt: 1,
      fenceCapable: true,
      lastRenewalSentAt: 1,
      leaseTtlMs: 1,
      fenceGraceMs: 0,
    })
    await store.updateRun("run-admission", {
      stop: { state: "requested", action: "stop", epoch: 1, requestedAt: 2 },
    })
    await coordinator.recover()
    expect((await store.getChild("completed-fence"))?.status).toBe("completed")
    expect((await store.getRun("run-admission"))?.stop?.state).toBe("unconfirmed")
    await expect(
      coordinator.assessTaskRecovery("run-admission", "completed-fence")
    ).resolves.toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
  })

  it("does not infer stop from lost process activity after a capture reported unconfirmed", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", {
      startedAt: 1,
      dispatchEpoch: 1,
      status: "needs_input",
      stop: { state: "unconfirmed", epoch: 1, requestedAt: 2 },
    })
    await coordinator.checkpoint("local", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    await store.updateRun("run-admission", {
      stop: { state: "requested", action: "stop", epoch: 1, requestedAt: 2 },
    })
    const restarted = make({ localSessions: { isStopped: async () => undefined } })
    await expect(restarted.recover()).resolves.toEqual([
      { runId: "run-admission", status: "needs_input" },
    ])
    await expect(restarted.terminateChild("local")).rejects.toThrow("stop_unconfirmed")
    expect((await store.getChild("local"))?.stop).toMatchObject({ state: "unconfirmed" })
    expect((await store.getChild("local"))?.stop?.proof).toBeUndefined()
  })

  it("does not mistake another coordinator's live local execution for process loss", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
    await coordinator.checkpoint("local", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    const detach = coordinator.attachLiveControl("local", { steer: async () => {} })
    const second = make()
    await expect(second.recover()).resolves.toEqual([
      { runId: "run-admission", status: "needs_input" },
    ])
    detach()
  })

  it.each(["requested", "unconfirmed"] as const)(
    "reconciles a persisted %s stop instead of resuming it",
    async (state) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "local")
      await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
      await store.updateRun("run-admission", {
        stop: { state, action: "terminate", epoch: 1, requestedAt: 2 },
      })
      await expect(make().recover()).resolves.toEqual([
        { runId: "run-admission", status: "terminated" },
      ])
      expect(await store.getRun("run-admission")).toMatchObject({
        status: "terminated",
        stop: { state: "confirmed" },
      })
      expect((await store.getRun("run-admission"))?.stop?.proof).toBeUndefined()
    }
  )

  it("retains a startup remote stop without worker proof as needs_input", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "remote")
    await store.claimDispatchLease({
      childRunId: "remote",
      leaseId: "remote-lease",
      hostRef: "host-a",
      now: 1,
    })
    await store.updateRun("run-admission", {
      stop: { state: "requested", epoch: 1, requestedAt: 2 },
    })
    await expect(make().recover()).resolves.toEqual([
      { runId: "run-admission", status: "needs_input" },
    ])
    expect(await store.getRun("run-admission")).toMatchObject({
      recoveryReason: "stop_unconfirmed",
      stop: { state: "unconfirmed" },
    })
  })

  it.each(["requested", "unconfirmed"] as const)(
    "does not clear a %s run stop barrier while a different task is unconfirmed",
    async (state) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "local")
      await store.updateChild("local", { startedAt: 1, status: "failed" })
      await coordinator.checkpoint("local", {
        replay: "safe",
        sideEffects: [],
        trajectorySequence: 0,
      })
      await register(coordinator, "remote")
      await store.claimDispatchLease({
        childRunId: "remote",
        leaseId: "remote-lease",
        hostRef: "host-a",
        now: 1,
      })
      await store.updateRun("run-admission", {
        status: "running",
        stop: { state, epoch: 1, requestedAt: 2 },
      })
      await expect(coordinator.retryChild("local")).rejects.toThrow("stop_unconfirmed")
      expect(await store.getRun("run-admission")).toMatchObject({
        status: "needs_input",
        recoveryReason: "stop_unconfirmed",
        stop: { state: "unconfirmed" },
      })
    }
  )

  it("times out a local void terminate while the real execution remains pending", async () => {
    const coordinator = make({ localStopTimeoutMs: 5 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
    let release!: () => void
    const pending = coordinator.trackChildExecution(
      "local",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    coordinator.attachLiveControl("local", { steer: async () => {}, terminate: async () => {} })
    await expect(coordinator.terminateChild("local")).rejects.toThrow("stop_unconfirmed")
    expect((await store.getChild("local"))?.stop?.state).toBe("unconfirmed")
    release()
    await pending
  })

  it("does not confirm a concurrent terminate when only the execution wrapper rejects", async () => {
    const coordinator = make({ localSessions: { isStopped: async () => false } })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    await store.updateChild("local", { startedAt: 1, dispatchEpoch: 1 })
    let fail!: () => void
    const execution = coordinator.trackChildExecution(
      "local",
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error("transport lost"))
        })
    )
    const observed = execution.catch(() => undefined)
    coordinator.attachLiveControl("local", {
      steer: async () => {},
      terminate: async () => {
        fail()
      },
    })
    await expect(coordinator.terminateChild("local")).rejects.toThrow("stop_unconfirmed")
    await observed
    expect(await store.getChild("local")).toMatchObject({
      status: "needs_input",
      stop: { state: "unconfirmed", epoch: 1 },
    })
  })

  it("stops the started epoch when executor start commits after terminate's initial read", async () => {
    const coordinator = make({ localSessions: { isStopped: async () => false } })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "local")
    const getChild = store.getChild.bind(store)
    jest.spyOn(store, "getChild").mockImplementationOnce(async (id) => {
      const beforeStart = await getChild(id)
      await store.atomically(async (tx) => {
        await tx.updateChild(id, { startedAt: 1, dispatchEpoch: 1 })
      })
      return beforeStart
    })
    await expect(coordinator.terminateChild("local")).rejects.toThrow("stop_unconfirmed")
    expect(await store.getChild("local")).toMatchObject({
      dispatchEpoch: 1,
      status: "needs_input",
      stop: { state: "unconfirmed", epoch: 1 },
    })
    expect((await store.getChild("local"))?.settledEpoch).toBeUndefined()
  })

  // Remote fixtures model worker acknowledgement; local fixtures rely on process truth.
  const proveStopped = async (coordinator: ReturnType<typeof make>, childId: string) => {
    const child = (await store.getChild(childId))!
    const epoch = child.dispatchEpoch ?? 0
    if (child.remoteSessionId || child.dispatchLeaseId || child.remoteDispatchEpoch !== undefined)
      await store.updateChild(childId, {
        stop: { state: "confirmed", epoch, requestedAt: 1, proof: { kind: "ack", epoch, at: 2 } },
      })
    await coordinator.checkpoint(childId, {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: child.lastTrajectorySequence ?? 0,
    })
  }

  it.each(["retryChild", "resumeChild", "wakeChild", "beginTakeover", "completeTakeover"] as const)(
    "%s applies the task gate even when a different teammate has the unconfirmed child",
    async (entry) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "child")
      await proveStopped(coordinator, "child")
      coordinator.attachLiveControl("child", { steer: jest.fn(), pause: async () => true })
      const child = (await store.getChild("child"))!
      await store.createChild({
        ...child,
        id: "other",
        teammateId: "other",
        dispatchEpoch: 1,
        remoteDispatchEpoch: 1,
        stop: undefined,
        status: "failed",
      })
      if (entry === "wakeChild") await store.updateChild("child", { status: "sleeping" })
      const operation =
        entry === "completeTakeover"
          ? () => coordinator.completeTakeover({ childRunId: "child" })
          : () => coordinator[entry]("child")
      await expect(operation()).rejects.toThrow("stop_unconfirmed")
      expect((await store.getRun("run-admission"))?.recoveryReason).toBe("stop_unconfirmed")
    }
  )

  it("records a missing takeover handle as pause unconfirmed", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await expect(coordinator.beginTakeover("child")).rejects.toThrow("stop_unconfirmed")
    expect(await store.getChild("child")).toMatchObject({
      status: "needs_input",
      waitingReason: "pause_unconfirmed",
    })
    expect(
      (await store.listTrajectory("run-admission")).some(
        (event) => event.kind === "manual_takeover_started"
      )
    ).toBe(false)
  })

  it("requires proof for failed or cancelled history even if its status looks terminal", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      await register(coordinator, status)
      await store.updateChild(status, { status, startedAt: 1, remoteDispatchEpoch: 1 })
    }
    const recovered = await coordinator.recover()
    expect(recovered).toEqual([{ runId: "run-admission", status: "needs_input" }])
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      expect((await store.getChild(status))?.status).toBe(
        status === "completed" ? "completed" : "needs_input"
      )
    }
  })

  it("gates remote events persisted after the latest safe checkpoint", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "remote")
    await coordinator.checkpoint("remote", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await store.appendTrajectory({
      runId: "run-admission",
      childRunId: "remote",
      kind: "remote_event",
      correlationId: "event-after-checkpoint",
      createdAt: Date.now(),
    })
    expect(await coordinator.recover()).toEqual([{ runId: "run-admission", status: "needs_input" }])
    expect((await store.getChild("remote"))?.status).toBe("needs_input")
  })

  it("does not recover a run terminated after the recovery scan", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    const list = store.listRecoveryCandidates
    jest.spyOn(store, "listRecoveryCandidates").mockImplementationOnce(async () => {
      const candidates = await list()
      await store.updateRun("run-admission", { status: "terminated" })
      return candidates
    })
    expect(await coordinator.recover()).toEqual([])
    expect((await store.getRun("run-admission"))?.status).toBe("terminated")
    expect((await store.getChild("child"))?.status).toBe("running")
  })

  it("does not replace a terminated run with the budget input gate", async () => {
    const coordinator = make()
    await coordinator.prepareRun(
      spec({
        resourcePolicy: { priority: 0, maxConcurrentChildren: 1, maxTokens: 0 },
      }),
      "run-admission"
    )
    await register(coordinator, "child")
    const getRun = store.getRun
    jest.spyOn(store, "getRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await store.updateRun(id, { status: "terminated" })
      return run
    })
    const operation = jest.fn()
    await expect(coordinator.withChildAdmission("child", operation)).rejects.toThrow("budget")
    expect((await store.getRun("run-admission"))?.status).toBe("terminated")
    expect((await store.getChild("child"))?.status).toBe("running")
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("does not start a queued run cancelled while preparation reads it", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await store.updateRun("run-admission", { status: "queued" })
    const getRun = store.getRun
    jest.spyOn(store, "getRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await store.updateRun(id, { status: "cancelled" })
      return run
    })
    await expect(coordinator.prepareRun(spec(), "run-admission")).rejects.toThrow("changed")
    expect((await store.getRun("run-admission"))?.status).toBe("cancelled")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "does not revive a %s child through sleep or wake",
    async (status) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "child")
      await store.updateChild("child", { status })
      const resume = jest.fn(async () => undefined)
      coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
      await coordinator.sleepChild("child")
      await coordinator.wakeChild("child")
      expect((await store.getChild("child"))?.status).toBe(status)
      expect(resume).not.toHaveBeenCalled()
    }
  )

  it("does not revive a child that terminates while wake waits for the provider", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await proveStopped(coordinator, "child")
    await coordinator.sleepChild("child")
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resume: async () => {
        await store.updateChild("child", { status: "terminated" })
      },
    })
    await coordinator.wakeChild("child")
    expect((await store.getChild("child"))?.status).toBe("terminated")
  })

  it("rejects remote resume and cross-host migration after uncheckpointed remote work", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await store.updateChild("child", {
      hostRef: "device:a",
      remoteSessionId: "remote-session",
      status: "paused",
    })
    await coordinator.checkpoint("child", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await store.appendTrajectory({
      runId: "run-admission",
      childRunId: "child",
      kind: "remote_event",
      correlationId: "uncheckpointed-command",
      createdAt: Date.now(),
    })
    await expect(coordinator.resumeChild("child")).rejects.toThrow("safe checkpoint")
    await expect(coordinator.retryChild("child", "device:b")).rejects.toThrow("safe checkpoint")
    expect((await store.getChild("child"))?.status).toBe("needs_input")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "refuses child retry for a %s parent",
    async (status) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "child")
      await store.updateChild("child", { status: "failed" })
      await store.updateRun("run-admission", { status })
      await expect(coordinator.retryChild("child")).rejects.toThrow("cannot be retried")
      expect((await store.getRun("run-admission"))?.status).toBe(status)
    }
  )

  it("rejects duplicate admission for the same child while the first holds capacity", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "already has an admission"
    )
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    release()
    await first
  })

  it("cancels admission parked on a paused run", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    coordinator.setRunPaused("run-admission", true)
    const controller = new AbortController()
    const operation = jest.fn()
    const waiting = coordinator.withChildAdmission("first", operation, controller.signal)
    const rejected = expect(waiting).rejects.toThrow("cancel parked")
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error("cancel parked"))
    await rejected
    coordinator.setRunPaused("run-admission", false)
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it.each(["terminateChild", "pauseChild"] as const)(
    "does not execute queued work after %s",
    async (action) => {
      const coordinator = make({ globalConcurrency: 1 })
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "first")
      await register(coordinator, "second")
      let release!: () => void
      const first = coordinator.withChildAdmission(
        "first",
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      const operation = jest.fn()
      const second = coordinator.withChildAdmission("second", operation)
      const rejected = expect(second).rejects.toThrow()
      await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
      coordinator.attachLiveControl("second", {
        steer: jest.fn(),
        pause: async () => true,
        terminate: async () => ({ kind: "ack", epoch: 0, at: 1 }),
      })
      await coordinator[action]("second")
      release()
      await first
      await rejected
      expect(operation).not.toHaveBeenCalled()
      expect((await store.getChild("second"))?.status).toBe(
        action === "terminateChild" ? "terminated" : "paused"
      )
      expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
    }
  )

  it("releases admission when the running-state write fails", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    const update = store.updateChildIfCurrent
    jest.spyOn(store, "updateChildIfCurrent").mockImplementation(async (id, expected, patch) => {
      if (patch.status === "running") throw new Error("injected store failure")
      return update(id, expected, patch)
    })
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "injected store failure"
    )
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels queued admission without waiting for the active child", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const second = coordinator.withChildAdmission("second", jest.fn(), controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel queued")
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    controller.abort(new Error("cancel queued"))
    await rejected
    expect(coordinator.schedulerSnapshot().queued).toHaveLength(0)
    release()
    await first
  })

  it("retains active capacity until cancelled work settles and rejects its late result", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const controller = new AbortController()
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("late success")
        }),
      controller.signal
    )
    const rejected = expect(first).rejects.toThrow("cancel active")
    await waitUntil(() => !!release)
    controller.abort(new Error("cancel active"))
    const operation = jest.fn()
    const second = coordinator.withChildAdmission("second", operation)
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    expect(operation).not.toHaveBeenCalled()
    release()
    await Promise.all([rejected, second])
    expect(operation).toHaveBeenCalledTimes(1)
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels a writer wait without releasing the preceding writer lease", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    const request = { runId: "run-admission", repositoryId: "primary", access: "write" as const }
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      request,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const skipped = jest.fn()
    const second = coordinator.withWorkspaceLease(request, skipped, controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel writer")
    const thirdOperation = jest.fn()
    const third = coordinator.withWorkspaceLease(request, thirdOperation)
    controller.abort(new Error("cancel writer"))
    await rejected
    expect(skipped).not.toHaveBeenCalled()
    expect(thirdOperation).not.toHaveBeenCalled()
    release()
    await Promise.all([first, third])
    expect(thirdOperation).toHaveBeenCalledTimes(1)
  })

  it.each(["mutation", "alias", "root"])(
    "keeps isolated writer ownership exclusive across %s",
    async (scenario) => {
      const coordinator = make()
      await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "run-admission")
      const ownership = [
        scenario === "alias" ? "src/../shared" : scenario === "root" ? "." : "shared",
      ]
      const request = {
        runId: "run-admission",
        repositoryId: "primary",
        access: "write" as const,
        fileOwnership: ownership,
      }
      let release!: () => void
      const active = coordinator.withWorkspaceLease(
        request,
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      if (scenario === "mutation") ownership[0] = "unrelated"
      const operation = jest.fn()
      try {
        await expect(
          coordinator.withWorkspaceLease(
            { ...request, fileOwnership: ["shared/file.ts"] },
            operation
          )
        ).rejects.toThrow("overlaps")
        expect(operation).not.toHaveBeenCalled()
      } finally {
        release()
        await active
      }
      await coordinator.withWorkspaceLease(
        { ...request, fileOwnership: ["shared/file.ts"] },
        operation
      )
      expect(operation).toHaveBeenCalledTimes(1)
    }
  )

  it("coalesces concurrent wake requests into one provider resume", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await proveStopped(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    const resumed = new Promise<void>((resolve) => {
      release = resolve
    })
    const resume = jest.fn(() => resumed)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    const first = coordinator.wakeChild("child")
    const second = coordinator.wakeChild("child")
    await waitUntil(() => resume.mock.calls.length > 0)
    release()
    await Promise.all([first, second])
    expect(resume).toHaveBeenCalledTimes(1)
    await coordinator.wakeChild("child")
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it("reuses the remote checkpoint gate when waking a sleeping child", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await store.updateChild("child", { remoteSessionId: "remote" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("safe checkpoint")
    expect(resume).not.toHaveBeenCalled()
    expect(await store.getChild("child")).toMatchObject({ status: "needs_input" })
    await proveStopped(coordinator, "child")
    await store.updateChild("child", { status: "sleeping" })
    await coordinator.checkpoint("child", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 1,
    })
    await coordinator.wakeChild("child")
    expect(await store.getChild("child")).toMatchObject({ status: "queued" })
  })

  it("does not wake a sleeping child after its parent terminates", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await store.updateRun("run-admission", { status: "terminated" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("run stopped")
    expect(resume).not.toHaveBeenCalled()
  })

  it("keeps a newer pause when a resource-only wake finishes later", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await proveStopped(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resumeStartsExecution: false,
      resume: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      pause: async () => true,
    })
    const wake = coordinator.wakeChild("child")
    await waitUntil(() => !!release)
    await coordinator.pauseChild("child")
    release()
    await wake
    expect(await store.getChild("child")).toMatchObject({ status: "paused" })
  })

  it("rejects ambiguous repository topology before creating a run", async () => {
    const coordinator = make({ now: () => 100 })
    const invalid = spec({
      repositories: [
        { id: "one", role: "primary", path: "/one", writable: true },
        { id: "two", role: "primary", path: "/two", writable: true },
      ],
    })

    await expect(coordinator.prepareRun(invalid, "run-invalid")).rejects.toThrow(
      /exactly one primary repository/
    )
    expect(await store.listRuns()).toEqual([])
  })

  it("snapshots configured operator constraints into the immutable run ledger", async () => {
    const coordinator = make({ now: () => 90 })
    await coordinator.prepareRun(
      spec({
        userConstraints: [{ title: "Compatibility", detail: "Do not break the public API" }],
      }),
      "run-constraints"
    )

    expect(await store.listDecisions("run-constraints")).toEqual([
      expect.objectContaining({
        status: "constraint",
        immutable: true,
        title: "Compatibility",
        detail: "Do not break the public API",
      }),
    ])
    expect(journal.runPrepared).toHaveBeenCalledWith({
      runId: "run-constraints",
      projectId: "project-1",
      title: "Ship",
      at: 90,
    })
  })

  it("serializes writers while allowing read-only work to proceed", async () => {
    const coordinator = make({ now: () => 100 })
    await coordinator.prepareRun(spec(), "run-1")
    const order: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => {
        order.push("writer-1:start")
        await firstBlocked
        order.push("writer-1:end")
      }
    )
    const second = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => order.push("writer-2")
    )
    const reader = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "read" },
      async () => order.push("reader")
    )

    await reader
    expect(order).toEqual(["writer-1:start", "reader"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["writer-1:start", "reader", "writer-1:end", "writer-2"])
  })

  it("runs independent candidate workspaces concurrently without disjoint file ownership", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    for (const id of ["one", "two"]) {
      await coordinator.registerChild({
        runId: "run-admission",
        childRunId: id,
        teammateId: id,
        taskId: id,
        repositoryId: "primary",
        access: "write",
        workspacePath: `/candidates/${id}`,
      })
    }
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      { runId: "run-admission", repositoryId: "primary", access: "write", childRunId: "one" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const operation = jest.fn()
    await coordinator.withWorkspaceLease(
      { runId: "run-admission", repositoryId: "primary", access: "write", childRunId: "two" },
      operation
    )
    expect(operation).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it("serializes canonical workspace aliases across different runs and repository ids", async () => {
    const canonicalize = jest.fn(async () => "/physical")
    const coordinator = make({ paths: { ...posixPaths, canonicalize } })
    await coordinator.prepareRun(spec(), "one")
    await coordinator.prepareRun(
      spec({
        repositories: [{ id: "alias", role: "primary", path: "/symlink", writable: true }],
      }),
      "two"
    )
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      { runId: "one", repositoryId: "primary", access: "write" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const operation = jest.fn()
    const second = coordinator.withWorkspaceLease(
      { runId: "two", repositoryId: "alias", access: "write" },
      operation
    )
    await waitUntil(() => canonicalize.mock.calls.length === 2)
    expect(operation).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(operation).toHaveBeenCalledTimes(1)
    expect(canonicalize.mock.calls).toEqual([["/repo"], ["/symlink"]])
  })

  it("keeps legacy isolated disjoint ownership and exclusive writer modes mutually safe", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "isolated")
    await coordinator.prepareRun(spec(), "exclusive")
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      { runId: "isolated", repositoryId: "primary", access: "write", fileOwnership: ["src/a"] },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const disjoint = jest.fn()
    await coordinator.withWorkspaceLease(
      { runId: "isolated", repositoryId: "primary", access: "write", fileOwnership: ["src/b"] },
      disjoint
    )
    expect(disjoint).toHaveBeenCalledTimes(1)
    const exclusive = jest.fn()
    const waiting = coordinator.withWorkspaceLease(
      { runId: "exclusive", repositoryId: "primary", access: "write" },
      exclusive
    )
    expect(exclusive).not.toHaveBeenCalled()
    await expect(
      coordinator.withWorkspaceLease(
        { runId: "isolated", repositoryId: "primary", access: "write", fileOwnership: ["src/c"] },
        jest.fn()
      )
    ).rejects.toThrow("overlaps")
    release()
    await Promise.all([first, waiting])
    expect(exclusive).toHaveBeenCalledTimes(1)
  })

  it("compares absolute alias ownership against relative claims on the canonical root", async () => {
    const coordinator = make({ paths: { ...posixPaths, canonicalize: async () => "/physical" } })
    await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "isolated")
    let release!: () => void
    const request = { runId: "isolated", repositoryId: "primary", access: "write" as const }
    const first = coordinator.withWorkspaceLease(
      { ...request, fileOwnership: ["/repo/src"] },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    await expect(
      coordinator.withWorkspaceLease({ ...request, fileOwnership: ["src/file.ts"] }, jest.fn())
    ).rejects.toThrow("overlaps")
    release()
    await first
  })

  it("rejects invalid Host canonical roots and mismatched durable child identities", async () => {
    const coordinator = make({ paths: { ...posixPaths, canonicalize: async () => "" } })
    await coordinator.prepareRun(spec(), "run-admission")
    const operation = jest.fn()
    const request = { runId: "run-admission", repositoryId: "primary", access: "write" as const }
    await expect(coordinator.withWorkspaceLease(request, operation)).rejects.toThrow("canonical")
    await register(coordinator, "one")
    await expect(
      coordinator.withWorkspaceLease(
        { ...request, repositoryId: "dep", childRunId: "one" },
        operation
      )
    ).rejects.toThrow("does not match")
    expect(operation).not.toHaveBeenCalled()
  })

  it("delivers live steering and queues a durable fallback when live control fails", async () => {
    const coordinator = make({ now: () => 200 })
    await coordinator.prepareRun(spec(), "run-2")
    await coordinator.registerChild({
      runId: "run-2",
      childRunId: "child-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-1", { steer })

    const delivered = await coordinator.steer("child-1", "Check tests")
    expect(delivered.status).toBe("delivered")
    expect(steer).toHaveBeenCalledWith("Check tests", delivered.id)

    coordinator.attachLiveControl("child-1", {
      steer: async () => {
        throw new Error("no active turn")
      },
    })
    const queued = await coordinator.steer("child-1", "Inspect migration")
    expect(queued.status).toBe("queued")
    expect(
      (await store.listSteeringReceipts("run-2")).filter((row) => row.status === "queued")
    ).toHaveLength(1)
  })

  it("sends the PII-gated steering payload to the live runtime", async () => {
    const coordinator = make({ now: () => 225 })
    await coordinator.prepareRun(spec(), "run-redacted-steer")
    await coordinator.registerChild({
      runId: "run-redacted-steer",
      childRunId: "child-redacted-steer",
      teammateId: "mate-1",
      taskId: "task-redacted-steer",
      repositoryId: "primary",
      access: "read",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-redacted-steer", { steer })

    const receipt = await coordinator.steer(
      "child-redacted-steer",
      "Contact operator@example.com before continuing"
    )

    expect(receipt.message).toBe("Contact [EMAIL] before continuing")
    expect(steer).toHaveBeenCalledWith(receipt.message, receipt.id)
  })

  it("refuses steering and takeover text the host's redactor will not clear", async () => {
    const coordinator = make({ now: () => 230, redactForPersistence: () => undefined })
    await coordinator.prepareRun(spec(), "run-refused")
    await coordinator.registerChild({
      runId: "run-refused",
      childRunId: "child-refused",
      teammateId: "mate-1",
      taskId: "task-refused",
      repositoryId: "primary",
      access: "read",
    })
    await proveStopped(coordinator, "child-refused")
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-refused", { steer })
    await expect(coordinator.steer("child-refused", "anything")).rejects.toThrow(/PII/)
    expect(steer).not.toHaveBeenCalled()
    expect(await store.listSteeringReceipts("run-refused")).toEqual([])
    await expect(
      coordinator.completeTakeover({ childRunId: "child-refused", commands: ["ls"] })
    ).rejects.toThrow(/PII redaction/)
    expect(await store.listEvidence("run-refused")).toEqual([])
  })

  it("rejects isolated ownership that escapes the repository before execution", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "run-admission")
    for (const path of ["", "../outside", "/outside", "src\0file"]) {
      const operation = jest.fn()
      await expect(
        coordinator.withWorkspaceLease(
          {
            runId: "run-admission",
            repositoryId: "primary",
            access: "write",
            fileOwnership: [path],
          },
          operation
        )
      ).rejects.toThrow(/ownership/)
      expect(operation).not.toHaveBeenCalled()
    }
  })

  it("forwards pause, resume, and terminate requests to the active provider control", async () => {
    const coordinator = make({ now: () => 250 })
    await coordinator.prepareRun(spec(), "run-control")
    await coordinator.registerChild({
      runId: "run-control",
      childRunId: "child-control",
      teammateId: "mate-1",
      taskId: "task-control",
      repositoryId: "primary",
      access: "write",
    })
    const pause = jest.fn(async () => undefined)
    const resume = jest.fn(async () => undefined)
    const terminate = jest.fn(async () => ({
      kind: "ack" as const,
      epoch: (await store.getChild("child-control"))!.dispatchEpoch ?? 0,
      at: 250,
    }))
    coordinator.attachLiveControl("child-control", {
      steer: async () => undefined,
      pause,
      resume,
      terminate,
    })

    await coordinator.pauseChild("child-control")
    await proveStopped(coordinator, "child-control")
    await coordinator.resumeChild("child-control")
    await store.updateChild("child-control", {
      remoteSessionId: "remote-control",
      stop: undefined,
    })
    await coordinator.terminateChild("child-control")

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(releaseRemoteSession).toHaveBeenCalledWith("remote-control")
    expect((await store.getChild("child-control"))?.status).toBe("terminated")
  })

  it("recovers safe checkpoints and gates uncertain side effects", async () => {
    const coordinator = make({ now: () => 300 })
    await coordinator.prepareRun(spec(), "run-safe")
    await coordinator.registerChild({
      runId: "run-safe",
      childRunId: "child-safe",
      teammateId: "mate-1",
      taskId: "task-safe",
      repositoryId: "primary",
      access: "write",
    })
    await coordinator.checkpoint("child-safe", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })

    await coordinator.prepareRun(spec(), "run-uncertain")
    await coordinator.registerChild({
      runId: "run-uncertain",
      childRunId: "child-uncertain",
      teammateId: "mate-1",
      taskId: "task-uncertain",
      repositoryId: "primary",
      access: "write",
    })
    await store.updateChild("child-uncertain", { startedAt: 1 })
    await coordinator.checkpoint("child-uncertain", {
      replay: "needs_input",
      trajectorySequence: 0,
      sideEffects: [{ id: "publish", kind: "github_pr", state: "unknown", replay: "unknown" }],
    })

    await proveStopped(coordinator, "child-safe")
    const recovered = await coordinator.recover()
    expect(recovered).toEqual(
      expect.arrayContaining([
        { runId: "run-safe", status: "recovering" },
        { runId: "run-uncertain", status: "needs_input" },
      ])
    )
  })

  it("requires stop proof and a safe checkpoint for same-host and cross-host retry", async () => {
    let now = 500
    const coordinator = make({ now: () => now })
    await coordinator.prepareRun(spec(), "run-retry")
    await coordinator.registerChild({
      runId: "run-retry",
      childRunId: "child-retry",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    await store.updateChild("child-retry", {
      hostRef: "device:a",
      status: "needs_input",
      dispatchLeaseId: "dispatch:old-attempt",
      dispatchLeaseExpiresAt: 60_000,
    })

    await expect(coordinator.retryChild("child-retry", "device:b")).rejects.toThrow(
      "stop_unconfirmed"
    )
    await expect(coordinator.retryChild("child-retry", "device:a")).rejects.toThrow(
      "stop_unconfirmed"
    )
    now = 550
    await proveStopped(coordinator, "child-retry")
    const sameHost = await coordinator.retryChild("child-retry", "device:a")
    expect(sameHost).toMatchObject({ status: "queued", waitingReason: "retry_host:device:a" })
    expect(sameHost.dispatchLeaseId).toBeUndefined()
    expect(sameHost.dispatchLeaseExpiresAt).toBeUndefined()
    const migrated = await coordinator.retryChild("child-retry", "device:b")
    expect(migrated.waitingReason).toBe("retry_host:device:b")
    expect((await store.getRun("run-retry"))?.status).toBe("recovering")
  })

  it("requeues a remote child from a safe checkpoint without reopening its old session", async () => {
    const coordinator = make({ now: () => 1_000 })
    await coordinator.prepareRun(spec(), "run-remote-resume")
    await coordinator.registerChild({
      runId: "run-remote-resume",
      childRunId: "child-remote-resume",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    await store.updateChild("child-remote-resume", {
      remoteSessionId: "remote-session-1",
      attempt: 1,
    })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-remote-resume", {
      steer: jest.fn(async () => undefined),
      resume,
    })

    await expect(coordinator.resumeChild("child-remote-resume")).rejects.toThrow("safe checkpoint")
    await coordinator.checkpoint("child-remote-resume", {
      trajectorySequence: 0,
      replay: "safe",
      sideEffects: [],
    })
    await proveStopped(coordinator, "child-remote-resume")
    await coordinator.resumeChild("child-remote-resume")

    expect(resume).not.toHaveBeenCalled()
    expect(await store.getChild("child-remote-resume")).toMatchObject({
      status: "queued",
      attempt: 1,
    })
    expect((await store.getChild("child-remote-resume"))?.remoteSessionId).toBeUndefined()
  })

  it("does not overwrite a terminal child that settles while pause waits for idle", async () => {
    const coordinator = make({ now: () => 1_100 })
    await coordinator.prepareRun(spec(), "run-pause-race")
    await coordinator.registerChild({
      runId: "run-pause-race",
      childRunId: "child-pause-race",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-race", {
      steer: jest.fn(async () => undefined),
      pause: async () => {
        await store.updateChild("child-pause-race", { status: "completed" })
        return true
      },
    })

    await coordinator.pauseChild("child-pause-race")
    expect((await store.getChild("child-pause-race"))?.status).toBe("completed")
  })

  it("routes an unsafe cooperative pause to needs_input", async () => {
    const coordinator = make({ now: () => 1_200 })
    await coordinator.prepareRun(spec(), "run-pause-unsafe")
    await coordinator.registerChild({
      runId: "run-pause-unsafe",
      childRunId: "child-pause-unsafe",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-unsafe", {
      steer: jest.fn(async () => undefined),
      pause: jest.fn(async () => false),
    })

    await coordinator.pauseChild("child-pause-unsafe")
    expect((await store.getChild("child-pause-unsafe"))?.status).toBe("needs_input")
  })

  it("blocks new child admission while a cooperative pause waits for idle", async () => {
    const coordinator = make({ now: () => 1_300 })
    await coordinator.prepareRun(spec(), "run-pause-admission")
    await coordinator.registerChild({
      runId: "run-pause-admission",
      childRunId: "child-pause-admission",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    let releasePause!: () => void
    coordinator.attachLiveControl("child-pause-admission", {
      steer: jest.fn(async () => undefined),
      pause: () => new Promise<boolean>((resolve) => (releasePause = () => resolve(true))),
    })

    const pausing = coordinator.pauseChild("child-pause-admission")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await store.getChild("child-pause-admission"))?.status).toBe("pausing")
    await expect(
      coordinator.withChildAdmission("child-pause-admission", async () => undefined)
    ).rejects.toThrow("not accepting new turns")
    releasePause()
    await pausing
    expect((await store.getChild("child-pause-admission"))?.status).toBe("paused")
  })

  it("falls back to the working directory as the only writable primary repository", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec({ repositories: [], workingDir: "/work" }), "run-workdir")
    await expect(
      coordinator.registerChild({
        runId: "run-workdir",
        childRunId: "child",
        teammateId: "mate-1",
        taskId: "task-1",
        repositoryId: "primary",
        access: "write",
      })
    ).resolves.toMatchObject({ repositoryId: "primary" })
    await expect(
      make().prepareRun(spec({ repositories: [], workingDir: undefined }), "run-none")
    ).rejects.toThrow(/exactly one primary repository/)
  })

  it("completes a manual takeover with redacted evidence, a safe checkpoint and a resume", async () => {
    const coordinator = make({ now: () => 1_400 })
    await coordinator.prepareRun(spec(), "run-takeover")
    await coordinator.registerChild({
      runId: "run-takeover",
      childRunId: "child-takeover",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    await proveStopped(coordinator, "child-takeover")
    const pause = jest.fn(async () => true)
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-takeover", { steer: jest.fn(), pause, resume })

    const taken = await coordinator.beginTakeover("child-takeover")
    expect(taken.status).toBe("paused")
    await coordinator.completeTakeover({
      childRunId: "child-takeover",
      commands: ["notify ops@example.com"],
      diffContent: "diff --git a/x b/x",
      workspaceCommit: "abc123",
    })

    const evidence = await store.listEvidence("run-takeover", { childRunId: "child-takeover" })
    expect(evidence.map((item) => item.kind)).toEqual(["command", "diff", "commit"])
    const command = await store.getContent(evidence[0].contentHash!)
    expect(new TextDecoder().decode(command?.data)).toBe("notify [EMAIL]")
    expect(await store.getLatestCheckpoint("child-takeover")).toMatchObject({
      replay: "safe",
      workspaceCommit: "abc123",
    })
    expect((await store.listTrajectory("run-takeover")).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["manual_takeover_started", "manual_takeover_completed"])
    )
    expect(resume).toHaveBeenCalledTimes(1)
    expect((await store.getChild("child-takeover"))?.status).toBe("running")
  })
})
