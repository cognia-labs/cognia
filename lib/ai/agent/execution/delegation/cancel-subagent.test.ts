const requestCancel = jest.fn(async (..._a: unknown[]) => true)
const cancelBackground = jest.fn(async (..._a: unknown[]) => true)
const hasBackground = jest.fn((_id: string) => false)
const setStatus = jest.fn()
const registeredStops = new Set<string>()
const stopRunTree = jest.fn(async (_runId: string) => ({ stopped: true, descendantsStopped: 0 }))
const cancelAgent = jest.fn((_id: string) => false)

jest.mock("./subagent-cancel-registry", () => ({
  requestCancelSubagentRunAndWait: (...a: unknown[]) => requestCancel(...a),
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  hasRendererBackgroundRun: (id: string) => hasBackground(id),
  cancelRendererBackgroundRunAndWait: (...a: unknown[]) => cancelBackground(...a),
}))
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: { getState: () => ({ setStatus }) },
}))
jest.mock("@/lib/execution/launch-child-run", () => ({
  childJobExecutionRunId: (id: string) => `execution:job:${id}`,
}))
jest.mock("@/lib/execution/run-stops", () => ({
  hasRunStop: (runId: string) => registeredStops.has(runId),
}))
jest.mock("@/lib/execution/run-control", () => ({
  stopRunTree: (runId: string) => stopRunTree(runId),
}))
jest.mock("@/lib/ai/agent/background-agent-manager", () => ({
  getBackgroundAgentManager: () => ({ cancelAgent: (id: string) => cancelAgent(id) }),
}))

import { cancelChildRun, cancelSubagentRun } from "./cancel-subagent"

beforeEach(() => {
  requestCancel.mockClear()
  requestCancel.mockResolvedValue(true)
  cancelBackground.mockClear()
  hasBackground.mockReset()
  hasBackground.mockReturnValue(false)
  setStatus.mockClear()
  registeredStops.clear()
  stopRunTree.mockClear()
  stopRunTree.mockResolvedValue({ stopped: true, descendantsStopped: 0 })
  cancelAgent.mockReset()
  cancelAgent.mockReturnValue(false)
})

describe("cancelChildRun", () => {
  it("stops a launched child through the tree stop, and nothing else", async () => {
    registeredStops.add("execution:job:r1")
    expect(await cancelChildRun("r1")).toBe(true)
    expect(stopRunTree).toHaveBeenCalledWith("execution:job:r1")
    expect(requestCancel).not.toHaveBeenCalled()
    expect(cancelBackground).not.toHaveBeenCalled()
    expect(cancelAgent).not.toHaveBeenCalled()
  })

  it("answers false when the tree stop could not stop the root", async () => {
    registeredStops.add("execution:job:r1")
    stopRunTree.mockResolvedValueOnce({ stopped: false, descendantsStopped: 1 } as never)
    expect(await cancelChildRun("r1")).toBe(false)
  })

  it("cancels a dispatch that has not launched yet through its cancel registry", async () => {
    expect(await cancelChildRun("r2", { reason: "why" })).toBe(true)
    expect(requestCancel).toHaveBeenCalledWith("r2", "why")
    expect(stopRunTree).not.toHaveBeenCalled()
  })

  it("uses the background control exactly once for a detached run", async () => {
    hasBackground.mockReturnValue(true)
    cancelBackground.mockResolvedValueOnce(false)
    expect(await cancelChildRun("r3")).toBe(false)
    expect(cancelBackground).toHaveBeenCalledTimes(1)
    expect(requestCancel).not.toHaveBeenCalled()
  })

  it("falls back to the background-agent manager for an agent with no stop yet", async () => {
    requestCancel.mockResolvedValueOnce(false)
    cancelAgent.mockReturnValueOnce(true)
    expect(await cancelChildRun("bg_1")).toBe(true)
    expect(cancelAgent).toHaveBeenCalledWith("bg_1")
  })
})

describe("cancelSubagentRun", () => {
  it("requests cancel and marks the node cancelled (foreground)", async () => {
    expect(await cancelSubagentRun("r1")).toBe(true)
    expect(requestCancel).toHaveBeenCalledWith("r1", undefined)
    expect(cancelBackground).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith("r1", "cancelled")
  })

  it("uses the existing background control exactly once when backgrounded", async () => {
    await cancelSubagentRun("r2", { backgrounded: true })
    expect(requestCancel).not.toHaveBeenCalled()
    expect(cancelBackground).toHaveBeenCalledWith("r2")
    expect(setStatus).toHaveBeenCalledWith("r2", "cancelled")
  })

  it("marks a launched child cancelled once the tree stop reached it", async () => {
    registeredStops.add("execution:job:r4")
    expect(await cancelSubagentRun("r4")).toBe(true)
    expect(setStatus).toHaveBeenCalledWith("r4", "cancelled")
  })

  it("does not mark a run cancelled until the persistence receipt resolves", async () => {
    let resolve!: (value: boolean) => void
    cancelBackground.mockReturnValueOnce(
      new Promise<boolean>((done) => {
        resolve = done
      })
    )
    const result = cancelSubagentRun("r3", { backgrounded: true })
    expect(setStatus).not.toHaveBeenCalled()
    resolve(false)
    await expect(result).resolves.toBe(false)
    expect(setStatus).not.toHaveBeenCalled()
  })
})
