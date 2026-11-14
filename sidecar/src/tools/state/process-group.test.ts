import test from "node:test"
import assert from "node:assert/strict"
import { createProcessGroup } from "./process-group.ts"

test("after leader exit a signal reaches the group only right after a live probe", () => {
  const calls: (NodeJS.Signals | number)[] = []
  let live = true
  const group = createProcessGroup(123, true, (pid, signal) => {
    assert.equal(pid, -123)
    calls.push(signal)
    if (!live) throw Object.assign(new Error("gone"), { code: "ESRCH" })
  })
  group.signal("SIGTERM")
  group.leaderExited()
  // A survivor that ignored SIGTERM still gets the escalation.
  assert.equal(group.signal("SIGKILL"), true)
  assert.deepEqual(calls, [0, "SIGTERM", 0, 0, "SIGKILL"])
  live = false
  // An empty group answers the probe with ESRCH and is never signalled again.
  assert.equal(group.signal("SIGKILL"), false)
  assert.equal(group.retire(), true)
  assert.equal(group.signal("SIGTERM"), false)
  assert.deepEqual(calls, [0, "SIGTERM", 0, 0, "SIGKILL", 0])
})

test("retirement ends signal authority even while the probe still sees the group", () => {
  const signals: (NodeJS.Signals | number)[] = []
  const group = createProcessGroup(123, true, (_, signal) => signals.push(signal))
  group.leaderExited()
  assert.equal(group.retire(), false)
  assert.equal(group.signal("SIGKILL"), false)
  assert.deepEqual(signals.filter(Boolean), [])
})

test("ESRCH permanently retires the identity on exit and on every query", () => {
  for (const onExit of [true, false]) {
    let calls = 0
    const group = createProcessGroup(123, true, () => {
      calls++
      throw Object.assign(new Error("gone"), { code: "ESRCH" })
    })
    if (onExit) group.leaderExited()
    assert.equal(group.isLive(), false)
    group.signal("SIGKILL")
    assert.equal(group.retire(), true)
    assert.equal(calls, 1)
  }
})

test("unsupported process trees never prove empty", () => {
  const group = createProcessGroup(123, false, () => assert.fail("unsupported"))
  group.leaderExited()
  assert.equal(group.isLive(), true)
  assert.equal(group.retire(), false)
})
