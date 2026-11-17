"use client"

import type { ComposerInnerProps } from "../../composer"
import type React from "react"
import { type StagedAttachmentsValue } from "../staged-attachment-store"
import { type AcceptFilesOptions } from "./use-attachment-intake"
import {
  type AttachmentsContext,
  type TextInputContext,
} from "@/components/ai-elements/prompt-input"
import { isVideoPreprocessSettings } from "@/lib/chat/attachments/video/settings"
import { draftAttachmentsFromFiles } from "@/lib/chat/draft-attachments"
import { type FoldedLinks } from "@/lib/chat/link-fold"
import { type AttachmentCitations } from "@/lib/chat/mentions/attachment-citations"
import { isContextRef } from "@/lib/chat/mentions/read"
import { refreshSelectionFreshness } from "@/lib/chat/mentions/selection-freshness"
import { isContextSelectionRef } from "@/lib/chat/mentions/selection-guard"
import { type ContextRef } from "@/lib/chat/mentions/types"
import { mergeComposerIntentPrompt } from "@/lib/chat/merge-composer-intent"
import { type ChatTemplateBinding } from "@/lib/chat/template/binding"
import { type ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"
import {
  getDraft as getChatDraft,
  setDraftDebounced as setChatDraftDebounced,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { parseRemoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import { useChatStore, useComposerContextSelections } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { loggers } from "@cognia/logging"
import { useTranslations } from "next-intl"
import { useEffect, useRef } from "react"
import { toast } from "sonner"

export interface ComposerDraftLifecycleInput {
  /**
   * Turns a composer intent's images into files (the mobile composer's
   * `attachmentToFiles`). Passed in so this hook does not import the mobile
   * shell; the composer already does.
   */
  attachmentToFiles: (attachment: {
    kind: "photos"
    items: Array<{ uri: string; mime: string }>
  }) => Promise<File[]>
  tCommands: ReturnType<typeof useTranslations<"chat.composer.commands">>
  persistDrafts: boolean
  textValue: string
  textInput: TextInputContext
  attachments: AttachmentsContext
  staged: StagedAttachmentsValue
  attachmentCitations: AttachmentCitations
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  turnInFlight: boolean
  followUpInFlight: boolean
  isComposing: boolean
  draftHydratedFor: string | null
  setDraftHydratedFor: React.Dispatch<React.SetStateAction<string | null>>
  setRestoredAttachments: React.Dispatch<React.SetStateAction<DraftAttachmentMeta[]>>
  setPastedBlocks: React.Dispatch<React.SetStateAction<Record<string, string>>>
  acceptFiles: (files: FileList | File[], options?: AcceptFilesOptions) => Promise<File[]>
  sessionId: string | null
  foldedLinks: FoldedLinks
  setFoldedLinks: (next: FoldedLinks) => void
  setTemplateBinding: React.Dispatch<React.SetStateAction<ChatTemplateBinding | undefined>>
  setPendingLaunchSpec: React.Dispatch<
    React.SetStateAction<{
      spec: ChatTemplateLaunchSpec
      templateName: string
      body: string
    } | null>
  >
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  effectiveBinding: ChatTemplateBinding | undefined
  pendingAutoSendRef: React.RefObject<{
    text: string
    sessionId: string | null
    onSubmitted?: (sent: boolean) => void
    recoverHandoff?: boolean
    citations?: readonly ContextRef[]
  } | null>
  submit: () => Promise<boolean>
  props: Pick<ComposerInnerProps, "externalSessionLink">
}

/**
 * The draft's lifecycle across conversation switches: restore the saved draft
 * (and say what could not come back), consume a pending composer intent once
 * hydrated, finish an auto-send handshake, and save the draft as it changes.
 */
export function useComposerDraftLifecycle(input: ComposerDraftLifecycleInput) {
  const {
    attachmentToFiles,
    tCommands,
    persistDrafts,
    textValue,
    textInput,
    attachments,
    staged,
    attachmentCitations,
    textareaRef,
    turnInFlight,
    followUpInFlight,
    isComposing,
    draftHydratedFor,
    setDraftHydratedFor,
    setRestoredAttachments,
    setPastedBlocks,
    acceptFiles,
    sessionId,
    foldedLinks,
    setFoldedLinks,
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    effectiveBinding,
    pendingAutoSendRef,
    submit,
    props,
  } = input

  // Subscribed (not just read at send) so the save effect below re-fires when
  // a chip is staged or removed — the chips are part of the draft now.
  const draftContextSelections = useComposerContextSelections(sessionId)
  const pendingComposerIntent = useComposerIntentStore((state) =>
    sessionId ? state.pendingBySession[sessionId] : undefined
  )
  const consumeComposerIntent = useComposerIntentStore((state) => state.consume)
  // See `restoredAttachments` above: only the ones we could not bring back.
  const tDraft = useTranslations("chat.composer.draftRestore")
  // The next-intl translator isn't a stable reference, so we read it through a
  // ref instead of listing it as an effect dependency — depending on it would
  // re-run the hydration effect every render and loop on its setState calls.
  const tDraftRef = useRef(tDraft)
  useEffect(() => {
    tDraftRef.current = tDraft
  }, [tDraft])

  // Tracks the session we last reset the box for. A ref (not state) so it can't
  // race the async draft load below.
  const clearedForSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor === sessionId) return
    // Reset the input SYNCHRONOUSLY, once per session change. The Composer is
    // not remounted per session (no `key`), so without this the previous
    // session's text + staged attachments bleed into this one and then get
    // persisted into its draft. The ref guard means a re-render during the
    // async load (e.g. the user typing in the gap) doesn't wipe their input a
    // second time.
    if (clearedForSessionRef.current !== sessionId) {
      clearedForSessionRef.current = sessionId
      textInput.setInput("")
      attachments.clear()
      // Folded-paste bodies are in-memory only (not persisted); drop them too.
      setPastedBlocks({})
      // Folded links belong to the draft they were pasted into; the restore
      // below brings this session's own map back.
      setFoldedLinks({})
      // Parameter values belong to the draft they were typed into.
      setTemplateBinding(undefined)
      setActiveParamId(null)
      setPendingLaunchSpec(null)
    }
    let cancelled = false
    getChatDraft(sessionId)
      .then((row) => {
        if (cancelled) return
        // The box was emptied synchronously above, so any text in it now was
        // typed during this async gap. That text wins: the stored draft used to
        // land on top of it the moment the read resolved, replacing what the
        // user was in the middle of writing. The stored text's companions —
        // parameter values, folded links — describe THAT text, so they stay
        // out with it; attachments and context chips below are additive and
        // still come back.
        const typedDuringLoad = textInput.value.length > 0
        if (!typedDuringLoad) {
          // Populate the saved draft only when the target actually has one.
          if (row?.text) textInput.setInput(row.text)
          // The tokens come back with the text; their values come back here.
          setTemplateBinding(row?.templateBinding)
          // Same for links: the text holds short labels, and this is what
          // turns them back into URLs on send. Without it a restored draft
          // would ship `svenstaro/genact` as prose.
          setFoldedLinks(row?.foldedLinks ?? {})
        }
        // Attachments whose binary survived are re-staged for real: the file
        // comes back, ready to send. Seed the store with its cached extraction
        // first so re-staging doesn't re-parse a document we already read.
        // Anything whose blob was evicted (quota) still degrades to a chip.
        const restored = row?.attachments ?? []
        const revivable = restored.filter((a) => a.bytes)
        if (revivable.length > 0) {
          staged.seedIncoming(
            revivable.map((a) => ({
              filename: a.name,
              sizeBytes: a.size,
              state: {
                status: "ready" as const,
                sizeBytes: a.size,
                bytes: a.bytes,
                restoredContent: a.extractedContent,
                remoteDocument: parseRemoteDocumentProvenance(a.remoteDocument) ?? undefined,
                ocrText: a.ocrText,
                includeOcr: a.includeOcr,
                ...(a.extractedText
                  ? {
                      extracted: {
                        kind: a.mediaType.startsWith("audio/")
                          ? ("audio" as const)
                          : ("document" as const),
                        block: { type: "text" as const, text: a.extractedText },
                        tokens: a.tokens ?? 0,
                        text: a.extractedText,
                        extractedContent: a.extractedContent,
                      },
                    }
                  : {}),
                // A video's frames are re-sampled with the settings it was saved
                // with; a row this build cannot read falls back to the default.
                ...(isVideoPreprocessSettings(a.videoSettings)
                  ? { video: { settings: a.videoSettings } }
                  : {}),
              },
            }))
          )
          const revived = revivable.map((a) => ({
            citation: a.citation,
            file: new File([a.bytes as BlobPart], a.name, { type: a.mediaType }),
          }))
          // A restored document cites what it cited before the switch. The
          // row may come from another build, so its citation is checked first.
          for (const { citation, file } of revived) {
            if (isContextRef(citation)) attachmentCitations.expect(file, citation)
          }
          attachments.add(revived.map(({ file }) => file))
        }
        // Reminder chips are now only for the ones we could NOT bring back.
        const reminders = restored.filter((a) => !a.bytes)
        setRestoredAttachments(reminders)
        if (reminders.length > 0) {
          toast.info(tDraftRef.current("toast", { count: reminders.length }))
        }
        // Context chips come back too — each ref carries its own snapshot and
        // fingerprint, so staging needs no re-read of the source. Rows can come
        // from another build, so each entry is shape-checked first and a
        // malformed one reads as absent. Freshness is then re-checked so a
        // record edited while the draft sat shows its `stale` flag rather than
        // presenting the old body as current.
        const storedSelections = (row?.contextSelections ?? []).filter(isContextSelectionRef)
        if (storedSelections.length > 0) {
          void refreshSelectionFreshness(storedSelections)
            .then(({ selections }) => {
              if (cancelled) return
              for (const selection of selections) {
                useChatStore.getState().addContextSelection(selection, sessionId)
              }
            })
            .catch(() => {
              if (cancelled) return
              for (const selection of storedSelections) {
                useChatStore.getState().addContextSelection(selection, sessionId)
              }
            })
        }
        setDraftHydratedFor(sessionId)
      })
      .catch(() => {
        if (cancelled) return

        setDraftHydratedFor(sessionId)
      })
    return () => {
      cancelled = true
    }
  }, [
    persistDrafts,
    sessionId,
    draftHydratedFor,
    setFoldedLinks,
    textInput,
    attachments,
    attachmentCitations,
    staged,
    setPastedBlocks,
    setTemplateBinding,
    setActiveParamId,
    setPendingLaunchSpec,
    setDraftHydratedFor,
    setRestoredAttachments,
  ])

  const intentSessionRef = useRef("")
  const intentIdentity = `${sessionId ?? ""}:${props.externalSessionLink?.agentId ?? ""}:${props.externalSessionLink?.sessionId ?? ""}`
  useEffect(() => {
    intentSessionRef.current = intentIdentity
    return () => {
      intentSessionRef.current = ""
    }
  }, [intentIdentity])

  // A system-selection action arrives while the main window and target session
  // are being activated. Consume it only after the saved draft has finished
  // hydrating, otherwise the async draft read can overwrite the inserted stock
  // instruction. Ask has no stock prompt and only focuses the textarea.
  useEffect(() => {
    if (!sessionId || !pendingComposerIntent || isComposing) return
    if (persistDrafts && draftHydratedFor !== sessionId) return
    if (
      pendingComposerIntent.waitForEmpty &&
      (textValue || attachments.files.length || turnInFlight || followUpInFlight)
    )
      return
    const intent = consumeComposerIntent(sessionId, pendingComposerIntent.candidateId)
    if (!intent) return
    if (
      intent.externalSession &&
      (intent.externalSession.agentId !== props.externalSessionLink?.agentId ||
        intent.externalSession.sessionId !== props.externalSessionLink?.sessionId)
    )
      return
    if (intent.prompt !== null) {
      const merged = mergeComposerIntentPrompt(textInput.value, intent.prompt, intent.mode)
      textInput.setInput(merged)
      // Auto-send (tray quick panel) is armed here but fired by the effect
      // below, once the input state has actually flushed: `submit` builds the
      // turn from the committed input and its derived state (segments, param
      // tokens, folded pastes), none of which has caught up with this write
      // until the next commit.
      if (intent.autoSend) pendingAutoSendRef.current = { text: merged, sessionId }
    }
    for (const ref of intent.citations ?? []) useChatStore.getState().addCitedRef(ref, sessionId)
    if (intent.images?.length) {
      const identity = intentIdentity
      void attachmentToFiles({
        kind: "photos",
        items: intent.images.map((image) => ({
          uri: `data:${image.mimeType};base64,${image.data}`,
          mime: image.mimeType,
        })),
      })
        .then(async (files) => {
          const isCurrent = () => intentSessionRef.current === identity
          const accepted = await acceptFiles(files, { isCurrent })
          if (!isCurrent() && accepted.length === 0) {
            useComposerIntentStore.getState().stage(sessionId, {
              ...intent,
              candidateId: `${intent.candidateId}:attachments`,
              prompt: null,
              mode: "append",
            })
          }
        })
        .catch((error) => {
          loggers.chat.error("restoring queued attachments failed", error)
          toast.error(error instanceof Error ? error.message : tCommands("failed"))
        })
    }
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [
    acceptFiles,
    intentIdentity,
    tCommands,
    consumeComposerIntent,
    isComposing,
    props.externalSessionLink?.agentId,
    props.externalSessionLink?.sessionId,
    textInput,
    draftHydratedFor,
    pendingComposerIntent,
    persistDrafts,
    sessionId,
    textValue,
    attachments.files.length,
    turnInFlight,
    followUpInFlight,
    pendingAutoSendRef,
    textareaRef,
    attachmentToFiles,
  ])

  // Second half of the auto-send handshake: fire only once the committed input
  // matches the text we staged, so the send can never race the state write.
  useEffect(() => {
    const pending = pendingAutoSendRef.current
    if (pending === null) return
    if (sessionId !== pending.sessionId) {
      pendingAutoSendRef.current = null
      if (pending.recoverHandoff && pending.sessionId) {
        useComposerIntentStore.getState().stage(pending.sessionId, {
          candidateId: crypto.randomUUID(),
          prompt: pending.text,
          mode: "append",
          waitForEmpty: true,
          citations: pending.citations,
        })
        for (const ref of pending.citations ?? [])
          useChatStore.getState().removeCitedRef(ref.id, pending.sessionId)
      }
      pending.onSubmitted?.(false)
      return
    }
    if (textValue !== pending.text) return
    // Capture the addressed handoff before clearing the one-shot latch.
    const submission = submit()
    pendingAutoSendRef.current = null
    void submission.then((sent) => pending.onSubmitted?.(sent))
  }, [textValue, submit, sessionId, pendingAutoSendRef])

  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor !== sessionId) return
    // Built here, not memoised during render. A chip's citation is bound by the
    // observe effect near the top of this component, which runs after render,
    // so rows computed in the render that added the chip would save it
    // uncited. Rebuilding is a map over a handful of files, and the blobs come
    // from `staged`, which already holds the bytes it fetched for extraction,
    // so a save still costs no extra reads.
    const draftAttachments = draftAttachmentsFromFiles(
      attachments.files,
      staged.byId,
      attachmentCitations.citationOf
    )
    try {
      // `undefined` keeps the default debounce. The binding is passed on every
      // save (never omitted) so clearing the last parameter actually clears the
      // stored value — omission means "preserve" in `setDraft`.
      setChatDraftDebounced(sessionId, textValue, draftAttachments, undefined, {
        templateBinding: effectiveBinding ?? null,
        // Passed on every save (never omitted) so removing the last link
        // actually clears the stored map — omission means "preserve".
        foldedLinks,
        // Same contract: every save carries the live chip list, so unstaging
        // the last chip clears the stored selections instead of leaving them
        // to resurrect on the next reload.
        contextSelections: draftContextSelections,
      })
    } catch {
      // Dexie unavailable (e.g., SSR / tests without fake-indexeddb) — drafts are best-effort.
    }
  }, [
    textValue,
    attachments.files,
    staged.byId,
    attachmentCitations,
    sessionId,
    draftHydratedFor,
    persistDrafts,
    effectiveBinding,
    foldedLinks,
    draftContextSelections,
  ])
}
