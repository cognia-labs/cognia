/** @jest-environment node */
import type {
  ActingIdentityV1,
  PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { engineLaunchProfile } from "./launch-profile"

const mockResolveRunActingIdentity = jest.fn()
const mockPlatformRequesterIsOwner = jest.fn()
jest.mock("@/lib/execution/acting-authority", () => ({
  resolveRunActingIdentity: (...args: unknown[]) => mockResolveRunActingIdentity(...args),
}))
jest.mock("@/lib/chat/conversation-channel", () => ({
  platformRequesterIsOwner: (requester: unknown) => mockPlatformRequesterIsOwner(requester),
}))

const local: PrincipalRefV1 = { kind: "local-person" }
const member: PrincipalRefV1 = {
  kind: "platform",
  platform: "lark",
  adapterId: "adp_1",
  remoteUserId: "ou_member",
}
const owner: PrincipalRefV1 = { ...member, remoteUserId: "ou_owner" }

function identity(fields: Partial<ActingIdentityV1>): ActingIdentityV1 {
  return {
    schemaVersion: 1,
    rootRunId: "run-root",
    lane: "delegated",
    trigger: "requester",
    requesters: [],
    authorityRevision: 1,
    ...fields,
  }
}

const run = { executionRunId: "run-1" }

async function profileFor(found: ActingIdentityV1 | undefined, chatSessionId?: string) {
  mockResolveRunActingIdentity.mockResolvedValueOnce(found)
  return engineLaunchProfile({ context: run, ...(chatSessionId ? { chatSessionId } : {}) })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPlatformRequesterIsOwner.mockImplementation(
    async (requester: { remoteUserId: string }) => requester.remoteUserId === "ou_owner"
  )
})

describe("engineLaunchProfile", () => {
  it("is the owner's for an execution bound to no run", async () => {
    await expect(engineLaunchProfile({ context: undefined })).resolves.toEqual({ kind: "owner" })
    await expect(engineLaunchProfile({ context: {} })).resolves.toEqual({ kind: "owner" })
    expect(mockResolveRunActingIdentity).not.toHaveBeenCalled()
  })

  it("is the owner's for the local person's own run and a verified owner's request", async () => {
    const own = { trigger: "local" as const, authorizingPrincipal: local, requesters: [local] }
    await expect(profileFor(identity(own))).resolves.toEqual({ kind: "owner" })
    expect(mockResolveRunActingIdentity).toHaveBeenCalledWith(undefined, "run-1")
    await expect(
      profileFor(identity({ ...own, trigger: "schedule", requesters: [] }))
    ).resolves.toEqual({ kind: "owner" })
    await expect(profileFor(identity({ requesters: [local] }))).resolves.toEqual({ kind: "owner" })
    await expect(profileFor(identity({ requesters: [owner] }))).resolves.toEqual({ kind: "owner" })
    expect(mockPlatformRequesterIsOwner).toHaveBeenCalledWith(owner)
  })

  it.each<[string, ActingIdentityV1 | undefined, string]>([
    ["an unreadable identity", undefined, "requester"],
    ["the service lane", identity({ lane: "service", requesters: [local] }), "service"],
    ["an external event", identity({ trigger: "external-event" }), "event"],
    ["someone else's request", identity({ requesters: [member] }), "requester"],
    ["the owner with someone else", identity({ requesters: [owner, member] }), "requester"],
    ["a request with no requester", identity({ requesters: [] }), "requester"],
    [
      "a local run someone else joined",
      identity({ trigger: "local", authorizingPrincipal: local, requesters: [local, member] }),
      "requester",
    ],
    [
      "a local run no local person authorised",
      identity({ trigger: "local", authorizingPrincipal: member }),
      "requester",
    ],
    ["a child trigger", identity({ trigger: "child", requesters: [local] }), "requester"],
  ])("isolates %s", async (_label, found, reason) => {
    await expect(profileFor(found, "chat-1")).resolves.toMatchObject({
      kind: "isolated",
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      reason,
    })
  })

  it("keys a conversation's private state by its requester set, in any order", async () => {
    const one = await profileFor(identity({ requesters: [member] }), "chat-1")
    const again = await profileFor(identity({ requesters: [member] }), "chat-1")
    const joined = await profileFor(identity({ requesters: [member, owner] }), "chat-1")
    const reordered = await profileFor(identity({ requesters: [owner, member] }), "chat-1")
    const elsewhere = await profileFor(identity({ requesters: [member] }), "chat-2")
    const key = (profile: Awaited<ReturnType<typeof profileFor>>) =>
      profile.kind === "isolated" ? profile.key : undefined
    expect(key(again)).toBe(key(one))
    expect(key(joined)).not.toBe(key(one))
    expect(key(reordered)).toBe(key(joined))
    expect(key(elsewhere)).not.toBe(key(one))
  })

  it("keys a run without a conversation by its run tree", async () => {
    const key = async (found: ActingIdentityV1 | undefined) => {
      const profile = await profileFor(found)
      return profile.kind === "isolated" ? profile.key : undefined
    }
    const root = await key(identity({ requesters: [member] }))
    expect(await key(identity({ requesters: [member] }))).toBe(root)
    expect(await key(identity({ rootRunId: "run-other", requesters: [member] }))).not.toBe(root)
    // Without a recorded root the run itself is the scope.
    expect(await key(identity({ rootRunId: undefined, requesters: [member] }))).not.toBe(root)
  })
})
