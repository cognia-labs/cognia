import type { SendFn } from "./agent-chat-turn-tasks"
jest.mock("@/lib/execution/personal-visibility", () => ({
  prepareOwnerHistory: jest.fn(async (messages: { id: string }[]) => {
    const { withholdForReaders } = jest.requireActual(
      "@cognia/plugin-contract/types/execution/personal-visibility"
    )
    return withholdForReaders(messages, [{ kind: "local-person" }])
  }),
}))
const runTitleTaskMock = jest.fn()
jest.mock("@/lib/ai/generation/run-title-task", () => ({
  ...jest.requireActual("@/lib/ai/generation/run-title-task"),
  runTitleTask: (...args: unknown[]) => runTitleTaskMock(...args),
}))
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
const getActiveGoalMock = jest.fn()
const manualContinueListeners = new Map<string, () => void>()
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({
    getActiveGoalForSession: (...args: unknown[]) => getActiveGoalMock(...args),
    recordPacingDecision: async () => undefined,
    onManualContinue: (goalId: string, cb: () => void) => {
      manualContinueListeners.set(goalId, cb)
      return () => manualContinueListeners.delete(goalId)
    },
  }),
}))
const gateContinuationMock = jest.fn((..._args: unknown[]) => ({ kind: "hold" }))
jest.mock("@/lib/goal/pacing", () => ({
  ...jest.requireActual("@/lib/goal/pacing"),
  gateContinuation: (...args: unknown[]) => gateContinuationMock(...args),
}))

import {
  applyInstantTitle,
  scheduleLoopContinuation,
  extractAssistantText,
  extractPlainText,
  renderGoalExitCard,
  runUtilityModelTasks,
  scheduleGoalContinuation,
} from "./agent-chat-turn-tasks"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { useSettingsStore } from "@/stores/settings"
import { prepareOwnerHistory } from "@/lib/execution/personal-visibility"

describe("Claude chat turn tasks", () => {
  const message = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] } as never

  it("extracts rendered message text", () => {
    expect(extractAssistantText(message)).toBe("done")
    expect(extractPlainText(message)).toBe("done")
  })

  it("renders terminal goal cards", () => {
    expect(renderGoalExitCard("completed", "shipped")).toContain("Goal completed")
  })
  it("does not title another person's sealed turn in the Host owner utility job", async () => {
    getSessionMock.mockResolvedValue({ id: "s", title: "New chat" })
    useSettingsStore.setState({ settings: { language: "en" } as never })
    runTitleTaskMock.mockClear()
    runUtilityModelTasks("s", [
      {
        id: "personal",
        role: "assistant",
        parts: [{ type: "text", text: "private report" }],
        metadata: {
          personalMarks: [
            {
              person: {
                kind: "platform",
                platform: "lark",
                adapterId: "foreign-adapter",
                remoteUserId: "foreign-person",
              },
              source: "private-tool",
              markedAt: 1,
            },
          ],
        },
      },
    ] as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prepareOwnerHistory).toHaveBeenCalled()
    expect(runTitleTaskMock).not.toHaveBeenCalled()
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
      expect(send).toHaveBeenCalledWith("next iteration", undefined, {
        skipUserAppend: true,
        sessionId: "s1",
      })
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

describe("a held goal continuation", () => {
  const flushAll = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const goal = { id: "goal-a", generationId: "gen-1" }

  beforeEach(() => {
    manualContinueListeners.clear()
    gateContinuationMock.mockClear()
    getActiveGoalMock.mockReset().mockResolvedValue(goal)
  })

  it("goes to its own conversation when Continue is clicked from another", async () => {
    const send = jest.fn(async () => true)
    const active = { current: "session-a" }
    scheduleGoalContinuation(
      "goal-a",
      "session-a",
      "keep going",
      { current: send } as never,
      active
    )
    await flushAll()
    expect(manualContinueListeners.has("goal-a")).toBe(true)

    // The person moved on to conversation B, then clicks A's Continue.
    active.current = "session-b"
    manualContinueListeners.get("goal-a")!()
    await flushAll()
    expect(send).toHaveBeenCalledWith("keep going", undefined, {
      skipUserAppend: true,
      sessionId: "session-a",
    })
  })

  it("sends nothing when the goal was paused, stopped or replaced since the hold", async () => {
    const send = jest.fn(async () => true)
    scheduleGoalContinuation("goal-a", "session-a", "keep going", { current: send } as never, {
      current: "session-a",
    })
    await flushAll()

    const click = manualContinueListeners.get("goal-a")!
    // Paused and resumed, or given a new objective: the generation rotated.
    getActiveGoalMock.mockResolvedValue({ ...goal, generationId: "gen-2" })
    click()
    await flushAll()
    // Stopped: no active goal is left in the conversation.
    getActiveGoalMock.mockResolvedValue(undefined)
    click()
    await flushAll()
    expect(send).not.toHaveBeenCalled()
  })
})
