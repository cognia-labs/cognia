jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  resolveRunActingIdentity: jest.fn(),
}))
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { McpServer } from "@cognia/agent-config-types"

const mockLoadEntry = jest.fn()
const mockRefresh = jest.fn()
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  mcpOAuthStatus: jest.fn(async () => ({ hasTokens: true })),
  mcpOAuthLoadEntry: (...args: unknown[]) => mockLoadEntry(...args),
  mcpOAuthRefresh: (...args: unknown[]) => mockRefresh(...args),
}))
const mockResolveSecrets = jest.fn(async (config: Record<string, unknown>) => ({
  ...config,
  headers: { ...((config.headers ?? {}) as Record<string, unknown>), "X-Key": "resolved" },
}))
jest.mock("@/lib/mcp/credentials", () => ({
  ...jest.requireActual("@/lib/mcp/credentials"),
  resolveMcpSecrets: (config: Record<string, unknown>) => mockResolveSecrets(config),
}))

import { buildRunMcpServerMap } from "./run-server-map"

const remote = {
  id: "srv-1",
  name: "remote",
  transport: "http",
  config: { url: "https://mcp.example", headers: { "X-Tenant": "one" } },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
} as unknown as McpServer

describe("buildRunMcpServerMap", () => {
  beforeEach(() => {
    mockLoadEntry.mockReset()
    mockRefresh.mockReset()
    mockResolveSecrets.mockClear()
  })

  it("resolves SecretRefs without OAuth off the desktop", async () => {
    const map = await buildRunMcpServerMap(
      [
        {
          ...remote,
          config: { ...remote.config, headers: { "X-Key": { secretRef: "k" } } },
        } as unknown as McpServer,
      ],
      { credentialContext: { localAuthorization: LOCAL_PERSON_RUN }, isTauri: () => false }
    )
    expect(map.remote).toMatchObject({ type: "http", headers: { "X-Key": "resolved" } })
    expect(mockLoadEntry).not.toHaveBeenCalled()
  })

  it("injects the server's stored OAuth bearer on the desktop, looked up by stable id", async () => {
    mockLoadEntry.mockResolvedValue({ accessToken: "tok" })
    const map = await buildRunMcpServerMap([remote], {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isTauri: () => true,
    })
    expect(map.remote).toMatchObject({
      headers: { "X-Tenant": "one", Authorization: "Bearer tok" },
    })
    expect(mockLoadEntry).toHaveBeenCalledWith(
      "srv-1",
      "remote",
      {
        transport: "http",
        config: remote.config,
      },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  })

  it("refreshes a near-expiry token through the matching server", async () => {
    mockLoadEntry.mockResolvedValue({ accessToken: "old", expiresAtMs: Date.now() + 1_000 })
    mockRefresh.mockResolvedValue({ accessToken: "new" })
    const map = await buildRunMcpServerMap([remote], {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      isTauri: () => true,
    })
    expect(mockRefresh).toHaveBeenCalledWith(
      "srv-1",
      {
        transport: "http",
        config: remote.config,
      },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(map.remote).toMatchObject({ headers: { Authorization: "Bearer new" } })
  })
})

describe("ADR-0243 personal OAuth admission", () => {
  it("withholds real external-engine OAuth even when the Host admitted the local person", async () => {
    mockLoadEntry.mockClear()
    mockRefresh.mockClear()
    const map = await buildRunMcpServerMap([remote], {
      isTauri: () => true,
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN, externalEngine: true },
    })
    expect(map).toEqual({})
    expect(mockLoadEntry).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it.each(["requester", "external-event", "schedule"])(
    "withholds OAuth for a %s root without touching its bearer",
    async (trigger) => {
      const { resolveRunActingIdentity } = await import("@/lib/execution/acting-authority")
      jest.mocked(resolveRunActingIdentity).mockResolvedValue({
        trigger,
        lane: "legacy",
        requesters: [{ kind: "platform", remoteUserId: "not-owner" }],
      } as never)
      const onRefusal = jest.fn()
      const map = await buildRunMcpServerMap([remote], {
        isTauri: () => true,
        credentialContext: { sessionId: "im", executionRunId: "r" },
        onRefusal,
      })
      expect(map).toEqual({})
      expect(mockLoadEntry).not.toHaveBeenCalled()
      expect(mockRefresh).not.toHaveBeenCalled()
      expect(onRefusal).toHaveBeenCalledWith(remote, expect.any(String))
    }
  )
})
