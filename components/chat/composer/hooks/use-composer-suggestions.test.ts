/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { AttachmentsContext, TextInputContext } from "@/components/ai-elements/prompt-input"
import type { UseComposerGhostTextResult } from "@/hooks/chat/use-composer-ghost-text"
import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerSuggestions, type ComposerSuggestionsInput } from "./use-composer-suggestions"

const dismiss = jest.fn()
const useFollowUpSuggestions = jest.fn((..._args: unknown[]) => ({
  suggestions: ["Run the tests"],
  dismiss,
}))
jest.mock("@/hooks/chat/use-follow-up-suggestions", () => ({
  useFollowUpSuggestions: (...args: unknown[]) => useFollowUpSuggestions(...args),
}))

function textInputWith(initial: string) {
  let value = initial
  return {
    get value() {
      return value
    },
    setInput: jest.fn((next: string) => {
      value = next
    }),
  } as unknown as TextInputContext
}

function input(extra: Partial<ComposerSuggestionsInput> = {}): ComposerSuggestionsInput {
  return {
    outboundBlocked: false,
    persistDrafts: true,
    textValue: "",
    textInput: textInputWith(""),
    attachments: { files: [] } as unknown as AttachmentsContext,
    textareaRef: { current: null },
    turnInFlight: false,
    followUpInFlight: false,
    turnInFlightRef: { current: false },
    followUpInFlightRef: { current: false },
    setCaret: jest.fn(),
    isComposing: false,
    draftHydratedFor: "s1",
    restoredAttachments: [],
    attachmentPrepareCountRef: { current: 0 },
    sessionId: "s1",
    ghost: { accept: jest.fn(() => null) } as unknown as UseComposerGhostTextResult,
    acceptedPredictionRef: { current: null },
    submit: jest.fn(async () => true),
    props: { session: { id: "s1", kind: "direct" } as ChatSession, status: "ready" },
    ...extra,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
})

it("offers a follow-up only in an idle, empty, hydrated box", () => {
  const ready = renderHook(() => useComposerSuggestions(input())).result.current
  expect(ready.predictionEligible).toBe(true)
  expect(useFollowUpSuggestions).toHaveBeenLastCalledWith(expect.anything(), { enabled: true })

  for (const extra of [
    { textValue: "typing" },
    { turnInFlight: true },
    { draftHydratedFor: null },
    {
      props: { session: { id: "s1", kind: "direct" } as ChatSession, status: "streaming" as const },
    },
  ] as Partial<ComposerSuggestionsInput>[]) {
    expect(
      renderHook(() => useComposerSuggestions(input(extra))).result.current.predictionEligible
    ).toBe(false)
  }
})

it("fills the box with the prediction, or sends it at once, and remembers it was a prediction", () => {
  const deps = input()
  const { result } = renderHook(() => useComposerSuggestions(deps))

  act(() => {
    expect(result.current.acceptPrediction("Run the tests")).toBe(true)
  })
  expect(deps.textInput.value).toBe("Run the tests")
  expect(deps.acceptedPredictionRef.current).toEqual({ sessionId: "s1", text: "Run the tests" })
  expect(deps.submit).not.toHaveBeenCalled()
  expect(dismiss).toHaveBeenCalled()

  const sending = input()
  const second = renderHook(() => useComposerSuggestions(sending)).result
  act(() => {
    second.current.acceptPrediction("Ship it", true)
  })
  expect(sending.submit).toHaveBeenCalled()
})

it("refuses a prediction once something was typed or a send is dispatching", () => {
  const typed = input({ textInput: textInputWith("mine") })
  expect(renderHook(() => useComposerSuggestions(typed)).result.current.acceptPrediction("x")).toBe(
    false
  )

  const busy = input({ turnInFlightRef: { current: true } })
  expect(renderHook(() => useComposerSuggestions(busy)).result.current.acceptPrediction("x")).toBe(
    false
  )
})

it("accepts ghost text into the box", () => {
  const ghost = { accept: jest.fn(() => "/compact now") } as unknown as UseComposerGhostTextResult
  const deps = input({ ghost })
  const { result } = renderHook(() => useComposerSuggestions(deps))

  expect(result.current.acceptGhost()).toBe(true)
  expect(deps.textInput.value).toBe("/compact now")
  expect(deps.setCaret).toHaveBeenCalledWith(12)

  const none = input()
  expect(renderHook(() => useComposerSuggestions(none)).result.current.acceptGhost()).toBe(false)
})
