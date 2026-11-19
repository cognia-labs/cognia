#!/usr/bin/env node
/**
 * Reproduce the Inbox audit's current failures with synthetic IndexedDB data.
 * Passing assertions document the defect; they do not certify correct behavior.
 * Reuses the repository's test harness and imports the current product modules.
 * Generated files stay under .cache; no product source or real account is changed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const directory = ".cache/inbox-gap-audit"
mkdirSync(directory, { recursive: true })

const localHarness = readFileSync("lib/connectors/inbox-writes/local.test.ts", "utf8")
  .split('describe("segmentsToMessageParts"')[0]
  .replace('from "./local"', 'from "@/lib/connectors/inbox-writes/local"')
writeFileSync(
  `${directory}/draft-local.test.ts`,
  localHarness +
    `
it("F01 observes approval without a delivery target removing the draft", async () => {
  const d = await createDraft({ sessionId: SESSION, conversationKey: KEY,
    segments: [{ type: "text", text: "no binding" }] })
  const result = await approveDraftLocally(d.id)
  expect(result).toMatchObject({ alreadyApproved: false, jobId: undefined })
  expect(enqueueMock).not.toHaveBeenCalled()
  expect((await getDb().connectorDrafts.get(d.id))?.status).toBe("approved")
})

it("F02 observes an expired pending draft being approved and enqueued", async () => {
  const d = await createDraft({ sessionId: SESSION, conversationKey: KEY,
    segments: [{ type: "text", text: "expired" }], expiresAt: Date.now() - 60_000 })
  const result = await approveDraftLocally(d.id,
    { binding: { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF } })
  expect(result.jobId).toBeDefined()
  expect(enqueueMock).toHaveBeenCalledTimes(1)
  expect((await getDb().connectorDrafts.get(d.id))?.status).toBe("approved")
})

it("F03 observes a recovery draft reusing a deadlettered job without enqueue", async () => {
  const request = { conversationRef: REF,
    segments: [{ type: "text" as const, text: "retry me" }],
    metadata: { idempotencyKey: "original" } }
  const now = Date.now()
  await getDb().outboundQueue.add({ id: "dead-original", adapterId: ADAPTER,
    conversationKey: KEY, request, status: "deadlettered", attempts: 1,
    createdAt: now, updatedAt: now, nextAttemptAt: 0, idempotencyKey: "original",
    source: "ai-run" } as OutboundJobRow)
  const d = await createDraft({ sessionId: SESSION, conversationKey: KEY,
    segments: request.segments, outboundPreview: request })
  const result = await approveDraftLocally(d.id)
  expect(result.jobId).toBe("dead-original")
  expect(enqueueMock).not.toHaveBeenCalled()
  expect((await getDb().connectorDrafts.get(d.id))?.status).toBe("approved")
  expect((await getDb().outboundQueue.get("dead-original"))?.status).toBe("deadlettered")
})
`
)

const remoteHarness = readFileSync("lib/connectors/inbox-writes/remote.test.ts", "utf8")
  .split('describe("sendManualReplyRemotely"')[0]
  .replace('from "./pending-overrides"', 'from "@/lib/connectors/inbox-writes/pending-overrides"')
  .replace('from "./remote"', 'from "@/lib/connectors/inbox-writes/remote"')
writeFileSync(
  `${directory}/draft-remote.test.ts`,
  remoteHarness +
    `
it("F04 observes a deadlettered relay leaving the host's pending draft hidden", async () => {
  const d = await createDraft({ sessionId: SESSION, conversationKey: KEY,
    segments: [{ type: "text", text: "host draft" }] })
  const host = { ...d, createdAt: 1, updatedAt: 1 }
  await getDb().connectorDrafts.put(host)
  const queued = await approveDraftRemotely(d.id, undefined)
  await getDb().mobileOutboundQueue.update(queued.id,
    { status: "deadlettered", attempts: 5, lastError: "permission denied" })
  const { applyConnectorDraftRows } = await import("@/lib/sync/handlers/connector-drafts")
  await applyConnectorDraftRows([host])
  expect((await getDb().connectorDrafts.get(d.id))?.status).toBe("approved")
  expect(await getDb().connectorDrafts.where("status").equals("pending").count()).toBe(0)
})
`
)

writeFileSync(
  `${directory}/lifecycle.test.ts`,
  `/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { upsertByConversationKey, readForResolution, addLabel, setStatus, wakeSnoozedConversations }
  from "@/lib/db/conversation-overrides"
import { isConversationOverrideMutation, applyConversationOverrideMutation }
  from "@/lib/connectors/inbox-writes/override-mutation"
import { countMobileUnread } from "@/lib/inbox/unread-count"
import { filterConversationSessions } from "@/hooks/inbox/use-conversation-rows"
import { inverseTriageActions } from "@/lib/inbox/bulk-triage"
const KEY = "telegram:a:c"
beforeEach(async () => { await getDb().delete(); await getDb().open() })
afterEach(() => jest.restoreAllMocks())

it("F05 observes the host contract rejecting the UI's id-less human assignee", async () => {
  const mutation = { kind: "setAssignee" as const, conversationKey: KEY,
    sessionId: "s", assignee: { kind: "human" as const } }
  expect(isConversationOverrideMutation(mutation)).toBe(false)
  await applyConversationOverrideMutation(mutation)
  expect((await readForResolution(KEY))?.engagement).toBe("human")
})

it("F06 observes two successful concurrent label additions losing one label", async () => {
  await upsertByConversationKey({ conversationKey: KEY, sessionId: "s", labelIds: [] })
  await Promise.all([addLabel(KEY, "a", "s"), addLabel(KEY, "b", "s")])
  expect((await readForResolution(KEY))!.labelIds).toHaveLength(1)
  expect(await getDb().conversationAssignmentEvents.where("conversationKey").equals(KEY)
    .filter(x => x.kind === "label.added").count()).toBe(2)
})

it("F07 observes a stale snooze sweep reopening a newer resolved state", async () => {
  await upsertByConversationKey({ conversationKey: KEY, sessionId: "s",
    status: "snoozed", snoozeUntil: 1000 })
  const table = getDb().conversationOverrides
  const original = table.update.bind(table)
  jest.spyOn(table, "update").mockImplementationOnce(async (id, patch) => {
    await original(id, { status: "resolved", snoozeUntil: undefined })
    return original(id, patch)
  })
  await wakeSnoozedConversations(2000)
  expect((await readForResolution(KEY))?.status).toBe("open")
})

it("F09 observes an Inbox badge for an integration conversation excluded from its list", () => {
  const session = { id: "integration-only", title: "GitHub", createdAt: 1, updatedAt: 1,
    integrationBinding: { integrationId: "github" } } as any
  expect(countMobileUnread([session], new Map([[session.id, 1]])).inbox).toBe(1)
  expect(filterConversationSessions([session], {})).toEqual([])
})

it("F10 observes resolve Undo replacing the state reopened by a newer inbound", async () => {
  const target = { sessionId: "s", conversationKey: KEY, status: "snoozed" as const,
    snoozeUntil: 10000, labelIds: [], pinned: false, archived: false, unread: true }
  await upsertByConversationKey({ conversationKey: KEY, sessionId: "s",
    status: "snoozed", snoozeUntil: target.snoozeUntil })
  await setStatus(KEY, "resolved")
  // The exact primitive the inbound bus uses to reopen a resolved conversation.
  await setStatus(KEY, "open")
  const [inverse] = inverseTriageActions({ kind: "setStatus", status: "resolved" }, [target], 2000)
  if (inverse.action.kind !== "setStatus") throw new Error("unexpected inverse")
  await setStatus(KEY, inverse.action.status, { snoozeUntil: inverse.action.snoozeUntil })
  expect((await readForResolution(KEY))?.status).toBe("snoozed")
})
`
)

const queueHarness = readFileSync("lib/queue/outbound-queue.test.ts", "utf8")
  .split('describe("createOutboundRunner"')[0]
  .replace('from "./outbound-queue"', 'from "@/lib/queue/outbound-queue"')
writeFileSync(
  `${directory}/draft-wire.test.ts`,
  queueHarness +
    `
import { createDraft } from "@/lib/db/connector-drafts"
import { approveDraftRemotely, rejectDraftRemotely } from "@/lib/connectors/inbox-writes/remote"
beforeEach(async () => {
  setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  await getDb().delete(); await getDb().open()
})
afterEach(() => clearActiveRuntimeTargetContext())
it("F08 observes actual draft relay keys reaching the dispatcher outside the UUID contract", async () => {
  const approve = await createDraft({ sessionId: "s", conversationKey: "telegram:a:c",
    segments: [{ type: "text", text: "approve" }] })
  const reject = await createDraft({ sessionId: "s", conversationKey: "telegram:a:c",
    segments: [{ type: "text", text: "reject" }] })
  await approveDraftRemotely(approve.id, undefined)
  await rejectDraftRemotely(reject.id)
  const call = jest.fn().mockResolvedValue({})
  const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
  try {
    await runner.kick()
    const keys = call.mock.calls.map(args => args[2].idempotencyKey)
    // Dispatch order is not part of this probe; both exact wire keys are.
    expect(keys.toSorted()).toEqual([
      "cdr-approve:" + approve.id, "cdr-reject:" + reject.id,
    ].toSorted())
    for (const key of keys) expect(key).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  } finally { await runner.stop() }
})
`
)

writeFileSync(
  `${directory}/jest.config.ts`,
  `import base from "../../jest.config.ts"
export default async () => {
  const config = await base()
  const project = config.projects.find(p => p.displayName === "jsdom" || p.displayName?.name === "jsdom")
  return { ...config, rootDir: process.cwd(), cacheDirectory: ".cache/inbox-gap-audit/jest",
    projects: [{ ...project, rootDir: process.cwd(),
      testMatch: ["<rootDir>/.cache/inbox-gap-audit/*.test.ts"],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: project.modulePathIgnorePatterns.filter(p => !p.includes(".cache")) }] }
}
`
)
const result = spawnSync(
  "pnpm",
  [
    "--config.verifyDepsBeforeRun=false",
    "test",
    "--config",
    `${directory}/jest.config.ts`,
    "--runInBand",
    "--watchman=false",
  ],
  { stdio: "inherit" }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
