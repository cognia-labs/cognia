import { externalAgentWorkspaceCaptureSupport } from "./capture-support"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

function config(
  protocol: string,
  transport: string,
  extra: Partial<ExternalAgentConfig> = {}
): ExternalAgentConfig {
  return {
    id: "agent",
    name: "Agent",
    protocol,
    transport,
    enabled: true,
    ...extra,
  } as ExternalAgentConfig
}

describe("externalAgentWorkspaceCaptureSupport", () => {
  it.each([
    "acp",
    "codex-app-server",
    "codex-siwc-app-server",
    "pi-rpc",
    "aider-cli",
    "openclaude-cli",
    "continue-cli",
  ])("recognizes the %s Host process rail", (protocol) => {
    expect(externalAgentWorkspaceCaptureSupport(config(protocol, "stdio"))).toEqual({
      available: true,
    })
  })

  it.each(["dsh-sdk", "codebuff-sdk"])("recognizes the %s Host-owned SDK child", (protocol) => {
    expect(externalAgentWorkspaceCaptureSupport(config(protocol, "stdio"))).toEqual({
      available: true,
    })
  })

  it.each(["opencode", "opencode-v2", "crush-http", "rovo-http"])(
    "recognizes an owned %s service without an external endpoint",
    (protocol) => {
      expect(
        externalAgentWorkspaceCaptureSupport(
          config(protocol, "sse", { process: { command: "agent-service" } })
        )
      ).toEqual({ available: true })
    }
  )

  it.each(["opencode", "opencode-v2", "crush-http", "rovo-http", "acp"])(
    "does not infer shared files from a %s endpoint, even loopback",
    (protocol) => {
      expect(
        externalAgentWorkspaceCaptureSupport(
          config(protocol, "sse", {
            network: { endpoint: "http://127.0.0.1:4000" },
            process: { command: "unused" },
          })
        )
      ).toEqual({ available: false, reason: "remote-filesystem" })
    }
  )

  it("does not infer filesystem ownership for remote ACP, A2A or unknown plugins", () => {
    expect(externalAgentWorkspaceCaptureSupport(config("acp", "websocket"))).toEqual({
      available: false,
      reason: "remote-filesystem",
    })
    expect(externalAgentWorkspaceCaptureSupport(config("a2a", "http"))).toEqual({
      available: false,
      reason: "remote-filesystem",
    })
    expect(externalAgentWorkspaceCaptureSupport(config("plugin:agent", "stdio"))).toEqual({
      available: false,
      reason: "unsupported-runtime",
    })
    expect(externalAgentWorkspaceCaptureSupport(undefined)).toEqual({
      available: false,
      reason: "unsupported-runtime",
    })
  })
})
