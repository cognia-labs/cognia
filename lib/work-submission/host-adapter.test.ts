/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import {
  type AllowedHostStateIntent,
  type HostStateAction,
} from "@cognia/agent-config-types/host-state"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  getWorkSubmission,
  getWorkSubmissionBundle,
  WORK_SUBMISSION_LEASE_TTL_MS,
} from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import { openWorkSubmissionPayload } from "./crypto"
import {
  acceptHostStateChatTurn,
  bindHostStateChatTurnContext,
  claimHostStateChatTurnForDispatch,
  cancelHostStateTurnAfterRestart,
  failHostStateTurnAfterRestart,
  HOST_RESTARTED,
  hostStateRunId,
  hostStateSubmissionId,
  listHostStateTurnsInterruptedBefore,
  markHostStateChatTurnStarted,
  permitHostStateRedispatchAfterRestart,
  revokeHostStateRedispatchPermit,
  hostStateUploadRefs,
  type HostAdapterDeps,
} from "./host-adapter"
import {
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
  consumeAttachmentRefs,
} from "@/lib/db/session-attachment-uploads"
import { sha256Bytes } from "@/lib/utils/hash"

/** Stage a small PNG into `sessionId` the way a member's device does. */
async function stagePng(sessionId: string, name = "shot.png"): Promise<string> {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const init = await beginAttachmentUpload({
    sessionId,
    deviceId: "device-1",
    name,
    mediaType: "image/png",
    size: bytes.byteLength,
    hash: await sha256Bytes(bytes),
  })
  await appendAttachmentChunk({ uploadId: init.uploadId, deviceId: "device-1", offset: 0, bytes })
  return (await commitAttachmentUpload({ uploadId: init.uploadId, deviceId: "device-1" })).ref
}

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const KEY = new Uint8Array(32).fill(13)
const NOW = 1_755_000_000_000

function deps(overrides: Partial<HostAdapterDeps> = {}): HostAdapterDeps {
  return { loadKey: async () => KEY, ...overrides }
}

function action(
  intent: AllowedHostStateIntent = {
    kind: "message.enqueue",
    messageId: "message-1",
    text: "hello from mobile",
    attachments: [],
  },
  overrides: Partial<HostStateAction> = {}
): HostStateAction {
  return {
    channel: "cognia://target/target-1/sessions/session-1",
    accountId: "account-1",
    runtimeTargetId: "target-1",
    hostId: "host-1",
    hostGeneration: 1,
    sessionId: "session-1",
    clientId: "client-1",
    clientSeq: 1,
    actionId: "action-1",
    createdAt: 1_755_000_000_000,
    action: intent,
    ...overrides,
  }
}

describe("id helpers", () => {
  it("derives run and submission ids from the action id", () => {
    expect(hostStateRunId("action-1")).toBe("hoststate:action-1")
    expect(hostStateSubmissionId("action-1")).toBe("work:hoststate:action-1")
  })
})

describe("acceptHostStateChatTurn", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  }, 30_000)

  it.each([true, false])(
    "captures the Host thread parent (retained: %s), ignoring client provenance",
    async (retained) => {
      const { recordedRunMetadata } = await import("@/lib/execution/acting-authority")
      const parent = {
        id: "coordinator",
        kind: "agent-turn" as const,
        sourceId: "coordinator",
        title: "Coordinator",
        status: "running" as const,
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
        ...recordedRunMetadata("local", { runId: "coordinator" }),
        authority: {
          schemaVersion: 1 as const,
          caps: "explicit-v1" as const,
          permissionMode: "plan" as const,
          tools: { allow: ["Read"] },
        },
      }
      if (retained) await getDb().executionRuns.put(parent)
      await getDb().sessions.put({
        id: "session-1",
        title: "Thread",
        createdAt: 1,
        updatedAt: 1,
        projectThread: { parentExecutionRunId: parent.id },
      } as import("@cognia/agent-config-types").ChatSession)
      const incoming = Object.assign(action(), { parentExecutionRunId: "forged-client-parent" })
      const receipt = await acceptHostStateChatTurn(incoming, deps())
      expect(receipt?.runId).toBe("hoststate:action-1")
      const run = await getDb().executionRuns.get(receipt!.runId)
      expect(run?.parentRunId).toBe(retained ? parent.id : undefined)
      expect(run?.authority).toEqual(retained ? parent.authority : undefined)
      if (!retained) {
        const events = await getDb()
          .executionRunEvents.where("runId")
          .equals(receipt!.runId)
          .toArray()
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              seq: 0,
              type: "authority.observed",
              payload: expect.objectContaining({ operation: "coordinator_parent_unavailable" }),
            }),
          ])
        )
      }
    }
  )

  it("accepts an enqueued message from an attached client", async () => {
    const receipt = await acceptHostStateChatTurn(action(), deps())

    expect(receipt).toMatchObject({
      submissionId: "work:hoststate:action-1",
      runId: "hoststate:action-1",
      state: "accepted",
    })
    expect((await getDb().executionRuns.get("hoststate:action-1"))?.actingIdentity).toMatchObject({
      trigger: "local",
      authorizingPrincipal: { kind: "local-person" },
    })
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      accountId: "account-1",
      runtimeTargetId: "target-1",
      sessionId: "session-1",
      sourceKind: "chat",
      triggerId: "action-1",
    })
  }, 30_000)

  it("uses the same idempotency key shape as the renderer", async () => {
    // A turn that reaches the Host twice — once via the client outbox, once
    // locally — is the same work and must collapse onto one submission.
    await acceptHostStateChatTurn(action(), deps())
    const row = await getWorkSubmission("work:hoststate:action-1")
    expect(row?.idempotencyKey).toBe(chatIdempotencyKey("session-1", "message-1"))
  }, 30_000)

  it("keeps a regenerate apart from the turn its question already had", async () => {
    // The question's own turn holds the plain key; a regenerate is new work.
    await acceptHostStateChatTurn(action(), deps())
    const regenerate = action(
      {
        kind: "message.enqueue",
        messageId: "message-1",
        text: "hello from mobile",
        attachments: [],
        branch: { kind: "regenerate" },
      },
      { actionId: "action-2" }
    )
    const receipt = await acceptHostStateChatTurn(regenerate, deps())
    expect(receipt?.submissionId).toBe("work:hoststate:action-2")
    expect((await getWorkSubmission("work:hoststate:action-2"))?.idempotencyKey).toBe(
      chatIdempotencyKey("session-1", "message-1#regenerate:action-2")
    )
    // Its own redelivery still collapses.
    await expect(acceptHostStateChatTurn(regenerate, deps())).resolves.toEqual(receipt)
  }, 30_000)

  it("collapses a redelivered action onto the original submission", async () => {
    const first = await acceptHostStateChatTurn(action(), deps())
    const second = await acceptHostStateChatTurn(action(), deps())
    expect(second).toEqual(first)
    expect(await getDb().workSubmissions.count()).toBe(1)
  }, 30_000)

  it("collapses a re-sent message that arrives under a different action id", async () => {
    // The transport may retry with a fresh action id; the message id is what
    // identifies the work.
    await acceptHostStateChatTurn(action(), deps())
    const replay = await acceptHostStateChatTurn(
      action(undefined, { actionId: "action-2" }),
      deps()
    )
    expect(replay?.submissionId).toBe("work:hoststate:action-1")
    expect(await getDb().workSubmissions.count()).toBe(1)
  }, 30_000)

  it("freezes the enqueued text as the model-side input", async () => {
    await acceptHostStateChatTurn(action(), deps())
    const batch = await getDb().workInputBatches.get("input:hoststate:action-1")
    expect(batch?.visibleMessageIds).toEqual(["message-1"])
    expect(batch?.attachments).toEqual([])
    expect(JSON.stringify(batch?.envelope)).not.toContain("hello from mobile")
  }, 30_000)

  it.each<AllowedHostStateIntent>([
    { kind: "turn.abort" },
    { kind: "turn.steer", text: "actually, stop" },
    { kind: "draft.replace", text: "draft", attachments: [] },
    { kind: "session.rename", title: "renamed" },
  ])(
    "ignores the $kind intent",
    async (intent) => {
      expect(await acceptHostStateChatTurn(action(intent), deps())).toBeNull()
      expect(await getDb().workSubmissions.count()).toBe(0)
    },
    30_000
  )

  it("ignores an action with no session", async () => {
    const withoutSession = action()
    delete (withoutSession as { sessionId?: string }).sessionId
    expect(await acceptHostStateChatTurn(withoutSession, deps())).toBeNull()
  }, 30_000)

  it("reports a rejection rather than dropping the client's message", async () => {
    const onError = jest.fn()
    const receipt = await acceptHostStateChatTurn(
      action(undefined, { accountId: "" }),
      deps({ onError })
    )
    expect(receipt).toBeNull()
    expect(onError).toHaveBeenCalled()
  }, 30_000)

  it("refuses a rejected project-thread acceptance before an uncapped fallback can dispatch", async () => {
    await getDb().sessions.put({
      id: "session-1",
      projectThread: { parentExecutionRunId: "coordinator" },
    } as never)
    await getDb().executionRuns.put({
      id: "coordinator",
      kind: "agent-turn",
      sourceId: "coordinator",
      title: "Coordinator",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
      authority: { schemaVersion: 1, caps: "explicit-v1" as const, tools: { allow: ["Read"] } },
    })
    await expect(
      acceptHostStateChatTurn(action(undefined, { accountId: "" }), deps())
    ).rejects.toMatchObject({ name: "WorkSubmissionRejectedError", code: "invalid_intent" })
    expect(await getDb().executionRuns.get(hostStateRunId("action-1"))).toBeUndefined()
  })

  it("propagates an unexpected failure instead of silently continuing", async () => {
    const onError = jest.fn()
    await expect(
      acceptHostStateChatTurn(
        action(),
        deps({
          onError,
          loadKey: async () => {
            throw new Error("keyring unavailable")
          },
        })
      )
    ).rejects.toThrow("keyring unavailable")
    expect(onError).toHaveBeenCalled()
  }, 30_000)
})

describe("HostState live handoff", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptHostStateChatTurn(action(), deps())
  }, 30_000)

  it("freezes the production send options before HostState dispatch", async () => {
    expect(
      await bindHostStateChatTurnContext(
        action(),
        { cwd: "/srv/original", model: "claude-sonnet-4-5" },
        deps()
      )
    ).toBe(true)
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      contextBundleId: "context:hoststate:action-1",
    })
  }, 30_000)

  it("claims the accepted turn before HostState assembles its send options", async () => {
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW, deps())).toBe("claimed")
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "claimed",
      leaseOwner: "host-state",
    })
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW + 1, deps())).toBe(
      "owned_elsewhere"
    )
  }, 30_000)

  it("marks the successful HostState handoff dispatched", async () => {
    expect(await markHostStateChatTurnStarted("action-1", NOW + 1, deps())).toBe(true)
    expect((await getWorkSubmission("work:hoststate:action-1"))?.dispatchState).toBe("dispatched")
  }, 30_000)

  it("adr-0253 g25 freezes the turn's staged uploads by ref and verified hash", async () => {
    await getDb().delete()
    __resetDbForTesting()
    const ref = await stagePng("session-1", "a/b\\shot.png")
    const receipt = await acceptHostStateChatTurn(
      action({
        kind: "message.enqueue",
        messageId: "message-1",
        text: "look",
        attachments: [
          { ref, name: "spoofed.exe", mediaType: "text/plain", size: 1 },
          // Gone from the store: the dispatch refuses the turn for it.
          { ref: "cognia-upload:upl_missing", name: "gone.png", mediaType: "image/png", size: 3 },
        ],
      }),
      deps()
    )
    expect(receipt).not.toBeNull()
    const bundle = await getWorkSubmissionBundle("work:hoststate:action-1")
    // The store's verified facts, not the client's labels; never a path.
    expect(bundle?.inputBatch?.attachments).toEqual([
      {
        assetId: ref,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        mediaType: "image/png",
        size: 32,
        fileName: "a_b_shot.png",
      },
    ])
    expect(hostStateUploadRefs(bundle!.inputBatch!.attachments)).toEqual([ref])
    // The context no longer carries a side count of them.
    expect(await bindHostStateChatTurnContext(action(), { model: "m" }, deps())).toBe(true)
    const context = JSON.parse(
      await openWorkSubmissionPayload(
        (await getWorkSubmissionBundle("work:hoststate:action-1"))!.contextBundle!.envelope,
        { accountId: "account-1", submissionId: "work:hoststate:action-1", kind: "context-bundle" },
        deps()
      )
    )
    expect(context.detail).toBeUndefined()
  }, 30_000)
})

describe("HostState redrive of an earlier attempt", () => {
  const LATER = NOW + WORK_SUBMISSION_LEASE_TTL_MS + 1

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptHostStateChatTurn(action(), deps())
    // A previous Host claimed and handed the turn off, then died.
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW, deps())).toBe("claimed")
    expect(await markHostStateChatTurnStarted("action-1", NOW, deps())).toBe(true)
  }, 30_000)

  it("leaves a turn whose lease is still live to its owner", async () => {
    const listRunEvents = jest.fn(async () => [])
    expect(
      await claimHostStateChatTurnForDispatch("action-1", NOW + 1, deps({ listRunEvents }))
    ).toBe("owned_elsewhere")
    expect(listRunEvents).not.toHaveBeenCalled()
    expect((await getWorkSubmission("work:hoststate:action-1"))?.dispatchState).toBe("dispatched")
  }, 30_000)

  it("parks a turn that already reached a tool instead of sending it again", async () => {
    const abortPrevious = jest.fn(async () => undefined)
    const listRunEvents = jest.fn(async () => [{ type: "tool.started" }] as never)
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({ listRunEvents, abortPrevious })
      )
    ).toBe("recovery_required")
    // The runtime that took the turn may still be running it: it is stopped
    // rather than left working on a turn nobody owns any more.
    expect(abortPrevious).toHaveBeenCalledWith(
      expect.objectContaining({ id: "work:hoststate:action-1", sessionId: "session-1" })
    )
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "observed-tool-activity",
    })
  }, 30_000)

  it("stops the previous runtime and parks a turn whose logs are empty", async () => {
    // Empty logs do not show the runtime had not started: the turn waits for
    // a person instead of being sent again.
    const abortPrevious = jest.fn(async () => undefined)
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({
          listRunEvents: async () => [],
          readEnvelopes: async () => [],
          abortPrevious,
        })
      )
    ).toBe("recovery_required")
    expect(abortPrevious).toHaveBeenCalledWith(
      expect.objectContaining({ id: "work:hoststate:action-1", sessionId: "session-1" })
    )
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "unconfirmed-attempt",
    })
  }, 30_000)

  it("parks the turn when the previous runtime cannot be stopped", async () => {
    const onError = jest.fn()
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({
          listRunEvents: async () => [],
          readEnvelopes: async () => [],
          abortPrevious: async () => {
            throw new Error("sidecar unreachable")
          },
          onError,
        })
      )
    ).toBe("recovery_required")
    expect(onError).toHaveBeenCalled()
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      errorCode: "takeover_abort_failed",
    })
  }, 30_000)

  it("does not touch a settled turn", async () => {
    const listRunEvents = jest.fn(async () => [{ type: "tool.started" }] as never)
    await claimHostStateChatTurnForDispatch("action-1", LATER, deps({ listRunEvents }))
    listRunEvents.mockClear()
    expect(
      await claimHostStateChatTurnForDispatch("action-1", LATER + 1, deps({ listRunEvents }))
    ).toBe("owned_elsewhere")
    expect(listRunEvents).not.toHaveBeenCalled()
  }, 30_000)
})

describe("after a Host restart (ADR-0253 §7)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptHostStateChatTurn(action(), deps())
    // The previous Host claimed the turn, handed it off and restarted.
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW, deps())).toBe("claimed")
    expect(await markHostStateChatTurnStarted("action-1", NOW, deps())).toBe(true)
  }, 30_000)

  it("sends a permitted turn again past its dead lease and its tool activity, once", async () => {
    const abortPrevious = jest.fn(async () => undefined)
    const listRunEvents = jest.fn(async () => [{ type: "tool.started" }] as never)
    permitHostStateRedispatchAfterRestart("action-1")
    // Still inside the old lease, with a tool already run: the organization
    // chose at-least-once, and the runtime that held it is gone.
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        NOW + 1,
        deps({ abortPrevious, listRunEvents })
      )
    ).toBe("claimed")
    expect(listRunEvents).not.toHaveBeenCalled()
    expect(abortPrevious).not.toHaveBeenCalled()
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "claimed",
      attemptCount: 2,
    })
    // The permit was spent: the next claim is fenced as before.
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW + 2, deps())).toBe(
      "owned_elsewhere"
    )
  }, 30_000)

  it("a revoked permit lets nothing through", async () => {
    permitHostStateRedispatchAfterRestart("action-1")
    revokeHostStateRedispatchPermit("action-1")
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW + 1, deps())).toBe(
      "owned_elsewhere"
    )
  }, 30_000)

  it("lists the open turns accepted before the Host booted, oldest first, with their words", async () => {
    await acceptHostStateChatTurn(
      action(
        { kind: "message.enqueue", messageId: "message-2", text: "and then", attachments: [] },
        { actionId: "action-2" }
      ),
      deps()
    )
    const bootedAt = Date.now() + 60_000
    const turns = await listHostStateTurnsInterruptedBefore("session-1", bootedAt, deps())
    expect(turns).toEqual([
      expect.objectContaining({
        submissionId: "work:hoststate:action-1",
        actionId: "action-1",
        sessionId: "session-1",
        messageId: "message-1",
        text: "hello from mobile",
        attachments: [],
        attachmentsLost: false,
      }),
      expect.objectContaining({ actionId: "action-2", messageId: "message-2", text: "and then" }),
    ])
    // Accepted after the boot: this Host's own, not the previous one's.
    await expect(listHostStateTurnsInterruptedBefore("session-1", 0, deps())).resolves.toEqual([])
    await expect(
      listHostStateTurnsInterruptedBefore("session-other", bootedAt, deps())
    ).resolves.toEqual([])
  }, 30_000)

  it("carries a turn's staged uploads, and marks them lost once they are gone", async () => {
    const ref = await stagePng("session-files")
    await acceptHostStateChatTurn(
      action(
        {
          kind: "message.enqueue",
          messageId: "message-9",
          text: "look",
          attachments: [{ ref, name: "shot.png", mediaType: "image/png", size: 32 }],
        },
        { actionId: "action-9", sessionId: "session-files" }
      ),
      deps()
    )
    const bootedAt = Date.now() + 60_000
    const [withFiles] = await listHostStateTurnsInterruptedBefore("session-files", bootedAt, deps())
    expect(withFiles).toMatchObject({
      text: "look",
      attachments: [
        {
          ref,
          name: "shot.png",
          mediaType: "image/png",
          size: 32,
          hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      attachmentsLost: false,
    })
    await consumeAttachmentRefs([ref])
    const [consumed] = await listHostStateTurnsInterruptedBefore("session-files", bootedAt, deps())
    expect(consumed).toMatchObject({ attachmentsLost: true })
  }, 30_000)

  it("leaves unreadable words null", async () => {
    const bootedAt = Date.now() + 60_000
    // Another key cannot open the frozen input.
    const [unreadable] = await listHostStateTurnsInterruptedBefore("session-1", bootedAt, {
      loadKey: async () => new Uint8Array(32).fill(7),
    })
    expect(unreadable).toMatchObject({ actionId: "action-1", messageId: null, text: null })
  }, 30_000)

  it("ends a turn its Host had been told to stop as cancelled, and only once", async () => {
    expect(await cancelHostStateTurnAfterRestart("work:hoststate:action-1", NOW + 5)).toBe(true)
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "cancelled",
      errorCode: HOST_RESTARTED,
    })
    expect(await cancelHostStateTurnAfterRestart("work:hoststate:action-1", NOW + 6)).toBe(false)
    expect(await failHostStateTurnAfterRestart("work:hoststate:action-1", NOW + 7)).toBe(false)
  }, 30_000)

  it("ends a turn it will not retry as host_restarted, and only once", async () => {
    expect(await failHostStateTurnAfterRestart("work:hoststate:action-1", NOW + 5)).toBe(true)
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "failed",
      errorCode: HOST_RESTARTED,
    })
    expect(await failHostStateTurnAfterRestart("work:hoststate:action-1", NOW + 6)).toBe(false)
    await expect(
      listHostStateTurnsInterruptedBefore("session-1", Date.now() + 60_000, deps())
    ).resolves.toEqual([])
  }, 30_000)
})
