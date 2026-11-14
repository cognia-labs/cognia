import assert from "node:assert/strict"
import test from "node:test"
import { createHostRpc, type HostRpcRequestFrame } from "../../platform/host-rpc.ts"
import { createWorkerToolAdmission, FenceDeniedError } from "./admission.ts"

test("relative TTL starts at request send and only the final synchronous check reads it", async () => {
  let time = 100
  let calls = 0
  let denied = 0
  const admission = createWorkerToolAdmission({
    sessionId: "session",
    now: () => time,
    onDenied: () => {
      denied++
    },
    hostRpc: {
      async call(method, params, options) {
        calls++
        assert.equal(method, "worker.admitTool")
        assert.deepEqual(params, { sessionId: "session", toolName: "Read", toolUseId: "tool" })
        assert.equal(options?.timeoutMs, 5000)
        time = 140 // forty ms of transit consumes forty ms of the grant
        return { allowed: true, leaseTtlMs: 50 }
      },
    },
  })
  await admission.admit("Read", "tool")
  admission.assertAllowed()
  time = 150
  // The grant was measured from the send at 100, so it lapsed at 150.
  assert.throws(() => admission.assertAllowed(), FenceDeniedError)
  assert.equal(calls, 1)
  assert.equal(denied, 1)
  assert.throws(() => admission.assertOpen(), FenceDeniedError)
})

test("a lease renewed past the cached deadline is admitted again, not latched closed", async () => {
  let time = 0
  let calls = 0
  let renewed = false
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {},
    hostRpc: {
      async call() {
        calls++
        return renewed ? { allowed: true, leaseTtlMs: 1_000 } : { allowed: true, leaseTtlMs: 100 }
      },
    },
  })
  await admission.admit("Read")
  // A long model call or approval wait crosses the first grant; meanwhile the
  // brain renewed the lease on the Node authority.
  time = 500
  renewed = true
  await admission.admit("Write")
  admission.assertAllowed()
  assert.equal(calls, 2)
  time = 1_499
  admission.assertAllowed()
  time = 1_500
  assert.throws(() => admission.assertAllowed(), FenceDeniedError)
})

test("an expired cached deadline still asks Node, and a refusal then latches", async () => {
  let time = 0
  let calls = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {},
    hostRpc: {
      async call(_method, _params, options) {
        calls++
        if (calls === 1) return { allowed: true, leaseTtlMs: 10 }
        // The lapsed deadline does not shrink the bound to zero.
        assert.equal(options?.timeoutMs, 5000)
        return { allowed: false }
      },
    },
  })
  await admission.admit("Read")
  time = 50
  await assert.rejects(admission.admit("Write"), FenceDeniedError)
  await assert.rejects(admission.admit("Write"), FenceDeniedError)
  assert.throws(() => admission.assertOpen(), FenceDeniedError)
  assert.equal(calls, 2)
})

test("a refusal latches all later calls without another round trip", async () => {
  let calls = 0
  let denied = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied: () => {
      denied++
    },
    hostRpc: {
      async call() {
        calls++
        return { allowed: false }
      },
    },
  })
  await assert.rejects(admission.admit("plugin"), FenceDeniedError)
  await assert.rejects(admission.admit("mcp"), FenceDeniedError)
  assert.equal(calls, 1)
  assert.equal(denied, 1)
})

test("RPC errors fail closed", async () => {
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied() {},
    hostRpc: {
      async call() {
        throw new Error("disconnected")
      },
    },
  })
  await assert.rejects(admission.admit("Read"), FenceDeniedError)
})

test("a refresh near the old deadline waits its full bound for a renewed grant", async () => {
  const frames: HostRpcRequestFrame[] = []
  const rpc = createHostRpc({ emit: (frame) => frames.push(frame) })
  let time = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    hostRpc: rpc,
    now: () => time,
    onDenied() {},
  })
  const first = admission.admit("Read")
  rpc.resolveResult({
    rpcId: frames[0]!.rpcId,
    ok: true,
    result: { allowed: true, leaseTtlMs: 15 },
  })
  await first
  // One millisecond of the first grant left; the reply takes ten.
  time = 14
  const second = admission.admit("Write")
  time = 24
  rpc.resolveResult({
    rpcId: frames[1]!.rpcId,
    ok: true,
    result: { allowed: true, leaseTtlMs: 1000 },
  })
  await second
  admission.assertAllowed()
  admission.assertOpen()
})

test("a renewal that shortens the lease is honoured over a longer cached grant", async () => {
  let time = 0
  let ttl = 1000
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {},
    hostRpc: {
      async call() {
        const answer = { allowed: true, leaseTtlMs: ttl }
        time += 6
        return answer
      },
    },
  })
  await admission.admit("Read") // sent at 0, grant to 1000
  time = 10
  ttl = 5 // the brain shortened the lease: sent at 10, grant to 15, reply at 16
  await assert.rejects(admission.admit("Write"), FenceDeniedError)
  // The newer, shorter grant replaced the longer one, and its lapse latches.
  assert.throws(() => admission.assertAllowed(), FenceDeniedError)
  assert.throws(() => admission.assertOpen(), FenceDeniedError)
})

test("a grant that lapsed in transit stops a concurrent call that later gets a valid grant", async () => {
  let time = 0
  let interrupts = 0
  const replies: Array<(answer: unknown) => void> = []
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {
      interrupts++
    },
    hostRpc: {
      call: () =>
        new Promise((resolve) => {
          replies.push(resolve)
        }),
    },
  })
  const a = admission.admit("Read") // sent at 0
  const b = admission.admit("Write") // sent at 0
  time = 20
  replies[0]!({ allowed: true, leaseTtlMs: 10 }) // lapsed at 10, seen at 20
  await assert.rejects(a, FenceDeniedError)
  replies[1]!({ allowed: true, leaseTtlMs: 1000 })
  await assert.rejects(b, FenceDeniedError)
  assert.equal(interrupts, 1)
})

test("an older reply arriving late never replaces a newer-sent grant", async () => {
  let time = 0
  const replies: Array<(answer: unknown) => void> = []
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {},
    hostRpc: {
      call: () =>
        new Promise((resolve) => {
          replies.push(resolve)
        }),
    },
  })
  const older = admission.admit("Read") // sent at 0
  time = 10
  const newer = admission.admit("Write") // sent at 10
  replies[1]!({ allowed: true, leaseTtlMs: 20 }) // grant to 30
  await newer
  replies[0]!({ allowed: true, leaseTtlMs: 1000 }) // older view: to 1000
  await older
  time = 30
  assert.throws(() => admission.assertAllowed(), FenceDeniedError)
})

test("the five-second ceiling applies even if a caller ignores timeoutMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let stopped = false
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied() {
      stopped = true
    },
    hostRpc: { call: () => new Promise(() => {}) },
  })
  const pending = assert.rejects(admission.admit("Read"), FenceDeniedError)
  t.mock.timers.tick(5000)
  await pending
  assert.equal(stopped, true)
})

test("channel close denies an in-flight call and latches subsequent calls", async () => {
  const frames: HostRpcRequestFrame[] = []
  const rpc = createHostRpc({ emit: (frame) => frames.push(frame) })
  const admission = createWorkerToolAdmission({ sessionId: "s", hostRpc: rpc, onDenied() {} })
  const call = admission.admit("Read")
  rpc.rejectAll("host channel closed")
  await assert.rejects(call, FenceDeniedError)
  await assert.rejects(admission.admit("Write"), FenceDeniedError)
  assert.equal(frames.length, 1)
})

test("a closed or missing channel cannot admit the first call", async () => {
  const rpc = createHostRpc({
    emit() {
      assert.fail("closed channel emitted")
    },
  })
  rpc.rejectAll()
  for (const hostRpc of [rpc, undefined]) {
    const admission = createWorkerToolAdmission({ sessionId: "s", hostRpc, onDenied() {} })
    await assert.rejects(admission.admit("Read"), FenceDeniedError)
  }
})

test("a channel closed after a grant is denied by the final synchronous check", async () => {
  let closed = false
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied() {},
    hostRpc: {
      get isClosed() {
        return closed
      },
      async call() {
        return { allowed: true, leaseTtlMs: 10000 }
      },
    },
  })
  await admission.admit("Read")
  closed = true
  assert.throws(() => admission.assertAllowed(), FenceDeniedError)
})

test("invalid grants and replies arriving after their TTL are denied", async () => {
  for (const answer of [
    { allowed: true },
    { allowed: true, leaseTtlMs: -1 },
    { allowed: true, leaseTtlMs: Infinity },
    { allowed: true, leaseTtlMs: 2 },
    null,
  ]) {
    let now = 0
    const admission = createWorkerToolAdmission({
      sessionId: "s",
      now: () => now,
      onDenied() {},
      hostRpc: {
        async call() {
          now = 3
          return answer
        },
      },
    })
    await assert.rejects(admission.admit("Read"), FenceDeniedError)
  }
})

test("a late concurrent grant cannot reopen a denied session", async () => {
  let grant!: (answer: unknown) => void
  let calls = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied() {},
    hostRpc: {
      call() {
        return ++calls === 1
          ? new Promise((resolve) => {
              grant = resolve
            })
          : Promise.resolve({ allowed: false })
      },
    },
  })
  const late = admission.admit("Read")
  await assert.rejects(admission.admit("Write"), FenceDeniedError)
  grant({ allowed: true, leaseTtlMs: 10000 })
  await assert.rejects(late, FenceDeniedError)
  await assert.rejects(admission.admit("Read"), FenceDeniedError)
  assert.equal(calls, 2)
})

test("an older reply sent in the same clock tick never replaces a newer, shorter grant", async () => {
  let time = 0
  const replies: Array<(answer: unknown) => void> = []
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    now: () => time,
    onDenied() {},
    hostRpc: {
      call: () =>
        new Promise((resolve) => {
          replies.push(resolve)
        }),
    },
  })
  const older = admission.admit("Read") // sent at 0
  const newer = admission.admit("Write") // also sent at 0
  replies[1]!({ allowed: true, leaseTtlMs: 10 })
  await newer
  time = 20
  replies[0]!({ allowed: true, leaseTtlMs: 1000 })
  // The older call is judged by the newest grant, which lapsed at 10.
  await assert.rejects(older, FenceDeniedError)
})
