import test from "node:test"
import assert from "node:assert/strict"
import { createProcessGroup } from "./process-group.ts"

test("leader exit fences every later signal even if the probe sees a reused pgid", () => {
  const signals: (NodeJS.Signals | number)[] = []
  const group = createProcessGroup(123, true, (_, signal) => signals.push(signal))
  group.signal("SIGTERM")
  group.leaderExited()
  group.signal("SIGKILL")
  assert.equal(group.isLive(), true)
  assert.deepEqual(signals.filter(Boolean), ["SIGTERM"])
  assert.equal(group.retire(), false)
  group.signal("SIGTERM")
  assert.deepEqual(signals.filter(Boolean), ["SIGTERM"])
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
