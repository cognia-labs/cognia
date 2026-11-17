"use client"

import type React from "react"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { useRepoChatTemplates } from "@/hooks/chat/use-repo-chat-templates"
import { type RouteTargetsState } from "@/hooks/chat/use-route-targets"
import { useTemplateResourceSearch } from "@/hooks/chat/use-template-resource-search"
import { type SubagentMentionTarget } from "@/lib/chat/mentions/agent-targets"
import { startNewSession } from "@/lib/chat/start-session"
import {
  paramState as paramStateOfValue,
  pruneBinding,
  type ChatTemplateBinding,
  type ChatTemplateParamValue,
  withParamValue,
} from "@/lib/chat/template/binding"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import {
  diffLaunchSpec,
  launchSpecSeed,
  type ChatTemplateLaunchSpec,
  type LaunchSpecDifference,
} from "@/lib/chat/template/launch-spec"
import { listParamTokens } from "@/lib/chat/template/param-segments"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import { onTemplateRerunRequest } from "@/lib/chat/template/rerun-request"
import { bindingFromRun } from "@/lib/chat/template/run"
import { type OfferedChatTemplate } from "@/lib/chat/template/template"
import {
  createChatTemplate,
  listChatTemplates,
  subscribeChatTemplates,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import { type ParamSegment, type RichSegment } from "@/lib/slash-commands/parse-segments"
import { type Character, type ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

export interface ComposerTemplatesInput {
  tTemplateParams: ReturnType<typeof useTranslations<"chat.composer.templateParams">>
  textValue: string
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  cwd: string | null
  sessionId: string | null
  routes: RouteTargetsState
  chatAgents: SubagentMentionTarget[] | undefined
  teamMembers: readonly Character[]
  overlaySegments: RichSegment[]
  props: {
    session?: ChatSession | null
  }
}

/**
 * Chat templates in the composer: the bound template and its parameter pills,
 * the parameter resources, preview, launch-spec differences, saving the draft
 * as a template and starting a session from one.
 */
export function useComposerTemplates(input: ComposerTemplatesInput) {
  const {
    tTemplateParams,
    textValue,
    textInput,
    textareaRef,
    setCaret,
    cwd,
    sessionId,
    routes,
    chatAgents,
    teamMembers,
    overlaySegments,
    props,
  } = input

  // ── `{{parameter}}` values ────────────────────────────────────────────────
  // The tokens live in the text (so a reload recovers them for free); their
  // values live on the draft row, because the chip overlay is a
  // character-for-character mirror of the textarea and a pill can only ever
  // paint the token it covers.
  const [templateBinding, setTemplateBinding] = useState<ChatTemplateBinding | undefined>()
  /** Which parameter the editor panel is open on, if any. */
  const [activeParamId, setActiveParamId] = useState<string | null>(null)
  /** Show the message with its values substituted, read-only. */
  const [previewRequested, setPreviewRequested] = useState(false)
  /** Personal templates offered in the `/` menu. Reloaded whenever one is saved. */
  const [savedTemplates, setSavedTemplates] = useState<ChatTemplateRow[]>([])
  const [templateEpoch, setTemplateEpoch] = useState(0)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  /**
   * The launch spec of the template just inserted, held only so the diff bar
   * can offer to start a conversation that matches it. Cleared on dismiss and
   * whenever the binding goes.
   */
  const [pendingLaunchSpec, setPendingLaunchSpec] = useState<{
    spec: ChatTemplateLaunchSpec
    templateName: string
    body: string
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    listChatTemplates()
      .then((rows) => {
        if (!cancelled) setSavedTemplates(rows)
      })
      // Dexie unavailable (SSR / a test without fake-indexeddb): the `/` menu
      // simply offers no templates, which is the same as having none.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [templateEpoch])
  // Templates also change behind this box: saved or imported in Settings,
  // adopted from a repository, or pulled in by the companion sync on a phone.
  // Each of those announces itself, so the `/` menu follows without a remount.
  useEffect(() => subscribeChatTemplates(() => setTemplateEpoch((epoch) => epoch + 1)), [])
  /**
   * Load a past turn back into the box, chips and all.
   *
   * Subscribed rather than passed down: the message row that offers this sits
   * three layers inside the virtualised list and the composer is the list's
   * SIBLING, so a callback would have to be threaded through components that
   * have no interest in it. The address check is what keeps a split pane group
   * from filling in every composer at once.
   *
   * It refuses over a non-empty box. Replacing is the obvious implementation
   * and it silently destroys whatever was half-written — the input history only
   * holds SENT messages, so there would be nothing to recover it from. One
   * extra step in a rare case beats losing text in it.
   */
  useEffect(
    () =>
      onTemplateRerunRequest((detail) => {
        if (!sessionId || detail.sessionId !== sessionId) return
        if (textInput.value.trim().length > 0) {
          toast.info(tTemplateParams("rerunBusy"))
          return
        }
        textInput.setInput(detail.run.text)
        setTemplateBinding(bindingFromRun(detail.run, Date.now()))
        setPendingLaunchSpec(null)
        // Land on the first parameter with its editor open — the reason to
        // re-run a turn is to change one of them.
        const first = listParamTokens(detail.run.text, computeCodeRanges(detail.run.text))[0]
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (!ta) return
          ta.focus()
          const caret = first ? first.start : detail.run.text.length
          ta.setSelectionRange(caret, caret)
          setCaret(caret)
          if (first) setActiveParamId(first.paramId)
        })
      }),
    [sessionId, textInput, textareaRef, setCaret, tTemplateParams]
  )

  // Templates that travel IN the checkout, behind the same Workspace Trust
  // verdict the send path uses. Personal ones come first: they are yours, and a
  // `git pull` must never reorder the list you built muscle memory on.
  const repoTemplates = useRepoChatTemplates(cwd)
  const chatTemplates: OfferedChatTemplate[] = useMemo(
    () => [...savedTemplates, ...repoTemplates],
    [savedTemplates, repoTemplates]
  )

  const paramTokens = useMemo(
    () => overlaySegments.filter((seg): seg is ParamSegment => seg.kind === "param"),
    [overlaySegments]
  )
  // Derived from the chips rather than from a fresh scan of the text, so the
  // set that blocks a send is exactly the set the user can see and click. A
  // second scan would also count `{{x}}` inside a `/command`'s arguments, which
  // is never a chip and belongs to `applyTemplate`.
  const paramIds = useMemo(() => [...new Set(paramTokens.map((seg) => seg.paramId))], [paramTokens])
  // Values whose token has left the text are dropped here rather than in an
  // effect: breaking a token is how the user demotes a chip, and the value has
  // to go with it or retyping `{{module}}` later would resurrect an answer from
  // a sentence that no longer exists. Deriving keeps it out of a setState loop.
  const effectiveBinding = useMemo(
    () => (templateBinding ? pruneBinding(templateBinding, paramIds) : undefined),
    [templateBinding, paramIds]
  )
  /**
   * Whether a bound reference still points at something on THIS device.
   *
   * Only answered for the kinds whose whole population is already in memory. A
   * file is deliberately never judged: the workspace may simply not be loaded
   * yet, and a dangling `@path` is exactly what typing one by hand produces —
   * flagging it would be inventing a failure the composer does not otherwise
   * have. An empty candidate list means "this composer has no source for that
   * kind", not "the target is gone", so it is not evidence either.
   */
  const isResourceResolvable = useCallback(
    (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => {
      if (value.resourceKind === "subagent") {
        // `chatAgents` is undefined outside combined-mention mode — a composer
        // with no subagent source at all, which is the same "no evidence" case
        // as an empty list, not a reason to flag the chip.
        const list = chatAgents ?? []
        return list.length === 0 || list.some((agent) => agent.handle === value.id)
      }
      if (value.resourceKind === "agent") {
        // Matched on the handle AND the name: a template saved before route
        // targets carried handles stored the target's name as its id.
        const list = routes.targets
        return (
          list.length === 0 ||
          list.some((target) => target.handle === value.id || target.name === value.id)
        )
      }
      if (value.resourceKind === "member") {
        // Empty outside a team room: no evidence either way. Inside one, the
        // member must still be here AND still answer to the name that was
        // inserted, because the router matches `@Name`; a renamed character
        // leaves a token that routes to nobody.
        return (
          teamMembers.length === 0 ||
          teamMembers.some((member) => member.id === value.id && `@${member.name}` === value.raw)
        )
      }
      return true
    },
    [chatAgents, routes.targets, teamMembers]
  )
  const paramPillState = useCallback(
    (paramId: string) => paramStateOfValue(effectiveBinding?.params[paramId], isResourceResolvable),
    [effectiveBinding, isResourceResolvable]
  )
  /**
   * The declarations behind the tokens currently in the box — labels, which
   * parameters are optional, and which open an `@` picker instead of a text
   * field.
   *
   * Only honoured when the saved template is still at the revision this draft
   * was inserted at. The binding pins a version and never follows the template
   * (see `ChatTemplateBinding`), so reading a NEWER declaration list here would
   * quietly re-interpret a half-written message: a parameter demoted to
   * optional after the fact would stop blocking a send that the user set up
   * expecting it to. On a mismatch every token falls back to "required free
   * text", which is what an undeclared token already is.
   */
  const paramDeclarations = useMemo(() => {
    if (!effectiveBinding) return []
    const row = chatTemplates.find((template) => template.id === effectiveBinding.templateId)
    if (!row || String(row.revision) !== effectiveBinding.version) return []
    return row.params
  }, [chatTemplates, effectiveBinding])
  const searchTemplateResources = useTemplateResourceSearch({
    cwd,
    chatAgents,
    routeTargets: routes.targets,
    teamMembers,
  })
  /** The parameter token containing `caret`, or null. */
  const paramTokenAt = useCallback(
    (caret: number) => paramTokens.find((seg) => caret >= seg.start && caret <= seg.end) ?? null,
    [paramTokens]
  )
  // The one real cost of keeping the token in the text is that you never see
  // the finished sentence while editing — the chip overlay has to mirror the
  // textarea character for character, so a pill can only paint `{{module}}`.
  // This is the answer to that, and it only exists when there is something to
  // preview.
  const preview = useMemo(() => {
    if (paramTokens.length === 0) return null
    return {
      on: previewRequested,
      text: renderParamTokens(textValue, paramTokens, effectiveBinding).text,
      toggle: () => setPreviewRequested((on) => !on),
    }
  }, [paramTokens, previewRequested, textValue, effectiveBinding])

  const tSaveTemplate = useTranslations("chat.composer.saveTemplate")
  const tLaunchDiff = useTranslations("chat.composer.launchDiff")

  /** What the inserted template's setup would change about THIS conversation. */
  const launchDifferences: LaunchSpecDifference[] = useMemo(() => {
    if (!pendingLaunchSpec || !props.session) return []
    return diffLaunchSpec(pendingLaunchSpec.spec, {
      model: props.session.model,
      permissionMode: props.session.permissionMode,
      systemPrompt: props.session.systemPrompt,
      workingDir: props.session.workingDir,
      characterId: props.session.characterId,
      squadId: props.session.squadId,
      projectId: props.session.projectId,
    })
  }, [pendingLaunchSpec, props.session])

  /** The current conversation's setup, offered to "save as template". */
  const currentLaunchSpec: ChatTemplateLaunchSpec | undefined = useMemo(() => {
    const session = props.session
    if (!session) return undefined
    return {
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.workingDir ? { workingDir: session.workingDir } : {}),
      ...(session.characterId ? { characterId: session.characterId } : {}),
      ...(session.squadId ? { squadId: session.squadId } : {}),
      ...(session.projectId ? { workspace: { projectId: session.projectId } } : {}),
    }
  }, [props.session])

  const launchFieldLabel = useCallback(
    (difference: LaunchSpecDifference): string => {
      const label = {
        characterId: tLaunchDiff("fieldCharacter"),
        squadId: tLaunchDiff("fieldSquad"),
        projectId: tLaunchDiff("fieldProject"),
        model: tLaunchDiff("fieldModel"),
        permissionMode: tLaunchDiff("fieldPermissionMode"),
        workingDir: tLaunchDiff("fieldWorkingDir"),
        systemPrompt: tLaunchDiff("fieldSystemPrompt"),
      }[difference.field]
      // The value itself for anything with a readable one; an opaque id reads
      // as noise, so those show only which axis differs.
      const opaque = difference.field === "characterId" || difference.field === "squadId"
      return opaque ? label : `${label}: ${difference.wanted}`
    },
    [tLaunchDiff]
  )

  /**
   * Start a fresh conversation configured the way the template asks, and carry
   * the body across. The current conversation is left exactly as it was.
   */
  const startSessionFromTemplate = useCallback(async () => {
    const pending = pendingLaunchSpec
    if (!pending) return
    setPendingLaunchSpec(null)
    try {
      await startNewSession(launchSpecSeed(pending.spec))
      // The composer is not remounted per session, so the draft-hydration
      // effect clears the box for the new one — set the body after it has,
      // which is the same frame the session id lands in props.
      requestAnimationFrame(() => textInput.setInput(pending.body))
    } catch (err) {
      loggers.chat.error("composer: starting a session from a template failed", err)
    }
  }, [pendingLaunchSpec, textInput])
  const saveCurrentAsTemplate = useCallback(
    async (input: { name: string; description?: string; launchSpec?: ChatTemplateLaunchSpec }) => {
      await createChatTemplate({ ...input, body: textInput.value })
      // Re-read rather than push onto the local list: the store derives the
      // declarations and the id, and re-reading is the only way the `/` menu
      // shows exactly what was stored.
      setTemplateEpoch((epoch) => epoch + 1)
      toast.success(tSaveTemplate("saved"))
    },
    [textInput, tSaveTemplate]
  )

  const setParamValue = useCallback((paramId: string, value: ChatTemplateParamValue) => {
    setTemplateBinding((prev) =>
      withParamValue(
        prev ?? { templateId: "", version: "", params: {}, insertedAt: Date.now() },
        paramId,
        value
      )
    )
  }, [])
  return {
    setTemplateBinding,
    setPendingLaunchSpec,
    setActiveParamId,
    paramIds,
    effectiveBinding,
    paramDeclarations,
    paramTokens,
    activeParamId,
    paramTokenAt,
    pendingLaunchSpec,
    launchDifferences,
    launchFieldLabel,
    startSessionFromTemplate,
    paramPillState,
    preview,
    setSaveTemplateOpen,
    saveTemplateOpen,
    currentLaunchSpec,
    saveCurrentAsTemplate,
    searchTemplateResources,
    setParamValue,
    chatTemplates,
  }
}
