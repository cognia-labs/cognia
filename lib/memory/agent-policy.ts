import type { AgentMemoryPolicy } from "@cognia/agent-config-types"
import {
  resolveMemoryTurnPolicy,
  type MemoryExternalContextSource,
  type MemorySessionPolicy,
} from "@/lib/memory/control-plane/policy"
import {
  resolveMemoryConfig,
  type MemoryConfig,
  type MemoryScope,
  type ProjectMemoryIsolationMode,
  type ProjectMemoryPolicy,
} from "@/types/memory/memory"

const ALL_SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]

export function readProjectMemoryPolicy(
  project: { metadata?: Record<string, unknown> } | null | undefined
): ProjectMemoryPolicy {
  const raw = project?.metadata?.memoryPolicy
  if (raw && typeof raw === "object") {
    const mode = (raw as { isolationMode?: unknown }).isolationMode
    if (mode === "project-only" || mode === "inherit") {
      return { isolationMode: mode as ProjectMemoryIsolationMode }
    }
  }
  return { isolationMode: "inherit" }
}

export function mergeProjectMemoryPolicyMetadata(
  metadata: Record<string, unknown> | undefined,
  policy: ProjectMemoryPolicy
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) }
  if (policy.isolationMode === "inherit") {
    delete next.memoryPolicy
  } else {
    next.memoryPolicy = { isolationMode: policy.isolationMode }
  }
  return next
}

export interface ResolvedAgentMemoryPolicy {
  canRecall: boolean
  canCreate: boolean
  canUpdate: boolean
  canForget: boolean
  canAutoLearn: boolean
  /** Session-resolved chat learning gate (independent of per-turn `autoExtract`). */
  canLearnSession: boolean
  readableScopes: MemoryScope[]
  writableScopes: MemoryScope[]
  recallReason: string
  learnReason: string
}

export function resolveAgentMemoryPolicy(input: {
  config: Partial<MemoryConfig>
  agentPolicy?: AgentMemoryPolicy
  projectPolicy?: ProjectMemoryPolicy
  session?: MemorySessionPolicy
  externalContext?: readonly MemoryExternalContextSource[]
}): ResolvedAgentMemoryPolicy {
  const config = resolveMemoryConfig(input.config)
  const operations = input.agentPolicy?.operations ?? {
    recall: true,
    create: true,
    update: true,
    forget: true,
  }
  const projectOnly = input.projectPolicy?.isolationMode === "project-only"
  const baseReadable = [...(input.agentPolicy?.readableScopes ?? ALL_SCOPES)]
  const baseWritable = [...(input.agentPolicy?.writableScopes ?? ALL_SCOPES)]
  const readableScopes = projectOnly
    ? baseReadable.filter((scope) => scope === "workspace")
    : baseReadable
  const writableScopes = projectOnly
    ? baseWritable.filter((scope) => scope === "workspace")
    : baseWritable
  const turn = resolveMemoryTurnPolicy({
    config,
    session: input.session,
    externalContext: input.externalContext,
  })
  const globallyWritable = config.enabled && !config.temporary
  // Intersection, not `??` chains: the Agent's declared operations and the
  // workspace's isolation policy are hard ceilings the session toggles can only
  // narrow.
  const canRecall = turn.canRecall && operations.recall && readableScopes.length > 0
  const canLearnSession =
    turn.canLearn &&
    (input.agentPolicy?.autoLearn ?? true) &&
    operations.create &&
    writableScopes.length > 0
  const canAutoLearn = canLearnSession && config.autoExtract

  return {
    canRecall,
    canCreate: globallyWritable && operations.create && writableScopes.length > 0,
    canUpdate: globallyWritable && operations.update && writableScopes.length > 0,
    canForget: operations.forget && writableScopes.length > 0,
    canAutoLearn,
    canLearnSession,
    readableScopes,
    writableScopes,
    recallReason: canRecall
      ? "allowed"
      : turn.recallReason === "temporary" || turn.recallReason === "disabled"
        ? turn.recallReason
        : !operations.recall || baseReadable.length === 0
          ? "agent_policy"
          : readableScopes.length === 0
            ? "project_policy"
            : input.session?.memoryUse === false
              ? "disabled_for_chat"
              : turn.recallReason,
    learnReason: canAutoLearn
      ? "allowed"
      : turn.learnReason === "temporary" || turn.learnReason === "disabled"
        ? turn.learnReason
        : !operations.create || input.agentPolicy?.autoLearn === false || baseWritable.length === 0
          ? "agent_policy"
          : writableScopes.length === 0
            ? "project_policy"
            : input.session?.memoryLearn === false
              ? "disabled_for_chat"
              : !config.autoExtract
                ? "disabled"
                : turn.learnReason,
  }
}

export function scopeAllowedByAgentMemoryPolicy(
  policy: ResolvedAgentMemoryPolicy,
  operation: "recall" | "create" | "update" | "forget",
  scope: MemoryScope
): boolean {
  return operation === "recall"
    ? policy.canRecall && policy.readableScopes.includes(scope)
    : operation === "create"
      ? policy.canCreate && policy.writableScopes.includes(scope)
      : operation === "update"
        ? policy.canUpdate && policy.writableScopes.includes(scope)
        : policy.canForget && policy.writableScopes.includes(scope)
}

export async function resolvePersistedAgentMemoryPolicy(input: {
  config: Partial<MemoryConfig>
  characterId?: string
  sessionId?: string
  projectId?: string
  externalContext?: readonly MemoryExternalContextSource[]
}): Promise<ResolvedAgentMemoryPolicy> {
  const session = input.sessionId
    ? await import("@/lib/db/sessions")
        .then(({ getSession }) => getSession(input.sessionId!))
        .catch(() => undefined)
    : undefined
  const characterId = input.characterId ?? session?.characterId
  const projectId = input.projectId ?? session?.projectId
  const [character, project] = await Promise.all([
    characterId
      ? import("@/lib/db/characters")
          .then(({ resolveCharacterById }) => resolveCharacterById(characterId))
          .catch(() => undefined)
      : Promise.resolve(undefined),
    projectId
      ? import("@/lib/db/schema")
          .then(({ getDb }) => getDb().projects.get(projectId))
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  return resolveAgentMemoryPolicy({
    config: input.config,
    session,
    agentPolicy: character?.memoryPolicy,
    projectPolicy: readProjectMemoryPolicy(project),
    externalContext: input.externalContext,
  })
}

/** Carry the resolved operation ceiling into every target chosen by the judge. */
export function consolidationPermissionsForAgent(
  policy: ResolvedAgentMemoryPolicy
): import("@cognia/memory/consolidate/consolidator").ConsolidationPermissions {
  return {
    canUpdate: policy.canUpdate,
    canForget: policy.canForget,
    scopeAllowed: (operation, scope) => scopeAllowedByAgentMemoryPolicy(policy, operation, scope),
  }
}
