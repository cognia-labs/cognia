"use client"

/**
 * Root of the selection-toolbar overlay window.
 *
 * Owns the candidate subscription, the IPC, and the phase machine the capsule
 * renders. Six actions collapse into three feedback shapes:
 *
 *   copy                      → run in Rust, show ✓, leave
 *   explain / translate / ask → hand to the main window, which comes forward;
 *                               leave immediately, the user is looking there
 *   remember / speak          → hand over *without* stealing focus and stay
 *                               put, waiting for a result or driving a player
 *
 * The third shape is why the toolbar can be held open at all: the memory PII
 * gate returns `{ok:false}` rather than throwing, so dismissing optimistically
 * would make a blocked write vanish silently whenever the main window sits in
 * the tray.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, useReducedMotion } from "motion/react"
import { emitTo, listen } from "@tauri-apps/api/event"
import { useLocale, useTranslations } from "next-intl"
import { MoreHorizontalIcon, PuzzleIcon, WandSparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"
import { getPref, setPref } from "@/lib/tauri/store"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { isTauri } from "@/lib/tauri"
import { isMacPlatform } from "@/lib/tauri/os"
import {
  executeSelectionToolbarAction,
  copySelectionActionResult,
  replaceCurrentSelection,
  undoSelectionReplacement,
  finishSelectionToolbar,
  getCurrentSelectionCandidate,
  listShortcutChords,
  revealSelectionToolbar,
  selectionActionResult,
  listenSelectionControl,
  sendSelectionControl,
  SELECTION_CANDIDATE_EVENT,
  SELECTION_DISMISS_EVENT,
  SELECTION_ESCAPE_EVENT,
  SELECTION_RESULT_EVENT,
  SELECTION_ACTION_CATALOG_EVENT,
  SELECTION_ACTION_CATALOG_REQUEST_EVENT,
  SELECTION_ACTION_CANCEL_EVENT,
  SELECTION_CONSENT_EVENT,
  SELECTION_CONSENT_RESPONSE_EVENT,
  SELECTION_OPEN_RESULT_ACK_EVENT,
  SELECTION_REQUEST_TIMEOUT_MS,
  type SelectionConsentPayload,
  SELECTION_ACTION_REQUEST_EVENT,
  SELECTION_ACTION_RESULT_EVENT,
  SELECTION_ACTION_LAYOUT_PREF,
  SELECTION_OPEN_RESULT_EVENT,
  SELECTION_SHADOW_PAD,
  SELECTION_SHORTCUT_EVENT,
  SELECTION_SPEECH_EVENT,
  SELECTION_SPEECH_STOP_EVENT,
  setSelectionToolbarInteractive,
  setSelectionToolbarKeepAlive,
  type ExternalSelectionCandidate,
  type SelectionResultPayload,
  type SelectionActionCatalogPayload,
  type SelectionActionExecutionPayload,
  type SelectionShortcutPayload,
  type SelectionSpeechPayload,
  type SelectionToolbarAction,
} from "@/lib/tauri/selection-toolbar"
import { classifySelection, type SelectionClassification } from "@/lib/selection/classify-selection"
import {
  defaultSearchEngine,
  isSearchEngineId,
  SELECTION_SEARCH_ENGINE_PREF,
} from "@/lib/selection/search-engines"
import {
  findAction,
  findActionByShortcutId,
  isActionSuppressed,
  initialTargetLocale,
  resolveVisibleActions,
  selectionIsSecure,
  SELECTION_CONTEXTUAL_ACTIONS_PREF,
  SELECTION_TRANSLATE_LOCALE_PREF,
  TARGET_LOCALES,
  type SelectionActionId,
  type TargetLocale,
} from "./selection-toolbar-actions"
import { SelectionToolbarCapsule, type SelectionToolbarPhase } from "./selection-toolbar-capsule"
import { SelectionResultPanel, SelectionResultPanelShell } from "./selection-result-panel"
import { useSelectionToolbarGeometry } from "./use-selection-toolbar-geometry"
import {
  normalizeSelectionActionLayout,
  type SelectionActionLayout,
} from "@/lib/selection/preferences"
import {
  resolveSelectionActionSlots,
  type SelectionHostActionDescriptor,
} from "@/lib/selection/action-layout"

/** How long a ✓ stays up before the toolbar leaves. */
const SUCCESS_DWELL_MS = 420
/** How long an error stays up. Longer — it has to be read, not just noticed. */
const ERROR_DWELL_MS = 6_000

const MAIN_WINDOW_LABEL = "main"

/**
 * Build the wire action for a button press.
 *
 * The contextual actions carry a payload the classifier already computed, so
 * Rust does not have to re-derive "which part of this text was the link".
 * Returns `null` when the classification that made a button visible is somehow
 * absent by the time it is pressed — better to do nothing than to guess a URL.
 */
function toAction(
  id: SelectionActionId,
  targetLocale: TargetLocale,
  classification: SelectionClassification,
  searchEngine: string
): SelectionToolbarAction | null {
  switch (id) {
    case "translate":
      return { kind: "translate", targetLocale }
    case "openLink":
      return classification.url ? { kind: "openLink", url: classification.url } : null
    case "composeEmail":
      return classification.email ? { kind: "composeEmail", address: classification.email } : null
    case "searchWeb":
      return { kind: "searchWeb", engine: searchEngine }
    default:
      return { kind: id }
  }
}

export function SelectionToolbarView() {
  const t = useTranslations("selectionToolbar")
  const tConsent = useTranslations("plugins.consent")
  const locale = useLocale()
  const reduceMotion = useReducedMotion() ?? false

  const [candidate, setCandidate] = useState<ExternalSelectionCandidate | null>(null)
  const [phase, setPhase] = useState<SelectionToolbarPhase>({ kind: "idle" })
  const [hovered, setHovered] = useState<string | null>(null)
  const [localeOpen, setLocaleOpen] = useState(false)
  const [chords, setChords] = useState<Record<string, string>>({})
  const [targetLocale, setTargetLocale] = useState<TargetLocale>(() => initialTargetLocale(locale))
  const [contextualEnabled, setContextualEnabled] = useState(true)
  const [searchEngine, setSearchEngine] = useState(() => defaultSearchEngine(locale))
  const [pluginActions, setPluginActions] = useState<SelectionHostActionDescriptor[]>([])
  const [actionLayout, setActionLayout] = useState<SelectionActionLayout>({
    ordered: [],
    hidden: [],
    pinned: [],
  })
  const [moreOpen, setMoreOpen] = useState(false)
  const [submenuActionId, setSubmenuActionId] = useState<string | null>(null)
  const [execution, setExecution] = useState<SelectionActionExecutionPayload | null>(null)
  const [undoAvailable, setUndoAvailable] = useState(false)
  const [replaceUnavailableReason, setReplaceUnavailableReason] = useState<string | undefined>()
  const [resultError, setResultError] = useState<string | undefined>()
  const pendingRequestRef = useRef<string | null>(null)
  const candidateIdRef = useRef<string | null>(null)
  const [consent, setConsent] = useState<SelectionConsentPayload | null>(null)
  const [shortcut, setShortcut] = useState<SelectionShortcutPayload | null>(null)
  const [catalogId, setCatalogId] = useState<string | null>(null)
  const [preferencesId, setPreferencesId] = useState<string | null>(null)
  const [listenersId, setListenersId] = useState<string | null>(null)
  const responseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRequest = useRef<string | null>(null)

  const clearResponseTimer = useCallback(() => {
    if (responseTimer.current) clearTimeout(responseTimer.current)
    responseTimer.current = null
  }, [])

  const cancelPending = useCallback(
    (preserveOpen = false) => {
      const requestId = pendingRequestRef.current ?? (preserveOpen ? null : openRequest.current)
      pendingRequestRef.current = null
      if (!preserveOpen) openRequest.current = null
      if (!openRequest.current) clearResponseTimer()
      if (requestId) {
        void sendSelectionControl(SELECTION_ACTION_CANCEL_EVENT, { requestId }).catch(() => {})
      }
    },
    [clearResponseTimer]
  )
  const isMac = useMemo(() => isMacPlatform(), [])

  // Pure and synchronous, so the buttons a selection deserves are known on the
  // same render the candidate arrives — there is never a frame where the
  // capsule shows the wrong set.
  const classification = useMemo(
    () => classifySelection(candidate?.text ?? "", { uiLocale: locale }),
    [candidate?.text, locale]
  )
  const builtInActions = useMemo(
    () =>
      resolveVisibleActions({
        types: classification.types,
        candidate: {
          origin: candidate?.origin,
          sourceSubrole: candidate?.sourceSubrole,
        },
        contextualEnabled,
      }),
    [classification.types, candidate?.origin, candidate?.sourceSubrole, contextualEnabled]
  )

  const secure = selectionIsSecure({ sourceSubrole: candidate?.sourceSubrole })

  const { visibleActions, overflowActions } = useMemo(() => {
    // `resolveVisibleActions` already withholds every built-in from a password
    // field, but the slot resolver merges plugin ids in beside them, so
    // withholding the built-ins alone would leave a capsule made entirely of
    // third-party buttons over a password. The rule belongs to the candidate,
    // not to the built-in table.
    if (secure) return { visibleActions: [], overflowActions: [] }
    const slots = resolveSelectionActionSlots({
      builtInIds: builtInActions.map((action) => action.id),
      pluginActions,
      layout: actionLayout,
    })
    const pluginById = new Map(pluginActions.map((action) => [action.id, action]))
    const toDescriptor = (id: string) => {
      const builtIn = findAction(id)
      if (builtIn) return builtIn
      const plugin = pluginById.get(id)
      if (!plugin) return undefined
      return {
        id: plugin.id,
        // The manifest's own icon, through the same catalog the plugin
        // validator admits names against, so what a manifest may declare is
        // what actually draws. The two fallbacks stay meaningful: a wand for
        // the host's own extras, a puzzle piece for third-party ones.
        icon:
          resolveLucideIcon(plugin.icon) ??
          (plugin.source === "cognia" ? WandSparklesIcon : PuzzleIcon),
        label: plugin.title,
        mode: "await" as const,
        priority: 50,
        pluginActionId: plugin.id,
        children: plugin.children,
        attribution: plugin.attribution,
        accelerator: plugin.accelerator,
      }
    }
    let primaryIds = [...slots.primaryIds]
    const moreIds = [...slots.overflowIds]
    if (moreIds.length > 0) {
      const removable =
        [...primaryIds]
          .reverse()
          .find(
            (id) => id !== "copy" && !actionLayout.pinned.includes(id) && !findAction(id)?.requires
          ) ??
        [...primaryIds].reverse().find((id) => id !== "copy" && !actionLayout.pinned.includes(id))
      const evicted = removable ?? primaryIds[primaryIds.length - 1]
      if (evicted) {
        primaryIds = primaryIds.filter((id) => id !== evicted)
        moreIds.unshift(evicted)
      }
      primaryIds.push("__more")
    }
    const moreDescriptor = {
      id: "__more",
      icon: MoreHorizontalIcon,
      label: t("more"),
      mode: "local" as const,
      priority: 101,
      isMore: true,
    }
    return {
      visibleActions: primaryIds
        .map((id) => (id === "__more" ? moreDescriptor : toDescriptor(id)))
        .filter((action): action is NonNullable<typeof action> => Boolean(action)),
      overflowActions: moreIds
        .map(toDescriptor)
        .filter((action): action is NonNullable<typeof action> => Boolean(action)),
    }
  }, [actionLayout, builtInActions, pluginActions, secure, t])

  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearDwell = useCallback(() => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current)
      dwellRef.current = null
    }
  }, [])

  // Any layout-affecting input. `useSelectionToolbarGeometry` re-measures on
  // every change and pushes the result to Rust.
  const contentKey = [
    candidate?.id ?? "none",
    consent?.promptId ?? "",
    // The row itself. The plugin catalog arrives asynchronously and can add a
    // More button and evict an action, and the panels are sized from the same
    // measurement — leaving this out left a window measured for the row the
    // capsule had a moment ago, with `overflow: hidden` cropping the rest.
    visibleActions.map((action) => action.id).join(","),
    overflowActions.length,
    submenuActionId ?? "",
    phase.kind,
    phase.kind === "pending" ||
    phase.kind === "ok" ||
    phase.kind === "error" ||
    phase.kind === "status"
      ? phase.action
      : "",
    phase.kind === "speaking" && phase.progress !== undefined ? "p" : "",
    hovered ?? "",
    localeOpen ? "menu" : "",
    moreOpen ? "more" : "",
    execution?.requestId ?? "",
    // The result sheet grows a row for each of these.
    undoAvailable ? "undo" : "",
    replaceUnavailableReason ?? "",
    resultError ?? "",
    targetLocale,
    candidate?.truncated ? "trunc" : "",
    Object.keys(chords).length,
  ].join("|")
  const geometry = useSelectionToolbarGeometry(candidate?.id ?? null, contentKey)

  useEffect(() => {
    if (!isTauri()) return
    document.documentElement.setAttribute("data-selection-toolbar", "true")
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    const track = (unlisten: () => void) => {
      if (alive) unlistens.push(unlisten)
      else safeUnlisten(unlisten)
    }

    let preferenceRead = 0
    let currentRead = Promise.resolve()
    let dismissRevision = 0
    const refreshPreferences = (id: string) => {
      const read = ++preferenceRead
      void Promise.all([
        listShortcutChords().catch(() => ({})),
        getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF).catch(() => undefined),
        getPref<boolean>(SELECTION_CONTEXTUAL_ACTIONS_PREF).catch(() => false),
        getPref<string>(SELECTION_SEARCH_ENGINE_PREF).catch(() => undefined),
        getPref<SelectionActionLayout>(SELECTION_ACTION_LAYOUT_PREF).catch(() => undefined),
      ]).then(([bound, target, contextual, engine, layout]) => {
        if (!alive || read !== preferenceRead || candidateIdRef.current !== id) return
        setChords(bound)
        setTargetLocale(
          TARGET_LOCALES.includes(target as TargetLocale)
            ? (target as TargetLocale)
            : initialTargetLocale(locale)
        )
        setContextualEnabled(contextual !== false)
        setSearchEngine(isSearchEngineId(engine) ? engine : defaultSearchEngine(locale))
        setActionLayout(normalizeSelectionActionLayout(layout))
        setPreferencesId(id)
      })
    }

    const syncCurrent = () => {
      const revision = dismissRevision
      currentRead = currentRead
        .then(async () => {
          if (!alive || revision !== dismissRevision) return
          const current = await getCurrentSelectionCandidate()
          if (!alive || revision !== dismissRevision || !current) return
          if (candidateIdRef.current !== current.id) {
            clearDwell()
            cancelPending()
            setConsent(null)
            setPluginActions([])
            setCatalogId(null)
            candidateIdRef.current = current.id
            refreshPreferences(current.id)
            setCandidate(current)
            setPhase({ kind: "idle" })
            setHovered(null)
            setLocaleOpen(false)
            setMoreOpen(false)
            setSubmenuActionId(null)
            setExecution(null)
            setUndoAvailable(false)
            setReplaceUnavailableReason(undefined)
            setResultError(undefined)
          }
          if (current.activationShortcut) {
            setShortcut({ candidateId: current.id, shortcutId: current.activationShortcut })
          }
          await emitTo(MAIN_WINDOW_LABEL, SELECTION_ACTION_CATALOG_REQUEST_EVENT, null)
        })
        .catch(() => {})
    }

    void Promise.all([
      listenSelectionControl<SelectionShortcutPayload>(SELECTION_SHORTCUT_EVENT, ({ payload }) => {
        if (alive) setShortcut(payload)
      }).then(track),
      listenSelectionControl<SelectionConsentPayload>(SELECTION_CONSENT_EVENT, ({ payload }) => {
        if (
          alive &&
          candidateIdRef.current === payload.candidateId &&
          pendingRequestRef.current === payload.actionRequestId
        )
          setConsent(payload)
      }).then(track),
      listen(SELECTION_CANDIDATE_EVENT, syncCurrent).then(track),
      listenSelectionControl<SelectionActionCatalogPayload>(
        SELECTION_ACTION_CATALOG_EVENT,
        (event) => {
          if (alive && candidateIdRef.current === event.payload.candidateId) {
            setPluginActions(event.payload.actions)
            setCatalogId(event.payload.candidateId)
          }
        }
      ).then(track),
      listen(SELECTION_ESCAPE_EVENT, () => {
        // Rust only routes Escape here while a sub-panel owns focus; closing it
        // hands Escape back, so a second press dismisses the toolbar.
        if (!alive) return
        setLocaleOpen(false)
        setMoreOpen(false)
        if (pendingRequestRef.current) {
          cancelPending()
          setConsent(null)
          setPhase({ kind: "idle" })
        }
      }).then(track),
      listen(SELECTION_DISMISS_EVENT, () => {
        if (!alive) return
        dismissRevision += 1
        clearDwell()
        cancelPending(true)
        setConsent(null)
        setShortcut(null)
        setCatalogId(null)
        candidateIdRef.current = null
        // Unmounting drives the AnimatePresence exit; Rust holds the native
        // hide back by EXIT_ANIMATION_MS for idle/completed dismissals so the
        // animation is actually on screen.
        setCandidate(null)
        setPhase({ kind: "idle" })
        setHovered(null)
        setLocaleOpen(false)
        setMoreOpen(false)
        setSubmenuActionId(null)
        setExecution(null)
        setPluginActions([])
        setUndoAvailable(false)
        setResultError(undefined)
      }).then(track),
    ])
      .then(syncCurrent)
      .catch(() => {})

    return () => {
      alive = false
      cancelPending()
      document.documentElement.removeAttribute("data-selection-toolbar")
      unlistens.forEach(safeUnlisten)
    }
  }, [cancelPending, clearDwell, locale])

  // Reveal only once the window has been sized to its content. Replaces a
  // double-rAF guess, and on Windows the resize doubles as the recomposite
  // nudge a `transparent(true)` window needs to avoid painting black
  // (see `lib/tauri/overlay-reveal.ts` for the same quirk on the pet windows).
  const measured = geometry.measured
  useEffect(() => {
    if (!candidate || !measured || preferencesId !== candidate.id || listenersId !== candidate.id)
      return
    void revealSelectionToolbar(candidate.id).catch((error: unknown) => {
      if (candidateIdRef.current === candidate.id) {
        console.warn("selection toolbar reveal failed", error)
      }
    })
  }, [candidate, listenersId, measured, preferencesId])

  // Freeze the idle countdown whenever the user is engaged with the toolbar or
  // something is still in flight.
  const busy = phase.kind !== "idle" || execution !== null
  useEffect(() => {
    if (!candidate) return
    void setSelectionToolbarKeepAlive(hovered !== null || localeOpen || moreOpen || busy).catch(
      () => {}
    )
  }, [candidate, hovered, localeOpen, moreOpen, busy])

  useEffect(() => {
    if (!candidate) return
    void setSelectionToolbarInteractive(localeOpen || moreOpen || consent !== null).catch(() => {})
  }, [candidate, consent, localeOpen, moreOpen])

  const finish = useCallback((candidateId: string) => {
    void finishSelectionToolbar(candidateId).catch(() => {})
  }, [])

  const failAction = useCallback(
    (candidateId: string, action: string) => {
      if (candidateIdRef.current !== candidateId) return
      cancelPending()
      setConsent(null)
      clearDwell()
      setPhase({ kind: "error", action, reason: t("errors.generic") })
      dwellRef.current = setTimeout(() => setPhase({ kind: "idle" }), ERROR_DWELL_MS)
    },
    [cancelPending, clearDwell, t]
  )

  const runAction = useCallback(
    (id: string, target = targetLocale) => {
      if (
        !candidate ||
        preferencesId !== candidate.id ||
        listenersId !== candidate.id ||
        phase.kind === "pending" ||
        responseTimer.current !== null
      )
        return
      if (id === "__more") {
        setLocaleOpen(false)
        setSubmenuActionId(null)
        setMoreOpen((open) => !open)
        return
      }
      const plugin = pluginActions.find(
        (action) => action.id === id || action.children?.some((child) => child.id === id)
      )
      if (plugin) {
        if (plugin.id === id && plugin.children?.length) {
          setLocaleOpen(false)
          setSubmenuActionId(id)
          setMoreOpen(true)
          return
        }
        const requestId = globalThis.crypto.randomUUID()
        pendingRequestRef.current = requestId
        setMoreOpen(false)
        setLocaleOpen(false)
        setExecution(null)
        setPhase({ kind: "pending", action: id })
        responseTimer.current = setTimeout(
          () => failAction(candidate.id, id),
          SELECTION_REQUEST_TIMEOUT_MS
        )
        void sendSelectionControl(SELECTION_ACTION_REQUEST_EVENT, {
          requestId,
          candidateId: candidate.id,
          actionId: id,
        }).catch(() => failAction(candidate.id, id))
        return
      }
      const descriptor = findAction(id)
      if (
        !descriptor ||
        isActionSuppressed(descriptor, candidate) ||
        (descriptor.requires &&
          (!contextualEnabled || !classification.types.includes(descriptor.requires)))
      )
        return
      const action = toAction(id as SelectionActionId, target, classification, searchEngine)
      // The classification that made a contextual button visible has gone
      // missing. Doing nothing beats guessing a URL to open.
      if (!action) return
      setLocaleOpen(false)
      clearDwell()

      setPhase({ kind: "pending", action: id })
      responseTimer.current = setTimeout(
        () => failAction(candidate.id, id),
        SELECTION_REQUEST_TIMEOUT_MS
      )
      void executeSelectionToolbarAction(candidate.id, action)
        .then(() => {
          if (candidateIdRef.current !== candidate.id || !responseTimer.current) return
          if (descriptor.mode === "local") {
            clearResponseTimer()
            setPhase({ kind: "ok", action: id })
            dwellRef.current = setTimeout(() => finish(candidate.id), SUCCESS_DWELL_MS)
          }
        })
        .catch(() => failAction(candidate.id, id))
    },
    [
      candidate,
      pluginActions,
      phase.kind,
      preferencesId,
      listenersId,
      targetLocale,
      classification,
      contextualEnabled,
      searchEngine,
      clearDwell,
      clearResponseTimer,
      failAction,
      finish,
    ]
  )

  const canReplaceCandidate = Boolean(
    candidate &&
    candidate.origin === "accessibility" &&
    candidate.editable &&
    candidate.replaceCapability === "paste" &&
    !candidate.truncated
  )

  const replaceResult = useCallback(
    async (text: string) => {
      if (!candidate) return
      setResultError(undefined)
      try {
        const result = await replaceCurrentSelection(candidate.id, text)
        if (result.replaced) {
          setUndoAvailable(Boolean(result.undoExpiresAt))
          setReplaceUnavailableReason(undefined)
          return
        }
        setReplaceUnavailableReason(
          result.reason === "stale" || result.reason === "selectionChanged"
            ? "replaceUnavailable.stale"
            : result.reason === "rolloutDisabled"
              ? // Not a property of the field. Saying "not editable" here sent
                // the user to check a text field that was fine.
                "replaceUnavailable.rolloutDisabled"
              : "replaceUnavailable.notEditable"
        )
      } catch {
        setResultError(t("errors.generic"))
      }
    },
    [candidate, t]
  )

  const copyGeneratedResult = useCallback(
    (text: string) => {
      if (!candidate) return
      setResultError(undefined)
      void copySelectionActionResult(candidate.id, text).catch(() => {
        setResultError(t("errors.generic"))
      })
    },
    [candidate, t]
  )

  const openGeneratedResult = useCallback(
    (text: string) => {
      if (!candidate || !execution || openRequest.current) return
      const requestId = globalThis.crypto.randomUUID()
      openRequest.current = requestId
      setResultError(undefined)
      const failed = () => {
        if (openRequest.current !== requestId) return
        cancelPending()
        if (candidateIdRef.current === candidate.id) setResultError(t("errors.generic"))
      }
      responseTimer.current = setTimeout(failed, SELECTION_REQUEST_TIMEOUT_MS)
      void sendSelectionControl(SELECTION_OPEN_RESULT_EVENT, {
        requestId,
        candidateId: candidate.id,
        resultRequestId: execution.requestId,
        variantIndex:
          execution.result?.kind === "variants" ? execution.result.variants.indexOf(text) : 0,
      }).catch(failed)
    },
    [cancelPending, candidate, execution, t]
  )

  const undoReplacement = useCallback(() => {
    if (!candidate) return
    void undoSelectionReplacement(candidate.id)
      .then((undone) => {
        if (undone) setUndoAvailable(false)
        else setResultError(t("errors.generic"))
      })
      .catch(() => setResultError(t("errors.generic")))
  }, [candidate, t])

  // Results and playback state arrive from the main window, which owns the
  // memory writer and the single `ttsOrchestrator` shared with chat and the pet.
  useEffect(() => {
    if (!isTauri() || !candidate) return
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    const track = (unlisten: () => void) => {
      if (alive) unlistens.push(unlisten)
      else safeUnlisten(unlisten)
    }

    void Promise.all([
      listenSelectionControl<SelectionResultPayload>(SELECTION_RESULT_EVENT, (event) => {
        if (!alive || event.payload.candidateId !== candidate.id) return
        clearResponseTimer()
        clearDwell()
        if (event.payload.ok) {
          setPhase({ kind: "ok", action: "remember" })
          dwellRef.current = setTimeout(() => finish(candidate.id), SUCCESS_DWELL_MS)
          return
        }
        const reason =
          event.payload.reason === "pii_blocked" ? t("errors.piiBlocked") : t("errors.generic")
        setPhase({ kind: "error", action: "remember", reason })
        dwellRef.current = setTimeout(() => finish(candidate.id), ERROR_DWELL_MS)
      }).then(track),
      listenSelectionControl<SelectionActionExecutionPayload & { stored?: boolean }>(
        SELECTION_ACTION_RESULT_EVENT,
        async ({ payload }) => {
          if (
            !alive ||
            payload.candidateId !== candidate.id ||
            payload.requestId !== pendingRequestRef.current
          ) {
            return
          }
          if (payload.stored) {
            const stored = await selectionActionResult(
              payload.candidateId,
              payload.requestId
            ).catch(() => null)
            if (
              !alive ||
              payload.requestId !== pendingRequestRef.current ||
              candidateIdRef.current !== candidate.id
            )
              return
            if (!stored) {
              failAction(candidate.id, payload.actionId)
              return
            }
            payload = stored
          }
          pendingRequestRef.current = null
          if (!payload.ok || payload.output !== "copy" || payload.result?.kind !== "text") {
            clearResponseTimer()
          }
          setConsent(null)
          clearDwell()
          if (!payload.ok) {
            setPhase({ kind: "error", action: payload.actionId, reason: t("errors.generic") })
            dwellRef.current = setTimeout(() => setPhase({ kind: "idle" }), ERROR_DWELL_MS)
            return
          }
          const result = payload.result
          if (!result || result.kind === "status") {
            if (result?.kind === "status" && result.message) {
              setPhase({ kind: "status", action: payload.actionId, message: result.message })
              dwellRef.current = setTimeout(() => setPhase({ kind: "idle" }), ERROR_DWELL_MS)
              return
            }
            setPhase({ kind: "ok", action: payload.actionId })
            dwellRef.current = setTimeout(() => setPhase({ kind: "idle" }), SUCCESS_DWELL_MS)
            return
          }
          if (payload.output === "copy" && result.kind === "text") {
            void copySelectionActionResult(candidate.id, result.text)
              .then(() => {
                if (!alive || !responseTimer.current || candidateIdRef.current !== candidate.id)
                  return
                clearResponseTimer()
                setPhase({ kind: "ok", action: payload.actionId })
                dwellRef.current = setTimeout(() => setPhase({ kind: "idle" }), SUCCESS_DWELL_MS)
              })
              .catch(() => failAction(candidate.id, payload.actionId))
            return
          }
          setPhase({ kind: "idle" })
          setExecution(payload)
          setReplaceUnavailableReason(
            candidate.origin === "ocr"
              ? "replaceUnavailable.ocr"
              : candidate.origin === "clipboard"
                ? "replaceUnavailable.clipboard"
                : canReplaceCandidate
                  ? undefined
                  : candidate.editable
                    ? "replaceUnavailable.rolloutDisabled"
                    : "replaceUnavailable.notEditable"
          )
          if (
            payload.directReplaceAllowed &&
            payload.output === "replace" &&
            result.kind === "text" &&
            canReplaceCandidate
          ) {
            void replaceResult(result.text)
          }
        }
      ).then(track),
      listenSelectionControl<SelectionSpeechPayload>(SELECTION_SPEECH_EVENT, (event) => {
        if (!alive || event.payload.candidateId !== candidate.id) return
        clearResponseTimer()
        if (event.payload.playing) {
          setPhase({ kind: "speaking", progress: event.payload.progress })
          return
        }
        clearDwell()
        finish(candidate.id)
      }).then(track),
      listenSelectionControl<SelectionResultPayload & { requestId: string }>(
        SELECTION_OPEN_RESULT_ACK_EVENT,
        ({ payload }) => {
          if (
            !alive ||
            payload.candidateId !== candidate.id ||
            payload.requestId !== openRequest.current
          )
            return
          openRequest.current = null
          clearResponseTimer()
          if (payload.ok) {
            setExecution(null)
            finish(candidate.id)
          } else {
            setResultError(t("errors.generic"))
          }
        }
      ).then(track),
    ])
      .then(() => {
        if (alive) setListenersId(candidate.id)
      })
      .catch(() => {})

    return () => {
      alive = false
      unlistens.forEach(safeUnlisten)
    }
  }, [
    candidate,
    canReplaceCandidate,
    clearDwell,
    clearResponseTimer,
    failAction,
    finish,
    replaceResult,
    t,
  ])

  useEffect(() => {
    if (
      !candidate ||
      !shortcut ||
      shortcut.candidateId !== candidate.id ||
      preferencesId !== candidate.id ||
      listenersId !== candidate.id
    )
      return
    const configured = shortcut.shortcutId.startsWith("selection.action:")
    const id = configured
      ? shortcut.shortcutId.slice("selection.action:".length)
      : findActionByShortcutId(shortcut.shortcutId)?.id
    if (id && !findAction(id) && catalogId !== candidate.id) return
    let active = true
    queueMicrotask(() => {
      if (!active || candidateIdRef.current !== candidate.id) return
      setShortcut((current) => (current === shortcut ? null : current))
      if (id) runAction(id)
    })
    return () => {
      active = false
    }
  }, [candidate, catalogId, listenersId, preferencesId, runAction, shortcut])

  useEffect(() => clearDwell, [clearDwell])

  const chooseTarget = useCallback(
    (next: TargetLocale) => {
      setTargetLocale(next)
      setLocaleOpen(false)
      void setPref(SELECTION_TRANSLATE_LOCALE_PREF, next).catch(() => {})
      runAction("translate", next)
    },
    [runAction]
  )

  const stopSpeech = useCallback(() => {
    if (!candidate) return
    void sendSelectionControl(SELECTION_SPEECH_STOP_EVENT, {
      candidateId: candidate.id,
    }).catch(() => failAction(candidate.id, "speak"))
  }, [candidate, failAction])

  const answerConsent = (allow: boolean, persist: boolean) => {
    if (!consent) return
    setConsent(null)
    void sendSelectionControl(SELECTION_CONSENT_RESPONSE_EVENT, {
      actionRequestId: consent.actionRequestId,
      promptId: consent.promptId,
      allow,
      persist,
    }).catch(() => failAction(consent.candidateId, "__more"))
  }

  const generatedResult =
    execution?.result?.kind === "text" || execution?.result?.kind === "variants"
      ? execution.result
      : null

  return (
    <div
      className={cn(
        "flex h-screen w-screen select-none justify-center",
        // Rust pins the window edge nearest the selection: placing above fixes
        // the window's BOTTOM (`y = anchor.y - height - margin`), placing below
        // fixes its TOP. Anchoring the content to that same edge is what keeps
        // the capsule still while the window grows for the language panel —
        // the old code grew from a re-anchored top edge and teleported it.
        geometry.placement === "above" ? "items-end" : "items-start"
      )}
      style={{ padding: SELECTION_SHADOW_PAD }}
      data-testid="selection-toolbar"
      title={
        candidate
          ? candidate.sourceTitle
            ? `${candidate.sourceApp} · ${candidate.sourceTitle}`
            : candidate.sourceApp
          : undefined
      }
    >
      <AnimatePresence onExitComplete={geometry.remeasure}>
        {/*
          No row means no toolbar. A password field withholds every action, and
          an empty pill floating over the field would be a promise of something
          to click that is not there.
        */}
        {candidate && (generatedResult || visibleActions.length > 0) ? (
          consent ? (
            <SelectionResultPanelShell geometry={geometry}>
              <section
                role="alertdialog"
                aria-label={tConsent("ariaLabel")}
                className="pointer-events-auto w-80 space-y-3 rounded-lg border bg-popover p-3 text-popover-foreground"
              >
                <p className="text-sm">{consent.reason}</p>
                <p className="text-xs text-muted-foreground">{consent.pluginId}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => answerConsent(false, false)}>
                    {tConsent("actions.reject")}
                  </Button>
                  <Button size="sm" onClick={() => answerConsent(true, false)}>
                    {tConsent("actions.allowOnce")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => answerConsent(true, true)}>
                    {tConsent("actions.allowSession")}
                  </Button>
                </div>
              </section>
            </SelectionResultPanelShell>
          ) : generatedResult ? (
            <SelectionResultPanelShell geometry={geometry}>
              <SelectionResultPanel
                candidate={candidate}
                result={generatedResult}
                attribution={execution?.attribution ?? t("cogniaAttribution")}
                canReplace={execution?.output === "replace" && canReplaceCandidate}
                replaceUnavailableReason={replaceUnavailableReason}
                undoAvailable={undoAvailable}
                errorMessage={resultError}
                onCopy={copyGeneratedResult}
                onOpen={openGeneratedResult}
                onReplace={(text) => void replaceResult(text)}
                onCancel={() => {
                  cancelPending()
                  setExecution(null)
                  setUndoAvailable(false)
                  setResultError(undefined)
                }}
                onUndo={undoReplacement}
              />
            </SelectionResultPanelShell>
          ) : (
            <SelectionToolbarCapsule
              geometry={geometry}
              actions={visibleActions}
              overflowActions={
                submenuActionId
                  ? [
                      ...visibleActions.filter((action) => action.id === submenuActionId),
                      ...overflowActions.filter((action) => action.id !== submenuActionId),
                    ]
                  : overflowActions
              }
              overflowInitialParentId={submenuActionId ?? undefined}
              moreOpen={moreOpen}
              onMoreOpenChange={(open) => {
                setMoreOpen(open)
                if (!open) setSubmenuActionId(null)
                if (open) setLocaleOpen(false)
              }}
              phase={phase}
              hovered={hovered}
              onHoverChange={setHovered}
              onAction={runAction}
              onStopSpeech={stopSpeech}
              chords={chords}
              isMac={isMac}
              targetLocale={targetLocale}
              localeOpen={localeOpen}
              onLocaleOpenChange={(open) => {
                setLocaleOpen(open)
                if (open) setMoreOpen(false)
              }}
              onLocaleSelect={chooseTarget}
              truncated={candidate.truncated}
              reduceMotion={reduceMotion}
            />
          )
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default SelectionToolbarView
