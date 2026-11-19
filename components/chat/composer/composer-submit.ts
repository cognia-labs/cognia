"use client"

import type { ComposerInnerProps } from "../composer"
import type React from "react"
import {
  type TextInputContext,
  type AttachmentsContext,
} from "@/components/ai-elements/prompt-input"
import { impact, notify } from "@/lib/capacitor/haptics"
import { hideKeyboard } from "@/lib/capacitor/keyboard"
import { type SubmittedFile } from "@/lib/chat/attachments/dispatch"
import { stagedRemoteDocument } from "@/lib/chat/attachments/remote-document"
import { applyOrder } from "@/lib/chat/attachments/reorder"
import { isVideoDescriptor } from "@/lib/chat/attachments/video/classify"
import { expandFoldedLinks, type FoldedLinks } from "@/lib/chat/link-fold"
import {
  isMemoryTargetAvailable,
  memoryFilesUnavailableKey,
  parseMemoryTargetKey,
  type MemoryFilesAccess,
} from "@/lib/chat/memory-target"
import { type ContextRef } from "@/lib/chat/mentions/types"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import { REPO_TEMPLATE_ID_PREFIX } from "@/lib/chat/template/repo-templates"
import { templateRunFromBinding } from "@/lib/chat/template/run"
import { unfilledRequiredParams, type ChatTemplateParam } from "@/lib/chat/template/template"
import { type TurnRoute } from "@/lib/chat/turn-route/types"
import { clearDraft as clearChatDraft, type DraftAttachmentMeta } from "@/lib/db/chat-drafts"
import { recordChatTemplateUse } from "@/lib/db/chat-templates"
import { parseRemoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import { expandPastes } from "@/lib/paste-collapse"
import {
  applyTemplate,
  type SlashCommand,
  type SlashStagedFiles,
} from "@/lib/slash-commands/builtin"
import {
  parseSegments,
  type InputSegment,
  type ParamSegment,
} from "@/lib/slash-commands/parse-segments"
import { runSegments, type CommandError } from "@/lib/slash-commands/run-segments"
import { selectComposerReplyTo, useChatStore } from "@/stores/chat"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { loggers } from "@cognia/logging"
import { type useTranslations } from "next-intl"
import { toast } from "sonner"

import type { UseInputHistory } from "@/components/chat/composer/hooks/use-input-history"
import type { StagedAttachmentsValue } from "@/components/chat/composer/staged-attachment-store"
import type { ChatTemplateBinding } from "@/lib/chat/template/binding"
import type { FileUIPart } from "ai"
/** Reads a `blob:` URL back as a data URL; null when it can no longer be read. */
const blobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** What the composer's submit reads from `ComposerInner`. */
export interface ComposerSubmitContext {
  props: Pick<
    ComposerInnerProps,
    | "canResume"
    | "disabled"
    | "onCommand"
    | "onResume"
    | "onSubmit"
    | "onSubmitMemory"
    | "onSubmitShell"
    | "session"
    | "status"
  >
  tCommands: ReturnType<typeof useTranslations<"chat.composer.commands">>
  tMemory: ReturnType<typeof useTranslations<"chat.composer.memory">>
  tTemplateParams: ReturnType<typeof useTranslations<"chat.composer.templateParams">>
  nativeMobile: boolean
  softKeyboard: boolean
  outboundBlocked: boolean
  clearAfterSendEnabled: boolean
  textInput: TextInputContext
  attachments: AttachmentsContext
  staged: StagedAttachmentsValue
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setTurnInFlight: React.Dispatch<React.SetStateAction<boolean>>
  setFollowUpInFlight: React.Dispatch<React.SetStateAction<boolean>>
  turnInFlightRef: React.RefObject<boolean>
  followUpInFlightRef: React.RefObject<boolean>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  setRestoredAttachments: React.Dispatch<React.SetStateAction<DraftAttachmentMeta[]>>
  attachmentPrepareCountRef: React.RefObject<number>
  setPastedBlocks: React.Dispatch<React.SetStateAction<Record<string, string>>>
  pastedBlocks: Record<string, string>
  setCommandErrors: React.Dispatch<React.SetStateAction<CommandError[]>>
  sessionId: string | null
  currentDraftRef: React.RefObject<{
    sessionId: string | null
    text: string
    files: (FileUIPart & { id: string; sourceFile?: File | undefined })[]
  }>
  memoryFilesAccess: MemoryFilesAccess
  tBestOfN: ReturnType<typeof useTranslations<"bestOfNEntry">>
  commandMap: Map<string, SlashCommand>
  foldedLinks: FoldedLinks
  setFoldedLinks: (next: FoldedLinks) => void
  segments: InputSegment[]
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  paramIds: string[]
  effectiveBinding: ChatTemplateBinding | undefined
  paramDeclarations: ChatTemplateParam[]
  paramTokens: ParamSegment[]
  noteCommandUsed: (name: string) => void
  history: UseInputHistory
  routeOf: (outgoing: string) => TurnRoute | null
  localActionInFlightRef: React.RefObject<boolean>
  acceptedPredictionRef: React.RefObject<{ sessionId: string | null; text: string } | null>
  pendingAutoSendRef: React.RefObject<{
    text: string
    sessionId: string | null
    onSubmitted?: (sent: boolean) => void
    recoverHandoff?: boolean
    citations?: readonly ContextRef[]
  } | null>
}

export async function runComposerSubmit(
  ctx: Pick<
    ComposerSubmitContext,
    | "props"
    | "tCommands"
    | "tMemory"
    | "tTemplateParams"
    | "nativeMobile"
    | "softKeyboard"
    | "outboundBlocked"
    | "clearAfterSendEnabled"
    | "textInput"
    | "attachments"
    | "staged"
    | "textareaRef"
    | "setTurnInFlight"
    | "setFollowUpInFlight"
    | "turnInFlightRef"
    | "followUpInFlightRef"
    | "setCaret"
    | "setRestoredAttachments"
    | "attachmentPrepareCountRef"
    | "setPastedBlocks"
    | "pastedBlocks"
    | "setCommandErrors"
    | "sessionId"
    | "currentDraftRef"
    | "memoryFilesAccess"
    | "tBestOfN"
    | "commandMap"
    | "foldedLinks"
    | "setFoldedLinks"
    | "segments"
    | "setActiveParamId"
    | "paramIds"
    | "effectiveBinding"
    | "paramDeclarations"
    | "paramTokens"
    | "noteCommandUsed"
    | "history"
    | "routeOf"
    | "localActionInFlightRef"
    | "acceptedPredictionRef"
    | "pendingAutoSendRef"
  >
): Promise<boolean> {
  const {
    props,
    tCommands,
    tMemory,
    tTemplateParams,
    nativeMobile,
    softKeyboard,
    outboundBlocked,
    clearAfterSendEnabled,
    textInput,
    attachments,
    staged,
    textareaRef,
    setTurnInFlight,
    setFollowUpInFlight,
    turnInFlightRef,
    followUpInFlightRef,
    setCaret,
    setRestoredAttachments,
    attachmentPrepareCountRef,
    setPastedBlocks,
    pastedBlocks,
    setCommandErrors,
    sessionId,
    currentDraftRef,
    memoryFilesAccess,
    tBestOfN,
    commandMap,
    foldedLinks,
    setFoldedLinks,
    segments,
    setActiveParamId,
    paramIds,
    effectiveBinding,
    paramDeclarations,
    paramTokens,
    noteCommandUsed,
    history,
    routeOf,
    localActionInFlightRef,
    acceptedPredictionRef,
    pendingAutoSendRef,
  } = ctx

  const text = textInput.value
  const pendingHandoff = pendingAutoSendRef.current
  const recoverHandoff =
    pendingHandoff?.recoverHandoff &&
    pendingHandoff.sessionId === sessionId &&
    pendingHandoff.text === text
  const literalPrediction =
    acceptedPredictionRef.current?.sessionId === sessionId &&
    acceptedPredictionRef.current?.text === text
  if (localActionInFlightRef.current) return false
  // These local actions must remain available during a main-turn approval
  // wait. They never enter the main send lane or consume staged attachments.
  const asideCommand = !literalPrediction && text.trim().match(/^\/(btw|side)(?:\s+([\s\S]*))?$/)
  if (asideCommand) {
    if (localActionInFlightRef.current) return false
    const command = commandMap.get(asideCommand[1])
    if (!command) return false
    localActionInFlightRef.current = true
    const owningDraft = currentDraftRef.current
    try {
      const handled = await props.onCommand(command, asideCommand[2] ?? "")
      if (
        handled &&
        currentDraftRef.current === owningDraft &&
        owningDraft.sessionId === sessionId &&
        textInput.value === text
      )
        textInput.setInput("")
      return handled
    } finally {
      localActionInFlightRef.current = false
    }
  }
  if (props.disabled || outboundBlocked) return false
  if (attachmentPrepareCountRef.current > 0) return false
  // Re-entrancy guard (send protection): reject a second dispatch while one is
  // already in flight — covers the window between the click and the store
  // flipping to "streaming", where a fast Enter could otherwise double-send.
  // Once the turn is live, its own still-pending dispatch no longer blocks a
  // follow-up: that send joins the running turn instead of starting one.
  const liveTurn = props.status === "streaming"
  if (followUpInFlightRef.current) return false
  if (turnInFlightRef.current && !liveTurn) return false

  // Emptiness is decided from the synchronous attachment count (blob→data-url
  // conversion below preserves count) so the guard can be armed BEFORE the
  // first await, leaving no race for a concurrent submit to slip through.
  const empty = text.trim().length === 0 && attachments.files.length === 0
  if (empty && props.canResume && props.onResume) {
    turnInFlightRef.current = true
    setTurnInFlight(true)
    try {
      await props.onResume()
      return true
    } catch (error) {
      console.warn("chat continuation failed", error)
      return false
    } finally {
      turnInFlightRef.current = false
      setTurnInFlight(false)
    }
  }
  if (empty) return false

  // Validate before arming send protection: this return never enters the
  // dispatch's try/finally, and the user must be able to fill a chip and retry.
  const missingParams = unfilledRequiredParams(paramIds, effectiveBinding, paramDeclarations)
  if (!literalPrediction && missingParams.length > 0) {
    toast.error(tTemplateParams("unfilled", { count: missingParams.length }))
    const first = paramTokens.find((seg) => seg.paramId === missingParams[0])
    const ta = textareaRef.current
    if (first && ta) {
      ta.focus()
      ta.setSelectionRange(first.start, first.start)
      setCaret(first.start)
      setActiveParamId(first.paramId)
    }
    return false
  }

  // Best-of-N owns the whole prompt, including subsequent lines. Letting the
  // general command batch split it would also send the trailing prose as a
  // second ordinary parent turn.
  const bestOfNCommand = !literalPrediction && text.trim().match(/^\/best-of-n(?:\s+([\s\S]*))?$/)
  if (bestOfNCommand) {
    if (localActionInFlightRef.current) return false
    const command = commandMap.get("best-of-n")
    if (!command) return false
    localActionInFlightRef.current = true
    try {
      const args = expandFoldedLinks(
        expandPastes(bestOfNCommand[1] ?? "", pastedBlocks),
        foldedLinks
      )
      const handled = await props.onCommand(command, args, {
        files: attachments.files.flatMap((file) =>
          file.id && file.url
            ? [{ id: file.id, url: file.url, mediaType: file.mediaType ?? "" }]
            : []
        ),
        consume: () => undefined,
      })
      if (handled && textInput.value === text) {
        textInput.clear()
        setPastedBlocks({})
        setFoldedLinks({})
      }
      return handled
    } finally {
      localActionInFlightRef.current = false
    }
  }
  // Inside a mixed batch the general pipeline would hand `/best-of-n` only
  // its own line and then send the remaining prose as an ordinary parent
  // turn. Refuse the batch before any command in it runs.
  if (
    !literalPrediction &&
    segments.some((segment) => segment.kind === "command" && segment.name === "best-of-n")
  ) {
    toast.error(tBestOfN("mixedBatch"))
    return false
  }

  const lane = liveTurn ? "followUp" : "turn"
  if (lane === "followUp") {
    followUpInFlightRef.current = true
    setFollowUpInFlight(true)
  } else {
    turnInFlightRef.current = true
    setTurnInFlight(true)
  }

  // Tactile confirmation for the most frequent chat action. The wrapper
  // no-ops off the Capacitor shell, so this is safe unconditionally.
  if (nativeMobile) void impact("light")

  // Post-send focus policy: with a hardware keyboard the textarea keeps focus
  // for rapid follow-ups; with a soft keyboard it blurs so the keyboard folds
  // away and the streaming reply isn't hidden behind it (ChatGPT-app
  // behavior). `hideKeyboard` is the native plugin; a browser folds its
  // keyboard on the blur alone.
  const settleFocusAfterSend = () => {
    if (softKeyboard) {
      textareaRef.current?.blur()
      if (nativeMobile) void hideKeyboard()
    } else {
      textareaRef.current?.focus()
    }
  }

  // Snapshot the attachments BEFORE the optimistic clear so the actual send
  // still has them (and so a failed send can restore the composer). The chip
  // order is the user's (drag-reordered) order, and the model must receive
  // them in exactly that order — see `buildAttachmentBlocks`.
  const snapshotFiles = applyOrder([...attachments.files], staged.order)
  const platformSubmission = props.session?.platformBinding
    ? { replyTo: selectComposerReplyTo(useChatStore.getState(), sessionId) }
    : undefined
  // `id` is RETAINED here (unlike before): it is the key `buildSendContent`
  // uses to look each file up in the staging-time extraction cache.
  // Provenance survives even when this send captured an extraction that was
  // still pending. It belongs to the submitted File, independently of parsing.
  const snapshotAttachmentInputs = snapshotFiles.map((item) => {
    const remoteDocument = parseRemoteDocumentProvenance(
      staged.byId.get(item.id)?.remoteDocument ?? stagedRemoteDocument(item.sourceFile)
    )
    return { ...item, ...(remoteDocument ? { remoteDocument } : {}) }
  })
  // Snapshot the folded-paste bodies too: the optimistic clear wipes them, so
  // the send (and a restore-on-failure) reads from this stable map.
  const pasteMap = pastedBlocks
  // Same for the folded links: the text carries short labels, and this is the
  // map that turns them back into the URLs the user actually wrote.
  const linkMap = foldedLinks
  const restoreText = (text: string) => expandFoldedLinks(expandPastes(text, pasteMap), linkMap)

  // ── Optimistic clear ───────────────────────────────────────────────────
  // Natural chat UX: the box empties the instant you hit send — not after the
  // whole turn resolves (`onSubmit` only settles once the send pipeline has
  // run, which is why the text used to linger for the entire response). We
  // snapshot first and restore on a rejected/failed send. `clearAfterSend`
  // off keeps everything in place (the user resends/tweaks), so skip then.
  let cleared = false
  const clearInputOptimistically = () => {
    if (!clearAfterSendEnabled || cleared) return
    // Optimistically clear ONLY the text + folded-paste chips. Attachments are
    // deliberately held back until the send is confirmed (`finalizeSend`):
    // `attachments.clear()` revokes every staged blob URL, so clearing here
    // would irrecoverably destroy the files on any rejected / cancelled /
    // thrown send (e.g. declining the oversize dialog).
    textInput.clear()
    setPastedBlocks({})
    setFoldedLinks({})
    cleared = true
  }
  // Run only once a send is CONFIRMED successful: now it is safe to drop (and
  // revoke) the staged attachments, the reminder chips, and the saved draft.
  const finalizeSend = () => {
    // Remember what this template's parameters were set to, so the next
    // insert pre-fills them — in practice most values repeat. Fire-and-forget
    // and only after a CONFIRMED send: losing a usage counter must never
    // surface as a failure on a turn that actually went out.
    // Repository templates deliberately remember nothing. There is no row to
    // write to, and a checkout's template is not the sort of thing that
    // should accumulate one person's last answers — what it wants pre-filled
    // it declares as a default, in the file, where the team can see it.
    const usedTemplateId = effectiveBinding?.templateId
    if (usedTemplateId && !usedTemplateId.startsWith(REPO_TEMPLATE_ID_PREFIX)) {
      void recordChatTemplateUse(usedTemplateId, effectiveBinding.params).catch(() => undefined)
    }
    const currentDraft = currentDraftRef.current
    if (currentDraft.sessionId !== sessionId) return
    if (clearAfterSendEnabled) {
      for (const file of snapshotFiles) attachments.remove(file.id)
      setRestoredAttachments([])
      const hasNewFiles = currentDraft.files.some(
        (file) => !snapshotFiles.some((submitted) => submitted.id === file.id)
      )
      if (sessionId && !currentDraft.text && !hasNewFiles) {
        void clearChatDraft(sessionId, { hostAlreadyCleared: true })
      }
    }
    settleFocusAfterSend()
  }
  const restoreInputAfterFailure = () => {
    if (!cleared) return
    const currentDraft = currentDraftRef.current
    // A failed request cannot replace follow-up typing or another session's
    // draft. Restore only while its optimistic empty input is still current.
    if (currentDraft.sessionId !== sessionId || textInput.value) {
      if (recoverHandoff && sessionId) {
        useComposerIntentStore.getState().stage(sessionId, {
          candidateId: crypto.randomUUID(),
          prompt: restoreText(text),
          mode: "append",
          waitForEmpty: true,
          citations: pendingHandoff?.citations,
        })
        // These sources belong to the deferred text, not newer follow-up
        // typing. The intent consumer restores them with that text.
        for (const ref of pendingHandoff?.citations ?? [])
          useChatStore.getState().removeCitedRef(ref.id, sessionId)
      }
      return
    }
    textInput.setInput(text)
    setPastedBlocks(pasteMap)
    // The text comes back holding SHORT labels, so the label→URL map has to
    // come back with it. Without this a failed send left every folded link as
    // literal prose, and the retry shipped `··owner/repo` to the model.
    setFoldedLinks(linkMap)
    cleared = false
    // Attachments were never cleared, so there is nothing to restore — the
    // staged files are still live in the controller.
  }
  // Substitute on the CHIP RANGES, before the command pipeline: code stays
  // code because the chip pass already excluded it, and a `/command`'s
  // arguments stay untouched for `applyTemplate`'s own `$1` pass.
  const paramRendered = renderParamTokens(text, paramTokens, effectiveBinding)
  // Captured from the text as it reads RIGHT HERE — before substitution and
  // before the command pipeline rewrites anything — because that is the only
  // form in which the parameters are still visible as parameters. What goes
  // out has the values baked in and nothing marking which words they were.
  const templateRun = templateRunFromBinding(effectiveBinding, text)

  clearInputOptimistically()

  try {
    // Let any in-flight staging extraction land first, so the send reuses it
    // instead of re-parsing the same document. Resolves synchronously when
    // nothing is pending, which is the overwhelmingly common case.
    await staged.whenSettled()
    const precomputed = staged.precomputed
    const filesToSend: SubmittedFile[] = await Promise.all(
      snapshotAttachmentInputs.map(async (item) => {
        // A file whose extraction is cached never needs its bytes again —
        // skip the blob→data-URL round trip entirely.
        if (!props.session?.platformBinding) {
          if (precomputed.has(item.id)) return item
          // A video is sampled from its blob URL at staging time and only
          // ever sent as those samples: reading a 500 MB source into a data
          // URL here would buy nothing and could exhaust the webview.
          if (isVideoDescriptor({ name: item.filename ?? "", mediaType: item.mediaType ?? "" })) {
            return item
          }
        }
        if (item.url?.startsWith("blob:")) {
          const dataUrl = await blobUrlToDataUrl(item.url)
          return { ...item, url: dataUrl ?? item.url }
        }
        return item
      })
    )

    // Platform recall cannot depend on folded maps cleared during submission.
    // Keep template tokens editable while retaining full paste/link bodies.
    history.record(props.session?.platformBinding ? restoreText(text) : text)

    // A model prediction is literal text: direct acceptance must never execute
    // a generated slash command, shell line or memory action.
    if (literalPrediction) {
      const ok = await props.onSubmit(text, filesToSend, precomputed)
      if (ok === false) restoreInputAfterFailure()
      else finalizeSend()
      return ok !== false
    }

    if (props.session?.platformBinding) {
      const ok = await props.onSubmit(
        restoreText(paramRendered.text),
        filesToSend,
        precomputed,
        templateRun,
        platformSubmission
      )
      if (ok === false) restoreInputAfterFailure()
      else finalizeSend()
      return ok !== false
    }

    // ── `!shell` / `#memory` first-line modes ────────────────────────────
    // Decided from the ORIGINAL input, never from the post-command outgoing
    // text: `/clear\n!ls` must NOT shell out just because stripping `/clear`
    // left `!ls` behind. And the mode claims only its FIRST LINE — exactly
    // what `detectTrigger` and the popover have always previewed — so lines
    // 2+ continue through the normal command/prose pipeline below.
    // The mode is decided from the ORIGINAL first character, but sliced out
    // of the substituted text. Safe together: whenever `text[0]` is `!` or
    // `#` it is not the start of a `{{token}}`, so substitution cannot have
    // moved index 0.
    const modeChar = text[0]
    const submittedText = paramRendered.text
    let pipelineText = submittedText
    let modeRan = false
    if (modeChar === "!" || modeChar === "#") {
      const newline = submittedText.indexOf("\n")
      const modeLine = (newline === -1 ? submittedText : submittedText.slice(0, newline))
        .slice(1)
        .trim()
      pipelineText = newline === -1 ? "" : submittedText.slice(newline + 1)
      modeRan = true
      if (modeChar === "!") {
        await props.onSubmitShell(modeLine)
      } else if (!modeLine) {
        toast.error(tMemory("needsLine"))
      } else {
        // Bare `#note` + Enter repeats the last destination instead of
        // demanding a popover pick every single time. The availability guard
        // matters here as much as on the pick path: a file target chosen in a
        // local conversation can be replayed in the browser, or in one whose
        // turns run on a remote Host, where this window cannot reach the
        // instruction files they load.
        const remembered = parseMemoryTargetKey(
          useComposerCommandStore.getState().lastMemoryTargetKey
        )
        if (!remembered) toast.info(tMemory("pickScope"))
        else if (!isMemoryTargetAvailable(remembered, memoryFilesAccess)) {
          toast.error(tMemory(memoryFilesUnavailableKey(memoryFilesAccess) ?? "desktopOnly"))
        } else await props.onSubmitMemory(remembered, modeLine)
      }
    }

    // Multi-command: `segments` is the live memo over the whole input; when a
    // first-line mode consumed line 1 we re-parse just the remainder so the
    // consumed line can't also be sent as prose. When the message contains one
    // or more line-start `/commands`, run them in order: action handlers
    // execute via `props.onCommand` (context-rich), template commands expand
    // inline, and the leftover prose is what gets sent.
    // `segments` is memoised over the UNSUBSTITUTED text, so it is stale the
    // moment a parameter was replaced — re-parse then too, not just after a
    // first-line mode consumed a line.
    const pipelineSegments =
      modeRan || paramRendered.changed
        ? parseSegments(pipelineText, (name) => commandMap.has(name))
        : segments
    const hasCommand = pipelineSegments.some((s) => s.kind === "command")
    if (hasCommand) {
      // Remember every runnable command sent (covers typed-not-picked ones).
      // Skip disabled/coming-soon commands so they can't pollute Recent — the
      // pick path already guards them before noteCommandUsed.
      for (const seg of pipelineSegments) {
        if (seg.kind === "command" && !commandMap.get(seg.name)?.disabled) {
          noteCommandUsed(seg.name)
        }
      }
      // Files an action command took for itself (`/video`'s start frame). A
      // later command in the same batch sees only what is still staged.
      const consumed = new Set<string>()
      const commandFiles = snapshotFiles.flatMap((file) =>
        file.id && file.url
          ? [
              {
                id: file.id,
                url: file.url,
                mediaType: file.mediaType ?? "",
                ...(file.filename ? { filename: file.filename } : {}),
              },
            ]
          : []
      )
      const stagedForCommand = (): SlashStagedFiles => ({
        files: commandFiles.filter((file) => !consumed.has(file.id)),
        consume: (ids) => {
          for (const id of ids) consumed.add(id)
        },
      })
      const draftOutput: string[] = []
      const { outgoingText, overrides, ranAction, errors, cancelled } = await runSegments(
        pipelineSegments,
        {
          commandMap,
          runAction: async (command, args) => {
            return props.onCommand(command, args, stagedForCommand(), (value) => {
              if (currentDraftRef.current.sessionId !== sessionId) return false
              draftOutput.push(value)
              return true
            })
          },
          applyTemplate,
        }
      )
      const remainingFiles = filesToSend.filter((file) => !file.id || !consumed.has(file.id))
      if (cancelled) {
        restoreInputAfterFailure()
        return false
      }
      useChatStore.getState().setPendingCommandOverrides(overrides)
      // A failed command in a batch used to vanish: `runSegments` isolates the
      // throw into `errors` precisely so the rest of the batch still runs, but
      // nothing read the array. Report it once, aggregated — N toasts for a
      // three-command chain would be worse than one.
      setCommandErrors(errors)
      if (errors.length > 0) {
        toast.error(
          tCommands("batchFailed", {
            count: errors.length,
            names: errors.map((e) => `/${e.name}`).join(", "),
          })
        )
      }
      // Only send a turn when there is prose or attachments. An action-only
      // batch (e.g. `/clear`) mutates client state and sends nothing — mirroring
      // today's "action command clears the input, no turn" behavior.
      let sent = true
      if (outgoingText.length > 0 || remainingFiles.length > 0) {
        const outgoing = restoreText(outgoingText)
        sent = await props.onSubmit(
          outgoing,
          remainingFiles,
          precomputed,
          templateRun,
          undefined,
          routeOf(outgoing)
        )
      } else if (!ranAction && !modeRan) {
        // Defensive: no prose, no files, no action, no first-line mode —
        // nothing was dispatched, so restore the optimistically-cleared input
        // rather than lose it.
        restoreInputAfterFailure()
        return false
      }
      if (sent) finalizeSend()
      else {
        restoreInputAfterFailure()
        if (nativeMobile) void notify("error")
      }
      const liveDraft = currentDraftRef.current
      if (draftOutput.length > 0 && liveDraft.sessionId === sessionId) {
        const current = sent && liveDraft.text === text ? "" : liveDraft.text
        textInput.setInput([current, ...draftOutput].filter(Boolean).join("\n\n"))
      }
      return sent
    }

    // A first-line mode that consumed the entire input has already done its
    // work — don't also send an empty turn.
    if (modeRan && pipelineText.trim().length === 0 && filesToSend.length === 0) {
      finalizeSend()
      return true
    }

    const outgoing = restoreText(pipelineText)
    const sent = await props.onSubmit(
      outgoing,
      filesToSend,
      precomputed,
      templateRun,
      undefined,
      routeOf(outgoing)
    )
    if (sent) finalizeSend()
    else {
      restoreInputAfterFailure()
      if (nativeMobile) void notify("error")
    }
    return sent
  } catch (err) {
    // A thrown send must not leave the user's text lost — restore the
    // optimistically-cleared input and surface the failure (don't rethrow
    // into the fire-and-forget click handler).
    restoreInputAfterFailure()
    if (nativeMobile) void notify("error")
    loggers.chat.error("composer send failed", err)
    return false
  } finally {
    // Always release the guard. On a successful send the store has already
    // flipped to "streaming" (so the button stays in stop state); on a
    // rejected/aborted send it returns to the idle send state so the user can
    // retry.
    if (lane === "followUp") {
      followUpInFlightRef.current = false
      setFollowUpInFlight(false)
    } else {
      turnInFlightRef.current = false
      setTurnInFlight(false)
    }
  }
}
