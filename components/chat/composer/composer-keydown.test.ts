/** @jest-environment jsdom */
import type React from "react"

import type { ComposerTrigger } from "../composer-trigger"
import { handleComposerKeyDown } from "./composer-keydown"

type Ctx = Parameters<typeof handleComposerKeyDown>[0]

function context(value: string, extra: Partial<Ctx> = {}) {
  const ctx = {
    props: { onOpenCheatsheet: jest.fn(), session: { id: "s1" } },
    sendOnEnter: true,
    inputHistoryRecall: true,
    textInput: { value, setInput: jest.fn() },
    textareaRef: { current: null },
    activeHintRef: { current: "" },
    popoverRef: { current: { navigate: jest.fn(), confirm: jest.fn(() => false) } },
    setCaret: jest.fn(),
    isComposing: false,
    setPermissionMode: jest.fn(),
    permissionMode: "default",
    setActiveParamId: jest.fn(),
    paramTokens: [],
    activeParamId: null,
    history: { recall: jest.fn(), entries: [] },
    ghost: { ghost: null },
    completionTrigger: null,
    markShellSubmitted: jest.fn(),
    dismissPopover: jest.fn(),
    submit: jest.fn(async () => true),
    acceptGhost: jest.fn(() => false),
    predictionEligible: false,
    prediction: { suggestions: [], dismiss: jest.fn() },
    acceptPrediction: jest.fn(() => false),
    stepToParam: jest.fn(() => false),
    deletePillAtCaret: jest.fn(() => false),
    turnStatus: "ready",
    onStopTurn: jest.fn(),
    ...extra,
  } as unknown as Ctx
  return ctx
}

function key(k: string, mods: Partial<KeyboardEvent> = {}) {
  const textarea = document.createElement("textarea")
  return {
    key: k,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    keyCode: 0,
    nativeEvent: { isComposing: false, keyCode: 0 },
    currentTarget: textarea,
    preventDefault: jest.fn(),
    ...mods,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>
}

it("sends on Enter and leaves Shift+Enter to the textarea", () => {
  const ctx = context("hello")
  const enter = key("Enter")
  handleComposerKeyDown(ctx, enter)
  expect(ctx.submit).toHaveBeenCalledTimes(1)
  expect(enter.preventDefault).toHaveBeenCalled()

  const shifted = key("Enter", { shiftKey: true })
  handleComposerKeyDown(ctx, shifted)
  expect(ctx.submit).toHaveBeenCalledTimes(1)
  expect(shifted.preventDefault).not.toHaveBeenCalled()
})

it("sends on ⌘/Ctrl+Enter only when Enter inserts newlines", () => {
  const ctx = context("hello", { sendOnEnter: false })
  handleComposerKeyDown(ctx, key("Enter"))
  expect(ctx.submit).not.toHaveBeenCalled()
  handleComposerKeyDown(ctx, key("Enter", { metaKey: true }))
  expect(ctx.submit).toHaveBeenCalledTimes(1)
})

it("claims no key while an IME is composing", () => {
  const ctx = context("ni", { isComposing: true })
  const enter = key("Enter")
  handleComposerKeyDown(ctx, enter)
  expect(ctx.submit).not.toHaveBeenCalled()
  expect(enter.preventDefault).not.toHaveBeenCalled()
})

it("opens the cheatsheet on `?` in an empty box only", () => {
  const empty = context("")
  handleComposerKeyDown(empty, key("?"))
  expect(empty.props.onOpenCheatsheet).toHaveBeenCalled()

  const typing = context("why")
  handleComposerKeyDown(typing, key("?"))
  expect(typing.props.onOpenCheatsheet).not.toHaveBeenCalled()
})

it("cycles the permission mode on Shift+Tab for this conversation", () => {
  const ctx = context("x")
  handleComposerKeyDown(ctx, key("Tab", { shiftKey: true }))
  expect(ctx.setPermissionMode).toHaveBeenCalledWith(expect.anything(), "s1")
})

it("hands arrows, Escape and Enter to an open completion panel", () => {
  const trigger = { kind: "slash", query: "co", tokenStart: 0, tokenEnd: 3 } as ComposerTrigger
  const confirm = jest.fn(() => true)
  const navigate = jest.fn()
  const ctx = context("/co", {
    completionTrigger: trigger,
    popoverRef: { current: { navigate, confirm } } as never,
  })

  handleComposerKeyDown(ctx, key("ArrowDown"))
  expect(navigate).toHaveBeenCalledWith(1)
  handleComposerKeyDown(ctx, key("Enter"))
  expect(confirm).toHaveBeenCalledWith({ alternate: false })
  expect(ctx.submit).not.toHaveBeenCalled()
  handleComposerKeyDown(ctx, key("Escape"))
  expect(ctx.dismissPopover).toHaveBeenCalled()
})

it("runs the line on Enter in `!` mode, whatever the panel shows", () => {
  const trigger = { kind: "bash", query: "ls", tokenStart: 0, tokenEnd: 3 } as ComposerTrigger
  const ctx = context("!ls", { completionTrigger: trigger })
  handleComposerKeyDown(ctx, key("Enter"))
  expect(ctx.markShellSubmitted).toHaveBeenCalled()
  expect(ctx.submit).toHaveBeenCalled()
})

it("deletes a whole pill on Backspace next to it", () => {
  const ctx = context("/reset ", { deletePillAtCaret: jest.fn(() => true) })
  const backspace = key("Backspace")
  handleComposerKeyDown(ctx, backspace)
  expect(ctx.deletePillAtCaret).toHaveBeenCalledWith(backspace.currentTarget, "backward")
  expect(backspace.preventDefault).toHaveBeenCalled()
})
