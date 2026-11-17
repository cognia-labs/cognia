import { act, render } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import { COMPOSER_APPEND_EVENT, type ComposerAppendDetail } from "@/lib/chat/composer-append"

import { ComposerAppendBridge } from "./composer-append-bridge"

const chat = {
  activeSessionId: "active",
  addCitedRef: jest.fn(),
  addCarriedPreambles: jest.fn(),
  setReplyTo: jest.fn(),
  replyTo: null as unknown,
}
jest.mock("@/stores/chat", () => {
  const useChatStore = (selector: (s: typeof chat) => unknown) => selector(chat)
  useChatStore.getState = () => chat
  return { useChatStore, selectComposerReplyTo: () => chat.replyTo }
})
const warning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (m: string) => warning(m) } }))

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

function append(detail: ComposerAppendDetail): ComposerAppendDetail {
  act(() => {
    window.dispatchEvent(new CustomEvent(COMPOSER_APPEND_EVENT, { detail }))
  })
  return detail
}

beforeEach(() => {
  jest.clearAllMocks()
  chat.replyTo = null
})

function mount(sessionId = "s1", initial = "draft") {
  const textInput = textInputWith(initial)
  const addFiles = jest.fn()
  const requestSubmit = jest.fn()
  render(
    <ComposerAppendBridge
      sessionId={sessionId}
      textInput={textInput}
      addFiles={addFiles}
      requestSubmit={requestSubmit}
    />
  )
  return { textInput, addFiles, requestSubmit }
}

it("takes an event addressed to its conversation and stages everything it carries", () => {
  const { textInput, addFiles, requestSubmit } = mount()
  const file = new File(["x"], "a.txt")
  const ref = { kind: "file", id: "r1" } as never
  const replyTo = { messageId: "m1" } as never

  const detail = append({
    sessionId: "s1",
    text: "more",
    files: [file],
    citations: [ref],
    replyTo,
    carried: [{ id: "c1" } as never],
    missing: ["a.pdf"],
    submit: true,
  })

  expect(detail.claimed).toBe(true)
  expect(textInput.value).toBe("draft more")
  expect(addFiles).toHaveBeenCalledWith([file])
  expect(chat.addCitedRef).toHaveBeenCalledWith(ref, "s1")
  expect(chat.setReplyTo).toHaveBeenCalledWith(replyTo, "s1")
  expect(chat.addCarriedPreambles).toHaveBeenCalledWith([{ id: "c1" }], "s1")
  expect(requestSubmit).toHaveBeenCalledWith("draft more", undefined)
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("a.pdf"))
})

it("ignores an event for another conversation, an empty one, or one already claimed", () => {
  const { textInput } = mount()

  expect(append({ sessionId: "other", text: "x" }).claimed).toBeUndefined()
  expect(append({ sessionId: "s1" }).claimed).toBeUndefined()
  append({ sessionId: "s1", text: "x", claimed: true })
  expect(textInput.setInput).not.toHaveBeenCalled()
})

it("treats an un-addressed event as meant for the active conversation", () => {
  const { textInput } = mount("active", "")
  append({ text: "hi" })
  expect(textInput.value).toBe("hi")
})

it("keeps a reply target the user already picked", () => {
  chat.replyTo = { messageId: "mine" }
  mount()
  append({ sessionId: "s1", text: "x", replyTo: { messageId: "back" } as never })
  expect(chat.setReplyTo).not.toHaveBeenCalled()
})
