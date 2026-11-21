import {
  forwardGatewayOutcome,
  gatewayOutcomeToProviderOutcome,
  gatewayUsageOperationId,
} from "./telemetry-forwarder"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordSurfaceUsage } from "@/lib/db/session-usage"
import type { GatewayRequestOutcome } from "@/types/gateway"
import { registerGatewayTaskAttribution, resetGatewayTaskAttributions } from "./task-attribution"

jest.mock("@/lib/claude/provider-telemetry", () => ({
  recordProviderOutcome: jest.fn(),
}))

jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: jest.fn(async () => null),
  swallowUsageWrite: (p: Promise<unknown>) => void p.catch(() => {}),
}))

const mockSessions = new Map<string, { projectId?: string }>()
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async (id: string) => mockSessions.get(id)),
}))

let mockDatabase = "cognia-account-a"
jest.mock("@/lib/db/schema", () => ({ activeDatabaseName: () => mockDatabase }))

/** Let the forwarder's deferred ledger write run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const base: GatewayRequestOutcome = {
  providerId: "openai",
  modelId: "gpt-4o",
  ok: true,
  latencyMs: 120,
  inputTokens: 10,
  outputTokens: 5,
  errorMessage: null,
}

describe("gatewayOutcomeToProviderOutcome", () => {
  it("sums tokens and maps the core fields incl. the breakdown", () => {
    expect(gatewayOutcomeToProviderOutcome(base)).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      ok: true,
      latencyMs: 120,
      tokensUsed: 15,
      // Breakdown forwarded so the sink can estimate cost (gateway has no cost).
      inputTokens: 10,
      outputTokens: 5,
    })
  })

  it("omits tokensUsed when both token counts are null", () => {
    const o = gatewayOutcomeToProviderOutcome({
      ...base,
      inputTokens: null,
      outputTokens: null,
    })
    expect("tokensUsed" in o).toBe(false)
  })

  it("carries the error message on failures", () => {
    const o = gatewayOutcomeToProviderOutcome({
      ...base,
      ok: false,
      errorMessage: "HTTP 429",
    })
    expect(o.ok).toBe(false)
    expect(o.errorMessage).toBe("HTTP 429")
  })

  it("treats a single present token count as a partial sum", () => {
    expect(gatewayOutcomeToProviderOutcome({ ...base, outputTokens: null }).tokensUsed).toBe(10)
  })

  it("forwards sessionId (affinity) and retryAfterMs (breaker cooldown) when present", () => {
    const o = gatewayOutcomeToProviderOutcome({
      ...base,
      ok: false,
      errorMessage: "HTTP 429",
      sessionId: "gw-cc-abc",
      retryAfterMs: 30_000,
    })
    expect(o.sessionId).toBe("gw-cc-abc")
    expect(o.retryAfterMs).toBe(30_000)
  })

  it("omits sessionId / retryAfterMs when absent or null", () => {
    const o = gatewayOutcomeToProviderOutcome({ ...base, sessionId: null, retryAfterMs: null })
    expect("sessionId" in o).toBe(false)
    expect("retryAfterMs" in o).toBe(false)
    // Also absent when the fields aren't on the outcome at all (older events).
    const o2 = gatewayOutcomeToProviderOutcome(base)
    expect("sessionId" in o2).toBe(false)
    expect("retryAfterMs" in o2).toBe(false)
  })
})

describe("gatewayUsageOperationId", () => {
  it("is stable for the same outcome and clock", () => {
    expect(gatewayUsageOperationId(base, 1000)).toBe(gatewayUsageOperationId(base, 1000))
  })

  it("separates sessions and providers", () => {
    const a = gatewayUsageOperationId({ ...base, sessionId: "s1" }, 1000)
    const b = gatewayUsageOperationId({ ...base, sessionId: "s2" }, 1000)
    expect(a).not.toBe(b)
  })

  it("falls back to an anonymous scope when the gateway reports no session", () => {
    expect(gatewayUsageOperationId(base, 1000)).toContain(":anon:")
  })

  it("keys a request by its own id, whatever millisecond it lands in (F16)", () => {
    const a = gatewayUsageOperationId({ ...base, requestId: "req-a" }, 1000)
    const b = gatewayUsageOperationId({ ...base, requestId: "req-b" }, 1000)
    expect(a).toBe("gw:req-a")
    expect(a).not.toBe(b)
    // A redelivered outcome for the same request lands on the same row.
    expect(gatewayUsageOperationId({ ...base, requestId: "req-a" }, 9999)).toBe(a)
  })
})

describe("forwardGatewayOutcome", () => {
  beforeEach(() => {
    ;(recordProviderOutcome as jest.Mock).mockClear()
    ;(recordSurfaceUsage as jest.Mock).mockClear()
    resetGatewayTaskAttributions()
    mockSessions.clear()
    mockDatabase = "cognia-account-a"
  })

  it("records the mapped outcome into the telemetry sink", () => {
    forwardGatewayOutcome(base)
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", tokensUsed: 15 })
    )
  })

  it("writes a canonical ledger row so gateway traffic reaches the budget", async () => {
    forwardGatewayOutcome(base, 1000)
    await settle()
    expect(recordSurfaceUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "gateway",
        operationId: gatewayUsageOperationId(base, 1000),
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 5,
          model: "gpt-4o",
          providerId: "openai",
          usageBasis: "provider-reported",
        }),
      })
    )
  })

  it("bills nothing for a failed request that reported no tokens", async () => {
    forwardGatewayOutcome({
      ...base,
      ok: false,
      errorMessage: "boom",
      inputTokens: null,
      outputTokens: null,
    })
    await settle()
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })

  it("books a failed request that still reported tokens: the provider billed them (F16)", async () => {
    forwardGatewayOutcome({ ...base, ok: false, errorMessage: "stream stalled", requestId: "r" })
    await settle()
    expect(recordSurfaceUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "gw:r",
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      })
    )
  })

  it("leaves a request the Passthrough Ledger booked to the ledger (F20)", async () => {
    forwardGatewayOutcome({ ...base, requestId: "r", ledgered: true })
    await settle()
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
    // Its health still trains the breaker.
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", ok: true })
    )
  })

  it("skips a success that reported no tokens at all", async () => {
    forwardGatewayOutcome({ ...base, inputTokens: null, outputTokens: null })
    await settle()
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })

  it("books an external agent's Cognia-model request to its conversation's workspace (F02)", async () => {
    mockSessions.set("chat-1", { projectId: "proj-1" })
    registerGatewayTaskAttribution("task-1", { chatSessionId: "chat-1" })
    // A desktop ticket's session is the task id; a Host lease scopes it.
    forwardGatewayOutcome({ ...base, sessionId: "task-1", requestId: "a" })
    forwardGatewayOutcome({
      ...base,
      sessionId: JSON.stringify(["host-task", "device-1", "task-1"]),
      requestId: "b",
    })
    await settle()
    const usages = (recordSurfaceUsage as jest.Mock).mock.calls.map(([args]) => args.usage)
    expect(usages).toEqual([
      expect.objectContaining({ projectId: "proj-1", providerId: "openai" }),
      expect.objectContaining({ projectId: "proj-1", providerId: "openai" }),
    ])
  })

  it("leaves a request no task claims without a workspace", async () => {
    forwardGatewayOutcome({ ...base, sessionId: "affinity-hash", requestId: "a" })
    await settle()
    const [[args]] = (recordSurfaceUsage as jest.Mock).mock.calls
    expect(args.usage).not.toHaveProperty("projectId")
  })

  it("drops the write when another account opened before it landed (F27)", async () => {
    mockSessions.set("chat-1", { projectId: "proj-1" })
    registerGatewayTaskAttribution("task-1", { chatSessionId: "chat-1" })
    forwardGatewayOutcome({ ...base, sessionId: "task-1", requestId: "a" })
    mockDatabase = "cognia-account-b"
    await settle()
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })
})
