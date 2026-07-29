"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

export const SELECTION_TOOLBAR_LABEL = "selection-toolbar"
export const SELECTION_CANDIDATE_EVENT = "selection://candidate"
export const SELECTION_DISMISS_EVENT = "selection://dismiss"
export const SELECTION_STAGE_EVENT = "selection://stage"
export const SELECTION_SHORTCUT_EVENT = "selection://shortcut"
/**
 * Escape pressed while the toolbar held focus. Only sent when a focus-taking
 * sub-panel is open — otherwise Rust dismisses the toolbar directly.
 */
export const SELECTION_ESCAPE_EVENT = "selection://escape"
/** Main window → toolbar: an `awaits_result` action has settled. */
export const SELECTION_RESULT_EVENT = "selection://result"
/** Main window → toolbar: speech playback ticked or ended. */
export const SELECTION_SPEECH_EVENT = "selection://speech"
/** Toolbar → main window: stop the speech this candidate started. */
export const SELECTION_SPEECH_STOP_EVENT = "selection://speech-stop"
export const SELECTION_TOOLBAR_ENABLED_PREF = "selectionToolbar.enabled"
export const SELECTION_TOOLBAR_DISABLED_APPS_PREF = "selectionToolbar.disabledApps"

export type SelectionOrigin = "accessibility" | "clipboard"

/**
 * Transparent breathing room reserved on every side of the capsule.
 *
 * The native window is `shadow(false)` and the page is `overflow: hidden`, so
 * anything painted outside the window box is simply cut — which is why the old
 * fixed 360x44 window amputated the capsule's `shadow-xl`. The window is now
 * measured as `content + 2 * SELECTION_SHADOW_PAD`, and Rust hit-tests the
 * content rects so this margin does not become a dead zone.
 */
export const SELECTION_SHADOW_PAD = 20

export interface SelectionAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ExternalSelectionCandidate {
  id: string
  text: string
  sourceApp: string
  sourceTitle?: string
  origin: SelectionOrigin
  anchorRect?: SelectionAnchorRect
  capturedAt: number
  truncated: boolean
}

export type SelectionToolbarAction =
  | { kind: "copy" }
  | { kind: "explain" }
  | { kind: "translate"; targetLocale: string }
  | { kind: "ask" }
  | { kind: "remember" }
  | { kind: "speak" }

export interface SelectionStagePayload {
  candidate: ExternalSelectionCandidate
  action: SelectionToolbarAction
  /**
   * Whether handing off should also raise the main window. False for
   * remember/speak: both finish without the user ever looking at the app, and
   * yanking it forward would defeat the point.
   */
  focusMain: boolean
}

/** Why the toolbar is going away — drives whether the exit is animated. */
export type SelectionDismissReason = "interrupted" | "idle" | "completed"

export interface SelectionDismissPayload {
  reason: SelectionDismissReason
}

/** Which side of the selection the toolbar landed on. */
export type SelectionToolbarPlacement = "above" | "below"

export interface SelectionToolbarGeometry {
  placement: SelectionToolbarPlacement
}

export interface SelectionShortcutPayload {
  shortcutId: string
  candidateId: string
}

/** Outcome of a `remember` handoff, reported back by the main window. */
export interface SelectionResultPayload {
  candidateId: string
  ok: boolean
  /** Present when `ok` is false — e.g. `"pii_blocked"`. */
  reason?: string
}

export interface SelectionSpeechPayload {
  candidateId: string
  playing: boolean
  /** 0-1, or undefined when the provider reports no duration. */
  progress?: number
}

export interface SelectionToolbarStatus {
  running: boolean
  hasCandidate: boolean
}

const STOPPED_STATUS: SelectionToolbarStatus = { running: false, hasCandidate: false }

export async function startSelectionToolbar(
  disabledApps: string[] = []
): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_start", {
    args: { disabledApps },
  })
}

export async function stopSelectionToolbar(): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_stop")
}

export async function getSelectionToolbarStatus(): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_status")
}

export async function getCurrentSelectionCandidate(): Promise<ExternalSelectionCandidate | null> {
  if (!isTauri()) return null
  return invoke<ExternalSelectionCandidate | null>("selection_toolbar_current_candidate")
}

export async function captureClipboardSelection(): Promise<ExternalSelectionCandidate | null> {
  if (!isTauri()) return null
  return invoke<ExternalSelectionCandidate | null>("selection_toolbar_capture_clipboard")
}

export async function takePendingSelectionStage(): Promise<SelectionStagePayload | null> {
  if (!isTauri()) return null
  return invoke<SelectionStagePayload | null>("selection_toolbar_take_pending_stage")
}

export async function executeSelectionToolbarAction(
  candidateId: string,
  action: SelectionToolbarAction
): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_execute", { candidateId, action })
}

export async function revealSelectionToolbar(): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_reveal")
}

export async function setSelectionToolbarInteractive(interactive: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_set_interactive", { interactive })
}

/**
 * Size the native window to the measured content and re-anchor it.
 *
 * `width`/`height` are the whole window box (content + `SELECTION_SHADOW_PAD`
 * on each side) and `hitRects` are the opaque rects inside it — the capsule,
 * plus the language list while it is open. Rust hit-tests against those, so the
 * padding is not a dead zone *and* a click in the open list is not mistaken for
 * a click away. Returns the placement actually used, which can flip to `below`
 * once the real height is known.
 */
export async function resizeSelectionToolbar(
  width: number,
  height: number,
  hitRects: SelectionAnchorRect[]
): Promise<SelectionToolbarGeometry> {
  if (!isTauri()) return { placement: "above" }
  return invoke<SelectionToolbarGeometry>("selection_toolbar_resize", {
    width,
    height,
    hitRects,
  })
}

/** Freeze (or resume) the idle countdown — pointer hover, pending, speaking. */
export async function setSelectionToolbarKeepAlive(keepAlive: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_set_keep_alive", { keepAlive })
}

/** Report that a remember/speak action has settled, releasing the toolbar. */
export async function finishSelectionToolbar(candidateId: string): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_finish", { candidateId })
}

/**
 * Current chord for every bound shortcut, as `id → chord`.
 *
 * Read straight from Rust rather than through `useShortcutStore`: the toolbar
 * renders in an overlay window that deliberately mounts only the minimal shell
 * (`components/pet/pet-window-shell.tsx`), so the app-wide stores are not
 * hydrated there. The capsule shows whatever the user has actually bound, which
 * is why this is a live read and not the hard-coded defaults.
 */
export async function listShortcutChords(): Promise<Record<string, string>> {
  if (!isTauri()) return {}
  const bindings = await invoke<Array<{ id: string; chord: string }>>("shortcut_list")
  return Object.fromEntries(bindings.map((binding) => [binding.id, binding.chord]))
}
