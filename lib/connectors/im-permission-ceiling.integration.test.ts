/** @jest-environment jsdom */

import { resolveImEffectiveConfig } from "@/lib/connectors/effective-config"
import { deriveImPermissionCeiling } from "@/lib/connectors/im-permission-ceiling"
import { startTeamRunFromIM, type StartTeamRunFromIMDeps } from "@/lib/connectors/team-dispatch"
import type { SquadRunRecordsSeed } from "@/lib/ai/agent/team/squad/start-squad-run"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

const adapter: AdapterInstanceRow = {
  id: "adapter_audit",
  type: "telegram",
  displayName: "Authority audit",
  enabled: true,
  transportMode: "stub",
  settings: {},
  credentialsRef: { keyringService: "audit", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  defaultTeamId: "team_audit",
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 1,
}
const baseOverride: ConversationOverrideRow = {
  id: "override_audit",
  conversationKey: "telegram:adapter_audit:room",
  sessionId: "session_audit",
  createdAt: 1,
  updatedAt: 1,
}

it.each(["conversation-plan", "adapter-plan", "confirm"] as const)(
  "keeps a target below the IM %s authority constraint",
  async (scenario) => {
    const row =
      scenario === "adapter-plan" ? { ...adapter, defaultAuthority: "plan" as const } : adapter
    const override: ConversationOverrideRow = {
      ...baseOverride,
      ...(scenario === "conversation-plan" ? { authority: "plan" as const } : {}),
      ...(scenario === "confirm"
        ? { autonomy: "confirm" as const, authority: "bypassPermissions" as const }
        : {}),
    }
    const effective = resolveImEffectiveConfig({
      adapter: row,
      override,
      rule: null,
      system: { mode: "auto" },
    })
    expect(effective.authority.effective).toBe(
      scenario === "confirm" ? "bypassPermissions" : "plan"
    )

    // This is the parent ceiling the actual IM runtime passes to its target.
    const ceiling = deriveImPermissionCeiling({
      adapter: row,
      override,
      target: "team",
      allBuiltInSkills: [],
      allowedBuiltInToolNames: new Set(),
    })
    expect(ceiling.permissionMode).toBe(scenario === "confirm" ? "default" : "plan")
    const seeds: SquadRunRecordsSeed[] = []
    const lifecycle = jest.fn(async () => ({ status: "completed" }))
    const deps: StartTeamRunFromIMDeps = {
      awaitRuntimeReady: async () => true,
      loadStore: async () => ({
        getTeam: (id) => ({
          id,
          name: "Audit team",
          config: { defaultPermissionMode: "bypassPermissions" },
        }),
        getTeammates: () => [{ role: "teammate" }],
        getTeamTasks: () => [],
        updateTeam: () => undefined,
      }),
      evaluateReadiness: async () => ({ ready: true, blockers: [], evaluatedAt: 1 }),
      findLiveRun: async () => undefined,
      createRunRecords: async (seed) => {
        seeds.push(seed)
        return { executionRunId: `execution:team:${seed.runId}`, created: true }
      },
      runLifecycle: lifecycle as NonNullable<StartTeamRunFromIMDeps["runLifecycle"]>,
    }
    const result = await startTeamRunFromIM(
      {
        teamId: "team_audit",
        goal: "Perform requested task",
        adapterId: row.id,
        conversationKey: override.conversationKey,
        permissionCeiling: ceiling,
      },
      deps
    )
    expect(result.started).toBe(true)
    expect(seeds).toHaveLength(1)
    const actualMode = seeds[0].executionConstraints?.permissionCeiling?.permissionMode

    expect(actualMode).toBe(scenario === "confirm" ? "default" : "plan")
  }
)
