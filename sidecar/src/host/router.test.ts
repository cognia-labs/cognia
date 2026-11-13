import test from "node:test"
import assert from "node:assert/strict"
import { blockUnsupportedCommand, routeCommand } from "./router.ts"

test("commands unsupported by the frozen adapter emit a typed capability_error", () => {
  const sessions = new Map([
    ["frozen", { runtimeAdapterId: "ai-sdk" }],
    ["legacy", {}],
  ])
  const out: unknown[] = []
  const emit = (m: unknown) => out.push(m)

  // ai-sdk supports compaction/set_mode; steer is unsupported on both rails.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "steer" }, emit),
    true
  )
  assert.deepEqual(out, [
    { type: "capability_error", sessionId: "frozen", capability: "steer", command: "steer" },
  ])
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "compact" }, emit),
    false
  )
  // Legacy sessions and unknown sessions are never blocked.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "legacy", type: "steer" }, emit),
    false
  )
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "ghost", type: "steer" }, emit),
    false
  )
})

// ---- Command routing must never take the process down ----------------------

function routerHarness(handlers: Parameters<typeof routeCommand>[1]["handlers"]) {
  const emitted: unknown[] = []
  const logged: string[][] = []
  const sessions = new Map()
  const route = (msg: Parameters<typeof routeCommand>[0]) =>
    routeCommand(msg, {
      emit: (payload) => emitted.push(payload),
      log: (level, line) => logged.push([level, line]),
      sessions,
      handlers,
    })
  return { emitted, logged, sessions, route }
}

test("a send whose handler throws ends that session instead of escaping the read loop", () => {
  const closed: unknown[] = []
  const { emitted, logged, sessions, route } = routerHarness({
    send: () => {
      throw new Error("Unsupported runtime adapter: external")
    },
  })
  sessions.set("s1", {
    closeInput: () => closed.push("closeInput"),
    q: { close: () => closed.push("q.close") },
  })
  assert.doesNotThrow(() =>
    route({ type: "send", sessionId: "s1", prompt: "hi", options: { turnId: "t1" } })
  )
  assert.deepEqual(emitted, [
    {
      type: "session_ended",
      sessionId: "s1",
      turnId: "t1",
      error: "send failed: Unsupported runtime adapter: external",
    },
  ])
  assert.deepEqual(closed, ["closeInput", "q.close"])
  assert.equal(sessions.has("s1"), false)
  assert.equal(logged[0]![0], "error")
})

test("a rejected async command is logged and does not become an unhandled rejection", async () => {
  const { emitted, logged, route } = routerHarness({
    interrupt: async () => {
      throw new Error("no session")
    },
  })
  route({ type: "interrupt", sessionId: "s1" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(emitted, [])
  assert.deepEqual(logged, [["error", "interrupt failed: no session"]])
})

test("a send that fails without a session id is only logged", () => {
  const { emitted, logged, route } = routerHarness({
    send: () => {
      throw new Error("boom")
    },
  })
  route({ type: "send" })
  assert.deepEqual(emitted, [])
  assert.equal(logged.length, 1)
})

test("an unknown command type is a warning, not a crash", () => {
  const { logged, route } = routerHarness({})
  route({ type: "nope" })
  assert.deepEqual(logged, [["warn", "unknown command type: nope"]])
})

test("acknowledges a sticky egress fence before returning to the Host", () => {
  const { sessions, route, emitted } = routerHarness({
    control: () => {
      throw new Error("must not reach SDK")
    },
  })
  const sendOptions = { personalEgressFenced: false }
  sessions.set("private", { sendOptions })
  route({
    type: "control",
    sessionId: "private",
    requestId: "fence-1",
    method: "updateSettings",
    params: { personalEgressFence: true },
  })
  assert.equal(sendOptions.personalEgressFenced, true)
  assert.deepEqual(emitted, [
    {
      type: "control_response",
      sessionId: "private",
      requestId: "fence-1",
      method: "updateSettings",
      ok: true,
      result: { personalEgressFenced: true },
    },
  ])
})

test("G3: Host fence ACK follows quiescence and failed proof returns refusal", async () => {
  const { sessions, route, emitted } = routerHarness({})
  let finish!: () => void
  const quiesced = new Promise<void>((resolve) => {
    finish = resolve
  })
  sessions.set("s", { sendOptions: {}, fencePersonalEgress: () => quiesced })
  route({
    type: "control",
    sessionId: "s",
    requestId: "r",
    method: "updateSettings",
    params: { personalEgressFence: true },
  })
  assert.equal(emitted.length, 0)
  finish()
  await quiesced
  await Promise.resolve()
  assert.equal((emitted[0] as { ok?: boolean })?.ok, true)
  sessions.set("bad", {
    sendOptions: {},
    fencePersonalEgress: async () => {
      throw new Error("process alive")
    },
  })
  route({
    type: "control",
    sessionId: "bad",
    requestId: "bad",
    method: "updateSettings",
    params: { personalEgressFence: true },
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal((emitted[1] as { ok?: boolean })?.ok, false)
})
