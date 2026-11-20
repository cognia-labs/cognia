/** @jest-environment node */
import type { UIMessage } from "ai"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import { SQUAD_HANDOFF_RECONCILE_WINDOW_MS } from "@/lib/background-tasks/squad-handoff-outbox"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import type { RoomHandoffAttempt } from "./decide"
import {
  __setRoomHandoffSettleDepsForTesting,
  reconcileRoomHandoffs,
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
})
