import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { cleanupSourceIsAllowed, readCleanupRowOwnership } from "./cleanup-ownership"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("protects native sync sources without session provenance", () => {
  for (const source of ["skills", "memories", "terminalHistory", "mcpServerSummaries"]) {
    expect(cleanupSourceIsAllowed(source, "session-rows")).toBe(false)
    expect(cleanupSourceIsAllowed(source, "local")).toBe(true)
  }
  for (const source of ["sessions", "messages", "sessionState", "sessionUsage"]) {
    expect(cleanupSourceIsAllowed(source, "session-rows")).toBe(true)
    expect(cleanupSourceIsAllowed(source, "host-managed")).toBe(false)
    expect(cleanupSourceIsAllowed(source, "unknown")).toBe(false)
  }
  expect(cleanupSourceIsAllowed("backupHistory", "unknown")).toBe(true)
})

it("protects persisted mirror cascades and any parent that could delete or reparent them", async () => {
  const db = getDb()
  await db.sessions.bulkPut([
    { id: "local" },
    { id: "host", programmaticCreator: "host-state" },
    {
      id: "attached",
      parentSessionId: "host",
      attachedChild: { parentSessionId: "host", lifecycleOwnerSessionId: "host" },
    },
    { id: "sidechat", surfaceBindingKey: "session:host" },
    { id: "ordinary-local-branch", parentSessionId: "host" },
    { id: "local-parent" },
    { id: "host-child", programmaticCreator: "host-state", parentSessionId: "local-parent" },
    {
      id: "sibling",
      parentSessionId: "local-parent",
      attachedChild: { parentSessionId: "local-parent", lifecycleOwnerSessionId: "local-parent" },
    },
    { id: "delivery", deliverySourceHosts: [{ hostId: "host" }] },
    { id: "existing-bound" },
    { id: "orphan-sidechat", surfaceBindingKey: "session:missing-host" },
    { id: "message-marker" },
  ] as never)
  await db.messages.put({
    id: "host-message",
    sessionId: "message-marker",
    metadata: { hostState: { optimistic: true } },
  } as never)
  await db.hostStateChannels.put({
    channel: "index",
    hostId: "host",
    state: {
      kind: "session-index",
      sessions: [{ sessionId: "existing-bound" }, { sessionId: "missing-host" }],
    },
  } as never)
  await db.chatGoals.put({ id: "host-goal", sessionId: "host" } as never)
  await db.agentPlans.put({ id: "host-plan", sessionId: "host" } as never)
  await db.loops.put({ id: "host-loop", sessionId: "host" } as never)
  await db.executionRuns.bulkPut([
    { id: "host-run", sessionId: "host" },
    { id: "local-run", sessionId: "local" },
  ] as never)
  const ownership = await readCleanupRowOwnership(db)
  for (const id of [
    "host",
    "attached",
    "sidechat",
    "local-parent",
    "host-child",
    "sibling",
    "delivery",
    "existing-bound",
    "orphan-sidechat",
    "message-marker",
  ]) {
    expect(ownership.allows("sessions", { id })).toBe(false)
    expect(ownership.allows("messages", { sessionId: id })).toBe(false)
    expect(ownership.allows("messageMediaRefs", { sessionId: id })).toBe(false)
  }
  for (const id of ["local", "ordinary-local-branch"]) {
    expect(ownership.allows("sessions", { id })).toBe(true)
    expect(ownership.allows("messages", { sessionId: id })).toBe(true)
  }
  expect(ownership.allows("messages", { sessionId: "missing" })).toBe(false)
  expect(
    ownership.allows("messages", {
      sessionId: "local",
      metadata: { hostState: { optimistic: true } },
    })
  ).toBe(false)
  expect(
    ownership.allows("sessionPeerMessages", { senderSessionId: "local", receiverSessionId: "host" })
  ).toBe(false)
  expect(ownership.allows("chatGoalEvents", { goalId: "host-goal" })).toBe(false)
  expect(ownership.allows("agentPlanEvents", { planId: "host-plan" })).toBe(false)
  expect(ownership.allows("loopEvents", { loopId: "host-loop" })).toBe(false)
  expect(ownership.allows("executionRunEvents", { runId: "host-run" })).toBe(false)
  expect(ownership.allows("executionRunBindings", { runId: "host-run" })).toBe(false)
  expect(ownership.allows("executionRunBindings", { runId: "local-run" })).toBe(true)
  expect(ownership.allows("executionRunBindings", { runId: "missing" })).toBe(false)
})
