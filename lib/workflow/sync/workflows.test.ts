/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowRow } from "@/types/workflow/visual"

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "@/lib/sync/handlers/base"

import { syncWorkflows } from "./workflows"

const pendingIds = new Set<string>()
jest.mock("../remote/host-writes", () => ({
  pendingWorkflowHostWriteIds: jest.fn(async () => new Set(pendingIds)),
}))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  pendingIds.clear()
})
afterAll(dbFixture.dispose)

function makeTransport(rows: WorkflowRow[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncWorkflows", () => {
  it("calls sync_pull with table=workflows + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncWorkflows(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "workflows",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("filters out isBuiltIn rows before persisting", async () => {
    const rows = [
      { id: "u", name: "user-workflow", isBuiltIn: false } as unknown as WorkflowRow,
      { id: "b", name: "builtin", isBuiltIn: true } as unknown as WorkflowRow,
    ]
    const tx = makeTransport(rows)
    const out = await syncWorkflows(tx, { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(1)
  })

  it("defers a row the client is still saving to the Host, holding the cursor below it", async () => {
    pendingIds.add("wf_editing")
    await getDb().workflows.put({
      id: "wf_editing",
      name: "phone edit",
      updatedAt: 50,
    } as unknown as WorkflowRow)
    const rows = [
      { id: "wf_editing", name: "host's older copy", updatedAt: 40 } as unknown as WorkflowRow,
      { id: "wf_other", name: "unrelated", updatedAt: 45 } as unknown as WorkflowRow,
    ]
    const out = await syncWorkflows(makeTransport(rows, [], 60), { since: 10 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // The edit on screen survives the older delta; the other row lands.
    expect((await getDb().workflows.get("wf_editing"))?.name).toBe("phone edit")
    expect((await getDb().workflows.get("wf_other"))?.name).toBe("unrelated")
    expect(out.result.applied).toBe(1)
    // The next pull hands the deferred row back instead of moving past it.
    expect(out.result.nextSince).toBe(39)
  })
})
