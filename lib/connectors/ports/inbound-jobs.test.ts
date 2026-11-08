/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  bindConnectorInboundJobExecutionRun,
  markConnectorInboundJobRecoveryRequired,
} from "@/lib/db/connector-inbound-jobs"
import { port } from "./inbound-jobs"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const seed = () =>
  port.seedRunningJob({
    adapterId: "wecom:a",
    conversationKey: "conv-1",
    platform: "wecom",
    sender: { id: "wecom:u1", remoteUserId: "u1", displayName: "Ann" },
  })

describe("inbound-jobs port", () => {
  it("seeds a claimed job driven by the verified sender", async () => {
    const { id } = await seed()
    const row = await getDb().connectorInboundJobs.get(id)
    expect(row?.status).toBe("running")
    expect(row?.event.sender).toMatchObject({ remoteUserId: "u1", displayName: "Ann" })
  })

  it("finds the job a run belongs to, and nothing for another run", async () => {
    const { id } = await seed()
    await bindConnectorInboundJobExecutionRun(id, "run-1")
    await expect(port.findJobForRun("run-1")).resolves.toMatchObject({
      id,
      executionRunId: "run-1",
      status: "running",
    })
    await expect(port.findJobForRun("run-2")).resolves.toBeUndefined()
  })

  it("continues only a job that needs recovery, carrying the anchor", async () => {
    const { id } = await seed()
    await expect(port.continueJob(id, { recoveryAnchor: { version: 1 } })).resolves.toBe(false)
    await markConnectorInboundJobRecoveryRequired(id, "crashed")
    await expect(port.continueJob(id, { recoveryAnchor: { version: 1 } })).resolves.toBe(true)
    const row = await getDb().connectorInboundJobs.get(id)
    expect(row?.status).toBe("steering")
  })
})
