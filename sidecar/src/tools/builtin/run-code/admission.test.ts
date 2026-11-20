import { test } from "node:test"
import assert from "node:assert/strict"

import { createRunAdmission } from "./admission.ts"
import type { RunAdmission } from "./admission.ts"

const LIMITS = {
  maxConcurrentRunsPerSession: 1,
  maxConcurrentRunsPerHost: 2,
  maxAdmissionWaitMs: 5_000,
}

function granted(admission: RunAdmission) {
  assert.equal(admission.ok, true)
  return (admission as Extract<RunAdmission, { ok: true }>).release
}

/** Whether a pending admission has settled yet. */
async function settled(pending: Promise<RunAdmission>) {
  return Promise.race([pending.then(() => true), new Promise((r) => setImmediate(() => r(false)))])
}

test("a session runs its programs one after another", async () => {
  const admission = createRunAdmission()
  const first = granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  const second = admission.acquire({ sessionId: "a", limits: LIMITS })
  assert.equal(await settled(second), false)
  first()
  granted(await second)()
  assert.equal(admission.running().host, 0)
})

test("the Host runs at most its limit across sessions", async () => {
  const admission = createRunAdmission()
  const a = granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  granted(await admission.acquire({ sessionId: "b", limits: LIMITS }))
  const third = admission.acquire({ sessionId: "c", limits: LIMITS })
  assert.equal(await settled(third), false)
  assert.equal(admission.running().host, 2)
  a()
  granted(await third)
})

test("a waiter held by its own session does not block another session", async () => {
  const admission = createRunAdmission()
  granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  const sameSession = admission.acquire({ sessionId: "a", limits: LIMITS })
  const other = await admission.acquire({ sessionId: "b", limits: LIMITS })
  assert.equal(other.ok, true)
  assert.equal(await settled(sameSession), false)
})

test("a session's waiting programs start in the order it asked", async () => {
  const admission = createRunAdmission()
  const running = granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  const order: string[] = []
  const first = admission.acquire({ sessionId: "a", limits: LIMITS }).then((r) => {
    order.push("first")
    return r
  })
  const second = admission.acquire({ sessionId: "a", limits: LIMITS }).then((r) => {
    order.push("second")
    return r
  })
  running()
  granted(await first)()
  await second
  assert.deepEqual(order, ["first", "second"])
})

test("cancelling the turn withdraws a waiting program", async () => {
  const admission = createRunAdmission()
  granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  const controller = new AbortController()
  const waiting = admission.acquire({ sessionId: "a", signal: controller.signal, limits: LIMITS })
  controller.abort()
  assert.deepEqual(await waiting, { ok: false, reason: "cancelled" })
  assert.equal(admission.waiting(), 0)
})

test("an already-cancelled turn is never admitted", async () => {
  const admission = createRunAdmission()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(
    await admission.acquire({ sessionId: "a", signal: controller.signal, limits: LIMITS }),
    { ok: false, reason: "cancelled" }
  )
  assert.equal(admission.running().host, 0)
})

test("waiting past the bound refuses with the limit that held it", async () => {
  const admission = createRunAdmission()
  granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  const refused = await admission.acquire({
    sessionId: "a",
    limits: { ...LIMITS, maxAdmissionWaitMs: 20 },
  })
  assert.deepEqual(refused, {
    ok: false,
    reason: "busy",
    limit: { kind: "concurrent-runs-session", limit: 1 },
  })
  assert.equal(admission.waiting(), 0)
})

test("release is idempotent", async () => {
  const admission = createRunAdmission()
  const release = granted(await admission.acquire({ sessionId: "a", limits: LIMITS }))
  release()
  release()
  assert.equal(admission.running().host, 0)
  assert.equal(admission.running().sessions.size, 0)
})

test("a caller with no session is bounded by the Host limit only", async () => {
  const admission = createRunAdmission()
  granted(await admission.acquire({ limits: LIMITS }))
  granted(await admission.acquire({ limits: LIMITS }))
  const third = admission.acquire({ limits: { ...LIMITS, maxAdmissionWaitMs: 20 } })
  assert.deepEqual(await third, {
    ok: false,
    reason: "busy",
    limit: { kind: "concurrent-runs-host", limit: 2 },
  })
})
