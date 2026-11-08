/** @jest-environment node */
import {
  SQUAD_HANDOFF_RECONCILE_WINDOW_MS,
  isSettledOutboxKind,
  outboxReconcileWindowMs,
  squadHandoffOutboxId,
  squadHandoffOutboxRecord,
} from "./squad-handoff-outbox"

const facts = {
  proposerId: "ava",
  toolUseId: "tu-1",
  squadId: "sq-1",
  squadName: "Builders",
  delegationRunId: "execution:delegation:room-handoff:tu-1",
  squadRunId: "execution:team:r1",
  outcome: "completed" as const,
}

describe("squad-handoff outbox entries", () => {
  it("are settled entries of their own kind, kept from pruning for their window", () => {
    expect(isSettledOutboxKind("squad-handoff")).toBe(true)
    expect(isSettledOutboxKind("shell-job")).toBe(true)
    expect(isSettledOutboxKind("monitor")).toBe(true)
    expect(isSettledOutboxKind("subagent")).toBe(false)
    expect(outboxReconcileWindowMs("squad-handoff")).toBe(SQUAD_HANDOFF_RECONCILE_WINDOW_MS)
    expect(outboxReconcileWindowMs("subagent")).toBe(0)
  })

  it("write one attempt's end, owed to the room, keyed by the attempt", () => {
    expect(
      squadHandoffOutboxRecord({
        roomId: "room-1",
        brief: "Write a hello script",
        facts,
        startedAt: 1,
        settledAt: 9,
        resultText: "hello.sh written",
      })
    ).toEqual({
      runId: squadHandoffOutboxId("execution:team:r1"),
      kind: "squad-handoff",
      subagentId: "sq-1",
      label: "Builders",
      prompt: "Write a hello script",
      sessionId: "room-1",
      host: "renderer",
      status: "done",
      startedAt: 1,
      settledAt: 9,
      resultText: "hello.sh written",
      mode: "background",
      deliveryState: "pending",
      squadHandoff: facts,
    })
    expect(squadHandoffOutboxId("execution:team:r1")).toBe("squad-handoff:execution:team:r1")
  })

  it("say why an attempt failed, and owe a stopped one nothing", () => {
    const failed = squadHandoffOutboxRecord({
      roomId: "room-1",
      brief: "b",
      facts: { ...facts, outcome: "failed" },
      startedAt: 1,
      settledAt: 2,
    })
    expect(failed).toMatchObject({
      status: "error",
      error: "Squad run failed",
      deliveryState: "pending",
    })
    const stopped = squadHandoffOutboxRecord({
      roomId: "room-1",
      brief: "b",
      facts: { ...facts, outcome: "cancelled" },
      startedAt: 1,
      settledAt: 2,
      error: "stopped by a person",
    })
    expect(stopped).toMatchObject({
      status: "error",
      error: "stopped by a person",
      deliveryState: "skipped",
    })
  })
})
