"use client"

/**
 * Main-window half of the selection toolbar.
 *
 * Three of the six actions are prompts and land in the composer with the window
 * raised. The other two run here *without* raising the window — stashing a note
 * or reading text aloud must not interrupt whatever the user is doing in
 * another app — and report back to the overlay, which stays on screen showing a
 * spinner, a ✓, a PII warning, or a player until they settle.
 *
 * The memory path in particular has to report: `storeExternalMemory` *returns*
 * `{ok: false, reason: "pii_blocked"}` rather than throwing, so a fire-and-
 * forget write would be a silent no-op whenever the main window is in the tray.
 */

import { useEffect, useRef } from "react"
import { listen } from "@tauri-apps/api/event"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"

import { startNewSession } from "@/lib/chat/start-session"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { storeExternalMemory } from "@/lib/memory/api/store-memory"
import { loadPort } from "@/lib/modules/ports"
import {
  SELECTION_RESULT_EVENT,
  SELECTION_ACTION_CATALOG_EVENT,
  SELECTION_ACTION_CATALOG_REQUEST_EVENT,
  SELECTION_ACTION_CANCEL_EVENT,
  SELECTION_CONSENT_EVENT,
  SELECTION_CONSENT_RESPONSE_EVENT,
  SELECTION_OPEN_RESULT_ACK_EVENT,
  SELECTION_REQUEST_TIMEOUT_MS,
  SELECTION_ACTION_REQUEST_EVENT,
  SELECTION_ACTION_RESULT_EVENT,
  SELECTION_OPEN_RESULT_EVENT,
  SELECTION_CANDIDATE_EVENT,
  SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF,
  SELECTION_SPEECH_EVENT,
  SELECTION_SPEECH_STOP_EVENT,
  SELECTION_STAGE_EVENT,
  getCurrentSelectionCandidate,
  selectionActionResult,
  listenSelectionControl,
  sendSelectionControl,
  type SelectionActionRequestPayload,
  type SelectionActionExecutionPayload,
  finishSelectionToolbar,
  type SelectionOpenResultPayload,
  type ExternalSelectionCandidate,
  type SelectionLiveStagePayload,
} from "@/lib/tauri/selection-toolbar"
import { selectComposerContextSelections, useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { ExternalSelectionRef } from "@/types/artifact/artifact"
import { classifySelection } from "@/lib/selection/classify-selection"
import { selectionIsSecure } from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  getQuickAction,
  listQuickActions,
  subscribeQuickActions,
} from "@/lib/plugin/registries/quick-action-registry"
import {
  executePluginSelectionQuickAction,
  SelectionQuickActionError,
} from "@/lib/selection/plugin-actions"
import {
  pluginActionIsEligible,
  type SelectionHostActionDescriptor,
} from "@/lib/selection/action-layout"
import { lookupPluginMessage } from "@/lib/i18n/plugin-i18n-registry"
import { getPref } from "@/lib/tauri/store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { enhancePrompt, ENHANCE_MODES, type EnhanceMode } from "@/lib/chat/completion/enhance"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { showMainWindow } from "@/lib/tauri/overlay-windows"
import {
  getPluginConsentBroker,
  type PluginConsentResponse,
} from "@/lib/plugin/security/consent-broker"

function localizedPluginActionTitle(
  pluginId: string,
  locale: string,
  labelKey: string | undefined,
  fallback: string
): string {
  if (!labelKey) return fallback
  return lookupPluginMessage(locale, `plugin.${pluginId}.${labelKey}`) ?? fallback
}

function pluginCatalogForCandidate(
  candidate: ExternalSelectionCandidate,
  locale: string,
  rewrite: SelectionHostActionDescriptor
): SelectionHostActionDescriptor[] {
  // Same rule the built-in table applies, at the other end of the wire. Rust
  // refuses to read a password field and the overlay withholds every built-in
  // action for one, but this catalog is assembled here and shipped over, so
  // without the gate a secure candidate that somehow arrived would be offered
  // to every plugin that registered for the selection surface.
  if (selectionIsSecure(candidate)) return []
  const classification = classifySelection(candidate.text, { uiLocale: locale })
  const plugins = listQuickActions("selection").flatMap((entry) => {
    if (!entry.selection) return []
    const descriptor: SelectionHostActionDescriptor = {
      id: entry.fullId,
      title: localizedPluginActionTitle(entry.pluginId, locale, entry.labelKey, entry.title),
      source: "plugin",
      pluginId: entry.pluginId,
      attribution: entry.pluginId,
      icon: entry.icon,
      accelerator: entry.accelerator,
      directReplace: entry.selection.output === "replace",
      ...entry.selection,
    }
    return pluginActionIsEligible(descriptor, {
      origin: candidate.origin,
      contentTypes: classification.types,
      chars: Array.from(candidate.text).length,
    })
      ? [descriptor]
      : []
  })
  return [rewrite, ...plugins]
}

function rewriteDescriptor(
  t: ReturnType<typeof useTranslations<"selectionToolbar">>
): SelectionHostActionDescriptor {
  return {
    id: "cognia:rewrite",
    title: t("rewrite.title"),
    source: "cognia",
    attribution: t("cogniaAttribution"),
    input: "text",
    output: "replace",
    origins: ["accessibility", "clipboard", "ocr"],
    directReplace: true,
    children: ENHANCE_MODES.map((mode) => ({
      id: `cognia:rewrite:${mode}`,
      title: t(`rewrite.modes.${mode}` as never),
    })),
  }
}

function promptForAction(
  action: SelectionLiveStagePayload["action"],
  candidate: ExternalSelectionCandidate,
  locale: string,
  t: ReturnType<typeof useTranslations<"selectionToolbar">>
): string | null {
  const classification = classifySelection(candidate.text, { uiLocale: locale })
  switch (action.kind) {
    case "copy":
    case "ask":
    case "remember":
    case "speak":
    // `launch` actions never reach the composer — Rust hands them to the
    // browser or the mail client and the toolbar leaves.
    case "openLink":
    case "composeEmail":
    case "searchWeb":
      return null
    case "explain":
      return classification.types.includes("code") ? t("prompts.explainCode") : t("prompts.explain")
    case "translate":
      return classification.script
        ? t("prompts.translateDetected", {
            script: classification.script,
            language: t(`languages.${action.targetLocale}` as never),
          })
        : t("prompts.translate", {
            language: t(`languages.${action.targetLocale}` as never),
          })
    case "convertUnit":
      return classification.types.includes("measurement")
        ? t("prompts.convertMeasurement")
        : t("prompts.convertUnit")
  }
}

async function reportResult(candidateId: string, ok: boolean, reason?: string): Promise<void> {
  await sendSelectionControl(SELECTION_RESULT_EVENT, { candidateId, ok, reason })
}

async function rememberSelection(candidate: ExternalSelectionCandidate): Promise<void> {
  try {
    const result = await storeExternalMemory(
      {
        text: candidate.text,
        tags: ["selection", candidate.sourceApp].filter(Boolean),
        source: {},
      },
      { channel: "selection" }
    )
    await reportResult(candidate.id, result.ok, result.ok ? undefined : result.reason)
  } catch {
    await reportResult(candidate.id, false)
  }
}

export function SelectionToolbarInitializer() {
  const router = useRouter()
  const locale = useLocale()
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const t = useTranslations("selectionToolbar")
  const tRef = useRef(t)
  const localeRef = useRef(locale)
  useEffect(() => {
    tRef.current = t
    localeRef.current = locale
  }, [locale, t])

  useEffect(() => {
    let alive = true
    const owner = useAccountStore.getState()
    const assertOwner = () => {
      const current = useAccountStore.getState()
      if (
        !alive ||
        !owner.unlockedAccountId ||
        current.locked ||
        current.unlockedAccountId !== owner.unlockedAccountId ||
        current.accountRevision !== owner.accountRevision
      ) {
        throw new SelectionQuickActionError("ineligible", "Selection account is no longer active")
      }
    }
    const unlistens: Array<() => void | Promise<void>> = []
    // One playback subscription at a time — a second `speak` supersedes the
    // first, exactly as the single orchestrator does.
    let stopWatching: (() => void) | null = null
    const requests = new Map<string, AbortController>()
    const handledRequests = new Set<string>()
    const pendingPrompts = new Map<string, string>()
    let catalogCandidateId: string | null = null

    const publishPluginCatalog = async () => {
      assertOwner()
      const current = await getCurrentSelectionCandidate()
      assertOwner()
      if (!current) return
      if (catalogCandidateId !== current.id) {
        catalogCandidateId = current.id
        handledRequests.clear()
      }
      await sendSelectionControl(SELECTION_ACTION_CATALOG_EVENT, {
        candidateId: current.id,
        actions: pluginCatalogForCandidate(
          current,
          localeRef.current,
          rewriteDescriptor(tRef.current)
        ),
      })
    }

    const requireCandidate = async (id: string, signal?: AbortSignal) => {
      assertOwner()
      const candidate = await getCurrentSelectionCandidate()
      assertOwner()
      signal?.throwIfAborted()
      if (!candidate || candidate.id !== id || selectionIsSecure(candidate)) {
        throw new SelectionQuickActionError("ineligible", "Selection is no longer active")
      }
      return candidate
    }

    const executePluginAction = async (request: SelectionActionRequestPayload) => {
      if (handledRequests.has(request.requestId) || requests.has(request.requestId)) return
      const controller = new AbortController()
      const { signal } = controller
      requests.set(request.requestId, controller)
      const forgetRequest = () => {
        requests.delete(request.requestId)
        pendingPrompts.delete(request.requestId)
      }
      signal.addEventListener("abort", forgetRequest, { once: true })
      const timeout = setTimeout(() => controller.abort(), SELECTION_REQUEST_TIMEOUT_MS)
      const emitResult = async (
        result: Omit<SelectionActionExecutionPayload, keyof SelectionActionRequestPayload>
      ) => {
        if (result.result) {
          await selectionActionResult(request.candidateId, request.requestId, {
            ...request,
            ...result,
          })
          signal.throwIfAborted()
          assertOwner()
          await sendSelectionControl(SELECTION_ACTION_RESULT_EVENT, {
            ...request,
            ok: true,
            stored: true,
          })
        } else {
          await sendSelectionControl(SELECTION_ACTION_RESULT_EVENT, {
            ...request,
            ...result,
          })
        }
      }
      try {
        const candidate = await requireCandidate(request.candidateId, signal)
        handledRequests.add(request.requestId)
        const rewriteMode = request.actionId.startsWith("cognia:rewrite:")
          ? (request.actionId.slice("cognia:rewrite:".length) as EnhanceMode)
          : null
        if (rewriteMode !== null) {
          if (!ENHANCE_MODES.includes(rewriteMode)) {
            await emitResult({ ok: false, error: "stale" })
            return
          }
          const appSettings = useSettingsStore.getState().settings
          const client =
            buildUtilityLlmClient({
              session: null,
              appSettings,
              override: appSettings?.composerAssistance?.model,
              featureId: "selection-rewrite",
            }) ?? buildHeadlessTurnLlmClient({ session: null, label: "Selection rewrite" })
          if (!client) {
            await emitResult({ ok: false, error: "noModel" })
            return
          }
          const enhanced = await enhancePrompt(candidate.text, rewriteMode, { client, signal })
          await requireCandidate(candidate.id, signal)
          if (enhanced.kind === "skipped") {
            await emitResult({
              ok: false,
              error: enhanced.reason === "pii" ? "piiBlocked" : "noOutput",
            })
            return
          }
          const allowlist = (await getPref<string[]>(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF)) ?? []
          await requireCandidate(candidate.id, signal)
          await emitResult({
            ok: true,
            result:
              enhanced.kind === "variants"
                ? { kind: "variants", variants: enhanced.variants }
                : { kind: "text", text: enhanced.text },
            attribution: tRef.current("cogniaAttribution"),
            output: "replace",
            directReplaceAllowed:
              allowlist.includes("cognia:rewrite") || allowlist.includes(request.actionId),
          })
          return
        }

        const entry = getQuickAction(request.actionId)
        if (!entry?.selection || !entry.surfaces.includes("selection")) {
          await emitResult({ ok: false, error: "stale" })
          return
        }
        const classification = classifySelection(candidate.text, { uiLocale: localeRef.current })
        const result = await executePluginSelectionQuickAction(entry, candidate, classification, {
          signal,
          validate: async () => {
            await requireCandidate(candidate.id, signal)
          },
          assertCurrent: assertOwner,
          emitConsent: async (prompt) => {
            await requireCandidate(candidate.id, signal)
            pendingPrompts.set(request.requestId, prompt.requestId)
            await sendSelectionControl(SELECTION_CONSENT_EVENT, {
              candidateId: candidate.id,
              actionRequestId: request.requestId,
              promptId: prompt.requestId,
              pluginId: prompt.pluginId,
              reason: prompt.reason,
            })
          },
          reason: tRef.current("permissionRequest", {
            title: localizedPluginActionTitle(
              entry.pluginId,
              localeRef.current,
              entry.labelKey,
              entry.title
            ),
          }),
        })
        const allowlist = (await getPref<string[]>(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF)) ?? []
        await requireCandidate(candidate.id, signal)
        if (getQuickAction(request.actionId) !== entry) {
          throw new SelectionQuickActionError("ineligible", "Selection action became stale")
        }
        await emitResult({
          ok: true,
          result: result || undefined,
          attribution: entry.pluginId,
          output: entry.selection.output,
          directReplaceAllowed:
            entry.selection.output === "replace" && allowlist.includes(entry.fullId),
        })
      } catch (error) {
        if (!alive || signal.aborted) return
        const code =
          error instanceof SelectionQuickActionError
            ? error.code === "permissionDenied" || error.code === "invalidResult"
              ? error.code
              : "stale"
            : "failed"
        await emitResult({ ok: false, error: code }).catch(() => {})
      } finally {
        clearTimeout(timeout)
        forgetRequest()
        signal.removeEventListener("abort", forgetRequest)
      }
    }

    // Read aloud through the `speech` port (ADR-0250 §14). Where no module
    // provides it, the toolbar hears at once that nothing is playing.
    const beginSpeaking = (candidate: ExternalSelectionCandidate) => {
      stopWatching?.()
      let started = false
      let settled = false
      let stopPlayback: (() => void) | undefined
      let unwatch: (() => void) | undefined
      const retire = () => {
        settled = true
        unwatch?.()
        if (stopWatching === cancelSpeech) stopWatching = null
      }
      const cancelSpeech = () => {
        retire()
        stopPlayback?.()
      }
      stopWatching = cancelSpeech
      const ended = () => {
        if (settled || !alive) return
        retire()
        void sendSelectionControl(SELECTION_SPEECH_EVENT, {
          candidateId: candidate.id,
          playing: false,
        }).catch(() => {})
      }
      void loadPort("speech")
        .then(async (speech) => {
          await requireCandidate(candidate.id)
          if (settled) return
          if (!speech) {
            ended()
            return
          }
          unwatch = speech.readAloud.watchSelection(candidate.id, (update) => {
            if (settled || !alive) return
            if (!update.playing) {
              ended()
              return
            }
            started = true
            void sendSelectionControl(SELECTION_SPEECH_EVENT, {
              candidateId: candidate.id,
              playing: true,
              progress: update.progress,
            }).catch(() => {})
          })
          if (settled) {
            unwatch()
            return
          }
          stopPlayback = () => {
            void speech.readAloud.stopSelection(candidate.id)
          }
          await speech.readAloud.speakSelection({
            candidateId: candidate.id,
            text: candidate.text,
            beforeStart: async () => {
              await requireCandidate(candidate.id)
              if (settled) throw new Error("Selection playback was canceled")
            },
          })
          if (!started) ended()
        })
        .catch(ended)
    }

    const stageIntoComposer = async (
      candidate: ExternalSelectionCandidate,
      action: SelectionLiveStagePayload["action"]
    ) => {
      const sessionId = useChatStore.getState().activeSessionId ?? (await startNewSession()).id
      await requireCandidate(candidate.id)
      if (!(await showMainWindow({ checked: true })))
        throw new Error("Could not show the main window")
      assertOwner()
      const chat = useChatStore.getState()
      if (
        !selectComposerContextSelections(chat, sessionId).some(
          (selection) => selection.kind === "external" && selection.candidateId === candidate.id
        )
      ) {
        const selection: ExternalSelectionRef = {
          kind: "external",
          candidateId: candidate.id,
          title: candidate.sourceTitle ?? candidate.sourceApp,
          snapshot: candidate.text,
          comment: "",
          sourceApp: candidate.sourceApp,
          sourceTitle: candidate.sourceTitle,
          sourceUrl: candidate.sourceUrl,
          capturedAt: candidate.capturedAt,
          origin: candidate.origin,
          truncated: candidate.truncated,
        }
        chat.addContextSelection(selection, sessionId)
      }
      useComposerIntentStore.getState().stage(sessionId, {
        candidateId: candidate.id,
        prompt: promptForAction(action, candidate, localeRef.current, tRef.current),
      })
      if (useChatStore.getState().activeSessionId === sessionId) router.push("/")
      await finishSelectionToolbar(candidate.id)
    }

    const openGeneratedResult = async (payload: SelectionOpenResultPayload) => {
      if (requests.has(payload.requestId) || handledRequests.has(payload.requestId)) return
      const controller = new AbortController()
      const { signal } = controller
      const timeout = setTimeout(() => controller.abort(), SELECTION_REQUEST_TIMEOUT_MS)
      requests.set(payload.requestId, controller)
      handledRequests.add(payload.requestId)
      let ok = false
      try {
        const candidate = await requireCandidate(payload.candidateId, signal)
        const stored = await selectionActionResult(candidate.id, payload.resultRequestId)
        const result = stored?.result
        const text =
          result?.kind === "text" && payload.variantIndex === 0
            ? result.text
            : result?.kind === "variants"
              ? result.variants[payload.variantIndex]
              : undefined
        if (!text) return
        const attribution = stored?.attribution ?? tRef.current("cogniaAttribution")
        const sessionId = useChatStore.getState().activeSessionId ?? (await startNewSession()).id
        await requireCandidate(candidate.id, signal)
        if (!(await showMainWindow({ checked: true }))) return
        signal.throwIfAborted()
        assertOwner()
        const resultCandidateId = `${candidate.id}:result:${payload.requestId}`
        useChatStore.getState().addContextSelection(
          {
            kind: "external",
            candidateId: resultCandidateId,
            title: attribution,
            snapshot: text,
            comment: "",
            sourceApp: attribution,
            sourceTitle: candidate.sourceTitle,
            sourceUrl: candidate.sourceUrl,
            capturedAt: Date.now(),
            origin: candidate.origin,
            truncated: false,
          },
          sessionId
        )
        useComposerIntentStore.getState().stage(sessionId, {
          candidateId: resultCandidateId,
          prompt: null,
        })
        if (useChatStore.getState().activeSessionId === sessionId) router.push("/")
        ok = true
      } finally {
        clearTimeout(timeout)
        requests.delete(payload.requestId)
        if (alive && !signal.aborted) {
          await sendSelectionControl(SELECTION_OPEN_RESULT_ACK_EVENT, {
            requestId: payload.requestId,
            candidateId: payload.candidateId,
            ok,
          }).catch(() => {})
        }
      }
    }

    const consumeStage = async ({ candidateId, action }: SelectionLiveStagePayload) => {
      try {
        const candidate = await requireCandidate(candidateId)
        switch (action.kind) {
          case "remember":
            assertOwner()
            await rememberSelection(candidate)
            return
          case "speak":
            beginSpeaking(candidate)
            return
          default:
            await stageIntoComposer(candidate, action)
        }
      } catch {
        if (alive) await reportResult(candidateId, false).catch(() => {})
      }
    }

    const track = (dispose: () => void | Promise<void>) => {
      if (alive) unlistens.push(dispose)
      else safeUnlisten(dispose)
    }
    void Promise.all([
      listen(SELECTION_CANDIDATE_EVENT, () => {
        if (alive) void publishPluginCatalog().catch(() => {})
      }).then(track),
      listen(SELECTION_ACTION_CATALOG_REQUEST_EVENT, () => {
        if (alive) void publishPluginCatalog().catch(() => {})
      }).then(track),
      listenSelectionControl<SelectionActionRequestPayload>(
        SELECTION_ACTION_REQUEST_EVENT,
        (event) => {
          if (alive) void executePluginAction(event.payload)
        }
      ).then(track),
      listenSelectionControl<{ requestId: string }>(
        SELECTION_ACTION_CANCEL_EVENT,
        ({ payload }) => {
          handledRequests.add(payload.requestId)
          requests.get(payload.requestId)?.abort()
        }
      ).then(track),
      listenSelectionControl<PluginConsentResponse & { actionRequestId: string; promptId: string }>(
        SELECTION_CONSENT_RESPONSE_EVENT,
        ({ payload }) => {
          if (alive && pendingPrompts.get(payload.actionRequestId) === payload.promptId) {
            getPluginConsentBroker().respond(payload.promptId, {
              allow: payload.allow,
              persist: payload.persist,
            })
          }
        }
      ).then(track),
      listenSelectionControl<SelectionOpenResultPayload>(
        SELECTION_OPEN_RESULT_EVENT,
        ({ payload }) => {
          if (alive) void openGeneratedResult(payload).catch(() => {})
        }
      ).then(track),
      listenSelectionControl<SelectionLiveStagePayload>(SELECTION_STAGE_EVENT, ({ payload }) => {
        if (alive && payload?.candidateId) void consumeStage(payload)
      }).then(track),
      listenSelectionControl<{ candidateId: string }>(SELECTION_SPEECH_STOP_EVENT, (event) => {
        if (!alive) return
        const { candidateId } = event.payload
        void loadPort("speech")
          .then((speech) => speech?.readAloud.stopSelection(candidateId))
          .catch(() => {})
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
    ])
      .then(publishPluginCatalog)
      .catch(() => {})
    const unsubscribeAccount = useAccountStore.subscribe((account) => {
      if (
        account.locked ||
        account.accountRevision !== owner.accountRevision ||
        account.unlockedAccountId !== owner.unlockedAccountId
      ) {
        for (const controller of requests.values()) controller.abort()
        stopWatching?.()
        if (catalogCandidateId) void finishSelectionToolbar(catalogCandidateId).catch(() => {})
      }
    })
    const unsubscribeCatalog = subscribeQuickActions(() => {
      if (alive) void publishPluginCatalog().catch(() => {})
    })

    return () => {
      alive = false
      for (const controller of requests.values()) controller.abort()
      stopWatching?.()
      unsubscribeAccount()
      unsubscribeCatalog()
      unlistens.forEach(safeUnlisten)
    }
  }, [accountRevision, router, unlockedAccountId])

  return null
}

export default SelectionToolbarInitializer
