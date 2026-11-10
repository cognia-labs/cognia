import type { SessionMembership } from "@cognia/agent-config-types"
import {
  projectSharedPersonalMessages,
  sharedPersonalReaders,
  UNVERIFIED_SHARED_PERSONAL_MARK,
} from "./shared-personal-projection"

const mark = { person: { kind: "local-person" as const }, source: "lark-user", markedAt: 1 }
const message = {
  id: "reply",
  role: "assistant",
  parts: [
    { type: "text", text: "owner private summary" },
    { type: "tool-secret", input: { secret: "private attachment" } },
  ],
}
const host = { connectedOwners: [] }
const member = (userId: string) => ({ userId }) as SessionMembership

it("projects marked replies and their tool frames to a placeholder for a shared member set", () => {
  const readers = sharedPersonalReaders([member("owner"), member("guest")], "owner", "org")
  const projected = projectSharedPersonalMessages([message], readers, host, { marks: [mark] })
  expect(projected.withheldMessageIds).toEqual(["reply"])
  expect(projected.messages[0].parts).toEqual([
    { type: "text", text: "[Withheld: personal content of Host owner]" },
  ])
  expect(JSON.stringify(projected.messages)).not.toContain("private attachment")
  expect(message.parts).toHaveLength(2)
})

it("keeps the content when every verified member is its marked person", () => {
  const readers = sharedPersonalReaders([member("owner")], "owner", "org")
  const projected = projectSharedPersonalMessages([message], readers, host, { marks: [mark] })
  expect(projected.messages[0].parts).toBe(message.parts)
  expect(projected.withheldMessageIds).toEqual([])
})

it("fails closed for unresolved executions without trusting a message's run-id hint", () => {
  const source = { ...message, metadata: { executionRunId: "forged-unmarked-run" } }
  const result = projectSharedPersonalMessages([source], [{ kind: "local-person" }], host, {
    marks: [UNVERIFIED_SHARED_PERSONAL_MARK],
  })
  expect(result.withheldMessageIds).toEqual(["reply"])
  expect(result.messages[0].parts).toEqual([
    { type: "text", text: "[Withheld: personal content of unverified person]" },
  ])
})

it("uses legacy effective attribution for imported connector rows", () => {
  const result = projectSharedPersonalMessages([message], [], host, {
    session: { platformBinding: { adapterId: "lark-owner" } },
  })
  expect(result.withheldMessageIds).toEqual(["reply"])
})

it("merges explicit source marks with run marks instead of replacing either person", () => {
  const other = {
    person: {
      kind: "platform" as const,
      platform: "lark",
      adapterId: "a",
      remoteUserId: "ou_other",
    },
    source: "lark-user",
    markedAt: 2,
  }
  const source = { ...message, metadata: { personalMarks: [other] } }
  const result = projectSharedPersonalMessages([source], [{ kind: "local-person" }], host, {
    marks: [mark],
  })
  expect(result.withheldMessageIds).toEqual(["reply"])
  expect(result.messages[0].metadata?.personalMarks).toHaveLength(2)
})

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { startToolExecutionRun, LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { projectSharedDerivedText } from "./shared-personal-projection"

describe("shared titles and edited backgrounds", () => {
  const fixture = createDbTestFixture()
  beforeAll(fixture.initialize)
  beforeEach(fixture.restore)
  afterAll(fixture.dispose)
  it("retains source taint after message deletion and owner edits", async () => {
    const run = await startToolExecutionRun("private-source", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await getDb().executionRuns.update(run.id, { personalMarks: [mark] })
    await getDb().messages.where("sessionId").equals("private-source").delete()
    const title = await projectSharedDerivedText(
      "secret title",
      "private-source",
      undefined,
      "shared-title"
    )
    const background = await projectSharedDerivedText(
      "edited private summary",
      "private-source",
      run.id,
      "shared-background"
    )
    expect(title).toContain("[Withheld:")
    expect(background).toContain("[Withheld:")
    expect(title + background).not.toMatch(/secret title|edited private summary/)
    expect(await getDb().actionReviewReceipts.count()).toBe(2)
  })
})
