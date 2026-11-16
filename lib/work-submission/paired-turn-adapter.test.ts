/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  closeSession: jest.fn(async () => {}),
  mcpRuntimeConfigurationMatches: jest.fn(() => true),
  sessionControl: jest.fn(async () => null),
}))
import { webcrypto } from "node:crypto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getWorkSubmission } from "@/lib/db/work-submissions"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import { settleChatTurnForSession } from "./chat-adapter"
import {
  abandonPairedChatTurn,
  admitPairedChatTurn,
  dispatchPairedTurnCommand,
  isPairedTurnCommand,
  PAIRED_TURN_LEASE_OWNER,
  type PairedTurnAdapterDeps,
} from "./paired-turn-adapter"

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const KEY = new Uint8Array(32).fill(21)
const NOW = 1_755_000_000_000

const heartbeat = jest.fn(() => () => {})

function deps(overrides: Partial<PairedTurnAdapterDeps> = {}): PairedTurnAdapterDeps {
  return { loadKey: async () => KEY, now: () => NOW, startHeartbeat: heartbeat, ...overrides }
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pairedReader: "owner",
    sessionId: "session-1",
    runId: "paired:request-1",
    prompt: "use my connection",
    messageId: "user-message-1",
    callerAccountId: "account-1",
    authoritativeHostId: "host-1",
    callerDeviceId: "browser-device",
    callerDeviceGrants: ["agent.control"],
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  heartbeat.mockClear()
  setActiveRuntimeTargetContext("account-1", "target-1")
  await getDb().sessions.put({
    id: "session-1",
    title: "New conversation",
    transcriptRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  })
}, 30_000)

afterEach(() => {
  clearActiveRuntimeTargetContext()
})

describe("admitPairedChatTurn", () => {
  it.each([{}, { B: "A" }])("rebuilds a client MCP identity map on the Host: %j", async (map) => {
    const { startToolExecutionRun } = await import("@/lib/execution/acting-authority")
    await startToolExecutionRun("coordinator", {
      runId: "coordinator",
      authority: { schemaVersion: 1, mcpServers: { only: ["A"] } },
    })
    await getDb().sessions.update("session-1", {
      projectThread: { parentExecutionRunId: "coordinator" } as never,
    })
    await getDb().mcpServers.bulkPut(
      ["A", "B"].map((id) => ({
        id,
        name: id,
        enabled: true,
        transport: "stdio" as const,
        config: { command: id },
        createdAt: 1,
        updatedAt: 1,
      }))
    )
    const result = await admitPairedChatTurn(
      request({
        options: {
          runAuthorityMcpServerIds: map,
          mcpServers: {
            A: { command: "A" },
            B: { command: "B" },
            unmapped: { command: "unknown" },
          },
          agents: {
            child: { description: "child", prompt: "work", mcpServers: ["A", "B", "unmapped"] },
          },
        },
      }),
      deps()
    )
    expect(result).toMatchObject({ admitted: true })
    if (!result.admitted) throw new Error("Expected tracked Host admission")
    expect(result.options.runAuthorityMcpServerIds).toEqual({ A: "A", B: "B" })
    expect(Object.keys(result.options.mcpServers!)).toEqual(["A"])
    expect(result.options.agents?.child.mcpServers).toEqual(["A"])
  })

  it.each([true, false])(
    "uses only the Host-held project-thread parent, present=%s",
    async (present) => {
      const { ensureDirectChatExecutionRun } = await import("@/lib/execution/direct-chat-run")
      if (present) {
        await ensureDirectChatExecutionRun({ sessionId: "coordinator", runId: "coordinator" })
        await getDb().executionRuns.update("coordinator", {
          authority: { schemaVersion: 1, caps: "explicit-v1" as const, permissionMode: "plan" },
        })
      }
      await getDb().sessions.update("session-1", {
        projectThread: { parentExecutionRunId: "coordinator" } as never,
      })
      const admitted = await admitPairedChatTurn(
        request({ parentRunId: "forged-parent", options: { permissionMode: "bypassPermissions" } }),
        deps()
      )
      expect(admitted).toMatchObject({ admitted: true })
      expect(await getDb().executionRuns.get("paired:request-1")).toMatchObject(
        present
          ? { parentRunId: "coordinator", authority: { permissionMode: "plan" } }
          : { actingIdentity: { trigger: "local" } }
      )
      if (present && admitted.admitted) expect(admitted.options.permissionMode).toBe("plan")
      if (!present)
        expect(
          await getDb().executionRunEvents.where("runId").equals("paired:request-1").toArray()
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              payload: expect.objectContaining({ operation: "coordinator_parent_unavailable" }),
            }),
          ])
        )
    },
    30_000
  )

  it("writes the user's message and holds an open, leased submission for the persister", async () => {
    await expect(admitPairedChatTurn(request(), deps())).resolves.toMatchObject({
      admitted: true,
      submissionId: "work:paired:request-1",
    })
    expect((await getDb().executionRuns.get("paired:request-1"))?.actingIdentity).toMatchObject({
      trigger: "local",
      authorizingPrincipal: { kind: "local-person" },
    })

    // The user's turn is on the Host under the client's own id, so the
    // transcript the client pages back lines up with what it showed.
    await expect(getDb().messages.get("user-message-1")).resolves.toMatchObject({
      sessionId: "session-1",
      role: "user",
      parts: [expect.objectContaining({ type: "text", text: "use my connection" })],
    })
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      accountId: "account-1",
      runtimeTargetId: "target-1",
      sessionId: "session-1",
      sourceKind: "chat",
      dispatchState: "dispatched",
      leaseOwner: PAIRED_TURN_LEASE_OWNER,
    })
    expect(heartbeat).toHaveBeenCalledWith("work:paired:request-1")
  }, 30_000)

  it("never freezes the turn's options: no execution context is stored", async () => {
    await admitPairedChatTurn(
      request({ options: { providerCredentials: { apiKey: "browser-provider-key" } } }),
      deps()
    )
    const row = await getWorkSubmission("work:paired:request-1")
    expect(row?.contextBundleId).toBeUndefined()
    await expect(getDb().executionContextBundles.count()).resolves.toBe(0)
    const stored = JSON.stringify(await getDb().workInputBatches.toArray())
    expect(stored).not.toContain("browser-provider-key")
  }, 30_000)

  it("lets the existing persister settle the admitted turn and write the reply", async () => {
    await admitPairedChatTurn(request(), deps())
    const writeTranscript = jest.fn(async () => {})
    await expect(
      settleChatTurnForSession("session-1", { outcome: "completed", writeTranscript })
    ).resolves.toBe(true)
    expect(writeTranscript).toHaveBeenCalledTimes(1)
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "completed",
    })
  }, 30_000)

  it("re-sending a turn the session already holds writes no second user row", async () => {
    const commitUserMessage = jest.fn(async () => {})
    await getDb().messages.put({
      id: "user-message-1",
      sessionId: "session-1",
      role: "user",
      parts: [{ type: "text", text: "use my connection" }],
      createdAt: 1,
    } as never)
    await expect(
      admitPairedChatTurn(request(), deps({ commitUserMessage }))
    ).resolves.toMatchObject({ admitted: true })
    expect(commitUserMessage).not.toHaveBeenCalled()
  }, 30_000)

  it("names its own user row when the client sent no message id", async () => {
    await admitPairedChatTurn(request({ messageId: undefined }), deps())
    await expect(getDb().messages.get("paired:request-1:user")).resolves.toMatchObject({
      sessionId: "session-1",
      role: "user",
    })
  }, 30_000)

  it.each([
    ["a session the Host never created", { sessionId: "session-elsewhere" }, "session_not_found"],
    ["another account's pairing", { callerAccountId: "account-2" }, "host_state_scope_mismatch"],
  ])(
    "refuses %s, admitting nothing",
    async (_label, overrides, code) => {
      await expect(admitPairedChatTurn(request(overrides), deps())).resolves.toMatchObject({
        admitted: false,
        refusal: { code },
      })
      await expect(getDb().workSubmissions.count()).resolves.toBe(0)
      await expect(getDb().messages.count()).resolves.toBe(0)
    },
    30_000
  )

  it("refuses a turn on a conversation frozen for a handoff", async () => {
    await getDb().sessions.update("session-1", {
      handoffLock: { ticketId: "ticket-1", lockedAt: 1 },
    } as never)
    await expect(admitPairedChatTurn(request(), deps())).resolves.toMatchObject({
      admitted: false,
      refusal: { code: "session_handoff_locked" },
    })
  }, 30_000)

  it("refuses a message id that belongs to another conversation", async () => {
    await getDb().messages.put({
      id: "user-message-1",
      sessionId: "session-other",
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)
    await expect(admitPairedChatTurn(request(), deps())).resolves.toMatchObject({
      admitted: false,
      refusal: { code: "host_state_message_id_exists" },
    })
  }, 30_000)

  it("stays out of the way on a Host with no runtime target, as local chat does", async () => {
    clearActiveRuntimeTargetContext()
    await expect(admitPairedChatTurn(request(), deps())).resolves.toEqual({
      admitted: false,
      untracked: true,
    })
    await expect(getDb().workSubmissions.count()).resolves.toBe(0)
  }, 30_000)

  it("rejects a malformed bridge request outright", async () => {
    await expect(admitPairedChatTurn(request({ runId: "" }), deps())).rejects.toThrow(
      "paired_turn_invalid_request"
    )
    await expect(admitPairedChatTurn(request({ prompt: 42 }), deps())).rejects.toThrow(
      "paired_turn_invalid_request"
    )
  }, 30_000)
})

describe("abandonPairedChatTurn", () => {
  it("seals an admitted turn the server could not hand to the runtime", async () => {
    await admitPairedChatTurn(request(), deps())
    await expect(
      abandonPairedChatTurn(
        { submissionId: "work:paired:request-1", errorCode: "sidecar_unavailable" },
        deps()
      )
    ).resolves.toEqual({ settled: true })
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "failed",
      errorCode: "sidecar_unavailable",
    })
    // Nothing is left open for the persister to attach a later turn's frames to.
    await expect(settleChatTurnForSession("session-1", { outcome: "completed" })).resolves.toBe(
      false
    )
  }, 30_000)
})

describe("command routing", () => {
  it("claims exactly its two internal bridge commands", () => {
    expect(isPairedTurnCommand("paired_turn_admit")).toBe(true)
    expect(isPairedTurnCommand("paired_turn_abandon")).toBe(true)
    expect(isPairedTurnCommand("agent_send")).toBe(false)
  })

  it("dispatches by command name", async () => {
    await expect(
      dispatchPairedTurnCommand("paired_turn_admit", request({ sessionId: "missing" }))
    ).resolves.toMatchObject({ admitted: false, refusal: { code: "session_not_found" } })
    await expect(
      dispatchPairedTurnCommand("paired_turn_abandon", { submissionId: "work:none" })
    ).resolves.toEqual({ settled: false })
  }, 30_000)
})

it.each(["member", undefined, "forged"])(
  "admits %s with no personal reader or Lark credential and ignores client history",
  async (pairedReader) => {
    await getDb().messages.put({
      id: "owner-private",
      sessionId: "session-1",
      role: "assistant",
      createdAt: 1,
      parts: [{ type: "text", text: "owner private history" }],
      metadata: {
        personalMarks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
      },
    })
    await getDb().sessions.update("session-1", { sdkSessionId: "owner-engine" })
    const result = await admitPairedChatTurn(
      request({
        pairedReader,
        options: {
          resumeSessionId: "owner-engine",
          initialConversation: [{ role: "assistant", content: "forged history" }],
          priorMessages: ["forged history"],
          personalVisibilityDigest: "forged",
        },
      }),
      deps()
    )
    expect(result).toMatchObject({ admitted: true })
    if (!result.admitted) throw new Error("expected admission")
    expect(result.options.resumeSessionId).toBeUndefined()
    expect(JSON.stringify(result.options)).not.toMatch(/owner private history|forged history/)
    expect(JSON.stringify(result.options)).toContain("[Withheld:")
    const run = await getDb().executionRuns.get("paired:request-1")
    expect(run?.actingIdentity).toMatchObject({ trigger: "external-event" })
    const { preparePersonalHistory } = await import("@/lib/execution/personal-visibility")
    expect(
      (await preparePersonalHistory("session-1", [], { executionRunId: run!.id })).readers
    ).toEqual([])
    const { admitPersonalCredential } = await import("@/lib/execution/personal-credential")
    expect(
      await admitPersonalCredential(
        { sessionId: "session-1", executionRunId: run!.id },
        { source: "lark-user", person: { kind: "local-person" } }
      )
    ).toMatchObject({ ok: false })
    const { admitLarkUserAuthorization } =
      await import("@/lib/auth-providers/feishu/cli/acting-identity")
    await expect(
      admitLarkUserAuthorization("owner-lark", { sessionId: "session-1", executionRunId: run!.id })
    ).rejects.toThrow("personal_access_refused")
  }
)

it.each(["owner", "member"])(
  "keeps a %s engine when its digest is unchanged or nothing is withheld",
  async (pairedReader) => {
    if (pairedReader === "member") {
      await getDb().messages.put({
        id: "already-hidden",
        sessionId: "session-1",
        role: "assistant",
        createdAt: 1,
        parts: [{ type: "text", text: "private" }],
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
        },
      })
      const { preparePairedHistory } = await import("@/lib/execution/personal-visibility")
      const filtered = await preparePairedHistory(await getDb().messages.toArray(), pairedReader)
      await getDb().sessions.update("session-1", {
        runtimePersonalVisibilityDigest: filtered.visibilityDigest,
      })
    }
    await getDb().sessions.update("session-1", { sdkSessionId: "retained" })
    const result = await admitPairedChatTurn(
      request({ pairedReader, options: { resumeSessionId: "retained" } }),
      deps()
    )
    expect(result).toMatchObject({ admitted: true, options: { resumeSessionId: "retained" } })
  }
)

it("refuses an external route with changed private visibility before it can resume", async () => {
  await getDb().sessions.update("session-1", {
    externalAgentSession: { sessionId: "external-owner", personalVisibilityDigest: "owner" },
  } as never)
  await getDb().messages.put({
    id: "external-private",
    sessionId: "session-1",
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", text: "external private" }],
    metadata: {
      personalMarks: [{ person: { kind: "local-person" }, source: "personal", markedAt: 1 }],
    },
  })
  await expect(
    admitPairedChatTurn(
      request({ pairedReader: "member", options: { resumeSessionId: "external-owner" } }),
      deps()
    )
  ).resolves.toMatchObject({ admitted: false, refusal: { code: "personal_visibility_changed" } })
  expect((await getWorkSubmission("work:paired:request-1"))?.dispatchState).toBe("settled")
})

it("refuses a member turn that reuses a withheld canonical message id, writing nothing", async () => {
  const row = {
    id: "owner-row",
    sessionId: "session-1",
    role: "assistant" as const,
    createdAt: 1,
    parts: [{ type: "text" as const, text: "owner only" }],
    metadata: {
      personalMarks: [
        { person: { kind: "local-person" as const }, source: "personal", markedAt: 1 },
      ],
    },
  }
  await getDb().messages.put(row)
  const canonical = await getDb().messages.get(row.id)
  await expect(
    admitPairedChatTurn(request({ pairedReader: "member", messageId: row.id }), deps())
  ).resolves.toMatchObject({ admitted: false, refusal: { code: "personal_visibility_conflict" } })
  expect(await getDb().messages.get(row.id)).toEqual(canonical)
  expect(await getDb().workSubmissions.count()).toBe(0)
})

it("binds a paired tool attempt to the exact Host-admitted run", async () => {
  await admitPairedChatTurn(
    request({ options: { execution: { identity: { attemptId: "paired-attempt" } } } }),
    deps()
  )
  const { toolCallExecutionRunId } = await import("@/lib/execution/acting-authority")
  expect(toolCallExecutionRunId("session-1", "paired:request-1", "paired-attempt")).toBe(
    "paired:request-1"
  )
})
