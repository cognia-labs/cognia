/**
 * Capability audit — detects *stale* capability ids persisted on a team or
 * teammate that no longer resolve against the live registries / catalogs
 * (e.g. a plugin that contributed a subagent was disabled or uninstalled).
 *
 * Mirrors the warning shape of `agent-team-template-registry.validateTemplateRequires`
 * but operates on persisted store instances rather than a template `requires`
 * block. The set of "known ids" per capability bucket is built from exactly
 * the sources the runtime resolves against (`build-options`), so a flagged id
 * is genuinely unresolvable — not a host-vs-plugin false positive:
 *
 *   - skillIds            → plugin skill registry ∪ host skills (Dexie)
 *   - mcpServerIds        → plugin mcp-preset registry ∪ host mcp servers (Dexie)
 *   - a2uiTemplateIds     → host a2ui templates (Dexie)
 *   - nativeAnthropicToolIds → plugin native-tool registry
 *   - characterPackIds    → plugin character-pack registry
 *   - externalAgentPresetIds → built-in presets ∪ plugin presets
 *   - subagentIds         → the team surface's built-ins ∪ plugin subagents (bare and namespaced, `knownSubagentIds`)
 *
 * Warnings are *derived*, never persisted (per CLAUDE.md: derived data must
 * not be persisted). `refreshAllInstanceCapabilityWarnings` recomputes a
 * sidecar map the UI reads through `useSquadCapabilityWarnings`
 * (`subscribeCapabilityWarnings` + `getInstanceCapabilityWarnings`, narrowed
 * to one teammate with `teammateWarningsIn`).
 */

import type { AgentTeam, AgentTeammate, TeamCapabilityBundle } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { listSkillIds } from "@/lib/plugin/registries/skill-registry"
import { listMcpServerPresetIds } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listNativeAnthropicToolIds } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { listCharacterPackIds } from "@/lib/plugin/registries/character-pack-registry"
import { knownSubagentIds } from "@/lib/claude/agents/subagents"
import { getAvailablePresets } from "@/lib/ai/agent/external/config/presets"
import { listSharedMemoryAdapterIds } from "@/lib/plugin/registries/shared-memory-adapter-registry"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listTemplates as listA2uiTemplates } from "@/lib/db/a2ui-templates"

export type CapabilityAuditWarningCode =
  | "missing-mcp-preset"
  | "missing-skill"
  | "missing-native-tool"
  | "missing-character-pack"
  | "missing-external-agent-preset"
  | "missing-subagent"
  | "missing-a2ui-template"
  | "missing-shared-memory-adapter"

export type CapabilityAuditScope =
  { kind: "team"; teamId: string } | { kind: "teammate"; teamId: string; teammateId: string }

/**
 * The location a stale id lives at. Either one of the 7 capability-bundle
 * list keys, or the single `sharedMemoryAdapterId` team-config field.
 */
export type CapabilityAuditBucket = keyof TeamCapabilityBundle | "sharedMemoryAdapterId"

export interface CapabilityAuditWarning {
  code: CapabilityAuditWarningCode
  /** The capability bundle key the id lives under (or the adapter field). */
  bucket: CapabilityAuditBucket
  /** The id that no longer resolves. */
  missingId: string
  scope: CapabilityAuditScope
}

/** The 7 capability buckets and their warning codes. */
const BUCKET_CODES: Record<keyof TeamCapabilityBundle, CapabilityAuditWarningCode> = {
  mcpServerIds: "missing-mcp-preset",
  skillIds: "missing-skill",
  nativeAnthropicToolIds: "missing-native-tool",
  characterPackIds: "missing-character-pack",
  externalAgentPresetIds: "missing-external-agent-preset",
  subagentIds: "missing-subagent",
  a2uiTemplateIds: "missing-a2ui-template",
}

const BUCKET_KEYS = Object.keys(BUCKET_CODES) as Array<keyof TeamCapabilityBundle>

/** Snapshot of every id the runtime can currently resolve, keyed by bucket. */
export interface KnownCapabilityIds {
  mcpServerIds: Set<string>
  skillIds: Set<string>
  nativeAnthropicToolIds: Set<string>
  characterPackIds: Set<string>
  externalAgentPresetIds: Set<string>
  subagentIds: Set<string>
  a2uiTemplateIds: Set<string>
  /** Registered shared-memory adapter ids (for the team config field). */
  sharedMemoryAdapterIds: Set<string>
}

/**
 * Build the per-bucket set of currently-resolvable ids. Reads the plugin
 * overlay registries (sync) plus the host Dexie catalogs (async) so a single
 * call covers an entire audit sweep without re-querying per team.
 */
export async function buildKnownCapabilityIds(): Promise<KnownCapabilityIds> {
  const [skills, mcpServers, a2uiTemplates] = await Promise.all([
    listSkills(),
    listMcpServers(),
    listA2uiTemplates(),
  ])

  const subagentIds = new Set<string>(knownSubagentIds("team"))

  return {
    skillIds: new Set<string>([...listSkillIds(), ...skills.map((s) => s.id)]),
    mcpServerIds: new Set<string>([...listMcpServerPresetIds(), ...mcpServers.map((m) => m.id)]),
    nativeAnthropicToolIds: new Set<string>(listNativeAnthropicToolIds()),
    characterPackIds: new Set<string>(listCharacterPackIds()),
    externalAgentPresetIds: new Set<string>(getAvailablePresets()),
    subagentIds,
    a2uiTemplateIds: new Set<string>(a2uiTemplates.map((t) => t.id)),
    sharedMemoryAdapterIds: new Set<string>(listSharedMemoryAdapterIds()),
  }
}

/** Collect the ids a teammate overlay introduces (add + replace) per bucket. */
function teammateOwnIds(
  teammate: Pick<AgentTeammate, "config">,
  bucket: keyof TeamCapabilityBundle
): string[] {
  const overlay = teammate.config.capabilities?.[bucket]
  if (!overlay) return []
  const ids: string[] = []
  if (overlay.replace) ids.push(...overlay.replace)
  if (overlay.add) ids.push(...overlay.add)
  return ids
}

/**
 * Validate one team's (and optionally one teammate's) persisted capability
 * ids against a prebuilt known-id snapshot. Pure + sync given the snapshot.
 *
 * Team scope checks the team-level default bundle. Teammate scope checks only
 * the ids the teammate's overlay *introduces* (add/replace) so team-level
 * stale ids aren't double-reported under every teammate.
 */
export function validateInstanceCapabilitiesWith(
  known: KnownCapabilityIds,
  team: AgentTeam,
  teammate?: AgentTeammate
): CapabilityAuditWarning[] {
  const warnings: CapabilityAuditWarning[] = []
  const scope: CapabilityAuditScope = teammate
    ? { kind: "teammate", teamId: team.id, teammateId: teammate.id }
    : { kind: "team", teamId: team.id }

  for (const bucket of BUCKET_KEYS) {
    const ids = teammate
      ? teammateOwnIds(teammate, bucket)
      : (team.config.capabilities?.[bucket] ?? [])
    for (const id of ids) {
      if (!known[bucket].has(id)) {
        warnings.push({ code: BUCKET_CODES[bucket], bucket, missingId: id, scope })
      }
    }
  }

  // The shared-memory adapter is a single team-level config field, not a
  // capability list — only audited at team scope.
  if (!teammate) {
    const adapterId = team.config.sharedMemoryAdapterId
    if (adapterId && !known.sharedMemoryAdapterIds.has(adapterId)) {
      warnings.push({
        code: "missing-shared-memory-adapter",
        bucket: "sharedMemoryAdapterId",
        missingId: adapterId,
        scope,
      })
    }
  }

  return warnings
}

export interface AgentTeamsAuditResult {
  warningsByTeamId: Record<string, CapabilityAuditWarning[]>
  totalWarnings: number
}

/**
 * Sweep every team + teammate in the store against a single known-id
 * snapshot. Returns warnings grouped by team id (teammate warnings are folded
 * into their owning team's array, carrying a teammate scope).
 *
 * @internal Test seam: exported for its unit tests, not for production callers.
 */
export async function auditAllAgentTeamsCapabilities(): Promise<AgentTeamsAuditResult> {
  const known = await buildKnownCapabilityIds()
  const state = useAgentTeamStore.getState()
  const warningsByTeamId: Record<string, CapabilityAuditWarning[]> = {}
  let totalWarnings = 0

  for (const team of Object.values(state.teams)) {
    const teamWarnings = validateInstanceCapabilitiesWith(known, team)
    const memberWarnings: CapabilityAuditWarning[] = []
    for (const teammateId of team.teammateIds) {
      const teammate = state.teammates[teammateId]
      if (!teammate) continue
      memberWarnings.push(...validateInstanceCapabilitiesWith(known, team, teammate))
    }
    const all = [...teamWarnings, ...memberWarnings]
    if (all.length > 0) {
      warningsByTeamId[team.id] = all
      totalWarnings += all.length
    }
  }

  return { warningsByTeamId, totalWarnings }
}

// ============================================================================
// Derived sidecar warning store (not persisted)
// ============================================================================

let warningsByTeamId: Record<string, CapabilityAuditWarning[]> = {}
const warningListeners = new Set<() => void>()
const NO_WARNINGS: readonly CapabilityAuditWarning[] = []

function publishWarnings(next: Record<string, CapabilityAuditWarning[]>): void {
  warningsByTeamId = next
  for (const listener of warningListeners) listener()
}

/**
 * Recompute the sidecar capability-warning map for every team. Fire-and-forget
 * safe — callers (plugin unregister sweep, workspace open, "Audit now") may
 * ignore the returned promise.
 */
export async function refreshAllInstanceCapabilityWarnings(): Promise<AgentTeamsAuditResult> {
  const result = await auditAllAgentTeamsCapabilities()
  publishWarnings(result.warningsByTeamId)
  return result
}

/**
 * Listen for a recomputed warning map. `getInstanceCapabilityWarnings` keeps
 * returning the same array until the next refresh, so it is a stable
 * `useSyncExternalStore` snapshot.
 */
export function subscribeCapabilityWarnings(listener: () => void): () => void {
  warningListeners.add(listener)
  return () => {
    warningListeners.delete(listener)
  }
}

/** Read the cached warnings for a team (team-scope + teammate-scope folded in). */
export function getInstanceCapabilityWarnings(teamId: string): readonly CapabilityAuditWarning[] {
  return warningsByTeamId[teamId] ?? NO_WARNINGS
}

/** The warnings in a team's list that belong to one teammate's own overlay. */
export function teammateWarningsIn(
  teamWarnings: readonly CapabilityAuditWarning[],
  teammateId: string
): readonly CapabilityAuditWarning[] {
  const own = teamWarnings.filter(
    (w) => w.scope.kind === "teammate" && w.scope.teammateId === teammateId
  )
  return own.length > 0 ? own : NO_WARNINGS
}

/** Test-only: clear the cached warning map. */
export function __resetCapabilityWarningsForTesting(): void {
  publishWarnings({})
}
