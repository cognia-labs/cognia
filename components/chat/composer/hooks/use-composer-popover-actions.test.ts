/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

import type { PopoverItem } from "../../composer-popover"
import type { ComposerTrigger } from "../../composer-trigger"
import {
  useComposerPopoverActions,
  type ComposerPopoverActionsInput,
} from "./use-composer-popover-actions"

const toast = { info: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: { info: (m: string) => toast.info(m), error: (m: string) => toast.error(m) },
}))
jest.mock("@/hooks/chat/use-entity-mention-staging", () => ({
  useEntityMentionStaging: () => jest.fn(),
}))
const onPick = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/chat/mentions/pick-registry", () => ({
  getMentionPickHandler: (kind: string) => (kind === "file" ? { onPick } : undefined),
}))

const t = ((key: string) => key) as never

function setup(
  value: string,
  trigger: ComposerTrigger | null,
  extra: Partial<ComposerPopoverActionsInput> = {}
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
  const input: ComposerPopoverActionsInput = {
    tCommands: t,
    tMemory: t,
    tSkill: t,
    textValue: value,
    textInput,
    textareaRef: { current: textarea },
    caret: value.length,
    setCaret: jest.fn(),
    popoverDismissed: null,
    setPopoverDismissed: jest.fn(),
    setParamForm: jest.fn(),
    stageRemoteDoc: jest.fn(async () => null),
    setCommandErrors: jest.fn(),
    addReferencedPath: jest.fn(),
    resolvedMentionMode: "combined",
    applyPreset: jest.fn(async () => undefined) as never,
    memoryFilesAccess: "available",
    isLinkToken: () => false,
    setTemplateBinding: jest.fn(),
    setPendingLaunchSpec: jest.fn(),
    setActiveParamId: jest.fn(),
    noteCommandUsed: jest.fn(),
    trigger,
    hasCommandPrefix: () => true,
    dismissShell: jest.fn(),
    props: { onSubmitMemory: jest.fn(async () => true), session: null },
    ...extra,
  }
  const hook = renderHook(() => useComposerPopoverActions(input))
  return { hook, input, value: () => current }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0)
    return 0
  })
})

const slash = (query: string, end: number) =>
  ({ kind: "slash", query, tokenStart: 0, tokenEnd: end }) as ComposerTrigger

it("drops a picked command into the box in place of the typed fragment", async () => {
  const { hook, input, value } = setup("/res", slash("res", 4))
  const item = { kind: "slash", command: { name: "reset" } as SlashCommand } as PopoverItem

  await act(() => hook.result.current.onPickPopoverItem(item))

  expect(value()).toBe("/reset ")
  expect(input.noteCommandUsed).toHaveBeenCalledWith("reset")
  expect(input.setPopoverDismissed).toHaveBeenCalledWith({ kind: "slash", tokenStart: 0 })
})

it("opens the parameter form for a command with params, and refuses a disabled one", async () => {
  const withParams = { name: "deploy", params: [{ id: "env" }] } as unknown as SlashCommand
  const a = setup("/dep", slash("dep", 4))
  await act(() =>
    a.hook.result.current.onPickPopoverItem({ kind: "slash", command: withParams } as PopoverItem)
  )
  expect(a.input.setParamForm).toHaveBeenCalledWith({
    command: withParams,
    tokenStart: 0,
    tokenEnd: 4,
  })
  expect(a.value()).toBe("/dep")

  const b = setup("/off", slash("off", 4))
  const disabled = { name: "off", disabled: true } as unknown as SlashCommand
  await act(() =>
    b.hook.result.current.onPickPopoverItem({ kind: "slash", command: disabled } as PopoverItem)
  )
  expect(toast.info).toHaveBeenCalledWith("unavailable")
  expect(b.value()).toBe("/off")
})

it("writes a `#` line to memory and keeps the lines after it", async () => {
  const trigger = {
    kind: "memory",
    query: "use pnpm",
    tokenStart: 0,
    tokenEnd: 9,
  } as ComposerTrigger
  const target = { target: "store" } as never
  const { hook, input, value } = setup("#use pnpm\nthen this", trigger)

  await act(() =>
    hook.result.current.onPickPopoverItem({
      kind: "memory",
      target,
      preview: "",
      available: true,
    } as PopoverItem)
  )

  expect(input.props.onSubmitMemory).toHaveBeenCalledWith(target, "use pnpm")
  expect(value()).toBe("then this")
})

it("refuses a file memory target this window cannot reach", async () => {
  const trigger = { kind: "memory", query: "x", tokenStart: 0, tokenEnd: 2 } as ComposerTrigger
  const { hook, input } = setup("#x", trigger, { memoryFilesAccess: "remote-host" })

  await act(() =>
    hook.result.current.onPickPopoverItem({
      kind: "memory",
      target: { target: "file" } as never,
      preview: "",
      available: false,
    } as PopoverItem)
  )

  expect(toast.error).toHaveBeenCalledWith("remoteHost")
  expect(input.props.onSubmitMemory).not.toHaveBeenCalled()
})

it("hands a mention pick to its registered handler", async () => {
  const trigger = { kind: "file", query: "rea", tokenStart: 0, tokenEnd: 4 } as ComposerTrigger
  const { hook } = setup("@rea", trigger)
  const item = { kind: "file", entry: { path: "README.md" } } as unknown as PopoverItem

  await act(() => hook.result.current.onPickPopoverItem(item))

  expect(onPick).toHaveBeenCalledWith(item, expect.objectContaining({ session: null }))
})

it("closes `!` mode's lookups along with the panel", () => {
  const trigger = { kind: "bash", query: "", tokenStart: 0, tokenEnd: 1 } as ComposerTrigger
  const { hook, input } = setup("!", trigger)
  act(() => hook.result.current.dismissPopover())
  expect(input.setPopoverDismissed).toHaveBeenCalledWith({ kind: "bash", tokenStart: 0 })
  expect(input.dismissShell).toHaveBeenCalled()
})

it("drops one staged command and the separator after it", () => {
  const { hook, input, value } = setup("/a /b /c", null)
  act(() => hook.result.current.removeCommandSegment(3, 5))
  expect(value()).toBe("/a /c")
  expect(input.setCaret).toHaveBeenCalledWith(3)
  expect(input.setCommandErrors).toHaveBeenCalledWith([])
})

it("splices the confirmed parameter form into the captured range", () => {
  const { hook, input, value } = setup("/dep", null)
  act(() => hook.result.current.handleParamFormSubmit("env=prod"))
  const update = (input.setParamForm as jest.Mock).mock.calls[0][0] as (current: unknown) => unknown
  act(() => {
    update({ command: { name: "deploy" }, tokenStart: 0, tokenEnd: 4 })
  })
  expect(value()).toBe("/deploy env=prod ")
  expect(input.noteCommandUsed).toHaveBeenCalledWith("deploy")

  act(() => hook.result.current.handleParamFormCancel())
  expect(input.setParamForm).toHaveBeenLastCalledWith(null)
})
