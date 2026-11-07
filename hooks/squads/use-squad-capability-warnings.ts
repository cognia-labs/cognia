"use client"

/**
 * Live stale-capability warnings for one Squad (ADR-0252 P2).
 *
 * The audit's sidecar map (`lib/squads/capability-audit.ts`) is derived and
 * never persisted. Plugin unregister, a run's pre-run gate and "Audit now"
 * recompute it; this hook subscribes to it, so every reader repaints when any
 * of them does. A surface that owns the Squad's capability settings passes
 * `audit: true` to recompute whenever the ids it would flag change, so fixing
 * a stale id in the editor clears its warning without another click. Narrow
 * the list to one teammate with `teammateWarningsIn`.
 */

import { useEffect, useSyncExternalStore } from "react"

import {
  getInstanceCapabilityWarnings,
  refreshAllInstanceCapabilityWarnings,
  subscribeCapabilityWarnings,
  type CapabilityAuditWarning,
} from "@/lib/squads/capability-audit"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"

const NONE: readonly CapabilityAuditWarning[] = []

export interface SquadCapabilityWarningsOptions {
  /** Recompute the audit on mount and whenever the audited ids change. */
  audit?: boolean
}

export function useSquadCapabilityWarnings(
  squadId: string | undefined,
  options: SquadCapabilityWarningsOptions = {}
): readonly CapabilityAuditWarning[] {
  const audit = options.audit === true
  const warnings = useSyncExternalStore(
    subscribeCapabilityWarnings,
    () => (squadId ? getInstanceCapabilityWarnings(squadId) : NONE),
    () => NONE
  )
  const auditKey = useAgentTeamStore((s) => (audit && squadId ? auditedIdsKey(s, squadId) : ""))

  useEffect(() => {
    if (!audit || !squadId) return
    void refreshAllInstanceCapabilityWarnings().catch(() => undefined)
  }, [audit, squadId, auditKey])

  return warnings
}

/**
 * Exactly what `validateInstanceCapabilitiesWith` reads for a Squad: the team
 * bundle, the shared-memory adapter and each teammate's overlay. A string, so
 * the store selector stays referentially stable across unrelated edits.
 */
function auditedIdsKey(
  state: ReturnType<typeof useAgentTeamStore.getState>,
  squadId: string
): string {
  const team = state.teams[squadId]
  if (!team) return ""
  return JSON.stringify([
    team.config.capabilities ?? null,
    team.config.sharedMemoryAdapterId ?? null,
    team.teammateIds.map((id) => [id, state.teammates[id]?.config.capabilities ?? null]),
  ])
}
