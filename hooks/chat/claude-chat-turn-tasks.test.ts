import type { SendFn } from "./claude-chat-turn-tasks"
const getSessionMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))

const getActiveLoopMock = jest.fn()
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => ({ getActiveLoopForSession: getActiveLoopMock }),
}))
jest.mock("@/lib/loop/pacing", () => ({
  gateLoopContinuation: () => ({ kind: "send" }),
}))

import {
  applyInstantTitle,
  scheduleLoopContinuation,
  extractAssistantText,
  extractPlainText,
  renderGoalExitCard,
} from "./claude-chat-turn-tasks"
import { composeTurnText } from "@/lib/chat/prompt-preamble"

describe("Claude chat turn tasks", () => {
  const message = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] } as never

  it("extracts rendered message text", () => {
    expect(extractAssistantText(message)).toBe("done")
    expect(extractPlainText(message)).toBe("done")
  })

  it("renders terminal goal cards", () => {
    expect(renderGoalExitCard("completed", "shipped")).toContain("Goal completed")
  })
})

describe("the composer's context envelope", () => {
  const turn = composeTurnText(
    "summarize the incident",
    [{ kind: "references", text: "Referenced context:\n\nIssue COG-9 body" }],
    { nonce: "a1b2c3d4e5" }
  )

  beforeEach(() => {
    getSessionMock.mockReset().mockResolvedValue({ id: "s1", title: "New chat" })
    updateSessionMock.mockReset().mockResolvedValue(undefined)
  })

  // Title, timeline label and memory extraction all ask what the user SAID.
  it("is not part of a user message's plain text", () => {
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: turn.text }] } as never
    expect(extractPlainText(user)).toBe("summarize the incident")
  })

  it("does not become the instant title", async () => {
    await applyInstantTitle("s1", turn.text)
    expect(updateSessionMock).toHaveBeenCalledWith("s1", {
      title: expect.stringContaining("summarize the incident"),
      titleAuto: true,
    })
    const [, patch] = updateSessionMock.mock.calls[0]
    expect(patch.title).not.toContain("cognia_context")
  })
})

describe("a refused automated continuation", () => {
  it("settles without an unhandled rejection when the session is busy", async () => {
    getActiveLoopMock.mockResolvedValue({ id: "loop-1" })
    const unhandled = jest.fn()
    process.on("unhandledRejection", unhandled)
    try {
      const send = jest.fn(() => Promise.reject(new Error("session_turn_busy")))
      scheduleLoopContinuation("loop-1", "s1", "next iteration", { current: send } as never, {
        current: "s1",
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setImmediate(resolve))
      expect(send).toHaveBeenCalledWith("next iteration", undefined, { skipUserAppend: true })
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  })
})

it("carries Host background run references through the shared send contract", async () => {
  const accept = jest.fn()
  const send: SendFn = async (_content, _options, call) => {
    accept(call?.backgroundDelivery?.personalRunIds)
  }
  await send("framed", undefined, {
    backgroundDelivery: {
      id: "delivery",
      onAccepted: () => {},
      personalRunIds: ["execution:job:child"],
    },
  })
  expect(accept).toHaveBeenCalledWith(["execution:job:child"])
})
