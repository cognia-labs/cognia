import { reconcileWorkflowTriggerRegistrations } from "./reconcile-trigger-registrations"
import {
  getWorkflowTriggerHealth,
  resetWorkflowTriggerHealthForTest,
} from "./trigger-registration-health"
import { listWorkflows } from "@/lib/db/workflows"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { syncWorkflowTriggers, unsyncWorkflowTriggers } from "./webhook-bridge"

jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn() }))
jest.mock("@/lib/db/workflow-deployments", () => ({ resolveWorkflowDeployment: jest.fn() }))
jest.mock("./webhook-bridge", () => ({
  syncWorkflowTriggers: jest.fn(),
  unsyncWorkflowTriggers: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  resetWorkflowTriggerHealthForTest()
})

it("reconciles deployments, removes drafts, reports failures and continues to other workflows", async () => {
  const rows = ["bad", "good", "draft"].map((id) => ({
    id,
    nodes: [{ id: "t", type: "trigger.cron", data: {} }],
    published: { deploymentId: id },
  }))
  jest.mocked(listWorkflows).mockResolvedValue(rows as never)
  jest.mocked(resolveWorkflowDeployment).mockImplementation(async (id) => {
    if (id === "bad") throw new Error("snapshot missing")
    return id === "good" ? ({ workflow: rows[1] } as never) : undefined
  })
  const log = jest.fn()
  const results = await reconcileWorkflowTriggerRegistrations({ log })
  expect(results.map((result) => result.ok)).toEqual([false, true, true])
  expect(syncWorkflowTriggers).toHaveBeenCalledWith(rows[1], { signal: undefined })
  expect(unsyncWorkflowTriggers).toHaveBeenCalledWith(rows[2])
  expect(getWorkflowTriggerHealth().registrations).toContainEqual(
    expect.objectContaining({
      workflowId: "bad",
      triggerId: "t",
      status: "failed",
      error: "snapshot missing",
    })
  )
  expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("bad"))
})

it("preserves cancellation before and after an asynchronous deployment lookup", async () => {
  const controller = new AbortController()
  jest.mocked(listWorkflows).mockResolvedValue([{ id: "late", nodes: [] }] as never)
  jest.mocked(resolveWorkflowDeployment).mockImplementation(async () => {
    controller.abort()
    return { workflow: { id: "late", nodes: [] } } as never
  })
  expect(await reconcileWorkflowTriggerRegistrations({ signal: controller.signal })).toEqual([])
  expect(syncWorkflowTriggers).not.toHaveBeenCalled()
  expect(unsyncWorkflowTriggers).not.toHaveBeenCalled()
})
