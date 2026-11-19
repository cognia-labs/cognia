import test from "node:test"
import assert from "node:assert/strict"
import { raceDeadline } from "./deadline.ts"

test("returns work and preserves its rejection before the deadline", async () => {
  const timeout = () => {
    throw new Error("deadline should not fire")
  }
  assert.equal(await raceDeadline(Promise.resolve(7), 1000, timeout, { ref: true }), 7)
  const failure = new Error("work failed")
  await assert.rejects(
    raceDeadline(Promise.reject(failure), 1000, timeout, { ref: false }),
    failure
  )
})

test("settles at the deadline and consumes a later work rejection", async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<string>((_resolve, fail) => {
    reject = fail
  })
  assert.equal(await raceDeadline(pending, 1, () => "timed out", { ref: true }), "timed out")
  reject(new Error("late failure"))
  await new Promise<void>((resolve) => setImmediate(resolve))
})

test("keeps pending work alive until the caller's deadline and clears the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const timeout = t.mock.fn(() => "timed out")
  const settled = t.mock.fn()
  const result = raceDeadline(new Promise<string>(() => {}), 1000, timeout, { ref: true })
  void result.then(settled)
  t.mock.timers.tick(999)
  await Promise.resolve()
  assert.equal(timeout.mock.callCount(), 0)
  assert.equal(settled.mock.callCount(), 0)
  t.mock.timers.tick(1)
  assert.equal(await result, "timed out")
  assert.equal(timeout.mock.callCount(), 1)
  t.mock.timers.tick(1000)
  assert.equal(timeout.mock.callCount(), 1)
})

test("cancels the deadline when work settles first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const timeout = t.mock.fn(() => 99)
  assert.equal(await raceDeadline(Promise.resolve(7), 1000, timeout, { ref: true }), 7)
  t.mock.timers.tick(1000)
  assert.equal(timeout.mock.callCount(), 0)
})

test("propagates a throwing timeout handler", async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  try {
    await assert.rejects(
      raceDeadline(
        pending,
        1,
        () => {
          throw new Error("expired")
        },
        { ref: true }
      ),
      /expired/
    )
  } finally {
    resolve()
  }
})
