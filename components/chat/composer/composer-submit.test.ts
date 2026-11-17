/** @jest-environment jsdom */
import type { SlashCommand } from "@/lib/slash-commands/builtin"

import { runComposerSubmit } from "./composer-submit"

const toast = { error: jest.fn() }
jest.mock("sonner", () => ({ toast: { error: (m: string) => toast.error(m) } }))

type Ctx = Parameters<typeof runComposerSubmit>[0]

function context(text: string, extra: Partial<Ctx> = {}, props: Partial<Ctx["props"]> = {}) {
  let value = text
  const textInput = {
    get value() {
      return value
    },
    setInput: jest.fn((next: string) => {
      value = next
    }),
    clear: jest.fn(() => {
      value = ""
    }),
  }
  const ctx = {
    props: {
      status: "ready",
      onSubmit: jest.fn(async () => true),
      onCommand: jest.fn(async () => true),
      onSubmitMemory: jest.fn(async () => true),
      onSubmitShell: jest.fn(async () => true),
      ...props,
    },
    tCommands: ((k: string) => k) as never,
    tMemory: ((k: string) => k) as never,
    tTemplateParams: ((k: string) => k) as never,
    tBestOfN: ((k: string) => k) as never,
    nativeMobile: false,
    softKeyboard: false,
    outboundBlocked: false,
    clearAfterSendEnabled: true,
    textInput,
    attachments: { files: [] },
    staged: {},
    textareaRef: { current: document.createElement("textarea") },
    setTurnInFlight: jest.fn(),
    setFollowUpInFlight: jest.fn(),
    turnInFlightRef: { current: false },
    followUpInFlightRef: { current: false },
    setCaret: jest.fn(),
    setRestoredAttachments: jest.fn(),
    attachmentPrepareCountRef: { current: 0 },
    setPastedBlocks: jest.fn(),
    pastedBlocks: {},
    setCommandErrors: jest.fn(),
    sessionId: "s1",
    currentDraftRef: { current: { sessionId: "s1", text, files: [] } },
    memoryFilesAccess: "available",
    commandMap: new Map([["btw", { name: "btw" } as SlashCommand]]),
    foldedLinks: {},
    setFoldedLinks: jest.fn(),
    segments: [],
    setActiveParamId: jest.fn(),
    paramIds: [],
    effectiveBinding: undefined,
    paramDeclarations: [],
    paramTokens: [],
    noteCommandUsed: jest.fn(),
    history: {},
    routeOf: () => null,
    localActionInFlightRef: { current: false },
    acceptedPredictionRef: { current: null },
    pendingAutoSendRef: { current: null },
    ...extra,
  } as unknown as Ctx
  return { ctx, value: () => value }
}

beforeEach(() => jest.clearAllMocks())

it("sends nothing while the box is disabled, outbound is blocked, or attachments are still preparing", async () => {
  for (const [extra, props] of [
    [{}, { disabled: true }],
    [{ outboundBlocked: true }, {}],
    [{ attachmentPrepareCountRef: { current: 1 } }, {}],
  ] as [Partial<Ctx>, Partial<Ctx["props"]>][]) {
    const { ctx } = context("hello", extra, props)
    await expect(runComposerSubmit(ctx)).resolves.toBe(false)
    expect(ctx.props.onSubmit).not.toHaveBeenCalled()
  }
})

it("rejects a second dispatch while a turn or a follow-up is still dispatching", async () => {
  const busy = context("again", { turnInFlightRef: { current: true } })
  await expect(runComposerSubmit(busy.ctx)).resolves.toBe(false)

  const followUp = context(
    "again",
    { followUpInFlightRef: { current: true } },
    { status: "streaming" }
  )
  await expect(runComposerSubmit(followUp.ctx)).resolves.toBe(false)
})

it("resumes the turn on an empty submit when the conversation can continue", async () => {
  const onResume = jest.fn(async () => undefined)
  const { ctx } = context("  ", {}, { canResume: true, onResume })

  await expect(runComposerSubmit(ctx)).resolves.toBe(true)
  expect(onResume).toHaveBeenCalled()
  expect(ctx.setTurnInFlight).toHaveBeenLastCalledWith(false)
})

it("returns false for an empty box with nothing to resume", async () => {
  const { ctx } = context("   ")
  await expect(runComposerSubmit(ctx)).resolves.toBe(false)
})

it("runs `/btw` as a local action and clears the box it came from", async () => {
  const { ctx, value } = context("/btw what is this?")

  await expect(runComposerSubmit(ctx)).resolves.toBe(true)
  expect(ctx.props.onCommand).toHaveBeenCalledWith({ name: "btw" }, "what is this?")
  expect(value()).toBe("")
  expect(ctx.localActionInFlightRef.current).toBe(false)
})

it("stops on an unfilled required parameter and lands on its chip", async () => {
  const param = { kind: "param", paramId: "module", raw: "{{module}}", start: 7, end: 17 }
  const { ctx } = context("Review {{module}}", {
    paramIds: ["module"],
    paramTokens: [param] as never,
  })

  await expect(runComposerSubmit(ctx)).resolves.toBe(false)
  expect(toast.error).toHaveBeenCalledWith("unfilled")
  expect(ctx.setCaret).toHaveBeenCalledWith(7)
  expect(ctx.setActiveParamId).toHaveBeenCalledWith("module")
  expect(ctx.props.onSubmit).not.toHaveBeenCalled()
})
