import {
  deviceTransport,
  DEVICE_RPC_PREFIX,
  INTERNAL_RPC_PREFIX,
  classifyStatus,
  internalTransport,
  operationPath,
  withRelayFallback,
  type CommandOutcome,
  type HostTransport,
  type TransportFetch,
  type RequestOptions,
} from "./transport"
import type { WatchOptions } from "./events"

interface Call {
  url: string
  init: RequestInit
}

function stubFetch(
  responder: (call: Call) => { status: number; body?: unknown; text?: string }
): TransportFetch & { calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = responder({ url, init })
    const text = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body))
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => text,
    } as unknown as Response
  }) as TransportFetch & { calls: Call[] }
  impl.calls = calls
  return impl
}

const ENDPOINT = "https://127.0.0.1:27890"

describe("classifyStatus", () => {
  it("reads 404 and unknown_command as a missing command", () => {
    expect(classifyStatus(404)).toBe("unknown-command")
    expect(classifyStatus(400, "unknown_command")).toBe("unknown-command")
  })

  it("separates a credential problem from a policy refusal on 403", () => {
    expect(classifyStatus(403)).toBe("auth")
    expect(classifyStatus(403, "command_transport_forbidden")).toBe("refused")
    expect(classifyStatus(428, "interactive_approval_required")).toBe("refused")
  })

  it("reads a schema rejection as an invalid request", () => {
    expect(classifyStatus(422)).toBe("invalid-request")
    expect(classifyStatus(400)).toBe("invalid-request")
  })

  it("reads a 5xx as a failure and a gateway timeout as a timeout", () => {
    expect(classifyStatus(500)).toBe("failed")
    expect(classifyStatus(504)).toBe("timeout")
  })
})

describe("internalTransport", () => {
  it("posts to the internal RPC route with the service token", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: { ok: true } }))
    const transport = internalTransport({ endpoint: ENDPOINT, serviceToken: "svc", fetchImpl })
    const outcome = await transport.execute("plugin_list", { scope: "all" })

    expect(outcome).toMatchObject({ ok: true, result: { ok: true } })
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}${INTERNAL_RPC_PREFIX}/plugin_list`)
    expect(fetchImpl.calls[0].init.method).toBe("POST")
    expect((fetchImpl.calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer svc"
    )
    expect(fetchImpl.calls[0].init.body).toBe('{"scope":"all"}')
  })

  it("strips a trailing slash from the endpoint so the path never doubles", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    await internalTransport({ endpoint: `${ENDPOINT}/`, serviceToken: "s", fetchImpl }).execute("x")
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}${INTERNAL_RPC_PREFIX}/x`)
  })

  it("percent-encodes the command name rather than trusting it as a path", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    await internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl }).execute("a/../b")
    expect(fetchImpl.calls[0].url).toContain("a%2F..%2Fb")
  })

  it("sends an idempotency key only when one was supplied", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    const transport = internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl })
    await transport.execute("x", {}, { idempotencyKey: "key-1" })
    await transport.execute("x", {})
    expect((fetchImpl.calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "key-1"
    )
    expect(
      (fetchImpl.calls[1].init.headers as Record<string, string>)["idempotency-key"]
    ).toBeUndefined()
  })

  it("reports a 202 as accepted and carries the operation id", async () => {
    const fetchImpl = stubFetch(() => ({ status: 202, body: { operationId: "op_1" } }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("workflow_run")
    expect(outcome).toMatchObject({ ok: true, accepted: true, operationId: "op_1" })
  })

  it("carries the host's code and message into the failure", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 403,
      body: { code: "capability_denied", message: "device lacks plugin.manage", requestId: "r1" },
    }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("plugin_uninstall")
    expect(outcome).toMatchObject({
      ok: false,
      cause: "auth",
      code: "capability_denied",
      message: "device lacks plugin.manage",
      status: 403,
      requestId: "r1",
    })
  })

  it("takes the message from a problem document's detail", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 410,
      body: {
        type: "https://cognia.dev/problems/command_renamed",
        title: "Gone",
        status: 410,
        detail: "session_list is now session.list",
        code: "command_renamed",
        requestId: "r2",
        retryable: false,
        details: { replacement: "session.list" },
      },
    }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("session_list")
    expect(outcome).toMatchObject({
      ok: false,
      status: 410,
      code: "command_renamed",
      message: "session_list is now session.list",
      requestId: "r2",
    })
  })

  it("keeps a non-JSON error body as a detail instead of discarding it", async () => {
    const fetchImpl = stubFetch(() => ({ status: 502, text: "<html>bad gateway</html>" }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "failed" })
    expect((outcome as { details: string[] }).details[0]).toContain("bad gateway")
  })

  it("classifies a transport error as network without inventing a status", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "network", message: "ECONNREFUSED" })
    expect(outcome).not.toHaveProperty("status")
  })

  it("classifies an aborted request as a timeout", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted")
      error.name = "AbortError"
      throw error
    }) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "timeout" })
  })

  it("aborts the request once the timeout budget elapses", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      })) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x", {}, { timeoutMs: 5 })
    expect(outcome).toMatchObject({ ok: false, cause: "timeout" })
  })

  it("sends an arbitrary route verbatim through request", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: { devices: [] } }))
    await internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl }).request(
      "get",
      "/api/devices"
    )
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}/api/devices`)
    expect(fetchImpl.calls[0].init.method).toBe("GET")
    expect(fetchImpl.calls[0].init.body).toBeUndefined()
  })
})

describe("operationPath", () => {
  it("points at the receipt route for each wire", () => {
    expect(operationPath("internal", "op_1")).toBe("/internal/operations/op_1")
    expect(operationPath("http", "op_1")).toBe("/api/operations/op_1")
  })

  it("encodes the id rather than splicing it into the path", () => {
    expect(operationPath("internal", "a/b")).toBe("/internal/operations/a%2Fb")
  })
})

describe("device wire constants", () => {
  it("names the paired-device RPC prefix the host actually mounts", () => {
    expect(DEVICE_RPC_PREFIX).toBe("/api/_rpc")
  })
})

describe("withRelayFallback (ADR-0224 A4)", () => {
  const unreachable: CommandOutcome = { ok: false, cause: "network", message: "ECONNREFUSED" }

  function directReturning(...outcomes: CommandOutcome[]): HostTransport {
    const execute = jest.fn()
    for (const outcome of outcomes) execute.mockResolvedValueOnce(outcome)
    return {
      wire: "http",
      label: "Cognia Host (https://h:1, device d)",
      execute,
      request: jest.fn().mockResolvedValue(unreachable),
      close: jest.fn(),
    }
  }

  function relayReturning(...outcomes: CommandOutcome[]) {
    const execute = jest.fn()
    for (const outcome of outcomes) execute.mockResolvedValueOnce(outcome)
    return { execute, close: jest.fn() }
  }

  it.each(["execute", "operation", "watch"])(
    "shares the remaining budget across %s routes",
    async (kind) => {
      let now = 0
      const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
      const direct = directReturning()
      const unavailable = async () => {
        now += 40
        return unreachable
      }
      direct.execute = jest.fn(unavailable)
      direct.request = jest.fn(unavailable)
      direct.watch = jest.fn(unavailable)
      const relay = {
        ...relayReturning({ ok: true, result: {} }),
        getOperation: jest.fn(async (_id: string, _options?: RequestOptions) => ({
          ok: true as const,
          result: {},
        })),
        watch: jest.fn(async (_options: WatchOptions) => ({ ok: true as const, result: {} })),
      }
      try {
        const host = withRelayFallback(direct, relay)
        if (kind === "execute") {
          await host.execute("read", {}, { timeoutMs: 100 })
          expect(relay.execute.mock.calls[0][2]).toMatchObject({ timeoutMs: 60 })
        } else if (kind === "operation") {
          await host.request(
            "GET",
            operationPath("http", "00000000-0000-4000-8000-000000000001"),
            undefined,
            { timeoutMs: 100 }
          )
          expect(relay.getOperation.mock.calls[0][1]).toMatchObject({ timeoutMs: 60 })
        } else {
          await host.watch!({ channels: ["a"], onEvent: () => {}, timeoutMs: 100 })
          expect(relay.watch.mock.calls[0][0]).toMatchObject({ timeoutMs: 60 })
        }
      } finally {
        clock.mockRestore()
      }
    }
  )

  it("does not start a fallback after its budget expires", async () => {
    let now = 0
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
    const direct = directReturning()
    direct.execute = jest.fn(async () => {
      now = 100
      return unreachable
    })
    const relay = relayReturning({ ok: true, result: {} })
    try {
      await expect(
        withRelayFallback(direct, relay).execute("write", {}, { timeoutMs: 100 })
      ).resolves.toMatchObject({ ok: false, cause: "timeout" })
      expect(relay.execute).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it("uses the address while it answers, and never joins the relay", async () => {
    const direct = directReturning({ ok: true, result: 1 })
    const relay = relayReturning()
    const transport = withRelayFallback(direct, relay)
    await expect(transport.execute("x")).resolves.toEqual({ ok: true, result: 1 })
    expect(relay.execute).not.toHaveBeenCalled()
    expect(transport.label).toContain("relay fallback")
  })

  it("does not fall back on a host that answered and refused", async () => {
    const refused: CommandOutcome = { ok: false, cause: "auth", message: "nope", status: 401 }
    const relay = relayReturning()
    await expect(withRelayFallback(directReturning(refused), relay).execute("x")).resolves.toBe(
      refused
    )
    expect(relay.execute).not.toHaveBeenCalled()
  })

  it("falls back when the address does not answer, then goes to the relay first", async () => {
    const direct = directReturning(unreachable)
    const relay = relayReturning({ ok: true, result: "a" }, { ok: true, result: "b" })
    const transport = withRelayFallback(direct, relay)
    await expect(transport.execute("x", { a: 1 }, { idempotencyKey: "k" })).resolves.toEqual({
      ok: true,
      result: "a",
    })
    expect(relay.execute).toHaveBeenCalledWith("x", { a: 1 }, { idempotencyKey: "k" })
    await expect(transport.execute("y")).resolves.toEqual({ ok: true, result: "b" })
    expect(direct.execute).toHaveBeenCalledTimes(1)
  })

  it("says why when neither route answers", async () => {
    const transport = withRelayFallback(
      directReturning(unreachable),
      relayReturning({ ok: false, cause: "network", message: "room did not open" })
    )
    const outcome = await transport.execute("x")
    expect(outcome).toMatchObject({
      ok: false,
      cause: "network",
      message: "the host answered neither on its address nor through its relay room",
      details: ["direct: ECONNREFUSED", "relay: room did not open"],
    })
  })

  it("goes back to the address when the relay stops answering", async () => {
    const direct = directReturning(unreachable, { ok: true, result: "direct" })
    const relay = relayReturning({ ok: true, result: "relay" }, unreachable)
    const transport = withRelayFallback(direct, relay)
    await transport.execute("x")
    await expect(transport.execute("y")).resolves.toEqual({ ok: true, result: "direct" })
  })

  it("keeps raw routes direct and says they have no relay form", async () => {
    const direct = directReturning()
    const transport = withRelayFallback(direct, relayReturning())
    const outcome = await transport.request("GET", "/api/devices")
    expect(outcome).toMatchObject({ ok: false, cause: "network" })
    expect(!outcome.ok && outcome.details?.join(" ")).toContain("no relay form")
  })

  it("closes both routes", () => {
    const direct = directReturning()
    const relay = relayReturning()
    withRelayFallback(direct, relay).close?.()
    expect(direct.close).toHaveBeenCalled()
    expect(relay.close).toHaveBeenCalled()
  })
})

describe("deviceTransport token exchange failures", () => {
  let privateKeyJwk: JsonWebKey
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  })

  it.each([false, true])(
    "isolates short and long authentication waiters (short first: %p)",
    async (shortFirst) => {
      let release!: () => void
      let entered!: () => void
      const challenge = new Promise<void>((resolve) => {
        release = resolve
      })
      const challenged = new Promise<void>((resolve) => {
        entered = resolve
      })
      let rpcCount = 0
      const host = await deviceTransport({
        endpoint: ENDPOINT,
        tenantId: "t",
        deviceId: "d",
        privateKeyJwk,
        fetchImpl: async (url, init) => {
          if (url.endsWith("/challenge")) {
            entered()
            await Promise.race([
              challenge,
              new Promise<void>((_resolve, reject) => {
                const abort = () => reject(new DOMException("challenge stopped", "AbortError"))
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
              }),
            ])
            return Response.json({ challengeId: "c", nonce: "n" })
          }
          if (url.endsWith("/token"))
            return Response.json({
              accessToken: `e30.${Buffer.from('{"jti":"j"}').toString("base64url")}.sig`,
              expiresIn: 300,
            })
          rpcCount++
          return Response.json({ result: true, requestId: "r" })
        },
      })
      const first = host.execute(
        shortFirst ? "short" : "long",
        {},
        { timeoutMs: shortFirst ? 5 : 1000 }
      )
      await challenged
      const second = host.execute(
        shortFirst ? "long" : "short",
        {},
        { timeoutMs: shortFirst ? 1000 : 5 }
      )
      const short = shortFirst ? first : second
      const long = shortFirst ? second : first
      try {
        await expect(
          Promise.race([
            short,
            new Promise((resolve) => setTimeout(() => resolve("missed budget"), 50)),
          ])
        ).resolves.toMatchObject({ ok: false, cause: "timeout" })
        expect(rpcCount).toBe(0)
      } finally {
        release()
        await first
        await second
      }
      await expect(long).resolves.toMatchObject({ ok: true })
      expect(rpcCount).toBe(1)
    }
  )

  it.each(["challenge", "token", "refresh"])(
    "propagates cancellation during %s without a later RPC",
    async (phase) => {
      const controller = new AbortController()
      const paths: string[] = []
      let challenges = 0
      let reached!: () => void
      const blocked = new Promise<void>((resolve) => {
        reached = resolve
      })
      const transport = await deviceTransport({
        endpoint: ENDPOINT,
        tenantId: "t",
        deviceId: "d",
        privateKeyJwk,
        fetchImpl: async (url, init) => {
          const path = new URL(url).pathname
          paths.push(path)
          if (path.endsWith("/challenge")) challenges++
          if (
            (phase === "challenge" && path.endsWith("/challenge")) ||
            (phase === "token" && path.endsWith("/token")) ||
            (phase === "refresh" && challenges === 2)
          ) {
            reached()
            return new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(new DOMException("stopped", "AbortError"))
              if (init.signal?.aborted) abort()
              else init.signal?.addEventListener("abort", abort, { once: true })
            })
          }
          if (path.endsWith("/challenge")) return Response.json({ challengeId: "c", nonce: "n" })
          if (path.endsWith("/token"))
            return Response.json({
              accessToken: `e30.${Buffer.from(JSON.stringify({ jti: "j" })).toString("base64url")}.sig`,
              expiresIn: 300,
            })
          return Response.json({ code: "token_stale" }, { status: 401 })
        },
      })
      const pending = transport.execute("write", {}, { signal: controller.signal, timeoutMs: 1000 })
      await blocked
      const countAtAbort = paths.length
      controller.abort()
      await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
      expect(paths).toHaveLength(countAtAbort)
      expect(paths.filter((path) => path.includes("/_rpc/"))).toHaveLength(
        phase === "refresh" ? 1 : 0
      )
    }
  )

  /**
   * ADR-0224 A4. The token exchange is the first request a device makes, so a
   * dead address fails there. Reporting that as "auth" hid it from the relay
   * fallback, which only steps in when the host was not reached at all.
   */
  it("reports an exchange that never reached the host as a network failure", async () => {
    const transport = await deviceTransport({
      endpoint: "https://h:1",
      tenantId: "t",
      deviceId: "d",
      privateKeyJwk,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1")
      },
    })
    await expect(transport.execute("x")).resolves.toMatchObject({
      ok: false,
      cause: "network",
      message: "connect ECONNREFUSED 127.0.0.1:1",
    })
  })

  it("reports the host refusing the device as an auth failure", async () => {
    const transport = await deviceTransport({
      endpoint: "https://h:1",
      tenantId: "t",
      deviceId: "d",
      privateKeyJwk,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "device_revoked", detail: "device revoked" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    })
    await expect(transport.execute("x")).resolves.toMatchObject({
      ok: false,
      cause: "auth",
      status: 401,
    })
  })
})

describe("JSON value preservation", () => {
  it.each([false, 7, "hello", null])("preserves %p on the internal wire", async (value) => {
    const host = internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "synthetic",
      fetchImpl: stubFetch(() => ({ status: 200, body: value })),
    })
    expect(await host.execute("synthetic")).toMatchObject({ ok: true, result: value })
  })
})

describe("REST response modes and metadata", () => {
  it.each(["json", "text", "stream"] as const)(
    "cancels a %s body even when it does not consume the fetch signal",
    async (responseMode) => {
      let body!: ReadableStreamDefaultController<Uint8Array>
      const host = internalTransport({
        endpoint: ENDPOINT,
        serviceToken: "synthetic",
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller
                controller.enqueue(new TextEncoder().encode('{"partial":'))
              },
            })
          ),
      })
      const pending = host.request("GET", "/stream", undefined, { responseMode, timeoutMs: 5 })
      try {
        await expect(
          Promise.race([
            pending,
            new Promise((resolve) => setTimeout(() => resolve("missed budget"), 50)),
          ])
        ).resolves.toMatchObject({ ok: false, cause: "timeout" })
      } finally {
        body.error(new DOMException("cleanup", "AbortError"))
        await pending
      }
    }
  )

  it.each([
    { status: 200, responseMode: "json" as const },
    { status: 500, responseMode: "json" as const },
    { status: 200, responseMode: "text" as const },
  ])("returns timeout during body reading: %p", async ({ status, responseMode }) => {
    const controller = new AbortController()
    let reached!: () => void
    const headersReceived = new Promise<void>((resolve) => {
      reached = resolve
    })
    const host = internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "synthetic",
      fetchImpl: async (_url, init) => {
        const response = new Response(
          new ReadableStream({
            start(body) {
              body.enqueue(new TextEncoder().encode('{"result":'))
              init.signal?.addEventListener(
                "abort",
                () => body.error(new DOMException("stopped", "AbortError")),
                { once: true }
              )
            },
          }),
          { status }
        )
        reached()
        return response
      },
    })
    const pending = host.execute("read", {}, { signal: controller.signal, responseMode })
    await headersReceived
    await Promise.resolve()
    controller.abort(new Error("caller stopped"))
    await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
  })

  it("preserves RFC Problem details and retry advice", async () => {
    const host = internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "synthetic",
      fetchImpl: stubFetch(() => ({
        status: 429,
        body: {
          code: "rate_limited",
          detail: "later",
          retryable: true,
          details: { replacement: "next" },
        },
      })),
    })
    expect(await host.execute("demo")).toMatchObject({
      ok: false,
      retryable: true,
      problem: { details: { replacement: "next" } },
    })
  })
  it("keeps text bytes intact instead of truncating JSON failures", async () => {
    const text = "line\n".repeat(200)
    const host = internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl: stubFetch(() => ({ status: 200, text })),
    })
    expect(await host.request("GET", "/export", undefined, { responseMode: "text" })).toMatchObject(
      { ok: true, result: text }
    )
  })
})

describe("relay operation observation", () => {
  it("observes an operation without replaying its mutation", async () => {
    const direct: HostTransport = {
      wire: "http",
      label: "offline",
      execute: jest.fn(async () => ({
        ok: false as const,
        cause: "network" as const,
        message: "offline",
      })),
      request: jest.fn(async () => ({
        ok: false as const,
        cause: "network" as const,
        message: "offline",
      })),
    }
    const execute = jest.fn(async () => ({
      ok: true as const,
      accepted: true,
      operationId: "11111111-1111-4111-8111-111111111111",
      result: {},
    }))
    const getOperation = jest.fn(async () => ({
      ok: true as const,
      result: {
        id: "11111111-1111-4111-8111-111111111111",
        done: true,
        status: "succeeded",
        result: null,
      },
    }))
    const host = withRelayFallback(direct, { execute, getOperation, close: () => {} })
    await host.execute("mutation", {}, { idempotencyKey: "11111111-1111-4111-8111-111111111111" })
    await expect(
      host.request("GET", "/api/operations/11111111-1111-4111-8111-111111111111")
    ).resolves.toMatchObject({ ok: true, result: { done: true, result: null } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(getOperation).toHaveBeenCalledTimes(1)
  })
})

describe("event transport preference and continuity", () => {
  it("keeps a healthy direct stream independent of relay availability", async () => {
    const watch = jest.fn(async () => ({ ok: true as const, result: { count: 1 } }))
    const relayWatch = jest.fn(async () => ({
      ok: false as const,
      cause: "network" as const,
      message: "offline",
    }))
    const direct: HostTransport = {
      wire: "http",
      label: "host",
      execute: async () => ({ ok: true, result: {} }),
      request: async () => ({ ok: true, result: {} }),
      watch,
    }
    const host = withRelayFallback(direct, {
      execute: direct.execute,
      watch: relayWatch,
      close: () => {},
    })
    await expect(
      host.watch!({ channels: ["a"], maxEvents: 1, onEvent: () => {} })
    ).resolves.toMatchObject({ ok: true })
    expect(watch).toHaveBeenCalledTimes(1)
    expect(relayWatch).not.toHaveBeenCalled()
  })
  it("preserves the cursor and remaining event bound when falling back", async () => {
    const relayWatch = jest.fn(async () => ({ ok: true as const, result: { count: 1 } }))
    const direct: HostTransport = {
      wire: "http",
      label: "host",
      execute: async () => ({ ok: true, result: {} }),
      request: async () => ({ ok: true, result: {} }),
      watch: async (options) => {
        options.onEvent({ type: "a", seq: 10, payload: 1 })
        options.onCursor?.(12)
        return { ok: false, cause: "network", message: "disconnected" }
      },
    }
    const host = withRelayFallback(direct, {
      execute: direct.execute,
      watch: relayWatch,
      close: () => {},
    })
    await host.watch!({ channels: ["a"], maxEvents: 2, onEvent: () => {} })
    expect(relayWatch).toHaveBeenCalledWith(expect.objectContaining({ since: 12, maxEvents: 1 }))
  })
})

it("merges raw request headers case-insensitively", async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
  const host = internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl })
  await host.request("POST", "/upload", undefined, {
    rawBody: "text",
    headers: { "Content-Type": "application/octet-stream" },
  })
  expect(new Headers(fetchImpl.calls[0].init.headers).get("content-type")).toBe(
    "application/octet-stream"
  )
})
