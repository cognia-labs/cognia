import "fake-indexeddb/auto"
import { personalEgressOptionsSource } from "@/lib/execution/personal-egress"
import { hostStateRunId } from "@/lib/work-submission/host-adapter"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"
import { ExecutionBroker } from "@/lib/execution/broker"
import { createPersonProcessPlane, type PersonPlaneTransport } from "./process-plane"
import {
  createPersonAgentRunner,
  gatewayCorrectedUsage,
  gatewayRefusalIn,
  personAgentPrompt,
  PERSON_AGENT_IDLE_MS,
  PERSON_AGENT_TICKET_SETTLE_POLL_MS,
  PERSON_AGENT_WORKSPACE,
  type PersonAgentManager,
  type PersonAgentRunnerDeps,
} from "./runner"

const at = new Date(0)

function event(value: Record<string, unknown>): ExternalAgentEvent {
  return { timestamp: at, ...value } as unknown as ExternalAgentEvent
}

/** A turn's events, released by the test so a turn can be held open. */
function scripted(events: ExternalAgentEvent[]) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    held: false,
    async *run(hold: boolean) {
      for (const [index, value] of events.entries()) {
        if (hold && index === events.length - 1) await gate
        yield value
      }
    },
  }
}

function harness(options: { holdLast?: boolean; turnLimit?: number } = {}) {
  const broker = new ExecutionBroker(
    options.turnLimit === undefined ? {} : { limits: { "ai-turn": options.turnLimit } }
  )
  const transportHandlers = new Map<string, Array<(payload: unknown) => void>>()
  const transport = {
    call: jest.fn(async () => null),
    subscribe: <T>(name: string, handler: (payload: T) => void) => {
      transportHandlers.set(name, [
        ...(transportHandlers.get(name) ?? []),
        handler as (payload: unknown) => void,
      ])
      return () => undefined
    },
    whenSubscribed: async () => undefined,
  }
  const plane = createPersonProcessPlane(transport as unknown as PersonPlaneTransport)
  const turns: Array<ReturnType<typeof scripted>> = []
  const manager = {
    addAgent: jest.fn(async () => undefined),
    removeAgent: jest.fn(async () => undefined),
    executeStreaming: jest.fn((..._args: Parameters<PersonAgentManager["executeStreaming"]>) => {
      const next = turns.shift()
      if (!next) throw new Error("no scripted turn")
      return next.run(options.holdLast ?? false)
    }),
    cancel: jest.fn(async () => undefined),
    respondToPermission: jest.fn(async () => undefined),
    respondToElicitation: jest.fn(async () => undefined),
  } satisfies PersonAgentManager
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  let ids = 0
  const settled: Array<{ actionId: string; outcome: string; errorCode?: string }> = []
  const writes: Array<{ sessionId: string; id: string; parts: unknown[] }> = []
  const envelopes: Array<{ eventId: string; event: Record<string, unknown> }> = []
  const liveFrames: TranscriptLiveFrame[] = []
  /** What reached the member and the store, in order. */
  const order: string[] = []
  const deps: PersonAgentRunnerDeps = {
    plane,
    manager,
    broker,
    prepareLease: jest.fn(async () => ({ ticketId: "t", secret: "lease-secret", expiresAtMs: 1 })),
    ticketTokens: jest.fn(async () => ({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      openRequests: 0,
    })),
    launchFor: (runtimeId) =>
      runtimeId === "claude-agent-acp"
        ? {
            config: {
              id: "preset",
              name: "Claude",
              protocol: "acp",
              transport: "stdio",
              enabled: true,
              process: { command: "claude-agent-acp", args: [] },
            } as never,
            family: "claude",
          }
        : undefined,
    history: jest.fn(async () => ({
      text: "User: earlier\n\nAssistant: reply",
      visibilityDigest: "same-readers",
      hasWithheld: false,
    })),
    writeMessage: jest.fn(async (sessionId, message) => {
      writes.push({ sessionId, id: message.id, parts: message.parts })
      order.push(`write:${message.parts.length}`)
    }),
    removeMessage: jest.fn(async (sessionId, messageId) => {
      order.push(`remove:${sessionId}:${messageId}`)
    }),
    settle: jest.fn(async (actionId, input) => {
      settled.push({ actionId, outcome: input.outcome, errorCode: input.errorCode })
      await input.writeTranscript?.()
    }),
    project: jest.fn(async (envelope) => {
      envelopes.push({
        eventId: envelope.eventId,
        event: envelope.event as unknown as Record<string, unknown>,
      })
    }),
    recordUsage: jest.fn(async () => {
      order.push("usage")
    }),
    publishLive: jest.fn(async (frame) => {
      liveFrames.push(frame)
      order.push(`live:${frame.state}`)
    }),
    transcriptRevision: jest.fn(async () => 7),
    applyEvent: (parts, value) =>
      value.type === "message_delta"
        ? [...parts, { type: "text", text: value.delta.text } as never]
        : (parts as never),
    pickAllowOption: (choices) =>
      Array.isArray(choices)
        ? (choices as Array<{ optionId: string; kind: string }>).find((option) =>
            option.kind.startsWith("allow")
          )?.optionId
        : undefined,
    newId: () => `id${++ids}`,
    now: () => 0,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log: () => undefined,
  }
  const runner = createPersonAgentRunner(deps)
  const emit = (name: string, payload: unknown) => {
    for (const handler of transportHandlers.get(name) ?? []) handler(payload)
  }
  return {
    runner,
    deps,
    broker,
    manager,
    turns,
    timers,
    settled,
    writes,
    envelopes,
    liveFrames,
    order,
    plane,
    emit,
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  session: { id: "s1" },
  runtimeId: "claude-agent-acp",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  prompt: "hello",
  actionId: "a1",
  messageId: "m1",
  ...overrides,
})

const flush = () => new Promise((resolve) => setImmediate(resolve))
/** Settling reads the revision and sends the final live frame first. */
const drain = async () => {
  for (let round = 0; round < 4; round += 1) await flush()
}

const replyTurn = (text = "hi") =>
  scripted([
    event({ type: "session_start", sessionId: "native-1" }),
    event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text } }),
    event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
  ])

describe("gatewayCorrectedUsage", () => {
  const gateway = { inputTokens: 16_500, outputTokens: 120 }
  it("replaces only a zero or missing figure", () => {
    expect(
      gatewayCorrectedUsage({ promptTokens: 0, completionTokens: 9, totalTokens: 9 }, gateway)
    ).toEqual({
      promptTokens: 16_500,
      promptTokensIncludeCache: true,
      completionTokens: 9,
      totalTokens: 16_509,
    })
    expect(gatewayCorrectedUsage(undefined, gateway)).toEqual({
      promptTokens: 16_500,
      promptTokensIncludeCache: true,
      completionTokens: 120,
      totalTokens: 16_620,
    })
  })
  it("keeps a full report, and keeps the report when the gateway saw nothing", () => {
    const full = { promptTokens: 40, completionTokens: 9, totalTokens: 49 }
    expect(gatewayCorrectedUsage(full, gateway)).toBe(full)
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    expect(gatewayCorrectedUsage(zero, { inputTokens: 0, outputTokens: 0 })).toBe(zero)
    expect(gatewayCorrectedUsage(zero, undefined)).toBe(zero)
    expect(gatewayCorrectedUsage(undefined, undefined)).toBeUndefined()
  })
})

describe("person agent runner", () => {
  it("p6e launches one sandboxed process with only the brokered lease", async () => {
    const h = harness()
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await flush()
    expect(h.deps.prepareLease).toHaveBeenCalledWith({
      runtimeId: "claude-agent-acp",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionId: "person-agent-id1",
    })
    expect(h.manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "person-agent-id1",
        process: {
          command: "claude-agent-acp",
          args: [],
          cwd: PERSON_AGENT_WORKSPACE,
          env: {
            COGNIA_GATEWAY_TOKEN: "lease-secret",
            COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({
              taskId: "person-agent-id1",
              runtime: "claude",
            }),
          },
        },
      })
    )
    // The first turn of a fresh process carries the conversation so far.
    expect(h.deps.history).toHaveBeenCalledWith("s1", ["m1", "assistant-a1"], "a1")
    expect(h.manager.executeStreaming).toHaveBeenCalledWith("person-agent-id1", "hello", {
      workingDirectory: PERSON_AGENT_WORKSPACE,
      context: { custom: { conversationHistory: "User: earlier\n\nAssistant: reply" } },
    })
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "completed", errorCode: undefined }])
    expect(h.writes.at(-1)).toEqual({
      sessionId: "s1",
      id: "assistant-a1",
      parts: [{ type: "text", text: "hi" }],
    })
    expect(h.envelopes.map((entry) => entry.event)).toEqual([
      { kind: "queue", phase: "accepted", queueId: "a1", delivery: "after-settle" },
      { kind: "queue", phase: "delivered", queueId: "a1", delivery: "after-settle" },
      { kind: "lifecycle", phase: "started" },
      { kind: "lifecycle", phase: "ended" },
    ])
    expect(new Set(h.envelopes.map((entry) => entry.eventId)).size).toBe(4)
  })

  it("p6e streams the reply live to the member's devices, the final frame before the write", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text: "hel" } }),
      event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text: "lo" } }),
      event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
    ])
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    // The first change goes out at once, whole; the next waits for its slot.
    expect(h.liveFrames).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        messageId: "assistant-a1",
        replyTo: "m1",
        seq: 1,
        keyframe: true,
        state: "streaming",
        parts: [{ type: "text", text: "hel" }],
      }),
    ])
    const slot = h.timers.find((timer) => timer.ms === 100 && !timer.cleared)
    expect(slot).toBeDefined()
    slot!.callback()
    await flush()
    expect(h.liveFrames[1]).toEqual(
      expect.objectContaining({
        seq: 2,
        base: 1,
        keyframe: false,
        parts: [{ type: "text", text: "lo" }],
      })
    )
    turn.release()
    await flush()
    await flush()
    expect(h.liveFrames[2]).toEqual(
      expect.objectContaining({
        seq: 3,
        base: 0,
        keyframe: true,
        state: "settled",
        parts: [
          { type: "text", text: "hel" },
          { type: "text", text: "lo" },
        ],
        // What was persisted before it: the device waits for a newer timeline.
        afterRevision: 7,
      })
    )
    expect(h.order.indexOf("live:settled")).toBeLessThan(h.order.lastIndexOf("write:2"))
  })

  it("p6e books the turn's token usage under its reply before settling", async () => {
    const h = harness()
    const tokenUsage = { promptTokens: 40, completionTokens: 9, totalTokens: 49 }
    h.turns.push(
      scripted([
        event({
          type: "message_delta",
          sessionId: "native-1",
          delta: { type: "text", text: "hi" },
        }),
        event({ type: "done", sessionId: "native-1", success: true, tokenUsage, durationMs: 1200 }),
      ])
    )
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await drain()
    expect(h.deps.recordUsage).toHaveBeenCalledTimes(1)
    expect(h.deps.recordUsage).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "assistant-a1",
      usage: tokenUsage,
      model: "claude-sonnet-4-5",
      providerId: "anthropic",
      durationMs: 1200,
    })
    expect(h.order.indexOf("usage")).toBeLessThan(h.order.lastIndexOf("write:1"))
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "completed", errorCode: undefined }])

    // A turn whose adapter reported no usage books nothing.
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2" }))
    await drain()
    expect(h.deps.recordUsage).toHaveBeenCalledTimes(1)
  })

  it("adr0253 books the gateway's count where the agent reported zero tokens", async () => {
    const h = harness()
    const readings = [
      { inputTokens: 100, outputTokens: 5, requests: 1, openRequests: 0 },
      // The turn's last request is still settling at the first read after it.
      { inputTokens: 100, outputTokens: 5, requests: 1, openRequests: 1 },
      { inputTokens: 16_600, outputTokens: 125, requests: 3, openRequests: 0 },
    ]
    jest.mocked(h.deps.ticketTokens).mockImplementation(async () => readings.shift()!)
    h.turns.push(
      scripted([
        event({
          type: "message_delta",
          sessionId: "native-1",
          delta: { type: "text", text: "hi" },
        }),
        event({
          type: "done",
          sessionId: "native-1",
          success: true,
          // claude-agent-acp: no input tokens, while the gateway charged ~16.5K.
          tokenUsage: { promptTokens: 0, completionTokens: 9, totalTokens: 9 },
        }),
      ])
    )
    await h.runner.startTurn(request())
    await drain()
    // Waiting for the open request: fire the poll timer.
    const poll = h.timers.find((timer) => timer.ms === PERSON_AGENT_TICKET_SETTLE_POLL_MS)
    expect(poll).toBeDefined()
    poll!.callback()
    await drain()
    expect(h.deps.ticketTokens).toHaveBeenCalledWith("t")
    expect(h.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "assistant-a1",
        // The gateway's input for this turn; the agent's own output stands.
        usage: {
          promptTokens: 16_500,
          promptTokensIncludeCache: true,
          completionTokens: 9,
          totalTokens: 16_509,
        },
      })
    )
  })

  it("adr0253 books the gateway's count for a turn the agent reported nothing for", async () => {
    const h = harness()
    const readings = [
      { inputTokens: 0, outputTokens: 0, requests: 0, openRequests: 0 },
      { inputTokens: 900, outputTokens: 40, requests: 1, openRequests: 0 },
    ]
    jest.mocked(h.deps.ticketTokens).mockImplementation(async () => readings.shift()!)
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await drain()
    expect(h.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokens: 900,
          promptTokensIncludeCache: true,
          completionTokens: 40,
          totalTokens: 940,
        },
      })
    )
  })

  it("adr0253 keeps the agent's report when the gateway cannot be read", async () => {
    const h = harness()
    jest.mocked(h.deps.ticketTokens).mockRejectedValue(new Error("person_brain_stopping"))
    const tokenUsage = { promptTokens: 0, completionTokens: 9, totalTokens: 9 }
    h.turns.push(
      scripted([event({ type: "done", sessionId: "native-1", success: true, tokenUsage })])
    )
    await h.runner.startTurn(request())
    await drain()
    expect(h.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: tokenUsage }))
  })

  it("p6e settles a turn whose usage could not be written", async () => {
    const h = harness()
    ;(h.deps.recordUsage as jest.Mock).mockRejectedValueOnce(new Error("disk full"))
    h.turns.push(
      scripted([
        event({
          type: "done",
          sessionId: "native-1",
          success: true,
          tokenUsage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
        }),
      ])
    )
    await h.runner.startTurn(request())
    await drain()
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "no_response", errorCode: undefined }])
  })

  it("p6e sends no live frame for a turn that never produced a part", async () => {
    const h = harness()
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
      ])
    )
    await h.runner.startTurn(request())
    await flush()
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "no_response", errorCode: undefined }])
    expect(h.liveFrames).toEqual([])
  })

  it("p6e keeps the process between turns and reaps it when idle", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn("again"))
    await h.runner.startTurn(request())
    await drain()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2" }))
    await drain()
    expect(h.manager.addAgent).toHaveBeenCalledTimes(1)
    expect(h.deps.history).toHaveBeenCalledTimes(2)
    expect(h.manager.executeStreaming).toHaveBeenLastCalledWith("person-agent-id1", "hello", {
      sessionId: "native-1",
      workingDirectory: PERSON_AGENT_WORKSPACE,
    })
    const idle = h.timers.filter((timer) => !timer.cleared)
    expect(idle).toHaveLength(1)
    expect(idle[0].ms).toBe(PERSON_AGENT_IDLE_MS)
    idle[0].callback()
    await flush()
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.runner.liveAgent("s1")).toBeUndefined()
  })

  it("keeps the native process when readers loosen to fully visible owner history", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn("again"))
    jest
      .mocked(h.deps.history)
      .mockResolvedValueOnce({
        text: "[Withheld: personal content of Host owner]",
        visibilityDigest: "two-readers",
        hasWithheld: true,
      })
      .mockResolvedValue({
        text: "owner-only material",
        visibilityDigest: "owner",
        hasWithheld: false,
      })
    await h.runner.startTurn(request())
    await drain()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2" }))
    await drain()
    expect(h.manager.removeAgent).not.toHaveBeenCalled()
    expect(h.manager.addAgent).toHaveBeenCalledTimes(1)
    expect(h.manager.executeStreaming.mock.calls.at(-1)?.[2]?.sessionId).toBe("native-1")
    await h.runner.closeAll()
  })

  it("rebuilds the native process from filtered history when a second requester joins", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn("again"))
    jest
      .mocked(h.deps.history)
      .mockResolvedValueOnce({
        text: "owner-only material",
        visibilityDigest: "owner",
        hasWithheld: false,
      })
      .mockResolvedValue({
        text: "[Withheld: personal content of Host owner]",
        visibilityDigest: "owner-and-requester",
        hasWithheld: true,
      })
    await h.runner.startTurn(request())
    await drain()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2" }))
    await drain()
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.manager.addAgent).toHaveBeenCalledTimes(2)
    const options = h.manager.executeStreaming.mock.calls.at(-1)?.[2]
    expect(options).not.toHaveProperty("sessionId")
    expect(options?.context?.custom.conversationHistory).toBe(
      "[Withheld: personal content of Host owner]"
    )
    await h.runner.closeAll()
  })

  it("rechecks live readers after a replacement process launches", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn("again"))
    let joined = false
    jest.mocked(h.deps.history).mockImplementation(async () =>
      joined
        ? {
            text: "[Withheld: personal content of Host owner]",
            visibilityDigest: "all-readers",
            hasWithheld: true,
          }
        : { text: "owner-only material", visibilityDigest: "owner", hasWithheld: false }
    )
    await h.runner.startTurn(request())
    await drain()
    jest.mocked(h.manager.addAgent).mockImplementationOnce(async () => {
      joined = true
    })
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", model: "claude-opus" }))
    await drain()
    const options = h.manager.executeStreaming.mock.calls.at(-1)?.[2]
    expect(options).not.toHaveProperty("sessionId")
    expect(options?.context?.custom.conversationHistory).toBe(
      "[Withheld: personal content of Host owner]"
    )
    await h.runner.closeAll()
  })

  it("p6e starts a new process and lease when the model changes", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn())
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", model: "claude-opus" }))
    await flush()
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.deps.prepareLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-opus", sessionId: "person-agent-id2" })
    )
    expect(h.runner.liveAgent("s1")).toMatchObject({ agentId: "person-agent-id2" })
  })

  it("p6e grants tool permissions in the sandbox and declines elicitations", async () => {
    const h = harness()
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({
          type: "permission_request",
          sessionId: "native-1",
          request: {
            id: "p1",
            toolInfo: {},
            options: [
              { optionId: "no", kind: "reject_once", name: "No" },
              { optionId: "yes", kind: "allow_once", name: "Yes" },
            ],
          },
        }),
        event({ type: "elicitation_request", sessionId: "native-1", request: { id: "e1" } }),
        event({ type: "async_questions", sessionId: "native-1", requestId: "q1", questions: [] }),
        event({ type: "done", sessionId: "native-1", success: true }),
      ])
    )
    await h.runner.startTurn(request())
    await flush()
    expect(h.manager.respondToPermission).toHaveBeenCalledWith("person-agent-id1", "native-1", {
      requestId: "p1",
      granted: true,
      optionId: "yes",
      reason: "granted inside the member's sandbox",
    })
    expect(h.manager.respondToElicitation).toHaveBeenCalledWith("person-agent-id1", {
      requestId: "e1",
      action: "decline",
    })
    expect(h.manager.respondToPermission).toHaveBeenCalledWith(
      "person-agent-id1",
      "native-1",
      expect.objectContaining({ requestId: "q1", granted: false })
    )
    // Nothing visible was produced.
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "no_response", errorCode: undefined }])
  })

  it("p6e settles with the Host's stop reason and drops the process", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({
        type: "message_delta",
        sessionId: "native-1",
        delta: { type: "text", text: "partial" },
      }),
      event({ type: "error", sessionId: "native-1", error: "process exited" }),
    ])
    h.turns.push(turn)
    await h.plane.watchStops()
    await h.runner.startTurn(request())
    await flush()
    h.emit("external-agent://state-change", {
      agentId: "person-agent-id1",
      state: "Stopping",
      reason: "person_workspace_quota_exceeded",
    })
    turn.release()
    await flush()
    await flush()
    expect(h.settled).toEqual([
      { actionId: "a1", outcome: "failed", errorCode: "person_workspace_quota_exceeded" },
    ])
    expect(h.envelopes.at(-1)?.event).toMatchObject({
      kind: "failure",
      code: "person_workspace_quota_exceeded",
    })
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.runner.liveAgent("s1")).toBeUndefined()
    // The partial reply is kept.
    expect(h.writes.at(-1)?.parts).toEqual([{ type: "text", text: "partial" }])
  })

  it("p6e names the gateway's refusal when the agent reports it as its own error", async () => {
    const h = harness()
    // A clock past the first write interval: the streamed part is persisted.
    h.deps.now = () => 10_000
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({
          type: "message_delta",
          sessionId: "native-1",
          delta: {
            type: "text",
            text: 'API Error: 429 {"error":{"code":"member_usage_cap_reached","retryable":false}}',
          },
        }),
        event({ type: "done", sessionId: "native-1", success: false, stopReason: "end_turn" }),
      ])
    )
    await h.runner.startTurn(request())
    await drain()
    expect(h.settled).toEqual([
      { actionId: "a1", outcome: "failed", errorCode: "member_usage_cap_reached" },
    ])
    expect(h.envelopes.at(-1)?.event).toMatchObject({
      kind: "failure",
      code: "member_usage_cap_reached",
    })
    // The refusal text was written while it streamed; it is not a reply, so it goes.
    expect(h.writes.map((write) => write.parts.length)).toEqual([1])
    expect(h.order).toContain("remove:s1:assistant-a1")
    expect(h.liveFrames.at(-1)).toMatchObject({ state: "reset", parts: [] })
  })

  it("p6e keeps a real partial reply when the refusal follows it", async () => {
    const h = harness()
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({
          type: "message_delta",
          sessionId: "native-1",
          delta: { type: "text", text: "Here is the start" },
        }),
        event({
          type: "error",
          sessionId: "native-1",
          error:
            "API Error: Request rejected (429) · member monthly token cap reached (member_usage_cap_reached)",
        }),
      ])
    )
    await h.runner.startTurn(request())
    await drain()
    expect(h.settled[0]?.errorCode).toBe("member_usage_cap_reached")
    expect(h.writes.at(-1)?.parts).toEqual([{ type: "text", text: "Here is the start" }])
    expect(h.order.some((entry) => entry.startsWith("remove:"))).toBe(false)
  })

  it("p6e names the refusal when the agent's prompt rejects with the gateway's message", async () => {
    const h = harness()
    h.turns.push({
      release: () => undefined,
      held: false,
      async *run() {
        yield event({ type: "session_start", sessionId: "native-1" })
        // What Claude Code over ACP rejects with on the rig.
        throw new Error(
          "-32603: Internal error: API Error: Request rejected (429) · member monthly token cap reached (member_usage_cap_reached)"
        )
      },
    })
    await h.runner.startTurn(request())
    await drain()
    expect(h.settled).toEqual([
      { actionId: "a1", outcome: "failed", errorCode: "member_usage_cap_reached" },
    ])
  })

  it("p6e lifts only a closed list of codes out of agent text", () => {
    expect(gatewayRefusalIn(["429 member_usage_unavailable"])).toBe("member_usage_unavailable")
    expect(gatewayRefusalIn([undefined, "x", "(member_usage_cap_reached)"])).toBe(
      "member_usage_cap_reached"
    )
    // A longer identifier that merely contains a code is not the code.
    expect(gatewayRefusalIn(["not_member_usage_cap_reached_yet"])).toBeUndefined()
    expect(gatewayRefusalIn(["host_surface_forbidden", "rate limited"])).toBeUndefined()
  })

  it("p6e watches the Host's stop channels before any spawn", async () => {
    const h = harness()
    await h.plane.watchStops()
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await flush()
    h.emit("external-agent://exit", { agentId: "person-agent-id1", code: 1 })
    await flush()
    // An idle process that exits is gone; the next turn starts a new one.
    expect(h.runner.liveAgent("s1")).toBeUndefined()
  })

  it("p6e aborts through the agent's own cancel", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({ type: "done", sessionId: "native-1", success: true, stopReason: "cancelled" }),
    ])
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    await expect(h.runner.abort("s1")).resolves.toBe(true)
    expect(h.manager.cancel).toHaveBeenCalledWith("person-agent-id1", "native-1")
    turn.release()
    await flush()
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "cancelled", errorCode: undefined }])
    expect(h.envelopes.at(-1)?.event).toEqual({ kind: "lifecycle", phase: "interrupted" })
    await expect(h.runner.abort("s1")).resolves.toBe(false)
  })

  it("p6e queues a message behind the running turn and delivers it after", async () => {
    const h = harness({ holdLast: true })
    const first = replyTurn("one")
    const second = replyTurn("two")
    h.turns.push(first, second)
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", prompt: "next" }))
    await flush()
    // Accepted at once, delivered only once the first turn settles.
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(1)
    expect(h.envelopes.filter((entry) => entry.eventId.startsWith("person-agent:a2:"))).toEqual([
      {
        eventId: "person-agent:a2:0",
        event: { kind: "queue", phase: "accepted", queueId: "a2", delivery: "after-settle" },
      },
    ])
    first.release()
    await drain()
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(2)
    second.release()
    await drain()
    expect(h.settled.map((entry) => [entry.actionId, entry.outcome])).toEqual([
      ["a1", "completed"],
      ["a2", "completed"],
    ])
    expect(
      h.envelopes
        .filter((entry) => entry.eventId.startsWith("person-agent:a2:"))
        .map((entry) => entry.event.phase ?? entry.event.kind)
    ).toEqual(["accepted", "delivered", "started", "ended"])
  })

  it("p6e drops a queued message whose turn cannot start", async () => {
    const h = harness({ holdLast: true })
    const first = replyTurn()
    h.turns.push(first)
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", model: "claude-opus" }))
    jest
      .mocked(h.deps.prepareLease)
      .mockRejectedValueOnce(Object.assign(new Error("no"), { code: "model_access_unavailable" }))
    first.release()
    await flush()
    await flush()
    expect(h.settled).toContainEqual({
      actionId: "a2",
      outcome: "failed",
      errorCode: "model_access_unavailable",
    })
    expect(h.envelopes.at(-1)?.event).toEqual({
      kind: "queue",
      phase: "dropped",
      queueId: "a2",
      delivery: "after-settle",
      reason: "model_access_unavailable",
    })
  })

  it("p6e refuses a turn before launch when the agent is not bundled or the prompt has a document", async () => {
    const h = harness()
    await expect(h.runner.startTurn(request({ runtimeId: "pi" }))).rejects.toMatchObject({
      code: "org_agent_not_allowed",
    })
    await expect(
      h.runner.startTurn(
        request({
          prompt: [
            { type: "text", text: "read" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "x" },
            },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "person_agent_attachment_unsupported" })
    expect(h.deps.prepareLease).not.toHaveBeenCalled()
  })

  it("p6e cleans up a process whose connect failed", async () => {
    const h = harness()
    h.manager.addAgent.mockRejectedValueOnce(
      Object.assign(new Error("refused"), { code: "execution_isolation_unavailable" })
    )
    await expect(h.runner.startTurn(request())).rejects.toMatchObject({
      code: "execution_isolation_unavailable",
    })
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    await expect(
      h.plane.host.process.invoke("check_command_exists", { command: "claude-agent-acp" })
    ).resolves.toBe(false)
  })
})

describe("personAgentPrompt", () => {
  it("p6e passes text and images, never documents", () => {
    expect(personAgentPrompt("hi")).toEqual({ text: "hi", attachments: [] })
    expect(
      personAgentPrompt([
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "text", text: "here" },
      ])
    ).toEqual({
      text: "look\n\nhere",
      attachments: [
        { type: "image", source: { type: "base64", data: "AAA", mediaType: "image/png" } },
      ],
    })
  })
})

describe("person agent runner execution-broker lease", () => {
  it("holds a lease for exactly as long as the turn runs", async () => {
    const h = harness({ holdLast: true })
    const turn = replyTurn()
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    // The brain reports this count to the Host, which keeps the brain up for it.
    expect(h.broker.countRunning()).toBe(1)
    expect(h.broker.list()).toEqual([
      expect.objectContaining({ kind: "chat", sessionId: "s1", providerId: "anthropic" }),
    ])
    turn.release()
    await drain()
    expect(h.settled).toEqual([expect.objectContaining({ actionId: "a1", outcome: "completed" })])
    expect(h.broker.countRunning()).toBe(0)
  })

  it("releases the lease when the turn never starts", async () => {
    const h = harness()
    await expect(h.runner.startTurn(request({ runtimeId: "not-bundled" }))).rejects.toMatchObject({
      code: "org_agent_not_allowed",
    })
    expect(h.broker.countRunning()).toBe(0)
    expect(h.broker.list()).toEqual([])
  })

  it("accepts a turn the ceiling holds back without blocking, and starts it when room frees", async () => {
    const h = harness({ holdLast: true, turnLimit: 1 })
    const first = replyTurn("one")
    const second = replyTurn("two")
    h.turns.push(first, second)
    await h.runner.startTurn(request())
    await flush()
    // Another conversation's turn: the dispatcher gets control back at once.
    await h.runner.startTurn(request({ session: { id: "s2" }, actionId: "a2", messageId: "m2" }))
    await flush()
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(1)
    expect(h.envelopes).toContainEqual(
      expect.objectContaining({
        eventId: "person-agent:a2:0",
        event: expect.objectContaining({ kind: "queue", phase: "accepted" }),
      })
    )
    first.release()
    await drain()
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(2)
    expect(h.broker.countRunning()).toBe(1)
    expect(h.envelopes).toContainEqual(
      expect.objectContaining({
        eventId: "person-agent:a2:1",
        event: expect.objectContaining({ kind: "queue", phase: "delivered" }),
      })
    )
    second.release()
    await drain()
    expect(h.settled.map((entry) => [entry.actionId, entry.outcome])).toEqual([
      ["a1", "completed"],
      ["a2", "completed"],
    ])
    expect(h.broker.countRunning()).toBe(0)
  })

  it("stops the turn when the broker cancels its lease", async () => {
    const h = harness({ holdLast: true })
    const turn = replyTurn()
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    expect(h.broker.cancelBySession("s1")).toBe(1)
    await flush()
    expect(h.manager.cancel).toHaveBeenCalledWith(
      expect.stringMatching(/^person-agent-/),
      "native-1"
    )
    turn.release()
    await drain()
    expect(h.settled).toEqual([expect.objectContaining({ actionId: "a1", outcome: "cancelled" })])
    expect(h.broker.countRunning()).toBe(0)
  })
})

it("R10 runner binds its action Host run and preserves clean replay", async () => {
  const h = harness()
  h.turns.push(replyTurn())
  await h.runner.startTurn(request())
  await drain()
  const options = h.manager.executeStreaming.mock.calls[0]?.[2]
  expect(personalEgressOptionsSource(options)).toEqual({
    sessionId: "s1",
    executionRunId: hostStateRunId("a1"),
  })
  expect(options?.context?.custom?.conversationHistory).toBe("User: earlier\n\nAssistant: reply")
  expect(h.settled).toEqual([{ actionId: "a1", outcome: "completed", errorCode: undefined }])
  await h.runner.closeAll()
})

it("R10 real runner settles clean replay and refuses a marked turn before tool reuse on every engine without a Cognia model", async () => {
  const { createDbTestFixture } = await import("@/lib/db/test-fixture")
  const { getDb } = await import("@/lib/db/schema")
  const { startToolExecutionRun, LOCAL_PERSON_RUN } =
    await import("@/lib/execution/acting-authority")
  const { preparePersonalHistory } = await import("@/lib/execution/personal-visibility")
  const { ExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  const { BaseProtocolAdapter, protocolAdapterRegistry } =
    await import("@/lib/ai/agent/external/protocol-adapter")
  type Config = import("@/types/agent/external-agent").ExternalAgentConfig
  type Message = import("@/types/agent/external-agent").ExternalAgentMessage
  type Options = import("@/types/agent/external-agent").ExternalAgentExecutionOptions
  type Session = import("@/types/agent/external-agent").ExternalAgentSession
  type CreateOptions = import("@/lib/ai/agent/external/protocol-adapter").SessionCreateOptions
  class RecordingAdapter extends BaseProtocolAdapter {
    readonly protocol = "test"
    lastMessage?: Message
    lastOptions?: Options
    lastSessionOptions?: CreateOptions
    async connect(config: Config) {
      this._config = config
      this._connectionStatus = "connected"
    }
    async disconnect() {
      this._connectionStatus = "disconnected"
      this._sessions.clear()
    }
    async createSession(options?: CreateOptions): Promise<Session> {
      this.lastSessionOptions = options
      const session: Session = {
        id: this.generateSessionId(),
        agentId: this._config!.id,
        status: "active",
        createdAt: new Date(),
        lastActivityAt: new Date(),
        messages: [],
        permissionMode: "default",
        metadata: options?.metadata,
      }
      this._sessions.set(session.id, session)
      return session
    }
    async closeSession(id: string) {
      this._sessions.delete(id)
    }
    async *prompt(id: string, message: Message, options?: Options) {
      this.lastMessage = message
      this.lastOptions = options
      yield event({ type: "message_delta", sessionId: id, delta: { type: "text", text: "reply" } })
      yield event({ type: "done", sessionId: id, success: true, stopReason: "end_turn" })
    }
    async respondToPermission() {}
    async cancel() {}
  }
  const fixture = createDbTestFixture({ seeded: false })
  await fixture.initialize()
  try {
    for (const [index, protocol, marked] of [
      [0, "acp", false],
      [1, "acp", true],
      [2, "codex-app-server", true],
    ] as const) {
      ExternalAgentManager.resetInstance()
      const manager = ExternalAgentManager.getInstance({ healthCheckInterval: 0 })
      const adapter = new RecordingAdapter()
      protocolAdapterRegistry.register(protocol, () => adapter)
      const h = harness()
      h.deps.manager = manager
      h.deps.launchFor = () => ({
        config: {
          id: "r10",
          name: "R10",
          protocol,
          transport: "http",
          process: { command: "test", args: [] },
          enabled: true,
          timeout: 100,
          retryConfig: {
            maxRetries: 0,
            retryDelay: 0,
            exponentialBackoff: false,
            maxRetryDelay: 0,
            retryOnErrors: [],
          },
        } as Config,
        family: "test",
      })
      const sessionId = `r10-person-${index}`,
        actionId = `r10-action-${index}`
      const run = await startToolExecutionRun(sessionId, {
        runId: hostStateRunId(actionId),
        localAuthorization:
          LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
      })
      const message = {
        id: `r10-message-${index}`,
        sessionId,
        role: "user",
        parts: [{ type: "text", text: "replayed history" }],
        metadata: {
          personalMarkVersion: 1,
          ...(marked
            ? { personalMarks: [{ person: { kind: "local-person" }, source: "R10", markedAt: 1 }] }
            : {}),
        },
      }
      await getDb().messages.put(message as never)
      let replay = ""
      h.deps.history = async () => {
        const prepared = await preparePersonalHistory(sessionId, [message as never], {
          executionRunId: run.id,
        })
        replay = JSON.stringify(prepared.messages)
        return {
          text: replay,
          visibilityDigest: prepared.visibilityDigest,
          hasWithheld: !!prepared.withheldMessageIds.length,
        }
      }
      try {
        await h.runner.startTurn(request({ session: { id: sessionId }, actionId, prompt: "next" }))
        for (let attempt = 0; !h.settled.length && attempt < 200; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 1))
        expect(h.settled).toEqual([
          {
            actionId,
            outcome: marked ? "failed" : "completed",
            errorCode: marked ? "personal-egress-denied" : undefined,
          },
        ])
        if (marked) expect(adapter.lastMessage).toBeUndefined()
        else {
          expect(adapter.lastMessage?.content).toEqual([{ type: "text", text: "next" }])
          expect(adapter.lastOptions?.context?.custom?.conversationHistory).toBe(replay)
          expect(replay).toContain("replayed history")
        }
      } finally {
        await h.runner.closeAll()
        await manager.dispose()
      }
    }
  } finally {
    await fixture.dispose()
  }
})
