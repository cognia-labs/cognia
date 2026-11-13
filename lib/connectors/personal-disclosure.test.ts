/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { personalEgressFenced } from "@/lib/execution/personal-egress"
import {
  personalDisclosureHash,
  personalDisclosureContext,
  commitPersonalDisclosureHistory,
  personalDisclosureContextForJob,
} from "@/lib/execution/personal-disclosure"
import { checkPersonalSink } from "@/lib/execution/personal-sink"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { withholdForReaders } from "@cognia/plugin-contract/types/execution/personal-visibility"
import { preservePersonalMarkMetadata } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { OutboundRequest, PlatformAdapter } from "@/types/connectors"
import type {
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import { ConnectorDeliveryGateway } from "./delivery-gateway"
import { handlePersonalDisclosureCallback } from "./personal-disclosure"
import { offerPersonalToolDisclosure } from "./personal-disclosure"
import { answerWithOutboundPolicy } from "@/lib/policy/action-review/plan-tool-call"
import { startOutboundRunner } from "./outbound-runner"

const adapters = new Map<string, PlatformAdapter>()
jest.mock("./bus", () => ({ getBus: () => ({ getAdapter: (id: string) => adapters.get(id) }) }))
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  adapters.clear()
})
afterAll(fixture.dispose)
const target = { adapterId: "bot", conversationKey: "lark:bot:oc_group" }
const owner = { kind: "local-person" as const }
const marks = [{ person: owner, source: "private-doc", markedAt: 1 }]

async function setup(
  segments: OutboundRequest["segments"] = [{ type: "text", text: "private exact answer" }]
) {
  await getDb().sessions.put({
    id: "group-session",
    title: "Group",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: { conversationKey: target.conversationKey, adapterId: "bot" },
  } as never)
  await getDb().adapterInstances.put({
    id: "bot",
    type: "lark",
    enabled: true,
    settings: {
      connectedUser: { openId: "ou_person" },
      runOperatorUserIds: ["ou_operator"],
      larkPrincipalRegistry: false,
    },
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const adapter = {
    id: "bot",
    meta: { type: "lark", capabilities: ["send.ephemeral"] },
    resolvePersonalAudience: async (key: string) =>
      key.includes(":ou_")
        ? {
            kind: "person",
            person: {
              kind: "platform",
              platform: "lark",
              adapterId: "bot",
              remoteUserId: key.split(":")[2],
            },
          }
        : { kind: "group" },
  } as unknown as PlatformAdapter
  adapter.send = jest.fn(async () => ({ ok: true, platformMessageId: crypto.randomUUID() }))
  adapter.health = () => ({ state: "running" })
  adapters.set("bot", adapter)
  const run = await startToolExecutionRun("group-session", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, { personalMarks: marks })
  const context = { sessionId: "group-session", executionRunId: run.id }
  const request: OutboundRequest = {
    conversationRef: { platform: "lark", adapterId: "bot", channelId: "oc_group" },
    segments,
    metadata: { idempotencyKey: "airun:answer" },
  }
  await getDb().messages.put({
    id: "answer",
    sessionId: "group-session",
    role: "assistant",
    parts: [{ type: "text", text: "private exact answer" }],
    createdAt: 1,
    metadata: { personalMarks: marks, personalMarkVersion: 1 },
  })
  const gateway = new ConnectorDeliveryGateway({ getAdapter: () => adapter })
  await gateway
    .enqueueAuthorized(
      {
        ...target,
        request,
        source: "ai-run",
        authorization: { kind: "origin-reply", inboundConversationKey: target.conversationKey },
        personalContext: context,
      },
      { executionContext: context }
    )
    .catch((error) => {
      if (!segments.some((segment) => segment.type === "file")) throw error
    })
  const row = (await getDb().actionReviewReceipts.toArray()).find(
    (item) => item.personalDisclosurePending
  )
  const bindings = await getDb().connectorCallbackBindings.toArray()
  return { context, request, row, bindings, adapter }
}
function press(
  binding: ConnectorCallbackBindingRow,
  remoteUserId = "ou_person"
): ConnectorCallbackEvent {
  return {
    platform: "lark",
    adapterId: "bot",
    selfId: "bot",
    triggerId: crypto.randomUUID(),
    surfaceId: binding.surfaceId,
    actionType: "button",
    value: String(binding.payload?.decision),
    conversationKey: binding.conversationKey,
    user: {
      id: remoteUserId,
      platform: "lark",
      adapterId: "bot",
      remoteUserId,
      displayName: "Alice",
    },
    timestamp: Date.now(),
    raw: {},
  }
}

it("persists the original exact hash and native private actions, grants once, and keeps opaque egress fenced", async () => {
  const { row, request, bindings, context } = await setup()
  expect(row?.personalDisclosurePending?.request).toEqual(request)
  expect(row?.personal?.contentHash).toBe(await personalDisclosureHash(request))
  expect(row?.personalDisclosurePending?.expiresAt).toBe(
    row!.personalDisclosurePending!.createdAt + 86_400_000
  )
  expect(bindings).toHaveLength(2)
  expect(bindings.every((binding) => binding.actorScope?.mode === "marked-person")).toBe(true)
  const privateJob = (await getDb().outboundQueue.toArray())[0]
  expect(JSON.stringify(privateJob.request)).toContain("Share to the group")
  expect(JSON.stringify(privateJob.request)).toContain("Keep private")
  const share = bindings.find((binding) => binding.payload?.decision === "share")!
  for (const actor of ["ou_operator", "ou_requester", "ou_member"])
    await expect(handlePersonalDisclosureCallback(press(share, actor), share)).rejects.toThrow()
  expect(await personalEgressFenced(context)).toBe(true)
  await handlePersonalDisclosureCallback(press(share), share)
  const jobs = await getDb().outboundQueue.toArray()
  const disclosed = jobs.filter((job) => job.personalDisclosureReceiptId === row!.id)
  expect(disclosed).toHaveLength(1)
  expect(disclosed[0].request).toEqual(request)
  expect({
    adapterId: disclosed[0].adapterId,
    conversationKey: disclosed[0].conversationKey,
  }).toEqual(target)
  const grant = (await getDb().actionReviewReceipts.get(row!.id))!.personal!.disclosure!
  expect(grant).toMatchObject({
    target,
    contentHash: row!.personal!.contentHash,
    jobId: disclosed[0].id,
    grantedBy: { remoteUserId: "ou_person" },
  })
  expect(grant.consumedAt).toEqual(expect.any(Number))
  await expect(handlePersonalDisclosureCallback(press(share), share)).rejects.toThrow()
  expect(await personalEgressFenced(context)).toBe(true)
  expect(
    await checkPersonalSink(
      personalDisclosureContext(context, row!.id, getDb()),
      { kind: "group" },
      request,
      target
    )
  ).toMatchObject({ outcome: "withhold" })
  expect(
    await checkPersonalSink(
      personalDisclosureContextForJob(context, disclosed[0], getDb()),
      { kind: "group" },
      request,
      target
    )
  ).toEqual({ outcome: "allow" })
  expect(
    await checkPersonalSink(
      personalDisclosureContextForJob(context, disclosed[0], getDb()),
      { kind: "group" },
      { ...request, segments: [{ type: "text", text: "tampered" }] },
      target
    )
  ).toMatchObject({ outcome: "withhold" })
})

it.each(["hash", "target", "expiry", "missing"])(
  "refuses %s tampering before enqueue",
  async (kind) => {
    const { row, bindings } = await setup()
    const share = bindings.find((binding) => binding.payload?.decision === "share")!
    const pending = row!.personalDisclosurePending!
    if (kind === "hash") pending.request.segments = [{ type: "text", text: "changed" }]
    if (kind === "target") pending.originalTarget.conversationKey = "lark:bot:oc_other"
    if (kind === "expiry") pending.expiresAt = Date.now() - 1
    if (kind === "missing") await getDb().actionReviewReceipts.delete(row!.id)
    else await getDb().actionReviewReceipts.update(row!.id, { personalDisclosurePending: pending })
    await expect(handlePersonalDisclosureCallback(press(share), share)).rejects.toThrow()
    expect(
      (await getDb().outboundQueue.toArray()).filter((job) => job.personalDisclosureReceiptId)
    ).toHaveLength(0)
  }
)

it("Keep private consumes both choices and closes without sending the original to the group", async () => {
  const { row, bindings } = await setup()
  const keep = bindings.find((binding) => binding.payload?.decision === "private")!
  await handlePersonalDisclosureCallback(press(keep), keep)
  const receipt = await getDb().actionReviewReceipts.get(row!.id)
  expect(receipt!.personalDisclosurePending!.closedAt).toEqual(expect.any(Number))
  expect(receipt!.personal!.disclosure).toBeUndefined()
  expect(
    (await getDb().outboundQueue.toArray()).some((job) => job.personalDisclosureReceiptId)
  ).toBe(false)
  expect(
    (await getDb().connectorCallbackBindings.toArray()).every((binding) => !!binding.consumedAt)
  ).toBe(true)
})

it("racing presses enqueue exactly one replay", async () => {
  const { row, bindings } = await setup()
  const share = bindings.find((binding) => binding.payload?.decision === "share")!
  const results = await Promise.allSettled([
    handlePersonalDisclosureCallback(press(share), share),
    handlePersonalDisclosureCallback(press(share), share),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(
    (await getDb().outboundQueue.toArray()).filter(
      (job) => job.personalDisclosureReceiptId === row!.id
    )
  ).toHaveLength(1)
})

it("a failed enqueue cannot consume the grant without its job", async () => {
  const { row, bindings, request } = await setup()
  const share = bindings.find((binding) => binding.payload?.decision === "share")!
  const fail = (_key: unknown, job: { request: OutboundRequest }) => {
    if (job.request.metadata.idempotencyKey === request.metadata.idempotencyKey)
      throw new Error("queue persistence refused")
  }
  getDb().outboundQueue.hook("creating", fail)
  try {
    await expect(handlePersonalDisclosureCallback(press(share), share)).rejects.toThrow(
      "queue persistence refused"
    )
  } finally {
    getDb().outboundQueue.hook("creating").unsubscribe(fail)
  }
  expect(
    (await getDb().actionReviewReceipts.get(row!.id))!.personal!.disclosure!.consumedAt
  ).toBeUndefined()
  expect(
    (await getDb().outboundQueue.toArray()).filter(
      (job) => job.personalDisclosureReceiptId === row!.id
    )
  ).toHaveLength(0)
})

it("discloses canonical history only to a later turn in the same conversation session, and changes the digest", async () => {
  const { row, bindings, context } = await setup()
  const other = {
    kind: "platform" as const,
    platform: "lark",
    adapterId: "bot",
    remoteUserId: "ou_other",
  }
  await getDb().executionRuns.update(context.executionRunId, {
    actingIdentity: {
      schemaVersion: 1,
      rootRunId: context.executionRunId,
      lane: "delegated",
      trigger: "requester",
      requesters: [other],
      authorityRevision: 1,
    },
  })
  const message = (await getDb().messages.get("answer"))!
  const before = await preparePersonalHistory("group-session", [message], {
    executionRunId: context.executionRunId,
  })
  expect(before.withheldMessageIds).toContain("answer")
  const share = bindings.find((binding) => binding.payload?.decision === "share")!
  await handlePersonalDisclosureCallback(press(share), share)
  const job = (await getDb().outboundQueue.toArray()).find(
    (item) => item.personalDisclosureReceiptId === row!.id
  )!
  await getDb().outboundQueue.update(job.id, { status: "sent" })
  await commitPersonalDisclosureHistory(job)
  const stored = (await getDb().messages.get("answer"))!
  expect(stored.metadata!.personalDisclosures).toHaveLength(1)
  const after = await preparePersonalHistory("group-session", [stored], {
    executionRunId: context.executionRunId,
  })
  expect(after.withheldMessageIds).toEqual([])
  expect(after.visibilityDigest).not.toBe(before.visibilityDigest)
  const elsewhere = await preparePersonalHistory("another-session", [stored], {
    executionRunId: context.executionRunId,
  })
  expect(elsewhere.withheldMessageIds).toContain("answer")
  expect(withholdForReaders([stored], [], {}).withheldMessageIds).toContain("answer")
  expect(
    preservePersonalMarkMetadata(
      { note: "updated", personalDisclosures: ["forged"] },
      stored.metadata,
      { rowExists: true }
    )!.personalDisclosures
  ).toEqual(stored.metadata!.personalDisclosures)
  expect(
    preservePersonalMarkMetadata(
      { personalDisclosures: stored.metadata!.personalDisclosures },
      undefined,
      { rowExists: false }
    )
  ).toBeUndefined()
})

it("opaque attachment withholds have no pending disclosure or card", async () => {
  const { row, bindings } = await setup([
    {
      type: "file",
      url: "https://example.invalid/private",
      name: "private",
      mimeType: "text/plain",
      sizeBytes: 1,
    },
  ])
  expect(row).toBeUndefined()
  expect(bindings).toEqual([])
})

it("drives the real runner through private delivery and the identical group send, then publishes history and the shared label", async () => {
  const { row, request, bindings, adapter } = await setup()
  const share = bindings.find((item) => item.payload?.decision === "share")!
  await handlePersonalDisclosureCallback(press(share), share)
  expect(
    (await getDb().outboundQueue.toArray()).some((job) =>
      JSON.stringify(job.request).includes("Shared by Alice")
    )
  ).toBe(false)
  const controller = new AbortController()
  const running = startOutboundRunner({
    adapters,
    signal: controller.signal,
    pollIntervalMs: 5,
    jitter: () => 0,
    settings: () => ({ agentPermissions: {} }),
  })
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const jobs = await getDb().outboundQueue.toArray()
      if (
        jobs.some((job) => job.personalDisclosureReceiptId === row!.id && job.status === "sent") &&
        jobs.some((job) => JSON.stringify(job.request).includes("Shared by Alice"))
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const job = (await getDb().outboundQueue.toArray()).find(
      (item) => item.personalDisclosureReceiptId === row!.id
    )!
    expect(job.status).toBe("sent")
    expect(
      jest
        .mocked(adapter.send)
        .mock.calls.filter(([sent]) => JSON.stringify(sent) === JSON.stringify(request))
    ).toHaveLength(1)
    expect((await getDb().messages.get("answer"))!.metadata!.personalDisclosures).toHaveLength(1)
    expect(
      (await getDb().outboundQueue.toArray()).some((item) =>
        JSON.stringify(item.request).includes("Shared by Alice")
      )
    ).toBe(true)
  } finally {
    controller.abort()
    await running
  }
})

it.each(["off", "shadow", "enforce"])(
  "fixed outbound tool withhold offers a card and replays only the message in %s mode",
  async (mode) => {
    const { context } = await setup()
    await getDb().outboundQueue.clear()
    await getDb().actionReviewReceipts.clear()
    await getDb().connectorCallbackBindings.clear()
    const result = await answerWithOutboundPolicy(
      {
        sessionId: "group-session",
        requestId: "literal-tool",
        toolName: "connector_send",
        input: { conversationKey: target.conversationKey, text: "literal private tool payload" },
      },
      {
        executionRunId: context.executionRunId,
        unattended: false,
        origin: { rootSessionId: "group-session", instructionEpoch: "turn" },
        settings: () => ({ agentPermissions: { outboundAuthorization: mode } }),
      },
      jest.fn()
    )
    expect(result.decision).toBe("deny")
    const receipt = (await getDb().actionReviewReceipts.toArray()).find(
      (row) => row.personalDisclosurePending
    )!
    expect(receipt.personalDisclosurePending!.request.segments).toEqual([
      { type: "text", text: "literal private tool payload" },
    ])
    const binding = (await getDb().connectorCallbackBindings.toArray()).find(
      (row) => row.payload?.decision === "share"
    )!
    await handlePersonalDisclosureCallback(press(binding), binding)
    const job = (await getDb().outboundQueue.toArray()).find(
      (row) => row.personalDisclosureReceiptId === receipt.id
    )!
    expect(job.request).toEqual(receipt.personalDisclosurePending!.request)
    expect(
      await offerPersonalToolDisclosure(
        context,
        "web_fetch",
        { url: "https://example.invalid", text: "private" },
        "opaque"
      )
    ).toBe(false)
    expect(
      await offerPersonalToolDisclosure(
        context,
        "connector_send",
        { conversationKey: target.conversationKey, segments: [{ type: "file", url: "mutable" }] },
        "media"
      )
    ).toBe(false)
  }
)
