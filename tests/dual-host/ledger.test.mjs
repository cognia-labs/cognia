import assert from "node:assert/strict"
import { test } from "node:test"
import { ledgerDiff, normalizeLedger } from "./ledger.ts"

function run(id, time) {
  return {
    id,
    kind: "agent-turn",
    status: "completed",
    startedAt: time,
    events: [
      {
        seq: 3,
        type: "tool.completed",
        payload: { toolCallId: id, toolName: "TodoWrite", duration: time },
      },
      { seq: 1, type: "run.started", payload: { surface: "chat", hostId: id } },
      { seq: 2, type: "tool.started", payload: { toolCallId: id, toolName: "TodoWrite" } },
      { seq: 4, type: "run.completed", payload: { timestamp: time } },
    ],
  }
}

test("normalization orders events and removes volatile host, time and id fields", () => {
  const desktop = normalizeLedger([run("desktop-id", 100)])
  const web = normalizeLedger([run("web-id", 900)])
  assert.deepEqual(desktop, web)
  assert.deepEqual(desktop[0], {
    source: "direct-chat",
    kind: "agent-turn",
    status: "succeeded",
    events: ["run.started", "tool.started", "tool.completed", "run.completed"],
    toolCalls: [{ name: "TodoWrite", status: "completed" }],
  })
  assert.equal(ledgerDiff(desktop, web), "Ledger projections agree")
})

test("failures, unfinished tools, duplicate runs and event ordering remain observable", () => {
  const success = normalizeLedger([run("one", 1)])
  const failed = run("two", 2)
  failed.status = "failed"
  failed.events[0].type = "tool.failed"
  const projection = normalizeLedger([failed])
  assert.equal(projection[0].toolCalls[0].status, "failed")
  assert.match(ledgerDiff(success, projection), /--- expected[\s\S]*\+\+\+ actual[\s\S]*failed/)
  assert.equal(normalizeLedger([run("one", 1), run("two", 2)]).length, 2)
  const pending = run("pending", 3)
  pending.events = pending.events.filter((event) => event.type !== "tool.completed")
  assert.equal(normalizeLedger([pending])[0].toolCalls[0].status, "running")
})

test("malformed tool identities fail rather than disappearing from parity checks", () => {
  const invalid = run("one", 1)
  delete invalid.events[0].payload.toolCallId
  assert.throws(() => normalizeLedger([invalid]), /Malformed tool.completed/)
})
