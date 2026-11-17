/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerResume, type ComposerResumeInput } from "./use-composer-resume"

const user = {
  id: "u1",
  role: "user",
  metadata: { route: { kind: "agent", id: "a1" }, targetMemberIds: ["m1"] },
}
const slice = {
  status: "error",
  messages: [user],
  activeBranchByGroup: {},
  messagesLoading: false,
  errorDiagnostic: null,
  errorMessage: "boom",
}
const state = { sessions: { s1: slice } as Record<string, unknown>, activeSessionId: "s1" }
jest.mock("@/stores/chat", () => {
  const useChatStore = (selector: (s: typeof state) => unknown) => selector(state)
  useChatStore.getState = () => state
  return { useChatStore, selectVisibleMessages: (messages: unknown[]) => messages }
})
const canContinueChat = jest.fn((..._args: unknown[]) => true)
jest.mock("@/lib/chat/continuation", () => ({
  canContinueChat: (...args: unknown[]) => canContinueChat(...args),
  lastUserMessage: (messages: Array<{ role: string }>) =>
    [...messages].reverse().find((m) => m.role === "user"),
}))
jest.mock("@/lib/chat/turn-route/types", () => ({
  readTurnRoute: (metadata: { route?: unknown }) => metadata?.route,
}))
let openGoal: unknown = null
jest.mock("@/components/goal/use-active-goal", () => ({ useOpenGoal: () => openGoal }))

function input(extra: Partial<ComposerResumeInput> = {}): ComposerResumeInput {
  return {
    session: { id: "s1", kind: "direct" } as ChatSession,
    paneStatus: undefined,
    onSend: jest.fn(async () => true),
    disabled: false,
    ...extra,
  }
}

beforeEach(() => {
  openGoal = null
  canContinueChat.mockReturnValue(true)
})

it("resumes as a continuation of the last user message, on its route and members", async () => {
  const deps = input()
  const { result } = renderHook(() => useComposerResume(deps))
  expect(result.current.canResume).toBe(true)

  await act(() => result.current.handleResume())
  expect(deps.onSend).toHaveBeenCalledWith(expect.any(String), [], null, {
    continuationOf: "u1",
    route: { kind: "agent", id: "a1" },
    targetMemberIds: ["m1"],
  })
})

it("offers no resume for an IM-bound, subagent or goal-driven conversation", () => {
  const bound = { id: "s1", kind: "direct", platformBinding: { platform: "lark" } }
  for (const session of [bound, { id: "s1", kind: "subagent" }] as unknown as ChatSession[]) {
    expect(renderHook(() => useComposerResume(input({ session }))).result.current.canResume).toBe(
      false
    )
  }
  openGoal = { id: "g1" }
  expect(renderHook(() => useComposerResume(input())).result.current.canResume).toBe(false)
})

it("sends nothing when the turn can no longer be continued or the composer is disabled", async () => {
  const disabled = input({ disabled: true })
  const first = renderHook(() => useComposerResume(disabled)).result
  await act(() => first.current.handleResume())
  expect(disabled.onSend).not.toHaveBeenCalled()

  canContinueChat.mockReturnValue(false)
  const done = input()
  const second = renderHook(() => useComposerResume(done)).result
  await act(() => second.current.handleResume())
  expect(done.onSend).not.toHaveBeenCalled()
})
