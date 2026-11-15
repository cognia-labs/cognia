// Teammate execution-binding resolver (ADR-0090 Phase 7).
//
// One fixed precedence chain decides which execution binding a teammate
// dispatch feeds the unified resolver:
//
//   managed force-all  >  member  >  run override  >  team default  >  app default
//
// Managed override is EXPLICIT in the trace (never silent), pool mode exposes
// candidate deployment ids ONLY (the coordinator never sees endpoints or
// credentials).

import type { AgentExecutionPolicy } from "@cognia/agent-config-types/agent-execution"
import type { TeammateConfig, TeammateExecutionBinding } from "@/types/agent/agent-team"

export type ExecutionBindingSource = "managed" | "member" | "run" | "team-default" | "app-default"

export interface ResolvedTeammateBinding {
  /** Policy fragment for `resolveAgentExecutionSpec` — refs only. */
  policy: Partial<AgentExecutionPolicy>
  source: ExecutionBindingSource
  /** Pool mode: the candidate ids the coordinator may pick from. */
  candidateIds?: string[]
  executionTarget: NonNullable<TeammateExecutionBinding["executionTarget"]>
  /** Explicit trace of the chain that was consulted (audit). */
  trace: {
    consulted: ExecutionBindingSource[]
    managedForced: boolean
  }
}

export interface ResolveTeammateBindingInput {
  member?: TeammateExecutionBinding
  runOverride?: TeammateExecutionBinding
  teamDefault?: TeammateExecutionBinding
  appDefault?: TeammateExecutionBinding
  /** Managed policy: force EVERY teammate onto this binding (explicit). */
  managedForceAll?: TeammateExecutionBinding
}

function policyFromBinding(binding: TeammateExecutionBinding): {
  policy: Partial<AgentExecutionPolicy>
  candidateIds?: string[]
} {
  if (binding.mode === "pinned") {
    return {
      policy: {
        ...(binding.runtimePolicy ? { runtimePolicy: binding.runtimePolicy } : {}),
        ...(binding.deploymentRef ? { deploymentRef: binding.deploymentRef } : {}),
        ...(binding.credentialProfileRef
          ? { credentialProfileRef: binding.credentialProfileRef }
          : {}),
        ...(binding.modelRole ? { modelBindingRef: binding.modelRole } : {}),
      },
    }
  }
  if (binding.mode === "pool") {
    // Candidates only — the picked id becomes a pinned deploymentRef AFTER
    // the coordinator chooses; nothing endpoint/credential shaped leaves here.
    return { policy: {}, candidateIds: [...binding.candidateIds] }
  }
  return { policy: {} }
}

const LOCAL_TARGET = { mode: "colocate" } as const

/**
 * Resolve the effective binding by fixed precedence. `inherit` (or absence)
 * at any level falls through to the next; managed force-all short-circuits
 * everything and is recorded in the trace.
 */
export function resolveTeammateExecutionBinding(
  input: ResolveTeammateBindingInput
): ResolvedTeammateBinding {
  const chain: Array<[ExecutionBindingSource, TeammateExecutionBinding | undefined]> = [
    ["managed", input.managedForceAll],
    ["member", input.member],
    ["run", input.runOverride],
    ["team-default", input.teamDefault],
    ["app-default", input.appDefault],
  ]

  const consulted: ExecutionBindingSource[] = []
  // Host selection is independent of deployment inheritance. Inherit-mode
  // rows are how the UI stores a host-only pin.
  let executionTarget: TeammateExecutionBinding["executionTarget"]
  for (const [source, binding] of chain) {
    consulted.push(source)
    executionTarget ??= binding?.executionTarget
    if (!binding || binding.mode === "inherit") continue
    const { policy, candidateIds } = policyFromBinding(binding)
    return {
      policy: { ...policy, ...(executionTarget ? { executionTarget } : {}) },
      source,
      ...(candidateIds ? { candidateIds } : {}),
      executionTarget: executionTarget ?? LOCAL_TARGET,
      trace: { consulted, managedForced: source === "managed" },
    }
  }

  // Whole chain inherited: the app default execution applies (empty policy —
  // the unified resolver's own legacy/default mapping decides).
  return {
    policy: executionTarget ? { executionTarget } : {},
    source: "app-default",
    executionTarget: executionTarget ?? LOCAL_TARGET,
    trace: { consulted, managedForced: false },
  }
}

/**
 * The member binding a teammate config asks for: its `execution` binding, or
 * a pinned `deploymentRef: provider` when it only names a provider. The
 * provider id IS the deployment id in the ADR-0090 P1 profile store
 * (`deriveProfiles` keeps provider ids as deployment identity), so its
 * credential resolves through the store's `legacy-provider-settings` reference.
 */
export function migrateTeammateExecutionBinding(
  config: TeammateConfig
): TeammateExecutionBinding | undefined {
  if (config.execution) return config.execution
  if (!config.provider) return undefined
  return { mode: "pinned", deploymentRef: config.provider }
}
