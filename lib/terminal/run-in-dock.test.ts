/**
 * @jest-environment jsdom
 */

// jest.mock factories are hoisted, so the broker singleton must be
// instantiated lazily inside the factory rather than captured from the
// outer scope (which would still be `undefined` at hoist time).
jest.mock("@/lib/plugin/security/consent-broker", () => {
  const actual = jest.requireActual("@/lib/plugin/security/consent-broker")
  let cached: import("@/lib/plugin/security/consent-broker").PluginConsentBroker | null = null
  return {
    ...actual,
    getPluginConsentBroker: () => {
      if (!cached) cached = new actual.PluginConsentBroker()
      return cached
    },
    __getTestBroker: () => cached,
    __setTestBroker: (b: unknown) => {
      cached = b as never
    },
  }
})

// Mock spawn-orchestrator so we can test newTab path without invoking
// Tauri spawn.
jest.mock("./spawn-orchestrator", () => ({
  spawnFromDock: jest.fn(async () => ({
    kind: "spawned" as const,
    sessionId: "spawned-1",
    shell: "/bin/bash",
  })),
}))

// What the Host reported about itself; `null` on the desktop's own PTY.
const mockEnsureHostCapabilities = jest.fn(async (): Promise<unknown> => null)
jest.mock("./host-capabilities", () => ({
  ...jest.requireActual("./host-capabilities"),
  ensureHostCapabilities: () => mockEnsureHostCapabilities(),
}))

import {
  getPluginConsentBroker,
  resetPluginConsentBroker,
} from "@/lib/plugin/security/consent-broker"
import { runInDockTab, runInTerminalDock } from "./run-in-dock"
import { spawnFromDock } from "./spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { __clearLiveSessionsForTesting, registerLiveSession } from "./session-registry"
import { agentTrustPluginId } from "./agent-trust"
import type { SessionInfo } from "./types"

function broker() {
  return getPluginConsentBroker()
}
/**
 * Grant trust through the broker's public flow — a request answered with
 * "allow for this session" — rather than seeding its private grant set, whose
 * key format (now scope-qualified) is the broker's business.
 */
async function grantTrust(chatId: string, tabId: string) {
  const request = broker().request({
    pluginId: agentTrustPluginId(chatId, tabId),
    permission: "terminal:write",
  })
  const pending = (broker() as unknown as { pending: Map<string, unknown> }).pending
  for (const id of [...pending.keys()]) broker().respond(id, { allow: true, persist: true })
  await expect(request).resolves.toBe(true)
}

function makeFakeSession(sid: string) {
  const integrationListeners: Array<(event: unknown) => void> = []
  const taps: Array<(bytes: Uint8Array) => void> = []
  const infoListeners: Array<(info: SessionInfo) => void> = []
  return {
    id: sid,
    info: {
      id: sid,
      projectId: null,
      extensionId: null,
      origin: "local" as const,
      shell: "/bin/bash",
    } as SessionInfo,
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
    onData: jest.fn(() => () => undefined),
    tapData: jest.fn((cb: (bytes: Uint8Array) => void) => {
      taps.push(cb)
      return () => {
        const idx = taps.indexOf(cb)
        if (idx >= 0) taps.splice(idx, 1)
      }
    }),
    onIntegration: jest.fn((cb: (event: unknown) => void) => {
      integrationListeners.push(cb)
      return () => {
        const idx = integrationListeners.indexOf(cb)
        if (idx >= 0) integrationListeners.splice(idx, 1)
      }
    }),
    onExit: jest.fn(() => () => undefined),
    onInfo: jest.fn((cb: (info: SessionInfo) => void) => {
      infoListeners.push(cb)
      return () => {
        const idx = infoListeners.indexOf(cb)
        if (idx >= 0) infoListeners.splice(idx, 1)
      }
    }),
    _fireInfo: (info: SessionInfo) => {
      for (const l of infoListeners.slice()) l(info)
    },
    _fireIntegration: (event: unknown) => {
      for (const l of integrationListeners.slice()) l(event)
    },
    _emit: (text: string) => {
      const bytes = new TextEncoder().encode(text)
      for (const l of taps.slice()) l(bytes)
    },
    isExited: false,
    lastExitCode: null,
  }
}

beforeEach(() => {
  resetPluginConsentBroker()
  broker().clearAllSessionGrants()
  broker().rejectAllPending()
  __clearLiveSessionsForTesting()
  useTerminalStore.getState().reset()
})

describe("runInDockTab", () => {
  it.each([null, "shell_integration_ready_timeout"])(
    "sends without waiting when command end is optional and integration is unsupported (%s)",
    async (reason) => {
      const fake = makeFakeSession("s-1")
      fake.info.integrationCapabilities = {
        osc633: false,
        commandStatus: reason !== null,
        cwdTracking: false,
        degradedReason: reason,
      }
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      await grantTrust("c", "s-1")
      await expect(
        runInDockTab({
          chatSessionId: "c",
          tabId: "s-1",
          command: "ls",
          requireCommandEnd: false,
          timeoutMs: 10,
        })
      ).resolves.toEqual({ kind: "sent", sessionId: "s-1", reason })
      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(fake.write).toHaveBeenCalledWith("ls\r")
      expect(fake.onIntegration).not.toHaveBeenCalled()
      expect(fake.tapData).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, true, false])(
    "reports an already-sent command when integration degrades (requireCommandEnd=%s)",
    async (requireCommandEnd) => {
      const fake = makeFakeSession("s-1")
      fake.info.integrationCapabilities = {
        osc633: true,
        commandStatus: true,
        cwdTracking: true,
        degradedReason: null,
      }
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      await grantTrust("c", "s-1")
      const pending = runInDockTab({
        chatSessionId: "c",
        tabId: "s-1",
        command: "ls",
        requireCommandEnd,
        timeoutMs: 1000,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      fake.info.integrationCapabilities = {
        osc633: false,
        commandStatus: false,
        cwdTracking: false,
        degradedReason: "shell_integration_ready_timeout",
      }
      fake._fireInfo(fake.info)
      await expect(pending).resolves.toEqual({
        kind: "sent",
        sessionId: "s-1",
        reason: "shell_integration_ready_timeout",
      })
      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(fake.write).toHaveBeenCalledWith("ls\r")
    }
  )

  it("reports sent when a freshly spawned tab degrades after the command was written", async () => {
    const fake = makeFakeSession("spawned-1")
    fake.info.integrationCapabilities = {
      osc633: true,
      commandStatus: true,
      cwdTracking: true,
      degradedReason: null,
    }
    ;(spawnFromDock as jest.Mock).mockImplementationOnce(async () => {
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      return { kind: "spawned", sessionId: "spawned-1", shell: "/bin/bash" }
    })
    await grantTrust("c", "spawned-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      newTab: { req: { shell: "/bin/bash", rows: 24, cols: 80 } },
      command: "echo once",
      timeoutMs: 1000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.info.integrationCapabilities = {
      osc633: false,
      commandStatus: false,
      cwdTracking: false,
      degradedReason: "shell_integration_ready_timeout",
    }
    fake._fireInfo(fake.info)
    await expect(pending).resolves.toEqual({
      kind: "sent",
      sessionId: "spawned-1",
      reason: "shell_integration_ready_timeout",
    })
    expect(fake.write).toHaveBeenCalledTimes(1)
    expect(fake.write).toHaveBeenCalledWith("echo once\r")
  })

  it("reports a failed optional write instead of claiming the command was sent", async () => {
    const fake = makeFakeSession("s-1")
    fake.info.integrationCapabilities = {
      osc633: false,
      commandStatus: false,
      cwdTracking: false,
      degradedReason: null,
    }
    fake.write.mockRejectedValueOnce(new Error("session no longer controlled"))
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    await grantTrust("c", "s-1")
    await expect(
      runInDockTab({ chatSessionId: "c", tabId: "s-1", command: "ls", requireCommandEnd: false })
    ).resolves.toEqual({ kind: "error", message: "session no longer controlled" })
  })

  it.each([null, "shell_integration_setup_failed:script_missing"])(
    "refuses without writing when integration is unavailable (%s)",
    async (reason) => {
      const fake = makeFakeSession("s-1")
      fake.info.integrationCapabilities = {
        osc633: false,
        commandStatus: false,
        cwdTracking: false,
        degradedReason: reason,
      }
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      await grantTrust("c", "s-1")
      await expect(
        runInDockTab({ chatSessionId: "c", tabId: "s-1", command: "ls", timeoutMs: 10 })
      ).resolves.toEqual({ kind: "unsupported", sessionId: "s-1", reason })
      expect(fake.write).not.toHaveBeenCalled()
    }
  )

  it("returns denied when the user rejects consent", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    const pending = runInDockTab({ chatSessionId: "c", tabId: "s-1", command: "ls" })
    // The broker emits a request — find the latest by counting pending.
    // Drive a reject via the broker singleton's pending map.
    // Since we don't have a handle to the requestId, we use the broker's
    // emit override pattern by listening on window. Simpler: simulate
    // the auto-reject by overriding the broker's emit + capturing the
    // requestId. Cleanest path: respond with allow=false to all pending.
    await Promise.resolve()
    const internal = broker() as unknown as {
      pending: Map<string, { resolve: (v: boolean) => void }>
    }
    for (const [id] of internal.pending) broker().respond(id, { allow: false, persist: false })
    await expect(pending).resolves.toEqual({ kind: "denied" })
  })

  it.each([undefined, true, false])(
    "returns the exit code and output with supported integration (requireCommandEnd=%s)",
    async (requireCommandEnd) => {
      const fake = makeFakeSession("s-1")
      fake.info.integrationCapabilities = {
        osc633: true,
        commandStatus: true,
        cwdTracking: true,
        degradedReason: null,
      }
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      // Pre-grant trust so the consent emit short-circuits.
      await grantTrust("c", "s-1")
      const pending = runInDockTab({
        chatSessionId: "c",
        tabId: "s-1",
        command: "echo hello",
        timeoutMs: 1000,
        requireCommandEnd,
      })
      // Allow microtasks to run so the session.write call is queued + listeners attach.
      await new Promise((r) => setTimeout(r, 0))
      expect(fake.write).toHaveBeenCalledWith("echo hello\r")
      // The PTY echoes the line, then the pre-exec marker, the output, and — after
      // the integration event for it — the chunk carrying the end marker.
      fake._emit("$ echo hello\r\n\u001b]633;C;nonce\u0007hello\r\n")
      fake._fireIntegration({ kind: "command_end", exit_code: 0 })
      fake._emit("\u001b]633;D;nonce;0\u0007$ ")
      const result = await pending
      // The command line is NOT the output: it used to be returned in its place.
      expect(result).toEqual({
        kind: "ok",
        sessionId: "s-1",
        exitCode: 0,
        output: "hello",
        outputTruncated: false,
      })
    }
  )

  /**
   * Regression: the store snapshot was taken before the spawn, so the freshly
   * spawned tab was never in it and every spawn-with-command returned
   * `unknown session` — after leaving the new tab open, and before consent or
   * any write.
   */
  it("runs in a freshly spawned tab", async () => {
    const fake = makeFakeSession("spawned-1")
    ;(spawnFromDock as jest.Mock).mockImplementationOnce(async () => {
      registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
      useTerminalStore.getState().registerSession(fake.info)
      return { kind: "spawned", sessionId: "spawned-1", shell: "/bin/bash" }
    })
    await grantTrust("c", "spawned-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      newTab: { req: { shell: "/bin/bash", rows: 24, cols: 80 } },
      command: "pwd",
      timeoutMs: 1000,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.write).toHaveBeenCalledWith("pwd\r")
    fake._emit("\u001b]633;C;n\u0007/work\r\n")
    fake._fireIntegration({ kind: "command_end", exit_code: 0 })
    fake._emit("\u001b]633;D;n;0\u0007")
    await expect(pending).resolves.toMatchObject({
      kind: "ok",
      sessionId: "spawned-1",
      exitCode: 0,
      output: "/work",
    })
    expect(useTerminalStore.getState().sessions["spawned-1"]?.agentTrusted).toBe(true)
  })

  it("returns timeout when command_end never fires", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    // Pre-grant trust to skip prompt.
    await grantTrust("c", "s-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      tabId: "s-1",
      command: "sleep 9999",
      timeoutMs: 25,
    })
    const result = await pending
    expect(result.kind).toBe("timeout")
    if (result.kind === "timeout") expect(result.sessionId).toBe("s-1")
  })

  it("returns error when the tab id is unknown", async () => {
    const result = await runInDockTab({ chatSessionId: "c", tabId: "ghost", command: "ls" })
    expect(result.kind).toBe("error")
  })

  it("flips agentTrusted on the store row when grant is honored", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    await grantTrust("c", "s-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      tabId: "s-1",
      command: "ls",
      timeoutMs: 100,
    })
    await new Promise((r) => setTimeout(r, 0))
    fake._fireIntegration({ kind: "command_end", exit_code: 0 })
    await pending
    expect(useTerminalStore.getState().sessions["s-1"]?.agentTrusted).toBe(true)
  })
})

describe("runInTerminalDock", () => {
  it("spawns a fresh tab, reveals + focuses the dock, and pipes the command", async () => {
    const fake = makeFakeSession("spawned-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    await runInTerminalDock("ssh example.com", "/work", "chat-1")
    const store = useTerminalStore.getState()
    expect(store.panelOpen).toBe(true)
    expect(store.getActiveSession(null)).toBe("spawned-1")
    // Carriage return submits the command in the shell (no command_end wait).
    expect(fake.write).toHaveBeenCalledWith("ssh example.com\r")
  })

  it("spawns the Host's default shell when nothing more specific is set", async () => {
    mockEnsureHostCapabilities.mockResolvedValueOnce({
      platform: "windows",
      defaultShell: "pwsh.exe",
      availableShells: [],
    })
    const fake = makeFakeSession("spawned-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    ;(spawnFromDock as jest.Mock).mockClear()
    await runInTerminalDock("ssh h", "/w", "c")
    expect((spawnFromDock as jest.Mock).mock.calls[0][0].req.shell).toBe("pwsh.exe")
  })

  it("throws when the spawn is denied", async () => {
    ;(spawnFromDock as jest.Mock).mockResolvedValueOnce({ kind: "denied" })
    await expect(runInTerminalDock("ssh h", "/w", "c")).rejects.toThrow(/denied/)
  })

  it("throws with the message when the spawn errors", async () => {
    ;(spawnFromDock as jest.Mock).mockResolvedValueOnce({ kind: "error", message: "no backend" })
    await expect(runInTerminalDock("ssh h", "/w", "c")).rejects.toThrow(/no backend/)
  })

  it("falls back to the active project's cwd + id when none is passed", async () => {
    const fake = makeFakeSession("spawned-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useProjectStore.setState({
      projects: [{ id: "p1", rootDir: "/proj/root" }],
      activeProjectId: "p1",
    } as never)
    ;(spawnFromDock as jest.Mock).mockClear()
    try {
      await runInTerminalDock("ssh h", "   ", "chat-1")
      const req = (spawnFromDock as jest.Mock).mock.calls[0][0].req
      expect(req.cwd).toBe("/proj/root")
      expect(req.projectId).toBe("p1")
      expect(fake.write).toHaveBeenCalledWith("ssh h\r")
    } finally {
      useProjectStore.setState({ projects: [], activeProjectId: null } as never)
    }
  })

  it("layers option env over the project env and titles the tab", async () => {
    const fake = makeFakeSession("spawned-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useProjectStore.setState({
      projects: [{ id: "p1", rootDir: "/proj", terminalConfig: { env: { A: "1", B: "1" } } }],
      activeProjectId: "p1",
    } as never)
    ;(spawnFromDock as jest.Mock).mockClear()
    try {
      await runInTerminalDock("pnpm dev", "/proj", "chat-1", { env: { B: "2" }, title: "web" })
      const input = (spawnFromDock as jest.Mock).mock.calls[0][0]
      expect(input.req.env).toEqual({ A: "1", B: "2" })
      expect(input.title).toBe("web")
    } finally {
      useProjectStore.setState({ projects: [], activeProjectId: null } as never)
    }
  })

  it("tolerates a spawned session that is not live (reveals, no write)", async () => {
    // No registerLiveSession → getLiveSession returns null; must not throw.
    ;(spawnFromDock as jest.Mock).mockResolvedValueOnce({
      kind: "spawned",
      sessionId: "ghost-1",
      shell: "/bin/bash",
    })
    await expect(runInTerminalDock("ssh h", "/w", "c")).resolves.toBeUndefined()
    expect(useTerminalStore.getState().panelOpen).toBe(true)
  })
})

it("F5 runInDock binds the live session before command timeout and retains it until Host exit", async () => {
  const { createDbTestFixture } = await import("@/lib/db/test-fixture")
  const fixture = createDbTestFixture()
  await fixture.initialize()
  const { startToolExecutionRun, LOCAL_PERSON_RUN } =
    await import("@/lib/execution/acting-authority")
  const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
  const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
  const parent = await startToolExecutionRun("f5-run-dock", {
    localAuthorization:
      LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
  })
  const child = await startToolExecutionRun("f5-run-dock-child", { parentRunId: parent.id })
  const fake = makeFakeSession("f5-run-dock-session")
  let exited = false
  Object.defineProperty(fake, "processExitConfirmed", { get: () => exited })
  registerLiveSession(fake as never)
  useTerminalStore.getState().registerSession(fake.info)
  await grantTrust("f5-chat", fake.id)
  const mark = { person: { kind: "local-person" as const }, source: "F5", markedAt: 1 }
  try {
    await expect(
      runInDockTab({
        chatSessionId: "f5-chat",
        tabId: fake.id,
        command: "sleep 100",
        timeoutMs: 1,
        credentialContext: { executionRunId: parent.id },
      })
    ).resolves.toEqual({ kind: "timeout", sessionId: fake.id })
    expect(await readRunPersonalTaint({ executionRunId: child.id })).toMatchObject({
      verified: true,
      marks: [],
    })
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    exited = true
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [mark])
    ).resolves.toBeUndefined()
  } finally {
    exited = true
    await fixture.dispose()
  }
})
