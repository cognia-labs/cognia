/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const mockProject = jest.fn(async (_workflow: unknown) => ({ ok: true as const }))
jest.mock("./reconcile-trigger-registrations", () => ({
  projectWorkflowTriggerRegistrations: (workflow: unknown) => mockProject(workflow),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { updateWorkflowWithPublication } from "@/lib/workflow/publish/publication-lifecycle"
import { createWorkflowVersion } from "@/lib/workflow/versioning/version-snapshot"
import type { VisualWorkflow } from "@/types/workflow/visual"
import {
  isWorkflowTriggerPaused,
  pausedTriggerIdsOf,
  setWorkflowTriggerPaused,
  WorkflowTriggerPauseError,
} from "./trigger-pauses"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(() => dbFixture.initialize())
beforeEach(async () => {
  await dbFixture.restore()
  mockProject.mockClear()
})
afterAll(() => dbFixture.dispose())

function workflow(): VisualWorkflow {
  return {
    id: "wf_p",
    schemaVersion: 2,
    name: "paused",
    createdAt: 1,
    updatedAt: 10,
    nodes: [
      {
        id: "cron",
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "cron", params: { cron: "* * * * *" } },
      },
    ],
    edges: [],
    settings: {} as VisualWorkflow["settings"],
  }
}

describe("trigger pause overrides (WF-07)", () => {
  it("records a pause on the row, outside the graph, and re-projects the registrations", async () => {
    await getDb().workflows.put(workflow())
    await setWorkflowTriggerPaused("wf_p", "cron", true, 50)
    const row = (await getDb().workflows.get("wf_p"))!
    expect(row.triggerPauses).toEqual({ cron: 50 })
    expect(row.nodes[0].data.disabled).toBeUndefined()
    // Companion sync is cursored on updatedAt, so the phone sees the pause.
    expect(row.updatedAt).toBe(50)
    expect(mockProject).toHaveBeenCalledWith(
      expect.objectContaining({ triggerPauses: { cron: 50 } })
    )
    expect(isWorkflowTriggerPaused(row, "cron")).toBe(true)
    expect([...pausedTriggerIdsOf(row)]).toEqual(["cron"])
  })

  it("keeps the original pause time when paused twice and clears the field on resume", async () => {
    await getDb().workflows.put(workflow())
    await setWorkflowTriggerPaused("wf_p", "cron", true, 50)
    await setWorkflowTriggerPaused("wf_p", "cron", true, 70)
    expect((await getDb().workflows.get("wf_p"))!.triggerPauses).toEqual({ cron: 50 })
    await setWorkflowTriggerPaused("wf_p", "cron", false, 90)
    const row = (await getDb().workflows.get("wf_p"))!
    expect("triggerPauses" in row).toBe(false)
    expect(isWorkflowTriggerPaused(row, "cron")).toBe(false)
  })

  it("refuses a workflow that does not exist", async () => {
    await expect(setWorkflowTriggerPaused("wf_missing", "cron", true)).rejects.toBeInstanceOf(
      WorkflowTriggerPauseError
    )
    expect(mockProject).not.toHaveBeenCalled()
  })

  it("survives an editor save made from a snapshot loaded before the pause", async () => {
    await getDb().workflows.put(workflow())
    const staleEditorSnapshot = workflow()
    await setWorkflowTriggerPaused("wf_p", "cron", true, 50)
    await updateWorkflowWithPublication("wf_p", { ...staleEditorSnapshot, name: "renamed" }, 60)
    const row = (await getDb().workflows.get("wf_p"))!
    expect(row.name).toBe("renamed")
    expect(row.triggerPauses).toEqual({ cron: 50 })
  })

  it("never becomes part of an immutable version", () => {
    const version = createWorkflowVersion({
      workflow: { ...workflow(), triggerPauses: { cron: 50 } },
      workflowInterface: {} as never,
      accountId: "acct",
      sequence: 1,
      createdAt: 1,
    })
    const unpaused = createWorkflowVersion({
      workflow: workflow(),
      workflowInterface: {} as never,
      accountId: "acct",
      sequence: 1,
      createdAt: 1,
    })
    expect("triggerPauses" in version.definition).toBe(false)
    expect(version.digest).toBe(unpaused.digest)
  })
})
