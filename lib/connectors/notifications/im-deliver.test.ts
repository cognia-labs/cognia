/**
 * Tests for the IM channel's notification delivery (`./im-deliver.ts`).
 * Which conversation a record belongs in is the kernel's, tested beside
 * `lib/notifications/im-deliver.ts`.
 */

import { deliverNotificationToConversation } from "./im-deliver"
import type { NotificationRecord } from "@/types/notifications"
import type { ChatSession } from "@cognia/agent-config-types"

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

function session(): ChatSession {
  return {
    id: "s1",
    title: "t",
    kind: "direct",
    platformConversationKey: "telegram:tg-1:9",
    platformBinding: {
      platform: "telegram",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: "9" },
      deliveryTarget: {
        address: {
          conversationKey: "telegram:tg-1:9",
          platform: "telegram",
          adapterId: "tg-1",
          scopeKind: "private",
          containerId: "9",
        },
        conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: "9" },
        refreshedAt: 0,
      },
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

interface Harness {
  enqueued: Array<{
    adapterId: string
    conversationKey: string
    idempotencyKey?: string
    segments: Array<Record<string, unknown>>
    authorization?: unknown
  }>
  audits: string[]
  deps: NonNullable<Parameters<typeof deliverNotificationToConversation>[1]>
}

function harness(opts: {
  hasSession?: boolean
  proactivePush?: boolean
  piiSafe?: boolean
  /** The outbound policy holds the push as a draft (ADR-0239). */
  heldAsDraft?: boolean
}): Harness {
  const enqueued: Harness["enqueued"] = []
  const audits: string[] = []
  const deps = {
    findSession: (async () =>
      opts.hasSession === false ? undefined : session()) as Harness["deps"]["findSession"],
    readOverride: (async () =>
      opts.proactivePush === undefined
        ? undefined
        : { proactivePush: opts.proactivePush }) as Harness["deps"]["readOverride"],
    enqueue: (async (job: {
      adapterId: string
      conversationKey: string
      request: {
        metadata?: { idempotencyKey?: string }
        segments: Array<Record<string, unknown>>
      }
      authorization?: unknown
    }) => {
      enqueued.push({
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        idempotencyKey: job.request.metadata?.idempotencyKey,
        segments: job.request.segments,
        authorization: job.authorization,
      })
      if (opts.heldAsDraft) return { kind: "drafted", draft: { id: "cdr_1" } }
      return { kind: "queued", job: { id: "job-1" } }
    }) as unknown as Harness["deps"]["enqueue"],
    audit: (async (e: { kind: string }) => {
      audits.push(e.kind)
    }) as unknown as Harness["deps"]["audit"],
    isPiiSafe: () => opts.piiSafe ?? true,
  }
  return { enqueued, audits, deps }
}

const KEY = "telegram:tg-1:9"

function deliver(record: NotificationRecord, deps: Harness["deps"]) {
  return deliverNotificationToConversation({ record, conversationKey: KEY }, deps)
}

describe("deliverNotificationToConversation", () => {
  it("enqueues a text push when opted in + PII-safe", async () => {
    const h = harness({ proactivePush: true, piiSafe: true })
    expect(await deliver(rec(), h.deps)).toEqual({ status: "pushed", conversationKey: KEY })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toMatchObject({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      idempotencyKey: "notify:n1",
      // The bound session's own conversation: its origin thread (ADR-0239).
      authorization: { kind: "unattended", ownerRef: "notification:n1", sessionId: "s1" },
    })
    expect(h.audits).toContain("notify.im_pushed")
  })

  it("does not report a push the outbound policy held as a draft as pushed", async () => {
    const h = harness({ proactivePush: true, piiSafe: true, heldAsDraft: true })
    expect(await deliver(rec(), h.deps)).toEqual({
      status: "skipped",
      reason: "held-as-draft",
      conversationKey: KEY,
    })
    expect(h.enqueued).toHaveLength(1)
    expect(h.audits).not.toContain("notify.im_pushed")
  })

  it("skips (no enqueue) when the conversation has not opted in", async () => {
    const h = harness({ proactivePush: false })
    expect(await deliver(rec(), h.deps)).toMatchObject({ status: "skipped", reason: "opt-in-off" })
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_skipped")
  })

  it("skips when no opt-in row exists at all (fail-closed default off)", async () => {
    const h = harness({ proactivePush: undefined })
    await deliver(rec(), h.deps)
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_skipped")
  })

  it("blocks + audits when the body fails the PII gate", async () => {
    const h = harness({ proactivePush: true, piiSafe: false })
    expect(await deliver(rec({ body: "card 4111 1111 1111 1111" }), h.deps)).toMatchObject({
      reason: "pii-blocked",
    })
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_pii_blocked")
  })

  it("does nothing when no bound session resolves the target", async () => {
    const h = harness({ hasSession: false, proactivePush: true })
    expect(await deliver(rec(), h.deps)).toEqual({
      status: "skipped",
      reason: "no-session",
      conversationKey: KEY,
    })
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })

  it("never throws when a dependency rejects (fail-closed)", async () => {
    const deps: Harness["deps"] = {
      findSession: async () => {
        throw new Error("dexie down")
      },
    }
    await expect(deliver(rec(), deps)).resolves.toEqual({ status: "error" })
  })
})

// ---------------------------------------------------------------------------
// Actions: a question needs its answers attached
// ---------------------------------------------------------------------------

describe("deliverNotificationToConversation: action buttons", () => {
  const approve = {
    id: "approve",
    label: "Approve",
    command: "plan.approval.respond",
    args: { planId: "p1", decision: "approve" },
    variant: "primary" as const,
  }

  it("sends an A2UI card carrying the record's actions", async () => {
    const h = harness({ proactivePush: true })
    await deliver(rec({ actions: [approve] }), h.deps)
    const segment = h.enqueued[0].segments[0] as {
      type: string
      content: { components: Record<string, Record<string, unknown>> }
    }
    expect(segment.type).toBe("a2ui")
    const button = segment.content.components.action_approve
    expect(button.component).toBe("Button")
    expect(button.bindingKind).toBe("notification_action")
    // The command and its args stay on the centre row: a card is pressable
    // long after it was sent, so baking them in would let a stale card run
    // work the record no longer offers.
    expect(button.bindingPayload).toEqual({ notificationId: "n1", actionId: "approve" })
  })

  // A record with no actions is a statement, and the plain-text path renders
  // it better on every platform.
  // The gate saw the title and body, which was the whole message while this
  // channel sent plain text. A card also renders the labels and the deep link,
  // and a PLUGIN can register an action, so its label is not necessarily
  // product-authored. Gating less than the card renders would let the buttons
  // carry out what the body was blocked for.
  it("gates the action labels and the deep link, not just the body", async () => {
    const blocked: string[] = []
    const h = harness({ proactivePush: true })
    ;(h.deps as { isPiiSafe: (t: string) => boolean }).isPiiSafe = (t) => {
      blocked.push(t)
      return !t.includes("secret")
    }
    await deliver(rec({ actions: [{ ...approve, label: "Approve secret" }] }), h.deps)
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_pii_blocked")
    expect(blocked[0]).toContain("Approve secret")
  })

  it("includes the href in what the gate sees", async () => {
    const seen: string[] = []
    const h = harness({ proactivePush: true })
    ;(h.deps as { isPiiSafe: (t: string) => boolean }).isPiiSafe = (t) => {
      seen.push(t)
      return true
    }
    await deliver(
      rec({ actions: [approve], href: "/?session=s1" } as Partial<NotificationRecord>),
      h.deps
    )
    expect(seen[0]).toContain("/?session=s1")
  })

  it("keeps the plain-text path for a record with no actions", async () => {
    const h = harness({ proactivePush: true })
    await deliver(rec(), h.deps)
    expect(h.enqueued[0].segments[0]).toMatchObject({ type: "text" })
  })
})
