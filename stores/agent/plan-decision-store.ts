/**
 * Who answers a plan awaiting approval, and how (ADR-0045).
 *
 * The approval decisions resume the chat (approve sends the implementing turn,
 * keep-planning sends feedback), so they belong to the pane that owns this
 * conversation's decisions — `PlanApprovalDock`, mounted above that pane's
 * composer. The dock's Tasks panel shows the same plan full height and offers
 * the same decisions; instead of re-deriving the resume plumbing it calls the
 * owner's handlers through this registry. One owner per session: with no
 * owner registered (a pane that does not own decisions) the panel offers none.
 *
 * In memory only: handlers are closures over a mounted dock.
 */

import { create } from "zustand"

import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import type { PlanEditPatch, PlanRefinementType } from "@/types/agent/plan"

export interface PlanDecisionHandlers {
  /** The plan these handlers decide; a panel showing another plan must not call them. */
  planId: string
  approve: (mode: PlanResumeMode) => void
  keepPlanning: (feedback?: string) => void
  reject: (reason?: string) => void
  refine: (type: PlanRefinementType, feedback?: string) => void
  edit: (patch: PlanEditPatch) => Promise<void>
  openEditor: () => void
}

export interface PlanDecisionOwner {
  handlers: PlanDecisionHandlers
  busy: boolean
  refining: boolean
}

interface PlanDecisionState {
  owners: Record<string, PlanDecisionOwner>
  /** Register the session's decision owner; returns the unregister call. */
  register: (sessionId: string, handlers: PlanDecisionHandlers) => () => void
  /** Mirror the owner's in-flight state so the panel disables the same buttons. */
  setPending: (sessionId: string, pending: { busy: boolean; refining: boolean }) => void
}

export const usePlanDecisionStore = create<PlanDecisionState>()((set) => ({
  owners: {},
  register: (sessionId, handlers) => {
    set((state) => ({
      owners: {
        ...state.owners,
        [sessionId]: {
          handlers,
          busy: state.owners[sessionId]?.busy ?? false,
          refining: state.owners[sessionId]?.refining ?? false,
        },
      },
    }))
    return () =>
      set((state) => {
        // Only drop the entry this call registered: a newer owner may already
        // have replaced it (remount, plan switch).
        if (state.owners[sessionId]?.handlers !== handlers) return state
        const { [sessionId]: _removed, ...owners } = state.owners
        return { owners }
      })
  },
  setPending: (sessionId, { busy, refining }) =>
    set((state) => {
      const owner = state.owners[sessionId]
      if (!owner || (owner.busy === busy && owner.refining === refining)) return state
      return { owners: { ...state.owners, [sessionId]: { ...owner, busy, refining } } }
    }),
}))

/** The decision owner for `planId` in `sessionId`, or null. */
export function usePlanDecisionOwner(
  sessionId: string | null | undefined,
  planId: string | null | undefined
): PlanDecisionOwner | null {
  return usePlanDecisionStore((state) => {
    if (!sessionId || !planId) return null
    const owner = state.owners[sessionId]
    return owner && owner.handlers.planId === planId ? owner : null
  })
}
