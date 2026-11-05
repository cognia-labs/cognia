/**
 * An org member's agent choices on a shared Host (P6g, plan §9b.6).
 *
 * The member's person brain declares them on its `host_feature_manifest`
 * (`personAgents`): the agents the org allows, the models the org serves them
 * with, and the member's own month. {@link resolvePersonTurn} is how a turn is
 * resolved, on both sides: the brain runs it on the policy it reads for the
 * turn (`lib/headless/person-agent/policy.ts`), the composer on the manifest,
 * so it can say up front what a turn would be refused for instead of failing
 * it.
 *
 * A conversation's agent is fixed when it is created (`agentRuntimeId` on the
 * HostState seed); choosing another agent starts a new conversation. Its model
 * is not: a pick from {@link personServedModels} reaches the Host as a
 * `session.model` intent and the next turn runs on it.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"

type SessionChoice = Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">

/** Why a turn on this conversation would be refused, as the brain decides it. */
export type PersonAgentProblem =
  | "not-allowed"
  | "execution-unavailable"
  | "no-key"
  | "model-not-served"
  /** Tool-less chat on a model the org serves no key or deployment for. */
  | "chat-model-not-served"

/**
 * What a member's turn is resolved from: the org's agent policy as the Host
 * answers it (`person_agent_policy_get`), which the person brain also
 * declares to its devices as `personAgents`.
 */
export interface PersonAgentFacts {
  allowedAgents: readonly {
    runtimeId: string
    /** Whether an org credential covers the agent's model family. */
    available: boolean
    /** Provider ids whose org credential can run this agent. */
    providers: readonly string[]
  }[]
  defaultAgent: string | null
  execution: "sandboxed" | "none"
  /** Per provider, the model ids the Host's deployment serves. */
  models: Readonly<Record<string, readonly string[]>>
}

export type PersonTurnResolution =
  | { kind: "agent"; runtimeId: string; explicit: boolean; provider: string; model: string }
  | { kind: "chat"; provider?: string; model?: string }
  | { kind: "refused"; problem: PersonAgentProblem; runtimeId?: string; explicit?: boolean }

/**
 * How a member's turn runs, or why it is refused (ADR-0253 D09).
 *
 * 1. The conversation's own `agentRuntimeId`, else the org default.
 * 2. Neither: tool-less chat, on a model the org serves.
 * 3. An agent the org does not allow is refused; a conversation that named
 *    an agent never falls back to another one.
 * 4. Execution unavailable on this Host, no org credential for the agent, or
 *    a provider or model the org does not serve it with: refused.
 *
 * The Host enforces the same facts again at the ticket mint and the task
 * lease; this only makes the refusal come first and read the same everywhere.
 */
export function resolvePersonTurn(
  session: SessionChoice,
  facts: PersonAgentFacts
): PersonTurnResolution {
  const explicit = !!session.agentRuntimeId
  const runtimeId = session.agentRuntimeId ?? facts.defaultAgent ?? undefined
  const provider = session.providerOverride
  const model = session.model
  const served = (id: string | undefined) =>
    !!id && !!model && (facts.models[id]?.includes(model) ?? false)
  if (!runtimeId) {
    if (!served(provider)) return { kind: "refused", problem: "chat-model-not-served" }
    return { kind: "chat", provider: provider!, model: model! }
  }
  const refused = (problem: PersonAgentProblem): PersonTurnResolution => ({
    kind: "refused",
    problem,
    runtimeId,
    explicit,
  })
  const agent = facts.allowedAgents.find((entry) => entry.runtimeId === runtimeId)
  if (!agent) return refused("not-allowed")
  if (facts.execution !== "sandboxed") return refused("execution-unavailable")
  if (!agent.available || agent.providers.length === 0) return refused("no-key")
  if (!provider || !agent.providers.includes(provider) || !served(provider))
    return refused("model-not-served")
  return { kind: "agent", runtimeId, explicit, provider, model: model! }
}

export type PersonConversationAgent =
  | {
      kind: "agent"
      runtimeId: string
      /** `false` when the conversation takes the org default. */
      explicit: boolean
      problem?: PersonAgentProblem
    }
  /** No agent named and no org default: tool-less chat. */
  | { kind: "chat"; problem?: "chat-model-not-served" }

/** The conversation's agent (or chat) as the composer shows it, with what a turn would hit. */
export function personConversationAgent(
  session: SessionChoice,
  agents: PersonAgentsManifest
): PersonConversationAgent {
  const resolved = resolvePersonTurn(session, agents)
  switch (resolved.kind) {
    case "agent":
      return { kind: "agent", runtimeId: resolved.runtimeId, explicit: resolved.explicit }
    case "chat":
      return { kind: "chat" }
    case "refused":
      return resolved.runtimeId === undefined
        ? { kind: "chat", problem: "chat-model-not-served" }
        : {
            kind: "agent",
            runtimeId: resolved.runtimeId,
            explicit: resolved.explicit ?? false,
            problem: resolved.problem,
          }
  }
}

export interface PersonAgentSeed {
  agentRuntimeId: string
  providerOverride: string
  model: string
}

/**
 * The seed for a new conversation with `runtimeId`. Keeps the current
 * provider and model when the org serves them for that agent, else takes the
 * first model the org serves. `null` when the agent cannot run at all.
 */
export function personAgentSeed(
  agents: PersonAgentsManifest,
  runtimeId: string,
  current: Pick<ChatSession, "providerOverride" | "model"> = {}
): PersonAgentSeed | null {
  const agent = agents.allowedAgents.find((entry) => entry.runtimeId === runtimeId)
  if (!agent || !agent.available || agents.execution !== "sandboxed") return null
  const pick = pickServedModel(personServedModels(agents, { agentRuntimeId: runtimeId }), current)
  return pick ? { agentRuntimeId: runtimeId, ...pick } : null
}

/** One provider the org serves a member's conversation with, and its models. */
export interface PersonServedProvider {
  provider: string
  models: string[]
  /** The deployment's display name for each model that has one, by id. */
  names: Record<string, string>
}

/**
 * The models the org serves this conversation with, by provider, in the
 * Host's order: the agent's own providers for an agent conversation (the
 * lease admits no other), every provider the org holds a key for for
 * tool-less chat (the ticket mint admits any of them). `session` empty means
 * a conversation not yet created, which takes the org default.
 */
export function personServedModels(
  agents: PersonAgentsManifest,
  session: SessionChoice
): PersonServedProvider[] {
  const current = personConversationAgent(session, agents)
  const providers =
    current.kind === "agent"
      ? (agents.allowedAgents.find((entry) => entry.runtimeId === current.runtimeId)?.providers ??
        [])
      : Object.keys(agents.models)
  return providers.flatMap((provider) => {
    const models = agents.models[provider] ?? []
    return models.length > 0
      ? [{ provider, models: [...models], names: { ...agents.modelNames?.[provider] } }]
      : []
  })
}

/**
 * The provider and model a member's new conversation starts on: the current
 * pick when the org serves it, else the app default when the org serves that,
 * else the first model the org serves. `null` when the org serves nothing
 * here, so the caller keeps its own default and the composer says why a turn
 * would be refused. The one default pick (ADR-0253 D08): the composer names
 * what `startNewSession` seeds, because both ask here.
 */
export function personDefaultModel(
  agents: PersonAgentsManifest,
  current: Pick<ChatSession, "providerOverride" | "model"> = {},
  appDefault: { provider?: string; model?: string } = {}
): { providerOverride: string; model: string } | null {
  return pickServedModel(personServedModels(agents, {}), {
    providerOverride: current.providerOverride ?? appDefault.provider,
    model: current.model ?? appDefault.model,
  })
}

/** `current` when one of `served` holds it, else the first served model. */
function pickServedModel(
  served: readonly PersonServedProvider[],
  current: Pick<ChatSession, "providerOverride" | "model">
): { providerOverride: string; model: string } | null {
  const { providerOverride, model } = current
  if (
    providerOverride &&
    model &&
    served.some((entry) => entry.provider === providerOverride && entry.models.includes(model))
  )
    return { providerOverride, model }
  const first = served[0]
  return first ? { providerOverride: first.provider, model: first.models[0] } : null
}

export type PersonAllowance =
  /** The Host keeps no usage ledger. */
  | { kind: "unknown" }
  | { kind: "unlimited"; spentTokens: number }
  | { kind: "left"; tokens: number; monthlyTokens: number }
  | { kind: "used-up"; monthlyTokens: number }

/** What is left of the member's month; tokens held by running turns count as spent. */
export function personAllowance(agents: PersonAgentsManifest): PersonAllowance {
  const usage = agents.usage
  if (!usage) return { kind: "unknown" }
  if (usage.monthlyTokens === null) return { kind: "unlimited", spentTokens: usage.spentTokens }
  const left = usage.monthlyTokens - usage.spentTokens - usage.reservedTokens
  return left > 0
    ? { kind: "left", tokens: left, monthlyTokens: usage.monthlyTokens }
    : { kind: "used-up", monthlyTokens: usage.monthlyTokens }
}
