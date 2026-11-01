/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import type { McpServer } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  finishToolExecutionRun,
  bindToolCallRun,
} from "@/lib/execution/acting-authority"
import { mcpOAuthLoadEntry, mcpOAuthStatus } from "@/lib/mcp/oauth-tauri"
import { defaultMcpRuntimeGateway } from "@/lib/mcp/runtime-gateway"
import { ManagedMcpAppCard } from "./managed-mcp-app-card"

jest.mock("@/lib/tauri", () => ({ ...jest.requireActual("@/lib/tauri"), isTauri: () => true }))
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  mcpOAuthLoadEntry: jest.fn(),
  mcpOAuthStatus: jest.fn(),
}))
jest.mock("@/lib/mcp/runtime-gateway", () => ({
  defaultMcpRuntimeGateway: { readResource: jest.fn() },
}))
jest.mock("./mcp-app-frame", () => ({ McpAppFrame: () => <span>loaded-app</span> }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize, 60_000)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(mcpOAuthLoadEntry).mockReset().mockResolvedValue({ accessToken: "personal-bearer" })
  jest.mocked(mcpOAuthStatus).mockReset().mockResolvedValue({ hasTokens: true })
  jest
    .mocked(defaultMcpRuntimeGateway.readResource)
    .mockReset()
    .mockResolvedValue({
      contents: [
        { uri: "ui://app", mimeType: "text/html;profile=mcp-app", text: "<main>app</main>" },
      ],
    })
  await getDb().mcpServers.put({
    id: "oauth",
    name: "remote",
    transport: "http",
    enabled: true,
    config: { url: "https://mcp.example.com" },
    createdAt: 1,
    updatedAt: 1,
  } as McpServer)
  await getDb().mcpCapabilityCache.put({
    id: "cache",
    serverId: "oauth",
    fingerprint: "f",
    tools: [{ name: "edit", _meta: { ui: { resourceUri: "ui://app" } } }],
    resources: [],
    prompts: [],
    updatedAt: 1,
    expiresAt: Date.now() + 60_000,
  })
})
afterAll(fixture.dispose)

const part = {
  type: "tool-mcp__remote__edit",
  toolCallId: "call",
  state: "output-available",
  input: {},
  output: "ok",
} as ToolUIPart

it.each(["non-owner", "bot", "external-engine", "unknown", "history"])(
  "auto-mount refuses personal OAuth for %s without user interaction",
  async (kind) => {
    if (kind !== "unknown") {
      const run = await startToolExecutionRun(
        "chat",
        kind === "history" || kind === "external-engine"
          ? { localAuthorization: LOCAL_PERSON_RUN }
          : {}
      )
      if (kind !== "external-engine")
        bindToolCallRun("chat", "turn", run.id, undefined, { builtinRuntime: true })
      if (kind === "non-owner")
        await getDb().executionRuns.update(run.id, {
          actingIdentity: {
            ...run.actingIdentity!,
            trigger: "requester",
            requesters: [
              { kind: "platform", platform: "lark", adapterId: "a", remoteUserId: "non-owner" },
            ],
          },
        })
      if (kind === "bot")
        await getDb().executionRuns.update(run.id, {
          actingIdentity: { ...run.actingIdentity!, lane: "service" },
        })
      await runEventJournal.append(
        run.id,
        semanticRunEvent("tool.started", { toolCallId: "call", toolName: "mcp__remote__edit" })
      )
      if (kind === "history") await finishToolExecutionRun(run.id)
    }
    // A different, live local turn cannot authorize this tool part.
    await startToolExecutionRun("chat", { localAuthorization: LOCAL_PERSON_RUN })
    const { container } = render(
      <ManagedMcpAppCard part={part} namespacedToolName="mcp__remote__edit" sessionId="chat" />
    )
    await waitFor(() => expect(mcpOAuthStatus).toHaveBeenCalled())
    expect(mcpOAuthLoadEntry).not.toHaveBeenCalled()
    expect(defaultMcpRuntimeGateway.readResource).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  }
)

it("auto-loads only under the exact live local tool execution", async () => {
  const run = await startToolExecutionRun("chat", { localAuthorization: LOCAL_PERSON_RUN })
  bindToolCallRun("chat", "turn", run.id, undefined, { builtinRuntime: true })
  await runEventJournal.append(
    run.id,
    semanticRunEvent("tool.started", { toolCallId: "call", toolName: "mcp__remote__edit" })
  )
  render(<ManagedMcpAppCard part={part} namespacedToolName="mcp__remote__edit" sessionId="chat" />)
  expect(await screen.findByText("loaded-app")).toBeInTheDocument()
  expect(mcpOAuthLoadEntry).toHaveBeenCalledWith("oauth", "remote", expect.any(Object), {
    sessionId: "chat",
    executionRunId: run.id,
    externalEngine: false,
  })
})
