/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"

import type { ComposerTrigger } from "../../composer-trigger"
import { useComposerPillEditing, type ComposerPillEditingInput } from "./use-composer-pill-editing"

function setup(
  value: string,
  segments: RichSegment[],
  extra: Partial<ComposerPillEditingInput> = {}
) {
  let current = value
  const textInput = {
    get value() {
      return current
    },
    setInput: jest.fn((next: string) => {
      current = next
    }),
  } as unknown as TextInputContext
  const textarea = document.createElement("textarea")
  textarea.value = value
  document.body.appendChild(textarea)
  const deps: ComposerPillEditingInput = {
    textInput,
    textareaRef: { current: textarea },
    setCaret: jest.fn(),
    overlaySegments: segments,
    setActiveParamId: jest.fn(),
    paramTokens: segments.filter((s) => s.kind === "param") as never,
    completionTrigger: null,
    ...extra,
  }
  const hook = renderHook(() => useComposerPillEditing(deps))
  return { hook, deps, textarea, value: () => current }
}

beforeEach(() => {
  document.body.innerHTML = ""
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
})

const param = (paramId: string, start: number, end: number) =>
  ({ kind: "param", paramId, raw: `{{${paramId}}}`, start, end }) as RichSegment

it("steps to the next parameter, wrapping to the first", () => {
  const { hook, deps, textarea } = setup("{{a}} and {{b}}", [param("a", 0, 5), param("b", 10, 15)])
  textarea.setSelectionRange(6, 6)

  expect(hook.result.current.stepToParam(1)).toBe(true)
  expect(deps.setActiveParamId).toHaveBeenLastCalledWith("b")
  expect(hook.result.current.stepToParam(1)).toBe(true)
  expect(deps.setActiveParamId).toHaveBeenLastCalledWith("a")
})

it("does nothing without parameters", () => {
  const { hook } = setup("plain", [])
  expect(hook.result.current.stepToParam(1)).toBe(false)
})

it("deletes the whole pill the caret hugs, but not while a panel is open", () => {
  const segments = [
    { kind: "command", name: "reset", raw: "/reset", start: 0, end: 6 } as unknown as RichSegment,
  ]
  const { hook, textarea, value, deps } = setup("/reset now", segments)
  textarea.setSelectionRange(6, 6)

  expect(hook.result.current.deletePillAtCaret(textarea, "backward")).toBe(true)
  expect(value()).toBe(" now")
  expect(deps.setCaret).toHaveBeenCalledWith(0)

  const open = setup("/reset now", segments, {
    completionTrigger: { kind: "slash" } as ComposerTrigger,
  })
  open.textarea.setSelectionRange(6, 6)
  expect(open.hook.result.current.deletePillAtCaret(open.textarea, "backward")).toBe(false)
})

it("handles a soft keyboard's delete through beforeinput", () => {
  const segments = [
    { kind: "command", name: "reset", raw: "/reset", start: 0, end: 6 } as unknown as RichSegment,
  ]
  const { textarea, value } = setup("/reset now", segments)
  textarea.setSelectionRange(6, 6)
  const event = new InputEvent("beforeinput", {
    inputType: "deleteContentBackward",
    cancelable: true,
    bubbles: true,
  })

  textarea.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
  expect(value()).toBe(" now")
})
