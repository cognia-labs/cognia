import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { runTerminalDockAction } from "./dock-tool-handler"
import { isSessionScratchWorkspace } from "@/lib/task-workspace/managed-workspace"
import { TERMINAL_DOCK_TOOL_NAMES, buildTerminalDockToolEntries, toolFamily } from "./agent-tools"

jest.mock("./dock-tool-handler", () => ({ runTerminalDockAction: jest.fn() }))
jest.mock("@/lib/task-workspace/managed-workspace", () => ({
  isSessionScratchWorkspace: jest.fn(() => false),
}))

function surfaceContext(overrides: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return {
    session: null,
    agent: null,
    settings: { terminal: { exposeDockToAgents: true } } as never,
    activeGoal: null,
    prompts: { snapshot: null, context: {} as never },
    host: "desktop",
    activeProject: null,
    ...overrides,
  }
}

const call: ToolCallContext = {
  sessionId: "sess-1",
  toolUseId: "use-1",
  executionRunId: "run-1",
  outboundAuthorization: { kind: "tool-call", sessionId: "sess-1", toolUseId: "use-1" },
}

afterEach(() => {
  jest.mocked(runTerminalDockAction).mockReset()
  jest.mocked(isSessionScratchWorkspace).mockReturnValue(false)
})

describe("terminal dock tool entries", () => {
  it("offers the four dock tools with closed object schemas", () => {
    const entries = buildTerminalDockToolEntries()
    expect(entries.map((entry) => entry.name)).toEqual([...TERMINAL_DOCK_TOOL_NAMES])
    expect(TERMINAL_DOCK_TOOL_NAMES).toEqual([
      "terminal_dock_spawn",
      "terminal_dock_write",
      "terminal_dock_read_recent",
      "terminal_dock_wait_for_exit",
    ])
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema).toMatchObject({ type: "object", additionalProperties: false })
    }
  })

  it("reuses the schema constants rather than copying them", () => {
    const [a] = buildTerminalDockToolEntries()
    const [b] = buildTerminalDockToolEntries()
    expect(a.jsonSchema).toBe(b.jsonSchema)
  })
})

describe("the terminal tool family's surface", () => {
  it("offers the tools when the person lets agents use the dock", async () => {
    const surface = await toolFamily.surface(surfaceContext())
    expect(surface?.tools.map((entry) => entry.name)).toEqual([...TERMINAL_DOCK_TOOL_NAMES])
  })

  it("offers nothing while the setting is off or unset", async () => {
    expect(
      await toolFamily.surface(
        surfaceContext({ settings: { terminal: { exposeDockToAgents: false } } as never })
      )
    ).toBeNull()
    expect(await toolFamily.surface(surfaceContext({ settings: null }))).toBeNull()
  })

  it("offers nothing to an agent with plugin tools switched off", async () => {
    expect(
      await toolFamily.surface(surfaceContext({ agent: { disablePluginTools: true } as never }))
    ).toBeNull()
  })

  it("offers nothing to a headless host's scratch-workspace session", async () => {
    jest.mocked(isSessionScratchWorkspace).mockReturnValue(true)
    expect(await toolFamily.surface(surfaceContext({ host: "brain" }))).toBeNull()
    // A scratch check only applies on the headless host.
    expect(await toolFamily.surface(surfaceContext({ host: "desktop" }))).not.toBeNull()
  })

  it("still offers them on a headless host outside a scratch workspace", async () => {
    expect(await toolFamily.surface(surfaceContext({ host: "brain" }))).not.toBeNull()
  })
})

describe("the terminal tool family's run", () => {
  it("hands the action, the arguments and the calling conversation to the dock handler", async () => {
    jest.mocked(runTerminalDockAction).mockResolvedValue({ ok: true, records: [] })
    const result = await toolFamily.run("terminal_dock_read_recent", { tabId: "t1" }, call)
    expect(runTerminalDockAction).toHaveBeenCalledWith({
      action: "read_recent",
      args: { tabId: "t1" },
      chatSessionId: "sess-1",
    })
    expect(result).toEqual({ ok: true, records: [] })
  })

  it("reports a name it does not know instead of throwing", async () => {
    await expect(toolFamily.run("terminal_dock_kill", {}, call)).resolves.toEqual({
      ok: false,
      reason: "unknown terminal dock tool: terminal_dock_kill",
    })
    expect(runTerminalDockAction).not.toHaveBeenCalled()
  })
})
