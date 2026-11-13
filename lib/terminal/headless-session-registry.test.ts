import {
  __clearRunSessionsForTesting,
  abandonRunSessionOpen,
  beginRunSessionOpen,
  closeRunSessions,
  finishRunSessionOpen,
  deregisterRunSession,
  listRunSessions,
  registerRunSession,
} from "./headless-session-registry"

const mockInvoke = jest.fn<Promise<unknown>, unknown[]>(async () => ({ status: "exited" }))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) =>
    (args[1] as { observeOnly?: boolean } | undefined)?.observeOnly
      ? Promise.resolve({ status: "unknown" })
      : mockInvoke(...args),
}))

const mockKillFromDock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./spawn-orchestrator", () => ({
  killFromDock: (...args: unknown[]) => mockKillFromDock(...args),
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ kind: "store-stub" }) },
}))

beforeEach(() => {
  __clearRunSessionsForTesting()
  mockInvoke.mockReset().mockResolvedValue({ status: "exited" })
  mockKillFromDock.mockReset().mockResolvedValue(undefined)
})

describe("headless session registry", () => {
  it("registers and lists sessions per run, deduped", () => {
    registerRunSession("run-1", "s-a", "headless")
    registerRunSession("run-1", "s-b", "dock")
    registerRunSession("run-1", "s-a", "headless") // duplicate
    registerRunSession("run-2", "s-c", "headless")
    expect(listRunSessions("run-1").map((e) => e.sessionId)).toEqual(["s-a", "s-b"])
    expect(listRunSessions("run-2")).toHaveLength(1)
    expect(listRunSessions("unknown")).toEqual([])
  })

  it("deregisters a single session", () => {
    registerRunSession("run-1", "s-a", "headless")
    registerRunSession("run-1", "s-b", "dock")
    deregisterRunSession("run-1", "s-a")
    expect(listRunSessions("run-1").map((e) => e.sessionId)).toEqual(["s-b"])
    // Unknown ids are a no-op.
    deregisterRunSession("run-1", "ghost")
    deregisterRunSession("ghost-run", "s-b")
  })

  it("closes headless sessions via the Tauri kill command", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    await closeRunSessions("run-1")
    expect(mockInvoke).toHaveBeenCalledWith("terminal_headless_kill", { sessionId: "hl-1" })
    expect(listRunSessions("run-1")).toEqual([])
  })

  it("closes dock sessions via killFromDock with the live store", async () => {
    registerRunSession("run-1", "tab-1", "dock")
    await closeRunSessions("run-1")
    expect(mockKillFromDock).toHaveBeenCalledWith("tab-1", { kind: "store-stub" })
  })

  it("isolates close failures so the rest still close", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("backend gone"))
    registerRunSession("run-1", "hl-1", "headless")
    registerRunSession("run-1", "hl-2", "headless")
    await expect(closeRunSessions("run-1")).resolves.toBeUndefined()
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("is idempotent for unknown runs and double closes", async () => {
    await expect(closeRunSessions("never-registered")).resolves.toBeUndefined()
    registerRunSession("run-1", "hl-1", "headless")
    await closeRunSessions("run-1")
    mockInvoke.mockClear()
    await closeRunSessions("run-1")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  /**
   * The run's cleanup can finish while an open is still awaiting its spawn. A
   * late success must not land in a run that has already released everything.
   */
  it("refuses a late registration into a run released mid-open", async () => {
    const open = beginRunSessionOpen("run-x")
    await closeRunSessions("run-x")
    expect(finishRunSessionOpen(open, "late-1", "headless")).toBe(false)
    expect(listRunSessions("run-x")).toEqual([{ sessionId: "late-1", mode: "headless" }])
  })

  it("registers an open that finished before any release", async () => {
    const open = beginRunSessionOpen("run-y")
    expect(finishRunSessionOpen(open, "s-1", "dock")).toBe(true)
    expect(listRunSessions("run-y")).toEqual([{ sessionId: "s-1", mode: "dock" }])
    await closeRunSessions("run-y")
    expect(mockKillFromDock).toHaveBeenCalledWith("s-1", { kind: "store-stub" })
  })

  /**
   * A run waiting for input releases its resources and resumes under the same
   * id. Only opens pending at the release are refused, not the run forever.
   */
  it("lets a resumed run open sessions again after a release", async () => {
    await closeRunSessions("run-z")
    const open = beginRunSessionOpen("run-z")
    expect(finishRunSessionOpen(open, "s-2", "headless")).toBe(true)
    expect(listRunSessions("run-z")).toEqual([{ sessionId: "s-2", mode: "headless" }])
  })

  it("forgets an abandoned open", async () => {
    const open = beginRunSessionOpen("run-a")
    abandonRunSessionOpen(open)
    abandonRunSessionOpen(open)
    await closeRunSessions("run-a")
    expect(open.released).toBe(false)
  })
})

it("F5 persistent headless lease survives a failed close until Host child-wait proves exit", async () => {
  const fixture = (await import("@/lib/db/test-fixture")).createDbTestFixture()
  await fixture.initialize()
  const { startToolExecutionRun, LOCAL_PERSON_RUN } =
    await import("@/lib/execution/acting-authority")
  const { addPersonalMarksToRun } = await import("@/lib/execution/personal-marks")
  const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
  const { closeRunSession } = await import("./headless-session-registry")
  const owner = await startToolExecutionRun("headless-lease-owner", {
    localAuthorization:
      LOCAL_PERSON_RUN as import("@/lib/execution/acting-authority").LocalPersonRun,
  })
  const child = await startToolExecutionRun("headless-lease-child", { parentRunId: owner.id })
  const mark = { person: { kind: "local-person" as const }, source: "F5", markedAt: 1 }
  mockInvoke.mockResolvedValue({ status: "stillRunning" })
  registerRunSession("workflow", "f5-headless", "headless", { executionRunId: owner.id })
  try {
    expect(await readRunPersonalTaint({ executionRunId: child.id })).toMatchObject({
      verified: true,
      marks: [],
    })
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    mockInvoke.mockRejectedValueOnce(new Error("Host unavailable"))
    await expect(closeRunSession("f5-headless", "headless")).rejects.toThrow("Host unavailable")
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    for (const proof of [undefined, { status: "unknown" }, { status: "stillRunning" }]) {
      mockInvoke.mockResolvedValueOnce(proof)
      await expect(closeRunSession("f5-headless", "headless")).resolves.toBeUndefined()
      await expect(
        addPersonalMarksToRun({ executionRunId: child.id }, [mark])
      ).rejects.toMatchObject({ code: "personal-egress-denied" })
    }
    await closeRunSessions("workflow")
    expect(listRunSessions("workflow")).toEqual([])
    mockInvoke.mockResolvedValue({ status: "exited" })
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [mark])
    ).resolves.toBeUndefined()
    expect(listRunSessions("workflow")).toEqual([])
  } finally {
    mockInvoke.mockResolvedValue({ status: "exited" })
    await closeRunSession("f5-headless", "headless")
    await fixture.dispose()
  }
})
