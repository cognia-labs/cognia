"use client"

import { applyComposerOcr } from "../ocr-attachment-action"
import {
  type AttachmentsContext,
  type TextInputContext,
} from "@/components/ai-elements/prompt-input"
import { type StagedAttachmentsValue } from "@/components/chat/composer/staged-attachment-store"
import { useOcr } from "@/hooks/use-ocr"
import { type OcrResult } from "@/types/ocr"
import { useCallback, useState } from "react"

export interface ComposerOcrInput {
  textInput: TextInputContext
  attachments: AttachmentsContext
  staged: StagedAttachmentsValue
}

/**
 * Composer attachment OCR: runs the engine on a staged attachment and holds
 * the result bubble's state.
 */
export function useComposerOcr(input: ComposerOcrInput) {
  const { textInput, attachments, staged } = input

  const ocr = useOcr()
  const [ocrBubbleOpen, setOcrBubbleOpen] = useState(false)
  const [ocrBubbleResult, setOcrBubbleResult] = useState<OcrResult | null>(null)
  const [ocrBubbleImageSrc, setOcrBubbleImageSrc] = useState<string | null>(null)

  // Composer attachment OCR. It used to live on a hover menu on the chip and
  // append text straight into the draft — which silently doubled the payload,
  // because the image itself stayed attached and both went to the model. OCR is
  // now one layer of the attachment preview panel's "model view": the text is
  // stored ON the staged attachment with an explicit opt-in, so the token badge
  // reflects the real cost before the user commits to it.
  const runComposerOcr = useCallback(
    async (
      attachmentId: string,
      action: "extract-to-input" | "view-result",
      options?: { quiet?: boolean }
    ) => {
      const file = attachments.files.find((f) => f.id === attachmentId)
      if (!file?.url) return
      let blob: Blob
      try {
        blob = await (await fetch(file.url)).blob()
      } catch {
        return
      }
      await applyComposerOcr({
        action,
        blob,
        mimeType: file.mediaType || blob.type,
        run: ocr.run,
        getInput: () => textInput.value,
        setInput: (value) => textInput.setInput(value),
        showResult: (result) => {
          // Panel gets the flat text (that is what would be sent); the per-page
          // result stays available behind the panel's "details" action so the
          // richer Live-Text sheet doesn't become unreachable.
          staged.setOcrText(attachmentId, result.combinedText)
          // A batch run for a recipient that cannot see the images only
          // needs the text included; a bubble per image would be noise.
          if (options?.quiet) return
          setOcrBubbleResult(result)
          setOcrBubbleImageSrc(
            (file.mediaType ?? "").startsWith("image/") ? (file.url ?? null) : null
          )
        },
      })
    },
    [attachments, ocr, textInput, staged]
  )
  const handleRunOcrForPanel = useCallback(
    (attachmentId: string) => runComposerOcr(attachmentId, "view-result"),
    [runComposerOcr]
  )
  /**
   * Include the text of these images with the message, for a recipient that
   * cannot see them (the attachment row's image notice). One at a time: OCR
   * runs on this device, and a burst would contend for the same engine.
   */
  const handleExtractImageText = useCallback(
    async (attachmentIds: readonly string[]) => {
      for (const attachmentId of attachmentIds) {
        await runComposerOcr(attachmentId, "view-result", { quiet: true })
      }
    },
    [runComposerOcr]
  )
  /** Second OCR route, kept from the old chip menu: text straight into the draft. */
  const handleExtractOcrToInput = useCallback(
    (attachmentId: string) => runComposerOcr(attachmentId, "extract-to-input"),
    [runComposerOcr]
  )
  const openOcrBubble = useCallback(() => setOcrBubbleOpen(true), [])
  return {
    setOcrBubbleOpen,
    openOcrBubble,
    ocrBubbleOpen,
    ocrBubbleResult,
    ocrBubbleImageSrc,
    handleExtractImageText,
    handleRunOcrForPanel,
    ocr,
    handleExtractOcrToInput,
  }
}
