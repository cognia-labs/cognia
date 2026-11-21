import type { VisualWorkflow } from "@/types/workflow/visual"
import { port } from "./fresh-workflows-port"

const mockLoadFresh = jest.fn()
const mockPutDerived = jest.fn(async (workflow: VisualWorkflow) => workflow)
const mockGetWorkflow = jest.fn()
jest.mock("./derived-workflow", () => ({
  loadFreshWorkflow: (...args: unknown[]) => mockLoadFresh(...args),
  defaultPlaybookWorkflowDeps: {
    getSkill: jest.fn(),
    listResources: jest.fn(),
    getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
    putDerivedWorkflow: (workflow: VisualWorkflow) => mockPutDerived(workflow),
    now: () => 0,
  },
}))

const wf = {
  id: "wf_playbook_review",
  name: "Review",
  nodes: [],
  edges: [],
} as unknown as VisualWorkflow

beforeEach(() => {
  mockLoadFresh.mockReset()
  mockPutDerived.mockClear()
  mockGetWorkflow.mockReset()
})

describe("the fresh-workflows port", () => {
  it("answers a ready read with the recompiled graph and its dormant-step count", async () => {
    mockLoadFresh.mockResolvedValue({
      status: "ready",
      workflow: wf,
      dormant: [{ nodeId: "n", skillId: "s", stepId: "x", reason: "pattern-core-pending" }],
    })
    await expect(port.read(wf.id)).resolves.toEqual({
      status: "ready",
      workflow: wf,
      dormantSteps: 1,
    })
  })

  it.each([
    [
      { status: "source-unavailable", workflow: wf, problem: { status: "missing" } },
      { status: "source-unavailable", workflow: wf },
    ],
    [{ status: "not-found" }, { status: "not-found" }],
  ])("narrows %o to the contract", async (result, expected) => {
    mockLoadFresh.mockResolvedValue(result)
    await expect(port.read(wf.id)).resolves.toEqual(expected)
  })

  it("reads from the caller's database and checks before writing a refreshed row", async () => {
    mockLoadFresh.mockResolvedValue({ status: "not-found" })
    const readWorkflow = jest.fn(async () => wf)
    const beforeWrite = jest.fn(() => {
      throw new Error("Evaluation scope changed")
    })
    await port.read(wf.id, { readWorkflow, beforeWrite })
    const deps = mockLoadFresh.mock.calls[0][1] as {
      getWorkflow: (id: string) => Promise<VisualWorkflow | undefined>
      putDerivedWorkflow: (workflow: VisualWorkflow) => Promise<VisualWorkflow>
    }
    await deps.getWorkflow(wf.id)
    expect(readWorkflow).toHaveBeenCalledWith(wf.id)
    expect(mockGetWorkflow).not.toHaveBeenCalled()
    // A scope that changed meanwhile stops the write before it happens.
    await expect(deps.putDerivedWorkflow(wf)).rejects.toThrow("Evaluation scope changed")
    expect(mockPutDerived).not.toHaveBeenCalled()
  })

  it("writes through the data layer when the caller sets no guard", async () => {
    mockLoadFresh.mockResolvedValue({ status: "not-found" })
    await port.read(wf.id)
    const deps = mockLoadFresh.mock.calls[0][1] as {
      getWorkflow: (id: string) => Promise<VisualWorkflow | undefined>
      putDerivedWorkflow: (workflow: VisualWorkflow) => Promise<VisualWorkflow>
    }
    await deps.getWorkflow(wf.id)
    expect(mockGetWorkflow).toHaveBeenCalledWith(wf.id)
    await expect(deps.putDerivedWorkflow(wf)).resolves.toBe(wf)
    expect(mockPutDerived).toHaveBeenCalledWith(wf)
  })
})
