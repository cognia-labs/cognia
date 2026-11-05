/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { followQueuedCreate, queuedCreateOutcome, type QueuedCreateOutcome } from "./shared-create"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(over: Partial<MobileOutboundJobRow> = {}): MobileOutboundJobRow {
  return {
    id: "op-1",
    accountId: "acct",
    targetId: "collab-plane",
    command: "collab_issue_create",
    payload: {},
    status: "pending",
    attempts: 0,
    createdAt: 1,
    nextAttemptAt: 1,
    idempotencyKey: "op-1",
    protocol: "collab-v1",
    ...over,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

describe("queuedCreateOutcome", () => {
  it("is null while the row is on its way, including a retryable failure", () => {
    for (const status of ["pending", "sending", "failed"] as const) {
      expect(queuedCreateOutcome(row({ status }))).toBeNull()
    }
  })

  it("reports delivery with the server's id, and every way a row ends without one", () => {
    expect(queuedCreateOutcome(row({ status: "sent", createdEntityId: "srv-1" }))).toEqual({
      kind: "delivered",
      entityId: "srv-1",
    })
    expect(queuedCreateOutcome(row({ status: "sent" }))).toEqual({ kind: "ended", status: "sent" })
    for (const status of ["deadlettered", "conflicted", "rejected"] as const) {
      expect(queuedCreateOutcome(row({ status }))).toEqual({ kind: "ended", status })
    }
    expect(queuedCreateOutcome(undefined)).toEqual({ kind: "ended", status: "gone" })
  })
})

describe("followQueuedCreate", () => {
  it("reports once, when the row is delivered", async () => {
    await getDb().mobileOutboundQueue.put(row())
    const outcomes: QueuedCreateOutcome[] = []
    followQueuedCreate("op-1", (outcome) => outcomes.push(outcome))
    await settle()
    expect(outcomes).toEqual([])
    await getDb().mobileOutboundQueue.update("op-1", { status: "sending" })
    await settle()
    await getDb().mobileOutboundQueue.update("op-1", {
      status: "sent",
      createdEntityId: "srv-1",
    })
    await settle()
    await getDb().mobileOutboundQueue.update("op-1", { createdEntityId: "srv-2" })
    await settle()
    expect(outcomes).toEqual([{ kind: "delivered", entityId: "srv-1" }])
  })

  it("reports a row that was discarded as gone", async () => {
    await getDb().mobileOutboundQueue.put(row({ status: "conflicted" }))
    const outcomes: QueuedCreateOutcome[] = []
    followQueuedCreate("op-1", (outcome) => outcomes.push(outcome))
    await settle()
    expect(outcomes).toEqual([{ kind: "ended", status: "conflicted" }])
    const later: QueuedCreateOutcome[] = []
    followQueuedCreate("missing", (outcome) => later.push(outcome))
    await settle()
    expect(later).toEqual([{ kind: "ended", status: "gone" }])
  })

  it("says nothing after it is disposed", async () => {
    await getDb().mobileOutboundQueue.put(row())
    const outcomes: QueuedCreateOutcome[] = []
    const stop = followQueuedCreate("op-1", (outcome) => outcomes.push(outcome))
    stop()
    await getDb().mobileOutboundQueue.update("op-1", { status: "sent", createdEntityId: "srv-1" })
    await settle()
    expect(outcomes).toEqual([])
  })
})
