import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { readFreshWorkflow } from "./fresh-workflow"

const mockGetWorkflow = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
}))

const row = (over: Partial<VisualWorkflow> = {}) =>
  ({ id: "wf1", name: "Report", nodes: [], edges: [], ...over }) as VisualWorkflow
const derived = row({
  id: "wf_playbook_review",
  readOnly: true,
  derivedFrom: {
    kind: "playbook",
    skillId: "review",
    contentHash: "h",
    compilerVersion: 1,
    compiledAt: 0,
  },
})

afterEach(() => {
  __resetPortsForTesting()
  mockGetWorkflow.mockReset()
})

describe("readFreshWorkflow", () => {
  it("reads through the fresh-workflows provider, passing the caller's options", async () => {
    const read = jest.fn(async () => ({
      status: "ready" as const,
      workflow: row({ name: "Recompiled" }),
      dormantSteps: 0,
    }))
    __setPortForTesting("fresh-workflows", { read })
    const options = { readWorkflow: jest.fn(), beforeWrite: jest.fn() }
    await expect(readFreshWorkflow("wf1", options)).resolves.toMatchObject({
      status: "ready",
      workflow: { name: "Recompiled" },
    })
    expect(read).toHaveBeenCalledWith("wf1", options)
    expect(mockGetWorkflow).not.toHaveBeenCalled()
  })

  describe("with no provider", () => {
    beforeEach(() => __setPortForTesting("fresh-workflows", null))

    it("returns an ordinary row as stored", async () => {
      mockGetWorkflow.mockResolvedValue(row())
      await expect(readFreshWorkflow("wf1")).resolves.toEqual({
        status: "ready",
        workflow: row(),
        dormantSteps: 0,
      })
    })

    it("refuses a playbook-derived row it cannot check against its playbook", async () => {
      mockGetWorkflow.mockResolvedValue(derived)
      await expect(readFreshWorkflow(derived.id)).resolves.toEqual({
        status: "source-unavailable",
        workflow: derived,
      })
    })

    it("reports a missing row, reading from the caller's scoped database", async () => {
      const readWorkflow = jest.fn(async () => undefined)
      await expect(readFreshWorkflow("ghost", { readWorkflow })).resolves.toEqual({
        status: "not-found",
      })
      expect(readWorkflow).toHaveBeenCalledWith("ghost")
      expect(mockGetWorkflow).not.toHaveBeenCalled()
    })
  })
})
