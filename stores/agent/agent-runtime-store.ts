"use client"

/**
 * Agent runtime selector, which picks the engine that drives the next chat turn.
 *
 * The choice is one `AgentRuntimeRef` (see `lib/ai/agent/runtime-catalog`):
 * Cognia's own runtime in the bundled sidecar, a locally configured external
 * agent process (Codex, Claude Code CLI, Gemini CLI, Cursor, custom), or a
 * configuration the paired host owns.
 *
 * Since ADR-0117 a "mode" is no longer one flat id. It is a composition of
 * five axes (preset, permission, tool presentation, orchestration, runtime),
 * and — importantly — it belongs to a SESSION rather than to the app. This
 * store therefore holds two different things:
 *
 *   - `defaultComposition`: what a NEW session starts from.
 *   - `sessionCompositions`: what each live session actually selected.
 *
 * The distinction is the fix for a real defect: with a single global `modeId`,
 * changing the mode in one session silently retargeted every other session,
 * including one mid-turn.
 *
 * `setModeId` maps a flat `agentModeId` (prompt presets carry one) onto the
 * default composition.
 *
 * Persisted to localStorage so the user's last choice survives reload.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import { STANDARD_PRESET_ID } from "@/lib/agent/composition/preset-catalog"
import { appPresetIds } from "@/lib/agent/composition/app-preset-catalog"
import { selectionFromLegacyModeId } from "@/lib/agent/composition/legacy-mode-mapping"
import { BUILTIN_RUNTIME_REF, type AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
export type { AgentRuntime } from "@cognia/plugin-contract/stores/agent/agent-runtime-store"

export interface ExternalSessionLink {
  agentId: string
  sessionId: string
  host?: import("@/types/agent/external-agent-config-store").ExternalAgentConfigStamp
}

function linkMatchesRuntime(link: ExternalSessionLink | undefined, ref: AgentRuntimeRef): boolean {
  if (!link) return false
  return ref.kind === "external"
    ? !link.host && ref.agentId === link.agentId
    : ref.kind === "host" &&
        Boolean(link.host) &&
        ref.configId === link.agentId &&
        ref.revision === link.host?.revision &&
        ref.lifecycleGeneration === link.host?.lifecycleGeneration
}

interface AgentRuntimeState {
  /**
   * What runs the next turn: Cognia's own runtime, a locally configured
   * external agent, or a configuration the paired host owns.
   */
  runtimeRef: AgentRuntimeRef
  /**
   * What each live session actually runs on.
   *
   * Same split as `defaultComposition` / `sessionCompositions`, and for the same
   * reason. ADR-0117 moved the mode onto the session because one global value
   * retargeted every other session, including one mid-turn. The runtime lane
   * was left global and read at send time, which was the identical defect on
   * the larger axis: switching runtime in one conversation changed where every
   * other conversation's next turn would run.
   */
  sessionRuntimeRefs: Record<string, AgentRuntimeRef>
  /** Live process identity for this device only; never persisted or synced. */
  sessionExternalLinks: Record<string, ExternalSessionLink>
  setSessionExternalLink: (chatSessionId: string, link: ExternalSessionLink | undefined) => void
  defaultComposition: AgentCompositionSelectionV1
  sessionCompositions: Record<string, AgentCompositionSelectionV1>

  /** Set the lane a NEW session starts on. */
  setRuntimeRef: (ref: AgentRuntimeRef) => void
  /** Set the lane for one live session, leaving every other session alone. */
  setSessionRuntimeRef: (sessionId: string, ref: AgentRuntimeRef) => void
  /** Drop one session's override so it falls back to the app default. */
  clearSessionRuntimeRef: (sessionId: string) => void
  /** Set the default composition from a flat `agentModeId`. */
  setModeId: (modeId: string) => void
  setDefaultComposition: (selection: AgentCompositionSelectionV1) => void
  setSessionComposition: (sessionId: string, selection: AgentCompositionSelectionV1) => void
  clearSessionComposition: (sessionId: string) => void
}

/**
 * Map a flat mode id onto a composition selection.
 *
 * The known set is the FULL app catalog — built-ins plus the user's custom modes
 * plus enabled plugin modes. Using the built-in catalog alone made every custom
 * mode look like an unrecognised legacy id, so selecting one in the composer
 * silently stored `presetId: "standard"` while the send path still applied the
 * custom prompt: the picker, the settings sheet and the recorded composition all
 * disagreed with each other.
 */
function selectionFromModeId(modeId: string | null | undefined): AgentCompositionSelectionV1 {
  return selectionFromLegacyModeId(modeId, appPresetIds()).selection
}

export const useAgentRuntimeStore = create<AgentRuntimeState>()(
  persist(
    (set) => ({
      runtimeRef: BUILTIN_RUNTIME_REF,
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
      defaultComposition: { presetId: STANDARD_PRESET_ID },
      sessionCompositions: {},

      setRuntimeRef: (runtimeRef) =>
        set((state) => ({
          runtimeRef,
          sessionExternalLinks: Object.fromEntries(
            Object.entries(state.sessionExternalLinks).filter(([id, link]) => {
              const ref = state.sessionRuntimeRefs[id] ?? runtimeRef
              return linkMatchesRuntime(link, ref)
            })
          ),
        })),
      setSessionRuntimeRef: (sessionId, ref) =>
        set((state) => {
          const links = { ...state.sessionExternalLinks }
          if (!linkMatchesRuntime(links[sessionId], ref)) delete links[sessionId]
          return {
            sessionRuntimeRefs: { ...state.sessionRuntimeRefs, [sessionId]: ref },
            sessionExternalLinks: links,
          }
        }),
      clearSessionRuntimeRef: (sessionId) =>
        set((state) => {
          if (
            !Object.hasOwn(state.sessionRuntimeRefs, sessionId) &&
            !Object.hasOwn(state.sessionExternalLinks, sessionId)
          )
            return state
          const next = { ...state.sessionRuntimeRefs }
          delete next[sessionId]
          const links = { ...state.sessionExternalLinks }
          if (!linkMatchesRuntime(links[sessionId], state.runtimeRef)) delete links[sessionId]
          return { sessionRuntimeRefs: next, sessionExternalLinks: links }
        }),
      setSessionExternalLink: (sessionId, link) =>
        set((state) => {
          const ref = selectRuntimeRefForSession(state, sessionId)
          // A late event from the previously selected runtime must not retarget
          // controls in the newly selected conversation lane.
          if (link && !linkMatchesRuntime(link, ref)) return state
          if (
            link &&
            state.sessionExternalLinks[sessionId]?.agentId === link.agentId &&
            state.sessionExternalLinks[sessionId]?.sessionId === link.sessionId &&
            JSON.stringify(state.sessionExternalLinks[sessionId]?.host) ===
              JSON.stringify(link.host)
          )
            return state
          const links = { ...state.sessionExternalLinks }
          if (link) links[sessionId] = link
          else delete links[sessionId]
          return { sessionExternalLinks: links }
        }),
      setModeId: (modeId) => set({ defaultComposition: selectionFromModeId(modeId) }),
      setDefaultComposition: (selection) => set({ defaultComposition: selection }),
      setSessionComposition: (sessionId, selection) =>
        set((state) => ({
          sessionCompositions: { ...state.sessionCompositions, [sessionId]: selection },
        })),
      clearSessionComposition: (sessionId) =>
        set((state) => {
          if (!Object.hasOwn(state.sessionCompositions, sessionId)) return state
          const next = { ...state.sessionCompositions }
          delete next[sessionId]
          return { sessionCompositions: next }
        }),
    }),
    {
      name: "cognia-next.agent-runtime",
      storage: persistLocalStorage(),
      version: 3,
      partialize: ({ sessionExternalLinks: _liveLinks, ...state }) => state,
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<AgentRuntimeState>),
        sessionExternalLinks: current.sessionExternalLinks,
      }),
    }
  )
)

/**
 * The runtime a session's next turn runs on.
 *
 * Falls back to the app default for a session that never chose one, which is
 * every session created before a per-session choice existed.
 */
export function runtimeRefForSession(sessionId: string | undefined): AgentRuntimeRef {
  return selectRuntimeRefForSession(useAgentRuntimeStore.getState(), sessionId)
}

/** The reactive form. A selector, so a component re-renders on its OWN lane. */
export function useRuntimeRefForSession(sessionId: string | undefined): AgentRuntimeRef {
  return useAgentRuntimeStore((state) => selectRuntimeRefForSession(state, sessionId))
}

function selectRuntimeRefForSession(
  state: AgentRuntimeState,
  sessionId: string | undefined
): AgentRuntimeRef {
  if (sessionId && Object.hasOwn(state.sessionRuntimeRefs, sessionId)) {
    return state.sessionRuntimeRefs[sessionId]
  }
  return state.runtimeRef
}

/**
 * The composition a session should run under.
 *
 * Falls back to the app default for a session that never chose one, which is
 * every session created before this shipped.
 */
export function compositionForSession(sessionId: string | undefined): AgentCompositionSelectionV1 {
  const state = useAgentRuntimeStore.getState()
  if (sessionId && Object.hasOwn(state.sessionCompositions, sessionId)) {
    return state.sessionCompositions[sessionId]
  }
  return state.defaultComposition
}

/** The current process-owned link, scoped to the selected local runtime. */
export function externalSessionLinkForSession(
  sessionId: string | undefined
): ExternalSessionLink | undefined {
  return selectExternalSessionLinkForSession(useAgentRuntimeStore.getState(), sessionId)
}

export function useExternalSessionLinkForSession(
  sessionId: string | undefined
): ExternalSessionLink | undefined {
  return useAgentRuntimeStore((state) => selectExternalSessionLinkForSession(state, sessionId))
}

function selectExternalSessionLinkForSession(
  state: AgentRuntimeState,
  sessionId: string | undefined
): ExternalSessionLink | undefined {
  if (!sessionId) return undefined
  const ref = selectRuntimeRefForSession(state, sessionId)
  const link = state.sessionExternalLinks[sessionId]
  return linkMatchesRuntime(link, ref) ? link : undefined
}
