/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { runHeadlessExec } from "./headless-exec"

// --- mocks ------------------------------------------------------------------

jest.mock("@/stores/settings", () => {
  const state = {
    allowUnattendedExecution: false as boolean | undefined,
    unattendedAskPolicy: undefined as "fail" | "consent" | "run" | undefined,
    sandboxed: false as boolean | undefined,
  }
  return {
    __mockTerminalSettings: state,
    useSettingsStore: {
      getState: () => ({
        settings: {
          terminal: {
            allowUnattendedExecution: state.allowUnattendedExecution,
            unattendedAskPolicy: state.unattendedAskPolicy,
            sandboxed: state.sandboxed,
          },
        },
      }),
    },
  }
})

jest.mock("@/lib/claude/permissions/command-safety", () => {
  const state = { verdict: "allow" as "allow" | "ask" | "deny" }
  return {
    __mockClassifyState: state,
    classifyCommand: () => ({ verdict: state.verdict, reason: "test reason", segments: [] }),
  }
})

jest.mock("@/lib/tauri", () => {
  // `tauri` is deliberately independent of `headless`: a browser paired to a
  // cognia-server is neither, and conflating them is what hid the bug these
  // tests cover.
  const state = { headless: false, tauri: true }
  return {
    __mockHostState: state,
    isTauri: () => state.tauri && !state.headless,
    transport: {
      call: jest.fn(async () => ({
        stdout: "server out",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      })),
    },
  }
})

let mockChain: string[] = ["tauri-channel"]
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

jest.mock("@/lib/platform/detect", () => {
  const { __mockHostState } = jest.requireMock("@/lib/tauri") as {
    __mockHostState: { headless: boolean; tauri: boolean }
  }
  return {
    isHeadlessHost: () => __mockHostState.headless,
    isTauri: () => __mockHostState.tauri && !__mockHostState.headless,
  }
})

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async () => ({ output: "ok", exitCode: 0, timedOut: false, durationMs: 12 })),
}))

jest.mock("@/lib/db/terminal-audit", () => ({
  appendUnattendedExecAudit: jest.fn(async () => undefined),
}))

jest.mock("./dock-tool-handler", () => ({
  runTerminalDockAction: jest.fn(async () => ({
    ok: true,
    sessionId: "dock-1",
    exitCode: 0,
    output: "via dock",
  })),
}))

const { __mockTerminalSettings } = jest.requireMock("@/stores/settings") as {
  __mockTerminalSettings: {
    allowUnattendedExecution: boolean | undefined
    unattendedAskPolicy: "fail" | "consent" | "run" | undefined
    sandboxed: boolean | undefined
  }
}
const { __mockClassifyState } = jest.requireMock("@/lib/claude/permissions/command-safety") as {
  __mockClassifyState: { verdict: "allow" | "ask" | "deny" }
}
const { invoke: mockInvoke } = jest.requireMock("@tauri-apps/api/core") as { invoke: jest.Mock }
const { __mockHostState, transport: mockTransport } = jest.requireMock("@/lib/tauri") as {
  __mockHostState: { headless: boolean; tauri: boolean }
  transport: { call: jest.Mock }
}
const { appendUnattendedExecAudit: mockAudit } = jest.requireMock("@/lib/db/terminal-audit") as {
  appendUnattendedExecAudit: jest.Mock
}
const { runTerminalDockAction: mockDock } = jest.requireMock("./dock-tool-handler") as {
  runTerminalDockAction: jest.Mock
}

async function flushAudit(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mockChain = ["tauri-channel"]
  __mockHostState.headless = false
  __mockHostState.tauri = true
  __mockTerminalSettings.allowUnattendedExecution = true
  __mockTerminalSettings.unattendedAskPolicy = undefined
  __mockTerminalSettings.sandboxed = false
  __mockClassifyState.verdict = "allow"
  mockInvoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "terminal_headless_spawn") return { sessionId: "one-shot", shell: "bash" }
    if (command === "terminal_headless_kill") return { status: "exited" }
    return { output: "ok", exitCode: 0, timedOut: false, durationMs: 12 }
  })
  mockTransport.call
    .mockReset()
    .mockResolvedValue({ stdout: "server out", stderr: "", exitCode: 0, timedOut: false })
  mockAudit.mockReset().mockResolvedValue(undefined)
  mockDock
    .mockReset()
    .mockResolvedValue({ ok: true, sessionId: "dock-1", exitCode: 0, output: "via dock" })
})

describe("runHeadlessExec — policy matrix", () => {
  it("fails closed when the master switch is off", async () => {
    __mockTerminalSettings.allowUnattendedExecution = false
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain("disabled")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("rejects a blank command", async () => {
    const out = await runHeadlessExec({ command: "  " })
    expect(out.ok).toBe(false)
  })

  it("runs an allow-verdict command headlessly and audits it", async () => {
    const out = await runHeadlessExec({ command: "echo hi", runId: "r1" })
    expect(out).toMatchObject({ ok: true, exitCode: 0, output: "ok", verdict: "allow" })
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_headless_exec",
      expect.objectContaining({ command: "echo hi" })
    )
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "allow", blocked: false, runId: "r1" })
    )
  })

  it("routes a headless brain command through the server execution plane", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({
      command: "printf server",
      cwd: "/data/workspace",
      env: { COGNIA_TEST: "1" },
      timeoutMs: 4_000,
    })

    expect(out).toMatchObject({
      ok: true,
      exitCode: 0,
      output: "server out",
      verdict: "allow",
    })
    expect(mockTransport.call).toHaveBeenCalledWith("terminal_exec", {
      command: "printf server",
      args: [],
      cwd: "/data/workspace",
      env: { COGNIA_TEST: "1" },
      timeoutMs: 4_000,
      shell: true,
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("fails closed instead of dropping the sandbox policy on the server", async () => {
    __mockHostState.headless = true
    __mockTerminalSettings.sandboxed = true

    const out = await runHeadlessExec({ command: "echo confined" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("sandboxed") })
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  it("fails explicitly when a custom shell cannot be preserved on the server", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({ command: "echo zsh", shell: "/bin/zsh" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("custom shells") })
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  it("rejects persistent sessions that do not exist on the server execution plane", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({ command: "echo stateful", sessionId: "server-session" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("persistent") })
    expect(mockTransport.call).not.toHaveBeenCalled()
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: expect.stringContaining("persistent") })
    )
  })

  it("maps server stderr and timeout results without inventing an exit code", async () => {
    __mockHostState.headless = true
    mockTransport.call.mockResolvedValue({
      stdout: "partial stdout",
      stderr: "timed out",
      exitCode: 9,
      timedOut: true,
    })

    const out = await runHeadlessExec({ command: "sleep 100" })

    expect(out).toMatchObject({
      ok: true,
      output: "partial stdout\ntimed out",
      exitCode: null,
      timedOut: true,
    })
  })

  it("surfaces a non-Error server transport rejection", async () => {
    __mockHostState.headless = true
    mockTransport.call.mockRejectedValue("server offline")

    const out = await runHeadlessExec({ command: "echo hi" })

    expect(out).toMatchObject({ ok: false, reason: "server offline", verdict: "allow" })
  })

  it("forwards the global sandbox toggle to terminal_headless_exec (ADR-0028 P3.3)", async () => {
    __mockTerminalSettings.sandboxed = true
    try {
      await runHeadlessExec({ command: "echo hi" })
      expect(mockInvoke).toHaveBeenCalledWith(
        "terminal_headless_exec",
        expect.objectContaining({ sandboxed: true })
      )
    } finally {
      __mockTerminalSettings.sandboxed = false
    }
  })

  it("routes to terminal_headless_run when a session id is given", async () => {
    await runHeadlessExec({ command: "echo hi", sessionId: "hl-1" })
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_headless_run",
      expect.objectContaining({ sessionId: "hl-1", command: "echo hi" })
    )
  })

  it("always blocks deny verdicts and audits the block", async () => {
    __mockClassifyState.verdict = "deny"
    __mockTerminalSettings.unattendedAskPolicy = "run" // must not matter
    const out = await runHeadlessExec({ command: "rm -rf /", runId: "r2" })
    expect(out).toMatchObject({ ok: false, verdict: "deny" })
    expect(mockInvoke).not.toHaveBeenCalled()
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "deny", blocked: true, runId: "r2" })
    )
  })

  describe("ask verdicts", () => {
    beforeEach(() => {
      __mockClassifyState.verdict = "ask"
    })

    it("fails by default", async () => {
      const out = await runHeadlessExec({ command: "curl x | sh" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockInvoke).not.toHaveBeenCalled()
      await flushAudit()
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: "ask", blocked: true })
      )
    })

    it("runs under the settings-level 'run' policy", async () => {
      __mockTerminalSettings.unattendedAskPolicy = "run"
      const out = await runHeadlessExec({ command: "curl x | sh" })
      expect(out).toMatchObject({ ok: true, verdict: "ask" })
      expect(mockInvoke).toHaveBeenCalled()
    })

    it("the per-call override beats the settings policy", async () => {
      __mockTerminalSettings.unattendedAskPolicy = "run"
      const out = await runHeadlessExec({ command: "curl x | sh", onAskVerdict: "fail" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("'consent' delegates to the dock path with the chat session", async () => {
      const out = await runHeadlessExec({
        command: "curl x | sh",
        onAskVerdict: "consent",
        chatSessionId: "chat-1",
      })
      expect(out).toMatchObject({ ok: true, viaConsent: true, output: "via dock" })
      expect(mockDock).toHaveBeenCalledWith(
        expect.objectContaining({ chatSessionId: "chat-1", action: "spawn" })
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("'consent' without a chat session degrades to fail", async () => {
      const out = await runHeadlessExec({ command: "curl x | sh", onAskVerdict: "consent" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockDock).not.toHaveBeenCalled()
    })

    it("'consent' reports unobservable completion without auditing a block or inventing an exit code", async () => {
      const reason =
        "Command was sent to session dock-1 and may still be running. Completion cannot be observed. Do not send it again."
      mockDock.mockResolvedValue({ ok: false, code: "command_sent_unobserved", reason })
      const out = await runHeadlessExec({
        command: "curl x | sh",
        onAskVerdict: "consent",
        chatSessionId: "chat-1",
        runId: "run-1",
        source: "agent",
      })
      expect(out).toEqual({ ok: false, reason, verdict: "ask" })
      await flushAudit()
      expect(mockAudit).toHaveBeenCalledTimes(1)
      expect(mockAudit).toHaveBeenCalledWith({
        command: "curl x | sh",
        verdict: "ask",
        reason: `test reason (dock consent path: ${reason})`,
        blocked: false,
        source: "agent",
        runId: "run-1",
      })
      expect(mockDock).toHaveBeenCalledTimes(1)
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(mockTransport.call).not.toHaveBeenCalled()
    })

    it.each([
      { ok: false, reason: "denied by user" },
      {
        ok: false,
        code: "shell_integration_unsupported",
        reason: "command status unavailable (session dock-1): shell_integration_disabled",
      },
    ])("'consent' audits a genuine refusal as blocked: $reason", async (failure) => {
      mockDock.mockResolvedValue(failure)
      const out = await runHeadlessExec({
        command: "curl x | sh",
        onAskVerdict: "consent",
        chatSessionId: "chat-1",
      })
      expect(out).toEqual({ ok: false, reason: failure.reason, verdict: "ask" })
      await flushAudit()
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: true, reason: expect.stringContaining(failure.reason) })
      )
      expect(mockDock).toHaveBeenCalledTimes(1)
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  it("maps a timed-out run to ok+timedOut with a null exit", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "terminal_headless_spawn") return { sessionId: "timeout-pty" }
      if (command === "terminal_headless_kill") return { status: "exited" }
      return { output: "partial", exitCode: null, timedOut: true, durationMs: 5000 }
    })
    const out = await runHeadlessExec({ command: "sleep 100" })
    expect(out).toMatchObject({ ok: true, timedOut: true, exitCode: null, output: "partial" })
  })

  it("maps an invoke rejection to a failure", async () => {
    mockInvoke.mockRejectedValue(new Error("unknown headless session"))
    const out = await runHeadlessExec({ command: "echo hi", sessionId: "ghost" })
    expect(out).toMatchObject({ ok: false, reason: "unknown headless session" })
  })

  it("never throws when auditing fails", async () => {
    mockAudit.mockRejectedValue(new Error("quota"))
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out.ok).toBe(true)
  })
})

/**
 * A workflow's terminal step used to fail outright in a browser paired to a
 * cognia-server — "requires the desktop app" — even though the routed,
 * capability-gated `terminal_exec` RPC it needed was already there. The gate
 * was `isHeadlessHost()`, which is true only *inside* the brain.
 */
describe("unattended execution on an attached host", () => {
  beforeEach(() => {
    __mockHostState.headless = false
    __mockTerminalSettings.allowUnattendedExecution = true
    __mockClassifyState.verdict = "allow"
  })

  it("runs on the paired host from a browser", async () => {
    __mockHostState.tauri = false
    mockChain = ["ws", "webrtc"]
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out).toMatchObject({ ok: true, output: "server out", exitCode: 0 })
    expect(mockTransport.call).toHaveBeenCalledWith(
      "terminal_exec",
      expect.objectContaining({ command: "echo hi", shell: true })
    )
    // Never the local PTY commands — there is no PTY in this shell.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("still uses the local PTY commands when this shell owns one", async () => {
    mockChain = ["tauri-channel"]
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out).toMatchObject({ ok: true })
    expect(mockInvoke).toHaveBeenCalled()
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  // Web standalone: no host of any kind, and the old copy pointed at the
  // desktop app as if that were the only option.
  it("refuses when no host is attached at all", async () => {
    __mockHostState.tauri = false
    mockChain = []
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out).toMatchObject({ ok: false })
    expect((out as { reason: string }).reason).toMatch(/connected host/i)
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  // The routed RPC is a one-shot capture: no session, no sandbox policy, no
  // shell selection. Refusing by name beats running under different rules than
  // the caller asked for.
  it("refuses what the remote plane cannot honour, by name", async () => {
    __mockHostState.tauri = false
    mockChain = ["ws"]
    await expect(runHeadlessExec({ command: "echo hi", sessionId: "s-1" })).resolves.toMatchObject({
      ok: false,
    })
    __mockTerminalSettings.sandboxed = true
    await expect(runHeadlessExec({ command: "echo hi" })).resolves.toMatchObject({ ok: false })
    __mockTerminalSettings.sandboxed = false
    await expect(
      runHeadlessExec({ command: "echo hi", shell: "/bin/fish" })
    ).resolves.toMatchObject({ ok: false })
    expect(mockTransport.call).not.toHaveBeenCalled()
  })
})

it("S2 refuses a marked Host producer before either headless transport", async () => {
  await expect(
    runHeadlessExec({ command: "echo private", credentialContext: { personalEgressBlocked: true } })
  ).rejects.toMatchObject({ code: "personal-egress-denied" })
  expect(mockInvoke).not.toHaveBeenCalled()
  expect(mockTransport.call).not.toHaveBeenCalled()
})

it("F5 headless consent keeps a timed-out dock PTY leased until its exit", async () => {
  const { createDbTestFixture } = await import("@/lib/db/test-fixture")
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb")
  const { default: Dexie } = await import("dexie")
  Dexie.dependencies.indexedDB = indexedDB
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  const fixture = createDbTestFixture()
  await fixture.initialize()
  const { startToolExecutionRun, LOCAL_PERSON_RUN } =
    await import("@/lib/execution/acting-authority")
  const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
  const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
  const { registerLiveSession, unregisterLiveSession } = await import("./session-registry")
  const parent = await startToolExecutionRun("f5-consent-parent", {
    localAuthorization:
      LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
  })
  const owner = await startToolExecutionRun("f5-consent-owner", { parentRunId: parent.id })
  const sibling = await startToolExecutionRun("f5-consent-sibling", { parentRunId: parent.id })
  let exited = false
  const listeners = new Set<() => void>()
  registerLiveSession({
    id: "f5-consent-pty",
    get processExitConfirmed() {
      return exited
    },
    onExit: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as never)
  __mockTerminalSettings.allowUnattendedExecution = true
  __mockClassifyState.verdict = "ask"
  mockDock.mockResolvedValueOnce({ ok: false, reason: "timeout", sessionId: "f5-consent-pty" })
  const mark = { person: { kind: "local-person" as const }, source: "F5", markedAt: 1 }
  try {
    await expect(
      runHeadlessExec({
        command: "interactive-command",
        onAskVerdict: "consent",
        chatSessionId: "f5-chat",
        credentialContext: { executionRunId: owner.id },
      })
    ).resolves.toMatchObject({ ok: false, reason: "timeout" })
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
    unregisterLiveSession("f5-consent-pty")
    await fixture.dispose()
  }
})

it.each([false, true])(
  "P6 one-shot completion releases its real run lease (failure=%s)",
  async (failure) => {
    const { indexedDB, IDBKeyRange } = await import("fake-indexeddb")
    const { default: Dexie } = await import("dexie")
    Dexie.dependencies.indexedDB = indexedDB
    Dexie.dependencies.IDBKeyRange = IDBKeyRange
    const fixture = (await import("@/lib/db/test-fixture")).createDbTestFixture()
    await fixture.initialize()
    const { startToolExecutionRun, LOCAL_PERSON_RUN } =
      await import("@/lib/execution/acting-authority")
    const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
    const owner = await startToolExecutionRun("p6-owner", {
      localAuthorization:
        LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
    })
    const child = await startToolExecutionRun("p6-child", { parentRunId: owner.id })
    let finish!: () => void
    mockInvoke.mockImplementation(async (_command: string) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      if (failure) throw new Error("command failed")
      return { output: "hello", exitCode: 0, timedOut: false, durationMs: 5 }
    })
    const running = runHeadlessExec({
      command: "echo hello",
      credentialContext: { executionRunId: owner.id },
    })
    try {
      while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
      const marking = addPersonalMarksToRun({ executionRunId: child.id }, [
        { person: { kind: "local-person" }, source: "P6", markedAt: 1 },
      ])
      finish()
      expect(await running).toMatchObject(
        failure
          ? { ok: false, reason: "command failed" }
          : { ok: true, output: "hello", exitCode: 0, durationMs: 5 }
      )
      await expect(marking).resolves.toBeUndefined()
      expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(["terminal_headless_exec"])
    } finally {
      finish?.()
      await running
      await fixture.dispose()
    }
  }
)

it.each([false, true])(
  "Q5 timeout or abnormal one-shot holds its lease until native exit proof; Q7 removed identity can still release (error=%s)",
  async (error) => {
    const { indexedDB, IDBKeyRange } = await import("fake-indexeddb")
    const { default: Dexie } = await import("dexie")
    Dexie.dependencies.indexedDB = indexedDB
    Dexie.dependencies.IDBKeyRange = IDBKeyRange
    const fixture = (await import("@/lib/db/test-fixture")).createDbTestFixture()
    await fixture.initialize()
    const { startToolExecutionRun, LOCAL_PERSON_RUN } =
      await import("@/lib/execution/acting-authority")
    const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
    const { __clearTerminalPersonalEgressForTesting } = await import("./personal-egress")
    const owner = await startToolExecutionRun("q5-owner", {
      localAuthorization:
        LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
    })
    const child = await startToolExecutionRun("q5-child", { parentRunId: owner.id })
    let exited = false
    mockInvoke.mockImplementation(async (command: string) =>
      command === "terminal_headless_kill"
        ? { status: exited ? "exited" : "stillRunning" }
        : {
            output: "partial",
            exitCode: null,
            timedOut: !error,
            durationMs: 5,
            pendingSessionId: "q5-survivor",
            ...(error ? { error: "event stream closed" } : {}),
          }
    )
    try {
      await runHeadlessExec({
        command: "echo hello",
        credentialContext: { executionRunId: owner.id },
      })
      const marks = [{ person: { kind: "local-person" as const }, source: "Q5", markedAt: 1 }]
      await expect(
        addPersonalMarksToRun({ executionRunId: child.id }, marks)
      ).rejects.toMatchObject({ code: "personal-egress-denied" })
      exited = true
      await expect(
        addPersonalMarksToRun({ executionRunId: child.id }, marks)
      ).resolves.toBeUndefined()
      // The observe-only exit-proof reconcile never signals the child.
      expect(
        mockInvoke.mock.calls.filter(
          ([command, args]) =>
            command === "terminal_headless_kill" &&
            !(args as { observeOnly?: boolean } | undefined)?.observeOnly
        )
      ).toHaveLength(2)
    } finally {
      __clearTerminalPersonalEgressForTesting()
      await fixture.dispose()
    }
  }
)
