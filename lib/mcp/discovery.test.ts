import type { McpServer } from "@cognia/agent-config-types"

import { discoverMcpServerViaSidecar } from "./discovery"

describe("sidecar MCP discovery wrapper", () => {
  const trustedServer: McpServer = {
    id: "srv-1",
    name: "docs",
    transport: "http",
    config: { url: "https://mcp.example/rpc", headers: { authorization: { secretRef: "token" } } },
    enabled: true,
    trust: { state: "trusted" },
    createdAt: 1,
    updatedAt: 1,
  }

  it("resolves secrets only before the ephemeral sidecar request and writes content-free audit", async () => {
    const requests: unknown[] = []
    const audits: unknown[] = []
    const result = await discoverMcpServerViaSidecar(trustedServer, undefined, {
      now: (() => {
        const values = [100, 108]
        return () => values.shift() ?? 108
      })(),
      resolveSecrets: async () => ({
        url: "https://mcp.example/rpc",
        headers: { authorization: "Bearer ephemeral" },
      }),
      requestResult: async (request) => {
        requests.push(request)
        return {
          ok: true,
          toolCount: 1,
          tools: [{ name: "search" }],
          resources: [],
          prompts: [],
          durationMs: 8,
        }
      },
      appendAudit: async (draft) => {
        audits.push(draft)
        return { id: "audit", ...draft }
      },
    })

    expect(result.ok).toBe(true)
    expect(requests).toEqual([
      expect.objectContaining({
        operation: "mcp-discover",
        mcpServer: expect.objectContaining({
          id: "srv-1",
          config: expect.objectContaining({
            headers: { authorization: "Bearer ephemeral" },
          }),
        }),
      }),
    ])
    await Promise.resolve()
    expect(JSON.stringify(audits)).not.toContain("ephemeral")
    expect(audits).toEqual([
      expect.objectContaining({ serverId: "srv-1", phase: "discover", allowed: true }),
    ])
  })

  it("fails closed before resolution or dispatch for pending trust", async () => {
    const requestResult = jest.fn()
    const resolveSecrets = jest.fn()
    const appendAudit = jest.fn(async (draft) => ({ id: "audit", ...draft }))
    const result = await discoverMcpServerViaSidecar(
      { ...trustedServer, trust: { state: "pending" } },
      undefined,
      { requestResult, resolveSecrets, appendAudit, now: () => 100 }
    )

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("pending") })
    expect(requestResult).not.toHaveBeenCalled()
    expect(resolveSecrets).not.toHaveBeenCalled()
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false, decision: "deny", errorCode: "policy-denied" })
    )
  })
})
