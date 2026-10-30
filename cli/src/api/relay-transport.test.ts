import type { TransportRtc, TransportRtcOptions } from "@/lib/tauri/transport-rtc"

import { classifyRelayCode, relayCommandChannel, type RelayRouteRecord } from "./relay-transport"

const mockImportSigningPrivateKey = jest.fn(async (..._args: unknown[]) => ({ key: "signing" }))
jest.mock("@/lib/signaling/crypto", () => ({
  importSigningPrivateKey: (...args: unknown[]) => mockImportSigningPrivateKey(...args),
}))

const route: RelayRouteRecord = {
  rendezvousId: "dev-room",
  roomDescriptor: { v: 2, roomId: "dev-room" } as never,
  signalingPrivateKeyJwk: { kty: "EC", d: "secret" },
  signalingUrl: "wss://relay.example/signaling",
}

function fakeRtc(call: jest.Mock, connect: jest.Mock<Promise<void>, []> = jest.fn(async () => {})) {
  const close = jest.fn()
  const rtc = {
    connect,
    call,
    close,
    subscribe: jest.fn(),
    onStateChange: () => () => {},
  } as unknown as TransportRtc
  const factory = jest.fn((_options: TransportRtcOptions) => rtc)
  return { factory, close, connect }
}

beforeEach(() => mockImportSigningPrivateKey.mockClear())

describe("relayCommandChannel", () => {
  it("joins the device's own room relay-only, once, and carries commands", async () => {
    const call = jest.fn(async () => ({ hostId: "h" }))
    const rtc = fakeRtc(call)
    const channel = relayCommandChannel({ route, deviceId: "dev_9", transportFactory: rtc.factory })

    await expect(channel.execute("host_capabilities", {})).resolves.toEqual({
      ok: true,
      result: { hostId: "h" },
    })
    await channel.execute("host_feature_manifest", {}, { idempotencyKey: "k1", timeoutMs: 1000 })

    expect(rtc.factory).toHaveBeenCalledTimes(1)
    expect(rtc.factory.mock.calls[0]?.[0]).toMatchObject({
      signalingUrl: "wss://relay.example/signaling",
      rendezvousId: "dev-room",
      deviceId: "dev_9",
      role: "mobile",
      p2p: false,
      persistEventCursor: false,
      signalingPrivateKey: { key: "signing" },
    })
    expect(mockImportSigningPrivateKey).toHaveBeenCalledWith(route.signalingPrivateKeyJwk)
    expect(call).toHaveBeenLastCalledWith(
      "host_feature_manifest",
      {},
      expect.objectContaining({ idempotencyKey: "k1", deadlineAt: expect.any(Number) })
    )
    channel.close()
    await Promise.resolve()
    expect(rtc.close).toHaveBeenCalled()
  })

  it("reports an accepted command with its operation id", async () => {
    const rtc = fakeRtc(jest.fn(async () => ({ operationId: "op_1", status: "running" })))
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("agent_run", {})).resolves.toMatchObject({
      ok: true,
      accepted: true,
      operationId: "op_1",
    })
  })

  it("keeps a host refusal apart from not reaching the host", async () => {
    const refusal = Object.assign(new Error("device revoked"), { code: "device_revoked" })
    const rtc = fakeRtc(
      jest
        .fn()
        .mockRejectedValueOnce(refusal)
        .mockRejectedValueOnce(new Error("TransportRtc: RPC 'x' timed out"))
        .mockRejectedValueOnce(new Error("carrier closed"))
    )
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("x", {})).resolves.toEqual({
      ok: false,
      cause: "auth",
      message: "device revoked",
      code: "device_revoked",
    })
    await expect(channel.execute("x", {})).resolves.toMatchObject({ cause: "timeout" })
    await expect(channel.execute("x", {})).resolves.toMatchObject({ cause: "network" })
  })

  it("does not cache a room that could not be joined", async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error("relay unreachable"))
      .mockResolvedValueOnce(undefined)
    const rtc = fakeRtc(
      jest.fn(async () => "ok"),
      connect
    )
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.execute("x", {})).resolves.toMatchObject({
      ok: false,
      cause: "network",
      message: expect.stringContaining("relay unreachable"),
    })
    await expect(channel.execute("x", {})).resolves.toEqual({ ok: true, result: "ok" })
    expect(rtc.factory).toHaveBeenCalledTimes(2)
  })

  it("refuses after it was closed", async () => {
    const rtc = fakeRtc(jest.fn())
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    channel.close()
    await expect(channel.execute("x", {})).resolves.toMatchObject({ ok: false, cause: "network" })
    expect(rtc.factory).not.toHaveBeenCalled()
  })
})

describe("classifyRelayCode", () => {
  it("reads the host's problem codes in the direct wire's vocabulary", () => {
    expect(classifyRelayCode("unknown_command")).toBe("unknown-command")
    expect(classifyRelayCode("interactive_approval_required")).toBe("refused")
    expect(classifyRelayCode("rate_limited")).toBe("refused")
    expect(classifyRelayCode("device_revoked")).toBe("auth")
    expect(classifyRelayCode("invalid_params")).toBe("invalid-request")
    expect(classifyRelayCode("timeout")).toBe("timeout")
    expect(classifyRelayCode("internal")).toBe("failed")
    expect(classifyRelayCode(undefined)).toBe("failed")
  })
})

describe("relay cancellation and observation", () => {
  it("does not create a transport when cancelled during key import", async () => {
    let imported!: (key: { key: string }) => void
    mockImportSigningPrivateKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          imported = resolve
        })
    )
    const rtc = fakeRtc(jest.fn())
    const controller = new AbortController()
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    const pending = channel.execute("write", {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
    imported({ key: "signing" })
    await Promise.resolve()
    await Promise.resolve()
    expect(rtc.factory).not.toHaveBeenCalled()
  })

  it("never dispatches a mutation after cancellation during handshake", async () => {
    let connected!: () => void
    const call = jest.fn()
    const rtc = fakeRtc(
      call,
      jest.fn(
        () =>
          new Promise<void>((resolve) => {
            connected = resolve
          })
      )
    )
    const controller = new AbortController()
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    const pending = channel.execute("write", {}, { signal: controller.signal, timeoutMs: 1000 })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
    expect(rtc.close).toHaveBeenCalled()
    connected()
    await Promise.resolve()
    await Promise.resolve()
    expect(call).not.toHaveBeenCalled()
    channel.close()
  })

  it("closes an event connection immediately when cancelled during handshake", async () => {
    let connected!: () => void
    const rtc = fakeRtc(
      jest.fn(),
      jest.fn(
        () =>
          new Promise<void>((resolve) => {
            connected = resolve
          })
      )
    )
    const controller = new AbortController()
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    const onEvent = jest.fn()
    const pending = channel.watch!({ channels: ["claude://*"], signal: controller.signal, onEvent })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
    expect(rtc.close).toHaveBeenCalled()
    connected()
    await Promise.resolve()
    await Promise.resolve()
    expect(onEvent).not.toHaveBeenCalled()
  })
  it("observes receipts with a control frame rather than replaying a command", async () => {
    const call = jest.fn(async () => ({ id: "op", done: true, result: null }))
    const rtc = fakeRtc(call)
    const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
    await expect(channel.getOperation!("op")).resolves.toMatchObject({
      ok: true,
      result: { done: true, result: null },
    })
    expect(call).toHaveBeenCalledWith(
      "host.operation.get",
      { operationId: "op" },
      expect.objectContaining({ controlKind: "operation-get" })
    )
    channel.close()
  })
  it("starts atomic watch without inventing a historical cursor", async () => {
    let settings!: TransportRtcOptions
    const close = jest.fn()
    const rtc = {
      subscribe: jest.fn(),
      close,
      onStateChange: () => () => {},
      connect: async () => {
        settings.subscriptionObserver?.({ channels: ["a"], rejected: [] })
        settings.eventObserver?.({ kind: "event", event: "a", seq: 12, payload: "new" })
      },
    } as unknown as TransportRtc
    const channel = relayCommandChannel({
      route,
      deviceId: "d",
      transportFactory: (options) => {
        settings = options
        return rtc
      },
    })
    const onEvent = jest.fn()
    await expect(
      channel.watch!({ channels: ["a"], maxEvents: 1, onEvent, timeoutMs: 1000 })
    ).resolves.toMatchObject({ ok: true, result: { count: 1, cursor: 12 } })
    expect(settings.atomicEventWatch).toBe(true)
    expect(settings.initialEventCursor).toBeUndefined()
    expect(onEvent).toHaveBeenCalledTimes(1)
    channel.close()
  })
})

it("clears the acknowledgment deadline for a canonical family subscription", async () => {
  jest.useFakeTimers()
  let settings!: TransportRtcOptions
  const rtc = {
    subscribe: jest.fn(),
    close: jest.fn(),
    onStateChange: () => () => {},
    connect: async () => {
      settings.subscriptionObserver?.({ channels: ["connectors://*"], rejected: [] })
    },
  } as unknown as TransportRtc
  const channel = relayCommandChannel({
    route,
    deviceId: "d",
    transportFactory: (options) => {
      settings = options
      return rtc
    },
  })
  try {
    let settled = false
    const pending = channel.watch!({
      channels: ["connectors://webhook/a"],
      maxEvents: 1,
      onEvent: () => {},
      timeoutMs: 30000,
    })
    void pending.then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(15001)
    expect(settled).toBe(false)
    settings.eventObserver?.({ kind: "event", event: "connectors://webhook/a", seq: 2, payload: 1 })
    await expect(pending).resolves.toMatchObject({ ok: true })
  } finally {
    channel.close()
    jest.useRealTimers()
  }
})

it("keeps relay retry advice", async () => {
  const error = Object.assign(new Error("later"), {
    code: "rate_limited",
    retryable: true,
    retryAfterMs: 2000,
  })
  const rtc = fakeRtc(
    jest.fn(async () => {
      throw error
    })
  )
  const channel = relayCommandChannel({ route, deviceId: "d", transportFactory: rtc.factory })
  await expect(channel.execute("read", {})).resolves.toMatchObject({
    ok: false,
    retryable: true,
    retryAfterMs: 2000,
  })
  channel.close()
})
