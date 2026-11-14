import type {
  AgentEventEnvelope,
  AgentWorkerManifestV1,
  CogniaClient,
  CogniaClientOptions,
  HandoffEnvelope,
} from "@cognia/agent"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

import { selectRemoteWorker } from "./remote-worker-runtime"
import { WorkerRpcPool, WorkerDetachedError } from "./worker-rpc-pool"
import { createCogniaClient } from "@cognia/agent"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "@cognia/agent/protocol"

const manifest: AgentWorkerManifestV1 = {
  manifestVersion: 1,
  runtime: "test",
  models: [],
  hardCapabilities: [],
  maxActiveTurns: 1,
  credentialProfileRefs: [],
  workspaceBindingRefs: [],
  taskWorkspace: { enabled: true },
  sandbox: { capabilities: [] },
  platform: { os: "test", arch: "test" },
  executionProfile: {
    profileVersion: 1,
    backendId: "test",
    runtimeAdapter: "external",
    modelBindings: { primary: "inherit" },
    deploymentRefs: ["provider:test"],
    capabilities: [],
  },
}

const executionSpec: ResolvedAgentExecutionSpec = {
  specVersion: 2,
  identity: { sessionId: "session", runId: "run", attemptId: "a1" },
  executionFingerprint: "aexf1-test",
  executionKind: "agent",
  runtimeAdapter: "external",
  runtimePolicySource: "legacy-mapped",
  deploymentRef: "provider:test",
  modelBindings: { primary: "inherit" },
  route: { kind: "direct", routePolicy: "direct" },
  hostRef: "headless-agent-host",
  compatibility: { evidence: "native" },
  capabilities: { effective: ["streaming"], disabledOptional: [] },
  credential: { profileRef: "credential:test", affinity: "sticky-with-failover" },
  fallbackPolicy: "none",
}

const safeHandoff: HandoffEnvelope = {
  envelopeVersion: 1,
  identity: {
    parentRunId: "team-run",
    childRunId: "child-run",
    depth: 1,
    parentChain: ["team-run"],
  },
  task: { prompt: "do the thing" },
  execution: { mode: "orchestrated" },
  resources: [],
  createdAt: "2026-08-12T00:00:00.000Z",
}

describe("WorkerRpcPool", () => {
  it("uses authenticated attach identity and transports RPC frames opaquely", async () => {
    const sent: string[] = []
    let now = 10
    const createClient = jest.fn(
      (_options: CogniaClientOptions) => new Promise<CogniaClient>(() => undefined)
    )
    const pool = new WorkerRpcPool({
      sendFrame: (_connectionId, frame) => sent.push(frame),
      now: () => now,
      createClient: createClient as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })
    expect(pool.listWorkers()).toEqual([
      expect.objectContaining({ hostRef: "device:trusted", online: true, lastSeenAt: 10 }),
    ])

    const streams = createClient.mock.calls[0]?.[0]?.host
    expect(streams).toMatchObject({ kind: "streams" })
    if (!streams || streams.kind !== "streams") throw new Error("missing streams")
    streams.writable.write('{"jsonrpc":"2.0","id":1}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual(['{"jsonrpc":"2.0","id":1}'])

    now = 20
    pool.receive("connection-1", '{"jsonrpc":"2.0","id":1,"result":{}}')
    pool.receive("missing", "ignored")
    pool.receive("connection-1", "two\nframes")
    expect(pool.listWorkers()[0]?.lastSeenAt).toBe(20)
    pool.detach("connection-1", "offline")
    expect(pool.listWorkers()).toEqual([])
  })

  it("turns a synchronous host send failure into detach without throwing from the frame sink", async () => {
    // Host delivery errors must not enter RpcPeer's synchronous write/error race.
    let host: Extract<NonNullable<CogniaClientOptions["host"]>, { kind: "streams" }> | undefined
    const createClient = jest.fn((options: CogniaClientOptions) => {
      if (options.host?.kind === "streams") host = options.host
      return new Promise<CogniaClient>(() => undefined)
    })
    const pool = new WorkerRpcPool({
      sendFrame: () => {
        throw "bridge failed"
      },
      createClient: createClient as never,
    })
    pool.attach({ connectionId: "connection-error", hostRef: "device:error", manifest })
    const streams = host
    if (!streams) throw new Error("missing streams")
    const errors: Error[] = []
    streams.writable.on("error", (error: Error) => errors.push(error))

    expect(streams.writable.write("frame\n")).toBe(true)
    expect(errors).toEqual([])
    expect(pool.listWorkers()).toEqual([])
  })

  it("replaces an older connection for the same authenticated host", () => {
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (() => new Promise<CogniaClient>(() => undefined)) as never,
    })
    pool.attach({ connectionId: "old", hostRef: "device:a", manifest })
    pool.attach({ connectionId: "new", hostRef: "device:a", manifest })
    expect(pool.listWorkers()).toEqual([expect.objectContaining({ connectionId: "new" })])
  })

  it("rejects malformed worker manifests before placement", () => {
    const pool = new WorkerRpcPool({ sendFrame: jest.fn() })
    expect(
      pool.attach({
        connectionId: "malformed",
        hostRef: "device:trusted",
        manifest: { ...manifest, maxActiveTurns: 0 },
      })
    ).toBe(false)
    expect(pool.listWorkers()).toEqual([])
  })

  it("fails closed before RPC dispatch when prompt or handoff content leaks PII", async () => {
    const createSession = jest.fn()
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: createSession, open: jest.fn() },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })

    await expect(
      pool.run({
        hostRef: "device:trusted",
        commandId: "lease-pii",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "Contact alice@example.com" },
          execution: { mode: "orchestrated" },
          resources: [],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })
    ).rejects.toThrow("PII redaction gate")
    expect(createSession).not.toHaveBeenCalled()
    expect(pool.listWorkers()[0]?.activeTurns).toBe(0)
  })

  it("fails closed before sending a steering message that leaks PII", async () => {
    const steer = jest.fn()
    const run = jest.fn()
    const session = {
      id: "session-1",
      events: async function* () {},
      run,
      steer,
      abort: jest.fn(),
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: jest.fn(async () => session), open: jest.fn(async () => session) },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })

    await expect(
      pool.run({
        hostRef: "device:trusted",
        commandId: "lease-steer",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          resources: [],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: async (control) => control.steer("Contact alice@example.com", "steer-1"),
      })
    ).rejects.toThrow("PII redaction gate")
    expect(steer).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("fills two one-slot workers without creating a second scheduler", async () => {
    const releases: Array<() => void> = []
    const close = jest.fn(async () => undefined)
    let sessionSequence = 0
    const createClient = jest.fn(async (): Promise<CogniaClient> => {
      sessionSequence += 1
      const sessionId = `session-${sessionSequence}`
      const session = {
        id: sessionId,
        events: async function* () {},
        run: jest.fn(
          () =>
            new Promise((resolve) => {
              releases.push(() => resolve({ status: "completed", result: {} }))
            })
        ),
        steer: jest.fn(),
        abort: jest.fn(),
        state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
        waitForIdle: jest.fn(),
        snapshot: jest.fn(),
        close,
      }
      return {
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      } as unknown as CogniaClient
    })
    const dispatchManifest: AgentWorkerManifestV1 = {
      ...manifest,
      hardCapabilities: ["tools"],
      credentialProfileRefs: ["credential:test"],
      workspaceBindingRefs: ["repository:project:repo"],
      sandbox: { capabilities: ["filesystem"] },
      executionProfile: { ...manifest.executionProfile!, capabilities: ["streaming"] },
    }
    const onWorkersChanged = jest.fn()
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient,
      onWorkersChanged,
    })
    pool.attach({ connectionId: "connection-b", hostRef: "device:b", manifest: dispatchManifest })
    pool.attach({ connectionId: "connection-a", hostRef: "device:a", manifest: dispatchManifest })
    const requirements = {
      spec: executionSpec,
      workspaceBindingRef: "repository:project:repo",
      requiredSandboxCapabilities: ["filesystem"],
    }
    const run = (hostRef: string, commandId: string) =>
      pool.run({
        hostRef,
        commandId,
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: commandId,
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: commandId },
          execution: { mode: "orchestrated" },
          resources: [{ kind: "repository", ref: "repository:project:repo" }],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: commandId,
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })

    const first = selectRemoteWorker(pool.listWorkers(), { mode: "auto" }, requirements)
    const firstRun = run(first.hostRef, "lease-1")
    await new Promise((resolve) => setImmediate(resolve))
    await expect(run(first.hostRef, "lease-over-capacity")).rejects.toThrow("capacity is exhausted")
    const second = selectRemoteWorker(pool.listWorkers(), { mode: "auto" }, requirements)
    const secondRun = run(second.hostRef, "lease-2")
    await new Promise((resolve) => setImmediate(resolve))

    expect([first.hostRef, second.hostRef]).toEqual(["device:a", "device:b"])
    expect(pool.listWorkers().map((worker) => worker.activeTurns)).toEqual([1, 1])
    expect(onWorkersChanged).toHaveBeenCalledWith([
      expect.objectContaining({ activeTurns: 1 }),
      expect.objectContaining({ activeTurns: 1 }),
    ])
    releases.splice(0).forEach((release) => release())
    expect(await Promise.all([firstRun, secondRun])).toEqual([
      { status: "completed", result: {} },
      { status: "completed", result: {} },
    ])
    expect(close).toHaveBeenCalledTimes(2)
    // Legacy close() has no current-epoch disposal ACK; never invent one.
    expect(pool.listWorkers().map((worker) => worker.activeTurns)).toEqual([0, 0])
  })

  it("routes recovery, replay, steering, and termination through CogniaSession methods", async () => {
    const steer = jest.fn(async () => undefined)
    const abort = jest.fn(async () => undefined)
    const waitForIdle = jest.fn(async () => undefined)
    const close = jest.fn(async () => undefined)
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-replayed",
      sequence: 2,
      sessionId: "session-recovery",
      runId: "run-recovery",
      attemptId: "attempt-2",
      turnId: "turn-recovery",
      timestamp: "2026-08-12T00:00:00.000Z",
      hostRef: "device:recovery",
      runtime: "builtin",
      event: { kind: "lifecycle" as const, phase: "started" as const },
    }
    const events = jest.fn(async function* () {
      yield event
    })
    const run = jest.fn(async () => ({ status: "completed", result: {} }))
    const session = {
      id: "session-recovery",
      events,
      run,
      steer,
      abort,
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle,
      snapshot: jest.fn(),
      close,
    }
    const create = jest.fn()
    const open = jest.fn(async () => session)
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({ sessions: { create, open }, close: jest.fn() })) as never,
    })
    pool.attach({ connectionId: "connection-recovery", hostRef: "device:recovery", manifest })
    const controller = new AbortController()
    const onEvent = jest.fn()

    await expect(
      pool.run({
        hostRef: "device:recovery",
        recoverySessionId: "session-recovery",
        lastRemoteEventId: "event-before",
        commandId: "lease-recovery",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-recovery",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        maxSteps: 2,
        signal: controller.signal,
        onSession: jest.fn(),
        onEvent,
        onControl: async (control) => {
          await control.steer("safe steering", "steer-1")
          void control.pause("pause-1")
          await control.terminate("terminate-1")
        },
      })
    ).resolves.toEqual({ status: "completed", result: {} })

    expect(create).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("session-recovery")
    expect(steer).toHaveBeenCalledWith("safe steering", { commandId: "steer-1" })
    expect(abort).toHaveBeenCalledWith({ commandId: "terminate-1" })
    expect(waitForIdle).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ afterEventId: "event-before", signal: expect.any(AbortSignal) })
    )
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(run).toHaveBeenCalledWith(
      "safe prompt",
      expect.objectContaining({
        commandId: "lease-recovery",
        maxSteps: 2,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("rejects dispatch to an unavailable host", async () => {
    const pool = new WorkerRpcPool({ sendFrame: jest.fn() })
    await expect(
      pool.run({
        hostRef: "device:missing",
        commandId: "lease-missing",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })
    ).rejects.toThrow("Worker is offline")
  })

  it("pauses cooperatively without aborting, snapshotting, or reopening the session", async () => {
    const abort = jest.fn()
    const waitForIdle = jest.fn(async () => undefined)
    const snapshot = jest.fn()
    const open = jest.fn()
    const session = {
      id: "session-pause",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: {} })),
      steer: jest.fn(),
      abort,
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle,
      snapshot,
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: jest.fn(async () => session), open },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-pause", hostRef: "device:pause", manifest })

    await pool.run({
      hostRef: "device:pause",
      commandId: "lease-pause",
      handoff: {
        envelopeVersion: 1,
        identity: {
          parentRunId: "team-run",
          childRunId: "child-run",
          depth: 1,
          parentChain: ["team-run"],
        },
        task: { prompt: "safe prompt" },
        execution: { mode: "orchestrated" },
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      prompt: "safe prompt",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: (control) => {
        void control.pause("pause-1")
      },
    })

    expect(waitForIdle).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
  it("reports a worker still holding an unresolved request as recovery-required", async () => {
    const session = {
      id: "session-recovery",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: { status: "completed" } })),
      steer: jest.fn(),
      state: jest.fn(async () => ({
        sessionId: "session-recovery",
        status: "recovery_required" as const,
      })),
      abort: jest.fn(),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-recovery-2", hostRef: "device:recovery", manifest })

    const outcome = await pool.run({
      hostRef: "device:recovery",
      commandId: "lease-recovery",
      handoff: safeHandoff,
      prompt: "do the thing",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: jest.fn(),
    })

    // The turn itself completed; the worker is still waiting on an operator.
    expect(outcome.status).toBe("completed")
    expect(outcome.recoveryRequired).toBe(true)
  })

  it("leaves the recovery flag off an ordinary completed turn", async () => {
    const session = {
      id: "session-clean",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: { status: "completed" } })),
      steer: jest.fn(),
      state: jest.fn(async () => ({ sessionId: "session-clean", status: "idle" as const })),
      abort: jest.fn(),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-clean", hostRef: "device:clean", manifest })

    const outcome = await pool.run({
      hostRef: "device:clean",
      commandId: "lease-clean",
      handoff: safeHandoff,
      prompt: "do the thing",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: jest.fn(),
    })
    expect(outcome.recoveryRequired).toBeUndefined()
  })
})

describe("WorkerRpcPool stop evidence", () => {
  function harness(
    capabilities: string[] = ["worker-self-fence-v1", "turn-interrupt-v1", "event-replay-v2"]
  ) {
    let now = 1_000
    let finish!: (outcome: { status: string; result: object }) => void
    const session = {
      id: "fresh-session",
      events: jest.fn(async function* (): AsyncGenerator<AgentEventEnvelope> {}),
      run: jest.fn(
        (_prompt: string, _options: import("@cognia/agent").RunOptions) =>
          new Promise<{ status: string; result: object }>((resolve) => {
            finish = resolve
          })
      ),
      renew: jest.fn(async () => ({ renewed: true })),
      abort: jest.fn(async () => ({
        stopped: true,
        turnStatus: "aborted",
        sessionStatus: "idle",
        targetTurnCommandId: "turn-1",
        dispatchEpoch: 7,
        followUpsDropped: 0,
      })),
      state: jest.fn(async () => ({ status: "idle" })),
      // The persisted head a strict stop drains through; none by default.
      entries: jest.fn(async () => ({ entries: [], headEventId: undefined as string | undefined })),
      close: jest.fn(async () => undefined),
      steer: jest.fn(),
      waitForIdle: jest.fn(),
    }
    let streams!: Extract<NonNullable<CogniaClientOptions["host"]>, { kind: "streams" }>
    const sendFrame = jest.fn()
    const supports = jest.fn((capability: string) => capabilities.includes(capability))
    const create = jest.fn(async () => session)
    const open = jest.fn(async () => session)
    const pool = new WorkerRpcPool({
      sendFrame,
      now: () => now,
      strictStopDrainTimeoutMs: 50,
      createClient: (async (options: CogniaClientOptions) => {
        streams = options.host as typeof streams
        return { sessions: { create, open }, runtime: { supports }, close: jest.fn() }
      }) as never,
    })
    pool.attach({
      connectionId: "connection",
      hostRef: "device:test",
      manifest: {
        ...manifest,
        executionProfile: {
          ...manifest.executionProfile!,
          runtimeAdapter: "ai-sdk",
          capabilities: ["streaming"],
        },
        credentialProfileRefs: ["credential:test"],
        workspaceBindingRefs: ["repository:project:repo"],
        hardCapabilities: capabilities as never,
        fenceGraceMs: 30_000,
      },
    })
    let control!: import("./remote-worker-runtime").RemoteWorkerTurnControl
    const input = {
      hostRef: "device:test",
      commandId: "turn-1",
      dispatchEpoch: 7,
      handoff: safeHandoff,
      prompt: "safe prompt",
      fence: {
        childRunId: "child-run",
        dispatchEpoch: 7,
        lastRenewalSentAt: 500,
        leaseTtlMs: 60_000,
      },
      onSession: jest.fn(),
      onEvent: jest.fn<Promise<void>, [AgentEventEnvelope]>(async () => undefined),
      onControl: (next: typeof control) => {
        control = next
      },
    }
    return {
      pool,
      session,
      create,
      open,
      input,
      sendFrame,
      supports,
      streams: () => streams,
      control: () => control,
      setNow: (value: number) => {
        now = value
      },
      finish: (status = "completed") => finish({ status, result: {} }),
      ready: () => new Promise<void>((resolve) => setImmediate(resolve)),
    }
  }

  it("computes the remaining run TTL when the client reads the fence to write its frame", async () => {
    const h = harness()
    const running = h.pool.run(h.input)
    await h.ready()
    h.setNow(2_000)
    const options = h.session.run.mock.calls[0]![1]
    expect(options.fence).toEqual({ childRunId: "child-run", dispatchEpoch: 7, leaseTtlMs: 58_500 })
    h.finish()
    await running
  })

  it("pushes the remaining renewal TTL and rejects a refused renewal", async () => {
    const h = harness()
    const running = h.pool.run(h.input)
    await h.ready()
    h.setNow(22_000)
    await h.control().renew!({ ...h.input.fence, lastRenewalSentAt: 20_000 })
    expect(h.session.renew).toHaveBeenCalledWith(
      {
        childRunId: "child-run",
        dispatchEpoch: 7,
        leaseTtlMs: 58_000,
      },
      { signal: expect.any(AbortSignal) }
    )
    h.session.renew.mockResolvedValueOnce({ renewed: false })
    const failedRun = expect(running).rejects.toThrow("renewal")
    await expect(h.control().renew!(h.input.fence)).rejects.toThrow("renewal")
    await failedRun
  })

  it("fails an in-flight run with its detach reason even if the fake client never settles", async () => {
    const h = harness()
    const running = h.pool.run(h.input)
    const observed = expect(running).rejects.toMatchObject({
      name: "WorkerDetachedError",
      connectionId: "connection",
      reason: "authority_revoked",
    })
    await h.ready()
    h.pool.detach("connection", "authority_revoked")
    await observed
    expect(new WorkerDetachedError("connection", "socket_closed")).toBeInstanceOf(Error)
  })

  it.each([
    [true, "turn-1", 7, true],
    [false, "turn-1", 7, false],
    [true, "other-turn", 7, false],
    [true, "turn-1", 6, false],
  ])(
    "accepts terminate evidence only for the stopped target and epoch (%s, %s, %s)",
    async (stopped, target, epoch, confirmed) => {
      const h = harness()
      const running = h.pool.run(h.input)
      await h.ready()
      h.session.abort.mockResolvedValueOnce({
        stopped,
        turnStatus: "aborted",
        sessionStatus: "idle",
        targetTurnCommandId: target,
        dispatchEpoch: epoch,
        followUpsDropped: 0,
      })
      const proof = await h.control().terminate("terminate-1")
      expect(proof).toEqual(confirmed ? { kind: "ack", epoch: 7, at: 1_000 } : undefined)
      expect(h.session.abort).toHaveBeenCalledWith(
        expect.objectContaining({ targetTurnCommandId: "turn-1", dispatchEpoch: 7 })
      )
      expect(h.session.close).toHaveBeenCalledTimes(confirmed ? 1 : 0)
      h.finish("aborted")
      await running
    }
  )

  it("obtains a completed-turn disposal receipt", async () => {
    const h = harness()
    h.session.abort.mockResolvedValueOnce({
      stopped: true,
      turnStatus: "completed",
      sessionStatus: "idle",
      targetTurnCommandId: "turn-1",
      dispatchEpoch: 7,
      followUpsDropped: 0,
    })
    const running = h.pool.run(h.input)
    await h.ready()
    h.finish()
    await expect(running).resolves.toMatchObject({
      disposalProof: { kind: "ack", epoch: 7, at: 1_000 },
    })
  })

  it("uses plain abort and no fence or disposal proof on an old Worker", async () => {
    const h = harness([])
    const running = h.pool.run({ ...h.input, fence: undefined })
    await h.ready()
    await expect(h.control().terminate("terminate-old")).resolves.toBeUndefined()
    expect(h.session.abort).toHaveBeenCalledWith({ commandId: "terminate-old" })
    expect(h.session.close).not.toHaveBeenCalled()
    expect(h.session.run.mock.calls[0]![1].fence).toBeUndefined()
    h.finish()
    await expect(running).resolves.not.toHaveProperty("disposalProof")
  })

  it("creates a fresh recovery session for a fenced Worker without replaying the old cursor", async () => {
    const h = harness()
    const running = h.pool.run({
      ...h.input,
      recoverySessionId: "fenced-session",
      lastRemoteEventId: "old-cursor",
    })
    await h.ready()
    expect(h.open).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledWith({ commandId: "turn-1", handoff: safeHandoff })
    h.finish()
    await running
  })

  it.each(["capability", "credential"])(
    "rechecks a %s lost after placement and before client initialization",
    async (lost) => {
      const h = harness()
      const requirements = {
        spec: { ...executionSpec, runtimeAdapter: "ai-sdk" as const },
        workspaceBindingRef: "repository:project:repo",
        requiredSandboxCapabilities: [],
      }
      selectRemoteWorker(h.pool.listWorkers(), { mode: "auto" }, requirements)
      const current = h.pool.listWorkers()[0]!.manifest
      if (lost === "capability") current.executionProfile!.capabilities.splice(0)
      else current.credentialProfileRefs.splice(0)
      await expect(h.pool.run({ ...h.input, placementRequirements: requirements })).rejects.toThrow(
        lost === "capability" ? "capability_mismatch" : "credential_missing"
      )
      expect(h.create).not.toHaveBeenCalled()
    }
  )

  it("rechecks compatibility and remaining TTL at the stream write after an async cursor read", async () => {
    const h = harness()
    const requirements = {
      spec: { ...executionSpec, runtimeAdapter: "ai-sdk" as const },
      workspaceBindingRef: "repository:project:repo",
      requiredSandboxCapabilities: [],
    }
    const running = h.pool.run({ ...h.input, placementRequirements: requirements })
    await h.ready()
    h.setNow(3_000)
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/run",
      params: {
        sessionId: "fresh-session",
        commandId: "turn-1",
        fence: { childRunId: "child-run", dispatchEpoch: 7, leaseTtlMs: 60_000 },
      },
    })
    h.streams().writable.write(frame + "\n")
    expect(JSON.parse(h.sendFrame.mock.calls[0]![1]).params.fence.leaseTtlMs).toBe(57_500)
    const observed = expect(running).rejects.toThrow("credential_missing")
    const errors: Error[] = []
    h.streams().writable.on("error", (error: Error) => errors.push(error))
    h.pool.listWorkers()[0]!.manifest.credentialProfileRefs.splice(0)
    h.streams().writable.write(frame + "\n")
    expect(errors).toEqual([])
    expect(h.sendFrame).toHaveBeenCalledTimes(1)
    await observed
  })

  it.each([true, false])(
    "strict pause reports its actual stop receipt (stopped=%s)",
    async (stopped) => {
      const h = harness()
      const running = h.pool.run(h.input)
      await h.ready()
      h.session.abort.mockResolvedValueOnce({
        stopped,
        turnStatus: "aborted",
        sessionStatus: "idle",
        targetTurnCommandId: "turn-1",
        dispatchEpoch: 7,
        followUpsDropped: 0,
      })
      await expect(h.control().pause("pause-1")).resolves.toEqual(
        stopped ? { kind: "ack", epoch: 7, at: 1_000 } : false
      )
      h.finish("aborted")
      await running
    }
  )

  it.each(["detach", "abort", "failure"])(
    "old Worker pause ends unconfirmed on %s",
    async (failure) => {
      const h = harness([])
      const controller = new AbortController()
      const running = h.pool.run({ ...h.input, fence: undefined, signal: controller.signal })
      const observed = running.catch(() => undefined)
      await h.ready()
      const pausing = h.control().pause("pause-after-turn")
      if (failure === "detach") h.pool.detach("connection", "socket_closed")
      else if (failure === "abort") controller.abort(new Error("lease lost"))
      else h.finish("failed")
      await expect(pausing).resolves.toBe(false)
      await observed
      expect(h.session.abort).not.toHaveBeenCalled()
      expect(h.session.waitForIdle).not.toHaveBeenCalled()
    }
  )

  it("lets pause_after_turn wait beyond thirty seconds and confirm a clean completion", async () => {
    const h = harness([])
    const running = h.pool.run({ ...h.input, fence: undefined })
    await h.ready()
    const pausing = h.control().pause("pause-after-turn")
    h.setNow(40_000)
    expect(h.session.waitForIdle).not.toHaveBeenCalled()
    h.finish()
    await expect(pausing).resolves.toBe(true)
    await running
  })

  it("preserves a completed turn while a pending renewal is refused before its disposal receipt arrives", async () => {
    const h = harness()
    let complete!: () => void
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    let failRenewal!: (error: Error) => void
    h.session.renew.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRenewal = reject
        })
    )
    let receipt!: (value: {
      stopped: boolean
      turnStatus: string
      sessionStatus: string
      targetTurnCommandId: string
      dispatchEpoch: number
      followUpsDropped: number
    }) => void
    h.session.abort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          receipt = resolve
        })
    )
    const running = h.pool.run({ ...h.input, onTurnCompleted: complete })
    await h.ready()
    const renewing = h.control().renew!(h.input.fence).catch((error: unknown) => error)
    h.finish()
    await completed
    await h.ready()
    failRenewal(new Error("session stopped after completion"))
    await expect(renewing).resolves.toBeInstanceOf(Error)
    expect(h.session.run.mock.calls[0]![1].signal?.aborted).toBe(false)
    receipt({
      stopped: true,
      turnStatus: "completed",
      sessionStatus: "idle",
      targetTurnCommandId: "turn-1",
      dispatchEpoch: 7,
      followUpsDropped: 0,
    })
    await expect(running).resolves.toMatchObject({ disposalProof: { kind: "ack", epoch: 7 } })
  })

  it("refuses dispatch when the RPC handshake does not confirm the manifest's fence capability", async () => {
    const h = harness()
    h.supports.mockReturnValue(false)
    await expect(h.pool.run(h.input)).rejects.toThrow("RPC does not declare worker-self-fence-v1")
    expect(h.session.run).not.toHaveBeenCalled()
  })

  it.each([
    [false, "completed", "turn-1", 7],
    [true, "aborted", "turn-1", 7],
    [true, "completed", "other-turn", 7],
    [true, "completed", "turn-1", 6],
  ])(
    "does not certify completion from an unconfirmed or mismatched receipt (%s, %s, %s, %s)",
    async (stopped, turnStatus, targetTurnCommandId, dispatchEpoch) => {
      const h = harness()
      const running = h.pool.run(h.input)
      await h.ready()
      h.session.abort.mockResolvedValueOnce({
        stopped,
        turnStatus,
        targetTurnCommandId,
        dispatchEpoch,
        sessionStatus: "idle",
        followUpsDropped: 0,
      })
      h.finish()
      await expect(running).resolves.not.toHaveProperty("disposalProof")
      expect(h.session.close).toHaveBeenCalledTimes(1)
    }
  )

  it("settles a pending strict pause as unconfirmed on detach", async () => {
    const h = harness()
    const running = h.pool.run(h.input)
    const observed = running.catch(() => undefined)
    await h.ready()
    h.session.abort.mockImplementationOnce(() => new Promise(() => undefined))
    const pausing = h.control().pause("pause-lost")
    h.pool.detach("connection", "socket_closed")
    await expect(pausing).resolves.toBe(false)
    await observed
  })

  it("drains accepted remote events before confirming a strict pause for checkpointing", async () => {
    const h = harness()
    let finishProjection!: () => void
    const projected = new Promise<void>((resolve) => {
      finishProjection = resolve
    })
    h.session.events.mockImplementation(async function* () {
      yield { eventId: "event-final", sequence: 1, event: { kind: "text-delta", delta: "final" } }
    })
    h.input.onEvent.mockImplementationOnce(() => projected)
    h.session.entries.mockResolvedValue({ entries: [], headEventId: "event-final" })
    const running = h.pool.run(h.input)
    await h.ready()
    let confirmed = false
    const pausing = h
      .control()
      .pause("pause-drain")
      .then((proof) => {
        confirmed = !!proof
        return proof
      })
    await h.ready()
    expect(confirmed).toBe(false)
    finishProjection()
    await expect(pausing).resolves.toMatchObject({ kind: "ack", epoch: 7 })
    h.finish("aborted")
    await running
  })

  it("keeps a verified stop receipt as proof when the cancelled turn's event tail cannot drain", async () => {
    for (const action of ["pause", "terminate"] as const) {
      const h = harness()
      h.session.events.mockImplementation(async function* () {
        yield { eventId: "event-final", sequence: 1, event: { kind: "text-delta", delta: "final" } }
      })
      // The projection never finishes; the turn's lifetime is then cancelled.
      h.input.onEvent.mockImplementationOnce(() => new Promise<void>(() => undefined))
      h.session.entries.mockResolvedValue({ entries: [], headEventId: "event-final" })
      const controller = new AbortController()
      const running = h.pool.run({ ...h.input, signal: controller.signal }).catch(() => undefined)
      await h.ready()
      const stopping =
        action === "pause"
          ? h.control().pause(`${action}-cancelled`)
          : h.control().terminate(`${action}-cancelled`)
      controller.abort(new Error("renewal refused"))
      const answer = await stopping
      if (action === "pause") {
        // Proven stop, but no checkpoint over an unprojected tail.
        expect(answer).toEqual({
          proof: { kind: "ack", epoch: 7, at: expect.any(Number) },
          checkpointSafe: false,
        })
      } else {
        expect(answer).toMatchObject({ kind: "ack", epoch: 7 })
      }
      h.finish("aborted")
      await running
    }
  })

  it("refuses a checkpoint when the Worker's persisted head was never projected", async () => {
    for (const ending of ["stream-ended", "never-arrives"] as const) {
      const h = harness()
      // The subscription delivers an earlier event; the head stays unseen.
      h.session.events.mockImplementation(async function* (options?: { signal?: AbortSignal }) {
        yield { eventId: "event-early", sequence: 1, event: { kind: "text-delta", delta: "a" } }
        // Like the real subscription, an idle stream ends only when cancelled.
        if (ending === "never-arrives")
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          )
      })
      h.session.entries.mockResolvedValue({ entries: [], headEventId: "event-unseen" })
      const running = h.pool.run(h.input)
      await h.ready()
      await expect(h.control().pause(`pause-${ending}`)).resolves.toEqual({
        proof: { kind: "ack", epoch: 7, at: expect.any(Number) },
        checkpointSafe: false,
      })
      h.finish("aborted")
      await running.catch(() => undefined)
    }
  })

  it("delivers a verified stop when a projection hangs while the dispatch stays alive", async () => {
    for (const action of ["pause", "terminate"] as const) {
      const h = harness()
      h.session.events.mockImplementation(async function* () {
        yield { eventId: "event-final", sequence: 1, event: { kind: "text-delta", delta: "final" } }
      })
      // The projection never returns and nothing cancels the dispatch.
      h.input.onEvent.mockImplementationOnce(() => new Promise<void>(() => undefined))
      h.session.entries.mockResolvedValue({ entries: [], headEventId: "event-final" })
      const running = h.pool.run(h.input).catch(() => undefined)
      await h.ready()
      const answer =
        action === "pause"
          ? await h.control().pause(`${action}-hung`)
          : await h.control().terminate(`${action}-hung`)
      const proof = { kind: "ack", epoch: 7, at: expect.any(Number) }
      expect(answer).toEqual(action === "pause" ? { proof, checkpointSafe: false } : proof)
      h.finish("aborted")
      void running
    }
  })

  it("treats a stopped turn as drained once its persisted head was already projected", async () => {
    const h = harness()
    h.session.events.mockImplementation(async function* () {
      yield { eventId: "event-final", sequence: 1, event: { kind: "text-delta", delta: "final" } }
    })
    h.session.entries.mockResolvedValue({ entries: [], headEventId: "event-final" })
    const running = h.pool.run(h.input)
    await h.ready()
    await h.ready()
    await expect(h.control().pause("pause-projected")).resolves.toEqual({
      kind: "ack",
      epoch: 7,
      at: expect.any(Number),
    })
    expect(h.session.entries).toHaveBeenCalledWith({ limit: 1 })
    h.finish("aborted")
    await running
  })

  it("refuses a checkpoint from a Worker that cannot report its persisted head", async () => {
    const h = harness(["worker-self-fence-v1", "turn-interrupt-v1"])
    const running = h.pool.run(h.input)
    await h.ready()
    await expect(h.control().pause("pause-no-head")).resolves.toEqual({
      proof: { kind: "ack", epoch: 7, at: expect.any(Number) },
      checkpointSafe: false,
    })
    expect(h.session.entries).not.toHaveBeenCalled()
    h.finish("aborted")
    await running
  })

  it("hands a verified completion receipt to the dispatcher before a later cleanup can fail the run", async () => {
    const h = harness()
    h.session.events.mockImplementation(async function* () {
      yield { eventId: "event-final", sequence: 1, event: { kind: "text-delta", delta: "final" } }
    })
    h.input.onEvent.mockImplementationOnce(() => new Promise<void>(() => undefined))
    h.session.abort.mockResolvedValueOnce({
      stopped: true,
      turnStatus: "completed",
      sessionStatus: "idle",
      targetTurnCommandId: "turn-1",
      dispatchEpoch: 7,
      followUpsDropped: 0,
    })
    const onDisposalProof = jest.fn()
    const controller = new AbortController()
    const running = h.pool.run({ ...h.input, onDisposalProof, signal: controller.signal })
    await h.ready()
    h.finish("completed")
    await h.ready()
    // The task times out while the projection of the final event still hangs.
    controller.abort(new Error("task timed out"))
    await expect(running).rejects.toThrow()
    expect(onDisposalProof).toHaveBeenCalledTimes(1)
    expect(onDisposalProof).toHaveBeenCalledWith({ kind: "ack", epoch: 7, at: expect.any(Number) })
  })

  it("fails the dispatch when the event projection or its PII gate rejects", async () => {
    const h = harness()
    h.session.events.mockImplementation(async function* () {
      yield {
        eventId: "event-rejected",
        sequence: 1,
        event: { kind: "text-delta", delta: "content" },
      }
    })
    h.input.onEvent.mockRejectedValueOnce(new Error("Remote event failed the PII gate"))
    await expect(h.pool.run(h.input)).rejects.toThrow("PII gate")
    expect(h.session.run.mock.calls[0]![1].signal?.aborted).toBe(true)
  })
})

// Exercise the actual SDK/RpcPeer; only the remote service is scripted.
function realRpcWorker(
  options: { capable?: boolean; beforeReply?(method: string, count: number): void } = {}
) {
  const requests: Array<{ id?: number; method: string; params: Record<string, unknown> }> = []
  let sequence = 0
  let entries = 0
  const openSessions = new Set<string>()
  const pool = new WorkerRpcPool({
    createClient: (options) => createCogniaClient({ ...options, requestTimeoutMs: 10 }),
    sendFrame(connectionId, original, finalize?: () => string | undefined) {
      const frame = finalize ? finalize() : original
      if (frame === undefined) return
      const request = JSON.parse(frame) as (typeof requests)[number]
      requests.push(request)
      if (request.id === undefined) return
      const sessionId = String(request.params?.sessionId ?? "")
      let result: unknown = { commandId: request.params?.commandId ?? "command" }
      if (request.method === "initialize")
        result = {
          protocolVersion: RPC_PROTOCOL_VERSION,
          host: { name: "scripted-worker", version: "1" },
          runtimeVersion: "1",
          instanceId: "real-rpc-worker",
          methods: RPC_METHODS,
          capabilities: [
            "worker-dispatch-v1",
            "event-replay",
            ...(options.capable ? ["worker-self-fence-v1"] : []),
          ],
          limits: { maxOpenSessions: 32, maxActiveTurns: 1 },
        }
      if (request.method === "session/create") {
        const id = `real-session-${++sequence}`
        openSessions.add(id)
        result = { sessionId: id, spec: {} }
      }
      if (request.method === "session/entries") {
        entries += 1
        result = { entries: [] }
      }
      if (request.method === "session/state") result = { sessionId, status: "idle" }
      if (request.method === "turn/run") result = { status: "completed", result: { text: "done" } }
      if (request.method === "session/close") openSessions.delete(sessionId)
      options.beforeReply?.(request.method, entries)
      queueMicrotask(() =>
        pool.receive(connectionId, JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
      )
    },
  })
  const workerManifest = {
    ...manifest,
    hardCapabilities: options.capable ? ["worker-self-fence-v1"] : [],
    fenceGraceMs: 30_000,
    credentialProfileRefs: ["credential:test"],
    workspaceBindingRefs: ["repository:project:repo"],
    executionProfile: {
      ...manifest.executionProfile!,
      runtimeAdapter: "ai-sdk" as const,
      capabilities: ["streaming"],
    },
  }
  pool.attach({ connectionId: "real-connection", hostRef: "device:real", manifest: workerManifest })
  const input = {
    hostRef: "device:real",
    commandId: "real-turn",
    prompt: "safe prompt",
    handoff: safeHandoff,
    onSession: jest.fn(),
    onEvent: jest.fn(),
    onControl: jest.fn(),
  }
  return { pool, requests, input, openSessions }
}

describe("WorkerRpcPool transport regressions", () => {
  it("fails a refused frame promptly through a real RpcPeer without an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    const h = realRpcWorker({
      capable: true,
      beforeReply(method, count) {
        if (method === "session/entries" && count === 2)
          h.pool.listWorkers()[0]!.manifest.credentialProfileRefs.splice(0)
      },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = h.pool
        .run({
          ...h.input,
          dispatchEpoch: 1,
          fence: {
            childRunId: "child-run",
            dispatchEpoch: 1,
            lastRenewalSentAt: Date.now(),
            leaseTtlMs: 60_000,
          },
          placementRequirements: {
            spec: { ...executionSpec, runtimeAdapter: "ai-sdk" },
            workspaceBindingRef: "repository:project:repo",
            requiredSandboxCapabilities: [],
          },
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error })
        )
      const result = await Promise.race([
        outcome,
        new Promise<{ error: unknown }>((resolve) => {
          timer = setTimeout(() => resolve({ error: new Error("refused frame hung") }), 100)
        }),
      ])
      expect(result.error).toMatchObject({
        message: "Worker placement changed: credential_missing",
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(h.requests.some((request) => request.method === "turn/run")).toBe(false)
    } finally {
      if (timer) clearTimeout(timer)
      h.pool.close()
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("cleans up more than 32 sequential completed sessions on one old-Worker connection without inventing proof", async () => {
    const h = realRpcWorker()
    try {
      for (let i = 0; i < 40; i++) {
        await expect(h.pool.run({ ...h.input, commandId: `turn-${i}` })).resolves.toEqual({
          status: "completed",
          result: { text: "done" },
        })
        expect(h.openSessions.size).toBe(0)
      }
      expect(h.requests.filter((request) => request.method === "session/close")).toHaveLength(40)
      expect(h.requests.filter((request) => request.method === "initialize")).toHaveLength(1)
    } finally {
      h.pool.close()
    }
  })
})
