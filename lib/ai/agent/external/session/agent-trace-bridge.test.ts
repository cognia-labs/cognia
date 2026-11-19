import type { AgentTraceSpan } from "@cognia/agent-trace"
import {
  __resetAgentTraceEmitterForTesting,
  setAgentTraceWriter,
} from "@cognia/agent-trace/emitter"
import { createExternalAgentTraceBridge } from "./agent-trace-bridge"

function captureWriter(): {
  spans: AgentTraceSpan[]
  install(): void
} {
  const spans: AgentTraceSpan[] = []
  return {
    spans,
    install() {
      setAgentTraceWriter((s) => {
        spans.push(s)
      })
    },
  }
}

beforeEach(() => {
  __resetAgentTraceEmitterForTesting()
})

describe("createExternalAgentTraceBridge", () => {
  it("maps the manager's standard result and preserves reported USD accounting on failure", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1", turnId: "t1" })
    await bridge.onStart("p")
    await bridge.onComplete({
      success: false,
      finalResponse: "partial answer",
      error: "provider failed",
      tokenUsage: {
        promptTokens: 150,
        promptTokensIncludeCache: true,
        completionTokens: 20,
        totalTokens: 170,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        providerCost: { amount: 0.03, currency: "USD" },
      },
    })
    expect(cap.spans[0]).toMatchObject({
      status: "error",
      errorType: "external_agent_error",
      errorMessage: "provider failed",
      turnId: "t1",
      outputPreview: "partial answer",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 10 },
      costUsdEstimate: 0.03,
    })
  })

  it("retains the latest streamed usage and output when the manager closes with an empty summary", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onEvent({ type: "message_delta", delta: { type: "text", text: "answer" } })
    await bridge.onEvent({
      type: "usage_update",
      tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })
    await bridge.onEvent({
      type: "done",
      success: false,
      tokenUsage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    })
    await bridge.onComplete({ success: false, finalResponse: "" })
    expect(cap.spans[0]).toMatchObject({
      status: "error",
      outputPreview: "answer",
      usage: { inputTokens: 20, outputTokens: 4 },
    })
  })

  it("does not relabel non-USD provider cost or empty counters as USD or real usage", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onComplete({
      success: true,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        providerCost: { amount: 2, currency: "EUR" },
      },
    })
    expect(cap.spans[0].costUsdEstimate).toBeUndefined()
    expect(cap.spans[0].usage).toBeUndefined()
  })
  it("returns a bridge exposing the 4 lifecycle methods", () => {
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    expect(typeof bridge.onStart).toBe("function")
    expect(typeof bridge.onEvent).toBe("function")
    expect(typeof bridge.onComplete).toBe("function")
    expect(typeof bridge.onError).toBe("function")
  })

  it("onStart + onComplete emits one invoke_agent span with usage + cost", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s1",
      agentId: "researcher",
      agentName: "Researcher",
      modelId: "claude-opus-4-7",
      turnId: "t-9",
      protocol: "acp",
      transport: "stdio",
      parentSpanId: "1111222233334444",
      tags: ["external-agent"],
      metadata: { runtime: "test" },
    })
    await bridge.onStart("write a haiku")
    await bridge.onComplete({
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      },
      finish_reason: "stop",
      model: "claude-opus-4-7-actual",
      result: "haiku text",
    })
    expect(cap.spans).toHaveLength(1)
    const span = cap.spans[0]
    expect(span.operationName).toBe("invoke_agent")
    expect(span.providerName).toBe("cognia.team")
    expect(span.surface).toBe("agent-team")
    expect(span.agentId).toBe("researcher")
    expect(span.requestModel).toBe("claude-opus-4-7")
    expect(span.responseModel).toBe("claude-opus-4-7-actual")
    expect(span.parentSpanId).toBe("1111222233334444")
    expect(span.handoff?.toAgent).toBe("researcher")
    expect(span.inputPreview).toBe("write a haiku")
    expect(span.outputPreview).toBe("haiku text")
    expect(span.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    })
    expect(span.costUsdEstimate).toBeCloseTo(0.0123)
    expect(span.finishReasons).toEqual(["stop"])
    expect(span.metadata?.turnId).toBe("t-9")
    expect(span.metadata?.protocol).toBe("acp")
  })

  it("recognises anthropic protocol -> anthropic provider", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s1",
      agentId: "a1",
      protocol: "anthropic",
    })
    await bridge.onStart("hi")
    await bridge.onComplete({})
    expect(cap.spans[0]?.providerName).toBe("anthropic")
  })

  it("falls back to local model pricing when the external result omits cost", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s1",
      agentId: "a1",
      protocol: "anthropic",
      modelId: "claude-sonnet-4-6",
    })
    await bridge.onStart("p")
    await bridge.onComplete({
      usage: {
        input_tokens: 1_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    })

    expect(cap.spans[0]?.costUsdEstimate).toBeCloseTo(0.003 + 0.03 + 0.00015 + 0.000375)
  })

  it("accepts array prompts and joins text fragments", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s1",
      agentId: "a1",
    })
    await bridge.onStart(["a", { text: "b" }, { irrelevant: true }, "c"])
    await bridge.onComplete({})
    expect(cap.spans[0]?.inputPreview).toBe("a\nb\nc")
  })

  it("omits inputPreview when the prompt is empty / unknown shape", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart({ unrecognised: true })
    await bridge.onComplete({})
    expect(cap.spans[0]?.inputPreview).toBeUndefined()
  })

  it("onEvent appends events with type / name / event keys", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onEvent({ type: "ping", value: 1 })
    await bridge.onEvent({ name: "tool", value: 2 })
    await bridge.onEvent("not-an-object")
    await bridge.onComplete({})
    const events = cap.spans[0]?.events ?? []
    expect(events).toHaveLength(3)
    expect(events[0]?.name).toBe("ping")
    expect(events[1]?.name).toBe("tool")
    expect(events[2]?.name).toBe("external_event")
  })

  it("ignores events / completions before onStart", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onEvent({ type: "early" })
    await bridge.onComplete({ ok: true })
    expect(cap.spans).toHaveLength(0)
  })

  it("onError emits an error span", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onEvent({
      type: "usage_update",
      tokenUsage: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        providerCost: { amount: 0.03, currency: "USD" },
      },
    })
    await bridge.onError(new Error("boom"), { detail: 1 })
    expect(cap.spans).toHaveLength(1)
    expect(cap.spans[0].errorType).toBe("external_agent_error")
    expect(cap.spans[0].errorMessage).toBe("boom")
    expect(cap.spans[0].metadata?.context).toEqual({ detail: 1 })
    expect(cap.spans[0]).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 2 },
      costUsdEstimate: 0.03,
    })
  })

  it("onError accepts a string error and stringifies non-Error objects", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge1 = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge1.onStart("p")
    await bridge1.onError("uh oh")
    expect(cap.spans[0].errorMessage).toBe("uh oh")

    const bridge2 = createExternalAgentTraceBridge({ sessionId: "s2", agentId: "a1" })
    await bridge2.onStart("p")
    await bridge2.onError({ message: "from object" })
    expect(cap.spans[1].errorMessage).toBe("from object")

    const bridge3 = createExternalAgentTraceBridge({ sessionId: "s3", agentId: "a1" })
    await bridge3.onStart("p")
    await bridge3.onError(42)
    expect(cap.spans[2].errorMessage).toBe("42")
  })

  it("is idempotent — onComplete after onError is dropped", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onError(new Error("boom"))
    await bridge.onComplete({})
    expect(cap.spans).toHaveLength(1)
    expect(cap.spans[0].errorMessage).toBe("boom")
  })

  it("drops the usage block when every counter is 0 and reports finish_reason array", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onComplete({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      finishReason: ["tool_use", "stop"],
    })
    expect(cap.spans[0].usage).toBeUndefined()
    expect(cap.spans[0].finishReasons).toEqual(["tool_use", "stop"])
  })

  it("extracts usage from a nested message.usage shape (Anthropic stream-final)", async () => {
    const cap = captureWriter()
    cap.install()
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await bridge.onStart("p")
    await bridge.onComplete({
      message: {
        usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
      },
    })
    expect(cap.spans[0].usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheCreationTokens: 0,
      cacheReadTokens: 2,
    })
  })

  it("never throws even when the writer rejects", async () => {
    setAgentTraceWriter(() => {
      throw new Error("writer fail")
    })
    const bridge = createExternalAgentTraceBridge({ sessionId: "s1", agentId: "a1" })
    await expect(bridge.onStart("p")).resolves.toBeUndefined()
    await expect(bridge.onComplete({})).resolves.toBeUndefined()
  })
})
