/** @jest-environment node */
import "fake-indexeddb/auto"
import type { UIMessage } from "ai"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import { SQUAD_HANDOFF_RECONCILE_WINDOW_MS } from "@/lib/background-tasks/squad-handoff-outbox"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import type { RoomHandoffAttempt } from "./decide"
import {
  __setRoomHandoffSettleDepsForTesting,
  reconcileRoomHandoffs,
  reconcileRoomHandoffsWithStatus,
  settleRoomHandoffAttempt,
  watchRoomHandoffAttempt,
  type RoomHandoffSettleDeps,
} from "./settle"

const NOW = 10 * 24 * 60 * 60 * 1000
const attempt: RoomHandoffAttempt = {
  roomId: "room-1",
  toolUseId: "tu-1",
  proposerId: "ava",
  squadId: "sq-1",
  squadName: "Builders",
  brief: "Write a hello script",
  delegationRunId: "execution:delegation:room-handoff:tu-1",
  squadRunId: "execution:team:r1",
  startedAt: NOW - 5_000,
}

const started = {
  status: "started",
  squadId: "sq-1",
  squadName: "Builders",
  delegationRunId: "execution:delegation:room-handoff:tu-1",
  squadRunId: "execution:team:r1",
  decidedAt: NOW - 5_000,
  decidedBy: { kind: "local" },
}

function world() {
  const reported: BackgroundTaskJournalRecord[] = []
  const entries = new Set<string>()
  const delegations: ExecutionRun[] = []
  const attempts = new Map<string, ExecutionRun[]>()
  const reports = new Map<string, { text?: string; error?: string }>()
  let messages: UIMessage[] = []
  const deps: RoomHandoffSettleDeps = {
    report: async (record) => {
      reported.push(record)
      entries.add(record.runId)
    },
    hasEntry: async (id) => entries.has(id),
    listHandoffDelegations: async () => delegations,
    listChildren: async (id) => attempts.get(id) ?? [],
    readMessages: async () => messages,
    runReport: async (squadRunId) => reports.get(squadRunId) ?? {},
    now: () => NOW,
  }
  __setRoomHandoffSettleDepsForTesting(deps)
  return {
    deps,
    reported,
    entries,
    delegations,
    attempts,
    reports,
    setMessages: (next: UIMessage[]) => {
      messages = next
    },
  }
}

afterEach(() => __setRoomHandoffSettleDepsForTesting(null))

const proposalReply = (decision: unknown = started) =>
  ({
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-room_handoff_to_squad",
        toolCallId: "tu-1",
        input: { brief: "Write a hello script", squadId: "sq-1" },
      },
    ],
    metadata: { senderId: "ava", squadHandoffs: { "tu-1": decision } },
  }) as unknown as UIMessage

describe("settleRoomHandoffAttempt", () => {
  it("writes the attempt's end for its proposer, with the Squad's result", async () => {
    const w = world()
    await settleRoomHandoffAttempt(attempt, { status: "completed", text: "done" })
    expect(w.reported).toEqual([
      expect.objectContaining({
        runId: "squad-handoff:execution:team:r1",
        kind: "squad-handoff",
        sessionId: "room-1",
        status: "done",
        resultText: "done",
        settledAt: NOW,
        deliveryState: "pending",
        squadHandoff: {
          proposerId: "ava",
          toolUseId: "tu-1",
          squadId: "sq-1",
          squadName: "Builders",
          delegationRunId: "execution:delegation:room-handoff:tu-1",
          squadRunId: "execution:team:r1",
          outcome: "completed",
        },
      }),
    ])
  })

  it("owes a stopped attempt nothing", async () => {
    const w = world()
    await settleRoomHandoffAttempt(attempt, { status: "cancelled", error: "stopped" })
    expect(w.reported[0]).toMatchObject({ status: "error", deliveryState: "skipped" })
  })

  it("reports the launched attempt when its outcome settles", async () => {
    const w = world()
    let settle: (value: ChildRunOutcome) => void = () => undefined
    watchRoomHandoffAttempt(
      attempt,
      new Promise((resolve) => {
        settle = resolve
      })
    )
    expect(w.reported).toEqual([])
    settle({ status: "failed", error: "boom" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(w.reported[0]).toMatchObject({ status: "error", error: "boom" })
  })
})

describe("reconcileRoomHandoffs", () => {
  const delegation = (updatedAt = NOW - 1_000) =>
    ({
      id: "execution:delegation:room-handoff:tu-1",
      kind: "delegation",
      sourceId: "room-handoff:tu-1",
      sessionId: "room-1",
      updatedAt,
    }) as ExecutionRun
  const teamRun = (id: string, status: ExecutionRun["status"], endedAt?: number) =>
    ({
      id,
      kind: "team",
      sourceId: id.replace("execution:team:", ""),
      status,
      startedAt: NOW - 9_000,
      updatedAt: NOW,
      endedAt,
    }) as ExecutionRun

  it("reports each ended attempt without an entry once, with that attempt's own report", async () => {
    const w = world()
    w.delegations.push(delegation())
    w.attempts.set("execution:delegation:room-handoff:tu-1", [
      teamRun("execution:team:r2", "completed", NOW - 1_000),
      teamRun("execution:team:r1", "failed", NOW - 60 * 60 * 1000),
      teamRun("execution:team:r3", "running"),
    ])
    w.reports.set("r2", { text: "hello.sh written" })
    w.reports.set("r1", { error: "tests failed" })
    w.setMessages([proposalReply()])
    await expect(reconcileRoomHandoffs()).resolves.toBe(2)
    expect(
      w.reported.map((row) => [row.runId, row.resultText, row.error, row.squadHandoff?.outcome])
    ).toEqual([
      ["squad-handoff:execution:team:r2", "hello.sh written", undefined, "completed"],
      ["squad-handoff:execution:team:r1", undefined, "tests failed", "failed"],
    ])
    expect(w.reported[0]).toMatchObject({ settledAt: NOW - 1_000, prompt: "Write a hello script" })
    await expect(reconcileRoomHandoffs()).resolves.toBe(0)
  })

  it("finds a retry under the attempt it replaced and gives each its own report (F05)", async () => {
    // A retry from the run's card hangs under the Squad run it replaced, not
    // under the delegation; and two attempts that ended close together must
    // not borrow each other's report.
    const w = world()
    w.delegations.push(delegation())
    w.attempts.set("execution:delegation:room-handoff:tu-1", [
      teamRun("execution:team:r1", "failed", NOW - 2_000),
    ])
    w.attempts.set("execution:team:r1", [
      teamRun("execution:team:r1-retry", "completed", NOW - 1_000),
      { id: "execution:agent:side", kind: "agent", status: "completed" } as unknown as ExecutionRun,
    ])
    w.attempts.set("execution:team:r1-retry", [
      teamRun("execution:team:r1-retry-2", "completed", NOW - 500),
    ])
    w.reports.set("r1", { error: "flaky test" })
    w.reports.set("r1-retry", { text: "first retry's answer" })
    w.reports.set("r1-retry-2", { text: "second retry's answer" })
    w.setMessages([proposalReply()])
    await expect(reconcileRoomHandoffs()).resolves.toBe(3)
    expect(w.reported.map((row) => [row.runId, row.resultText ?? row.error])).toEqual([
      ["squad-handoff:execution:team:r1", "flaky test"],
      ["squad-handoff:execution:team:r1-retry", "first retry's answer"],
      ["squad-handoff:execution:team:r1-retry-2", "second retry's answer"],
    ])
  })

  it("reports an attempt whose run has no report without inventing one", async () => {
    const w = world()
    w.delegations.push(delegation())
    w.attempts.set("execution:delegation:room-handoff:tu-1", [
      teamRun("execution:team:r1", "completed", NOW - 1_000),
    ])
    w.deps.runReport = async () => {
      throw new Error("row unreadable")
    }
    w.setMessages([proposalReply()])
    await expect(reconcileRoomHandoffs()).resolves.toBe(1)
    expect(w.reported[0]).toMatchObject({ status: "done", deliveryState: "pending" })
    expect(w.reported[0]?.resultText).toBeUndefined()
  })

  it("skips a hand-off outside the window, one with no started decision, and a room without the proposal", async () => {
    const w = world()
    w.delegations.push(delegation(NOW - SQUAD_HANDOFF_RECONCILE_WINDOW_MS - 1))
    w.attempts.set("execution:delegation:room-handoff:tu-1", [
      teamRun("execution:team:r1", "completed", NOW - 1_000),
    ])
    w.setMessages([proposalReply()])
    await expect(reconcileRoomHandoffs()).resolves.toBe(0)
    w.delegations.splice(0, 1, delegation())
    w.setMessages([
      proposalReply({ status: "declined", decidedAt: 1, decidedBy: { kind: "local" } }),
    ])
    await expect(reconcileRoomHandoffs()).resolves.toBe(0)
    w.setMessages([])
    await expect(reconcileRoomHandoffs()).resolves.toBe(0)
    expect(w.reported).toEqual([])
  })

  it("does not count failed outbox writes as reported and retries them cleanly on the next pass (F05, T04)", async () => {
    const w = world()
    w.delegations.push(delegation())
    w.attempts.set("execution:delegation:room-handoff:tu-1", [
      teamRun("execution:team:r1", "completed", NOW - 1_000),
    ])
    w.reports.set("r1", { text: "persisted on second pass" })
    w.setMessages([proposalReply()])

    let failWrite = true
    w.deps.report = async (record) => {
      if (failWrite) return false
      w.reported.push(record)
      w.entries.add(record.runId)
      return true
    }

    await expect(reconcileRoomHandoffsWithStatus()).resolves.toEqual({
      reported: 0,
      pendingRetry: 1,
    })
    expect(w.reported).toHaveLength(0)

    failWrite = false
    await expect(reconcileRoomHandoffsWithStatus()).resolves.toEqual({
      reported: 1,
      pendingRetry: 0,
    })
    expect(w.reported).toHaveLength(1)
    expect(w.reported[0]).toMatchObject({ resultText: "persisted on second pass" })
    await expect(reconcileRoomHandoffsWithStatus()).resolves.toEqual({
      reported: 0,
      pendingRetry: 0,
    })
  })

  it("recovers missing outbox entries across crash window, preserves close-timestamp attempt reports, and delivers once across duplicate startups (T04)", async () => {
    const { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } =
      await import("@/lib/db/schema")
    const { toStoredMessageRow } = await import("@/lib/db/messages")
    const {
      __resetBackgroundResultRuntimeForTesting,
      maybeDrainBackgroundResults,
      registerImRoomDeliveryLane,
    } = await import("@/lib/background-tasks/result-delivery")
    const { WAKE_COALESCE_MS } = await import("@/lib/background-tasks/wake-policy")
    const { start } = await import("./runtime-reconcile")

    __setRoomHandoffSettleDepsForTesting(null)
    const disableDb = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    __resetBackgroundResultRuntimeForTesting()

    const now = Date.now()
    try {
      const db = getDb()
      // Seed real IM group room session + transcript with started proposal
      await db.sessions.put({
        id: "room-crash",
        title: "Ops Room",
        mode: "chat",
        provider: "openai",
        model: "gpt-4o",
        platformBinding: {
          platform: "lark",
          adapterId: "a1",
          conversationKey: "lark:a1:oc_crash",
          scopeKind: "group",
        },
        createdAt: now - 10_000,
        updatedAt: now - 1_000,
      } as never)
      const proposalMsg = {
        id: "msg-proposal",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-room_handoff_to_squad",
            toolCallId: "tu-crash",
            input: { brief: "Ship hotfix", squadId: "sq-crash" },
          },
        ],
        metadata: {
          senderId: "ava",
          squadHandoffs: {
            "tu-crash": {
              status: "started",
              squadId: "sq-crash",
              squadName: "Hotfix Squad",
              delegationRunId: "execution:delegation:room-handoff:tu-crash",
              squadRunId: "execution:team:att-1",
              decidedAt: now - 8_000,
              decidedBy: { kind: "local" },
            },
          },
        },
      } as unknown as UIMessage
      await db.messages.put(
        toStoredMessageRow(proposalMsg, {
          id: "msg-proposal",
          sessionId: "room-crash",
          parts: proposalMsg.parts as never,
          createdAt: now - 9_000,
        })
      )

      // Seed ended delegation + two close-timestamp attempts (5ms apart!) + one cancelled attempt,
      // simulating a crash right after terminal executionRuns/workflowRuns persisted and BEFORE outbox write!
      await db.executionRuns.bulkPut([
        {
          id: "execution:delegation:room-handoff:tu-crash",
          kind: "delegation",
          sourceId: "room-handoff:tu-crash",
          sessionId: "room-crash",
          title: "Room handoff",
          status: "completed",
          currentRevision: 1,
          startedAt: now - 8_000,
          updatedAt: now - 100,
        },
        {
          id: "execution:team:att-1",
          parentRunId: "execution:delegation:room-handoff:tu-crash",
          kind: "team",
          sourceId: "att-1",
          sessionId: "room-crash",
          title: "Attempt 1",
          status: "failed",
          currentRevision: 2,
          startedAt: now - 7_000,
          updatedAt: now - 105,
          endedAt: now - 105,
        },
        {
          id: "execution:team:att-2",
          parentRunId: "execution:team:att-1",
          kind: "team",
          sourceId: "att-2",
          sessionId: "room-crash",
          title: "Attempt 2",
          status: "completed",
          currentRevision: 2,
          startedAt: now - 6_900,
          updatedAt: now - 100,
          endedAt: now - 100,
        },
        {
          id: "execution:team:att-cancelled",
          parentRunId: "execution:delegation:room-handoff:tu-crash",
          kind: "team",
          sourceId: "att-cancelled",
          sessionId: "room-crash",
          title: "Cancelled Attempt",
          status: "cancelled",
          currentRevision: 2,
          startedAt: now - 6_800,
          updatedAt: now - 95,
          endedAt: now - 95,
        },
      ] as never[])
      await db.workflowRuns.bulkPut([
        {
          id: "att-1",
          workflowId: "wf-1",
          status: "failed",
          startedAt: now - 7_000,
          completedAt: now - 105,
          error: { code: "STEP_FAILED", message: "attempt-1 distinct failure" },
        },
        {
          id: "att-2",
          workflowId: "wf-2",
          status: "succeeded",
          startedAt: now - 6_900,
          completedAt: now - 100,
          output: { stepA: { text: "attempt-2 distinct answer" } },
        },
      ] as never[])

      expect(await db.backgroundTasks.count()).toBe(0)

      const deliveries: string[] = []
      const unregisterLane = registerImRoomDeliveryLane({
        isReachable: () => true,
        isIdle: () => true,
        consumerId: () => "im-room-lane-t04",
        send: async (framed) => {
          deliveries.push(framed)
          return true
        },
      })

      // Duplicate startup reconciliation must backfill outbox entries idempotently and deliver ONCE!
      const stop1 = await start()
      const stop2 = await start()
      await new Promise((r) => setTimeout(r, WAKE_COALESCE_MS + 30))
      maybeDrainBackgroundResults("room-crash", { turnSettled: true })
      await new Promise((r) => setTimeout(r, 30))

      const outboxRows = await db.backgroundTasks.toArray()
      expect(outboxRows).toHaveLength(3)
      const byId = Object.fromEntries(outboxRows.map((r) => [r.runId, r]))
      expect(byId["squad-handoff:execution:team:att-1"]).toMatchObject({
        error: "attempt-1 distinct failure",
        deliveryState: "delivered",
      })
      expect(byId["squad-handoff:execution:team:att-2"]).toMatchObject({
        resultText: "attempt-2 distinct answer",
        deliveryState: "delivered",
      })
      expect(byId["squad-handoff:execution:team:att-cancelled"]).toMatchObject({
        deliveryState: "skipped",
      })

      // Delivered as ONE coalesced room turn, not duplicated on second start()!
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toContain("attempt-1 distinct failure")
      expect(deliveries[0]).toContain("attempt-2 distinct answer")

      stop1()
      stop2()
      unregisterLane()
    } finally {
      __resetBackgroundResultRuntimeForTesting()
      await getDb()
        .delete()
        .catch(() => undefined)
      __resetDbForTesting()
      disableDb()
    }
  })
})
