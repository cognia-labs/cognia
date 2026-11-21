import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { claimNext, markSent, recordFailure } from "@/lib/db/mobile-outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { VisualWorkflow } from "@/types/workflow/visual"

let writeAuthority: "local" | "host" = "host"
jest.mock("./write-authority", () => ({ workflowWriteAuthority: () => writeAuthority }))

import {
  awaitWorkflowHostWritesSettled,
  createAuthoredWorkflow,
  pendingWorkflowHostWriteIds,
  queueWorkflowCreateOnHost,
  queueWorkflowSaveOnHost,
  workflowDefinitionPayload,
  workflowHostChannel,
} from "./host-writes"

const scope = { accountId: "acct_phone", targetId: "host-desktop", routingGeneration: 0 }
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().mobileOutboundQueue.clear()
  await getDb().workflows.clear()
  setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  writeAuthority = "host"
})
afterEach(() => clearActiveRuntimeTargetContext())
afterAll(dbFixture.dispose)

function workflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf_phone",
    schemaVersion: 2,
    name: "Phone draft",
    createdAt: 1,
    updatedAt: 2,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    ...overrides,
  }
}

describe("workflowDefinitionPayload", () => {
  it("carries the editor's fields, never identity or publication, and clears with null", () => {
    const payload = workflowDefinitionPayload(
      workflow({
        description: undefined,
        published: { versionId: "v1" } as VisualWorkflow["published"],
        triggerPauses: { n_cron: 5 },
      })
    )
    expect(payload).toMatchObject({ name: "Phone draft", nodes: [], description: null })
    for (const key of ["id", "createdAt", "updatedAt", "published", "triggerPauses"]) {
      expect(payload).not.toHaveProperty(key)
    }
  })
})

describe("queued Host writes", () => {
  it("orders a create before the saves that follow it on the workflow's channel", async () => {
    await queueWorkflowCreateOnHost(workflow())
    await queueWorkflowSaveOnHost(workflow({ name: "Renamed" }))
    const rows = await getDb().mobileOutboundQueue.toArray()
    expect(rows.every((row) => row.channel === workflowHostChannel("wf_phone"))).toBe(true)

    const first = await claimNext(Date.now(), scope)
    expect(first?.command).toBe("workflow_create")
    expect(first?.payload).toMatchObject({ id: "wf_phone", draft: { name: "Phone draft" } })
    // The save waits behind the create until the Host has answered it.
    expect(await claimNext(Date.now(), scope)).toBeNull()
    await markSent(first!.id)
    const second = await claimNext(Date.now(), scope)
    expect(second?.command).toBe("workflow_update")
    expect(second?.payload).toMatchObject({ id: "wf_phone", patch: { name: "Renamed" } })
  })

  it("drops an unsent or failed older save once a newer one is queued", async () => {
    const stale = await queueWorkflowSaveOnHost(workflow({ name: "one" }))
    await getDb().mobileOutboundQueue.update(stale.id, { status: "deadlettered" })
    await queueWorkflowSaveOnHost(workflow({ name: "two" }))
    await queueWorkflowSaveOnHost(workflow({ name: "three" }))
    const rows = await getDb().mobileOutboundQueue.toArray()
    expect(rows.map((row) => (row.payload.patch as { name: string }).name)).toEqual(["three"])
  })

  it("names every workflow with a write the Host has not applied", async () => {
    await queueWorkflowSaveOnHost(workflow({ id: "wf_a" }))
    const sent = await queueWorkflowSaveOnHost(workflow({ id: "wf_b" }))
    await markSent(sent.id)
    // Another Host's queue is not this client's to protect.
    await getDb().mobileOutboundQueue.update(
      (await queueWorkflowSaveOnHost(workflow({ id: "wf_c" }))).id,
      { targetId: "host-other" }
    )
    expect([...(await pendingWorkflowHostWriteIds())]).toEqual(["wf_a"])
  })
})

describe("awaitWorkflowHostWritesSettled", () => {
  it("is settled with nothing queued and once the newest write was delivered", async () => {
    await expect(awaitWorkflowHostWritesSettled("wf_phone", { timeoutMs: 0 })).resolves.toEqual({
      outcome: "settled",
    })
    const row = await queueWorkflowSaveOnHost(workflow())
    await expect(awaitWorkflowHostWritesSettled("wf_phone", { timeoutMs: 0 })).resolves.toEqual({
      outcome: "pending",
    })
    await markSent(row.id)
    await expect(awaitWorkflowHostWritesSettled("wf_phone", { timeoutMs: 0 })).resolves.toEqual({
      outcome: "settled",
    })
  })

  it("reports a write the queue gave up on, so the client does not run a stale copy", async () => {
    const row = await queueWorkflowCreateOnHost(workflow())
    await recordFailure({ id: row.id, error: new Error("400 bad request") })
    await expect(awaitWorkflowHostWritesSettled("wf_phone", { timeoutMs: 0 })).resolves.toEqual({
      outcome: "refused",
      command: "workflow_create",
      error: "400 bad request",
    })
  })

  it("waits for a pending write to land", async () => {
    const row = await queueWorkflowSaveOnHost(workflow())
    setTimeout(() => void markSent(row.id), 30)
    await expect(
      awaitWorkflowHostWritesSettled("wf_phone", { timeoutMs: 2_000, pollMs: 10 })
    ).resolves.toEqual({ outcome: "settled" })
  })
})

describe("createAuthoredWorkflow", () => {
  it("creates only the local row where this process owns its workflows", async () => {
    writeAuthority = "local"
    const row = await createAuthoredWorkflow({ name: "Desktop draft" })
    expect(await getDb().workflows.get(row.id)).toBeDefined()
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })

  it("queues the same row, under the same id, to the Host on a paired client", async () => {
    const row = await createAuthoredWorkflow({ name: "Phone draft" })
    expect(await getDb().workflows.get(row.id)).toBeDefined()
    const [queued] = await getDb().mobileOutboundQueue.toArray()
    expect(queued).toMatchObject({
      command: "workflow_create",
      channel: workflowHostChannel(row.id),
      payload: { id: row.id, draft: { name: "Phone draft" } },
    })
  })

  it("removes the mirror row again when the Host write cannot be queued", async () => {
    // Outside any routed Host the queue refuses to take the job.
    clearActiveRuntimeTargetContext()
    await expect(createAuthoredWorkflow({ name: "Orphan" })).rejects.toThrow()
    expect(await getDb().workflows.count()).toBe(0)
  })
})
