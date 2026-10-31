---
title: "0243 — A run acts for someone, and says who"
description: "Every agent run names whose authority its data access uses: the requester's own authorization (delegated), a service identity, or one person's credential bound to a Bot and narrowed to what that person declared. Data read through a person's authorization stays theirs. It is marked, the mark follows it through child runs, tool results and history, and it leaves only for that person or through a disclosure they grant themselves. Children inherit one authority that only tightens, and budgets are one pool for the whole run tree."
---

# ADR 0243 — A run acts for someone, and says who

**Status:** Proposed
**Date:** 2026-10-30
**Related:** [ADR-0009](./0009-platform-connectors) (connectors), [ADR-0026](./0026-builtin-skills-and-lark-cli-bridge) (built-in skills; its 2026-10-30 amendment is the first step of this ADR), [ADR-0149](./0149-a-person-is-not-a-device) (person, user, membership), [ADR-0174](./0174-the-bot-control-plane) (Bot installations and their policy fold), [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (capability grants), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (the always-on Host), [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request) (outbound authorization)

## Context

Three questions are answered in different places, from different sources, and nothing ties the answers together:

1. **Who may use it.** Feishu senders are admitted against a principal registry (`lib/connectors/principal/resolve.ts`). Other platforms, and Feishu with the registry flag off, resolve as `legacy`.
2. **Whose credentials it uses.** A connector stores one user token per adapter. d74e413ff1 added a gate (`lib/skills/built-in/lark/acting-identity.ts`): the Lark skills read the live senders of the turn and refuse anyone but the connected user, so nobody else can use personal features. A Bot installation binds credential slots to integration accounts (`credentialBindings`). It has no field naming a person, and its `owner` is the machine that runs it (`lib/placement/ownership.ts`).
3. **How far it may go.** The Bot policy fold (`lib/bot/policy/ceilings.ts`) caps authority, autonomy, write approval, budgets and an unattended profile. The capability grant (ADR-0198) caps tools, skills, MCP servers and mode.

The requester reaches some decisions, from three different sources:
- **Live inbound jobs.** The Lark gate reads the turn's senders from them. Outbound planning (`lib/policy/action-review/resolve-request-origin.ts`) rebuilds its requester from the newest running inbound job through `lib/workflow/runtime/trigger-origin.ts`.
- **The persisted `run.initiator`.** It authorizes run control (approve, deny, stop) in `lib/execution/run-control.ts`, including for Bot runs. Scheduled Bot runs have none (`lib/scheduler/executors/bot-executor.ts`).
- **The shared-run coordinator,** for a collaborative session's member.

Webhook actors have no principal (`lib/bot/sources/integration-event.ts`).

What is missing:

- **Confidentiality.** A group reply is authorized by chat id alone (`sameChat` in `lib/policy/action-review/plan-delivery.ts`). Writes to shared documents are not outbound tools at all (`lib/policy/risk/outbound-tools.ts`). Nothing follows data read through one person's authorization into later replies, child results or the conversation history, which connectors reuse per conversation.
- **One authority across child agents.** The ceiling recorded for nested agents keeps only the mode and tool lists, in memory (`dispatch-context-registry.ts`). Nested dispatch already shares a subtree token budget and deadline (`lib/claude/agents/dispatch-budget.ts`). But that is not unified with MCP limits, the subagent list, the unattended profile, the Bot cost cap or persistence:
  - external subagents lose the parent's deny list (`lib/plugin/agent-sdk/dispatch.ts`);
  - a plugin's `permissionMode` overwrites the resolved mode after the cap (`lib/plugin/api/agent-turn.ts`);
  - Bot squads and workflows receive only the mode;
  - `maxRunCostUsd` is enforced only in the external-agent API.
- **Who may approve.** The `initiator` actor scope also admits configured operators (`lib/connectors/callback-authorization.ts`).

Org members on a multi-tenant Host already run in person partitions with org-owned keys, sandboxed tools and no connector tokens (ADR-0149 and the multi-user organization plan). This ADR does not change that path, and a paired Host carries the records it introduces like any other brain data.

## Decision

### 1. Words

- **Requester**: a person whose message or action started the run or was absorbed into it (a steered message).
- **Event actor**: someone outside Cognia whose action triggered a run, such as a GitHub commenter or a webhook sender. An event actor is never a principal.
- **Authorizing principal**: the person who authorized a run that has no requester: whoever created or armed a schedule, or confirmed a binding.
- **Acting principal**: whose authority the run's data access uses.
- **Credential lane**: how the acting principal is chosen, one of three below.
- **Transport identity**: the identity a connector uses to carry a message (a Lark bot token, say). It is never used to read or write data.
- **Audience**: the people a delivery or a write will reach.
- **Personal mark**: a label saying "this content came from <person>'s own authorization".

### 2. A run names its identity once; its authority only tightens

A run carries an `ActingIdentityV1`, persisted on the `ExecutionRun`, with two parts:

- **Fixed at start:** the lane, the acting principal, the authorizing principal when there is no requester, and for a bound person the binding id. These never change.
- **Monotonic:** the requesters and an authority revision. When a steered message from another person is absorbed, the run first tightens its authority (a second requester removes personal access), then accepts the message. Every credentialed call, every resume and every child launch checks the latest revision.

The snapshot never grants on its own. Each call also checks, live:
- the current credential authorization epoch, as the d74e413ff1 gate does;
- for a bound person, the current binding and consent revision.

A revoked or narrowed binding takes effect on the next call, including for parked and resumed runs.

Data access reads the acting identity, and only the acting identity, to pick a credential:
- a tool never picks one by adapter id alone;
- one lane never falls through to another;
- a missing credential is a refusal.

Carrying a message is separate. The transport identity may deliver what the planner (§5) has already decided, to the audience it decided. It cannot widen that audience, and it carries no data access of its own. That is how a delegated run still sends a Lark ephemeral card through the bot.

### 3. Three lanes

**Delegated (on behalf of the requester).** The run uses the requester's own authorization. Credentials are stored per connection and per principal.

A requester who has not authorized gets an authorization link through the most private route the conversation supports:
1. a Lark ephemeral card, in a verified ordinary group;
2. otherwise the conversation itself, when it is a direct chat with that person;
3. otherwise a direct message;
4. otherwise a notice in the chat saying where to authorize.

The callback accepts the token only if the identity that signed in is the requester the link was issued to.

A turn with more than one requester has no single principal, so its personal calls are refused. The local desktop person is the delegated principal of their own sessions.

A run with no requester is delegated only for its authorizing principal. That covers "every morning, summarize my calendar into my DM", set up by that person.

**Service.** The run uses a service identity: the app's tenant token, a GitHub App, or a service account. It never uses a person's token. What it may reach is the intersection of:
- what the platform granted that identity;
- the resources, actions and recipients the installation declares.

The tenant token is reachable for data only through this lane.

**Bound person.** A Bot installation may bind one person's own credential, for example a GitHub token, under three conditions:
- that person confirms the binding;
- the console labels the installation "runs as <person>";
- the binding carries a declared scope: the actions, resource selectors and recipients that person allows when the run was not started by them.

Runs that person requests, or schedules they authorized, behave as delegated. Runs started by anyone else, including event actors, may use only the declared scope. There is no unscoped binding.

The declared scope is also that person's standing disclosure. Content read inside it may go to the declared recipients, which is what lets a Bot answer an issue commenter. Content outside it cannot be read at all.

**Which trigger may use which lane.** This is checked when the run is admitted, not left to the installation's choice:

| Trigger | Delegated | Service | Bound person |
| --- | --- | --- | --- |
| A requester's own message or action | as that requester | yes | as delegated when the requester is the bound person, otherwise the declared scope |
| A schedule or fixed task a person set up | as that authorizing principal | yes | as delegated when the authorizing principal is the bound person, otherwise the declared scope |
| An external event (webhook, integration event) | **never** | yes | the declared scope only |

The existing run-control check on `run.initiator` stays as it is. It answers who may steer a run, not whose authority the run uses.

### 4. The lane is a setting a person switches

The lane is chosen per IM adapter and per Bot installation, by the operator. Changing it is a person-written setting: it advances `humanRevision` and an agent cannot write it.

- **IM assistants** default to delegated.
- **Bot definitions** declare which lanes each credential slot accepts. Nothing defaults to the installer's own credential.

### 5. Personal data stays with its person

**Marking.** Content returned by a personal-lane read carries a personal mark naming the person. The mark propagates:
- to the run;
- to tool results built from marked content;
- to a child's result returned to its parent;
- to messages persisted in the conversation history.

**Who reads the history.** Each turn has an effective reader:
- with requesters, the full set of them;
- without, the verified authorizing principal that the trigger table allows;
- service and event runs have no personal reader.

Marked content is visible only when every effective reader is the marked person, or a disclosure covers them. Otherwise the context builder replaces it with a placeholder naming whose it is. So a second person cannot ask the assistant to repeat someone else's private answer, and a parent cannot launder a child's personal read.

**Engines forget too.** Engines keep their own memory: the SDK resume session, the AI SDK runner's history, an external agent's native session (`lib/chat/turn-route/history.ts`). Filtering the stored transcript alone is not enough. The visibility revision is part of the runtime session identity. When it tightens, the turn does not resume the old engine session: it is rebuilt from the filtered canonical history through the existing transcript invalidation (`hooks/chat/claude-chat-send-options.ts`). This applies to native, AI SDK, external and CLI lanes, and on a paired Host.

**Every sink, not only deliveries.** A run carrying a person's mark may send or write content only:
- to a destination whose actual audience is shown to be that person alone at write time: a direct chat with them, an ephemeral card to them, a document whose permission list is them alone;
- under a disclosure that person grants.

Owning a resource is not enough: a document the person owns but shares with a team is a team audience.

That covers replies, document and sheet writes, integration actions, webhooks and HTTP calls, and uploads. A sink whose audience cannot be determined is withheld until a disclosure is granted.

Opaque egress is different. Shell, scripts and arbitrary fetch can send content other than what was approved, so a disclosure cannot unlock them. A marked run gets no network egress from shell or sandboxed tools. Its content leaves only through sinks that send fixed content, where the disclosure's content hash is checked at the moment of sending.

**Delivery.** Private results go to the marked person, not automatically to the requester. They reach the requester directly only when:
- the requester is the marked person; or
- an exact disclosure, or a bound person's declared scope, covers them.

Otherwise the result, and the disclosure request, go to the marked person: an ephemeral card where available, otherwise a direct message, otherwise withheld with a notice.

**Disclosure.** The narrowed card offers **Share to the group**. Disclosure is checked strictly against the marked person, with no operator exception. That is a new actor scope, not the existing `initiator` one, because that one also admits operators. A disclosure is bound to the exact content (by hash) and the exact target, and is recorded on the action-review receipt. For a bound person, the target must also be within the declared recipients.

Service-lane output follows ADR-0239's recipient grants unchanged. This guard does not wait behind ADR-0239's shadow mode, because the failure mode of a shadowed confidentiality check is the leak itself.

### 6. One authority for the whole run tree

A run's authority is one `RunAuthorityV1`: the acting identity plus every capped field:
- mode;
- tool allow and deny lists;
- skills;
- the MCP server set;
- the subagent list;
- the unattended profile;
- limits.

Fields that bound a single execution meet as follows:
- modes take the less privileged;
- allow lists intersect;
- deny lists union;
- a per-execution turn cap takes the minimum.

No field is "inner wins". A value set after resolution (a plugin's `permissionMode`, a teammate's `add` overlay, a grant's `tools.add`) is met with the authority; it never replaces it.

Pools are not split. Tokens, cost and wall-clock time are one persisted ledger for the whole run tree. It extends today's subtree token budget with the Bot cost cap:
- children reserve from the ledger before they start;
- retries and resumes draw from the same pool;
- the deadline is absolute and does not reset on resume.

Under a finite pool, every execution needs a bound that can be enforced. An engine whose spend cannot be metered or capped is refused, not merely stripped of tools, because a tool-less engine still spends model tokens. Unknown spend is never settled as zero. A reservation is released only after the execution has been confirmed to stop.

The authority is persisted with the run and passed whole to every way a run starts another agent: native subagents, teammates, squads, workflow agent nodes, external and ACP agents, and plugin agent turns. A test enumerates those launch paths. Bot policy reaches every child through it.

An engine that cannot express a field must translate it or have the affected tools withheld; it never drops the field.

Children inherit the acting identity, including its live revision, and never switch lane.

A person's credential never leaves the Host:
- External engines do not receive personal tokens in their environment or MCP configuration.
- Personal-lane access from an external engine goes through a Host broker that checks resource, action and recipient on every call.
- An engine is admitted to a personal lane only with full credential and execution isolation:
  - its own native accounts, the OS keychain, its configuration directories and credential helpers are unreachable;
  - it runs with a Host-provided MCP configuration only;
  - its direct API egress is limited to the broker and its model endpoint.
- An engine that cannot be isolated this way is refused. This extends the existing refusal for engines whose native keychain accounts are shared (`crates/cognia-external-agent/src/process.rs`).

## Considered options

- **Keep running as whoever's credential is bound** (before d74e413ff1). Rejected: being allowed to use a bot then means borrowing someone else's access.
- **Read with the owner's token after checking the requester's access.** Rejected: platform permission APIs answer for the calling identity, so the check needs the requester's own token anyway, and the read still uses the owner's access.
- **Check every group member's access to each resource before posting.** Rejected as the default: it needs the member list and a permission query per resource, races with membership changes, and not every platform offers the query. It may come later as an alternative to narrowing.
- **Mark only deliveries.** Rejected: a summary written to a shared document, or repeated in a later turn, leaks the same data without a delivery.
- **Hand an external engine the token of an allowed server.** Rejected: a server allow-list does not narrow what the token itself can reach, so the declared scope would be unenforceable.
- **Only service identities on Bots.** Rejected: existing Bots run on a person's token, and a scoped binding gives the same safety for triggers by others.

## Consequences

- Each person who wants personal features from a chat authorizes once. Until then they get a private authorization link instead of an answer.
- Group answers built on personal data become private by default. Sharing them is one press by that person.
- A run that read personal data cannot write the result to shared places without that person's disclosure. This is the main new friction, and it is deliberate.
- The refusal of personal calls in agent-team runs started from chat goes away. Teammates inherit the persisted identity instead of re-deriving it.
- Platforms without per-user OAuth offer the delegated lane only to the local person. Platforms without ephemeral messages narrow by direct message.

**Migration.**
- An existing Bot binding to a personal credential becomes bound-person only when the provider subject (for example the GitHub login behind a token) maps to a known person and that person confirms. Every other binding moves to `needs_setup` with a console problem.
- A person's existing scheduled tasks keep running as delegated only where their creator can be verified. The others move to `needs_setup`.
- Pairing migration (ADR-0224) carries these authorization records with the installation.
- **History saved before marking has no mark, and is not treated as public.** Before d74e413ff1, every personal read in a connector conversation used the token of the adapter's connected user. So existing history in a connector-bound conversation is marked as that person's, and those sessions' engine transcripts are invalidated. Where no connected user can be named, the history stays visible only to the people who were its requesters, or a new requester starts a fresh session.

## Rollout

Nothing widens access until the guards that bound it are in force.

1. Identity and authority types persisted on `ExecutionRun`, the live revision and epoch checks, and the transport identity split. Every entry sets them. No behaviour change.
2. Confidentiality, enforced:
   - the personal mark and its propagation through children, tool results and history;
   - history withholding;
   - audience narrowing and the sink checks;
   - the strict disclosure scope.
   Today only the owner has personal access, so this lands before anyone else gains it.
3. The run-tree authority across every launch path, the shared ledger, and the broker and configuration isolation for external engines.
4. The delegated lane opens: the per-principal credential store, the authorization link and its routes, and the callback identity check (Lark first). This replaces the owner-only gate. It ships only after the legacy-history marking and transcript invalidation above have run.
5. The bound-person lane: confirmation, declared scope, console labels, and migration with `needs_setup`.
6. Other platforms, as each gains per-user authorization.

Before phases 4 and 5 ship, the attack scenarios behind this ADR run as acceptance tests:
- a steer by a second person;
- a child laundering a personal read;
- a repeat request from a later turn;
- a summary written to a shared document;
- operator sharing;
- a revoked binding while a run is parked;
- a parallel-children budget;
- token export to an external CLI;
- a Lark direct chat without ephemeral support;
- a resumed engine session after a second requester joins;
- old history in a migrated conversation;
- a bound-person read triggered by someone else;
- a webhook against a delegated installation;
- shell egress after a disclosure;
- a summary written to a document the person owns but shares;
- an unmetered engine under a finite budget.

## Implementation status

Phase 1A records acting identity and resolved run authority on `ExecutionRun` in observe mode. Credential selection and existing refusals remain unchanged; revision mismatches are recorded privately and do not block execution. Children retain the parent's fixed identity (including its original trigger); when that identity is unavailable they record a `child` trigger with no inferred principal. Enforcement and shared pool accounting remain later rollout steps.

New identities name their `rootRunId`; children keep historical identity snapshots while live observations and requester absorption use the root. Metadata recording leaves `updatedAt` unchanged, skips unchanged values, and reaches other devices with the run's next real update. Automatic sources without known human provenance record `external-event`.

Phase 1B labels every tenant-token use by purpose (`transport`, `service-data`, or `adapter-admin`), without changing credential selection or request behavior.

Phase 2-0 closes the child-binding and model-minted-binding holes: child skills inherit root IM rules, model/tool surfaces lose callback binding hints, only dispatcher-issued bindings confirm skills, and conversation-scoped callbacks require matching keys on both sides. Personal Lark access requires a verified local desktop session root or the existing IM owner check; session-less Squad runs retain non-personal skills with unverified personal authority. Phase 3 will restore personal access for locally started Squads through persisted run identity.


### Phase 2-0 fix 6 — host cards and session creation audit (2026-10-31)

Workflow run and fan-out approval cards are sent by the Host through governed in-thread delivery after their bindings are recorded. Both APIs re-read the named session's IM origin, reject target mismatches, and use only the Host's live initiator. Workflow-ai supplies its current tool session; the existing `connectors:send` plugin capability remains the boundary for selecting a stored IM session. The workflow-ai tools return `sent: true` acknowledgements without a `surface`, and instruct the model not to re-emit the card. `prepareWorkflowApproval` retains its existing surface fields for contract compatibility. There is no model-relay registry, issuance window or asynchronous projection. Model/tool projection removes every `binding*` hint and every namespace-shaped callback value, including prefixes unknown to the Host. Direct Host builders keep their callbacks. Plugins cannot register dispatcher-only `skill_invoke` bindings.

A confirmation stores the durable root session id; a click after child cleanup hydrates that root and uses the clicker's sender identity. A persisted local team root has the same personal-lane proof as a direct desktop conversation. Session-less Squad runtime remains unverified. The new `programmaticCreator` field is non-indexed and needs no Dexie version change; it never grants `runPluginAgentTurn` ownership.

The audit below enumerates chat-session `createSession` / `sessions.add` callers under `lib/`, `hooks/` and `components/`, plus lifecycle adapters and the shared/Host row projections encountered while tracing them. Classification is about the entry, not its display title; a child follows durable root ancestry before personal authority is decided.

| Entry point | Classification | Durable proof / delegation |
| --- | --- | --- |
| `lib/plugin/agent-sdk/session.ts` — `createPluginAgentSession` / resume | programmatic, marked | `plugin-agent-sdk`; resume stamps legacy rows before another send |
| `lib/ai/agent/agent-executor.ts` — temporary tool session | programmatic, marked | `plugin-agent-executor` |
| `lib/plugin/api/session-api.ts` — `ctx.session.createSession` | programmatic, marked | `plugin:<id>`; awaited durable row and cache use the same id |
| `lib/plugin/api/session-seed.ts` — `startSeededSession` | programmatic, marked | `plugin-seed`, including workflow session nodes |
| `lib/plugin/api/agent-turn.ts` — owned agent turn | programmatic, marked | Existing `agentTurnOwner`; creator markers grant no adoption rights |
| `lib/workflow/nodes/teams/index.ts` — character-send session | programmatic, marked | `workflow` |
| `lib/ai/agent/team/teammate/dispatch-teammate.ts` — tool-enabled teammate | programmatic, marked | `team-teammate`; registered run ancestry still resolves the root |
| `lib/ai/eval/targets/chat.ts` — default evaluation dependency | programmatic, marked | `evaluation` |
| `lib/agent/composition/verified-fresh-agent.ts` — verification session and DB adapter | programmatic, marked | `verification-agent`; adapter forwards the seed |
| `lib/harness/runtime/editor-runner.ts` — agentic editor | programmatic, marked | `harness-editor` |
| `lib/harness/runtime/probe-runner.ts` — probe, surface discovery, DB adapter | programmatic, marked | `harness-probe`; adapter forwards the seed |
| `lib/best-of-n/runtime.ts` — candidate rows / `sessions.add` | programmatic, marked | `best-of-n` on the shared native/external candidate row |
| `lib/scheduler/executors/index.ts` — scheduled chat/team | programmatic, marked | `scheduler` |
| `lib/scheduler/executors/goal-executor.ts` — scheduled goal | programmatic, marked | `scheduler-goal` |
| `lib/integrations/events.ts` — projected inbox thread | programmatic, marked | `integration-event` and existing `integrationBinding` |
| `lib/connectors/session-bindings.ts` — `createPlatformSession` / `sessions.add` | programmatic, marked | `connector` and existing `platformBinding` |
| `lib/connectors/commands/dispatch.ts` — both command creation branches | programmatic, marked | Delegates to `createPlatformSession` |
| `lib/db/background-tasks.ts` — admitted persistent child / `sessions.add` | programmatic, marked | `background-task` plus parent/attached-child ancestry |
| `lib/sync/host-state-store.ts` — `session.create` and `session.import` / `sessions.add` | programmatic, marked | `host-state` on both rows |
| `lib/browser-companion/service.ts` — agent/session creation branches | programmatic, marked | `browser-companion` |
| `lib/browser-companion/host-dispatch.ts` — production session adapter | programmatic, marked | Stamps `browser-companion` at the Host boundary |
| `lib/files-library/remote/host-dispatch.ts` — new attachment conversation | programmatic, marked | `remote-files` |
| `lib/router-fusion/api/run-api-host.ts` — session port | programmatic, marked | `run-api` and existing gateway `origin` |
| `lib/skills/recording/controller.ts` — controlled trial | programmatic, marked | `skill-trial` |
| `lib/dev/expose-test-globals.tsx` — anchor/performance and staged fixtures | programmatic, marked | `dev-fixture` on both creation branches |
| `lib/project-coordinator/thread-session.ts` — thread creation adapter | programmatic, marked | `project-thread`, then attached-child ancestry |
| `lib/db/sessions.ts` — `createSession` | trusted desktop UI entry / programmatic, marked | Shared persistence primitive; retains the caller seed verbatim |
| `lib/db/sessions.ts` — `forkSessionFromParent` | trusted desktop UI entry / programmatic, marked | Inherits creator/owner/origin/integration provenance; legacy IM/shared/default-plugin forks get `nonlocal-fork` |
| `lib/chat/start-session.ts` — `startNewSession` | trusted desktop UI entry / programmatic, marked | Shared lifecycle owner; preserves `programmaticCreator` |
| `hooks/chat/use-sessions.ts` — `create` | trusted desktop UI entry | Forwards the explicit new-conversation seed |
| `components/desktop/desktop-chat-workspace.tsx` — New Team Conversation | trusted desktop UI entry | Persisted unbound `kind: team` root; member ids decode to it |
| `components/goal/goal-quick-create-dialog.tsx` | trusted desktop UI entry | User submits a goal |
| `components/onboarding/flow.tsx` | trusted desktop UI entry | User selects the first task |
| `components/settings/chat-templates-section.tsx` | trusted desktop UI entry | User chooses a template |
| `lib/files-library/use-in-chat.ts` — `resolveUseInChatTarget` | trusted desktop UI entry | User sends a selected file to chat |
| `lib/pet/chat/seed-main-chat.ts` | trusted desktop UI entry | User hands pet text to the main-chat draft |
| `lib/shell/start-guild-conversation.ts` — both new-conversation branches | trusted desktop UI entry | Explicit shell agent/team conversation actions |
| `components/workspace/workspace-recent-conversations.tsx` | trusted desktop UI entry | Workspace new-chat action |
| `components/providers/initializers/selection-toolbar-initializer.tsx` — both branches | trusted desktop UI entry | Selection-toolbar handoff |
| `components/settings/data/webdav-sync-card.tsx` | trusted desktop UI entry | User requests setup help |
| `components/data/export/schedule-card.tsx` | trusted desktop UI entry | User requests cloud setup help |
| `components/settings/agent-runtime/sdk-session-manager.tsx` | trusted desktop UI entry | User explicitly continues a native SDK conversation |
| `lib/ai/agent/external/session/open-native-session-in-chat.ts` — chat adapter | trusted desktop UI entry | User explicitly continues a selected native agent session |
| `components/providers/initializers/tray-panel-initializer.tsx` | trusted desktop UI entry | Tray handoff |
| `components/providers/tauri-provider.tsx` | trusted desktop UI entry | Launch new-chat action |
| `hooks/system/use-tauri-events.ts` | trusted desktop UI entry | Native new-chat menu event |
| `hooks/agents/use-start-agent-chat.ts` | trusted desktop UI entry | User starts an agent chat |
| `hooks/codeserver/use-code-server-chat-bridge.ts` — staging session | trusted desktop UI entry | Editor handoff stages selected diagnostics/files |
| `components/chat/message-im-actions.tsx` | trusted desktop UI entry | Continue quoted IM text locally, staged for the operator |
| `components/chat/composer.tsx` and `components/chat/composer/bottom-toolbar.tsx` | trusted desktop UI entry | Composer launch/runtime choices |
| `components/agents/builder/agent-builder-setup.tsx` — session adapter | trusted desktop UI entry | User opens the agent builder |
| `lib/project-coordinator/coordinator-session.ts` | trusted desktop UI entry | User enables/opens the workspace coordinator |
| `lib/slash-commands/actions/issue.ts` | trusted desktop UI entry | User opens an issue conversation and stages its prompt |
| `lib/slash-commands/actions/sessions.ts` and `lib/slash-commands/builtin.ts` | trusted desktop UI entry | New-chat actions delegate to the host UI callback |
| `lib/collab/shared-chat-sync.ts` — shared row projection | programmatic, marked | `shared-chat`; legacy `collaboration` also refuses local personal authority |
| `lib/sync/host-state-service.ts` — new summary rows | programmatic, marked | `host-state`; existing rows retain their original provenance |

The similarly named calls in `lib/browser/{agent-engine,document-viewer-session,local-client,shared-local-browser}.ts`, `hooks/browser/use-local-browser-session.ts`, `lib/ai/agent/external/manager.ts`, `hooks/agent/use-external-agent.ts`, `lib/canvas/collaboration/crdt-store.ts`, `lib/plugin/api/canvas-api.ts`, `hooks/canvas/use-collaborative-session.ts`, `lib/plugin/api/external-agent-api.ts` and `lib/integrations/github-auth.ts` create browser, external-engine, CRDT or OAuth sessions, not `ChatSession` rows. The `sessions.add` calls under `lib/usage/` and the external manager are `Set.add`. Branches/asides use their existing `parentSessionId` / session `surfaceBinding` lineage; editor/resource workbenches are desktop UI entry points. Import/restore writers were not changed by this creator-field audit.

**Residual risk.** Legacy plugin rows with default titles, `agentTurnOwner`, `origin` or `integrationBinding` are refused without a migration. Resuming through the plugin agent SDK stamps missing provenance before execution, and SDK forks preserve known nonlocal provenance. A legacy plugin-created session with a custom/renamed title and no surviving provenance remains indistinguishable from a desktop row until it is resumed through that SDK; this audit does not infer ownership from arbitrary titles or blanket-relabel existing sessions. Local queue/binding tests do not prove live IM provider delivery.

**Generated contract.** `scripts/plugin/generate-contract.mjs` owns the Rust CLI catalog, Python contract, TypeScript resource effects, plugin-point catalog and plugin-dev API reference. The sandbox blocks the tsx CLI's IPC socket, so generation/check invoke the same exported `generate` function with child tsx execution routed through `node --import tsx`. `pnpm i18n:build` includes the codeserver extension NLS outputs. `crates/cognia-cli/assets/author-types.json` is owned by another session and was not regenerated; its staged declaration has no `prepareFanoutApproval`, so a later `pnpm author-types:bundle` must add that method (and the `sent` result field).
