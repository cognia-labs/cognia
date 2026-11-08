const mockOwnsRuntime = jest.fn(() => true)
const mockUpdateSection = jest.fn(async () => undefined)
const mockApprove = jest.fn(async () => ({ draftId: "d1", alreadyApproved: false }))
const mockReject = jest.fn(async () => undefined)
const mockSendReply = jest.fn(async () => ({ jobId: "j1", messageId: "m1", reused: false }))
const mockMutateInstance = jest.fn(async () => ({ ok: true }))
const mockApplyMutation = jest.fn(async () => ({ conversationKey: "k" }))
const mockUpsert = jest.fn(async () => ({ conversationKey: "k", pinned: true }))

jest.mock("./bootstrap/install-connector-runtime", () => ({
  isConnectorRuntimeOwnedHere: () => mockOwnsRuntime(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...a: unknown[]) => mockUpdateSection(...(a as [])),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: (...a: unknown[]) => mockUpsert(...(a as [])),
}))
jest.mock("./inbox-writes/local", () => ({
  approveDraftLocally: (...a: unknown[]) => mockApprove(...(a as [])),
  rejectDraftLocally: (...a: unknown[]) => mockReject(...(a as [])),
  sendManualReplyLocally: (...a: unknown[]) => mockSendReply(...(a as [])),
  parseManualReplyMessageMetadata: () => undefined,
}))
jest.mock("./inbox-writes/override-mutation", () => ({
  isConversationOverrideMutation: (m: unknown) => (m as { kind?: string })?.kind === "patch",
  applyConversationOverrideMutation: (...a: unknown[]) => mockApplyMutation(...(a as [])),
}))
jest.mock("./instance-transfer", () => ({
  mutateAdapterInstanceOnHost: (...a: unknown[]) => mockMutateInstance(...(a as [])),
}))

import { hostWriteCommands } from "./host-writes"

const context = { partition: false }

beforeEach(() => {
  jest.clearAllMocks()
  mockOwnsRuntime.mockReturnValue(true)
})

describe("connectors host write commands", () => {
  it("answers exactly the commands the manifest declares", async () => {
    const { default: connectors } = await import("./module")
    expect(Object.keys(hostWriteCommands).sort()).toEqual(
      [...connectors.hostWriteCommands!.commands].sort()
    )
  })

  it("approves a draft with the edited segments, behind the runtime ownership check", async () => {
    const segments = [{ type: "text", text: "edited" }]
    await expect(
      hostWriteCommands.connector_approve_draft!({ draftId: "d1", segments }, context)
    ).resolves.toEqual({ draftId: "d1", alreadyApproved: false })
    expect(mockApprove).toHaveBeenCalledWith("d1", { segments })
    await expect(
      hostWriteCommands.connector_approve_draft!({ draftId: "d1", segments: "x" }, context)
    ).rejects.toThrow("connector_approve_draft.segments must be an array when present")
  })

  it("refuses an Inbox write in a process that does not own the runtime, with a retryable message", async () => {
    mockOwnsRuntime.mockReturnValue(false)
    await expect(
      hostWriteCommands.connector_reject_draft!({ draftId: "d1" }, context)
    ).rejects.toThrow(
      "connector_runtime_not_owner: connector_reject_draft reached a process that does not own the connector runtime; retry"
    )
    expect(mockReject).not.toHaveBeenCalled()
  })

  it("requires an idempotency key on a relayed reply", async () => {
    await expect(
      hostWriteCommands.connector_enqueue_outbound!(
        {
          adapterId: "a",
          conversationKey: "k",
          sessionId: "s",
          request: { segments: [], conversationRef: {} },
        },
        context
      )
    ).rejects.toThrow("connector_enqueue_outbound.request.metadata.idempotencyKey is required")
    expect(mockSendReply).not.toHaveBeenCalled()
  })

  it("applies an override mutation attributed to the caller device, or a legacy upsert", async () => {
    const mutation = { kind: "patch", conversationKey: "k", patch: {} }
    await expect(
      hostWriteCommands.conversation_overrides_update!(
        { mutation, callerDeviceId: "dev-1" },
        context
      )
    ).resolves.toEqual({ override: { conversationKey: "k" } })
    expect(mockApplyMutation).toHaveBeenCalledWith(mutation, { via: "device:dev-1" })
    await expect(
      hostWriteCommands.conversation_overrides_update!({ mutation: { kind: "?" } }, context)
    ).rejects.toThrow("conversation_overrides_update.mutation is malformed")
    await expect(
      hostWriteCommands.conversation_overrides_update!(
        { input: { conversationKey: "k", pinned: true } },
        context
      )
    ).resolves.toEqual({ override: { conversationKey: "k", pinned: true } })
  })

  it("hands an adapter instance mutation to the instance transfer", async () => {
    await expect(
      hostWriteCommands.adapter_instance_mutate!({ kind: "import" }, context)
    ).resolves.toEqual({ ok: true })
    expect(mockMutateInstance).toHaveBeenCalledWith({ kind: "import" })
  })

  it("writes each relayed policy section from the mobile source", async () => {
    await hostWriteCommands.adapter_update_policy!({ id: "ad1", muted: true }, context)
    expect(mockUpdateSection).toHaveBeenCalledWith(
      "ad1",
      expect.any(String),
      expect.objectContaining({ muted: true }),
      "mobile"
    )
    await expect(
      hostWriteCommands.adapter_update_policy!({ muted: true }, context)
    ).rejects.toThrow(/adapter_update_policy.id is required/)
  })
})
