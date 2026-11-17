/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { AttachmentsContext, TextInputContext } from "@/components/ai-elements/prompt-input"
import type { StagedAttachmentsValue } from "@/components/chat/composer/staged-attachment-store"
import type { OcrResult } from "@/types/ocr"

import { useComposerOcr } from "./use-composer-ocr"

const result = { combinedText: "page text", pages: [] } as unknown as OcrResult
const run = jest.fn(async (..._args: unknown[]) => result)
jest.mock("@/hooks/use-ocr", () => ({
  useOcr: () => ({ status: "idle", run: (...args: unknown[]) => run(...args) }),
}))

function setup(files: { id: string; url?: string; mediaType?: string }[]) {
  let value = "draft"
  const textInput = {
    get value() {
      return value
    },
    setInput: jest.fn((next: string) => {
      value = next
    }),
  } as unknown as TextInputContext
  const attachments = { files } as unknown as AttachmentsContext
  const staged = { setOcrText: jest.fn() } as unknown as StagedAttachmentsValue
  const hook = renderHook(() => useComposerOcr({ textInput, attachments, staged }))
  return { hook, textInput, staged, value: () => value }
}

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = jest.fn(async () => ({
    blob: async () => new Blob(["x"], { type: "image/png" }),
  })) as unknown as typeof fetch
})

it("stores the text on the attachment and opens the result bubble with the image", async () => {
  const { hook, staged } = setup([{ id: "a", url: "blob:a", mediaType: "image/png" }])

  await act(() => hook.result.current.handleRunOcrForPanel("a"))

  expect(staged.setOcrText).toHaveBeenCalledWith("a", "page text")
  expect(hook.result.current.ocrBubbleResult).toBe(result)
  expect(hook.result.current.ocrBubbleImageSrc).toBe("blob:a")
  act(() => hook.result.current.openOcrBubble())
  expect(hook.result.current.ocrBubbleOpen).toBe(true)
})

it("only stores the text for a batch run, without a bubble per image", async () => {
  const { hook, staged } = setup([
    { id: "a", url: "blob:a", mediaType: "image/png" },
    { id: "b", url: "blob:b", mediaType: "image/png" },
  ])

  await act(() => hook.result.current.handleExtractImageText(["a", "b"]))

  expect(staged.setOcrText).toHaveBeenCalledTimes(2)
  expect(hook.result.current.ocrBubbleResult).toBeNull()
})

it("appends the text to the draft on the extract-to-input route", async () => {
  const { hook, staged, value } = setup([{ id: "a", url: "blob:a", mediaType: "image/png" }])

  await act(() => hook.result.current.handleExtractOcrToInput("a"))

  expect(value()).toContain("page text")
  expect(value().startsWith("draft")).toBe(true)
  expect(staged.setOcrText).not.toHaveBeenCalled()
})

it("does nothing for an attachment without a URL", async () => {
  const { hook, staged } = setup([{ id: "a" }])

  await act(() => hook.result.current.handleRunOcrForPanel("a"))

  expect(run).not.toHaveBeenCalled()
  expect(staged.setOcrText).not.toHaveBeenCalled()
})
