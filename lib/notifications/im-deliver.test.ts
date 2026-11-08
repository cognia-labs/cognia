/**
 * Tests for lib/notifications/im-deliver.ts: which IM conversation a record
 * belongs in, and handing it to that conversation's channel. Posting it (the
 * opt-in, the PII gate, the card) is the channel's, tested beside
 * `lib/connectors/notifications/im-deliver.ts`.
 */

import { createImDeliver, deliverRecordToIM, type ImDeliverDeps } from "./im-deliver"
import type { NotificationRecord } from "@/types/notifications"
import type { ConversationChannel } from "@/types/modules/ports/conversation-channel"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    source: "connector",
    level: "info",
    title: "Task done",
    body: "Your build finished.",
    createdAt: 0,
    updatedAt: 0,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    sourceRef: { kind: "conversation", id: "telegram:tg-1:9" },
    ...over,
  }
}

function harness(opts: {
  sessions?: Record<string, { platformBinding?: { conversationKey?: string } }>
  runBindings?: Record<string, Array<{ conversationKey?: string }>>
  /** No active channel serves the conversation. */
  noChannel?: boolean
}) {
  const delivered: Array<{ record: NotificationRecord; conversationKey: string }> = []
  const asked: string[] = []
  const channel = {
    deliverNotification: jest.fn(
      async (input: { record: NotificationRecord; conversationKey: string }) => {
        delivered.push(input)
        return { status: "pushed" as const, conversationKey: input.conversationKey }
      }
    ),
  }
  const deps: ImDeliverDeps = {
    getSession: async (id) => opts.sessions?.[id],
    listRunBindings: (async (runId: string) =>
      opts.runBindings?.[runId] ?? []) as unknown as ImDeliverDeps["listRunBindings"],
    channelFor: async (binding) => {
      asked.push(binding.conversationKey)
      return opts.noChannel ? null : (channel as unknown as ConversationChannel)
    },
  }
  return { delivered, asked, channel, deps }
}

describe("deliverRecordToIM", () => {
  it("hands a conversation-scoped record to the conversation's channel", async () => {
    const h = harness({})
    expect(await deliverRecordToIM(rec(), h.deps)).toEqual({
      status: "pushed",
      conversationKey: "telegram:tg-1:9",
    })
    expect(h.asked).toEqual(["telegram:tg-1:9"])
    expect(h.delivered).toEqual([{ record: rec(), conversationKey: "telegram:tg-1:9" }])
  })

  it("skips, asking no channel, a record that belongs in no conversation", async () => {
    const h = harness({})
    expect(await deliverRecordToIM(rec({ sourceRef: { kind: "run", id: "x" } }), h.deps)).toEqual({
      status: "skipped",
      reason: "no-conversation",
    })
    expect(h.asked).toEqual([])
  })

  it("skips a conversation no active channel serves", async () => {
    const h = harness({ noChannel: true })
    expect(await deliverRecordToIM(rec(), h.deps)).toEqual({
      status: "skipped",
      reason: "no-channel",
      conversationKey: "telegram:tg-1:9",
    })
  })

  it("never throws when the channel rejects (fail-closed)", async () => {
    const h = harness({})
    h.channel.deliverNotification.mockRejectedValueOnce(new Error("queue down"))
    expect(await deliverRecordToIM(rec(), h.deps)).toEqual({ status: "error" })
    await expect(createImDeliver(h.deps)(rec())).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Conversation resolution: which records can reach IM at all
// ---------------------------------------------------------------------------

describe("deliverRecordToIM: conversation resolution", () => {
  const boundSession = { platformBinding: { conversationKey: "telegram:tg-1:9" } }

  // The gate was `sourceRef.kind === "conversation"` and a silent return, so a
  // plan awaiting approval was invisible in IM by construction, with nothing
  // recorded to say why. The plan hub sets `groupKey` to the plan's session id.
  it("reaches IM for a plan, through the session its groupKey names", async () => {
    const h = harness({ sessions: { s1: boundSession } })
    await deliverRecordToIM(
      rec({ sourceRef: { kind: "plan", id: "plan_1" }, groupKey: "s1" }),
      h.deps
    )
    expect(h.delivered.map((d) => d.conversationKey)).toEqual(["telegram:tg-1:9"])
  })

  it("reaches IM for a session-scoped record", async () => {
    const h = harness({ sessions: { s1: boundSession } })
    await deliverRecordToIM(rec({ sourceRef: { kind: "session", id: "s1" } }), h.deps)
    expect(h.delivered).toHaveLength(1)
  })

  // A run knows the conversation that started it, because the binding is
  // minted with the conversation key when the run is dispatched from IM.
  it.each(["run", "team-run", "background-run"])(
    "reaches IM for a %s through its execution-run binding",
    async (kind) => {
      const h = harness({ runBindings: { r1: [{ conversationKey: "telegram:tg-1:9" }] } })
      await deliverRecordToIM(rec({ sourceRef: { kind, id: "r1" } }), h.deps)
      expect(h.delivered).toHaveLength(1)
    }
  )

  // A run started on the desktop has no binding, and a record naming nothing
  // resolves to nothing. Widening WHERE a push can land must not widen WHETHER
  // one happens: the channel's opt-in still decides that.
  it("stays quiet for a run that never came from IM", async () => {
    const h = harness({ runBindings: { r1: [{}] } })
    await deliverRecordToIM(rec({ sourceRef: { kind: "run", id: "r1" } }), h.deps)
    expect(h.delivered).toHaveLength(0)
  })

  it("stays quiet for a record that names no entity at all", async () => {
    const h = harness({})
    await deliverRecordToIM(rec({ sourceRef: undefined, groupKey: undefined }), h.deps)
    expect(h.delivered).toHaveLength(0)
  })
})
