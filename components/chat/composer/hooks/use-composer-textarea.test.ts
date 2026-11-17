/** @jest-environment jsdom */
import { createRef, type ChangeEvent, type MouseEvent, type SyntheticEvent } from "react"
import { renderHook } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import type { ParamSegment } from "@/lib/slash-commands/parse-segments"
import type { ChatSession } from "@cognia/agent-config-types"

import type { ComposerHandle } from "../../composer"
import type { LinkFolding } from "./use-link-folding"
import type { UseInputHistory } from "./use-input-history"
import { useComposerTextarea, type ComposerTextareaInput } from "./use-composer-textarea"

const noteComposerTyping = jest.fn()
jest.mock("@/stores/chat/composer-typing-store", () => ({
  noteComposerTyping: (id: string) => noteComposerTyping(id),
}))
const requestBrowserUrl = jest.fn((_url: string) => false)
jest.mock("@/lib/browser/open-url-request", () => ({
  requestBrowserUrl: (url: string) => requestBrowserUrl(url),
}))
const openExternal = jest.fn(async (_url: string) => undefined)
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (url: string) => openExternal(url) }))

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

function setup(extra: Partial<ComposerTextareaInput> = {}) {
  const textarea = document.createElement("textarea")
  document.body.appendChild(textarea)
  const deps: ComposerTextareaInput = {
    textValue: "",
    textInput: textInputWith(""),
    textareaRef: { current: textarea },
    chipOverlayRef: { current: document.createElement("div") },
    ghostOverlayRef: { current: document.createElement("div") },
    setCaret: jest.fn(),
    isComposing: false,
    setCommandErrors: jest.fn(),
    linkFolding: { fold: jest.fn(), spans: [] } as unknown as LinkFolding,
    setActiveParamId: jest.fn(),
    activeParamId: null,
    paramTokenAt: jest.fn(() => null),
    history: { noteEdit: jest.fn() } as unknown as UseInputHistory,
    acceptedPredictionRef: { current: { sessionId: "s1", text: "p" } },
    props: { session: { id: "s1", kind: "direct" } as ChatSession },
    ...extra,
  }
  const hook = renderHook(() => useComposerTextarea(deps))
  return { deps, hook, textarea }
}

const changeEvent = (value: string, caret = value.length) =>
  ({
    target: { value, selectionStart: caret, scrollTop: 12 },
  }) as unknown as ChangeEvent<HTMLTextAreaElement>

beforeEach(() => {
  jest.clearAllMocks()
  document.body.innerHTML = ""
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
})

it("a keystroke updates the draft, leaves recall, drops stale errors and folds passed links", () => {
  const { deps, hook } = setup()
  hook.result.current.onChange(changeEvent("hello", 5))

  expect(deps.textInput.value).toBe("hello")
  expect(deps.setCaret).toHaveBeenCalledWith(5)
  expect(deps.acceptedPredictionRef.current).toBeNull()
  expect(deps.history.noteEdit).toHaveBeenCalled()
  expect(deps.setCommandErrors).toHaveBeenCalled()
  expect(deps.linkFolding.fold).toHaveBeenCalledWith("hello", 5)
  expect(deps.chipOverlayRef.current?.style.transform).toBe("translateY(-12px)")
  expect(noteComposerTyping).not.toHaveBeenCalled()
})

it("does not fold mid-composition, and tells a team room the human is typing", () => {
  const team = { id: "r1", kind: "team", teamId: "t1" } as ChatSession
  const { deps, hook } = setup({ isComposing: true, props: { session: team } })
  hook.result.current.onChange(changeEvent("你"))

  expect(deps.linkFolding.fold).not.toHaveBeenCalled()
  expect(noteComposerTyping).toHaveBeenCalledWith("r1")
})

it("settles every link on blur", () => {
  const { deps, hook } = setup({ textInput: textInputWith("see x") })
  hook.result.current.onBlur()
  expect(deps.linkFolding.fold).toHaveBeenCalledWith("see x", -1)
})

it("closes the parameter editor once the caret leaves its token, and opens one on click", () => {
  const param = { paramId: "p1" } as ParamSegment
  const { deps, hook, textarea } = setup({
    activeParamId: "p1",
    paramTokenAt: jest.fn((caret: number) => (caret < 4 ? param : null)),
  })
  textarea.value = "{{p1}} rest"
  textarea.setSelectionRange(8, 8)
  hook.result.current.onSelect({ currentTarget: textarea } as SyntheticEvent<HTMLTextAreaElement>)
  expect(deps.setActiveParamId).toHaveBeenCalledWith(null)

  textarea.setSelectionRange(2, 2)
  hook.result.current.onTextareaMouseUp({
    currentTarget: textarea,
    metaKey: false,
    ctrlKey: false,
  } as unknown as MouseEvent<HTMLTextAreaElement>)
  expect(deps.setActiveParamId).toHaveBeenLastCalledWith("p1")
})

it("follows a folded link on ⌘-click", () => {
  const spans = [{ start: 0, end: 10, url: "https://example.com" }]
  const { hook, textarea } = setup({
    linkFolding: { fold: jest.fn(), spans } as unknown as LinkFolding,
  })
  textarea.value = "example.com"
  textarea.setSelectionRange(3, 3)
  const preventDefault = jest.fn()
  hook.result.current.onTextareaMouseUp({
    currentTarget: textarea,
    metaKey: true,
    ctrlKey: false,
    preventDefault,
  } as unknown as MouseEvent<HTMLTextAreaElement>)

  expect(preventDefault).toHaveBeenCalled()
  expect(requestBrowserUrl).toHaveBeenCalledWith("https://example.com")
  expect(openExternal).toHaveBeenCalledWith("https://example.com")
})

it("exposes insertMention and focus through the handle", () => {
  const handleRef = createRef<ComposerHandle>()
  const { deps, textarea } = setup({
    textInput: textInputWith("hi"),
    props: { session: null, handleRef },
  })
  textarea.value = "hi"
  textarea.setSelectionRange(2, 2)

  handleRef.current?.insertMention("ana")
  expect(deps.textInput.value).toBe("hi @ana ")
  expect(deps.setCaret).toHaveBeenCalledWith(8)

  handleRef.current?.focus()
  expect(document.activeElement).toBe(textarea)
})
