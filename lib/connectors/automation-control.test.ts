/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  conversationAutomationState,
  waitForConversationAutomation,
  cancelConversationAutomations,
  retainConversationAutomationsOnResume,
} from "./automation-control"

jest.mock("@/lib/bot/runtime/run", () => ({
  cancelAcceptedBotDeliveries: jest.fn().mockResolvedValue(1),
}))
jest.mock("@/lib/workflow/runtime/cancel-run", () => ({
  cancelWorkflowRun: jest.fn().mockResolvedValue({ cancelled: true }),
}))

beforeEach(() => {
  __resetDbForTesting()
})

it("separates subscription pause from responder mute and manual mode", async () => {
  await getDb().conversationOverrides.put({
    id: "c",
    conversationKey: "one",
    sessionId: "s",
    mode: "manual",
    muted: true,
    createdAt: 1,
    updatedAt: 1,
  })
  expect(await conversationAutomationState("one", 10)).toEqual({ paused: false, cancelled: false })
  await getDb().conversationOverrides.update("c", { automationPaused: true })
  expect(await conversationAutomationState("one", 10)).toEqual({ paused: true, cancelled: false })
  expect(await conversationAutomationState("other", 10)).toEqual({
    paused: false,
    cancelled: false,
  })
})

it("retains an accepted waiter until resume and cancels old work without cancelling future events", async () => {
  const db = getDb()
  await db.conversationOverrides.put({
    id: "c",
    conversationKey: "one",
    sessionId: "s",
    automationPaused: true,
    createdAt: 1,
    updatedAt: 1,
  })
  let started = false
  const waiting = waitForConversationAutomation("one", 10).then((allowed) => {
    started = allowed
    return allowed
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(started).toBe(false)
  await db.conversationOverrides.update("c", { automationPaused: false })
  await expect(waiting).resolves.toBe(true)
  await db.conversationOverrides.update("c", { automationPaused: true })
  const cancelled = waitForConversationAutomation("one", 10)
  await db.conversationOverrides.update("c", { automationCancelledBefore: 20 })
  await expect(cancelled).resolves.toBe(false)
  await db.conversationOverrides.update("c", { automationPaused: false })
  expect(await waitForConversationAutomation("one", 30)).toBe(true)
})

it("cancels only owned subscription work in the same adapter/chat accepted by the cutoff", async () => {
  const db = getDb()
  for (const [id, adapterId, conversationKey, receivedAt, mirrored] of [
    ["match", "a", "one", 10, false],
    ["other-adapter", "b", "one", 10, false],
    ["other-chat", "a", "two", 10, false],
    ["future", "a", "one", 30, false],
    ["mirror", "a", "one", 10, true],
  ] as const)
    await db.botEventDeliveries.put({
      id,
      installationId: "bot",
      receivedAt,
      ...(mirrored ? { syncedFromHost: true } : {}),
      envelope: { binding: { adapterId, conversationKey } },
    } as never)
  for (const [id, triggerKind, conversationKey] of [
    ["observer", "trigger.connector.inbound", "one"],
    ["manual", "trigger.manual", "one"],
    ["other", "trigger.connector.inbound", "two"],
  ])
    await db.workflowRuns.put({
      id,
      triggerKind,
      triggerOriginAt: 10,
      startedAt: 40,
      triggerBinding: { adapterId: "a", conversationKey },
    } as never)
  await cancelConversationAutomations("a", "one", 20)
  const bot = await import("@/lib/bot/runtime/run")
  const workflow = await import("@/lib/workflow/runtime/cancel-run")
  expect(bot.cancelAcceptedBotDeliveries).toHaveBeenCalledTimes(1)
  expect(bot.cancelAcceptedBotDeliveries).toHaveBeenCalledWith("bot", "match")
  expect(workflow.cancelWorkflowRun).toHaveBeenCalledTimes(1)
  expect(workflow.cancelWorkflowRun).toHaveBeenCalledWith(
    "observer",
    "Conversation automation cancelled"
  )
})

it("refreshes retained Bot deadlines only for the resumed conversation", async () => {
  const db = getDb()
  await db.conversationOverrides.put({
    id: "c",
    conversationKey: "one",
    sessionId: "s",
    automationPaused: true,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.botEventDeliveries.put({
    id: "accepted",
    status: "parked",
    envelope: { binding: { conversationKey: "one" } },
  } as never)
  await db.botEventDeliveries.put({
    id: "other",
    status: "parked",
    envelope: { binding: { conversationKey: "two" } },
  } as never)
  await retainConversationAutomationsOnResume("one")
  expect((await db.botEventDeliveries.get("accepted"))?.retentionExtendedAt).toEqual(
    expect.any(Number)
  )
  expect((await db.botEventDeliveries.get("other"))?.retentionExtendedAt).toBeUndefined()
})

it.each(["caller", "run", "lease"])(
  "releases a paused waiter when its %s is cancelled",
  async (kind) => {
    const db = getDb()
    await db.conversationOverrides.put({
      id: "paused-wait",
      conversationKey: "cancel-wait",
      sessionId: "s",
      automationPaused: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.workflowRuns.put({ id: "paused-run", status: "pending" } as never)
    const controller = new AbortController()
    let markListening!: () => void
    const listening = new Promise<void>((resolve) => {
      markListening = resolve
    })
    const originalAdd = controller.signal.addEventListener.bind(controller.signal)
    const added = jest
      .spyOn(controller.signal, "addEventListener")
      .mockImplementation((type, listener, options) => {
        originalAdd(type, listener, options)
        if (type === "abort") markListening()
      })
    const removed = jest.spyOn(controller.signal, "removeEventListener")
    const waiting = waitForConversationAutomation("cancel-wait", 10, {
      signal: controller.signal,
      runId: "paused-run",
    }).then(
      (allowed) => ({ kind: "allowed", allowed }),
      (error: Error) => ({ kind: "error", message: error.message })
    )
    await listening
    if (kind === "caller") controller.abort(new Error("caller stopped"))
    else if (kind === "lease") await db.workflowRuns.update("paused-run", { cancelRequestedAt: 20 })
    else await db.workflowRuns.update("paused-run", { status: "cancelled" })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        waiting,
        new Promise((resolve) => {
          deadline = setTimeout(() => resolve({ kind: "timeout" }), 1_000)
        }),
      ])
      expect(outcome).toEqual(
        kind === "caller"
          ? { kind: "error", message: "caller stopped" }
          : { kind: "allowed", allowed: false }
      )
      expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
      if (kind === "lease")
        expect((await db.workflowRuns.get("paused-run"))?.status).toBe("pending")
    } finally {
      if (deadline) clearTimeout(deadline)
      await db.conversationOverrides.update("paused-wait", { automationPaused: false })
      await waiting
      added.mockRestore()
      removed.mockRestore()
    }
  }
)

it("aborts a wait even while its initial database read is blocked", async () => {
  const db = getDb()
  let markLocked!: () => void
  let release!: () => void
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = db.transaction("rw", db.conversationOverrides, async () => {
    await db.conversationOverrides.get("locked-wait")
    markLocked()
    await Dexie.waitFor(gate)
  })
  await locked
  const controller = new AbortController()
  const waiting = Dexie.ignoreTransaction(() =>
    waitForConversationAutomation("locked-chat", 10, { signal: controller.signal })
  ).then(
    () => ({ kind: "resolved" }),
    (error: Error) => ({ kind: "rejected", message: error.message })
  )
  controller.abort(new Error("blocked caller stopped"))
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ kind: "timeout" }), 1_000)
      }),
    ])
    expect(outcome).toEqual({ kind: "rejected", message: "blocked caller stopped" })
  } finally {
    if (deadline) clearTimeout(deadline)
    release()
    await writer
    await waiting
  }
})

it("rejects and releases the listener when the captured database is closed", async () => {
  const db = getDb()
  await whenSeeded()
  await db.open()
  db.close()
  const controller = new AbortController()
  const removed = jest.spyOn(controller.signal, "removeEventListener")
  const waiting = waitForConversationAutomation("closed-chat", 10, {
    signal: controller.signal,
  }).then(
    () => ({ kind: "resolved" }),
    (error: Error) => ({ kind: "rejected", name: error.name })
  )
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ kind: "timeout" }), 1_000)
      }),
    ])
    expect(outcome).toEqual({ kind: "rejected", name: "DatabaseClosedError" })
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
  } finally {
    if (deadline) clearTimeout(deadline)
    await db.open()
    controller.abort()
    await waiting
    removed.mockRestore()
  }
})
