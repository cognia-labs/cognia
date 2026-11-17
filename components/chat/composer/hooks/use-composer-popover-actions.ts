"use client"

import type React from "react"
import { type PopoverItem } from "../../composer-popover"
import {
  detectTrigger,
  spliceToken,
  type ComposerTrigger,
  type ComposerWorkflowMention,
  type MentionMode,
  type MentionableWorkflowElement,
} from "../../composer-trigger"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { type ApplyPresetFn } from "@/hooks/chat/use-apply-preset"
import { useEntityMentionStaging } from "@/hooks/chat/use-entity-mention-staging"
import { type RemoteDocStagingItem } from "@/hooks/chat/use-remote-doc-staging"
import {
  isMemoryTargetAvailable,
  memoryFilesUnavailableKey,
  type ComposerMemoryTarget,
  type MemoryFilesAccess,
} from "@/lib/chat/memory-target"
import { getMentionPickHandler } from "@/lib/chat/mentions/pick-registry"
import { seedParamValues } from "@/lib/chat/template/template"
import { applyShellCompletion } from "@/lib/shell-intelligence/apply"
import { type SlashCommand } from "@/lib/slash-commands/builtin"
import { type CommandError } from "@/lib/slash-commands/run-segments"
import { type ChatTemplateBinding } from "@/lib/chat/template/binding"
import { type ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"
import { useChatStore } from "@/stores/chat"
import { type FileReference } from "@/stores/chat/chat-store"
import { type ChatSession } from "@cognia/agent-config-types"
import { type useTranslations } from "next-intl"
import { useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"

export interface ComposerPopoverActionsInput {
  tCommands: ReturnType<typeof useTranslations<"chat.composer.commands">>
  tMemory: ReturnType<typeof useTranslations<"chat.composer.memory">>
  tSkill: ReturnType<typeof useTranslations<"chat.composer.skills">>
  textValue: string
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  caret: number
  setCaret: React.Dispatch<React.SetStateAction<number>>
  popoverDismissed: { tokenStart: number; kind: string } | null
  setPopoverDismissed: React.Dispatch<
    React.SetStateAction<{ tokenStart: number; kind: string } | null>
  >
  setParamForm: React.Dispatch<
    React.SetStateAction<{ command: SlashCommand; tokenStart: number; tokenEnd: number } | null>
  >
  stageRemoteDoc: (item: RemoteDocStagingItem) => Promise<File | null>
  setCommandErrors: React.Dispatch<React.SetStateAction<CommandError[]>>
  addReferencedPath: (ref: FileReference, sessionId?: string | null | undefined) => void
  resolvedMentionMode: MentionMode
  applyPreset: ApplyPresetFn
  memoryFilesAccess: MemoryFilesAccess
  isLinkToken: (token: string) => boolean
  setTemplateBinding: React.Dispatch<React.SetStateAction<ChatTemplateBinding | undefined>>
  setPendingLaunchSpec: React.Dispatch<
    React.SetStateAction<{
      spec: ChatTemplateLaunchSpec
      templateName: string
      body: string
    } | null>
  >
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  noteCommandUsed: (name: string) => void
  trigger: ComposerTrigger | null
  hasCommandPrefix: (query: string) => boolean
  dismissShell: () => void
  props: {
    onSubmitMemory: (target: ComposerMemoryTarget, text: string) => Promise<boolean>
    session?: ChatSession | null
    workflowMention?: ComposerWorkflowMention
  }
}

/**
 * What picking, dismissing and editing in the completion popover does to the
 * input: inserting a command, mention, file, skill, preset or memory target,
 * opening a command's parameter form, and dropping a staged command.
 */
export function useComposerPopoverActions(input: ComposerPopoverActionsInput) {
  const {
    tCommands,
    tMemory,
    tSkill,
    textValue,
    textInput,
    textareaRef,
    caret,
    setCaret,
    popoverDismissed,
    setPopoverDismissed,
    setParamForm,
    stageRemoteDoc,
    setCommandErrors,
    addReferencedPath,
    resolvedMentionMode,
    applyPreset,
    memoryFilesAccess,
    isLinkToken,
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    noteCommandUsed,
    trigger,
    hasCommandPrefix,
    dismissShell,
    props,
  } = input

  useEffect(() => {
    if (!popoverDismissed) return
    const tg = detectTrigger(textValue, caret, {
      mentionMode: resolvedMentionMode,
      hasCommandPrefix,
    })
    if (!tg || tg.kind !== popoverDismissed.kind || tg.tokenStart !== popoverDismissed.tokenStart) {
      setPopoverDismissed(null)
    }
  }, [
    textValue,
    caret,
    popoverDismissed,
    props.session?.platformBinding,
    resolvedMentionMode,
    hasCommandPrefix,
    isLinkToken,
    setPopoverDismissed,
  ])

  // Drop one staged command from the input. Works on the absolute segment
  // range, then eats a single adjoining separator so removing the middle of
  // `/a /b /c` doesn't leave a double space (or a blank line for line-per-
  // command batches).
  const removeCommandSegment = useCallback(
    (start: number, end: number) => {
      const value = textInput.value
      let cutEnd = end
      if (value[cutEnd] === " ") cutEnd += 1
      else if (value[cutEnd] === "\r" && value[cutEnd + 1] === "\n") cutEnd += 2
      else if (value[cutEnd] === "\n") cutEnd += 1
      const next = value.slice(0, start) + value.slice(cutEnd)
      textInput.setInput(next)
      setCaret(start)
      setCommandErrors([])
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.setSelectionRange(start, start)
          ta.focus()
        }
      })
    },
    [setCaret, setCommandErrors, textInput, textareaRef]
  )

  const dismissPopover = useCallback(() => {
    if (trigger) {
      setPopoverDismissed({
        kind: trigger.kind,
        tokenStart: trigger.tokenStart,
      })
      // `!` mode keeps a scheduler and a host query behind the panel, and
      // neither is torn down by hiding it. Without this, Escape left a query in
      // flight to deliver into a closed list, and the stale candidates were
      // still in state to flash on the next `!`.
      if (trigger.kind === "bash") dismissShell()
    }
  }, [trigger, setPopoverDismissed, dismissShell])

  const insertReplacement = useCallback(
    (replacement: string, opts?: { closeAfter?: boolean }) => {
      if (!trigger) return
      const ta = textareaRef.current
      if (!ta) return
      const cur = textInput.value
      const result = spliceToken(cur, trigger.tokenStart, trigger.tokenEnd, replacement)
      textInput.setInput(result.value)
      // Keep the caret STATE in step with the programmatic move (the DOM
      // selection is set in rAF below, but setSelectionRange does not fire a
      // `select` event, so trigger detection / ghost suppression would read a
      // stale caret without this).
      setCaret(result.caret)
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(result.caret, result.caret)
          ta2.focus()
        }
      })
      if (opts?.closeAfter ?? true) dismissPopover()
    },
    [trigger, textareaRef, textInput, setCaret, dismissPopover]
  )

  // Delete the active trigger token outright (no replacement, no trailing
  // space) — used by the `@skill:` / `@preset:` picks, which act on the
  // session config rather than inserting text.
  const removeTriggerToken = useCallback(() => {
    if (!trigger) return
    const cur = textInput.value
    const before = cur.slice(0, trigger.tokenStart)
    const after = cur.slice(trigger.tokenEnd)
    const next = before + after
    textInput.setInput(next)
    setCaret(before.length)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.setSelectionRange(before.length, before.length)
        ta.focus()
      }
    })
    dismissPopover()
  }, [trigger, textInput, setCaret, dismissPopover, textareaRef])

  // The picker's active row → a transient canvas highlight. Depend on the
  // (memoized) onHighlight fn, not the whole props object, so this callback
  // stays stable and the popover's highlight effect doesn't re-fire per render.
  const workflowOnHighlight = props.workflowMention?.onHighlight
  const handleHighlightElement = useCallback(
    (element: MentionableWorkflowElement | null) => {
      workflowOnHighlight?.(element ? [element.id] : [])
    },
    [workflowOnHighlight]
  )

  // A latest-value ref, not a direct call: `stageRemoteDoc` re-identifies
  // whenever the staged-file list changes (it closes over `acceptFiles`), and
  // naming it in `onPickPopoverItem`'s deps would rebuild that whole callback
  // on every attachment add. The ref keeps the pick handler stable while still
  // reaching the current implementation. Written from an effect, never during
  // render.
  const stageRemoteDocRef = useRef<(item: RemoteDocStagingItem) => Promise<File | null>>(
    async () => null
  )
  useEffect(() => {
    stageRemoteDocRef.current = stageRemoteDoc
  }, [stageRemoteDoc])

  // `stageEntity` is stable already (it closes over the session id and the
  // translator), so it needs no latest-value ref — it can be named in the deps.
  const stageEntity = useEntityMentionStaging({ sessionId: props.session?.id ?? null })

  const onPickPopoverItem = useCallback(
    async (item: PopoverItem) => {
      if (!trigger) return
      if (item.kind === "shell") {
        // Completion spans are LINE coordinates; the textarea's are one further
        // along, because the `!` is not part of the line. Everything else about
        // the splice — the trailing space, the caret — belongs to the shared
        // `applyShellCompletion` so the popup and any future surface agree.
        const currentValue = textInput.value
        const newline = currentValue.indexOf("\n")
        const lineEnd = newline === -1 ? currentValue.length : newline
        const line = currentValue.slice(1, lineEnd)
        const applied = applyShellCompletion(line, item.completion)
        const nextValue = `!${applied.line}${currentValue.slice(lineEnd)}`
        const nextCaret = applied.cursor + 1
        textInput.setInput(nextValue)
        setCaret(nextCaret)
        requestAnimationFrame(() => {
          const textarea = textareaRef.current
          if (textarea) {
            textarea.setSelectionRange(nextCaret, nextCaret)
            textarea.focus()
          }
        })
        // Deliberately NOT dismissed: a directory completion is meant to be
        // followed straight away by the next path segment, and re-opening the
        // panel would cost a keystroke.
        return
      }
      if (item.kind === "slashArgument") {
        const currentValue = textInput.value
        const result = spliceToken(currentValue, item.replaceStart, item.replaceEnd, item.value)
        textInput.setInput(result.value)
        setCaret(result.caret)
        requestAnimationFrame(() => {
          const textarea = textareaRef.current
          if (textarea) {
            textarea.setSelectionRange(result.caret, result.caret)
            textarea.focus()
          }
        })
        dismissPopover()
      } else if (item.kind === "chatTemplate") {
        // Insert the BODY over the `/query` token, not the template's name:
        // picking a template produces a message, where picking a command drops
        // `/name` in for review. `spliceToken` is the shared insertion primitive
        // so the caret and trailing-space rules cannot drift from the others.
        const template = item.template
        const result = spliceToken(
          textInput.value,
          trigger.tokenStart,
          trigger.tokenEnd,
          template.body
        )
        textInput.setInput(result.value)
        // Seed from what this template was set to last time — in practice most
        // values repeat — falling back to the declared default. Both are
        // filtered to parameters the body still declares, so a value orphaned
        // by an edit cannot come back.
        const seeded = seedParamValues(template.params, template.lastParams)
        setTemplateBinding({
          templateId: template.id,
          version: String(template.revision),
          params: seeded,
          insertedAt: Date.now(),
        })
        // Held only so the diff bar can OFFER a matching conversation. Nothing
        // about the current one is touched — see `TemplateLaunchDiffBar`.
        setPendingLaunchSpec(
          template.launchSpec
            ? { spec: template.launchSpec, templateName: template.name, body: template.body }
            : null
        )
        // Land on the first parameter that still needs a value, with its editor
        // open — the whole point of inserting a template is to fill it in.
        const firstUnset = template.params.find((param) => !seeded[param.id])
        const bodyStart = trigger.tokenStart
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (!ta) return
          ta.focus()
          const tokenAt = firstUnset ? template.body.indexOf(`{{${firstUnset.id}}}`) : -1
          const caretAt = tokenAt >= 0 ? bodyStart + tokenAt : result.caret
          ta.setSelectionRange(caretAt, caretAt)
          setCaret(caretAt)
          if (firstUnset) setActiveParamId(firstUnset.id)
        })
        dismissPopover()
      } else if (item.kind === "slash") {
        const cmd = item.command
        if (cmd.disabled) {
          toast.info(tCommands("unavailable", { name: cmd.name }))
          return
        }
        // Commands with structured params open a guided form; defer insertion
        // until the user confirms. Capture the token range to splice into.
        if (cmd.params && cmd.params.length > 0) {
          setParamForm({ command: cmd, tokenStart: trigger.tokenStart, tokenEnd: trigger.tokenEnd })
          dismissPopover()
          return
        }
        // Don't run the command on pick — drop it into the composer so the user
        // can review / append args and send it together with the rest of their
        // message. Both action handlers and templates are expanded on submit by
        // `runSegments` (see the submit handler), so the behavior is uniform:
        // pick → stays in the box → Enter sends.
        //
        // Replace the whole typed `/<query>` token with `/<name>`. `trigger.query`
        // is only the command-name fragment the user typed (the slash token ends
        // at the first whitespace), so it must NOT be re-appended as args — doing
        // so turned a fuzzy pick like "res" → /reset into "/reset res". Any real
        // args typed after a space live outside [tokenStart, tokenEnd) and are
        // preserved by spliceToken, which also adds the trailing space.
        insertReplacement(`/${cmd.name}`)
        noteCommandUsed(cmd.name)
      } else if (item.kind === "memory") {
        const text = trigger.query.trim()
        if (!text) {
          toast.error(tMemory("needsLine"))
          return
        }
        if (!isMemoryTargetAvailable(item.target, memoryFilesAccess)) {
          toast.error(tMemory(memoryFilesUnavailableKey(memoryFilesAccess) ?? "desktopOnly"))
          return
        }
        const ok = await props.onSubmitMemory(item.target, text)
        // Clear only the consumed FIRST line — the `#` mode never owned the
        // rest of the message, and wiping it here silently discarded any
        // commands or prose the user had typed on later lines.
        if (ok) {
          const value = textInput.value
          const newline = value.indexOf("\n")
          const rest = newline === -1 ? "" : value.slice(newline + 1)
          textInput.setInput(rest)
          setCaret(0)
        }
        dismissPopover()
      } else {
        // Mention-style picks (file / agent / subagent / skill / preset /
        // wfElement) dispatch through the registry — adding a new mentionable
        // kind is a `registerMentionPickHandler` call, not a composer edit.
        const handler = getMentionPickHandler(item.kind)
        if (handler) {
          await handler.onPick(item, {
            insertReplacement,
            removeTriggerToken,
            addReferencedPath,
            toggleEphemeralSkill: (skillId) =>
              useChatStore.getState().toggleEphemeralSkill(skillId, props.session?.id ?? null),
            addReferencedWorkflowElement: (el) =>
              useChatStore.getState().addReferencedWorkflowElement(el, props.session?.id ?? null),
            applyPreset: (preset, session) => applyPreset(preset, session).then(() => {}),
            stageRemoteDoc: (item) => stageRemoteDocRef.current(item),
            stageEntity: (item) => stageEntity(item.candidate),
            recordMention: (ref) =>
              useChatStore.getState().addCitedRef(ref, props.session?.id ?? null),
            session: props.session,
            clearWorkflowHighlight: () => props.workflowMention?.onHighlight?.([]),
            strings: {
              skillEnabled: (name) => tSkill("enabled", { name }),
            },
          })
        }
      }
    },
    [
      trigger,
      textInput,
      setCaret,
      textareaRef,
      dismissPopover,
      setTemplateBinding,
      setPendingLaunchSpec,
      setActiveParamId,
      insertReplacement,
      noteCommandUsed,
      tCommands,
      setParamForm,
      memoryFilesAccess,
      props,
      tMemory,
      removeTriggerToken,
      addReferencedPath,
      applyPreset,
      stageEntity,
      tSkill,
    ]
  )

  // Param-form confirm: splice `/command <args>` into the captured token range
  // as a chip the user can review/send. Cancel just closes (leaving the typed
  // partial command intact).
  const handleParamFormSubmit = useCallback(
    (args: string) => {
      setParamForm((current) => {
        if (!current) return null
        const cur = textInput.value
        const replacement = `/${current.command.name}${args ? ` ${args}` : ""}`
        const { value, caret } = spliceToken(cur, current.tokenStart, current.tokenEnd, replacement)
        textInput.setInput(value)
        noteCommandUsed(current.command.name)
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (ta) {
            ta.setSelectionRange(caret, caret)
            ta.focus()
          }
        })
        return null
      })
    },
    [setParamForm, textInput, noteCommandUsed, textareaRef]
  )

  const handleParamFormCancel = useCallback(() => {
    setParamForm(null)
    textareaRef.current?.focus()
  }, [setParamForm, textareaRef])
  return {
    dismissPopover,
    removeCommandSegment,
    handleHighlightElement,
    onPickPopoverItem,
    handleParamFormSubmit,
    handleParamFormCancel,
  }
}
