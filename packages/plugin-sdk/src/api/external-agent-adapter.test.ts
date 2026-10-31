import * as sdk from "./external-agent-adapter"
import * as runtime from "@cognia/agent-runtime-kit/base-adapter"
import type {
  AcpElicitationResponse,
  AcpPermissionResponse,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@cognia/agent-contracts/external-agent"
import type {
  PluginExternalAgentAdapterDef,
  ProtocolAdapter,
  ProtocolAdapterFactory,
  ProtocolAdapterRegistryChange,
  SessionCreateOptions,
} from "./external-agent-adapter"

describe("plugin-sdk api/external-agent-adapter", () => {
  it("exposes portable authoring and adapter runtime helpers", () => {
    expect(typeof sdk.defineExternalAgentAdapter).toBe("function")
    expect(typeof sdk.BaseProtocolAdapter).toBe("function")
    expect(typeof sdk.foldUsageUpdate).toBe("function")
    expect(typeof sdk.mergeTurnUsage).toBe("function")
    expect(typeof sdk.getExternalAgentExecutionBlock).toBe("function")
  })

  it("defineExternalAgentAdapter is a typesafe identity function", () => {
    const def = sdk.defineExternalAgentAdapter({
      id: "demo-protocol",
      label: "Demo Protocol",
      entry: "dist/adapter.js",
      export: "createDemoAdapter",
    })

    expect(def.id).toBe("demo-protocol")
    expect(def.export).toBe("createDemoAdapter")
  })

  it("re-exports external-agent adapter protocol types", () => {
    const assertTypes = <
      _T extends
        | PluginExternalAgentAdapterDef
        | ProtocolAdapter
        | ProtocolAdapterFactory
        | ProtocolAdapterRegistryChange
        | SessionCreateOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})

// Exercise both public entry points with the same expectations. Equality alone
// could let two implementations agree on the same lost usage or attachment.
const timestamp = new Date("2026-10-30T00:00:00Z")
const message: ExternalAgentMessage = {
  id: "input",
  role: "user",
  content: [{ type: "text", text: "Run the fixture" }],
  timestamp,
}
const done: ExternalAgentEvent = { type: "done", success: true, timestamp }
type AdapterConstructor = abstract new () => Pick<ProtocolAdapter, "execute">

function fixtureAdapter(
  Base: AdapterConstructor,
  events: readonly ExternalAgentEvent[],
  streamError?: Error
) {
  return new (class extends Base {
    respondToPermission = jest.fn(
      async (_sessionId: string, _response: AcpPermissionResponse) => {}
    )
    respondToElicitation = jest.fn(async (_response: AcpElicitationResponse) => {})

    async *prompt() {
      yield* events
      if (streamError) throw streamError
    }

    protected generateMessageId(): string {
      return "collected-message"
    }
  })()
}

describe.each([
  ["agent-runtime-kit", runtime],
  ["plugin-sdk", sdk],
] as const)("%s shared adapter behavior", (_name, api) => {
  it("retains the latest detailed usage rather than context occupancy", async () => {
    const adapter = fixtureAdapter(api.BaseProtocolAdapter, [
      {
        type: "usage_update",
        timestamp,
        used: 40_000,
        size: 200_000,
        tokenUsage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      },
      {
        type: "usage_update",
        timestamp,
        used: 50_000,
        size: 200_000,
        cost: { amount: 9, currency: "USD" },
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          reasoningTokens: 5,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          providerCost: { amount: 0.2, currency: "USD" },
        },
      },
      done,
    ])
    expect((await adapter.execute("s", message)).tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      reasoningTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      providerCost: { amount: 0.2, currency: "USD" },
      contextTokens: 50_000,
      modelContextWindow: 200_000,
    })
  })

  it("keeps accounting through occupancy updates and lets final usage win", async () => {
    const adapter = fixtureAdapter(api.BaseProtocolAdapter, [
      {
        type: "usage_update",
        timestamp,
        used: 50_000,
        size: 200_000,
        cost: { amount: 1, currency: "USD" },
      },
      {
        type: "message_end",
        timestamp,
        tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      { type: "usage_update", timestamp, used: 60_000, size: 0, cost: null },
      { ...done, tokenUsage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 } },
    ])
    expect((await adapter.execute("s", message)).tokenUsage).toEqual({
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      contextTokens: 60_000,
      modelContextWindow: 200_000,
      providerCost: { amount: 1, currency: "USD" },
    })
  })

  it("does not invent usage for an unreported turn", async () => {
    expect(
      (await fixtureAdapter(api.BaseProtocolAdapter, [done]).execute("s", message)).tokenUsage
    ).toBeUndefined()
  })

  it("keeps usage helper exports consistent with the execution contract", () => {
    const counted = api.foldUsageUpdate(undefined, {
      used: 50_000,
      size: 200_000,
      tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    })
    expect(counted).toMatchObject({ totalTokens: 120, contextTokens: 50_000 })
    expect(api.foldUsageUpdate(counted, { used: 60_000, size: 0, cost: null })).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      contextTokens: 60_000,
    })
    expect(
      api.mergeTurnUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, counted)
    ).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      contextTokens: 50_000,
      modelContextWindow: 200_000,
    })
  })

  it("replaces artifact snapshots and retains binary bodies with text and thinking", async () => {
    const resource = {
      type: "resource" as const,
      resource: { uri: "a2a:file.bin", blob: "AAEC", mimeType: "application/octet-stream" },
    }
    const adapter = fixtureAdapter(api.BaseProtocolAdapter, [
      { type: "message_delta", timestamp, delta: { type: "thinking", text: "Thinking" } },
      { type: "message_delta", timestamp, delta: { type: "text", text: "Answer:" } },
      {
        type: "artifact_update",
        timestamp,
        artifactId: "a",
        blocks: [{ type: "text", text: "draft" }],
        complete: false,
      },
      { type: "artifact_update", timestamp, artifactId: "a", blocks: [resource], complete: true },
      {
        type: "artifact_update",
        timestamp,
        artifactId: "b",
        blocks: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        complete: true,
      },
      done,
    ])
    const result = await adapter.execute("s", message)
    expect(result.success).toBe(true)
    expect(result.finalResponse).toBe("Answer:[file: a2a:file.bin][image: image/png]")
    expect(result.messages[0]).toBe(message)
    expect(result.messages.at(-1)).toMatchObject({
      id: "collected-message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Thinking" },
        { type: "text", text: "Answer:" },
        resource,
        { type: "image", source: { type: "base64", data: "aW1hZ2U=", mediaType: "image/png" } },
      ],
    })
  })

  it("returns artifact-only replies and supports empty replacement snapshots", async () => {
    const result = await fixtureAdapter(api.BaseProtocolAdapter, [
      {
        type: "artifact_update",
        timestamp,
        artifactId: "removed",
        blocks: [{ type: "text", text: "obsolete" }],
        complete: false,
      },
      { type: "artifact_update", timestamp, artifactId: "removed", blocks: [], complete: true },
      {
        type: "artifact_update",
        timestamp,
        artifactId: "kept",
        blocks: [{ type: "text", text: "artifact-body" }],
        complete: true,
      },
      done,
    ]).execute("s", message)
    expect(result.finalResponse).toBe("artifact-body")
    expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "artifact-body" }])
  })

  it("forwards events, approvals, elicitation, progress and tool results", async () => {
    const request = { id: "r", requestId: "r", sessionId: "s", toolInfo: { id: "t", name: "read" } }
    const elicitation = {
      id: "e",
      mode: "form" as const,
      message: "Choose",
      requestedSchema: { type: "object" as const, properties: {} },
      raw: {},
    }
    const permission: AcpPermissionResponse = {
      requestId: "r",
      granted: true,
      optionId: "allow",
    }
    const answer: AcpElicitationResponse = { requestId: "e", action: "accept", content: {} }
    const events: ExternalAgentEvent[] = [
      { type: "permission_request", timestamp, request },
      { type: "elicitation_request", timestamp, request: elicitation },
      { type: "plan_update", timestamp, entries: [], step: 1, totalSteps: 4, progress: 0.25 },
      { type: "progress", timestamp, progress: 0.5, message: "Working" },
      { type: "tool_use_start", timestamp, toolUseId: "t", toolName: "read" },
      { type: "tool_use_end", timestamp, toolUseId: "t", input: { path: "file" } },
      { type: "tool_result", timestamp, toolUseId: "t", result: "body", isError: false },
      done,
    ]
    const adapter = fixtureAdapter(api.BaseProtocolAdapter, events)
    const onEvent = jest.fn()
    const onProgress = jest.fn()
    const result = await adapter.execute("s", message, {
      onEvent,
      onProgress,
      onPermissionRequest: async () => permission,
      onElicitationRequest: async () => answer,
    })
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events)
    expect(adapter.respondToPermission).toHaveBeenCalledWith("s", permission)
    expect(adapter.respondToElicitation).toHaveBeenCalledWith(answer)
    expect(onProgress.mock.calls).toEqual([[0.25], [0.5, "Working"]])
    expect(result.toolCalls).toEqual([
      { id: "t", name: "read", input: { path: "file" }, result: "body", status: "completed" },
    ])
  })

  it("does not turn an unanswered refusal into success", async () => {
    const result = await fixtureAdapter(api.BaseProtocolAdapter, [
      { type: "error", timestamp, error: "Provider refused" },
      done,
    ]).execute("s", message)
    expect(result).toMatchObject({ success: false, error: "Provider refused", finalResponse: "" })
  })

  it("keeps a recovered artifact-producing turn successful", async () => {
    const result = await fixtureAdapter(api.BaseProtocolAdapter, [
      { type: "error", timestamp, error: "Retrying" },
      {
        type: "artifact_update",
        timestamp,
        artifactId: "a",
        blocks: [{ type: "text", text: "Recovered" }],
        complete: true,
      },
      done,
    ]).execute("s", message)
    expect(result).toMatchObject({ success: true, finalResponse: "Recovered" })
  })

  it("turns a stream exception into a failed result", async () => {
    const result = await fixtureAdapter(
      api.BaseProtocolAdapter,
      [],
      new Error("Stream failed")
    ).execute("s", message)
    expect(result).toMatchObject({
      success: false,
      error: "Stream failed",
      finalResponse: "",
      messages: [message],
    })
  })
})
