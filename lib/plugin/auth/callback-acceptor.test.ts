/** @jest-environment jsdom */
import {
  AuthCallbackAcceptor,
  acceptCallback,
  registerAuthCallbackWaiter,
  routeHostAuthCallback,
  startHostAuthCallbackListeners,
} from "./callback-acceptor"
import { AuthAttemptRejected, type AuthAttempt } from "./auth-attempts"
import { detectPlatform } from "@/lib/platform/detect"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "web"),
}))
beforeEach(() => jest.mocked(detectPlatform).mockReturnValue("web"))
it("refuses external callbacks on a headless Host with the matrix recovery", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  await expect(
    routeHostAuthCallback("cognia://auth/callback?state=bound&code=code")
  ).rejects.toMatchObject({
    code: "NOT_SUPPORTED",
    reason: "no-external-callback",
    recovery: ["use-another-method"],
  })
})

jest.mock("./auth-attempts", () => {
  const actual = jest.requireActual("./auth-attempts")
  return {
    ...actual,
    consumeAttempt: jest.fn(async (state) => ({ state })),
    cancelAttempt: jest.fn(async () => {}),
  }
})

const binding = { providerId: "p", clientId: "c", issuer: "https://issuer" }
it("consumes before resolving, drops replays, and logs typed failures without throwing", async () => {
  const consume = jest.fn(async () => ({ state: "state" }) as AuthAttempt)
  const cancel = jest.fn()
  const log = jest.fn()
  const acceptor = new AuthCallbackAcceptor(consume, cancel, log)
  const waiter = acceptor.registerWaiter("state", binding)
  expect(await acceptor.acceptCallback({ state: "state", code: "code" }, "deep-link")).toBe(true)
  expect(consume).toHaveBeenCalledWith("state", binding)
  expect((await waiter.promise).callback.code).toBe("code")
  expect(await acceptor.acceptCallback({ state: "state", code: "replay" }, "broadcast")).toBe(false)
  const cancelled = acceptor.registerWaiter("cancel", binding)
  const rejection = expect(cancelled.promise).rejects.toMatchObject({ reason: "cancelled" })
  await cancelled.cancel()
  await rejection
  expect(await acceptor.acceptCallback({ state: "cancel", code: "late" }, "message")).toBe(false)
  const mismatched = acceptor.registerWaiter("mismatch", binding)
  consume.mockRejectedValueOnce(new AuthAttemptRejected("client-mismatch"))
  expect(await acceptor.acceptCallback({ state: "mismatch", code: "bad" }, "message")).toBe(false)
  expect(log).toHaveBeenCalledWith("client-mismatch", "message")
  const cleanup = expect(mismatched.promise).rejects.toThrow("cancelled")
  await mismatched.cancel()
  await cleanup
})

it("wires origin-checked messages, BroadcastChannel and Host deep links to one acceptor", async () => {
  const original = globalThis.BroadcastChannel
  const channels: { onmessage?: (event: MessageEvent) => void; close: jest.Mock }[] = []
  const Channel = jest.fn().mockImplementation(() => {
    const channel = { close: jest.fn() }
    channels.push(channel)
    return channel
  })
  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: Channel,
    configurable: true,
    writable: true,
  })
  const stop = startHostAuthCallbackListeners()
  try {
    const message = registerAuthCallbackWaiter("message-state", binding)
    let resolved = false
    void message.promise.then(() => {
      resolved = true
    })
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil",
        data: { __pluginAuth: true, state: "message-state", code: "bad" },
      })
    )
    await Promise.resolve()
    expect(resolved).toBe(false)
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { __pluginAuth: true, state: "message-state", code: "ok" },
      })
    )
    expect((await message.promise).callback.code).toBe("ok")
    const broadcast = registerAuthCallbackWaiter("broadcast-state", binding)
    channels[0].onmessage?.({
      data: {
        __pluginAuth: true,
        state: "broadcast-state",
        error: "denied",
        error_description: "No consent",
      },
    } as MessageEvent)
    expect((await broadcast.promise).callback).toMatchObject({
      error: "denied",
      errorDescription: "No consent",
    })
    const deep = registerAuthCallbackWaiter("deep-state", binding)
    expect(
      await routeHostAuthCallback("cognia://auth/callback?state=deep-state&code=deep-code")
    ).toBe(true)
    expect((await deep.promise).callback.code).toBe("deep-code")
    expect(await routeHostAuthCallback("cognia://plugin/acme/callback")).toBe(false)
    expect(Channel).toHaveBeenCalledWith("plugin-auth")
    expect(await acceptCallback({ state: "unknown", code: "x" }, "message")).toBe(false)
  } finally {
    stop()
    globalThis.BroadcastChannel = original
  }
  expect(channels[0].close).toHaveBeenCalled()
})

it("rejects a matching waiter promptly on storage failures", async () => {
  const failure = new Error("keyring unavailable")
  const consume = jest.fn().mockRejectedValue(failure)
  const acceptor = new AuthCallbackAcceptor(consume, jest.fn(), jest.fn())
  const waiter = acceptor.registerWaiter("state", binding)
  const rejected = expect(waiter.promise).rejects.toBe(failure)
  expect(await acceptor.acceptCallback({ state: "state", code: "code" }, "pkce-driver")).toBe(false)
  await rejected
  expect(await acceptor.acceptCallback({ state: "state", code: "late" }, "broadcast")).toBe(false)
})
