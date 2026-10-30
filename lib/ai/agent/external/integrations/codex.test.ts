const mockBuildAgentEnv = jest.fn(async () => ({ CODEX_ACCESS_TOKEN: "tok" }))
jest.mock("../config/env-builder", () => ({
  buildAgentEnv: (...args: unknown[]) => mockBuildAgentEnv(...(args as [])),
}))
const mockRecord = jest.fn(async () => {})
jest.mock("@/lib/task-workspace/tool-evidence", () => ({
  recordToolFileChanges: (...args: unknown[]) => mockRecord(...(args as [])),
}))

import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import {
  CodexAppServerAdapter,
  codexAppServerExtension,
} from "@cognia/agent-codex/app-server-client"
import { CODEX_APP_SERVER_EXECUTION_SEMANTICS } from "@cognia/agent-codex/manifest"
import { createCodexAppServerAdapterFactory } from "./codex"

function unavailableHost(): AgentProcessHost {
  return {
    available: false,
    spawn: jest.fn(),
    send: jest.fn(),
    kill: jest.fn(),
    commandExists: jest.fn(),
    onStdoutLine: jest.fn(),
    onStdoutRaw: jest.fn(),
    onStderr: jest.fn(),
    onExit: jest.fn(),
  }
}

describe("Codex host wiring", () => {
  beforeEach(() => mockRecord.mockClear())

  it("records file-change evidence against the owning Cognia conversation", async () => {
    const adapter = createCodexAppServerAdapterFactory(unavailableHost())() as unknown as {
      _sessions: Map<string, { metadata: Record<string, unknown> }>
      onFileChanges: (sessionId: string, toolId: string, changes: unknown) => void
    }
    adapter._sessions.set("native-thread", { metadata: { cogniaSessionId: "chat-session" } })
    const changes = [{ path: "/managed/src/a.ts", kind: "modified" }]
    adapter.onFileChanges("native-thread", "tool-1", changes)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockRecord).toHaveBeenCalledWith("chat-session", "tool-1", changes)
  })

  it("does not attribute an unbound native session's writes to another conversation", async () => {
    const adapter = createCodexAppServerAdapterFactory(unavailableHost())() as unknown as {
      onFileChanges: (sessionId: string, toolId: string, changes: unknown) => void
    }
    adapter.onFileChanges("unbound-native", "tool-1", [{ path: "src/a.ts" }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("builds the codex-app-server adapter with turn-scoped cancel semantics", () => {
    const adapter = createCodexAppServerAdapterFactory(unavailableHost())()
    expect(adapter).toBeInstanceOf(CodexAppServerAdapter)
    expect(adapter.protocol).toBe("codex-app-server")
    expect(adapter.semantics).toBe(CODEX_APP_SERVER_EXECUTION_SEMANTICS)
    expect(codexAppServerExtension.resolve(adapter)).toBe(adapter)
  })

  it("refuses to connect without a process host and never resolves credentials", async () => {
    const host = unavailableHost()
    const adapter = createCodexAppServerAdapterFactory(host)()
    await expect(
      adapter.connect({
        id: "codex",
        name: "Codex",
        protocol: "codex-app-server",
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      } as never)
    ).rejects.toThrow(/process host/)
    expect(host.spawn).not.toHaveBeenCalled()
    expect(mockBuildAgentEnv).not.toHaveBeenCalled()
  })

  it("applies the app's PII gate to outbound Codex payloads", async () => {
    const send = jest.fn()
    const host: AgentProcessHost = { ...unavailableHost(), available: true, send }
    const adapter = createCodexAppServerAdapterFactory(host)() as unknown as {
      processId?: string
      writeToProcess(message: string): Promise<void>
    }
    adapter.processId = "codex"
    await expect(
      adapter.writeToProcess(
        JSON.stringify({ method: "turn/start", text: "mail alice@example.com" })
      )
    ).rejects.toThrow(/PII gate/)
    expect(send).not.toHaveBeenCalled()
  })

  it("creates an independent adapter per configuration", () => {
    const factory = createCodexAppServerAdapterFactory(unavailableHost())
    expect(factory()).not.toBe(factory())
  })
})
