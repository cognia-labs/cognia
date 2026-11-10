/** @jest-environment jsdom */
// Real Host ancestry/receipts distinguish the owner from a foreign person's
// content; only desktop surfaces are replaced to observe what they receive.
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() },
}))
const mockPlatform = jest.fn(() => "web")
const mockTransportCall = jest.fn(async (..._args: unknown[]) => ({ sent: 1 }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => mockPlatform(),
  isTauri: () => false,
  isCapacitor: () => false,
  isHeadlessHost: () => false,
}))
import { toast } from "sonner"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { notify } from "./runtime"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  mockPlatform.mockReturnValue("web")
})
afterAll(fixture.dispose)

it("withholds a foreign person's notification from the local feed and toast", async () => {
  const run = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [
      {
        person: {
          kind: "platform",
          platform: "lark",
          adapterId: "bot",
          remoteUserId: "ou_foreign",
        },
        source: "calendar",
        markedAt: 1,
      },
    ],
  })
  const id = await notify(
    {
      source: "scheduler",
      level: "info",
      title: "PRIVATE_TITLE",
      body: "PRIVATE_BODY",
      href: "/PRIVATE_HREF",
      meta: { private: "PRIVATE_META" },
      channels: ["center", "toast"],
    },
    { personalContext: { executionRunId: run.id } }
  )
  const row = await getDb().notifications.get(id)
  expect(JSON.stringify(row)).not.toMatch(/PRIVATE_(TITLE|BODY|HREF|META)/)
  expect(row?.personalContext).toEqual(
    expect.objectContaining({ executionRunId: run.id, receiptAttemptId: expect.any(String) })
  )
  expect(row?.title).toMatch(/private|私密/)
  expect(toast.info).not.toHaveBeenCalledWith("PRIVATE_TITLE", expect.anything())
})

it("preserves the local owner's notification content", async () => {
  const run = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [{ person: { kind: "local-person" }, source: "calendar", markedAt: 1 }],
  })
  const id = await notify(
    {
      source: "scheduler",
      level: "info",
      title: "Owner content",
      body: "Owner body",
      channels: ["center"],
    },
    { personalContext: { executionRunId: run.id } }
  )
  expect(await getDb().notifications.get(id)).toMatchObject({
    title: "Owner content",
    body: "Owner body",
  })
})

it.each(["headless", "tauri"])(
  "withholds owner-private notification fanout to unproven %s companion readers",
  async (platform) => {
    mockPlatform.mockReturnValue(platform)
    const run = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
    await getDb().executionRuns.update(run.id, {
      personalMarks: [{ person: { kind: "local-person" }, source: "calendar", markedAt: 1 }],
    })
    const id = await notify(
      {
        source: "scheduler",
        level: "critical",
        title: "PRIVATE_FANOUT",
        body: "PRIVATE_BODY",
        channels: ["center", "toast", "push"],
      },
      { personalContext: { executionRunId: run.id } }
    )
    expect(mockTransportCall).not.toHaveBeenCalledWith(
      "remote_notification_publish",
      expect.anything()
    )
    expect(mockTransportCall).not.toHaveBeenCalledWith(
      "companion_push_notification",
      expect.anything()
    )
    const row = await getDb().notifications.get(id)
    expect(row?.title).toBe("PRIVATE_FANOUT")
    expect(row?.deliveredVia).not.toContain("push")
    if (platform === "headless") expect(row?.deliveredVia).not.toContain("toast")
    expect(
      (await getDb().actionReviewReceipts.toArray()).some(
        (receipt) => receipt.personal?.outcome === "withheld"
      )
    ).toBe(true)
  }
)

it("keeps unverified remote/system content on the Host-local feed and toast", async () => {
  const { unverifiedPersonalSinkContext } = await import("@/lib/execution/personal-sink")
  const id = await notify(
    {
      source: "connector",
      level: "info",
      title: "Remote notice",
      body: "Original body",
      channels: ["center", "toast"],
    },
    { personalContext: unverifiedPersonalSinkContext("remote frame has no local run") }
  )
  expect(await getDb().notifications.get(id)).toMatchObject({
    title: "Remote notice",
    body: "Original body",
  })
  expect(toast.info).toHaveBeenCalledWith(
    "Remote notice",
    expect.objectContaining({ description: "Original body" })
  )
})

it("coalesces verified notification producers into a live verified taint union", async () => {
  const { readRunPersonalTaint } = await import("@/lib/execution/personal-sink")
  const a = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  const b = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  const input = {
    source: "scheduler" as const,
    level: "info" as const,
    title: "Clean",
    dedupeKey: "verified-union",
    channels: ["center" as const],
  }
  const id = await notify(input, { personalContext: { executionRunId: a.id } })
  expect(
    await notify({ ...input, body: "Retained body" }, { personalContext: { executionRunId: b.id } })
  ).toBe(id)
  const record = (await getDb().notifications.get(id))!
  expect(record.title).toBe("Clean")
  expect(await readRunPersonalTaint(record.personalContext)).toEqual({ verified: true, marks: [] })
  const markA = { person: { kind: "local-person" as const }, source: "source-a", markedAt: 1 }
  const markB = {
    person: {
      kind: "platform" as const,
      platform: "lark",
      adapterId: "bot",
      remoteUserId: "ou_foreign",
    },
    source: "source-b",
    markedAt: 2,
  }
  await getDb().executionRuns.update(a.id, { personalMarks: [markA] })
  await getDb().executionRuns.update(b.id, { personalMarks: [markB] })
  expect(await readRunPersonalTaint(record.personalContext)).toEqual({
    verified: true,
    marks: expect.arrayContaining([markA, markB]),
  })
})

it("coalesces a pre-provenance record without dropping its content locally", async () => {
  const input = {
    source: "scheduler" as const,
    level: "info" as const,
    title: "Legacy notice",
    dedupeKey: "legacy-dedupe",
    channels: ["center" as const],
  }
  const id = await notify(input, { personalContext: { hostOrigin: "fixed-notice" } })
  await getDb().notifications.update(id, { personalContext: undefined } as never)
  expect(
    await notify(
      { ...input, body: "New body" },
      { personalContext: { hostOrigin: "fixed-notice" } }
    )
  ).toBe(id)
  expect(await getDb().notifications.get(id)).toMatchObject({
    title: "Legacy notice",
    body: "New body",
    count: 2,
  })
})
