/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react"

import type { AttachmentsContext, TextInputContext } from "@/components/ai-elements/prompt-input"
import type { AttachmentCitations } from "@/lib/chat/mentions/attachment-citations"

import type { StagedAttachmentsValue } from "../staged-attachment-store"
import {
  useComposerDraftLifecycle,
  type ComposerDraftLifecycleInput,
} from "./use-composer-draft-lifecycle"

const toast = { info: jest.fn() }
jest.mock("sonner", () => ({ toast: { info: (m: string) => toast.info(m) } }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const getDraft = jest.fn()
const setDraftDebounced = jest.fn()
jest.mock("@/lib/db/chat-drafts", () => ({
  getDraft: (...args: unknown[]) => getDraft(...args),
  setDraftDebounced: (...args: unknown[]) => setDraftDebounced(...args),
}))
const selections: unknown[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ addContextSelection: jest.fn() }) },
  useComposerContextSelections: () => selections,
}))
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: (select: (s: unknown) => unknown) =>
    select({ pendingBySession: {}, consume: jest.fn() }),
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

function input(extra: Partial<ComposerDraftLifecycleInput> = {}): ComposerDraftLifecycleInput {
  return {
    tCommands: ((k: string) => k) as never,
    persistDrafts: true,
    textValue: "",
    textInput: textInputWith(""),
    attachments: { files: [], clear: jest.fn(), add: jest.fn() } as unknown as AttachmentsContext,
    staged: { byId: {}, seedIncoming: jest.fn() } as unknown as StagedAttachmentsValue,
    attachmentCitations: {
      citationOf: () => undefined,
      expect: jest.fn(),
    } as unknown as AttachmentCitations,
    textareaRef: { current: null },
    turnInFlight: false,
    followUpInFlight: false,
    isComposing: false,
    draftHydratedFor: null,
    setDraftHydratedFor: jest.fn(),
    setRestoredAttachments: jest.fn(),
    setPastedBlocks: jest.fn(),
    acceptFiles: jest.fn(async () => []),
    sessionId: "s1",
    foldedLinks: {},
    setFoldedLinks: jest.fn(),
    setTemplateBinding: jest.fn(),
    setPendingLaunchSpec: jest.fn(),
    setActiveParamId: jest.fn(),
    effectiveBinding: undefined,
    pendingAutoSendRef: { current: null },
    submit: jest.fn(async () => true),
    props: {},
    ...extra,
  }
}

beforeEach(() => jest.clearAllMocks())

it("clears the box for a new conversation and brings its saved draft back", async () => {
  getDraft.mockResolvedValue({ text: "half a thought", foldedLinks: { a: "b" } })
  const deps = input()
  renderHook(() => useComposerDraftLifecycle(deps))

  expect(deps.attachments.clear).toHaveBeenCalled()
  expect(deps.setTemplateBinding).toHaveBeenCalledWith(undefined)
  await waitFor(() => expect(deps.setDraftHydratedFor).toHaveBeenCalledWith("s1"))
  expect(getDraft).toHaveBeenCalledWith("s1")
  expect(deps.textInput.value).toBe("half a thought")
  expect(deps.setFoldedLinks).toHaveBeenLastCalledWith({ a: "b" })
})

it("names the attachments it could not bring back", async () => {
  const lost = { name: "big.pdf", size: 1, mediaType: "application/pdf" }
  getDraft.mockResolvedValue({ text: "", attachments: [lost] })
  const deps = input()
  renderHook(() => useComposerDraftLifecycle(deps))

  await waitFor(() => expect(deps.setRestoredAttachments).toHaveBeenCalledWith([lost]))
  expect(toast.info).toHaveBeenCalledWith("toast")
})

it("keeps what was typed while the draft was loading", async () => {
  let release: (row: unknown) => void = () => {}
  getDraft.mockImplementation(() => new Promise((r) => (release = r)))
  const deps = input()
  renderHook(() => useComposerDraftLifecycle(deps))

  deps.textInput.setInput("typed")
  release({ text: "saved" })
  await waitFor(() => expect(deps.setDraftHydratedFor).toHaveBeenCalledWith("s1"))
  expect(deps.textInput.value).toBe("typed")
})

it("saves the draft once hydrated, and never when drafts are off", () => {
  getDraft.mockResolvedValue(null)
  renderHook(() =>
    useComposerDraftLifecycle(input({ draftHydratedFor: "s1", textValue: "next words" }))
  )
  expect(setDraftDebounced).toHaveBeenCalledWith(
    "s1",
    "next words",
    [],
    undefined,
    expect.objectContaining({
      templateBinding: null,
      foldedLinks: {},
      contextSelections: selections,
    })
  )

  jest.clearAllMocks()
  renderHook(() => useComposerDraftLifecycle(input({ persistDrafts: false, textValue: "x" })))
  expect(getDraft).not.toHaveBeenCalled()
  expect(setDraftDebounced).not.toHaveBeenCalled()
})
