import type { ActingIdentityV1, PrincipalRefV1 } from "./acting-identity"
import { effectivePersonalMarks, personalReaders, withholdForReaders } from "./personal-visibility"

const owner: PrincipalRefV1 = { kind: "local-person" }
const other: PrincipalRefV1 = {
  kind: "platform",
  platform: "lark",
  adapterId: "a",
  remoteUserId: "b",
}
const identity = (patch: Partial<ActingIdentityV1> = {}): ActingIdentityV1 => ({
  schemaVersion: 1,
  lane: "delegated",
  trigger: "requester",
  requesters: [owner],
  authorityRevision: 0,
  ...patch,
})
const mark = { person: owner, source: "private-tool-name", markedAt: 1 }
const message = {
  id: "secret",
  role: "assistant",
  createdAt: 2,
  parts: [{ type: "dynamic-tool", toolName: "private-tool-name", output: "secret-snippet" }],
  content: "secret-snippet",
  title: "private-title",
  metadata: { personalMarks: [mark], title: "private-title" },
}

it("limits disclosure to the exact message in the original conversation session and changes even an owner's digest", () => {
  const disclosure = {
    receiptId: "receipt",
    messageId: "secret",
    sessionId: "session",
    target: { adapterId: "a", conversationKey: "lark:a:group" },
    persons: [owner],
    contentHash: "hash",
    grantedBy: owner,
    grantedAt: 2,
  }
  const context = {
    sessionId: "session",
    conversationKey: "lark:a:group",
    disclosures: [disclosure],
  }
  expect(withholdForReaders([message], [other], {}, context).withheldMessageIds).toEqual([])
  expect(
    withholdForReaders([message], [other], {}, { ...context, sessionId: "another" })
      .withheldMessageIds
  ).toEqual(["secret"])
  expect(
    withholdForReaders([message], [other], {}, { ...context, conversationKey: "lark:a:elsewhere" })
      .withheldMessageIds
  ).toEqual(["secret"])
  expect(withholdForReaders([message], [], {}, context).withheldMessageIds).toEqual(["secret"])
  expect(withholdForReaders([message], [owner], {}, context).visibilityDigest).not.toBe(
    withholdForReaders([message], [owner]).visibilityDigest
  )
  expect(
    withholdForReaders(
      [{ ...message, metadata: { ...message.metadata, personalDisclosures: [disclosure] } }],
      [other]
    ).withheldMessageIds
  ).toEqual(["secret"])
})

it("uses every requester, but never service, event, unverified or orphan-child authority", () => {
  expect(personalReaders(identity({ requesters: [owner, other] }))).toEqual([owner, other])
  expect(
    personalReaders(identity({ requesters: [], trigger: "schedule", authorizingPrincipal: owner }))
  ).toEqual([owner])
  expect(
    personalReaders(identity({ requesters: [], trigger: "local", authorizingPrincipal: owner }))
  ).toEqual([owner])
  for (const value of [
    undefined,
    identity({ lane: "service" }),
    identity({ trigger: "external-event" }),
    identity({ requesters: [], trigger: "child", authorizingPrincipal: owner }),
    identity({ requesters: [{ kind: "event-actor", source: "webhook" }] }),
  ]) {
    expect(personalReaders(value)).toEqual([])
  }
})

it("withholds the entire message including tools, titles, attachments and metadata", () => {
  for (const readers of [[], [other], [owner, other]]) {
    const result = withholdForReaders([message], readers)
    expect(result.withheldMessageIds).toEqual(["secret"])
    const serialized = JSON.stringify(result.messages)
    for (const secret of ["private-tool-name", "private-title", "secret-snippet"])
      expect(serialized).not.toContain(secret)
    expect(result.messages[0].parts).toEqual([
      { type: "text", text: "[Withheld: personal content of Host owner]" },
    ])
    expect(result.messages[0].content).toBe("[Withheld: personal content of Host owner]")
  }
  expect(withholdForReaders([message], [owner]).messages[0]).toBe(message)
})

it("requires all readers to equal all marks, with no disclosure granting access yet", () => {
  const multiple = { ...message, metadata: { personalMarks: [mark, { ...mark, person: other }] } }
  expect(withholdForReaders([multiple], [owner]).withheldMessageIds).toEqual(["secret"])
  const publicMessage = { ...message, metadata: { personalMarkVersion: 1 } }
  expect(withholdForReaders([publicMessage], []).messages[0]).toBe(publicMessage)
})

it("never turns missing derived provenance into an owner grant", () => {
  const unverified = {
    ...message,
    metadata: {
      personalMarks: [
        {
          person: { kind: "service" as const, ref: "unverified-personal-history" },
          source: "unverified-derived-history",
          markedAt: 0,
        },
      ],
    },
  }
  for (const readers of [[], [owner], [other]]) {
    const result = withholdForReaders([unverified], readers)
    expect(result.withheldMessageIds).toEqual(["secret"])
    expect(result.messages[0].content).toBe("[Withheld: personal content of unverified person]")
  }
})

it("attributes legacy connector rows to their bound person, never their sender", () => {
  const legacy = { ...message, metadata: { sender: other } }
  const session = { platformBinding: { adapterId: "a" } }
  const context = { boundPerson: owner, source: "lark-user" }
  expect(effectivePersonalMarks(legacy, session, context)).toEqual([
    { ...mark, source: "lark-user", markedAt: 2 },
  ])
  expect(withholdForReaders([legacy], [other], session, context).withheldMessageIds).toEqual([
    "secret",
  ])
  expect(withholdForReaders([legacy], [owner], session, context).messages[0]).toBe(legacy)
  expect(legacy.metadata).toEqual({ sender: other })
})

it("digests sets stably and changes on either readers or withheld ids, not text or order", () => {
  const publicMessage = { id: "public", parts: [], metadata: { personalMarkVersion: 1 } }
  const digest = withholdForReaders([message, publicMessage], [other, owner]).visibilityDigest
  expect(
    withholdForReaders([publicMessage, { ...message, title: "changed" }], [owner, other, owner])
      .visibilityDigest
  ).toBe(digest)
  expect(withholdForReaders([message], [owner]).visibilityDigest).not.toBe(digest)
  expect(
    withholdForReaders([{ ...message, id: "another" }], [other, owner]).visibilityDigest
  ).not.toBe(digest)
  expect(digest).toMatch(/^personal-v1:sha256-[a-f0-9]{64}$/)
})

it("retains structural turn and branch identity while removing content-bearing metadata", () => {
  const row = {
    ...message,
    turnKey: "turn-1",
    senderId: "member-id",
    metadata: {
      ...message.metadata,
      branchGroupId: "group",
      branchOwnerId: "owner-id",
      branchIndex: 1,
    },
  }
  const filtered = withholdForReaders([row], [other]).messages[0]
  expect(filtered).toMatchObject({
    turnKey: "turn-1",
    senderId: "member-id",
    metadata: { branchGroupId: "group", branchOwnerId: "owner-id", branchIndex: 1 },
  })
  expect(JSON.stringify(filtered)).not.toMatch(/private-title|private-tool-name|secret-snippet/)
})
