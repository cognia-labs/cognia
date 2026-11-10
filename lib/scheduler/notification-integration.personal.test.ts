/** @jest-environment jsdom */
// Separate from the channel unit suite so its policy mocks cannot replace the
// real Dexie personal gate at this outbound boundary.
jest.mock("@/lib/connectors/personal-delivery", () => ({
  resolveConnectorSinkAudience: jest.fn(async () => ({ kind: "group" })),
}))
jest.mock("@/lib/notifications/runtime", () => ({ notify: jest.fn(async () => "local-center") }))
jest.mock("@/lib/webhooks/delivery", () => ({ deliverWebhook: jest.fn() }))
jest.mock("@/lib/webhooks/egress-registry", () => ({ publishOutboundEvent: jest.fn() }))
jest.mock("@/lib/webhooks/audit", () => ({ appendWebhookAudit: jest.fn() }))
jest.mock("./webhook-outbound-config", () => ({
  getWebhookOutboundConfig: jest.fn(async () => ({ headers: {}, delivery: {} })),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { deliverWebhook } from "@/lib/webhooks/delivery"
import { publishOutboundEvent } from "@/lib/webhooks/egress-registry"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { notifyTaskEvent } from "./notification-integration"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
})
afterAll(fixture.dispose)

const task = {
  id: "task",
  name: "Task",
  type: "chat",
  trigger: { type: "once" },
  notification: {
    channels: ["im", "toast", "webhook"],
    imTarget: { conversationKey: "lark:bot:oc_group" },
    webhookUrl: "https://hooks.test/task",
  },
} as unknown as ScheduledTask

it("withholds a marked execution's IM and webhook content while retaining the local notification", async () => {
  const run = await startToolExecutionRun(undefined, {
    runId: "scheduled-execution",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [{ person: { kind: "local-person" }, source: "calendar", markedAt: 1 }],
  })
  const execution = {
    id: run.id,
    status: "failed",
    error: "private failure detail",
  } as TaskExecution
  await notifyTaskEvent(task, execution, "error")
  expect(centerNotify).toHaveBeenCalledWith(
    expect.objectContaining({ channels: ["center", "toast"] }),
    { personalContext: { executionRunId: run.id } }
  )
  expect(deliverWebhook).not.toHaveBeenCalled()
  expect(publishOutboundEvent).not.toHaveBeenCalled()
  const receipts = await getDb().actionReviewReceipts.toArray()
  expect(receipts).toHaveLength(2)
  expect(receipts.every((row) => row.personal?.outcome === "withheld")).toBe(true)
  expect(receipts.map((row) => row.personal?.originalTarget).sort()).toEqual([
    "https://hooks.test/task",
    "lark:bot:oc_group",
  ])
})

it("withholds legacy execution output whose canonical Host run cannot be verified", async () => {
  await notifyTaskEvent(
    task,
    { id: "missing-execution", status: "failed", error: "private detail" } as TaskExecution,
    "error"
  )
  expect(deliverWebhook).not.toHaveBeenCalled()
  expect(publishOutboundEvent).not.toHaveBeenCalled()
  expect(centerNotify).toHaveBeenCalledWith(
    expect.objectContaining({ channels: ["center", "toast"] }),
    { personalContext: { executionRunId: "missing-execution" } }
  )
})
