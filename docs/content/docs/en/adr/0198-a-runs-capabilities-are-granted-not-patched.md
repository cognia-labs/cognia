---
title: "0198 — A run's capabilities are granted, not patched"
description: "Agent launchers in the scheduler, workflow nodes, plugins, bots and subagent dispatch edited SendOptions after resolution. This bypassed the tool filter, Restricted Mode, parent ceiling and finalizer. Scheduled tasks could replace the agent's deny list. Adds the versioned AgentCapabilityGrantV1 contract as input to resolveSendOptions. Applies each grant field at the resolution stage of the profile field it extends."
---

# ADR 0198 — A run's capabilities are granted, not patched

**Status:** Accepted
**Date:** 2026-09-27
**Amended:** 2026-11-07, modules contribute grants (see the amendment at the end)
**Related:** [ADR-0117](./0117-composed-agent-modes-and-creator) (composition axes), [ADR-0161](./0161-agent-identity-runtime-and-host) (identity, runtime, placement), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (the unified execution service), [ADR-0002](./0002-scheduler-full-agent-resolution) (scheduled runs resolve the full agent)

## Context

An agent profile (`Character`) says what an agent is. The features that launch
agents also need to say what one run may additionally use or must do without:
a scheduled task needs its report skill, a workflow step wants one MCP server
and a stricter permission mode, a plugin wants a prompt fragment.

None of them had an input for that. `resolveSendOptions` only read the
character, the session, the mode and a few surface-specific fields. So each
caller patched the result:

- The scheduler assigned `model`, `permissionMode`, `maxTurns` and `effort`,
  unioned `allowedTools`, **replaced** `disallowedTools`, swapped in an MCP map
  and spliced an ad-hoc skill into the system prompt, all after the resolver
  returned (`applyPayloadOverrides`, `applyAdHocSkill`).
- `executeAgent` unioned the run's deny list and appended system text after
  resolving, and ignored the caller's `model`, `allowedTools` and `maxSteps`
  whenever a `characterId` was given.
- Plugin and bot turns could only pick a character and a permission mode.

Patching after the resolver skips everything the resolver enforces at the end:
the tool filter, Restricted Mode, the parent permission ceiling, and the
finalizer that seals the tool surface. The scheduler's replace semantics
dropped the character's denials, the tool filter's, the MCP servers' deny
rules and the IM safeguard, and its `permissionMode` bypassed the whole chain.
The payload model was assigned after provider selection. A task could
therefore send an Anthropic model id to another provider.

Separately, `resolveTurnAgentMode` never read `ctx.compositionSelection`, so a
connector turn's own composition only reached the transcript stamp while its
prompt delta, tools and authority came from the desktop composer's last choice.

## Decision

### One contract

`packages/agent-config-types/src/agent-capability-grant.ts` defines
`AgentCapabilityGrantV1`:

| Field | Applied where | Direction |
| --- | --- | --- |
| `model`, `provider`, `effort` | head of their resolver chains | replaces, then routed normally |
| `maxTurns` | after the execution policy | replaces |
| `instructions[]` | appended to `appendSystemPrompt` | adds; never replaces the prompt |
| `skills.add` / `.remove` | joins the character's skills / the session's disables | adds / narrows |
| `mcpServers.only` / `.add` / `.remove` | the MCP subset, drawn only from enabled servers | narrows / adds / narrows |
| `tools.add` | the allow list, like a skill's declared tools | adds |
| `tools.deny` | the deny list, re-applied after the plugin hook | narrows |
| `tools.restrictTo` | intersects the allow list after the plugin hook | narrows |
| `knowledgeBases.add` | agent knowledge retrieval | adds |
| `subagents.only` | the native subagent map, after every branch registered it and before `@agent` routing | narrows |
| `permissionMode` | a cap on the resolved mode | narrows only |

`BuildOptionsContext.capabilityGrants` takes an ordered list. The pure helpers
`mergeCapabilityGrants` / `foldCapabilityGrants` compose layers so that denials
are a union no later layer can undo, `restrictTo`, `mcpServers.only` and
`subagents.only` intersect, and permission caps keep the less privileged value.

### Additions are allowed and still clamped

A grant may add a tool, skill, MCP server or knowledge base the character did
not list. Every addition enters before the tool filter, Restricted Mode, the
parent ceiling and `finalizeToolSurface`, so it can never exceed them. An MCP id
that is not enabled in the run's workspace is ignored, never switched on.

### Callers

- **Scheduler:** `buildSchedulerCapabilityGrant` turns the payload into one
  grant. `disallowedTools` now joins the deny list and `permissionMode` is a
  cap. The skill task's skill rides `ephemeralSkillIds`. A deleted agent or a
  skill that is enabled nowhere fails the run instead of running a
  persona-less default.
- **`executeAgent`:** its own knobs become a grant (`executeAgentConfigGrant`):
  with a `characterId`, `model` heads the chain and `allowedTools` restricts.
  `maxSteps` finally reaches the run as `maxTurns`, and `capabilityGrants`
  passes through. The text rail speaks as the named agent. The tool rail builds
  retrieval deps when the agent or a grant binds a knowledge base or a twin.
  User-level memory stays a chat-surface feature.
- **Workflow `action.agent.turn`:** extra skills, MCP servers, knowledge bases,
  denied tools, instructions and a permission cap, with instructions going
  through the node's egress guard.
- **Agent teams:** a teammate's resolved `subagentIds` narrow the team
  session's native subagents with `subagents.only`. An empty list keeps the
  whole team surface, as for MCP servers.
- **Plugins and bots:** `runPluginAgentTurn` and `ctx.agent.run` accept
  `capabilityGrants` (validated, with the caller stamped as source) and a
  composition. Bots pass their whole projected composition.

`resolveTurnAgentMode` takes a caller-owned `selection`, which fixes the
connector split-brain above.

## Consequences

- A run's customisation is one reviewable value, traceable to the feature that
  issued it, and resolved by the same code as the profile it customises.
- Scheduled tasks that relied on `disallowedTools` replacing the agent's
  denials, or on `permissionMode` widening it, now run narrower. That is the
  intended change.
- `runPluginAgentTurn`'s explicit `permissionMode` is still an assignment. It
  is the documented way for a headless plugin to answer "who approves?", and it
  stays a decision at the call site.
- The frozen execution spec (ADR-0090) is still derived from the caller's
  `provider` and `model` fields, not from the agent profile. It drives capability
  gating and the fingerprint, not dispatch.

## Amendment (2026-11-07): modules contribute grants

A feature module that customises every run it applies to, rather than one run
a caller launches, contributes grants through its manifest
(`capabilityContributions`, [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds)
§14, M3). This adds a grant source, not a resolution stage: contributed grants
are folded with the caller's where `capabilityGrants` were already folded, and
each field is applied at the stage the table above assigns it.

- **Contract.** A module's manifest names a file (`capabilityContributions:
  { load: () => import("./…") }`) that exports `contributions`, a list of
  `{ id, failure, produce(ctx) }` (`lib/modules/manifest-types.ts`). `produce`
  returns a grant or `null` from a read-only `CapabilityContributionContext`:
  the session, the resolved agent, the settings, the active goal the caller
  passed, and the run's frozen Prompt Center view. It gets no `SendOptions`
  and no caller dependencies.
- **Fields.** A contribution may set `instructions`, `skills`, `mcpServers`,
  `tools`, `knowledgeBases`, `subagents`, `permissionMode` and
  `maxBudgetUsd`. It may not set `model`, `provider`, `effort`, `maxTurns` or
  `permissionProfile`: those are the caller's choices for its run, and a grant
  naming one is refused. The kernel stamps the source
  `{ kind: "module", id: "<module>/<contribution>" }`.
- **Order.** The caller's grants, then contributions in module id order and
  manifest order, then the resolver's own (the read-only aside). Every
  permitted field composes the same way in any order under
  `mergeCapabilityGrants`, except `instructions`, which are appended in this
  order.
- **Failure.** Contributions run concurrently under one deadline
  (`CAPABILITY_CONTRIBUTION_DEADLINE_MS`). A contribution declares what a
  failure (a throw, the deadline, a refused grant) means. `"skip"` leaves it
  out and reports it; such a contribution may only add, and one that sets a
  narrowing field (a deny list, `restrictTo`, a removal, `only`, a permission
  cap, a budget) is refused, because losing it silently would widen the run.
  `"refuse-turn"` fails the resolution, and is required for anything that
  narrows. A contribution file that does not load fails the resolution too,
  since it might hold a narrowing contribution; the next resolution retries
  it. An `experimental` module contributes nothing.
- **Where.** Wherever `resolveSendOptions` runs (the desktop renderer, the
  headless brain), and in `resolveSessionAsideReadOnly`, so a contributed
  permission cap binds an aside's authority too. The generated registry
  `lib/modules/generated/capabilities.ts` holds one lazy import per
  contributing file and nothing else; the resolver
  (`lib/claude/capability-contributions.ts`) imports no module. The
  person-chat and chat-participant paths return before any grant is folded and
  take no contributions.

Pilots: `browser-companion` (the agent-mode instruction it used to build inside
the resolver, `"skip"`) and `goal` (an active goal's section as an instruction
and its per-turn USD ceiling as the budget, `"refuse-turn"`). The goal's section
now follows the active plan's section and the caller's instructions, where
grant instructions are appended.

Per-turn retrieved context (memory, knowledge bases, project knowledge, twin)
and in-process tools with their rulesets are not grants. They stay out of this
amendment and get their own contracts: ADR-0250's `tools`, and a context
contribution still to be decided.
