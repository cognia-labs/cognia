/** @jest-environment jsdom */
import type { UIMessage } from "ai"

import { buildLiveVoiceRuntimeBindings } from "./runtime-bindings"

jest.mock("@/lib/execution/personal-visibility", () => ({
  prepareOwnerHistory: async (messages: readonly { id: string }[]) => {
    const { withholdForReaders } =
      await import("@cognia/plugin-contract/types/execution/personal-visibility")
    return withholdForReaders(messages, [{ kind: "local-person" }])
  },
}))

const LIMITS = { turnLimit: 12, characterLimit: 16_000 }

function history(): UIMessage[] {
  return [
    { id: "m1", role: "user", parts: [{ type: "text", text: "who won" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "the badgers" }] },
  ] as unknown as UIMessage[]
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    listMessages: jest.fn(async () => history()),
    buildPluginToolsManifest: jest.fn(async () => [
      { name: "search_notes", description: "search", jsonSchema: {}, pluginId: "notes" },
    ]),
    executeTool: jest.fn(async () => ({ result: null })),
    ...overrides,
  }
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    supportsTools: true,
    policy: {},
    limits: LIMITS,
    ...overrides,
  }
}

describe("buildLiveVoiceRuntimeBindings", () => {
  it("advertises the plugin manifest as realtime tools", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: deps() }))

    expect(bindings.tools).toEqual([
      {
        type: "function",
        name: "search_notes",
        description: "search",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ])
  })

  it("attaches an executor bound to the chat session", async () => {
    const d = deps()
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: d }))

    expect(bindings.toolExecution?.sessionId).toBe("s1")
    await bindings.toolExecution?.execute({
      sessionId: "s1",
      callId: "c1",
      name: "search_notes",
      args: {},
      signal: new AbortController().signal,
    })
    expect(d.executeTool).toHaveBeenCalled()
  })

  it("does not advertise host built-ins that cannot honour provider cancellation", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [
            {
              name: "ask_user",
              description: "ask",
              jsonSchema: {},
              pluginId: "cognia-ask-user",
            },
            {
              name: "terminal_dock_write",
              description: "write",
              jsonSchema: {},
              pluginId: "cognia-terminal-builtin",
            },
            {
              name: "search_notes",
              description: "search",
              jsonSchema: {},
              pluginId: "notes",
            },
          ]),
        }),
      })
    )

    expect(bindings.tools?.map((tool) => tool.name)).toEqual(["search_notes"])
  })

  it("carries the permission policy through untouched", async () => {
    const policy = { toolRules: { search_notes: "allow" as const } }
    const bindings = await buildLiveVoiceRuntimeBindings(options({ policy, deps: deps() }))

    expect(bindings.toolExecution?.policy).toBe(policy)
  })

  it("offers no tools when no candidate provider supports them", async () => {
    const d = deps()
    const bindings = await buildLiveVoiceRuntimeBindings(options({ supportsTools: false, deps: d }))

    expect(bindings.tools).toBeUndefined()
    expect(bindings.toolExecution).toBeUndefined()
    expect(d.buildPluginToolsManifest).not.toHaveBeenCalled()
    // Not a degradation: nothing that could use tools was going to get them.
    expect(bindings.toolsUnavailable).toBe(false)
  })

  it("offers no tools without a chat session to attribute approvals to", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({ sessionId: undefined, deps: deps() })
    )

    expect(bindings.toolExecution).toBeUndefined()
  })

  it("attaches no executor when every tool was dropped", async () => {
    // Advertising nothing but keeping an executor would be dead weight.
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [
            { name: "not a valid name", description: "", jsonSchema: {}, pluginId: "p" },
          ]),
        }),
      })
    )

    expect(bindings.tools).toBeUndefined()
    expect(bindings.toolExecution).toBeUndefined()
    expect(bindings.droppedTools).toHaveLength(1)
  })

  it("reports dropped tools for diagnostics", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [
            { name: "ok_tool", description: "", jsonSchema: {}, pluginId: "p" },
            { name: "bad name", description: "", jsonSchema: {}, pluginId: "p" },
          ]),
        }),
      })
    )

    expect(bindings.tools).toHaveLength(1)
    expect(bindings.droppedTools).toEqual([
      { name: "bad name", pluginId: "p", reason: "invalid-name" },
    ])
  })

  it("seeds the conversation from the session history", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: deps() }))

    expect(bindings.contextTranscript).toContain("User: who won")
    expect(bindings.contextTranscript).toContain("Assistant: the badgers")
  })

  it("withholds marked seed rows before rendering their text and tool labels", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          listMessages: async () => [
            {
              id: "private",
              role: "assistant",
              metadata: {
                personalMarks: [
                  {
                    version: 1,
                    person: {
                      kind: "platform",
                      platform: "lark",
                      adapterId: "foreign-adapter",
                      remoteUserId: "foreign-person",
                    },
                    source: "personal-read",
                    markedAt: 1,
                  },
                ],
              },
              parts: [
                { type: "text", text: "PRIVATE VOICE SEED" },
                { type: "tool-secret-tool", state: "output-available", output: "PRIVATE RESULT" },
              ],
            },
          ],
        }),
      })
    )

    expect(bindings.contextTranscript).toContain("[Withheld: personal content of")
    expect(bindings.contextTranscript).not.toMatch(/PRIVATE|secret-tool/)
  })

  it("includes the owner's marked history in their own live voice dialog", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          listMessages: async () => [
            {
              id: "owner-voice",
              role: "assistant",
              parts: [{ type: "text", text: "OWNER VOICE CONTEXT" }],
              metadata: {
                personalMarks: [{ person: { kind: "local-person" }, source: "read", markedAt: 1 }],
              },
            },
          ],
        }),
      })
    )
    expect(bindings.contextTranscript).toContain("OWNER VOICE CONTEXT")
  })

  it("skips the seed when there is no session", async () => {
    const d = deps()
    const bindings = await buildLiveVoiceRuntimeBindings(options({ sessionId: undefined, deps: d }))

    expect(bindings.contextTranscript).toBeUndefined()
    expect(d.listMessages).not.toHaveBeenCalled()
  })

  it("skips the seed for an empty session rather than sending a bare header", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({ deps: deps({ listMessages: jest.fn(async () => []) }) })
    )

    expect(bindings.contextTranscript).toBeUndefined()
  })

  it("still starts when the history cannot be read", async () => {
    // A voice session with no context beats no voice session.
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          listMessages: jest.fn(async () => {
            throw new Error("dexie is closed")
          }),
        }),
      })
    )

    expect(bindings.contextTranscript).toBeUndefined()
    expect(bindings.tools).toHaveLength(1)
    expect(bindings.historyUnavailable).toBe(true)
    expect(bindings.toolsUnavailable).toBe(false)
  })

  it("still starts when the plugin manifest cannot be built", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => {
            throw new Error("plugin store not initialised")
          }),
        }),
      })
    )

    expect(bindings.tools).toBeUndefined()
    expect(bindings.contextTranscript).toContain("User: who won")
    expect(bindings.toolsUnavailable).toBe(true)
    expect(bindings.historyUnavailable).toBe(false)
  })

  it("reports no degradation when history and tools both resolved", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: deps() }))

    expect(bindings).toMatchObject({
      historyUnavailable: false,
      toolsUnavailable: false,
      droppedTools: [],
    })
  })
})

const DECLARED_MODULE_TOOLS = [
  {
    module: "crate",
    stage: "stable",
    declare: {
      crate_list: { consent: "allow", effect: "read" },
      crate_tidy: { consent: "ask", effect: "write" },
      Crate_Send: { consent: "per-call", effect: "outbound", cancellable: false },
      crate_unlock: { consent: "ask", effect: "read", secrets: true },
    },
    load: async () => ({}),
  },
]

/** Load `load()` against a registry in which a module declares tools (ADR-0250 §14 amendment). */
async function withDeclaredModuleTools<T>(load: () => Promise<T>): Promise<T> {
  let loaded!: T
  await jest.isolateModulesAsync(async () => {
    jest.doMock("@/lib/modules/generated/tools", () => ({ MODULE_TOOLS: DECLARED_MODULE_TOOLS }))
    loaded = await load()
  })
  jest.dontMock("@/lib/modules/generated/tools")
  return loaded
}

describe("module-contributed tools", () => {
  it("does not advertise a module tool declared non-cancellable", async () => {
    const { buildLiveVoiceRuntimeBindings: build } = await withDeclaredModuleTools(
      () => import("./runtime-bindings")
    )
    const entry = (name: string) => ({
      name,
      description: name,
      jsonSchema: {},
      pluginId: "cognia-crate-builtin",
    })
    const bindings = await build(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [entry("Crate_Send"), entry("crate_list")]),
        }),
      })
    )
    expect(bindings.tools?.map((tool) => tool.name)).toEqual(["crate_list"])
  })
})
