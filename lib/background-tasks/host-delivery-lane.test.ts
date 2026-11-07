/** @jest-environment node */
import type { ChatSession, ClaudeEvent, SendOptions } from "@cognia/agent-config-types"
import type { WorkReceiptV1 } from "@cognia/agent-config-types/work-submission"
import type { UIMessage } from "ai"
import {
  afterTurnSettles,
  createHostDeliveryLane,
  isTurnEndFrame,
  runHostAutomatedTurn,
  type HostAutomatedTurnDeps,
} from "./host-delivery-lane"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const SESSION = { id: "chat-1", projectId: "proj-1", issueId: "issue-9" } as ChatSession
const RECEIPT = {
  runId: "delivery-1",
  turnId: "delivery-1",
  submissionId: "work:delivery-1",
} as WorkReceiptV1

function turnDeps(patch: Partial<HostAutomatedTurnDeps> = {}) {
  const rows: UIMessage[] = []
  const stopHeartbeat = jest.fn()
  const deps: HostAutomatedTurnDeps = {
    getSession: jest.fn(async (id: string) => (id === SESSION.id ? SESSION : undefined)),
    isBuiltinRuntime: jest.fn(() => true),
    existingSubmission: jest.fn(async () => undefined),
    listMessageIds: jest.fn(async () => ["m-1", "m-2"]),
    accept: jest.fn(async (input: Parameters<HostAutomatedTurnDeps["accept"]>[0]) => {
      await input.writeTranscript?.()
      return RECEIPT
    }) as HostAutomatedTurnDeps["accept"],
    claim: jest.fn(async () => "claimed" as const),
    markStarted: jest.fn(async () => true),
    heartbeat: jest.fn(() => stopHeartbeat),
    writeUserRow: jest.fn(async (_sessionId: string, row: UIMessage) => {
      rows.push(row)
    }),
    bindMessageRuns: jest.fn(),
    buildOptions: jest.fn(async () => ({ model: "m" }) as SendOptions),
    dispatch: jest.fn(async () => undefined),
    onError: jest.fn(),
    ...patch,
  }
  return { deps, rows, stopHeartbeat }
}

const input = {
  sessionId: "chat-1",
  text: "<background-results>done</background-results>",
  deliveryId: "delivery-1",
}

describe("runHostAutomatedTurn", () => {
  it("accepts the framed results as a background-result row, then dispatches it", async () => {
    const { deps, rows, stopHeartbeat } = turnDeps()
    await expect(
      runHostAutomatedTurn({ ...input, personalRunIds: ["execution:job:r1"] }, deps)
    ).resolves.toBe(true)
    expect(deps.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chat-1",
        runId: "delivery-1",
        messageId: "delivery-1",
        content: input.text,
        visibleMessageIds: ["m-1", "m-2", "delivery-1"],
        projectId: "proj-1",
        workItemRef: { kind: "issue", id: "issue-9" },
      })
    )
    // Automation never carries a person's authorization.
    expect((deps.accept as jest.Mock).mock.calls[0][0]).not.toHaveProperty("localAuthorization")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "delivery-1",
      role: "user",
      metadata: { automatedTurn: { producer: "background-result" } },
    })
    expect(deps.bindMessageRuns).toHaveBeenCalledWith("delivery-1", ["execution:job:r1"])
    await flush()
    expect(deps.claim).toHaveBeenCalledWith("delivery-1")
    expect(deps.heartbeat).toHaveBeenCalledWith("work:delivery-1")
    expect(deps.buildOptions).toHaveBeenCalledWith(SESSION, input.text, "delivery-1")
    expect(deps.dispatch).toHaveBeenCalledWith(
      "chat-1",
      input.text,
      { model: "m" },
      {
        messageId: "delivery-1",
        receipt: RECEIPT,
        commandId: "delivery-1",
      }
    )
    expect(deps.markStarted).toHaveBeenCalledWith("delivery-1")
    expect(stopHeartbeat).toHaveBeenCalled()
  })

  it("acknowledges a delivery already accepted without a second turn", async () => {
    const { deps } = turnDeps({
      existingSubmission: jest.fn(async () => ({ sessionId: "chat-1" })),
    })
    await expect(runHostAutomatedTurn(input, deps)).resolves.toBe(true)
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it("leaves the results pending for a missing session, another runtime, or a refused acceptance", async () => {
    const missing = turnDeps()
    await expect(runHostAutomatedTurn({ ...input, sessionId: "gone" }, missing.deps)).resolves.toBe(
      false
    )
    const external = turnDeps({ isBuiltinRuntime: () => false })
    await expect(runHostAutomatedTurn(input, external.deps)).resolves.toBe(false)
    const refused = turnDeps({ accept: jest.fn(async () => null) })
    await expect(runHostAutomatedTurn(input, refused.deps)).resolves.toBe(false)
    const broken = turnDeps({
      accept: jest.fn(async () => {
        throw new Error("ledger down")
      }),
    })
    await expect(runHostAutomatedTurn(input, broken.deps)).resolves.toBe(false)
    expect(broken.deps.onError).toHaveBeenCalled()
    for (const { deps } of [missing, external, refused, broken]) {
      expect(deps.dispatch).not.toHaveBeenCalled()
    }
  })

  it("does not send a turn another owner holds", async () => {
    const { deps } = turnDeps({ claim: jest.fn(async () => "owned_elsewhere" as const) })
    await expect(runHostAutomatedTurn(input, deps)).resolves.toBe(true)
    await flush()
    expect(deps.dispatch).not.toHaveBeenCalled()
    expect(deps.heartbeat).not.toHaveBeenCalled()
  })

  it("reports a dispatch failure after acceptance, which the work outbox then owns", async () => {
    const { deps, stopHeartbeat } = turnDeps({
      dispatch: jest.fn(async () => {
        throw new Error("sidecar refused")
      }),
    })
    await expect(runHostAutomatedTurn(input, deps)).resolves.toBe(true)
    await flush()
    expect(deps.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sidecar refused" })
    )
    expect(deps.markStarted).not.toHaveBeenCalled()
    expect(stopHeartbeat).toHaveBeenCalled()
  })
})

describe("createHostDeliveryLane", () => {
  const send = jest.fn(async () => true)
  const lane = (patch: { open?: boolean; builtin?: boolean } = {}) =>
    createHostDeliveryLane({
      getSession: async (id) =>
        id === "archived"
          ? ({ id, archivedAt: 5 } as ChatSession)
          : id === "gone"
            ? undefined
            : ({ id } as ChatSession),
      isBuiltinRuntime: () => patch.builtin ?? true,
      hasOpenTurn: async () => patch.open ?? false,
      send,
      databaseName: () => "cognia-acct-1",
    })

  it("reaches a conversation the Host keeps on the built-in runtime", async () => {
    await expect(lane().isReachable("chat-1")).resolves.toBe(true)
    await expect(lane().isReachable("gone")).resolves.toBe(false)
    await expect(lane().isReachable("archived")).resolves.toBe(false)
    await expect(lane({ builtin: false }).isReachable("chat-1")).resolves.toBe(false)
  })

  it("is idle only while no turn of the conversation is open in the ledger", async () => {
    await expect(lane().isIdle("chat-1")).resolves.toBe(true)
    await expect(lane({ open: true }).isIdle("chat-1")).resolves.toBe(false)
  })

  it("claims under one consumer id per Host account", () => {
    expect(lane().consumerId()).toBe("brain:cognia-acct-1")
    expect(lane().send).toBe(send)
  })
})

describe("afterTurnSettles", () => {
  it("waits for the turn's submission to close before draining", async () => {
    const answers = [true, true, false]
    const hasOpenTurn = jest.fn(async () => answers.shift() ?? false)
    const timers: Array<() => void> = []
    const then = jest.fn()
    afterTurnSettles("chat-1", then, {
      hasOpenTurn,
      schedule: (run) => timers.push(run),
      now: () => 0,
    })
    await flush()
    expect(then).not.toHaveBeenCalled()
    timers.shift()!()
    await flush()
    expect(then).not.toHaveBeenCalled()
    timers.shift()!()
    await flush()
    expect(then).toHaveBeenCalledTimes(1)
    expect(hasOpenTurn).toHaveBeenCalledTimes(3)
  })

  it("drains anyway once the wait runs out, and when the ledger cannot be read", async () => {
    let now = 0
    const timers: Array<() => void> = []
    const then = jest.fn()
    afterTurnSettles("chat-1", then, {
      hasOpenTurn: async () => true,
      schedule: (run) => timers.push(run),
      now: () => now,
      timeoutMs: 1_000,
    })
    await flush()
    now = 1_000
    timers.shift()!()
    await flush()
    expect(then).toHaveBeenCalledTimes(1)

    const unreadable = jest.fn()
    afterTurnSettles("chat-1", unreadable, {
      hasOpenTurn: async () => {
        throw new Error("db closed")
      },
    })
    await flush()
    expect(unreadable).toHaveBeenCalledTimes(1)
  })
})

it("reads a turn's end from the sidecar's frames", () => {
  expect(isTurnEndFrame({ type: "session_ended", sessionId: "chat-1" } as ClaudeEvent)).toBe(true)
  expect(isTurnEndFrame({ type: "event", sessionId: "chat-1" } as unknown as ClaudeEvent)).toBe(
    false
  )
})
