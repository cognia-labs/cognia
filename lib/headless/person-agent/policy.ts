/**
 * Which agent a member's conversation runs as (P6e).
 *
 * The Host answers `person_agent_policy_get` from the org's live agent policy:
 * the agents the org allows, whether its model credentials cover each one, the
 * org default, and whether this Host can run member agents at all. The answer
 * is read fresh for every turn: an admin who removes an agent or a credential
 * stops the next turn, not the next restart.
 *
 * Resolution is `resolvePersonTurn`, the one function the member's devices
 * run on the same facts (ADR-0253 D09), with its refusals as Host codes:
 *
 * - an agent the org does not allow: `org_agent_not_allowed`;
 * - execution unavailable on this Host, or no agent and no tool-less chat:
 *   `execution_isolation_unavailable`;
 * - no org credential for the agent, or a provider or model the org does not
 *   serve the conversation with: `model_access_unavailable`.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { resolvePersonTurn, type PersonAgentProblem } from "@/lib/chat/person-agent-choice"
import { MAX_PERSON_MODEL_NAME_LENGTH } from "@/lib/platform/host-feature-manifest"
import {
  readPersonModelPricing,
  rememberPersonModelPricing,
  type PersonModelPricing,
} from "./model-pricing"

export interface PersonAllowedAgent {
  runtimeId: string
  /** Whether an org credential covers the agent's model family. */
  available: boolean
  /** Provider ids whose org credential can run this agent. */
  providers: string[]
}

/** The member's own month (P6g). `monthlyTokens: null` means no cap. */
export interface PersonOwnUsage {
  month: string
  spentTokens: number
  reservedTokens: number
  monthlyTokens: number | null
}

export interface PersonAgentPolicy {
  allowedAgents: PersonAllowedAgent[]
  defaultAgent: string | null
  execution: "sandboxed" | "none"
  /**
   * P6g: per provider an allowed agent can use, the models the Host's
   * deployment serves; then every other provider the org holds a key for, so
   * a member's tool-less chat can start on one.
   */
  models: Record<string, string[]>
  /**
   * Per provider, the display name the deployment gives a served model, by
   * model id; absent when it names none. See `PersonAgentsManifest.modelNames`.
   */
  modelNames?: Record<string, Record<string, string>>
  /**
   * Per provider, the price the deployment gives a served model, by model id
   * (ADR-0253 §10); absent when it prices none. Member usage is booked at it.
   */
  modelPricing?: PersonModelPricing
  /** P6g: null when the Host keeps no usage ledger. */
  usage: PersonOwnUsage | null
  /**
   * ADR-0253 §7: retry a turn a Host restart interrupted, rather than end it
   * `host_restarted`. Present only when on.
   */
  resumeAfterRestart?: true
}

export type PersonAgentResolution =
  | { kind: "agent"; runtimeId: string; provider: string; model: string }
  | { kind: "tool-less" }
  | { kind: "refused"; code: string }

interface PolicyTransport {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isModels(value: unknown): value is Record<string, string[]> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0)
    )
  )
}

function copyModels(models: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(models).map(([provider, ids]) => [provider, [...ids]]))
}

/**
 * The names the Host gave, for models it also serves: an entry that is not a
 * bounded non-empty string, or that names a model the map does not list, is
 * dropped, so the manifest this feeds stays one the device accepts.
 */
function readModelNames(
  value: unknown,
  models: Record<string, string[]>
): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [provider, names] of Object.entries(value)) {
    if (!names || typeof names !== "object" || Array.isArray(names)) continue
    const kept: Record<string, string> = {}
    for (const [id, name] of Object.entries(names)) {
      if (
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= MAX_PERSON_MODEL_NAME_LENGTH &&
        models[provider]?.includes(id)
      )
        kept[id] = name
    }
    if (Object.keys(kept).length > 0) out[provider] = kept
  }
  return out
}

function isUsage(value: unknown): value is PersonOwnUsage | null {
  if (value === null) return true
  if (!value || typeof value !== "object") return false
  const usage = value as Record<string, unknown>
  return (
    typeof usage.month === "string" &&
    isCount(usage.spentTokens) &&
    isCount(usage.reservedTokens) &&
    (usage.monthlyTokens === null || isCount(usage.monthlyTokens))
  )
}

function isPolicy(
  value: unknown
): value is Omit<PersonAgentPolicy, "resumeAfterRestart"> & Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.allowedAgents) &&
    candidate.allowedAgents.every(
      (agent) =>
        agent !== null &&
        typeof agent === "object" &&
        typeof (agent as PersonAllowedAgent).runtimeId === "string" &&
        typeof (agent as PersonAllowedAgent).available === "boolean" &&
        Array.isArray((agent as PersonAllowedAgent).providers) &&
        (agent as PersonAllowedAgent).providers.every((id) => typeof id === "string")
    ) &&
    (candidate.defaultAgent === null || typeof candidate.defaultAgent === "string") &&
    (candidate.execution === "sandboxed" || candidate.execution === "none") &&
    // Every field this Host version answers with; a policy without them is
    // not one this brain was built against (same-version release).
    isModels(candidate.models) &&
    isUsage(candidate.usage) &&
    typeof candidate.resumeAfterRestart === "boolean"
  )
}

export async function fetchPersonAgentPolicy(
  transport: PolicyTransport
): Promise<PersonAgentPolicy> {
  const policy = await transport.call<unknown>("person_agent_policy_get", {})
  if (!isPolicy(policy))
    throw Object.assign(new Error("person_agent_policy_invalid"), {
      code: "execution_isolation_unavailable",
    })
  const models = copyModels(policy.models)
  const modelNames = readModelNames(policy.modelNames, models)
  const modelPricing = readPersonModelPricing(policy.modelPricing, models)
  // Every read refreshes the prices this brain books member usage at, so a
  // turn is priced at what the deployment charged when it ran.
  rememberPersonModelPricing(modelPricing)
  return {
    allowedAgents: policy.allowedAgents.map((agent) => ({
      runtimeId: agent.runtimeId,
      available: agent.available,
      providers: [...agent.providers],
    })),
    defaultAgent: policy.defaultAgent,
    execution: policy.execution,
    models,
    ...(Object.keys(modelNames).length > 0 ? { modelNames } : {}),
    ...(Object.keys(modelPricing).length > 0 ? { modelPricing } : {}),
    usage: policy.usage === null ? null : { ...policy.usage },
    ...(policy.resumeAfterRestart === true ? { resumeAfterRestart: true as const } : {}),
  }
}

const PROBLEM_CODES: Record<PersonAgentProblem, string> = {
  "not-allowed": "org_agent_not_allowed",
  "execution-unavailable": "execution_isolation_unavailable",
  "no-key": "model_access_unavailable",
  "model-not-served": "model_access_unavailable",
  "chat-model-not-served": "model_access_unavailable",
}

export function resolvePersonAgent(
  session: Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">,
  policy: PersonAgentPolicy,
  toolLessAvailable: boolean
): PersonAgentResolution {
  const resolved = resolvePersonTurn(session, policy)
  const chat =
    resolved.kind === "chat" ||
    (resolved.kind === "refused" && resolved.problem === "chat-model-not-served")
  // No agent and no tool-less chat on this Host: nothing can run the turn,
  // whatever model it names.
  if (chat && !toolLessAvailable)
    return { kind: "refused", code: "execution_isolation_unavailable" }
  switch (resolved.kind) {
    case "agent":
      return {
        kind: "agent",
        runtimeId: resolved.runtimeId,
        provider: resolved.provider,
        model: resolved.model,
      }
    case "chat":
      return { kind: "tool-less" }
    case "refused":
      return { kind: "refused", code: PROBLEM_CODES[resolved.problem] }
  }
}
