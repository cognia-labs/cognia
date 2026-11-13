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
  it.each(["terminal_dock_spawn", "terminal_dock_write"])(
    "passes the sent, do-not-retry reason unchanged to the model for %s",
    async (name) => {
      const failure = {
        ok: false as const,
        code: "command_sent_unobserved" as const,
        reason:
          "Command was sent to session t1 and may still be running. Completion cannot be observed. Do not send it again.",
      }
      jest.mocked(runTerminalDockAction).mockResolvedValue(failure)
      // Spawn and write pass the personal-egress fence, which needs a real,
      // clean run; an unknown run id fails closed.
      const { createDbTestFixture } = await import("@/lib/db/test-fixture")
      const fixture = createDbTestFixture()
      await fixture.initialize()
      try {
        const { startToolExecutionRun, LOCAL_PERSON_RUN } =
          await import("@/lib/execution/acting-authority")
        const run = await startToolExecutionRun(call.sessionId, {
          localAuthorization:
            LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
        })
        const result = await toolFamily.run(
          name,
          { tabId: "t1", command: "deploy" },
          { ...call, executionRunId: run.id }
        )
        expect(result).toEqual(failure)
        expect(runTerminalDockAction).toHaveBeenCalledTimes(1)
      } finally {
        await fixture.dispose()
      }
    }
  )

  it("hands the action, the arguments and the calling conversation to the dock handler", async () => {
    jest.mocked(runTerminalDockAction).mockResolvedValue({ ok: true, records: [] })
    const result = await toolFamily.run("terminal_dock_read_recent", { tabId: "t1" }, call)
    expect(runTerminalDockAction).toHaveBeenCalledWith({
      action: "read_recent",
      args: { tabId: "t1" },
      chatSessionId: "sess-1",
      credentialContext: call,
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

it.each(["terminal_dock_spawn", "terminal_dock_write"])(
  "S2 fences opaque dock %s before the PTY callback",
  async (name) => {
    await expect(
      toolFamily.run(name, {}, Object.assign({ ...call }, { personalEgressBlocked: true }))
    ).rejects.toMatchObject({ code: "personal-egress-denied" })
    expect(runTerminalDockAction).not.toHaveBeenCalled()
  }
)

it.each([
  {
    name: "terminal_dock_spawn",
    result: { ok: false, reason: "timeout", sessionId: "f5-dock-timeout" },
  },
  {
    name: "terminal_dock_spawn",
    result: { ok: true, exitCode: 0, sessionId: "f5-dock-completed" },
  },
  {
    name: "terminal_dock_write",
    result: { ok: false, reason: "timeout", sessionId: "f5-dock-write" },
  },
])(
  "F5 $name retains live PTY after result $result.sessionId until exit",
  async ({ name, result }) => {
    const { createDbTestFixture } = await import("@/lib/db/test-fixture")
    const fixture = createDbTestFixture()
    await fixture.initialize()
    const { startToolExecutionRun, LOCAL_PERSON_RUN } =
      await import("@/lib/execution/acting-authority")
    const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
    const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
    const { registerLiveSession, unregisterLiveSession } = await import("./session-registry")
    const parent = await startToolExecutionRun("f5-dock-parent", {
      localAuthorization:
        LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
    })
    const owner = await startToolExecutionRun(call.sessionId, { parentRunId: parent.id })
    const sibling = await startToolExecutionRun("f5-dock-sibling", { parentRunId: parent.id })
    let exited = false
    const listeners = new Set<() => void>()
    registerLiveSession({
      id: result.sessionId,
      get isExited() {
        return exited
      },
      get processExitConfirmed() {
        return exited
      },
      onExit: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as never)
    jest.mocked(runTerminalDockAction).mockResolvedValue(result as never)
    const mark = { person: { kind: "local-person" as const }, source: "F5", markedAt: 1 }
    try {
      await toolFamily.run(name, {}, { ...call, executionRunId: owner.id })
      expect(await readRunPersonalTaint({ executionRunId: sibling.id })).toMatchObject({
        verified: true,
        marks: [],
      })
      await expect(
        addPersonalMarksToRun({ executionRunId: sibling.id }, [mark])
      ).rejects.toMatchObject({ code: "personal-egress-denied" })
      exited = true
      for (const listener of listeners) listener()
      await expect(
        addPersonalMarksToRun({ executionRunId: sibling.id }, [mark])
      ).resolves.toBeUndefined()
    } finally {
      exited = true
      for (const listener of listeners) listener()
      unregisterLiveSession(result.sessionId)
      await fixture.dispose()
    }
  }
)
