/** @jest-environment jsdom */

/**
 * The runner against the real bus and the real database: an issue written
 * inside a caller's transaction reaches the workflow only after it commits,
 * and the runner's own `getIssue` then reads the committed row (plan
 * 2026-11-05 §5).
 */

const dispatchTrigger = jest.fn().mockResolvedValue(undefined)
jest.mock("./trigger-bridge", () => ({
  dispatchTrigger: (args: unknown) => dispatchTrigger(args),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import type { WorkflowRow } from "@/types/workflow/visual"
import { disposeIssueEventTrigger, initIssueEventTrigger } from "./issue-event-trigger"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const

function workflow(id: string): WorkflowRow {
  return {
    id,
    nodes: [
      { id: `${id}-n1`, type: "trigger.issue.event", data: { params: { kinds: ["created"] } } },
    ],
  } as unknown as WorkflowRow
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

beforeEach(async () => {
  dispatchTrigger.mockClear()
  initIssueEventTrigger()
  // The runner subscribes the bus through a dynamic import.
  await settle()
  _seedTriggerSubscriptionsForTest([workflow("wf1")])
})

afterEach(() => disposeIssueEventTrigger())

it("reads the issue a committed transaction created", async () => {
  const db = getDb()
  await db.transaction(
    "rw",
    [db.issues, db.issueEvents, db.issueCounters, db.issueProjects],
    async () => {
      const container = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
      await createIssue({
        projectId: "w1",
        issueProjectId: container.id,
        title: "Written in one transaction",
        createdBy: HUMAN,
      })
      // Nothing reaches the workflow while the transaction is open.
      expect(dispatchTrigger).not.toHaveBeenCalled()
    }
  )
  await settle()
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    workflowId: "wf1",
    payload: { kind: "created", identifier: "MERC-1", title: "Written in one transaction" },
  })
})

it("never fires for an issue whose transaction aborted", async () => {
  const db = getDb()
  await expect(
    db.transaction(
      "rw",
      [db.issues, db.issueEvents, db.issueCounters, db.issueProjects],
      async () => {
        const container = await createIssueProject({
          projectId: "w1",
          name: "Mercury",
          key: "MERC",
        })
        await createIssue({
          projectId: "w1",
          issueProjectId: container.id,
          title: "Rolled back",
          createdBy: HUMAN,
        })
        throw new Error("abort")
      }
    )
  ).rejects.toThrow("abort")
  await settle()
  expect(dispatchTrigger).not.toHaveBeenCalled()
})
