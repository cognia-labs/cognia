#!/usr/bin/env node
/**
 * Additional adversarial Inbox observations. Passing tests demonstrate the
 * current failure condition; they are not correctness or provider acceptance.
 * Keeps the first audit's observations intact and generates isolated tests.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const directory = ".cache/inbox-gap-audit-adversarial"
mkdirSync(directory, { recursive: true })

let noticeHarness = readFileSync("components/inbox/notices/notice-area.test.tsx", "utf8")
  .split('describe("InboxNoticeArea"')[0]
  .replaceAll('"../', '"@/components/inbox/')
  .replace('from "./notice-area"', 'from "@/components/inbox/notices/notice-area"')
  .replace(
    'ConnectionLossNotice: () => <div data-testid="src-connection-loss" />,',
    'ConnectionLossNotice: jest.requireActual("@/components/inbox/connection-loss-banner").ConnectionLossNotice,'
  )
noticeHarness += `
jest.mock("@/lib/connectors/lifecycle", () => ({ requeueAdapter: jest.fn() }))

it("A01 observes keyboard focus entering a collapsed notice's actual dismiss button", async () => {
  degradedAdapters = [{ adapterId: "probe", state: "down" }]
  saturatedAdapters = [{ adapterId: "other" }]
  renderArea()
  const toggle = screen.getByRole("button", { expanded: false })
  toggle.focus()
  await userEvent.tab()
  const dismiss = screen.getByRole("button", { name: "Dismiss" })
  expect(dismiss).toHaveFocus()
  const container = dismiss.closest('[data-testid="inbox-notice-list"]')
  expect(container).not.toHaveAttribute("hidden")
  expect(container).not.toHaveAttribute("inert")
  expect(container).not.toHaveAttribute("aria-hidden", "true")
  expect(toggle).toHaveAttribute("aria-expanded", "false")
})
`
writeFileSync(`${directory}/notices.test.tsx`, noticeHarness)

writeFileSync(
  `${directory}/draft-lifecycle.test.ts`,
  `/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createDraft, getDraft } from "@/lib/db/connector-drafts"
import { approveDraftLocally, rejectDraftLocally } from "@/lib/connectors/inbox-writes/local"
import { getConnectorDeliveryGateway, __resetConnectorDeliveryGatewayForTesting } from "@/lib/connectors/delivery-gateway"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { enqueueOutbound, holdOutboundForAuthorization } from "@/lib/db/outbound-jobs"

// No live adapter/network: gateway planning, personal gate and persistence remain real.
jest.mock("@/lib/connectors/bus", () => ({getBus: () => ({getAdapter: () => undefined})}))
jest.mock("@/lib/sync/host-invalidate", () => ({publishSyncInvalidate: jest.fn()}))
const fx=createDbTestFixture({seeded:false});
beforeAll(fx.initialize); beforeEach(async()=>{await fx.restore(); __resetConnectorDeliveryGatewayForTesting()}); afterAll(fx.dispose);
const KEY="telegram:probe:chat", REF={platform:"telegram" as const,adapterId:"probe",channelId:"chat"};
async function producer(expiresAt?:number){
 const run=await startToolExecutionRun(undefined,{localAuthorization:LOCAL_PERSON_RUN});
 const draft=await createDraft({personalExecutionRunId:run.id,sessionId:"probe-session",conversationKey:KEY,segments:[{type:"text",text:"payload"}],expiresAt,outboundPreview:{conversationRef:REF,segments:[{type:"text",text:"payload"}],metadata:{idempotencyKey:crypto.randomUUID()}}});
 return draft;
}
it("F02: real gateway and Host execution persist expired pending content as a runnable job",async()=>{
 const draft=await producer(Date.now()-60000);
 const result=await approveDraftLocally(draft.id,{},LOCAL_PERSON_RUN);
 expect((await getDraft(draft.id))?.status).toBe("approved");
 const job=await getDb().outboundQueue.get(result.jobId!);
 expect(job).toMatchObject({status:"pending",source:"draft-approved",request:{segments:[{type:"text",text:"payload"}]}});
 expect(await getDb().executionRuns.get("execution:job:outbound:"+job!.id)).toBeDefined();
});
it("Control: probe's legacy missing-provenance input is withheld by the actual personal gate",async()=>{
 const draft=await createDraft({sessionId:"s",conversationKey:KEY,segments:[{type:"text",text:"payload"}],expiresAt:Date.now()-60000});
 await expect(approveDraftLocally(draft.id,{binding:{adapterId:"probe",conversationKey:KEY,conversationRef:REF}},LOCAL_PERSON_RUN)).rejects.toMatchObject({code:"connector_delivery_denied",reason:"personal"});
 expect((await getDraft(draft.id))?.status).toBe("pending");
 const rows=await getDb().outboundQueue.toArray();
 expect(rows.some(r=>r.request.segments.some(s=>s.type==="text" && s.text==="payload"))).toBe(false);
});
it("F03 broader producer: actual authorization hold leaves same-key dead job; approval never queues replacement",async()=>{
 const draft=await producer(); await getDb().connectorDrafts.delete(draft.id);
 const job=await enqueueOutbound({adapterId:"probe",conversationKey:KEY,request:draft.outboundPreview!,source:"ai-run"});
 expect(await holdOutboundForAuthorization(job.id,{errorCode:"authorization",message:"held",draft})).toBe(true);
 const result=await approveDraftLocally(draft.id,{},LOCAL_PERSON_RUN);
 expect(result.jobId).toBe(job.id); expect((await getDraft(draft.id))?.status).toBe("approved");
 expect((await getDb().outboundQueue.get(job.id))?.status).toBe("deadlettered");
 expect(await getDb().outboundQueue.count()).toBe(1);
});
it("Race: reject succeeds before gateway acceptance, then suspended approval overwrites rejection and queues content",async()=>{
 const draft=await producer();
 let enter!:()=>void, release!:()=>void;
 const entered=new Promise<void>(r=>enter=r), gate=new Promise<void>(r=>release=r);
 const gateway=getConnectorDeliveryGateway(); const enqueue=gateway.enqueue.bind(gateway);
 const spy=jest.spyOn(gateway,"enqueue").mockImplementation(async(...args)=>{enter();await gate;return enqueue(...args)});
 try {
  const approving=approveDraftLocally(draft.id,{},LOCAL_PERSON_RUN); await entered;
  await rejectDraftLocally(draft.id); expect((await getDraft(draft.id))?.status).toBe("rejected");
  release(); const result=await approving;
  expect((await getDraft(draft.id))?.status).toBe("approved");
  expect((await getDb().outboundQueue.get(result.jobId!))?.status).toBe("pending");
 } finally {release();spy.mockRestore()}
});

it("F01 producer: real workflow executor accepts an ordinary unbound session and explicit IM key; approval closes it without a job",async()=>{
 await import("@/lib/connectors/workflow-nodes");
 const {getExecutor}=await import("@/lib/workflow/nodes/registry");
 await getDb().sessions.add({id:"ordinary-chat",title:"Workflow chat",createdAt:1,updatedAt:1} as never);
 await startToolExecutionRun("ordinary-chat",{runId:"execution:workflow:f01-workflow",localAuthorization:LOCAL_PERSON_RUN});
 const out=await getExecutor("action.connector.draft",1)!.execute({runId:"f01-workflow",workflowId:"wf",stepId:"draft",params:{conversationKey:KEY,sessionId:"ordinary-chat",content:"workflow payload"},upstream:{},trigger:{},signal:new AbortController().signal,log:()=>{},resolveSecret:async()=>undefined} as never);
 const draftId=(out.output as {draftId:string}).draftId;
 const before=await getDraft(draftId); expect(before?.outboundPreview).toBeUndefined();
 const result=await approveDraftLocally(draftId,{},LOCAL_PERSON_RUN);
 expect(result).toMatchObject({jobId:undefined,alreadyApproved:false});
 expect((await getDraft(draftId))?.status).toBe("approved");
 expect(await getDb().outboundQueue.count()).toBe(0);
});
it("F02 producer: real workflow TTL expires; bound-session approval still persists payload through actual gateway",async()=>{
 await import("@/lib/connectors/workflow-nodes");
 const {getExecutor}=await import("@/lib/workflow/nodes/registry");
 await getDb().sessions.add({id:"bound-chat",title:"IM chat",createdAt:1,updatedAt:1,platformBinding:{adapterId:"probe",conversationKey:KEY,conversationRef:REF}} as never);
 await startToolExecutionRun("bound-chat",{runId:"execution:workflow:f02-workflow",localAuthorization:LOCAL_PERSON_RUN});
 const out=await getExecutor("action.connector.draft",1)!.execute({runId:"f02-workflow",workflowId:"wf",stepId:"draft",params:{conversationKey:KEY,sessionId:"bound-chat",content:"workflow ttl payload",ttlMs:1},upstream:{},trigger:{},signal:new AbortController().signal,log:()=>{},resolveSecret:async()=>undefined} as never);
 const draftId=(out.output as {draftId:string}).draftId;
 await new Promise(resolve=>setTimeout(resolve,10));
 expect((await getDraft(draftId))!.expiresAt!).toBeLessThan(Date.now());
 const result=await approveDraftLocally(draftId,{},LOCAL_PERSON_RUN);
 expect((await getDb().outboundQueue.get(result.jobId!))?.request.segments).toEqual([{type:"text",text:"workflow ttl payload"}]);
 expect((await getDraft(draftId))?.status).toBe("approved");
});
`
)

writeFileSync(
  `${directory}/draft-editing.test.ts`,
  `/** @jest-environment jsdom */
import { createElement } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { DraftNotice } from "@/components/inbox/draft-banner"
import { approveInboxDraft } from "@/lib/connectors/inbox-writes"
import type {ConnectorDraftRow} from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/inbox-writes",()=>({approveInboxDraft:jest.fn().mockResolvedValue({route:"local"}),rejectInboxDraft:jest.fn()}))
jest.mock("@/components/ui/sheet")
jest.mock("@/components/plugins/plugin-extension-slot",()=>({PluginExtensionSlot:()=>null}))
const first={id:"a",conversationKey:"telegram:probe:c",sessionId:"s",segments:[{type:"text",text:"First draft body"}],status:"pending",createdAt:1,updatedAt:1} as ConnectorDraftRow;
const second={...first,id:"b",segments:[{type:"text",text:"Second draft body"}]} as ConnectorDraftRow;
it("Open unkeyed production DraftNotice retains old content when first pending draft changes, then approves second id with first text",async()=>{
 const ui=render(createElement(DraftNotice,{draft:first,conversationKey:first.conversationKey}));
 fireEvent.click(screen.getByRole("button",{name:/review/i}));
 expect(screen.getByRole("textbox")).toHaveValue("First draft body");
 // Production notice-area keeps the 'draft' notice key; external approval/rejection moves drafts[0].
 ui.rerender(createElement(DraftNotice,{draft:second,conversationKey:second.conversationKey}));
 expect(screen.getByRole("textbox")).toHaveValue("First draft body");
 fireEvent.click(screen.getByRole("button",{name:/approve.*send/i}));
 await waitFor(()=>expect(approveInboxDraft).toHaveBeenCalledWith(expect.objectContaining({id:"b"}),expect.objectContaining({segments:[{type:"text",text:"First draft body"}]})));
});
`
)

writeFileSync(
  `${directory}/relay-settlement.test.ts`,
  `/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie \`delete()\` + \`open()\` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

import { getDb } from "@/lib/db/schema"
import { createDraft } from "@/lib/db/connector-drafts"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { ConversationReference } from "@/types/connectors/event"
import { readForResolution, upsertByConversationKey } from "@/lib/db/conversation-overrides"

import { __resetPendingOverridesForTests, hasPendingOverrideMutation } from "@/lib/connectors/inbox-writes/pending-overrides"
import {
  approveDraftRemotely,
  mutateOverrideRemotely,
  rejectDraftRemotely,
  sendManualReplyRemotely,
} from "@/lib/connectors/inbox-writes/remote"

const ADAPTER = "tg-1"
const KEY = "telegram:tg-1:555"
const SESSION = "s-1"
const REF: ConversationReference = { platform: "telegram", adapterId: ADAPTER }

const manualInput = {
  adapterId: ADAPTER,
  conversationKey: KEY,
  sessionId: SESSION,
  conversationRef: REF,
  segments: [{ type: "text" as const, text: "on it" }],
  idempotencyKey: "idem-1",
  clientMessageId: "client-msg-1",
}

beforeEach(async () => {
  __resetPendingOverridesForTests()
  setActiveRuntimeTargetContext("acct-1", "host-1")
  await getDb().delete()
  await getDb().open()
})

afterEach(() => clearActiveRuntimeTargetContext())


import { syncConversationOverrides } from "@/lib/connectors/sync/conversation-overrides"
import { applyConversationOverrideMutation } from "@/lib/connectors/inbox-writes/override-mutation"
import { markSent } from "@/lib/db/mobile-outbound-queue"
import type { Transport } from "@/lib/tauri/transport-types"

it("observes an acknowledged assignment losing its authoritative routing row at an advanced sync cursor", async () => {
  await upsertByConversationKey({ conversationKey: KEY, sessionId: SESSION })
  const mutation = { kind: "setAssignee" as const, conversationKey: KEY,
    sessionId: SESSION, assignee: { kind: "character" as const, id: "char-target" } }
  const queued = await mutateOverrideRemotely(mutation)
  const optimistic = (await readForResolution(KEY))!
  expect(optimistic.assignee?.id).toBe("char-target")
  expect(optimistic.characterId).toBeUndefined()
  // Build exactly the Host function's authoritative result, then restore the
  // distinct client's mirror so both actual write functions are exercised.
  const authoritative = (await applyConversationOverrideMutation(mutation))!
  expect(authoritative.characterId).toBe("char-target")
  expect(authoritative.routingSource).toBe("assignment")
  await getDb().conversationOverrides.put(optimistic)
  const call = jest.fn(async (_command: string, args: { since: number }) => ({
    rows: args.since < authoritative.updatedAt ? [authoritative] : [],
    deleted_ids: [], next_since: authoritative.updatedAt,
  }))
  const transport = { call, subscribe: jest.fn() } as unknown as Transport
  const first = await syncConversationOverrides(transport, { since: 0 })
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("sync failed")
  expect(first.result.nextSince).toBe(authoritative.updatedAt)
  expect((await readForResolution(KEY))?.characterId).toBeUndefined()
  await markSent(queued.id)
  const second = await syncConversationOverrides(transport, { since: first.result.nextSince })
  expect(second.ok).toBe(true)
  if (!second.ok) throw new Error("sync failed")
  expect(second.result.applied).toBe(0)
  expect((await readForResolution(KEY))?.characterId).toBeUndefined()
  expect((await getDb().mobileOutboundQueue.get(queued.id))?.status).toBe("sent")
})


it("observes withdrawing an unsent draft approval retaining its approved shadow with no relay row", async () => {
  const draft = await createDraft({ sessionId: SESSION, conversationKey: KEY,
    segments: [{ type: "text", text: "host pending" }] })
  const host = { ...draft, updatedAt: 1, createdAt: 1 }
  await getDb().connectorDrafts.put(host)
  const queued = await approveDraftRemotely(draft.id, undefined)
  const { withdrawQueuedAction } = await import("@/lib/db/mobile-outbound-queue")
  expect(await withdrawQueuedAction(queued.id)).toBe("withdrawn")
  expect(await getDb().mobileOutboundQueue.get(queued.id)).toBeUndefined()
  const { applyConnectorDraftRows } = await import("@/lib/sync/handlers/connector-drafts")
  await applyConnectorDraftRows([host])
  expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("approved")
})
`
)

writeFileSync(
  `${directory}/membership.test.ts`,
  `/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { markSessionUnread } from "@/lib/db/session-state"
import { countMobileUnread } from "@/lib/inbox/unread-count"
import { filterConversationSessions } from "@/hooks/inbox/use-conversation-rows"
import type { ChatSession } from "@cognia/agent-config-types"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize); beforeEach(fixture.restore); afterAll(fixture.dispose)
it("F09 control observes the badge mismatch after real Mark unread on a valid integration session", async () => {
  const session = { id: "integration", title: "GitHub", createdAt: 1, updatedAt: 1,
    integrationBinding: { pluginId: "github", integrationId: "issues", accountId: "account",
      projectionId: "projection", threadKey: "issue:1" } } as ChatSession
  await getDb().sessions.put(session)
  await markSessionUnread(session.id)
  const state = await getDb().sessionState.get(session.id)
  expect(state!.unreadCount).toBeGreaterThan(0)
  expect(countMobileUnread([session], new Map([[session.id, state!.unreadCount]])).inbox).toBe(1)
  expect(filterConversationSessions([session], {})).toEqual([])
})
it("F09 observes a full IM session from workspace B counted while Inbox in workspace A excludes it", () => {
  const session = { id: "im-b", title: "IM", createdAt: 1, updatedAt: 1, projectId: "B",
    platformBinding: { platform: "telegram", adapterId: "a", conversationKey: "telegram:a:c",
      conversationRef: { platform: "telegram", adapterId: "a" } } } as ChatSession
  expect(countMobileUnread([session], new Map([[session.id, 1]])).inbox).toBe(1)
  expect(filterConversationSessions([session], { activeProjectId: "A" })).toEqual([])
})
`
)

writeFileSync(
  `${directory}/jest.config.ts`,
  `import base from "../../jest.config.ts"
export default async () => {
  const config = await base()
  const project = config.projects.find(p => p.displayName === "jsdom" || p.displayName?.name === "jsdom")
  return { ...config, rootDir: process.cwd(), cacheDirectory: ".cache/inbox-gap-audit-adversarial/jest",
    projects: [{ ...project, rootDir: process.cwd(),
      testMatch: ["<rootDir>/.cache/inbox-gap-audit-adversarial/*.test.ts", "<rootDir>/.cache/inbox-gap-audit-adversarial/*.test.tsx"],
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
