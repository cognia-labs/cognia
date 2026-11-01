jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  resolveRunActingIdentity: jest.fn(),
}))
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
/** @jest-environment node */
import type { McpServer } from "@cognia/agent-config-types"

import { resolveMcpRuntimeCredential } from "./credential-resolver"

const server = (transport: McpServer["transport"] = "http") =>
  ({
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    id: "server-id",
    name: "Remote",
    transport,
    config: { url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "one" } },
    credentialVersion: 2,
  }) as McpServer

describe("MCP runtime credential resolver", () => {
  it("leaves stdio and non-desktop servers untouched", async () => {
    const loadEntry = jest.fn()
    await expect(
      resolveMcpRuntimeCredential(server("stdio"), {
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
        isDesktop: () => true,
        loadEntry,
      })
    ).resolves.toEqual({ server: server("stdio") })
    await expect(
      resolveMcpRuntimeCredential(server(), {
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
        isDesktop: () => false,
        loadEntry,
      })
    ).resolves.toEqual({ server: server() })
    expect(loadEntry).not.toHaveBeenCalled()
  })

  it("injects a partitioned token locally and preserves configured headers", async () => {
    const loadEntry = jest.fn(async () => ({ accessToken: "secret", expiresAtMs: 100_000 }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isDesktop: () => true,
      now: () => 1,
      loadEntry,
    })
    expect(loadEntry).toHaveBeenCalledWith(
      "server-id",
      "Remote",
      {
        transport: "http",
        config: server().config,
      },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(resolved.server.config.headers).toEqual({
      "X-Tenant": "one",
      Authorization: "Bearer secret",
    })
  })

  it("preemptively refreshes near-expiry credentials", async () => {
    const refresh = jest.fn(async () => ({ accessToken: "new", expiresAtMs: 100_000 }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isDesktop: () => true,
      now: () => 50_000,
      loadEntry: async () => ({ accessToken: "old", expiresAtMs: 50_001 }),
      refresh,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect((resolved.server.config.headers as Record<string, string>).Authorization).toBe(
      "Bearer new"
    )
  })

  it("provides an explicit-401 refresh that advances the lease fingerprint", async () => {
    const refresh = jest.fn(async () => ({ accessToken: "new" }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isDesktop: () => true,
      loadEntry: async () => ({ accessToken: "old" }),
      refresh,
      getCurrent: async () => server(),
    })
    const retried = await resolved.refreshAuth?.()
    expect(retried?.server.credentialVersion).toBe(3)
    expect((retried?.server.config.headers as Record<string, string>).Authorization).toBe(
      "Bearer new"
    )
  })

  it("builds the retry from the Registry row as it is after the refresh", async () => {
    const resolved = await resolveMcpRuntimeCredential(server(), {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isDesktop: () => true,
      loadEntry: async () => ({ accessToken: "old" }),
      refresh: async () => ({ accessToken: "new" }),
      getCurrent: async () => ({ ...server(), enabled: false }),
    })
    const retried = await resolved.refreshAuth?.()
    expect(retried?.server.enabled).toBe(false)
  })

  it("refuses the retry once the server has been deleted", async () => {
    const resolved = await resolveMcpRuntimeCredential(server(), {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isDesktop: () => true,
      loadEntry: async () => ({ accessToken: "old" }),
      refresh: async () => ({ accessToken: "new" }),
      getCurrent: async () => undefined,
    })
    await expect(resolved.refreshAuth?.()).rejects.toThrow(/no longer configured/)
  })
})

describe("ADR-0243 personal OAuth admission", () => {
  it.each(["requester", "external-event", "schedule"])(
    "withholds OAuth for a %s root without touching its bearer",
    async (trigger) => {
      const { resolveRunActingIdentity } = await import("@/lib/execution/acting-authority")
      jest.mocked(resolveRunActingIdentity).mockResolvedValue({
        trigger,
        lane: "legacy",
        requesters: [{ kind: "platform", remoteUserId: "not-owner" }],
      } as never)
      const loadEntry = jest.fn()
      await expect(
        resolveMcpRuntimeCredential(server(), {
          isDesktop: () => true,
          loadEntry,
          status: async () => ({ hasTokens: true }),
          credentialContext: { sessionId: "im", executionRunId: "r" },
        })
      ).rejects.toMatchObject({ decision: { source: "mcp-oauth" } })
      expect(loadEntry).not.toHaveBeenCalled()
    }
  )
})

it("keeps operator SecretRefs service-only and refuses refresh after authority changes", async () => {
  const loadEntry = jest.fn()
  const staticServer = {
    ...server(),
    config: { headers: { Authorization: { secretRef: "operator" } } },
  } as unknown as McpServer
  expect(
    (await resolveMcpRuntimeCredential(staticServer, { isDesktop: () => true, loadEntry })).server
  ).toBe(staticServer)
  expect(loadEntry).not.toHaveBeenCalled()
  const { resolveRunActingIdentity } = await import("@/lib/execution/acting-authority")
  jest.mocked(resolveRunActingIdentity).mockResolvedValue({
    trigger: "local",
    authorizingPrincipal: { kind: "local-person" },
    requesters: [],
  } as never)
  const refresh = jest.fn()
  const resolved = await resolveMcpRuntimeCredential(server(), {
    isDesktop: () => true,
    loadEntry: async () => ({ accessToken: "initial" }),
    refresh,
    credentialContext: { sessionId: "s", executionRunId: "r" },
  })
  jest
    .mocked(resolveRunActingIdentity)
    .mockResolvedValue({ trigger: "external-event", requesters: [] } as never)
  await expect(resolved.refreshAuth?.()).rejects.toMatchObject({
    decision: { source: "mcp-oauth" },
  })
  expect(refresh).not.toHaveBeenCalled()
})
