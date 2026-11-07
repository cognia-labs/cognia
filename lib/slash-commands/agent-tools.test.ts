import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { hostCommandExecution } from "@/lib/plugin/core/invocation-identity"

const mockListSlashCommands = jest.fn(() => [{ name: "status", description: "Show status" }])
jest.mock("./registry", () => ({
  listSlashCommands: () => mockListSlashCommands(),
  dispatchSlashCommand: jest.fn(),
}))

import {
  SLASH_COMMAND_TOOL_NAME,
  __setSlashToolDepsForTesting,
  buildSlashCommandToolEntries,
  runSlashCommandTool,
  toolFamily,
  type SlashToolRunDeps,
} from "./agent-tools"

describe("SlashCommand tool", () => {
  it("builds a SlashCommand manifest entry, embedding available commands", () => {
    const entries = buildSlashCommandToolEntries([
      { name: "status", description: "Show status" },
      { name: "deploy" },
    ])
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e.name).toBe(SLASH_COMMAND_TOOL_NAME)
    expect(e.description).toMatch(/\/status: Show status/)
    expect(e.description).toMatch(/\/deploy/)
    // Honest limitation is stated.
    expect(e.description).toMatch(/chat composer/)
  })

  it("works with no command list", () => {
    const [e] = buildSlashCommandToolEntries()
    expect(e.description).not.toMatch(/Available commands/)
  })

  it("dispatches a command and returns its message, adding the leading slash", async () => {
    const calls: string[] = []
    const deps: SlashToolRunDeps = {
      dispatch: async (line) => {
        calls.push(line)
        return { message: "done" }
      },
    }
    const out = await runSlashCommandTool(
      SLASH_COMMAND_TOOL_NAME,
      { command: "status now" },
      deps,
      { sessionId: "s1" }
    )
    expect(out).toBe("done")
    expect(calls).toEqual(["/status now"])
  })

  it("serialises message + payload, and reports unknown commands", async () => {
    const both: SlashToolRunDeps = {
      dispatch: async () => ({ message: "ok", payload: { n: 1 } }),
    }
    const out = (await runSlashCommandTool(
      SLASH_COMMAND_TOOL_NAME,
      { command: "/x" },
      both
    )) as string
    expect(out).toContain("ok")
    expect(out).toContain('"n": 1')

    const unknown: SlashToolRunDeps = { dispatch: async () => null }
    expect(
      await runSlashCommandTool(SLASH_COMMAND_TOOL_NAME, { command: "/ghost" }, unknown)
    ).toMatch(/unknown slash command: \/ghost/)
  })

  it("returns errors for missing command, no dispatcher, and wrong tool", async () => {
    expect(await runSlashCommandTool(SLASH_COMMAND_TOOL_NAME, {}, {})).toMatch(
      /requires a `command`/
    )
    expect(await runSlashCommandTool(SLASH_COMMAND_TOOL_NAME, { command: "/x" }, {})).toMatch(
      /not available/
    )
    expect(await runSlashCommandTool("other", { command: "/x" }, {})).toMatch(/unknown slash tool/)
  })
})

describe("the slash-commands tool family", () => {
  function surfaceCtx(settings: ToolSurfaceContext["settings"]): ToolSurfaceContext {
    return {
      session: { id: "s1" } as ToolSurfaceContext["session"],
      agent: null,
      settings,
      activeGoal: null,
      prompts: { snapshot: null, context: {} },
      host: "cli",
      activeProject: null,
    }
  }

  afterEach(() => __setSlashToolDepsForTesting(null))

  it("offers SlashCommand with the registered commands once opted in, on any host", async () => {
    const surface = await toolFamily.surface(
      surfaceCtx({ selfInvokeTools: { slashCommand: true } } as ToolSurfaceContext["settings"])
    )
    expect(surface?.tools.map((tool) => tool.name)).toEqual([SLASH_COMMAND_TOOL_NAME])
    expect(surface?.tools[0].description).toMatch(/\/status: Show status/)
  })

  it("offers nothing until opted in", async () => {
    expect(await toolFamily.surface(surfaceCtx(null))).toBeNull()
    expect(mockListSlashCommands).not.toHaveBeenCalled()
  })

  it("runs the command as a host command of the calling conversation, under the call's run", async () => {
    const dispatch = jest.fn(async (_line: string, context: { sessionId?: string }) => {
      expect(hostCommandExecution(context)).toEqual({
        sessionId: "sess-Z",
        executionRunId: "exact-run",
      })
      return { message: "ran" }
    })
    __setSlashToolDepsForTesting(() => ({ dispatch }))
    const call: ToolCallContext = {
      sessionId: "sess-Z",
      toolUseId: "use-1",
      executionRunId: "exact-run",
      outboundAuthorization: { kind: "tool-call", sessionId: "sess-Z", toolUseId: "use-1" },
    }
    expect(
      await toolFamily.run(
        SLASH_COMMAND_TOOL_NAME,
        { command: "/status", executionRunId: "forged" },
        call
      )
    ).toBe("ran")
    expect(dispatch).toHaveBeenCalledWith("/status", { sessionId: "sess-Z" })
  })
})
