/** @jest-environment jsdom */

import {
  __resetIntegrationRegistryForTesting,
  getIntegrationAccountStatusProvider,
  getIntegrationResourceProvider,
  listRegisteredIntegrations,
} from "@/lib/integrations/registry"
import { getExecutor, __resetRegistryForTesting } from "@/lib/workflow/nodes/registry"
import {
  __resetPluginCatalogForTesting,
  getPluginCatalogSnapshot,
} from "@/lib/workflow/nodes/catalog"
import {
  registerIntegrationsForPlugin,
  unregisterIntegrationsForPlugin,
} from "./integrations-bridge"
import type { PluginManifest, PluginTool } from "@/types/plugin"
import {
  approveIntegrationActionJob,
  executeIntegrationAction,
} from "@/lib/integrations/action-runner"

jest.mock("@/lib/integrations/action-runner", () => ({
  executeIntegrationAction: jest.fn(),
  approveIntegrationActionJob: jest.fn(),
}))
jest.mock("@/lib/db/external-services", () => ({
  listServiceConnections: jest.fn(async () => [
    {
      id: "conn-1",
      serviceId: "svc",
      providerId: "prov",
      providerRef: { kind: "integration", accountId: "acct-1" },
    },
  ]),
  listCapabilityGrants: jest.fn(async () => []),
}))
jest.mock("@/lib/external-services/catalog", () => ({
  listExternalServices: () => [
    {
      definition: {
        id: "svc",
        providers: [{ id: "prov", kind: "integration", contributionId: "example" }],
      },
    },
  ],
  listExternalCapabilities: () => [],
}))
jest.mock("@/lib/external-services/grants", () => ({
  authorizeExternalCapability: jest.fn(async () => ({ decision: "allow" })),
  extractCapabilityResourceScopes: () => ({ ok: true, scopes: [] }),
}))

describe("Integration manifest bridge", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetIntegrationRegistryForTesting()
    __resetRegistryForTesting()
    __resetPluginCatalogForTesting()
  })

  it("resolves handlers and auto-materializes typed Workflow action nodes", async () => {
    const manifest = {
      id: "example-delivery",
      name: "Example",
      version: "1.0.0",
      description: "Example",
      type: "frontend",
      capabilities: ["integrations"],
      integrations: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [],
          resourceProvider: { handler: "listResources", kinds: ["issue"] },
          healthProvider: { handler: "checkHealth" },
          actions: [
            {
              id: "issue.comment",
              label: "Comment on issue",
              handler: "commentIssue",
              inputSchema: {
                type: "object",
                properties: { issueId: { type: "string" } },
                required: ["issueId"],
              },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
    } as PluginManifest
    const commentIssue = jest.fn()
    const listResources = jest.fn()
    const checkHealth = jest.fn()
    const registeredTools: Array<{ name: string; definition: { parametersSchema: unknown } }> = []

    await registerIntegrationsForPlugin(
      "example-delivery",
      manifest,
      {
        commentIssue,
        listResources,
        checkHealth,
      },
      (tool) => {
        registeredTools.push(tool)
        return () => undefined
      }
    )

    expect(listRegisteredIntegrations("example-delivery")).toHaveLength(1)
    expect(getIntegrationResourceProvider("example-delivery", "example")).toBe(listResources)
    expect(getIntegrationAccountStatusProvider("example-delivery", "example")).toBe(checkHealth)
    expect(getExecutor("example-delivery.action.issue.comment" as never, 1)).toBeDefined()
    expect(registeredTools).toEqual([
      expect.objectContaining({
        name: "integration__example-delivery__example__issue_comment",
        definition: expect.objectContaining({
          parametersSchema: expect.objectContaining({
            required: ["accountId", "issueId"],
          }),
        }),
      }),
    ])
    expect(
      getPluginCatalogSnapshot().find(
        (entry) => entry.kind === ("example-delivery.action.issue.comment" as never)
      )?.paramsSchema
    ).toMatchObject({
      properties: {
        accountId: { type: "string" },
        issueId: { type: "string" },
      },
      required: ["accountId", "issueId"],
    })

    await unregisterIntegrationsForPlugin("example-delivery")
    expect(listRegisteredIntegrations("example-delivery")).toHaveLength(0)
  })

  it("tells the broker which chat session or workflow run asks (ADR-0239 phase 2)", async () => {
    const manifest = {
      id: "example-delivery",
      name: "Example",
      version: "1.0.0",
      description: "Example",
      type: "frontend",
      capabilities: ["integrations"],
      integrations: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [],
          actions: [
            {
              id: "issue.comment",
              label: "Comment on issue",
              handler: "commentIssue",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
    } as PluginManifest
    const job = { id: "job-1", status: "awaiting_approval" }
    jest.mocked(executeIntegrationAction).mockResolvedValue(job as never)
    jest.mocked(approveIntegrationActionJob).mockResolvedValue(job as never)
    const tools: Array<{ execute: (args: unknown, context: unknown) => Promise<unknown> }> = []
    await registerIntegrationsForPlugin(
      "example-delivery",
      manifest,
      { commentIssue: jest.fn() },
      (tool) => {
        tools.push(tool as never)
        return () => undefined
      }
    )

    await tools[0].execute(
      { accountId: "acct-1", issueId: "1" },
      { sessionId: "s1", invocationId: "invocation-1" }
    )
    expect(executeIntegrationAction).toHaveBeenLastCalledWith(
      "example-delivery",
      expect.objectContaining({ source: "chat", idempotencyKey: "invocation-1:issue.comment" }),
      { kind: "tool-call", sessionId: "s1" }
    )
    // The bridge's own automatic approval; a held job ignores it.
    expect(approveIntegrationActionJob).toHaveBeenLastCalledWith("job-1")

    await getExecutor("example-delivery.action.issue.comment" as never, 1)!.execute({
      params: { accountId: "acct-1", issueId: "1" },
      workflowId: "wf-1",
      runId: "wr-1",
      stepId: "step-1",
    } as never)
    expect(executeIntegrationAction).toHaveBeenLastCalledWith(
      "example-delivery",
      expect.objectContaining({ source: "workflow", idempotencyKey: "wr-1:step-1" }),
      { kind: "workflow", workflowId: "wf-1", runId: "wr-1" }
    )
    await unregisterIntegrationsForPlugin("example-delivery")
  })

  async function chatAction(
    risk: "read" | "write",
    idempotency: "required" | "supported"
  ): Promise<PluginTool> {
    const manifest = {
      id: "example-delivery",
      name: "Example",
      version: "1.0.0",
      description: "Example",
      type: "frontend",
      capabilities: ["integrations"],
      integrations: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["calendar"],
          eventTypes: [],
          actions: [
            {
              id: "calendar.action",
              label: "Calendar action",
              handler: "calendarAction",
              inputSchema: { type: "object" },
              risk,
              idempotency,
            },
          ],
        },
      ],
    } as PluginManifest
    const tools: PluginTool[] = []
    const jobs = new Map<string, { id: string; status: string }>()
    let sequence = 0
    jest.mocked(executeIntegrationAction).mockImplementation(async (_pluginId, input) => {
      const key = input.idempotencyKey ?? `uncached-${++sequence}`
      if (!jobs.has(key)) jobs.set(key, { id: `job-${++sequence}`, status: "succeeded" })
      return jobs.get(key)! as never
    })
    await registerIntegrationsForPlugin(
      "example-delivery",
      manifest,
      { calendarAction: jest.fn() },
      (tool) => {
        tools.push(tool)
        return () => undefined
      }
    )
    return tools[0]
  }

  it("does not permanently cache read results for repeated calls in the same chat", async () => {
    const tool = await chatAction("read", "supported")
    const first = await tool.execute(
      { accountId: "acct-1", calendarId: "a" },
      { sessionId: "s1", config: {} }
    )
    const second = await tool.execute(
      { accountId: "acct-1", calendarId: "b" },
      { sessionId: "s1", config: {} }
    )
    expect(first).not.toEqual(second)
    expect(
      jest.mocked(executeIntegrationAction).mock.calls.map(([, input]) => input.idempotencyKey)
    ).toEqual([undefined, undefined])
    await unregisterIntegrationsForPlugin("example-delivery")
  })

  it.each(["required", "supported"] as const)(
    "scopes %s write keys to logical invocations, preserving retry identity",
    async (idempotency) => {
      const tool = await chatAction("write", idempotency)
      const first = await tool.execute(
        { accountId: "acct-1", title: "First" },
        {
          sessionId: "s1",
          invocationId: "call-1",
          config: {},
        }
      )
      const retry = await tool.execute(
        { accountId: "acct-1", title: "First" },
        {
          sessionId: "s1",
          invocationId: "call-1",
          config: {},
        }
      )
      const next = await tool.execute(
        { accountId: "acct-1", title: "Next" },
        {
          sessionId: "s1",
          invocationId: "call-2",
          config: {},
        }
      )
      expect(retry).toEqual(first)
      expect(next).not.toEqual(first)
      expect(
        jest.mocked(executeIntegrationAction).mock.calls.map(([, input]) => input.idempotencyKey)
      ).toEqual(["call-1:calendar.action", "call-1:calendar.action", "call-2:calendar.action"])
      await unregisterIntegrationsForPlugin("example-delivery")
    }
  )

  it("does not collapse independent writes from older callers without invocation ids", async () => {
    const tool = await chatAction("write", "required")
    const first = await tool.execute(
      { accountId: "acct-1", title: "First" },
      { sessionId: "s1", config: {} }
    )
    const second = await tool.execute(
      { accountId: "acct-1", title: "Next" },
      { sessionId: "s1", config: {} }
    )
    expect(first).not.toEqual(second)
    const keys = jest
      .mocked(executeIntegrationAction)
      .mock.calls.map(([, input]) => input.idempotencyKey)
    expect(keys[0]).toEqual(expect.any(String))
    expect(keys[1]).not.toBe(keys[0])
    await unregisterIntegrationsForPlugin("example-delivery")
  })

  it.each(["read", "write"] as const)(
    "honors explicit caller keys for %s actions",
    async (risk) => {
      const tool = await chatAction(risk, "supported")
      await tool.execute(
        { accountId: "acct-1", idempotencyKey: "caller-key" },
        { sessionId: "s1", config: {} }
      )
      expect(executeIntegrationAction).toHaveBeenLastCalledWith(
        "example-delivery",
        expect.objectContaining({ idempotencyKey: "caller-key" }),
        expect.anything()
      )
      await unregisterIntegrationsForPlugin("example-delivery")
    }
  )
})
