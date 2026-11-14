import {
  getRemoteWorkerRuntime,
  __resetRemoteWorkerRuntimeForTesting,
  type RemoteWorkerRunInput,
  type RemoteWorkerTurnControl,
} from "./remote-worker-runtime"
import { attachTauriWorkerRuntime, type WorkerBrainEnvelope } from "./tauri-worker-runtime"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "@cognia/agent/protocol"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
  Channel: class {
    onmessage: ((message: unknown) => void) | undefined
  },
}))

const manifest = {
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

class FakeChannel {
  onmessage: ((message: WorkerBrainEnvelope) => void) | undefined
  deliver(envelope: WorkerBrainEnvelope) {
    this.onmessage?.(envelope)
  }
}

function setup(invoke = jest.fn(async () => undefined)) {
  const channel = new FakeChannel()
  return {
    invoke,
    channel,
    attach: () =>
      attachTauriWorkerRuntime({
        tenantId: "local_acct_a",
        invoke: invoke as never,
        createChannel: () => channel as never,
      }),
  }
}

describe("attachTauriWorkerRuntime", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    __resetRemoteWorkerRuntimeForTesting()
  })

  afterEach(() => {
    jest.useRealTimers()
    __resetRemoteWorkerRuntimeForTesting()
  })

  it("installs the runtime so dispatch stops being a no-op on this host", async () => {
    // The whole defect this fixes: `getRemoteWorkerRuntime()` returned
    // undefined on desktop, so every placement decision resolved to "no runtime"
    // while Fleet still reported the worker online.
    const harness = setup()
    expect(getRemoteWorkerRuntime()).toBeUndefined()

    const handle = await harness.attach()

    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_attach_channel", {
      tenantId: "local_acct_a",
      onEvent: harness.channel,
    })
    expect(getRemoteWorkerRuntime()).toBe(handle.pool)
  })

  it("routes attach, frame, and detach envelopes into the pool", async () => {
    const harness = setup()
    const handle = await harness.attach()

    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })
    expect(handle.pool.listWorkers()).toEqual([
      expect.objectContaining({ hostRef: "device:a", online: true }),
    ])

    harness.channel.deliver({
      seq: 2,
      type: "worker_frame",
      connectionId: "connection-1",
      frame: '{"jsonrpc":"2.0","id":1,"result":{}}',
    })
    expect(handle.pool.listWorkers()).toHaveLength(1)

    const detach = jest.spyOn(handle.pool, "detach")
    harness.channel.deliver({
      seq: 3,
      type: "worker_detach",
      connectionId: "connection-1",
      hostRef: "device:a",
      reason: "socket_closed",
    })
    expect(handle.pool.listWorkers()).toEqual([])
    expect(detach).toHaveBeenCalledWith("connection-1", "socket_closed")
    detach.mockRestore()
  })

  it("acks cumulatively on a timer instead of once per frame", async () => {
    // Acks release the host's inbound byte budget. They are cumulative, so
    // coalescing is free — and one invoke per frame would double IPC traffic on
    // the hot path.
    const harness = setup()
    await harness.attach()
    harness.invoke.mockClear()

    harness.channel.deliver({
      seq: 7,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })
    harness.channel.deliver({
      seq: 8,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })
    expect(harness.invoke).not.toHaveBeenCalled()

    jest.advanceTimersByTime(50)

    expect(harness.invoke).toHaveBeenCalledTimes(1)
    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_ack_events", { throughSeq: 8 })
  })

  it("retries an ack the host refused instead of dropping the window", async () => {
    // A failed ack means those bytes are still charged against the host's
    // inbound budget. Dropping the window would only be repaired by the NEXT
    // envelope — and between turns none arrives, so the budget would stay held
    // and a later frame would trip the backpressure timeout on a healthy
    // connection.
    let failAck = true
    const invoke = jest.fn(async (command: string) => {
      if (command === "companion_worker_ack_events" && failAck) {
        throw new Error("no desktop brain is attached")
      }
      return undefined
    })
    const harness = setup(invoke as never)
    await harness.attach()
    harness.invoke.mockClear()

    harness.channel.deliver({
      seq: 4,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })

    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.invoke).toHaveBeenCalledTimes(1)

    // The discriminating assertion: NO new envelope arrives, so the only thing
    // that can produce a second ack is the retry re-arming the timer itself.
    failAck = false
    jest.advanceTimersByTime(50)
    await Promise.resolve()

    expect(harness.invoke).toHaveBeenCalledTimes(2)
    expect(harness.invoke).toHaveBeenLastCalledWith("companion_worker_ack_events", {
      throughSeq: 4,
    })
  })

  it("flushes an ack immediately once the batch window fills", async () => {
    const harness = setup()
    await harness.attach()
    harness.invoke.mockClear()

    for (let seq = 1; seq <= 32; seq += 1) {
      harness.channel.deliver({
        seq,
        type: "worker_frame",
        connectionId: "unknown",
        frame: "ignored",
      })
    }

    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_ack_events", { throughSeq: 32 })
  })

  it("sends outbound frames in order through one serialized invoke chain", async () => {
    // Separate `invoke` calls carry no ordering guarantee, and Agent RPC breaks
    // if a response overtakes the request it answers.
    const order: string[] = []
    let releaseFirstFrame!: () => void
    const firstFrameSent = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve
    })
    const invoke = jest.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "companion_worker_send_frame") {
        order.push(String(args?.frame))
        if (args?.frame === '{"id":1}') await firstFrameSent
      }
      return undefined
    })
    const harness = setup(invoke as never)
    const handle = await harness.attach()
    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })

    // SDK startup is asynchronous. Let it enqueue initialize before exercising
    // the sink, so this test checks wire ordering, not bootstrap scheduling.
    await jest.advanceTimersByTimeAsync(0)
    expect(JSON.parse(order[0]!)).toMatchObject({ method: "initialize" })

    const worker = handle.pool.listWorkers()[0]
    expect(worker).toBeDefined()
    const sink = (
      handle.pool as unknown as {
        workers: Map<string, { writable: { write(chunk: string): boolean } }>
      }
    ).workers.get("connection-1")!.writable
    sink.write('{"id":1}\n{"id":2}\n')
    sink.write('{"id":3}\n')

    await jest.advanceTimersByTimeAsync(0)
    expect(order.slice(1)).toEqual(['{"id":1}'])
    releaseFirstFrame()
    await jest.advanceTimersByTimeAsync(0)
    expect(order.slice(1)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
    await handle.dispose()
  })

  it.each([
    ["turn/run", "remaining"],
    ["dispatch/renew", "remaining"],
    ["turn/run", "expired"],
    ["dispatch/renew", "expired"],
    ["turn/run", "incompatible"],
    ["dispatch/renew", "incompatible"],
  ])("finalizes %s at desktop dequeue time (%s)", async (operation, scenario) => {
    jest.setSystemTime(1_000)
    type Request = { id?: number | string; method: string; params: Record<string, unknown> }
    const sent: Request[] = []
    let eventSeq = 1
    let entries = 0
    let blocked = false
    let release!: () => void
    const queueBlocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let runRequest: Request | undefined
    const reply = (request: Request, result: unknown) => {
      queueMicrotask(() =>
        harness.channel.deliver({
          seq: ++eventSeq,
          type: "worker_frame",
          connectionId: "queued",
          frame: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        })
      )
    }
    const invoke = jest.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "companion_worker_send_frame") return
      const request = JSON.parse(String(args?.frame)) as Request
      if (request.id === "queue-block") {
        blocked = true
        await queueBlocked
        return
      }
      if (request.id === undefined) return
      sent.push(request)
      let result: unknown = { commandId: request.params?.commandId ?? "command" }
      if (request.method === "initialize")
        result = {
          protocolVersion: RPC_PROTOCOL_VERSION,
          host: { name: "queued-worker", version: "1" },
          runtimeVersion: "1",
          instanceId: "queued",
          methods: RPC_METHODS,
          capabilities: ["worker-dispatch-v1", "event-replay", "worker-self-fence-v1"],
          limits: {},
        }
      if (request.method === "session/create") result = { sessionId: "queued-session", spec: {} }
      if (request.method === "session/entries") {
        result = { entries: [] }
        entries += 1
      }
      if (request.method === "session/state")
        result = { sessionId: "queued-session", status: "idle" }
      if (request.method === "turn/run") {
        runRequest = request
        return
      }
      if (request.method === "dispatch/renew")
        result = { commandId: request.params.commandId, renewed: true }
      reply(request, result)
      // Reply to the cursor read, but hold its IPC completion. The SDK can
      // enqueue turn/run while the transport still waits on this invocation.
      if (operation === "turn/run" && request.method === "session/entries" && entries === 2) {
        blocked = true
        await queueBlocked
      }
    })
    const harness = setup(invoke as never)
    const handle = await harness.attach()
    harness.channel.deliver({
      seq: eventSeq,
      type: "worker_attach",
      connectionId: "queued",
      hostRef: "device:queued",
      manifest: {
        ...manifest,
        hardCapabilities: ["worker-self-fence-v1"],
        fenceGraceMs: 30_000,
        executionProfile: { ...manifest.executionProfile, runtimeAdapter: "ai-sdk" },
      },
    })
    let control!: RemoteWorkerTurnControl
    const lease = {
      childRunId: "queued-child",
      dispatchEpoch: 1,
      lastRenewalSentAt: 1_000,
      leaseTtlMs: 5_000,
    }
    const input: RemoteWorkerRunInput = {
      hostRef: "device:queued",
      commandId: "queued-turn",
      dispatchEpoch: 1,
      fence: lease,
      handoff: {
        envelopeVersion: 1,
        identity: {
          parentRunId: "parent",
          childRunId: "queued-child",
          depth: 1,
          parentChain: ["parent"],
        },
        task: { prompt: "task" },
        execution: { mode: "orchestrated" },
        createdAt: "2026-11-14T00:00:00.000Z",
      },
      prompt: "task",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: (next) => {
        control = next
      },
    }
    const running = handle.pool.run(input).then(
      (outcome) => ({ outcome, error: undefined }),
      (error: unknown) => ({ outcome: undefined, error })
    )
    const flush = async () => {
      for (let i = 0; i < 8; i++) await jest.advanceTimersByTimeAsync(0)
    }
    let renewing: Promise<unknown> | undefined
    try {
      await flush()
      if (operation === "dispatch/renew") {
        const sink = (
          handle.pool as unknown as {
            workers: Map<string, { writable: { write(frame: string): boolean } }>
          }
        ).workers.get("queued")!.writable
        sink.write('{"id":"queue-block"}\n')
        await flush()
        renewing = control.renew!(lease).catch((error: unknown) => error)
        await flush()
      }
      expect(blocked).toBe(true)
      expect(sent.filter((request) => request.method === operation)).toHaveLength(0)
      await jest.advanceTimersByTimeAsync(scenario === "expired" ? 6_000 : 2_000)
      if (scenario === "incompatible")
        handle.pool.listWorkers()[0]!.manifest.hardCapabilities.splice(0)
      release()
      await flush()
      if (scenario === "remaining") {
        const request = sent.find((request) => request.method === operation)!
        const ttl =
          operation === "turn/run"
            ? (request.params.fence as { leaseTtlMs: number }).leaseTtlMs
            : request.params.leaseTtlMs
        expect(ttl).toBe(3_000)
        await renewing
        reply(runRequest!, { status: "completed", result: { text: "done" } })
        await flush()
        expect((await running).error).toBeUndefined()
      } else {
        expect(sent.filter((request) => request.method === operation)).toHaveLength(0)
        expect((await running).error).toBeInstanceOf(Error)
        await renewing
      }
    } finally {
      release()
      await handle.dispose()
    }
  })

  it("detaches the connection when a frame never reaches the worker", async () => {
    // A dropped frame strands every in-flight call on that connection. Closing
    // it surfaces the break to the dispatcher, which already recovers from a
    // closed worker.
    const invoke = jest.fn(async (command: string) => {
      if (command === "companion_worker_send_frame")
        throw new Error("worker connection is unavailable")
      return undefined
    })
    const harness = setup(invoke as never)
    const handle = await harness.attach()
    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })

    const sink = (
      handle.pool as unknown as {
        workers: Map<string, { writable: { write(chunk: string): boolean } }>
      }
    ).workers.get("connection-1")!.writable
    sink.write('{"id":1}\n')
    await jest.advanceTimersByTimeAsync(0)

    expect(handle.pool.listWorkers()).toEqual([])
  })

  it("releases the runtime slot and the host channel on dispose", async () => {
    const harness = setup()
    const handle = await harness.attach()

    await handle.dispose()

    expect(getRemoteWorkerRuntime()).toBeUndefined()
    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_detach_channel", {})
  })
})
