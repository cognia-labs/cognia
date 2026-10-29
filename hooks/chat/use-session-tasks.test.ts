/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useChatStore } from "@/stores/chat"

import { sessionTaskTimeline, useSessionTasks } from "./use-session-tasks"

const SID = "session-tasks-hook"

function todoMessage(id: string, items: Array<[string, string]>): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-TodoWrite",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { todos: items.map(([content, status]) => ({ content, status })) },
        output: "ok",
      },
    ] as UIMessage["parts"],
  }
}

function setMessages(messages: UIMessage[]) {
  act(() => useChatStore.getState().setSessionMessages(SID, messages))
}

function setStatus(status: "idle" | "streaming") {
  act(() => useChatStore.getState().setSessionStatus(SID, status))
}

describe("useSessionTasks", () => {
  afterEach(() => {
    setMessages([])
    setStatus("idle")
  })

  it("is null without a task list", () => {
    const { result } = renderHook(() => useSessionTasks(SID))
    expect(result.current).toBeNull()
  })

  it("reports the current list and its progress while running", () => {
    setStatus("streaming")
    setMessages([
      todoMessage("a", [
        ["one", "completed"],
        ["two", "in_progress"],
      ]),
    ])
    const { result } = renderHook(() => useSessionTasks(SID))
    expect(result.current?.running).toBe(true)
    expect(result.current?.stopped).toBe(false)
    expect(result.current?.progress).toMatchObject({ done: 1, total: 2 })
    expect(result.current?.progress.current?.title).toBe("two")
  })

  it("marks an in-progress item stopped once the run ended", () => {
    setMessages([todoMessage("a", [["one", "in_progress"]])])
    setStatus("idle")
    const { result } = renderHook(() => useSessionTasks(SID))
    expect(result.current?.stopped).toBe(true)
    expect(result.current?.items[0]?.status).toBe("stopped")
    expect(result.current?.finished).toBe(false)
  })

  it("is finished when every item is done and nothing runs", () => {
    setMessages([todoMessage("a", [["one", "completed"]])])
    const { result } = renderHook(() => useSessionTasks(SID))
    expect(result.current?.finished).toBe(true)
    setStatus("streaming")
    expect(result.current?.finished).toBe(false)
  })
})

describe("sessionTaskTimeline", () => {
  it("memoizes per messages array", () => {
    const messages = [todoMessage("x", [["one", "pending"]])]
    expect(sessionTaskTimeline(messages)).toBe(sessionTaskTimeline(messages))
  })
})
