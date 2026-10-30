import { appendGatewayRequestLog } from "@/lib/db/gateway-request-log"
import { forwardGatewayOutcome } from "./telemetry-forwarder"
import { installGatewayTelemetrySubscription } from "./telemetry-subscription"
import type { Transport } from "@/lib/tauri/transport-types"
import { GATEWAY_REQUEST_LOG_EVENT, GATEWAY_REQUEST_OUTCOME_EVENT } from "@/types/gateway"

jest.mock("@/lib/db/gateway-request-log", () => ({
  appendGatewayRequestLog: jest.fn(async () => {}),
}))
jest.mock("./telemetry-forwarder", () => ({ forwardGatewayOutcome: jest.fn() }))

function source() {
  const handlers = new Map<string, (value: unknown) => void>()
  const stopped: string[] = []
  const subscribe = jest.fn((event: string, handler: (value: unknown) => void) => {
    handlers.set(event, handler)
    return () => {
      stopped.push(event)
      handlers.delete(event)
    }
  })
  return { transport: { subscribe } as Pick<Transport, "subscribe">, subscribe, handlers, stopped }
}

const event = { ownerAccountId: "account-a", accountGeneration: 3, providerId: "p", modelId: "m" }
async function settle() {
  for (let tick = 0; tick < 5; tick++) await Promise.resolve()
}

beforeEach(() => jest.clearAllMocks())

it("delivers once per event when two desktop/runtime owners overlap", () => {
  const { transport, subscribe, handlers, stopped } = source()
  const acceptsEvent = () => true
  const stopOne = installGatewayTelemetrySubscription(transport, { acceptsEvent })
  const stopTwo = installGatewayTelemetrySubscription(transport, { acceptsEvent })
  expect(subscribe).toHaveBeenCalledTimes(2)
  handlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!(event)
  handlers.get(GATEWAY_REQUEST_LOG_EVENT)!(event)
  expect(forwardGatewayOutcome).toHaveBeenCalledTimes(1)
  expect(appendGatewayRequestLog).toHaveBeenCalledTimes(1)
  stopOne()
  stopOne()
  expect(stopped).toEqual([])
  handlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!(event)
  expect(forwardGatewayOutcome).toHaveBeenCalledTimes(2)
  stopTwo()
  expect(stopped.sort()).toEqual([GATEWAY_REQUEST_LOG_EVENT, GATEWAY_REQUEST_OUTCOME_EVENT].sort())
  expect(handlers.size).toBe(0)
})

it("does not deliver a queued callback after the final unsubscribe", async () => {
  const { transport, handlers } = source()
  let resolve!: (value: boolean) => void
  const allowed = new Promise<boolean>((done) => {
    resolve = done
  })
  const stop = installGatewayTelemetrySubscription(transport, { acceptsEvent: () => allowed })
  const callback = handlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!
  callback(event)
  stop()
  resolve(true)
  await settle()
  callback(event)
  expect(forwardGatewayOutcome).not.toHaveBeenCalled()
})

it("rechecks the active account before a deferred authority answer can write", async () => {
  const { transport, handlers } = source()
  let active = true
  let resolve!: (value: boolean) => void
  const allowed = new Promise<boolean>((done) => {
    resolve = done
  })
  const stop = installGatewayTelemetrySubscription(transport, {
    acceptsEvent: () => allowed,
    isCurrent: () => active,
  })
  handlers.get(GATEWAY_REQUEST_LOG_EVENT)!(event)
  active = false
  resolve(true)
  await settle()
  expect(appendGatewayRequestLog).not.toHaveBeenCalled()
  stop()
})

it("requires an accepting owner and ignores lookup failures or malformed events", async () => {
  const { transport, handlers } = source()
  const stopOne = installGatewayTelemetrySubscription(transport, {
    acceptsEvent: () => {
      throw new Error("unavailable")
    },
  })
  const stopTwo = installGatewayTelemetrySubscription(transport, {
    acceptsEvent: async () => {
      throw new Error("unavailable")
    },
  })
  const stopThree = installGatewayTelemetrySubscription(transport, { acceptsEvent: () => false })
  handlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!(event)
  handlers.get(GATEWAY_REQUEST_LOG_EVENT)!(null)
  await settle()
  expect(forwardGatewayOutcome).not.toHaveBeenCalled()
  expect(appendGatewayRequestLog).not.toHaveBeenCalled()
  stopOne()
  stopTwo()
  stopThree()
})

it("shares one delivery across asynchronous authorities and releases physical listeners", async () => {
  const { transport, handlers } = source()
  const stopOne = installGatewayTelemetrySubscription(transport, { acceptsEvent: async () => true })
  const stopTwo = installGatewayTelemetrySubscription(transport, { acceptsEvent: async () => true })
  handlers.get(GATEWAY_REQUEST_OUTCOME_EVENT)!(event)
  await settle()
  expect(forwardGatewayOutcome).toHaveBeenCalledTimes(1)
  stopOne()
  stopTwo()
  expect(handlers.size).toBe(0)
})

it("cleans the first listener if registration of the log listener fails", () => {
  const stop = jest.fn()
  const transport = {
    subscribe: jest
      .fn()
      .mockReturnValueOnce(stop)
      .mockImplementationOnce(() => {
        throw new Error("closed")
      }),
  } as Pick<Transport, "subscribe">
  expect(() =>
    installGatewayTelemetrySubscription(transport, { acceptsEvent: () => true })
  ).toThrow("closed")
  expect(stop).toHaveBeenCalledTimes(1)
})
