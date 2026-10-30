/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"
import { GATEWAY_REQUEST_LOG_EVENT, GATEWAY_REQUEST_OUTCOME_EVENT } from "@/types/gateway"

const mockHandlers = new Map<string, (value: unknown) => void>()
const mockForward = jest.fn()
const mockAppend = jest.fn(async (_event: unknown) => {})
let mockActiveAccount = "local-a"
const mockTransport = {
  subscribe: jest.fn((event: string, handler: (value: unknown) => void) => {
    mockHandlers.set(event, handler)
    return () => {
      mockHandlers.delete(event)
    }
  }),
  call: jest.fn(),
  whenSubscribed: jest.fn(async () => {}),
  hasSubscribedChannels: jest.fn(() => true),
}

jest.mock("@/lib/tauri", () => ({ transport: mockTransport }))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => mockActiveAccount,
}))
jest.mock("@/lib/gateway/telemetry-forwarder", () => ({
  forwardGatewayOutcome: (event: unknown) => mockForward(event),
}))
jest.mock("@/lib/db/gateway-request-log", () => ({
  appendGatewayRequestLog: (event: unknown) => mockAppend(event),
}))

const status = { accountRequired: true, ownerAccountId: "local-a", accountGeneration: 3 }
const event = {
  ...status,
  providerId: "p",
  modelId: "m",
  sessionId: "s",
  ok: true,
  latencyMs: 1,
  inputTokens: 2,
  outputTokens: 1,
  errorMessage: null,
}
const row = {
  ...event,
  id: "request-a",
  at: "2026-10-29T00:00:00Z",
  route: "/v1/chat/completions",
  remoteIp: "127.0.0.1",
  keyId: "k",
  model: "m",
  status: 200,
  error: null,
  stream: false,
}
let stop: (() => void) | undefined

function context(host: HeadlessRuntimeContext["host"] = "brain"): HeadlessRuntimeContext {
  return {
    host,
    localAccountId: "local-a",
    bridge: {
      listen: jest.fn(async () => () => {}),
      invoke: jest.fn(async () => null),
      respondMedia: jest.fn(async () => {}),
    },
    notifyDbWrite: () => {},
    resolveMessage: (key) => key,
    log: () => {},
  }
}

async function start(ctx = context()) {
  const registry = await import("../registry")
  registry.__resetHeadlessRuntimesForTesting()
  await import("./gateway-telemetry")
  const runtime = registry
    .listHeadlessRuntimes()
    .find((runtime) => runtime.name === "gateway-telemetry")!
  const teardown = await runtime.start(ctx)
  if (typeof teardown !== "function") throw new Error("missing telemetry teardown")
  stop = teardown
  return { ctx, runtime }
}

async function emit(channel: string, payload: unknown) {
  mockHandlers.get(channel)!(payload)
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
  mockHandlers.clear()
  mockActiveAccount = "local-a"
  mockTransport.call.mockReset().mockResolvedValue(status)
  mockTransport.whenSubscribed.mockReset().mockResolvedValue(undefined)
  mockTransport.hasSubscribedChannels.mockReset().mockReturnValue(true)
})
afterEach(() => {
  stop?.()
  stop = undefined
  jest.useRealTimers()
})

it("installs on authenticated transport events and persists native usage and logs", async () => {
  const { ctx, runtime } = await start()
  expect(runtime.criticality).toBe("required")
  expect(runtime.hosts).toEqual(["brain", "person-brain"])
  expect(ctx.bridge.listen).not.toHaveBeenCalled()
  expect(mockTransport.whenSubscribed).toHaveBeenCalledWith(
    [GATEWAY_REQUEST_LOG_EVENT, GATEWAY_REQUEST_OUTCOME_EVENT],
    5_000
  )
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  await emit(GATEWAY_REQUEST_LOG_EVENT, row)
  expect(mockTransport.call).toHaveBeenCalledWith("gateway_status")
  expect(mockForward).toHaveBeenCalledWith(event)
  expect(mockAppend).toHaveBeenCalledWith(row)
  stop!()
  expect(mockHandlers.size).toBe(0)
})

it("rejects another account, a stale generation and a different operator owner", async () => {
  await start()
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, { ...event, ownerAccountId: "other" })
  await emit(GATEWAY_REQUEST_LOG_EVENT, { ...row, accountGeneration: 2 })
  mockTransport.call.mockResolvedValue({ ...status, ownerAccountId: "other" })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  expect(mockForward).not.toHaveBeenCalled()
  expect(mockAppend).not.toHaveBeenCalled()
})

it("accepts only the authenticated member audience in a person brain", async () => {
  mockTransport.call.mockImplementation(async (command: string) => {
    if (command === "person_agent_policy_get") return { gatewayTelemetry: status }
    throw new Error("host_surface_forbidden")
  })
  await start(context("person-brain"))
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  expect(mockForward).toHaveBeenCalledTimes(1)
  expect(mockTransport.call).toHaveBeenCalledWith("person_agent_policy_get", {})
  expect(mockTransport.call).not.toHaveBeenCalledWith("gateway_status")
  mockForward.mockClear()
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, { ...event, ownerAccountId: "operator" })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, { ...event, ownerAccountId: undefined })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, { ...event, accountGeneration: 2 })
  mockTransport.call.mockResolvedValue({
    gatewayTelemetry: { ...status, ownerAccountId: "operator" },
  })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  mockTransport.call.mockResolvedValue({ ...status, ownerAccountId: null, accountRequired: false })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, { ...event, ownerAccountId: undefined })
  expect(mockForward).not.toHaveBeenCalled()
})

it("starts with the gateway disabled and never grants member authority from an absent view", async () => {
  mockTransport.call.mockResolvedValue({ gatewayTelemetry: null })
  await start(context("person-brain"))
  expect(mockTransport.call).not.toHaveBeenCalled()
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  expect(mockForward).not.toHaveBeenCalled()
  mockTransport.call.mockResolvedValue({ gatewayTelemetry: status })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, event)
  expect(mockForward).toHaveBeenCalledWith(event)
})

it("accepts unowned standalone events only with explicit accountRequired false", async () => {
  mockTransport.call.mockResolvedValue({ ...status, ownerAccountId: null, accountRequired: false })
  await start()
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, {
    ...event,
    ownerAccountId: undefined,
    accountGeneration: undefined,
  })
  expect(mockForward).toHaveBeenCalledTimes(1)
  mockForward.mockClear()
  mockTransport.call.mockResolvedValue({
    ...status,
    ownerAccountId: null,
    accountRequired: undefined,
  })
  await emit(GATEWAY_REQUEST_OUTCOME_EVENT, {
    ...event,
    ownerAccountId: undefined,
    accountGeneration: undefined,
  })
  expect(mockForward).not.toHaveBeenCalled()
})

it.each(["account", "epoch", "stop"])(
  "discards pending authority results after %s changes",
  async (change) => {
    let finish!: (value: unknown) => void
    mockTransport.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await start()
    mockHandlers.get(GATEWAY_REQUEST_LOG_EVENT)!(row)
    if (change === "account") mockActiveAccount = "local-b"
    if (change === "stop") stop!()
    finish(change === "epoch" ? { ...status, accountGeneration: 4 } : status)
    for (let tick = 0; tick < 12; tick++) await Promise.resolve()
    expect(mockAppend).not.toHaveBeenCalled()
  }
)

it("fails required startup and detaches subscriptions when the event socket is unavailable", async () => {
  mockTransport.whenSubscribed.mockRejectedValueOnce(new Error("event subscription refused"))
  await expect(start()).rejects.toThrow("event subscription refused")
  expect(mockHandlers.size).toBe(0)
})

it("refuses startup when a resolved wait has no accepted event acknowledgement", async () => {
  mockTransport.hasSubscribedChannels.mockReturnValue(false)
  await expect(start()).rejects.toThrow("gateway_telemetry_events_unavailable")
  expect(mockHandlers.size).toBe(0)
})

it("bounds unavailable status lookups and cannot write after their deadline", async () => {
  jest.useFakeTimers()
  let finish!: (value: unknown) => void
  mockTransport.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await start()
  mockHandlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!(event)
  await jest.advanceTimersByTimeAsync(3_000)
  finish(status)
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
  expect(mockForward).not.toHaveBeenCalled()
})
