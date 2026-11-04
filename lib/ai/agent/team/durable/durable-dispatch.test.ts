import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import { createLocalTauriExecutionEnvironment } from "../../execution/local-tauri-environment"
import { createDurableTeamCoordinator } from "./durable-runtime"
import { beginDurableDispatch } from "./durable-dispatch"
import { createDecisionLedger } from "@cognia/agent-orchestration/decision-ledger"
import * as runtimeDb from "@/lib/db/agent-team-runtime"
import { createMemoryTeamRunStore } from "@cognia/agent-orchestration/memory-store"
import type { AgentTeamExecutionConstraints } from "@/types/agent/agent-team-runtime"
const mockLiveSidecarSessions = jest.fn<Promise<ReadonlySet<string> | undefined>, []>()
const mockLiveExternalProcesses = jest.fn<Promise<ReadonlySet<string> | undefined>, []>()
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  ...jest.requireActual("@/lib/ai/agent/external/agent-transport"),
  getLiveExternalAgentProcessIds: () => mockLiveExternalProcesses(),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  getLiveSidecarSessionIds: () => mockLiveSidecarSessions(),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/db/agent-team-runtime"),
}))

const team = {
  id: "team-1",
  name: "Team",
  description: "",
  task: "Ship",
  status: "idle",
  config: {
    maxTeammates: 2,
    maxConcurrentTeammates: 1,
    executionMode: "coordinated",
    displayMode: "expanded",
    runtimeVersion: "durable-v2",
    writeMode: "single-writer",
    repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
  },
  leadId: "lead",
  teammateIds: ["lead", "mate"],
  taskIds: ["task"],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(1),
} as AgentTeam

describe("durable dispatch bridge", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    mockLiveSidecarSessions.mockReset().mockResolvedValue(undefined)
    mockLiveExternalProcesses.mockReset().mockResolvedValue(undefined)
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  const openDispatch = async (runId: string, access: "read" | "write" = "read", start = true) => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, runId)
    const input = {
      coordinator,
      team,
      runId,
      teammateId: "mate",
      taskId: "task",
      access,
      repositoryId: "primary",
    }
    const dispatch = await beginDurableDispatch(input)
    if (start) await dispatch.startLocalExecution()
    return { coordinator, input, dispatch }
  }

  // These fixtures execute entirely in-process: their own promise is the
  // executor, without the production capture/transport/timeout wrappers.
  const runLocalExecutor = <T>(
    dispatch: Awaited<ReturnType<typeof beginDurableDispatch>>,
    operation: () => Promise<T>
  ) =>
    dispatch.run(() => {
      const execution = operation()
      dispatch.trackLocalStop(
        execution.then(
          () => undefined,
          () => undefined
        )
      )
      return execution
    })

  // Evidence/trajectory fixtures run wholly in-process. Supply their explicit
  // executor disposal observation rather than inferring it from result text.
  const completeDisposed = async (
    dispatch: Awaited<ReturnType<typeof beginDurableDispatch>>,
    result: Parameters<Awaited<ReturnType<typeof beginDurableDispatch>>["complete"]>[0]
  ) => {
    await dispatch.flush()
    await dispatch.startLocalExecution()
    dispatch.trackLocalStop(Promise.resolve())
    await Promise.resolve()
    return dispatch.complete(result)
  }

  it("fences task status projection after a newer attempt completes", async () => {
    const { coordinator, dispatch } = await openDispatch("stale-task-projection")
    const project = jest.fn()
    await expect(dispatch.projectIfCurrent(project)).resolves.toBe(true)
    expect(project).toHaveBeenCalledTimes(1)
    const current = (await coordinator.store.getChild(dispatch.childRunId))!
    await coordinator.store.updateChild(dispatch.childRunId, {
      attempt: current.attempt + 1,
      dispatchEpoch: (current.dispatchEpoch ?? 0) + 1,
      status: "completed",
    })
    await dispatch.fail(new Error("old epoch failed"))
    await expect(dispatch.projectIfCurrent(project)).resolves.toBe(false)
    expect(project).toHaveBeenCalledTimes(1)
    expect((await coordinator.store.getChild(dispatch.childRunId))?.status).toBe("completed")
  })

  it.each([undefined, 7])(
    "keeps rejecting legacy completion after repeated admission (completedAt=%s)",
    async (completedAt) => {
      const { coordinator, input, dispatch } = await openDispatch(
        "legacy-completion",
        "read",
        false
      )
      await coordinator.store.updateChild(dispatch.childRunId, {
        status: "completed",
        dispatchEpoch: undefined,
        startedAt: undefined,
        completedAt,
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        // An operator may reopen the run, but cannot erase the old attempt's
        // missing disposal evidence by doing so.
        await coordinator.store.updateRun(input.runId, { status: "running" })
        await expect(beginDurableDispatch(input)).rejects.toThrow("stop_unconfirmed")
        await expect(
          coordinator.assessTaskRecovery(input.runId, input.taskId)
        ).resolves.toMatchObject({
          eligible: false,
          reason: "stop_unconfirmed",
        })
      }
      expect(await coordinator.store.listChildren(input.runId)).toHaveLength(1)
    }
  )

  it("keeps a failed preparation retryable when no executor was admitted", async () => {
    const { coordinator, input, dispatch } = await openDispatch("prepare-failed", "read", false)
    await dispatch.fail(new Error("prepare failed"))
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "failed",
    })
    await expect(coordinator.assessTaskRecovery(input.runId, input.taskId)).resolves.toEqual({
      eligible: true,
    })
    await expect(coordinator.retryChild(dispatch.childRunId)).resolves.toMatchObject({
      status: "queued",
    })
  })

  it.each(["mate", "other-mate"])(
    "fences an old completed child when %s owns the task, even with equal clocks",
    async (teammateId) => {
      jest.spyOn(Date, "now").mockReturnValue(1_000)
      const { input, dispatch: first } = await openDispatch("fresh-task-projection")
      await completeDisposed(first, { text: "old result" })
      const second = await beginDurableDispatch({ ...input, teammateId, now: () => 1_000 })
      expect(second.childRunId).not.toBe(first.childRunId)
      await second.startLocalExecution()
      await completeDisposed(second, { text: "new result" })
      await first.fail(new Error("late old cleanup error"))
      const stale = jest.fn()
      await expect(first.projectIfCurrent(stale)).resolves.toBe(false)
      expect(stale).not.toHaveBeenCalled()
      const current = jest.fn()
      await expect(second.projectIfCurrent(current)).resolves.toBe(true)
      expect(current).toHaveBeenCalledTimes(1)
    }
  )

  it.each([undefined, "host-b"])(
    "claims a fresh remote epoch after a confirmed stop (target=%s)",
    async (target) => {
      const { coordinator, input, dispatch } = await openDispatch("remote-retry", "read", false)
      await dispatch
        .run(
          async () => {
            expect(
              await dispatch.claimRemoteLease({
                childRunId: dispatch.childRunId,
                leaseId: "old-lease",
                hostRef: "host-a",
                now: Date.now(),
              })
            ).toBeDefined()
            throw new Error("remote failed")
          },
          undefined,
          { deferExecutionStart: true }
        )
        .catch(() => undefined)
      await coordinator.store.updateChild(dispatch.childRunId, {
        stop: {
          state: "confirmed",
          epoch: 1,
          requestedAt: 1,
          proof: { kind: "ack", epoch: 1, at: 2 },
        },
      })
      await dispatch.fail(new Error("remote failed"))
      await coordinator.retryChild(dispatch.childRunId, target)
      const retry = await beginDurableDispatch(input)
      await expect(retry.prepareTurnContext()).resolves.toContain("Frozen objective")
      const execute = jest.fn(async () => {
        const claimed = await retry.claimRemoteLease({
          childRunId: retry.childRunId,
          leaseId: "new-lease",
          hostRef: target ?? "host-a",
          now: Date.now(),
        })
        expect(claimed).toMatchObject({ attempt: 2, dispatchEpoch: 2 })
        expect(claimed?.stop).toBeUndefined()
      })
      await expect(
        retry.run(execute, undefined, { deferExecutionStart: true })
      ).resolves.toBeUndefined()
      expect(execute).toHaveBeenCalledTimes(1)
    }
  )

  it("projects remote completion while the dormant worker receipt keeps executor settlement closed", async () => {
    const { coordinator, dispatch, input } = await openDispatch(
      "remote-unconfirmed-completion",
      "read",
      false
    )
    await dispatch.claimRemoteLease({
      childRunId: dispatch.childRunId,
      leaseId: "remote-lease",
      hostRef: "host-a",
      now: Date.now(),
    })
    await dispatch.complete({ text: "retained remote answer" })
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "completed",
      waitingReason: "stop_unconfirmed",
      stop: { state: "unconfirmed", epoch: dispatch.dispatchEpoch },
    })
    expect((await coordinator.store.getChild(dispatch.childRunId))?.settledEpoch).toBeUndefined()
    expect(await coordinator.store.listTrajectory(input.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "model_turn_completed", contentHash: expect.any(String) }),
      ])
    )
    await expect(beginDurableDispatch(input)).rejects.toThrow("stop_unconfirmed")
    await coordinator.recover()
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "completed",
      waitingReason: "stop_unconfirmed",
    })
  })

  it("records a current remote disposal ACK after stop wins the result race", async () => {
    const { coordinator, dispatch } = await openDispatch("remote-late-ack", "read", false)
    await dispatch.run(
      async () => {
        await dispatch.claimRemoteLease({
          childRunId: dispatch.childRunId,
          leaseId: "remote-lease",
          hostRef: "host-a",
          now: Date.now(),
        })
      },
      undefined,
      { deferExecutionStart: true }
    )
    const epoch = dispatch.dispatchEpoch
    await coordinator.store.updateChild(dispatch.childRunId, {
      status: "needs_input",
      stop: { state: "unconfirmed", epoch, requestedAt: 1 },
    })
    await expect(
      dispatch.recordRemoteDisposal({ kind: "ack", epoch: epoch - 1, at: 2 })
    ).rejects.toThrow("stop_unconfirmed")
    await expect(
      dispatch.recordRemoteDisposal({ kind: "ack", epoch, at: 3 })
    ).resolves.toBeUndefined()
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
      settledEpoch: epoch,
      stop: { state: "confirmed", epoch, proof: { kind: "ack", epoch, at: 3 } },
    })
    await expect(dispatch.complete({ text: "late result" })).rejects.toThrow("no longer active")
  })

  it("keeps an external timeout unconfirmed until the Host registry proves it stopped", async () => {
    const { coordinator, dispatch, input } = await openDispatch("external-timeout")
    await dispatch.attachControl({ steer: async () => {} }, "native-session", "external-process")
    await coordinator.store.updateChild(dispatch.childRunId, { runtime: "codex" })
    mockLiveExternalProcesses.mockResolvedValue(new Set(["external-process"]))
    await expect(
      dispatch.run(
        async () => {
          throw new Error("External agent execution timed out")
        },
        undefined,
        { deferExecutionStart: true }
      )
    ).rejects.toThrow("timed out")
    await dispatch.fail(new Error("External agent execution timed out"))
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
      stop: { state: "unconfirmed", epoch: 1 },
    })
    expect((await coordinator.store.getChild(dispatch.childRunId))?.settledEpoch).toBeUndefined()
    await expect(coordinator.retryChild(dispatch.childRunId)).rejects.toThrow("stop_unconfirmed")
    const replacement = jest.fn(async () => {
      const next = await beginDurableDispatch({ ...input, teammateId: "replacement" })
      await next.run(async () => {})
    })
    await expect(replacement()).rejects.toThrow("not accepting dispatch")
    expect(mockLiveExternalProcesses).toHaveBeenCalled()
    mockLiveExternalProcesses.mockResolvedValue(new Set())
    await coordinator.terminateChild(dispatch.childRunId)
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "terminated",
      stop: { state: "confirmed", proof: { kind: "ack", epoch: 1 } },
    })
    await expect(coordinator.assessTaskRecovery(input.runId, input.taskId)).resolves.toEqual({
      eligible: true,
    })
  })

  it("does not invoke an executor after termination while its environment is preparing", async () => {
    const { coordinator, dispatch } = await openDispatch("terminate-during-prepare", "read", false)
    let finishPreparation!: () => void
    let enteredPreparation!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredPreparation = resolve
    })
    const executor = jest.fn()
    const execution = dispatch.run(
      async () => {
        await new Promise<void>((resolve) => {
          finishPreparation = resolve
          enteredPreparation()
        })
        await dispatch.startLocalExecution()
        executor()
      },
      undefined,
      { deferExecutionStart: true }
    )
    const observed = execution.catch((error: unknown) => error)
    await entered
    await coordinator.terminateChild(dispatch.childRunId)
    const stopped = await coordinator.store.getChild(dispatch.childRunId)
    expect(stopped).toMatchObject({ status: "terminated", stop: { state: "confirmed", epoch: 0 } })
    finishPreparation()
    expect(await observed).toMatchObject({ name: "AbortError" })
    expect(executor).not.toHaveBeenCalled()
    expect(await coordinator.store.getChild(dispatch.childRunId)).toEqual(stopped)
  })

  it.each(["requested", "confirmed"] as const)(
    "never clears a %s stop of the admitted epoch when starting",
    async (state) => {
      const { coordinator, dispatch } = await openDispatch("stopped-at-admission", "read", false)
      const stop = { state, epoch: 0, requestedAt: 1 }
      await coordinator.store.updateChild(dispatch.childRunId, { stop })
      await expect(dispatch.startLocalExecution()).rejects.toMatchObject({ name: "AbortError" })
      const child = await coordinator.store.getChild(dispatch.childRunId)
      expect(child?.dispatchEpoch ?? 0).toBe(0)
      expect(child?.stop).toEqual(stop)
      expect(
        (await coordinator.store.listTrajectory("stopped-at-admission")).some(
          (event) => event.kind === "model_turn_started"
        )
      ).toBe(false)
    }
  )

  it("accepts late terminal evidence after an unobserved local execution failure", async () => {
    const { coordinator, dispatch, input } = await openDispatch("late-local-terminal")
    await expect(
      dispatch.run(async () => {
        throw new Error("transport lost")
      })
    ).rejects.toThrow("transport lost")
    await dispatch.fail(new Error("transport lost"))
    dispatch.dispose()
    expect((await coordinator.store.getChild(dispatch.childRunId))?.stop?.state).toBe("unconfirmed")
    dispatch.trackLocalStop(Promise.resolve())
    for (let i = 0; i < 100; i++) {
      const child = await coordinator.store.getChild(dispatch.childRunId)
      if (child?.settledEpoch === 1) {
        expect(child.stop).toMatchObject({ state: "confirmed", proof: { kind: "ack", epoch: 1 } })
        await expect(coordinator.assessTaskRecovery(input.runId, input.taskId)).resolves.toEqual({
          eligible: true,
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("Late terminal evidence was not persisted")
  })

  it("records explicitly observed local executor settlement before failure admission", async () => {
    const { coordinator, dispatch } = await openDispatch("local-rejection")
    await expect(
      runLocalExecutor(dispatch, async () => {
        throw new Error("local executor failed")
      })
    ).rejects.toThrow("local executor failed")
    await dispatch.fail(new Error("local executor failed"))
    await expect(dispatch.run(async () => undefined)).rejects.toThrow("already invoked")
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "failed",
      settledEpoch: 1,
      stop: { state: "confirmed", proof: { kind: "ack", epoch: 1 } },
    })
    await expect(coordinator.retryChild(dispatch.childRunId)).resolves.toMatchObject({
      status: "queued",
    })
  })

  it("refuses completion when capture returns before its registered executor ends", async () => {
    const { coordinator, dispatch } = await openDispatch("capture-before-terminal")
    let stopped!: () => void
    const evidence = new Promise<void>((resolve) => {
      stopped = resolve
    })
    await dispatch.run(async () => {
      dispatch.trackLocalStop(evidence)
      return "captured text"
    })
    await expect(dispatch.complete({ text: "captured text" })).rejects.toThrow("stop_unconfirmed")
    await dispatch.fail(new Error("missing executor evidence"))
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
      stop: { state: "unconfirmed" },
    })
    stopped()
    for (let i = 0; i < 100; i++) {
      if ((await coordinator.store.getChild(dispatch.childRunId))?.settledEpoch === 1) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("Late executor evidence was not recorded")
  })

  it("refuses a completed turn without disposal, and admits re-dispatch after observed disposal", async () => {
    const { coordinator, dispatch, input } = await openDispatch("successful-disposal")
    await dispatch.run(async () => "turn completed")
    await expect(dispatch.complete({ text: "turn completed" })).rejects.toThrow("stop_unconfirmed")
    let disposed!: () => void
    const disposal = new Promise<void>((resolve) => {
      disposed = resolve
    })
    dispatch.trackLocalStop(disposal)
    disposed()
    await disposal
    for (let i = 0; i < 100; i++) {
      if ((await coordinator.store.getChild(dispatch.childRunId))?.settledEpoch === 1) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await dispatch.complete({ text: "disposed result" })
    expect(await coordinator.assessTaskRecovery(input.runId, input.taskId)).toEqual({
      eligible: true,
    })
    const next = await beginDurableDispatch(input)
    expect(next.childRunId).not.toBe(dispatch.childRunId)
    next.dispose()
  })

  it("preserves executor evidence arriving during failure admission", async () => {
    const { coordinator, input, dispatch } = await openDispatch("terminal-during-failure")
    let stopped!: () => void
    await dispatch.run(async () => {
      dispatch.trackLocalStop(
        new Promise<void>((resolve) => {
          stopped = resolve
        })
      )
    })
    const listChildren = coordinator.store.listChildren.bind(coordinator.store)
    jest.spyOn(coordinator.store, "listChildren").mockImplementationOnce(async (runId) => {
      const snapshot = await listChildren(runId)
      stopped()
      for (let i = 0; i < 100; i++) {
        if ((await coordinator.store.getChild(dispatch.childRunId))?.settledEpoch === 1)
          return snapshot
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error("Executor evidence was not persisted")
    })
    await dispatch.fail(new Error("capture failed"))
    expect((await coordinator.store.getChild(dispatch.childRunId))?.stop).toMatchObject({
      state: "confirmed",
      proof: { kind: "ack", epoch: 1 },
    })
    await expect(coordinator.assessTaskRecovery(input.runId, input.taskId)).resolves.toEqual({
      eligible: true,
    })
  })

  it("does not start an epoch while waiting for remote capacity, including startup recovery", async () => {
    const { coordinator, input, dispatch } = await openDispatch(
      "capacity-before-executor",
      "read",
      false
    )
    await expect(
      dispatch.run(
        async () => {
          throw new Error("no_compatible_capacity")
        },
        undefined,
        { deferExecutionStart: true }
      )
    ).rejects.toThrow("no_compatible_capacity")
    await dispatch.wait("no_compatible_capacity")
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      status: "queued",
    })
    expect((await coordinator.store.getChild(dispatch.childRunId))?.startedAt).toBeUndefined()
    expect((await coordinator.store.getChild(dispatch.childRunId))?.dispatchEpoch ?? 0).toBe(0)
    await coordinator.store.updateRun(input.runId, { status: "running" })
    await expect(coordinator.recover()).resolves.toEqual([
      { runId: input.runId, status: "recovering" },
    ])
    expect((await coordinator.store.getChild(dispatch.childRunId))?.status).toBe("queued")
    await expect(beginDurableDispatch(input)).resolves.toBeDefined()
  })

  it("does not treat a sidecar pause IPC reply as executor settlement", async () => {
    const { sidecarSessionControl } = await import("../teammate/child-controls")
    const { isStoredChildStopped } = await import("@cognia/agent-orchestration/coordinator")
    const { controlDurableRun } = await import("./durable-control")
    const { coordinator, input, dispatch } = await openDispatch("local-pause-pending")
    let release!: () => void
    let interrupted!: () => void
    const interrupt = new Promise<void>((resolve) => {
      interrupted = resolve
    })
    const execution = runLocalExecutor(dispatch, async () => {
      await dispatch.attachControl(
        sidecarSessionControl(
          {
            steerSession: async () => {},
            interruptSession: async () => {
              interrupted()
            },
            closeSession: async () => {},
          },
          "local-session"
        )
      )
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const observed = execution.catch(() => undefined)
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    const pausing = coordinator.pauseChild(dispatch.childRunId)
    try {
      await interrupt
      await new Promise((resolve) => setTimeout(resolve, 20))
      const child = (await coordinator.store.getChild(dispatch.childRunId))!
      expect(child.settledEpoch).toBeUndefined()
      expect(await isStoredChildStopped(coordinator.store, child, Date.now())).toBe(false)
      await expect(
        coordinator.assessTaskRecovery(input.runId, input.taskId)
      ).resolves.toMatchObject({
        eligible: false,
        reason: "stop_unconfirmed",
      })
      const stopping = controlDurableRun(input.runId, "stop", { coordinator })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await coordinator.store.getRun(input.runId))?.status).not.toBe("cancelled")
      release()
      await Promise.all([observed, pausing, stopping])
      expect((await coordinator.store.getRun(input.runId))?.status).toBe("cancelled")
    } finally {
      release()
      await Promise.all([observed, pausing])
      dispatch.dispose()
    }
  })

  it.each([false, true])(
    "checkpoints a settled sidecar pause on the production path (pending tool=%s)",
    async (pendingTool) => {
      const { sidecarSessionControl } = await import("../teammate/child-controls")
      const { coordinator, dispatch } = await openDispatch("local-pause-resume")
      let release!: () => void
      const execution = runLocalExecutor(dispatch, async () => {
        await dispatch.attachControl(
          sidecarSessionControl(
            {
              steerSession: async () => {},
              interruptSession: async () => {
                release()
              },
              closeSession: async () => {},
            },
            "local-session"
          ),
          "local-session"
        )
        if (pendingTool) {
          dispatch.capture({ type: "tool-call", id: "pending-write", toolName: "Write", input: {} })
          await dispatch.flush()
        }
        await new Promise<void>((resolve) => {
          release = resolve
        })
      })
      const observed = execution.catch(() => undefined)
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(await coordinator.store.getLatestCheckpoint(dispatch.childRunId)).toEqual(
        pendingTool ? expect.anything() : undefined
      )
      await coordinator.pauseChild(dispatch.childRunId)
      await observed
      expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
        status: "paused",
        stop: { state: "confirmed", proof: { kind: "ack" } },
      })
      expect(await coordinator.store.getLatestCheckpoint(dispatch.childRunId)).toMatchObject({
        replay: pendingTool ? "needs_input" : "safe",
        sideEffects: pendingTool ? [expect.objectContaining({ state: "intent" })] : [],
      })
      if (pendingTool) {
        await expect(coordinator.resumeChild(dispatch.childRunId)).rejects.toThrow(
          "uncertain_side_effect"
        )
        return
      }
      await expect(coordinator.resumeChild(dispatch.childRunId)).resolves.toBeUndefined()
      expect((await coordinator.store.getChild(dispatch.childRunId))?.status).toBe("queued")
      await dispatch.fail(new DOMException("Paused turn ended", "AbortError"))
      expect((await coordinator.store.getChild(dispatch.childRunId))?.status).toBe("queued")
    }
  )

  it("waits for a local executor after a void terminate, and confirms only after settlement", async () => {
    const { sidecarSessionControl } = await import("../teammate/child-controls")
    const { controlDurableRun } = await import("./durable-control")
    const { coordinator, input, dispatch } = await openDispatch("local-stop-settlement")
    let release!: () => void
    let terminateCalled!: () => void
    const terminating = new Promise<void>((resolve) => {
      terminateCalled = resolve
    })
    const execution = runLocalExecutor(dispatch, async () => {
      await dispatch.attachControl(
        sidecarSessionControl(
          {
            steerSession: async () => {},
            interruptSession: async () => {},
            closeSession: async () => {
              terminateCalled()
            },
          },
          "local-session"
        ),
        "local-session"
      )
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const observed = execution.catch(() => undefined)
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    const stopping = controlDurableRun(input.runId, "stop", { coordinator })
    await terminating
    expect((await coordinator.store.getRun(input.runId))?.status).toBe("running")
    expect((await coordinator.store.getChild(dispatch.childRunId))?.stop?.state).toBe("requested")
    release()
    await Promise.all([observed, stopping])
    expect(await coordinator.store.getChild(dispatch.childRunId)).toMatchObject({
      settledEpoch: 1,
      stop: { state: "confirmed", proof: { kind: "ack", epoch: 1 } },
    })
    expect(await coordinator.store.getRun(input.runId)).toMatchObject({
      status: "cancelled",
      stop: { state: "confirmed" },
    })
    expect((await coordinator.store.getRun(input.runId))?.stop?.proof).toBeUndefined()
  })

  it("rejects a delayed tool-result checkpoint after the next executor starts", async () => {
    const { coordinator, input, dispatch } = await openDispatch("late-tool-checkpoint")
    dispatch.capture({ type: "tool-call", id: "write", toolName: "Write", input: {} })
    await dispatch.flush()
    const checkpoint = coordinator.checkpoint
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const spy = jest.spyOn(coordinator, "checkpoint").mockImplementationOnce(async (...args) => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return checkpoint(...args)
    })
    dispatch.capture({
      type: "tool-result",
      id: "write",
      toolName: "Write",
      result: "done",
      isError: false,
    })
    await waiting
    // The real executor exits before the delayed persistence callback returns.
    await runLocalExecutor(dispatch, async () => undefined)
    await dispatch.attachControl({ steer: async () => {}, pause: async () => true })
    await coordinator.pauseChild(dispatch.childRunId)
    // Use the checkpoint already persisted before the delayed callback, then explicitly resolve its known effect.
    await checkpoint(dispatch.childRunId, {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    await coordinator.resumeChild(dispatch.childRunId)
    const next = await beginDurableDispatch(input)
    await next.startLocalExecution()
    release()
    await expect(dispatch.flush()).rejects.toThrow("epoch")
    spy.mockRestore()
    expect(
      (await coordinator.store.getLatestCheckpoint(dispatch.childRunId))?.trajectorySequence
    ).toBe(0)
    expect(
      (await coordinator.store.listTrajectory(input.runId)).some(
        (event) =>
          event.payload?.action === "epoch_rejected" && event.payload?.operation === "checkpoint"
      )
    ).toBe(true)
  })

  it("admits only one executor when two teammates prepared the same task before either started", async () => {
    const coordinator = createDurableTeamCoordinator()
    const concurrentTeam = { ...team, config: { ...team.config, maxConcurrentTeammates: 2 } }
    await coordinator.prepareRun(concurrentTeam, "simultaneous-task")
    const input = {
      coordinator,
      team: concurrentTeam,
      runId: "simultaneous-task",
      teammateId: "first",
      taskId: "task",
      repositoryId: "primary",
      access: "read" as const,
    }
    const dispatch = await beginDurableDispatch(input)
    const second = await beginDurableDispatch({ ...input, teammateId: "rotated" })
    let release!: () => void
    const first = dispatch.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    const execute = jest.fn(async () => undefined)
    try {
      await expect(second.run(execute)).rejects.toThrow("stop_unconfirmed")
      expect(execute).not.toHaveBeenCalled()
      expect((await coordinator.store.getChild(second.childRunId))?.dispatchEpoch ?? 0).toBe(0)
    } finally {
      release()
      await first
    }
  })

  const acknowledge = async (
    coordinator: ReturnType<typeof createDurableTeamCoordinator>,
    childId: string
  ) => {
    const child = (await coordinator.store.getChild(childId))!
    const epoch = child.dispatchEpoch ?? 0
    await coordinator.store.updateChild(childId, {
      stop: { state: "confirmed", epoch, requestedAt: 1, proof: { kind: "ack", epoch, at: 2 } },
    })
    await coordinator.retryChild(childId)
  }

  it.each(["device:a", "device:b"])(
    "refuses retry on %s after a settled Write and connection closure",
    async (target) => {
      const { coordinator, input, dispatch } = await openDispatch("probe-recovery")
      await coordinator.store.updateChild(dispatch.childRunId, {
        hostRef: "device:a",
        remoteSessionId: "remote-a",
      })
      await coordinator.store.appendTrajectory({
        runId: input.runId,
        childRunId: dispatch.childRunId,
        kind: "remote_event",
        correlationId: "remote-write-call",
        payload: { event: { kind: "tool-call", toolName: "Write", toolCallId: "write-1" } },
        createdAt: Date.now(),
      })
      dispatch.capture({
        type: "tool-call",
        id: "write-1",
        toolName: "Write",
        input: { path: "a.txt" },
      })
      await dispatch.flush()
      await coordinator.store.appendTrajectory({
        runId: input.runId,
        childRunId: dispatch.childRunId,
        kind: "remote_event",
        correlationId: "remote-write-result",
        payload: { event: { kind: "tool-result", toolName: "Write", toolCallId: "write-1" } },
        createdAt: Date.now(),
      })
      dispatch.capture({
        type: "tool-result",
        id: "write-1",
        toolName: "Write",
        result: "written",
        isError: false,
      })
      await dispatch.flush()
      await dispatch.fail(new Error("worker connection closed after authorization revocation"))
      expect((await coordinator.store.getLatestCheckpoint(dispatch.childRunId))?.replay).toBe(
        "safe"
      )
      await expect(coordinator.retryChild(dispatch.childRunId, target)).rejects.toThrow(
        "stop_unconfirmed"
      )
      await coordinator.store.updateRun(input.runId, { status: "running" })
      await expect(
        beginDurableDispatch({ ...input, teammateId: "rotated-teammate" })
      ).rejects.toThrow("stop_unconfirmed")
      expect(await coordinator.store.getRun(input.runId)).toMatchObject({
        status: "needs_input",
        recoveryReason: "stop_unconfirmed",
      })
      await acknowledge(coordinator, dispatch.childRunId)
      const next = await beginDurableDispatch({ ...input, teammateId: "rotated-teammate" })
      expect(next.childRunId).not.toBe(dispatch.childRunId)
    }
  )

  it("does not carry an expired fence proof into the new epoch", async () => {
    const { coordinator, input, dispatch } = await openDispatch("fence-reset")
    await coordinator.checkpoint(dispatch.childRunId, {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    await coordinator.store.updateChild(dispatch.childRunId, {
      status: "failed",
      remoteDispatchEpoch: dispatch.dispatchEpoch,
      fenceCapable: true,
      lastRenewalSentAt: 1,
      leaseTtlMs: 1,
      fenceGraceMs: 1,
    })
    const next = await beginDurableDispatch(input)
    await next.startLocalExecution()
    expect(next.dispatchEpoch).toBeGreaterThan(dispatch.dispatchEpoch)
    expect(await coordinator.store.getChild(next.childRunId)).toMatchObject({ fenceCapable: false })
    expect((await coordinator.store.getChild(next.childRunId))?.lastRenewalSentAt).toBeUndefined()
    await expect(beginDurableDispatch({ ...input, teammateId: "rotated" })).rejects.toThrow(
      "stop_unconfirmed"
    )
  })

  it("persists dispatch through the coordinator's injected run store", async () => {
    const store = createMemoryTeamRunStore<AgentTeamExecutionConstraints>()
    const coordinator = createDurableTeamCoordinator({ store })
    await coordinator.prepareRun(team, "run-injected-store")
    const input = {
      coordinator,
      team,
      runId: "run-injected-store",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
    }
    const dispatch = await beginDurableDispatch(input)

    expect(await store.getChild(dispatch.childRunId)).toMatchObject({
      status: "running",
      attempt: 1,
    })
    await dispatch.run(async () => undefined)
    expect((await store.listTrajectory(input.runId)).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["child_created", "model_turn_started"])
    )
    expect(await runtimeDb.getAgentTeamRun(input.runId)).toBeUndefined()
    expect(await runtimeDb.listAgentTeamChildRuns(input.runId)).toEqual([])
    await expect(beginDurableDispatch(input)).rejects.toThrow("already has an active dispatch")
  })

  it("forgets a provider session that ended under the child", async () => {
    const { coordinator, dispatch } = await openDispatch("run-released-session")
    const steer = jest.fn(async () => undefined)
    await dispatch.attachControl({ steer }, "session-1", "external-process")
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      sessionId: "session-1",
      executorRegistry: "external-process",
    })

    await dispatch.releaseSession("session-other")
    expect((await runtimeDb.getAgentTeamChildRun(dispatch.childRunId))?.sessionId).toBe("session-1")
    await dispatch.releaseSession("session-1")
    expect((await runtimeDb.getAgentTeamChildRun(dispatch.childRunId))?.sessionId).toBeUndefined()
    // Steering no longer reaches the dead session; it waits in the durable queue.
    const receipt = await coordinator.steer(dispatch.childRunId, "check the tests")
    expect(receipt.status).toBe("queued")
    expect(steer).not.toHaveBeenCalled()
    await completeDisposed(dispatch, { text: "done" })
  })

  it.each(["live", "absent", "unknown", "other-session"] as const)(
    "binds sidecar ownership only to its observed active turn: %s",
    async (mode) => {
      const { coordinator, dispatch } = await openDispatch(`registry-${mode}`)
      await dispatch.attachControl({ steer: async () => {} }, "session-1", "unconfirmed")
      mockLiveSidecarSessions.mockResolvedValue(
        mode === "unknown"
          ? undefined
          : new Set(mode === "live" ? ["session-1"] : mode === "other-session" ? ["session-2"] : [])
      )
      await dispatch.bindLocalSidecarSession(mode === "other-session" ? "session-2" : "session-1")
      expect((await coordinator.store.getChild(dispatch.childRunId))?.executorRegistry).toBe(
        mode === "live" ? "sidecar" : "unconfirmed"
      )
    }
  )

  it("admits only one simultaneous begin for the same task and teammate", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-concurrent-begin")
    const input = {
      coordinator,
      team,
      runId: "run-concurrent-begin",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
    }
    const results = await Promise.allSettled([
      beginDurableDispatch(input),
      beginDurableDispatch(input),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await runtimeDb.listAgentTeamChildRuns(input.runId)).toEqual([
      expect.objectContaining({ status: "running", attempt: 1 }),
    ])
    expect(await runtimeDb.getAgentTeamRun(input.runId)).toMatchObject({ status: "running" })
  })

  it("rejects a second begin without changing the active owner's attempt or run", async () => {
    const { input, dispatch } = await openDispatch("run-owned-begin")
    await expect(beginDurableDispatch(input)).rejects.toThrow("already has an active dispatch")
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "running",
      attempt: 1,
    })
    expect(await runtimeDb.getAgentTeamRun(input.runId)).toMatchObject({ status: "running" })
    await completeDisposed(dispatch, { text: "owner completed normally" })
  })

  it("keeps an older failed handle from settling a newer retry attempt", async () => {
    const { coordinator, input, dispatch: first } = await openDispatch("run-attempt-owner")
    await first.fail(new Error("first attempt failed"))
    await acknowledge(coordinator, first.childRunId)
    const second = await beginDurableDispatch(input)
    await expect(completeDisposed(first, { text: "stale result" })).rejects.toThrow(
      "no longer owns"
    )
    await first.fail(new Error("late first-attempt failure"))
    expect(await runtimeDb.getAgentTeamChildRun(second.childRunId)).toMatchObject({
      status: "running",
      attempt: 2,
    })
    const staleOperation = jest.fn(async () => "stale execution")
    await expect(first.run(staleOperation)).rejects.toThrow("no longer owns")
    expect(staleOperation).not.toHaveBeenCalled()
    first.capture({ type: "tool-call", id: "stale", toolName: "Write", input: {} })
    await expect(first.flush()).rejects.toThrow("no longer owns")
    expect(
      (await runtimeDb.listAgentTeamTrajectory(input.runId)).some(
        (event) => event.correlationId === "stale"
      )
    ).toBe(false)
    await completeDisposed(second, { text: "fresh result" })
  })

  it("persists executor ownership and refreshes it when retry uses a different executor", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-registry-owner")
    const input = {
      coordinator,
      team,
      runId: "run-registry-owner",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
      runtime: "codex",
      executorRegistry: "external-process" as const,
    }
    const first = await beginDurableDispatch(input)
    expect(await coordinator.store.getChild(first.childRunId)).toMatchObject({
      runtime: "codex",
      executorRegistry: "external-process",
    })
    await first.startLocalExecution()
    await first.fail(new Error("first attempt failed"))
    await acknowledge(coordinator, first.childRunId)
    const next = await beginDurableDispatch({
      ...input,
      runtime: "codex",
      executorRegistry: "unconfirmed",
    })
    expect(await coordinator.store.getChild(next.childRunId)).toMatchObject({
      runtime: "codex",
      executorRegistry: "unconfirmed",
      attempt: 2,
    })
  })

  it("compares epoch inside a projection write even when status and timestamp did not change", async () => {
    const { coordinator, dispatch } = await openDispatch("projection-cas")
    const read = coordinator.store.getChild
    jest.spyOn(coordinator.store, "getChild").mockImplementationOnce(async (id) => {
      const snapshot = await read(id)
      await coordinator.store.updateChild(id, { dispatchEpoch: (snapshot!.dispatchEpoch ?? 0) + 1 })
      return snapshot
    })
    await expect(dispatch.setWorkspace({ workspacePath: "/stale" })).rejects.toThrow(
      "no longer owns"
    )
    expect((await read(dispatch.childRunId))?.workspacePath).toBeUndefined()
    expect(
      (await coordinator.store.listTrajectory("projection-cas")).some(
        (event) => event.payload?.action === "epoch_rejected"
      )
    ).toBe(true)
  })

  it("does not let a duplicate begin replace a child waiting for scheduler admission", async () => {
    const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
    await coordinator.prepareRun(team, "run-admission-owner")
    const input = {
      coordinator,
      team,
      runId: "run-admission-owner",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
    }
    const blocker = await beginDurableDispatch({ ...input, taskId: "blocker" })
    const queued = await beginDurableDispatch(input)
    let release!: () => void
    const active = blocker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    const waiting = runLocalExecutor(queued, async () => "queued result")
    while (coordinator.schedulerSnapshot().queued.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1))
    try {
      await expect(beginDurableDispatch(input)).rejects.toThrow("already has an active dispatch")
      expect(await runtimeDb.getAgentTeamChildRun(queued.childRunId)).toMatchObject({
        status: "queued",
        attempt: 1,
      })
    } finally {
      release()
      await Promise.all([active, waiting])
    }
    await completeDisposed(queued, { text: "finished" })
  })

  it("rolls back executor start when the model_turn_started journal write fails", async () => {
    const { coordinator, dispatch } = await openDispatch("start-journal-failure", "read", false)
    const append = coordinator.store.appendTrajectory
    jest.spyOn(coordinator.store, "appendTrajectory").mockImplementation(async (event, content) => {
      if (event.kind === "model_turn_started") throw new Error("start journal unavailable")
      return append(event, content)
    })
    const executor = jest.fn(async () => undefined)
    await expect(dispatch.run(executor)).rejects.toThrow("start journal unavailable")
    expect(executor).not.toHaveBeenCalled()
    const child = (await coordinator.store.getChild(dispatch.childRunId))!
    expect(child.dispatchEpoch ?? 0).toBe(0)
    expect(child.startedAt).toBeUndefined()
    expect(
      (await coordinator.store.listTrajectory("start-journal-failure")).some(
        (event) => event.kind === "model_turn_started"
      )
    ).toBe(false)
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it.each(["child_created"])(
    "rolls back child initialization after %s journal failure",
    async (kind) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team, "run-init-failure")
      const append = runtimeDb.dexieTeamRunStore.appendTrajectory
      jest
        .spyOn(runtimeDb.dexieTeamRunStore, "appendTrajectory")
        .mockImplementation(async (event, content) => {
          if (event.kind === kind) throw new Error("initial journal unavailable")
          return append(event, content)
        })
      await expect(
        beginDurableDispatch({
          coordinator,
          team,
          runId: "run-init-failure",
          teammateId: "mate",
          taskId: "task",
          access: "read",
          repositoryId: "primary",
        })
      ).rejects.toThrow("initial journal unavailable")
      expect(await runtimeDb.listAgentTeamChildRuns("run-init-failure")).toEqual([])
      expect(await runtimeDb.getAgentTeamRun("run-init-failure")).toMatchObject({
        status: "needs_input",
      })
      expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
    }
  )

  it.each(["pausing", "paused", "sleeping", "needs_input"] as const)(
    "preserves the %s child dispatch gate",
    async (status) => {
      const { input, dispatch } = await openDispatch("run-gated")
      await runtimeDb.updateAgentTeamChildRun(dispatch.childRunId, { status })
      await expect(beginDurableDispatch(input)).rejects.toThrow("not accepting dispatch")
      expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
        status,
        attempt: 1,
      })
    }
  )

  it.each([false, true])(
    "keeps initialization failures scoped to the child when isolateFailure=%s",
    async (isolateFailure) => {
      const coordinator = createDurableTeamCoordinator()
      const runId = "run-isolated-init"
      await coordinator.prepareRun(team, runId)
      const append = runtimeDb.dexieTeamRunStore.appendTrajectory
      jest
        .spyOn(runtimeDb.dexieTeamRunStore, "appendTrajectory")
        .mockImplementation(async (event, content) => {
          if (event.kind === "child_created") throw new Error("initial journal unavailable")
          return append(event, content)
        })
      await expect(
        beginDurableDispatch({
          coordinator,
          team,
          runId,
          teammateId: "first",
          taskId: "first",
          access: "read",
          repositoryId: "primary",
          isolateFailure,
        })
      ).rejects.toThrow("initial journal unavailable")
      expect(await runtimeDb.listAgentTeamChildRuns(runId)).toEqual([])
      expect(await runtimeDb.getAgentTeamRun(runId)).toMatchObject({
        status: isolateFailure ? "running" : "needs_input",
      })
    }
  )

  it.each(["unsettled completion", "uncertain failure", "evidence failure"])(
    "keeps siblings runnable while retaining an isolated child's %s recovery gate",
    async (scenario) => {
      const coordinator = createDurableTeamCoordinator()
      const runId = "run-independent-candidates"
      await coordinator.prepareRun(team, runId)
      const input = {
        coordinator,
        team,
        runId,
        access: "read" as const,
        repositoryId: "primary",
        isolateFailure: true,
      }
      const failed = await beginDurableDispatch({
        ...input,
        teammateId: "first",
        taskId: "first",
        ...(scenario === "evidence failure" ? { taskKind: "code" as const } : {}),
      })
      const sibling = await beginDurableDispatch({
        ...input,
        teammateId: "second",
        taskId: "second",
      })
      if (scenario !== "evidence failure") {
        failed.capture({
          type: "tool-call",
          id: "write",
          toolName: "Write",
          input: { path: "file.ts" },
        })
      }
      if (scenario === "uncertain failure") await failed.fail(new Error("provider disconnected"))
      else
        await expect(completeDisposed(failed, { text: "done" })).rejects.toThrow(
          scenario === "evidence failure" ? "Evidence gate" : "unsettled tool"
        )
      expect(await runtimeDb.getAgentTeamChildRun(failed.childRunId)).toMatchObject({
        status: "needs_input",
      })
      expect(await runtimeDb.getAgentTeamRun(runId)).toMatchObject({ status: "running" })
      const operation = jest.fn(async () => "sibling completed")
      await expect(runLocalExecutor(sibling, operation)).resolves.toBe("sibling completed")
      expect(operation).toHaveBeenCalledTimes(1)
      await completeDisposed(sibling, { text: "done" })
      expect(await runtimeDb.getAgentTeamChildRun(sibling.childRunId)).toMatchObject({
        status: "completed",
      })
      failed.dispose()
      sibling.dispose()
    }
  )

  it("preserves an unsafe provider pause result through the control wrapper", async () => {
    const { coordinator, dispatch } = await openDispatch("run-unsafe-pause")
    await dispatch.attachControl({ steer: async () => {}, pause: async () => false })
    await coordinator.pauseChild(dispatch.childRunId)
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
  })

  it.each(["fail", "checkpointPause"] as const)(
    "does not certify an unprojected remote tool call during %s",
    async (action) => {
      const { dispatch } = await openDispatch("run-remote-tail")
      await runtimeDb.appendAgentTeamTrajectory({
        runId: "run-remote-tail",
        childRunId: dispatch.childRunId,
        kind: "remote_event",
        correlationId: "tool-unprojected",
        createdAt: Date.now(),
        payload: { event: { kind: "tool-call", toolName: "Write" } },
      })
      if (action === "fail") await dispatch.fail(new Error("projection failed"))
      else await expect(dispatch.checkpointPause()).resolves.toBe(false)
      expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
        replay: "needs_input",
      })
    }
  )

  it("keeps a settled local failure replay-safe without remote stop proof", async () => {
    const { dispatch } = await openDispatch("run-local-failure")
    await expect(
      runLocalExecutor(dispatch, async () => {
        throw new Error("provider unavailable")
      })
    ).rejects.toThrow("provider unavailable")
    await dispatch.fail(new Error("provider unavailable"))
    expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
      replay: "safe",
    })
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "failed",
    })
  })

  it("refuses completion while a tool has no settled result", async () => {
    const { dispatch } = await openDispatch("run-unsettled-tool")
    dispatch.capture({
      type: "tool-call",
      id: "write",
      toolName: "Write",
      input: { path: "src/main.ts" },
    })
    await expect(completeDisposed(dispatch, { text: "done" })).rejects.toThrow("unsettled tool")
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
    expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
      replay: "needs_input",
    })
  })

  it.each([
    ["Read", "pnpm test"],
    ["Bash", "pnpm test --help"],
    ["Bash", "pnpm test '--listTests'"],
    ["Bash", "pnpm test --passWithNoTests"],
    ["Bash", "cargo test --no-run"],
    ["Bash", "pnpm lint --fix"],
    ["Bash", "pnpm test > src/generated.ts"],
  ])("does not certify %s %s as verification", async (toolName, command) => {
    const { dispatch } = await openDispatch("run-verifier-command", "write")
    dispatch.capture({
      type: "tool-result",
      toolName,
      input: { command },
      result: "ok",
      isError: false,
    })
    await expect(completeDisposed(dispatch, { text: "done", commitSha: "abc" })).rejects.toThrow(
      "verification"
    )
  })

  it.each([false, true])(
    "does not hide a failing check behind other successful checks (retried=%s)",
    async (retried) => {
      const { dispatch } = await openDispatch("run-verification-retry", "write")
      const checks: Array<[string, boolean]> = [
        ["pnpm test", false],
        ["pnpm test", true],
        ["pnpm lint", false],
      ]
      if (retried) checks.push(["pnpm test", false])
      for (const [command, isError] of checks) {
        dispatch.capture({
          type: "tool-result",
          toolName: "Bash",
          input: { command },
          result: isError ? "failed" : "passed",
          isError,
        })
      }
      const completion = completeDisposed(dispatch, { text: "done", commitSha: "abc" })
      if (retried) await expect(completion).resolves.toBeUndefined()
      else await expect(completion).rejects.toThrow("verification")
    }
  )

  it("records a recoverable failure after a checkpoint write fails", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-storage-failure")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-storage-failure",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    const checkpoint = jest
      .spyOn(coordinator, "checkpoint")
      .mockRejectedValueOnce(new Error("storage unavailable"))
    dispatch.capture({ type: "tool-call", id: "write-1", toolName: "Write", input: {} })
    await expect(completeDisposed(dispatch, { text: "done" })).rejects.toThrow(
      "storage unavailable"
    )
    await dispatch.fail(new Error("turn failed"))
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it("does not let failed verification satisfy the evidence gate", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-failed-test")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-failed-test",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-result",
      id: "test-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "FAIL",
      isError: true,
    })
    await expect(completeDisposed(dispatch, { text: "done", commitSha: "abc" })).rejects.toThrow(
      "Evidence gate"
    )
  })

  it.each(["unconfirmed", "later-edit", "masked-exit"])(
    "rejects %s verification evidence",
    async (scenario) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team, "run-unverified")
      const dispatch = await beginDurableDispatch({
        coordinator,
        team,
        runId: "run-unverified",
        teammateId: "mate",
        taskId: "task",
        access: "write",
        repositoryId: "primary",
      })
      dispatch.capture({
        type: "tool-result",
        toolName: "Bash",
        input: { command: scenario === "masked-exit" ? "pnpm test; true" : "pnpm test" },
        result: "output",
        ...(scenario === "unconfirmed" ? {} : { isError: false }),
      })
      if (scenario === "later-edit")
        dispatch.capture({
          type: "tool-result",
          toolName: "Write",
          result: "edited",
          isError: false,
        })
      await expect(completeDisposed(dispatch, { text: "done", commitSha: "abc" })).rejects.toThrow(
        "verification"
      )
    }
  )

  it("keeps steering replayable until the turn completes", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-steering")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-steering",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    const receipt = await coordinator.steer(dispatch.childRunId, "Inspect only")
    await dispatch.prepareTurnContext()
    expect(await getDb().agentTeamSteeringReceipts.get(receipt.id)).toMatchObject({
      status: "delivered",
    })
    await completeDisposed(dispatch, { text: "inspected" })
    expect(await getDb().agentTeamSteeringReceipts.get(receipt.id)).toMatchObject({
      status: "applied",
    })
  })

  it("requires a settled revision and binds verification to the workspace snapshot", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-revision")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-revision",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-call",
      id: "test",
      toolName: "Bash",
      input: { command: "pnpm test" },
    })
    dispatch.capture({
      type: "tool-result",
      id: "test",
      toolName: "Bash",
      result: "passed",
      isError: false,
    })
    await completeDisposed(dispatch, {
      text: "done",
      diffContent: "changes",
      workspaceRevision: "workspace:sha256:snapshot",
    })
    const evidence = await getDb()
      .agentTeamEvidence.where("childRunId")
      .equals(dispatch.childRunId)
      .toArray()
    expect(evidence.find((item) => item.kind === "test")).toMatchObject({
      revision: "workspace:sha256:snapshot",
      status: "passed",
    })
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "completed",
    })
  })

  it("rejects code results without a verifiable workspace revision", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-no-revision")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-no-revision",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-result",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "passed",
      isError: false,
    })
    await expect(
      completeDisposed(dispatch, { text: "done", diffContent: "changes" })
    ).rejects.toThrow("revision")
  })

  it.each([
    "completed",
    "failed",
    "cancelled",
    "terminated",
    "paused",
    "pausing",
    "sleeping",
    "needs_input",
  ])("does not revive a %s child on late completion or worker waiting", async (status) => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-late")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-late",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    await getDb().agentTeamChildRuns.update(dispatch.childRunId, { status: status as "completed" })
    await expect(dispatch.complete({ text: "late" })).rejects.toThrow("no longer active")
    await expect(dispatch.wait("worker unavailable", "host")).rejects.toThrow("no longer active")
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({ status })
  })

  it("records write-ahead tool trajectory, evidence, usage and a safe checkpoint", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-1")
    let currentTime = 20
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-1",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
      now: () => currentTime,
    })
    dispatch.capture({
      type: "tool-call",
      id: "tool-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
    })
    currentTime = 55
    dispatch.capture({
      type: "tool-result",
      id: "tool-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "7 passed",
      isError: false,
    })
    currentTime = 80
    await completeDisposed(dispatch, {
      text: "Implemented and verified",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.0123,
      commitSha: "abc123",
    })

    const child = await getDb().agentTeamChildRuns.get(dispatch.childRunId)
    expect(child).toMatchObject({
      status: "completed",
      resourceUsage: {
        totalTokens: 15,
        costUsd: 0.0123,
        toolTimeMs: 35,
        attempts: 1,
        failures: 0,
      },
    })
    expect(
      (await getDb().agentTeamTrajectory.where("runId").equals("run-1").toArray()).map(
        (e) => e.kind
      )
    ).toEqual(
      expect.arrayContaining(["tool_intent", "tool_result", "model_turn_completed", "checkpoint"])
    )
    expect(
      (await getDb().agentTeamEvidence.where("taskId").equals("task").toArray()).map((e) => e.kind)
    ).toEqual(expect.arrayContaining(["activity", "outcome", "test", "commit"]))
    const checkpoints = await getDb().agentTeamCheckpoints.where("runId").equals("run-1").toArray()
    expect(checkpoints).toHaveLength(3)
    expect(checkpoints.filter((checkpoint) => checkpoint.replay === "needs_input")).toHaveLength(1)
    expect(checkpoints.filter((checkpoint) => checkpoint.replay === "safe")).toHaveLength(2)
  })

  /**
   * The durable record stays on the host; the execution run is what a paired
   * device syncs, so the spend has to land on its snapshot too.
   */
  it("reports the run's spend onto its remote-safe execution snapshot", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-usage")
    let currentTime = 20
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-usage",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
      now: () => currentTime,
    })
    currentTime = 80
    await completeDisposed(dispatch, {
      text: "Read it",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.0123,
    })

    const run = await getDb().executionRuns.get("execution:team:run-usage")
    expect(run?.latestSnapshot?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.0123,
      wallTimeMs: 60,
    })
    const events = await getDb()
      .executionRunEvents.where("runId")
      .equals("execution:team:run-usage")
      .toArray()
    const usage = events.find((event) => event.type === "usage.reported")
    expect(usage?.visibility).toBe("summary")
    // Counts only: nothing from the launch constraints rides along.
    expect(Object.keys(usage?.payload ?? {}).sort()).toEqual(
      ["completionTokens", "costUsd", "promptTokens", "totalTokens", "wallTimeMs"].sort()
    )
  })

  it("redacts tool payloads before trajectory and evidence persistence", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 30 })
    await coordinator.prepareRun(team, "run-redact")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team: {
        ...team,
        config: {
          ...team.config,
          evidencePolicy: {
            requireActivity: true,
            requireOutcome: true,
            requireCodeDiff: false,
            requireVerification: false,
            requireVisualForUi: false,
          },
        },
      },
      runId: "run-redact",
      teammateId: "mate",
      taskId: "task-redact",
      access: "read",
      repositoryId: "primary",
      now: () => 31,
    })
    dispatch.capture({
      type: "tool-call",
      id: "secret-tool",
      toolName: "Bash",
      input: { command: "echo user@example.com" },
    })
    dispatch.capture({
      type: "tool-result",
      id: "secret-tool",
      toolName: "Bash",
      input: { command: "echo user@example.com" },
      result: "user@example.com",
      isError: false,
    })
    await completeDisposed(dispatch, { text: "Finished" })

    const trajectory = await getDb()
      .agentTeamTrajectory.where("runId")
      .equals("run-redact")
      .toArray()
    expect(JSON.stringify(trajectory)).not.toContain("user@example.com")
    const objects = await getDb().agentTeamContentObjects.toArray()
    expect(objects.map((object) => new TextDecoder().decode(object.data)).join("\n")).not.toContain(
      "user@example.com"
    )
  })

  it("preserves attempt and failure accounting when a child resumes", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 35 })
    await coordinator.prepareRun(team, "run-retry")
    const first = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-retry",
      teammateId: "mate",
      taskId: "task-retry",
      access: "read",
      repositoryId: "primary",
      now: () => 36,
    })
    await first.fail(new Error("provider unavailable"))
    await acknowledge(coordinator, first.childRunId)

    const resumed = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-retry",
      teammateId: "mate",
      taskId: "task-retry",
      access: "read",
      repositoryId: "primary",
      now: () => 37,
    })
    expect(resumed.childRunId).toBe(first.childRunId)
    await completeDisposed(resumed, { text: "Recovered result" })

    const child = await getDb().agentTeamChildRuns.get(resumed.childRunId)
    expect(child?.resourceUsage).toMatchObject({ attempts: 2, failures: 1 })
  })

  it("refreshes queued children to the latest accepted decision version at the turn boundary", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 38 })
    await coordinator.prepareRun(team, "run-decisions")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-decisions",
      teammateId: "mate",
      taskId: "task-decisions",
      access: "write",
      repositoryId: "primary",
      now: () => 39,
    })
    const ledger = createDecisionLedger({
      store: runtimeDb.dexieTeamRunStore,
      runId: "run-decisions",
      leadId: "lead",
      now: () => 40,
    })
    await getDb().agentTeamEvidence.put({
      id: "evidence-1",
      runId: "run-decisions",
      childRunId: dispatch.childRunId,
      taskId: "task-decisions",
      kind: "activity",
      title: "Migration inspection",
      createdAt: 40,
    })
    const proposal = await ledger.propose({
      authorId: "mate",
      title: "Migration strategy",
      detail: "Use an additive migration",
      evidenceIds: ["evidence-1"],
    })
    await ledger.accept(proposal.id, "lead")

    const context = await dispatch.prepareTurnContext()
    expect(context).toContain("DECISION v1")
    expect(context).toContain("Use an additive migration")
    expect((await getDb().agentTeamChildRuns.get(dispatch.childRunId))?.decisionVersion).toBe(1)
  })

  it("unifies provider and local environment lifecycle control for a durable child", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 40 })
    await coordinator.prepareRun(team, "run-control")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-control",
      teammateId: "mate",
      taskId: "task-control",
      access: "read",
      repositoryId: "primary",
      now: () => 41,
    })
    const settle = jest.fn(async () => [])
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      executeSetup: async () => ({ success: true }),
      openWorkspace: async () => ({ executionRoot: "/worktree", settle }),
    })
    const profile: ProjectEnvironmentVersion = {
      id: "env:v1",
      environmentId: "env",
      projectId: "project",
      version: 1,
      name: "Local",
      setupScript: { default: "" },
      actions: [],
      variables: {},
      keyringReferences: [],
      policy: { requiredRuntimeCapabilities: ["filesystem"] },
      createdAt: 1,
    }
    const prepared = await environment.prepare(profile, "/repo")
    await environment.openChild({
      runId: "run-control",
      childRunId: dispatch.childRunId,
      taskId: "task-control",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    })
    dispatch.attachEnvironment(environment)
    const pause = jest.fn(async () => undefined)
    const resume = jest.fn(async () => undefined)
    const terminate = jest.fn(async () => ({
      kind: "ack" as const,
      epoch: dispatch.dispatchEpoch,
      at: 42,
    }))
    await dispatch.attachControl({
      steer: async () => undefined,
      pause,
      resume,
      terminate,
      resumeStartsExecution: false,
    })

    await coordinator.pauseChild(dispatch.childRunId)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("suspended")
    await coordinator.checkpoint(dispatch.childRunId, {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })
    await coordinator.resumeChild(dispatch.childRunId)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("running")
    await coordinator.terminateChild(dispatch.childRunId)

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("terminated")
    expect(settle).toHaveBeenCalledWith("cancelled")
  })

  it("keeps an unavailable remote child queued and marks the run as waiting", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 50 })
    await coordinator.prepareRun(team, "run-waiting")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-waiting",
      teammateId: "mate",
      taskId: "task-waiting",
      access: "read",
      repositoryId: "primary",
      now: () => 51,
    })

    await dispatch.wait("pinned_host_offline", "device:worker-a")

    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "queued",
      hostRef: "device:worker-a",
      waitingReason: "pinned_host_offline",
    })
    expect(await getDb().agentTeamRuns.get("run-waiting")).toMatchObject({
      status: "needs_input",
      recoveryReason: "worker_waiting:pinned_host_offline",
    })
  })

  it("records a safe durable checkpoint after remote pause reaches idle", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 60 })
    await coordinator.prepareRun(team, "run-pause-checkpoint")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-pause-checkpoint",
      teammateId: "mate",
      taskId: "task-pause-checkpoint",
      access: "read",
      repositoryId: "primary",
      now: () => 61,
    })

    await expect(dispatch.checkpointPause()).resolves.toBe(true)
    const checkpoint = await getDb()
      .agentTeamCheckpoints.where("childRunId")
      .equals(dispatch.childRunId)
      .last()
    expect(checkpoint).toMatchObject({ replay: "safe", sideEffects: [] })
  })
})
