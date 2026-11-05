import type { UIMessage } from "ai"

import type { InterruptedHostStateTurn } from "@/lib/work-submission/host-adapter"

const permitMock = jest.fn()
const revokeMock = jest.fn()
jest.mock("@/lib/work-submission/host-adapter", () => ({
  failHostStateTurnAfterRestart: jest.fn(),
  listHostStateTurnsInterruptedBefore: jest.fn(),
  permitHostStateRedispatchAfterRestart: (actionId: string) => permitMock(actionId),
  revokeHostStateRedispatchPermit: (actionId: string) => revokeMock(actionId),
}))
jest.mock("@/lib/db/messages", () => ({ commitMessageDelta: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { initializePersonChat } from "./person-chat"
import {
  createPersonHostRestartRecovery,
  hostRestartNotice,
  hostRestartNoticeId,
} from "./person-restart"

const turn: InterruptedHostStateTurn = {
  submissionId: "work:hoststate:action-1",
  actionId: "action-1",
  sessionId: "session-1",
  messageId: "message-1",
  text: "hello",
  attachments: false,
  createdAt: 10,
}

afterEach(() => initializePersonChat("brain", {}))

describe("person host restart recovery (ADR-0253 §7)", () => {
  it("exists only when the Host said when it booted", () => {
    initializePersonChat("person-brain", {})
    expect(createPersonHostRestartRecovery()).toBeUndefined()
    initializePersonChat("person-brain", { COGNIA_HOST_BOOTED_AT: "5000" })
    expect(createPersonHostRestartRecovery()?.bootedAt).toBe(5000)
    expect(createPersonHostRestartRecovery({ bootedAt: null })).toBeUndefined()
  })

  it("lists, ends and permits through the work ledger, at the boot instant", async () => {
    const listInterrupted = jest.fn(async () => [turn])
    const fail = jest.fn(async () => true)
    const recovery = createPersonHostRestartRecovery({ bootedAt: 5000, listInterrupted, fail })!
    await expect(recovery.interruptedTurns("session-1")).resolves.toEqual([turn])
    expect(listInterrupted).toHaveBeenCalledWith("session-1", 5000)
    await recovery.fail(turn)
    expect(fail).toHaveBeenCalledWith("work:hoststate:action-1")
    recovery.permit("action-1")
    recovery.revoke("action-1")
    expect(permitMock).toHaveBeenCalledWith("action-1")
    expect(revokeMock).toHaveBeenCalledWith("action-1")
  })

  it("reads the organization's choice once per recovery", async () => {
    const resumeEnabled = jest.fn(async () => true)
    const recovery = createPersonHostRestartRecovery({ bootedAt: 5000, resumeEnabled })!
    await expect(recovery.resumeEnabled()).resolves.toBe(true)
    await expect(recovery.resumeEnabled()).resolves.toBe(true)
    expect(resumeEnabled).toHaveBeenCalledTimes(1)
  })

  it("places the retry notice right after the member's message", async () => {
    const writeNotice = jest.fn(async (_sessionId: string, _message: UIMessage) => undefined)
    const messageCreatedAt = jest.fn(async () => 1_000)
    const recovery = createPersonHostRestartRecovery({
      bootedAt: 5000,
      writeNotice,
      messageCreatedAt,
    })!
    await recovery.markRetry(turn)
    expect(messageCreatedAt).toHaveBeenCalledWith("session-1", "message-1")
    expect(writeNotice).toHaveBeenCalledWith("session-1", {
      id: hostRestartNoticeId("action-1"),
      role: "system",
      parts: [{ type: "session-notice", variant: "host-restarted" }],
      metadata: { createdAt: 1_001 },
    })
  })

  it("still writes the notice when the member's message is not found", async () => {
    const writeNotice = jest.fn(async (_sessionId: string, _message: UIMessage) => undefined)
    const recovery = createPersonHostRestartRecovery({
      bootedAt: 5000,
      writeNotice,
      messageCreatedAt: async () => undefined,
    })!
    await recovery.markRetry(turn)
    const [, message] = writeNotice.mock.calls[0]!
    expect(message).toEqual(hostRestartNotice("action-1"))
    expect("metadata" in message).toBe(false)
  })

  it("the notice is one deterministic marker per retried turn", () => {
    expect(hostRestartNoticeId("a")).toBe("notice-host-restarted-a")
    expect(hostRestartNotice("a", 7)).toEqual(hostRestartNotice("a", 7))
  })
})
