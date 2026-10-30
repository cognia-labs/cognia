import { test } from "node:test"
import assert from "node:assert/strict"
import { createSemanticConsumers } from "./semantic-consumers.ts"
import type { PendingPluginHooks } from "./kernel/types.ts"
import type { PendingApproval } from "../policy/permission/approval.ts"

function harness(
  answer: (frame: Record<string, unknown>) => unknown,
  options: { respond?: boolean; approvalTtlMs?: number } = {}
) {
  const controller = new AbortController()
  const pendingPluginHookCalls: PendingPluginHooks = new Map()
  const pendingApprovals = new Map<string, PendingApproval>()
  const frames: Record<string, unknown>[] = []
  const consumers = createSemanticConsumers({
    sessionId: "session",
    signal: controller.signal,
    sendOptions: {
      semanticInterceptors: ["model.stream.transform", "agent.turn.decide"],
      approvalTtlMs: options.approvalTtlMs ?? 100,
    },
    pendingPluginHookCalls,
    pendingApprovals,
    emit: (frame) => {
      frames.push(frame)
      if (frame.type === "plugin_hook_exec" && options.respond !== false)
        queueMicrotask(() =>
          pendingPluginHookCalls.get(String(frame.execId))?.resolve(answer(frame))
        )
    },
  })
  return { consumers, pendingPluginHookCalls, pendingApprovals, controller, frames }
}
test("accepts presentation text only and retains transport identity", async () => {
  const h = harness(() => ({
    result: { part: { type: "tool-call", id: "forged", text: "projected" } },
  }))
  assert.deepEqual(
    await h.consumers.transform({ type: "text-delta", id: "original", text: "raw" }),
    { type: "text-delta", id: "original", text: "projected" }
  )
  assert.equal(h.pendingPluginHookCalls.size, 0)
})

test("one turn keeps a stable operation identity across chunks and steps", async () => {
  const answer = (frame: Record<string, unknown>) => ({
    result:
      frame.hookId === "interceptor:agent.turn.decide"
        ? { decision: "pass" }
        : { part: { text: "safe" } },
  })
  const h = harness(answer)
  await h.consumers.transform({ type: "text-delta", text: "one" })
  await h.consumers.transform({ type: "text-delta", text: "two" })
  await h.consumers.beforeStep(0)
  const payloads = h.frames.map((frame) => frame.payload as { operationId: string })
  assert.equal(new Set(payloads.map((payload) => payload.operationId)).size, 1)
  assert.equal(new Set(h.frames.map((frame) => frame.execId)).size, 3)
  const next = harness(answer)
  await next.consumers.beforeStep(0)
  assert.notEqual(
    (next.frames[0]!.payload as { operationId: string }).operationId,
    payloads[0]!.operationId
  )
})
test("a denied step never becomes approval", async () => {
  const h = harness(() => ({ result: { decision: "deny", reason: "stop here" } }))
  await assert.rejects(h.consumers.beforeStep(0), /stop here/)
  assert.equal(h.pendingApprovals.size, 0)
})
test("requireApproval uses the existing scoped permission waiter", async () => {
  const h = harness(() => ({ result: { decision: "requireApproval", reason: "ask" } }))
  const waiting = h.consumers.beforeStep(0)
  await new Promise((resolve) => setTimeout(resolve, 1))
  const frame = h.frames.find((frame) => frame.type === "permission_request")!
  assert.equal(frame.sessionId, "session")
  assert.equal(frame.requiresPerCallApproval, true)
  h.pendingApprovals.get(String(frame.requestId))!.resolve({ behavior: "allow" })
  await waiting
  assert.equal(h.pendingApprovals.size, 0)
})
test("aborting an approval prevents a late answer and drains ownership", async () => {
  const h = harness(() => ({ result: { decision: "requireApproval", reason: "ask" } }))
  const waiting = h.consumers.beforeStep(1)
  await new Promise((resolve) => setTimeout(resolve, 1))
  h.controller.abort()
  await assert.rejects(waiting, { name: "AbortError" })
  assert.equal(h.pendingApprovals.size, 0)
  assert.equal(h.pendingPluginHookCalls.size, 0)
})

test("aborting an outstanding projection drains the bridge and rejects late output", async () => {
  const h = harness(() => undefined, { respond: false })
  const waiting = h.consumers.transform({ type: "text-delta", text: "raw" })
  const pending = [...h.pendingPluginHookCalls.values()][0]!
  h.controller.abort()
  await assert.rejects(waiting, { name: "AbortError" })
  pending.resolve({ result: { part: { text: "late" } } })
  assert.equal(h.pendingPluginHookCalls.size, 0)
  assert.equal(h.pendingApprovals.size, 0)
})

test("a bridge timeout requires explicit approval and its TTL denies unattended continuation", async () => {
  const h = harness(() => ({ timedOut: true }), { approvalTtlMs: 5 })
  const waiting = h.consumers.beforeStep(2)
  // Keep the test alive while the production permission waiter's unref timer expires.
  await Promise.all([
    assert.rejects(waiting, /timed out/),
    new Promise((resolve) => setTimeout(resolve, 15)),
  ])
  assert.equal(h.frames.filter((frame) => frame.type === "permission_request").length, 1)
  assert.equal(h.pendingApprovals.size, 0)
  assert.equal(h.pendingPluginHookCalls.size, 0)
})

test("a failed stream bridge refuses an unprojected presentation", async () => {
  const h = harness(() => ({ error: "renderer unavailable" }))
  await assert.rejects(
    h.consumers.transform({ type: "reasoning-delta", text: "raw" }),
    /renderer unavailable/
  )
  assert.equal(h.pendingPluginHookCalls.size, 0)
})
