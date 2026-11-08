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

const mockInvoke = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
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
  mockInvoke.mockReset().mockResolvedValue(undefined)
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
    expect(listRunSessions("run-x")).toEqual([])
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
