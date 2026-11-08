import { isLocallyOrchestratedRoom, isMultiHumanRoom, platformScopeOf, roomKindOf } from "./kind"

const bindingFields = { platform: "telegram", adapterId: "a", conversationKey: "k" }
const binding = bindingFields as never
const collaboration = {
  orgId: "org",
  workspaceId: "ws",
  sessionId: "s",
  policyRevision: 1,
  syncCursor: 0,
}

describe("roomKindOf", () => {
  it("is null for a plain direct conversation", () => {
    expect(roomKindOf({ kind: "direct" })).toBeNull()
    expect(roomKindOf(undefined)).toBeNull()
  })

  it("reads a character team off kind + teamId", () => {
    expect(roomKindOf({ kind: "team", teamId: "t" })).toBe("team")
    expect(roomKindOf({ kind: "team" })).toBeNull()
  })

  it("reads an IM group off the platform binding", () => {
    expect(roomKindOf({ kind: "direct", platformBinding: binding })).toBe("im")
  })

  it("is null for a one-to-one IM chat, whichever field names its scope", () => {
    const dm = (extra: Record<string, unknown>) =>
      ({ kind: "direct", platformBinding: { ...bindingFields, ...extra } }) as never
    expect(roomKindOf(dm({ scopeKind: "private" }))).toBeNull()
    expect(roomKindOf(dm({ deliveryTarget: { address: { scopeKind: "private" } } }))).toBeNull()
    expect(roomKindOf(dm({ conversationRef: { scopeKind: "private" } }))).toBeNull()
    expect(roomKindOf(dm({ conversationRef: { channelKind: "private" } }))).toBeNull()
    expect(roomKindOf(dm({ scopeKind: "thread" }))).toBe("im")
  })

  it("lets a shared binding win over every other column", () => {
    expect(roomKindOf({ kind: "team", teamId: "t", collaboration, platformBinding: binding })).toBe(
      "shared"
    )
  })
})

describe("room predicates", () => {
  it("only a team room is orchestrated locally", () => {
    expect(isLocallyOrchestratedRoom({ kind: "team", teamId: "t" })).toBe(true)
    expect(isLocallyOrchestratedRoom({ kind: "team", teamId: "t", collaboration })).toBe(false)
    expect(isLocallyOrchestratedRoom({ kind: "direct", platformBinding: binding })).toBe(false)
  })

  it("shared and IM rooms can hold more than one human", () => {
    expect(isMultiHumanRoom("shared")).toBe(true)
    expect(isMultiHumanRoom("im")).toBe(true)
    expect(isMultiHumanRoom("team")).toBe(false)
    expect(isMultiHumanRoom(null)).toBe(false)
  })
})

describe("platformScopeOf", () => {
  it("prefers the stamped scope, then the delivery target, then the reference", () => {
    expect(
      platformScopeOf({
        ...bindingFields,
        scopeKind: "group",
        deliveryTarget: { address: { scopeKind: "private" } },
      } as never)
    ).toBe("group")
    expect(
      platformScopeOf({
        ...bindingFields,
        deliveryTarget: { address: { scopeKind: "channel" } },
        conversationRef: { scopeKind: "private" },
      } as never)
    ).toBe("channel")
    expect(
      platformScopeOf({ ...bindingFields, conversationRef: { channelKind: "thread" } } as never)
    ).toBe("thread")
  })

  it("says nothing when nothing names the scope, which reads as a room", () => {
    expect(platformScopeOf(binding)).toBeUndefined()
    expect(
      platformScopeOf({ ...bindingFields, conversationRef: { scopeKind: "lobby" } } as never)
    ).toBeUndefined()
    expect(roomKindOf({ platformBinding: binding })).toBe("im")
  })
})
