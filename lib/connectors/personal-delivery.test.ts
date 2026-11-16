/** @jest-environment jsdom */
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() },
}))
import { toast } from "sonner"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { explicitHostPersonalSinkContext } from "@/lib/execution/personal-sink"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { OutboundRequest, PlatformAdapter } from "@/types/connectors"
import { ConnectorDeliveryGateway } from "./delivery-gateway"
import { outboundReceipt } from "@/lib/policy/action-review/outbound-receipt"
import {
  checkConnectorPersonalSink,
  narrowPersonalDelivery,
  resolveConnectorSinkAudience,
  sendPersonalDeliveryNotice,
} from "./personal-delivery"

const adapters = new Map<string, PlatformAdapter>()
jest.mock("./bus", () => ({ getBus: () => ({ getAdapter: (id: string) => adapters.get(id) }) }))
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  adapters.clear()
})
afterAll(fixture.dispose)

const key = "lark:bot:oc_group"
const request = (): OutboundRequest => ({
  conversationRef: { platform: "lark", adapterId: "bot", channelId: "oc_group" },
  segments: [{ type: "text", text: "private detail" }],
  metadata: { idempotencyKey: crypto.randomUUID() },
})
function adapter(ephemeral = true): PlatformAdapter {
  const value = {
    id: "bot",
    meta: { type: "lark", capabilities: ephemeral ? ["send.ephemeral"] : [] },
    send: jest.fn(async () => ({ ok: true })),
    resolvePersonalAudience: jest.fn(async (conversation: string) =>
      conversation.includes(":ou_")
        ? {
            kind: "person",
            person: {
              kind: "platform",
              platform: "lark",
              adapterId: "bot",
              remoteUserId: conversation.split(":")[2],
            },
          }
        : { kind: "group" }
    ),
  } as unknown as PlatformAdapter
  adapters.set(value.id, value)
  return value
}
async function marked(owner = true) {
  if (owner) {
    const instance: AdapterInstanceRow = {
      id: "bot",
      type: "lark",
      displayName: "Bot",
      enabled: true,
      transportMode: "webhook",
      settings: { connectedUser: { openId: "ou_owner" } },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 1,
    }
    await getDb().adapterInstances.put(instance)
  }
  const run = await startToolExecutionRun("personal-delivery", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [{ person: { kind: "local-person" }, source: "private-doc", markedAt: 1 }],
  })
  return { executionRunId: run.id }
}

it("proves the adapter peer, never infers a person from a group key", async () => {
  adapter()
  expect(await resolveConnectorSinkAudience("bot", key)).toEqual({ kind: "group" })
  expect(await resolveConnectorSinkAudience("bot", "lark:bot:ou_owner")).toMatchObject({
    kind: "person",
    person: { remoteUserId: "ou_owner" },
  })
  expect(await resolveConnectorSinkAudience("bot", "lark:foreign:ou_owner")).toMatchObject({
    kind: "unknown",
  })
})

it("allows a matching p2p recipient and narrows a group reply into one recipient-only card", async () => {
  const a = adapter()
  const context = await marked()
  expect(
    await checkConnectorPersonalSink(context, "bot", "lark:bot:ou_owner", request(), { adapter: a })
  ).toEqual({ outcome: "allow" })
  const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
  const result = await gateway.enqueueAuthorized(
    {
      adapterId: "bot",
      conversationKey: key,
      request: request(),
      source: "ai-run",
      authorization: { kind: "origin-reply", inboundConversationKey: key },
      personalContext: context,
    },
    { executionContext: context }
  )
  expect(result.kind).toBe("queued")
  if (result.kind !== "queued") throw new Error("expected queue")
  expect(result.job.request.metadata.larkEphemeral).toEqual({ recipientOpenId: "ou_owner" })
  expect(result.job.request.segments[0].type).toBe("card")
  expect(result.job.personalDeliveryNotice?.conversationKey).toBe(key)
  expect(a.send).not.toHaveBeenCalled()
  const receipts = await getDb().actionReviewReceipts.toArray()
  expect(
    receipts.some(
      (row) =>
        row.personal?.outcome === "withheld" &&
        row.personal.contentHash &&
        (row.personal.originalTarget as { conversationKey?: string })?.conversationKey === key
    )
  ).toBe(true)
})

it("uses a verified owner's direct message when ephemeral is unavailable, stripping original routes", async () => {
  const a = adapter(false)
  await marked()
  const narrowed = await narrowPersonalDelivery(
    a,
    key,
    {
      ...request(),
      metadata: {
        ...request().metadata,
        pendingPlacement: { invalid: true },
        sourceMessageId: "group-message",
        streamKey: "group-stream",
        resultCard: { sourceMessageId: "group-source", runId: "retained-run" },
      } as never,
      replyTo: { messageId: "om_group" },
      editTargetMessageId: "om_group",
      threadId: "om_thread",
    },
    { kind: "local-person" }
  )
  expect(narrowed?.conversationKey).toBe("lark:bot:ou_owner")
  expect(narrowed?.request).not.toHaveProperty("replyTo")
  expect(narrowed?.request).not.toHaveProperty("editTargetMessageId")
  expect(narrowed?.request).not.toHaveProperty("threadId")
  expect(narrowed?.request.metadata).not.toHaveProperty("pendingPlacement")
  expect(narrowed?.request.metadata).not.toHaveProperty("sourceMessageId")
  expect(narrowed?.request.metadata).not.toHaveProperty("streamKey")
  expect(narrowed?.request.metadata.resultCard).toEqual({ runId: "retained-run" })
})

it("direct-messages the marked person of this adapter themself, never another adapter's", async () => {
  const a = adapter(false)
  await marked()
  const alice = {
    kind: "platform" as const,
    platform: "lark" as const,
    adapterId: "bot",
    remoteUserId: "ou_alice",
  }
  const narrowed = await narrowPersonalDelivery(a, key, request(), alice)
  expect(narrowed?.conversationKey).toBe("lark:bot:ou_alice")
  expect(narrowed?.request.conversationRef.channelId).toBe("ou_alice")
  expect(narrowed?.request.segments).toEqual(request().segments)
  expect(
    await narrowPersonalDelivery(a, key, request(), { ...alice, adapterId: "other-bot" })
  ).toBeUndefined()
})

it("withholds without an addressable owner and sends only a fixed notice", async () => {
  const a = adapter(false)
  const context = await marked(false)
  const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
  await expect(
    gateway.enqueueAuthorized({
      adapterId: "bot",
      conversationKey: key,
      request: request(),
      source: "ai-run",
      authorization: { kind: "origin-reply", inboundConversationKey: key },
      personalContext: context,
    })
  ).rejects.toMatchObject({ reason: "personal" })
  const jobs = await getDb().outboundQueue.toArray()
  expect(jobs).toHaveLength(1)
  expect(JSON.stringify(jobs[0].request)).not.toContain("private detail")
  expect(JSON.stringify(jobs[0].request)).toContain("withheld")
})

it("withholds two people's content and does not treat operator approval as disclosure", async () => {
  const a = adapter()
  const context = await marked()
  const run = await getDb().executionRuns.get(context.executionRunId)
  await getDb().executionRuns.update(context.executionRunId, {
    personalMarks: [
      ...run!.personalMarks!,
      {
        person: { kind: "platform", platform: "lark", adapterId: "bot", remoteUserId: "ou_other" },
        source: "other-doc",
        markedAt: 2,
      },
    ],
  })
  expect(
    await checkConnectorPersonalSink(context, "bot", key, request(), {
      adapter: a,
      canNarrow: true,
    })
  ).toMatchObject({ outcome: "withhold" })
})

it("refuses a foreign person's private content at the Host draft boundary", async () => {
  const a = adapter()
  const context = await marked()
  await getDb().executionRuns.update(context.executionRunId, {
    personalMarks: [
      {
        person: { kind: "platform", platform: "lark", adapterId: "bot", remoteUserId: "ou_other" },
        source: "foreign-doc",
        markedAt: 1,
      },
    ],
  })
  const receipt = outboundReceipt({
    requestId: "draft-test",
    origin: { channel: "connector-delivery", scope: "connector" },
    subject: { kind: "connector-delivery", ref: "test" },
    plan: "draft",
    outcome: "deny",
    enforced: true,
    authority: "policy-default",
    reason: "hold",
    now: 1,
  })
  const gateway = new ConnectorDeliveryGateway({
    getAdapter: () => a,
    planDelivery: async (input) =>
      input.source === "manual"
        ? { action: "send", provenance: { mode: "enforce", plan: "exempt" } }
        : { action: "draft", draftSessionId: "host", receipt },
  })
  await expect(
    gateway.enqueueAuthorized({
      adapterId: "bot",
      conversationKey: key,
      request: request(),
      source: "ai-run",
      authorization: { kind: "unattended", ownerRef: "test" },
      personalContext: context,
    })
  ).rejects.toMatchObject({ reason: "personal" })
  expect(await getDb().connectorDrafts.count()).toBe(0)
  const queued = await getDb().outboundQueue.toArray()
  expect(queued).toHaveLength(1)
  expect(JSON.stringify(queued[0].request)).not.toContain("private detail")
  expect(
    (await getDb().actionReviewReceipts.toArray()).some(
      (row) =>
        row.personal?.outcome === "withheld" &&
        (row.personal.originalTarget as { kind?: string })?.kind === "connector-draft"
    )
  ).toBe(true)
})

it("supports segment-array immediate payloads and explicit content-free Host notices", async () => {
  const a = adapter()
  const context = await marked()
  expect(
    await checkConnectorPersonalSink(context, "bot", key, request().segments, {
      request: request().segments as unknown as OutboundRequest,
      adapter: a,
    })
  ).toMatchObject({ outcome: "withhold" })
  await sendPersonalDeliveryNotice(a, key, request(), true)
  const notices = await getDb().outboundQueue.toArray()
  expect(notices).toHaveLength(1)
  expect(notices[0].request.segments).toEqual([
    { type: "text", text: expect.stringContaining("privately") },
  ])
  expect(JSON.stringify(notices[0].request)).not.toContain("private detail")
  expect(a.send).not.toHaveBeenCalled()
  expect(
    await checkConnectorPersonalSink(
      explicitHostPersonalSinkContext("typed-send"),
      "bot",
      key,
      "typed",
      { adapter: a }
    )
  ).toEqual({ outcome: "allow" })
})

it.each(["ask_user", "IM notification", "help"])(
  "delivers an untainted %s payload unchanged through the real personal gate",
  async (kind) => {
    const a = adapter()
    const run = await startToolExecutionRun("clean-delivery", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const original = request()
    original.segments = [
      {
        type: "text",
        text:
          kind === "ask_user"
            ? "Pick one: Alpha or Beta"
            : kind === "IM notification"
              ? "Task done"
              : "Cognia help",
      },
    ]
    const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
    const result = await gateway.enqueueAuthorized(
      {
        adapterId: "bot",
        conversationKey: key,
        request: original,
        source: "ai-run",
        authorization: { kind: "system-notice", inboundConversationKey: key },
        personalContext:
          kind === "help"
            ? explicitHostPersonalSinkContext("fixed-notice")
            : { executionRunId: run.id },
      },
      { executionContext: { executionRunId: run.id } }
    )
    expect(result.kind).toBe("queued")
    if (result.kind !== "queued") throw new Error("delivery unexpectedly drafted")
    expect(result.job.request).toEqual(original)
    expect(result.job.personalDeliveryNotice).toBeUndefined()
    expect(
      await getDb()
        .actionReviewReceipts.filter((row) => !!row.personal)
        .count()
    ).toBe(0)
  }
)

it.each(["run", "session"])(
  "keeps actual clean ask_user, IM notification and help producers on the real gateway (%s)",
  async (provenance) => {
    const a = adapter()
    const run = await startToolExecutionRun("clean-producers", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
    await getDb().sessions.put({
      id: "clean-producers",
      title: "Clean",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    const { runImAskUser } = await import("./hitl/ask-user-question")
    const { resolveAskUser, __resetAskUserRegistryForTesting } =
      await import("./hitl/ask-user-registry")
    const jobs: import("@/lib/db/connector-types").OutboundJobRow[] = []
    const enqueue: typeof import("./delivery-gateway").enqueueGoverned = async (input, options) => {
      const job = await gateway.enqueue(input, options)
      if (job) jobs.push(job)
      return job
    }
    const question = runImAskUser({
      ctx: {
        sessionId: "clean-producers",
        ...(provenance === "run" ? { runId: run.id } : {}),
        adapterId: "bot",
        conversationKey: key,
        conversationRef: request().conversationRef as never,
        initiatorUserId: "ou_owner",
      },
      toolUseId: "clean-question",
      args: {
        question: "Choose one",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      },
      deps: {
        enqueue,
        recordBinding: async () => undefined as never,
        audit: async () => undefined as never,
        waitForDelivery: async () => undefined,
      },
    })
    try {
      for (let n = 0; n < 100 && !jobs.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      expect(jobs[0]?.request.segments[0].type).toBe("a2ui")
      expect(JSON.stringify(jobs[0]?.request.segments)).toContain("Choose one")
    } finally {
      resolveAskUser("clean-producers", "clean-question", {
        selected: ["a"],
        text: "",
        cancelled: false,
      })
      await question
      __resetAskUserRegistryForTesting()
    }
    const { deliverNotificationToConversation } = await import("./notifications/im-deliver")
    const outcome = await deliverNotificationToConversation(
      {
        conversationKey: key,
        record: {
          personalContext: { executionRunId: run.id },
          id: "clean-notification",
          source: "connector",
          level: "info",
          title: "Task done",
          createdAt: 1,
          updatedAt: 1,
          readState: "unseen",
          count: 1,
          directed: false,
          deliveredVia: ["center"],
          sourceRef: { kind: "conversation", id: key },
        },
      },
      {
        findSession: async () =>
          ({
            id: "s",
            platformBinding: {
              adapterId: "bot",
              conversationRef: request().conversationRef,
              deliveryTarget: {
                address: {
                  platform: "lark",
                  adapterId: "bot",
                  conversationKey: key,
                  scopeKind: "group",
                  containerId: "oc_group",
                },
                conversationRef: request().conversationRef,
                refreshedAt: 1,
              },
            },
          }) as never,
        readOverride: async () => ({ proactivePush: true }) as never,
        enqueue: (input, options) => gateway.enqueueAuthorized(input, options),
        audit: async () => undefined as never,
      }
    )
    expect(outcome.status).toBe("pushed")
    const { maybeHandleHelpCommand } = await import("./help/help-dispatch")
    const row = {
      id: "bot",
      type: "lark",
      displayName: "Cognia",
      settings: {},
      defaultMode: "auto",
    } as AdapterInstanceRow
    expect(
      await maybeHandleHelpCommand(
        {
          platform: "lark",
          adapterId: "bot",
          conversationKey: key,
          conversationRef: request().conversationRef,
          plainText: "/help",
          channel: { kind: "group", id: "oc_group", platformChannelId: "oc_group" },
          messageId: "help-1",
          sender: { id: "owner", remoteUserId: "ou_owner" },
          receivedAt: 1,
        } as never,
        row,
        { enqueue, audit: async () => undefined as never, readOverride: async () => undefined }
      )
    ).toBe(true)
    expect(jobs.at(-1)?.personalDeliveryNotice).toBeUndefined()
    expect(
      await getDb()
        .actionReviewReceipts.filter((row) => !!row.personal)
        .count()
    ).toBe(0)
  }
)

it.each([false, true])(
  "checks session-finished title delivery with session taint=%s on the real gateway",
  async (tainted) => {
    const a = adapter()
    await getDb().sessions.put({
      id: "finished-session",
      title: "Original session title",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
    if (tainted) {
      const context = await marked()
      await getDb().executionRuns.update(context.executionRunId, { sessionId: "finished-session" })
    }
    const { deliverSessionNotification } = await import("@/hooks/chat/use-session-notifications")
    const translate = ((key: string, values?: { title?: string }) =>
      key === "readyTitle" ? "Session finished" : (values?.title ?? key)) as never
    await deliverSessionNotification(
      { sessionId: "finished-session", kind: "finished" },
      true,
      translate
    )
    const record = (await getDb().notifications.toArray()).find(
      (row) => row.title === "Session finished"
    )!
    expect(record.body).toBe("Original session title")
    expect(toast.success).toHaveBeenCalledWith(
      "Session finished",
      expect.objectContaining({ description: "Original session title" })
    )
    const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
    const { deliverNotificationToConversation } = await import("./notifications/im-deliver")
    const result = await deliverNotificationToConversation(
      { conversationKey: key, record },
      {
        findSession: async () =>
          ({
            id: "finished-session",
            platformBinding: {
              adapterId: "bot",
              conversationRef: request().conversationRef,
              deliveryTarget: {
                address: {
                  platform: "lark",
                  adapterId: "bot",
                  conversationKey: key,
                  scopeKind: "group",
                  containerId: "oc_group",
                },
                conversationRef: request().conversationRef,
                refreshedAt: 1,
              },
            },
          }) as never,
        readOverride: async () => ({ proactivePush: true }) as never,
        enqueue: (input, options) => gateway.enqueueAuthorized(input, options),
        audit: async () => undefined as never,
      }
    )
    expect(result.status).toBe("pushed")
    const jobs = await getDb().outboundQueue.toArray()
    const delivered = jobs.find((job) =>
      tainted
        ? !!job.request.metadata.larkEphemeral
        : JSON.stringify(job.request).includes("Original session title")
    )!
    expect(delivered).toBeDefined()
    if (tainted)
      expect(delivered.request.metadata.larkEphemeral).toEqual({ recipientOpenId: "ou_owner" })
    else {
      expect(JSON.stringify(delivered.request)).toContain("Original session title")
      expect(delivered.personalDeliveryNotice).toBeUndefined()
      expect(await readRunPersonalTaint(delivered.personalSourceContext!)).toEqual({
        verified: true,
        marks: [],
      })
    }
  }
)

it("delivers output from an untainted goal session through its real producer and gateway", async () => {
  const a = adapter()
  await getDb().sessions.put({
    id: "clean-goal-session",
    title: "Goal",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  const gateway = new ConnectorDeliveryGateway({ getAdapter: () => a })
  const { startConnectorGoalDriver } = await import("./commands/goal")
  let settled!: () => void
  const complete = new Promise<void>((resolve) => {
    settled = resolve
  })
  const jobs: import("@/lib/db/connector-types").OutboundJobRow[] = []
  startConnectorGoalDriver(
    {
      sessionId: "clean-goal-session",
      goalId: "clean-goal",
      adapterId: "bot",
      conversationKey: key,
      conversationRef: request().conversationRef as never,
      appSettings: {} as never,
    },
    {
      run: async ({ onTurn }) => {
        await onTurn?.("Original goal output", 0, {} as never)
        settled()
        return { status: "active", turns: 1 } as never
      },
      enqueue: async (input, options) => {
        const job = await gateway.enqueue(input, options)
        if (job) jobs.push(job)
        return job
      },
    }
  )
  await complete
  expect(jobs[0].request.segments).toEqual([{ type: "text", text: "Original goal output" }])
  expect(jobs[0].personalSourceContext).toEqual(
    expect.objectContaining({ sessionId: "clean-goal-session", sessionDerived: true })
  )
})
