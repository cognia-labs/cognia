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

| Trigger                                        | Delegated                     | Service | Bound person                                                                                  |
| ---------------------------------------------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| A requester's own message or action            | as that requester             | yes     | as delegated when the requester is the bound person, otherwise the declared scope             |
| A schedule or fixed task a person set up       | as that authorizing principal | yes     | as delegated when the authorizing principal is the bound person, otherwise the declared scope |
| An external event (webhook, integration event) | **never**                     | yes     | the declared scope only                                                                       |

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

Phase 2A-1 (2026-11-04): Personal credential admission now commits an unindexed `ExecutionRun.personalMarks` mark and a private `personal.marked` journal event on the executing run and every structural ancestor through its identity root before releasing a credential; a failed commit refuses admission. Mark events use the private observation sequence (`seq: 0`), leaving run status, control revisions, timestamps, snapshots and notification projections unchanged. The person is `local-person` for local roots/direct Host UI, or the platform principal retained by the exact verified Lark owner authorization. Marks deduplicate by person identity and credential source, keeping the earliest read. Run-level taint covers tool-bearing and assistant messages, child/teammate results (including blackboard, plan and delegation paths), and framed background-result user turns. Host writers bind generated message identities to their exact runs; persistence reads Host run state afresh, including delayed streaming writes, and merges existing `metadata.personalMarks` so later turns cannot erase earlier marks or inherit unrelated session taint. Staged cloud-document attachments conservatively stamp the attaching user message as `local-person`; their existing Host-local credential admission is unchanged. The IM assistant-row writer is the shared SDK event handler (`hooks/chat/claude-chat-events.ts`), not `run-and-capture.ts`; HostState builtin dispatch uses the correlated desktop writer or its headless terminal-event owner (`lib/work-submission/terminal-events.ts`), and the headless person-agent writer binds its action's execution.

Legacy connector history is resolved at read time by the pure `effectivePersonalMarks(message, session, context)`: explicit marks win; otherwise a connector-bound row without `metadata.personalMarkVersion: 1` is marked as the adapter's Host-resolved bound/connected person, never its sender/requester. Every new connector row (including ingress, ordinary full/delta writes, manual Inbox and paired sends) carries that per-message version marker. Updates take the version only from the stored row, including a legacy row with no metadata; incoming metadata cannot add or strip that version. Only new Host-bound rows or new rows carried from trusted sync/import copies may receive a version. Imported platform history has no Host marking-version proof and is conservatively treated as legacy history, regardless of its local insertion date. A per-message marker avoids a session watermark race across concurrent writers and classifies old/new rows without a Dexie upgrade, timestamp cutoff or backfill. The phase-2B caller must resolve the bound person before evaluating legacy rows. Portable copies materialize that legacy mark at export/read time, since account sync deliberately omits connector bindings: a connected Lark or Slack identity is used when available, and older adapters without a connected platform identity conservatively name the Host local person. Source rows are never rewritten. Metadata conflict merges, stale backup/import/handoff replacements and paired-history updates retain already known marks, independently of ordinary metadata conflict resolution. Metadata survives account-sync capture, backup streaming/restore, imported conversations, thread handoff (including canonical source/target conversion and its sequence digest) and paired history/projections; execution-run copies retain their existing table policy. Shared collaboration chat's allowlist is unchanged and remains a phase-2C sink residual. This phase records provenance only: history withholding, engine rebuild and enforcement remain phase 2B; sink/audience enforcement remains phase 2C. There is no schema-version bump, new UI or intentional visible behavior change.

Phase 2A-0 ADR-0246 port (2026-11-02): Google remains Rust-owned; the personal gate now protects auth.google Host connection credential reads, native snapshots and OAuth completion/device polling that may call userinfo, and token revocation. Refused disconnects leave the connection intact; unproven background cleanup makes no Google user call. Unproven background reconciliation uses published metadata and performs no user-authenticated snapshot; Settings, picker, staging and dock previews pass Host-local proof, including legacy `default` binding resolution. Provider plugins reading their own Host-managed sessions outside a run are classified as plugin-held token material (like `auth:exchange`), inventoried for phase 5/6. Inside a run, owner and consumer reads use the Host-held tool/command invocation and its exact attempt, never plugin-supplied fields. Each credential read pins its captured proof/read identity before its first await; later invocations can only restrict it. Only a Host-created child job with a verified persisted parent, plugin owner and exact identity root may overlap its parent tool binding; siblings and unrelated invocations still refuse. Lazy activation, dependency activation and fallback command recipients inherit that Host binding; actual callbacks retain it through timeout until settlement. Consumer operation grants are required both outside and inside runs, including every non-owner credential read; inside runs the personal-credential decision is additionally required. Raw Host-managed session reads do not carry an operation grant and cannot substitute a local-person run or transitional token-read policy for one. Explicit Bot bindings remain phase 5. Reconciliation locks, identity propagation and job settlement remain intact.

Phase 2A-0 Host callback binding (2026-11-04): The owner exception applies only outside Host dispatch. Every Host callback is bound by the plugin whose code executes, including cross-plugin interceptors and issue-sync providers. The existing invocation mechanism retains the exact Host execution context, or opaque `LOCAL_PERSON_RUN` for a proven direct UI action, through actual callback settlement (including timeouts, cancellation races and iterator steps). Runless Host background work uses `HOST_BACKGROUND` (`executionRunId: ""`), which refuses personal credentials; it cannot borrow an awaiting local invocation. Host proof is stripped from plugin arguments. Scheduled issue sync, backup, reconciliation, visibility updates and uncorrelated hooks do not become outside-dispatch owner reads. Imperative context registrations and exported contributions/factory results share that fence; callbacks preserve synchronous contracts, constructors and class receivers. Native Python/WASM calls, Python contribution streams, VS Code extension callbacks and frontend IDE providers use the same binding through transport settlement. Host database migration callbacks use the background sentinel. RPC and library imports pin their initiating identity before waiting for consent, activation or loading; a later local invocation cannot replace it. Library disposal is Host background work, while later exported-method calls bind their own invocation. Backup wrappers retain the exact operation identity across nested calls; Host sign-in carries its captured authority through authorize, exchange and describe, with opaque local proof from the Settings action. Existing integration jobs, tool attempts, workflow integration nodes, command provenance and the scheduler executor retain their dispatch bindings. Plugin self-initiated timers, activation and panel UI code have no Host binding outside dispatch: their plugin-held credentials remain a phase 5/6 residual, not a protection claimed by 2A-0. No schema or persisted-field changes; live provider and desktop acceptance remain unverified.

Phase 2A-0 review round 6 (2026-11-01): Skill confirmation cards enqueue with the dispatcher's resolved exact session/run, including child routes; unknown runs remain unproven. Owner confirmations retain Lark send-as-user admission after the originating turn ends. Bulk outbound deletion shares one transaction for execution settlement, queue deletion and Host tombstones, preserving completed executions and unrelated jobs. Adapter removal and workspace deletion use that owner; companion retention, sync tombstones and host-change clearing also use it without echoing tombstones or settling mirrored Host executions. Host-change cleanup settles local jobs before clearing execution summaries. Integration account removal already settles its deleted jobs atomically; a regression now pins that path. No schema or persisted-field changes; live provider sends remain unverified.

### Phase 2A-0 bulk-delete audit (round 6)

| Production delete/clear path                                                                                       | Settlement                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/db/outbound-jobs.ts`: retention sweep and single cancel/veto                                                  | Shared `deleteOutboundJobs` transaction; terminal outcome preserved, active/missing jobs cancelled, Host tombstones recorded.                                                                       |
| `lib/connectors/adapter-residue.ts`: `removeAdapterInstance` → reaper, compound adapter/status range               | Shared deletion transaction; other adapters remain untouched.                                                                                                                                       |
| `lib/db/project-scope.ts`: workspace cascade, dynamic project-table delete                                         | Shared deletion inside the workspace transaction, which includes execution/event/projection tables.                                                                                                 |
| `lib/sync/handlers/outbound-queue.ts`: aged projection `bulkDelete` and `base.ts` default tombstone deletion       | Both routed through shared deletion with no echoed tombstones; private journal ownership is required for settlement.                                                                                |
| `lib/sync/companion-sync.ts`: dynamic host-change `clear`                                                          | Outbound deletion precedes generic execution-summary clearing; no echoed tombstones.                                                                                                                |
| `lib/db/integrations.ts`: unbound account removal, `integrationActionJobs.where("accountId").equals(...).delete()` | Existing transaction settles terminal outcomes/cancels active executions before deletion. Bound-account security records are retained. No other production integration-job bulk delete/clear found. |

Dynamic account-sync replacement addresses only sessions, messages, characters, skills, memories and settings; plugin-table clears address namespaced plugin stores. Neither deletes these job tables. Full database reset deletes jobs and their journals together. Test-fixture clears are test-only.

Phase 2A-0 review round 5 (2026-11-01): Connector dispatch binds tool IPC to the Host-created current journal execution, including each recovery `:attempt`; stable provider identity remains routing data and never supplies admission. Builtin skills and nested agent dispatch ignore wire `runId`. Batch delivery forwards Host enqueue options; `im.broadcast`, `im.send_voice`, `im.create_chat` first messages and `im.dispatch_task` briefs use the existing Host-resolved exact run/session scope, including child routes. Reroutes inherit the original delivery job's execution before settling it; persisted addresses without a topic also reroute safely. A direct UI operation may continue its original integration job only with opaque Host local admission, matching account/action/input/key, and a local-person root on that job itself. Jobs rooted in another run still require the same verified root; serialized person/source labels grant nothing. No persisted fields or schema changes. Regression tests exercise recovery dispatch through real `sendPrompt` and tool IPC, real enqueue/runner/Lark admission, and real integration enqueue/approval/replay. Live provider sends are unverified.

### Phase 2A-0 outbound producer audit (round 5)

This inventory includes aliases and dependency-injected wrappers of `enqueueGoverned` / `enqueueGovernedMany`. `none` means an unproven external-event job, never personal permission: these bot/system notices have no verified personal execution and must refuse send-as-user. Delivery-policy approval is not credential admission.

| Caller under `lib/`                                           | Host execution passed at enqueue                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `connectors/inbox-writes/local.ts` (reply and draft approval) | Exact session plus opaque local UI admission; paired writes carry no local proof.                          |
| `connectors/runtime.ts` (direct and draft replies)            | Exact current session and execution attempt; failure notices carry none.                                   |
| `connectors/outbound-runner.ts` (failover and balance)        | Exact original `execution:job:outbound:<id>`, inherited before settlement.                                 |
| `connectors/presence/usage-status-runner.ts`                  | Explicit service automation, without personal admission.                                                   |
| `skills/built-in/im/broadcast.ts`                             | Host-resolved exact run/session scope through batch options, plus cancellation.                            |
| `skills/built-in/dispatcher.ts`                               | Exact Host-resolved session/run for the skill-confirmation card (round 6); unknown scopes remain unproven. |
| `connectors/hitl/ask-user-question.ts`                        | None; bot question cards and their state edits.                                                            |
| `connectors/hitl/tool-approval.ts`                            | None; bot tool-approval card.                                                                              |
| `connectors/hitl/plan-approval.ts`                            | None; bot plan-approval card.                                                                              |
| `connectors/hitl/workflow-run-approval.ts`                    | None; bot workflow-approval card.                                                                          |
| `connectors/hitl/media-grant.ts`                              | None; bot media-grant card.                                                                                |
| `connectors/hitl/approval-card-state.ts`                      | None; bot approval-card state edit.                                                                        |
| `connectors/commands/handoff.ts`                              | None; command handoff notice.                                                                              |
| `connectors/commands/dispatch.ts`                             | None; command result notice.                                                                               |
| `connectors/commands/goal.ts`                                 | None; headless goal result notice, without verified personal execution.                                    |
| `connectors/help/help-dispatch.ts`                            | None; bot help/welcome cards.                                                                              |
| `connectors/callback-authorization.ts`                        | None; callback refusal notice.                                                                             |
| `connectors/follow-up-control.ts`                             | None; run-control acknowledgement.                                                                         |
| `connectors/principal/unbound.ts`                             | None; unbound-requester notice.                                                                            |
| `connectors/adapters/lark/menu-actions.ts`                    | None; bot menu/link notices.                                                                               |
| `connectors/run-presentation/runner.ts`                       | None; bot progress/result presentation, without adopting metadata run ids.                                 |
| `a2ui/workflow-fanout-handler.ts`                             | None; workflow callback acknowledgement.                                                                   |
| `a2ui/workflow-approval-handler.ts`                           | None; workflow callback acknowledgement.                                                                   |
| `plugin/api/workflow-author-api.ts`                           | None; plugin-requested bot confirmation card.                                                              |
| `issues/im/propose.ts`                                        | None; issue confirmation card via its enqueue wrapper.                                                     |
| `issues/im/push.ts`                                           | None; issue result cards via their enqueue wrapper.                                                        |

The related `enqueueAuthorized` skill producers `skills/built-in/im/send-voice.ts`, `create-chat.ts` and `dispatch-task.ts` also forward the Host-resolved exact scope. Unknown scopes explicitly refuse rather than guessing a session's active run.

Phase 2A-0 review round 4 (2026-11-01): IM recovery persists only its verified same-session/source parent; workflow retries verify the source workflow before linking or inheriting. Integration idempotent hits verify account, action, canonical input and the caller's identity root inside the enqueue transaction, including concurrent hits; unknown or different roots refuse cached output and dispatch. Verified Bot bindings and Host approval/retry continuations retain their original identity; generic local UI proof cannot adopt an existing job. Held Squad publication commits durable and execution completion together on success or failure; stop/cancel retains its terminal journal path, uses conditional durable writes across child-control waits and honors a publication that settled first. The chat settlement watcher releases on each terminal outcome. A declined publication remains a resumable hold until approved or stopped.

Phase 2A-0 (2026-11-01): One Host personal-credential admission reuses persisted identity roots, including the existing Lark IM-owner exception; unknown, service, external-event and unproven scheduled runs refuse personal access. Direct Host UI actions carry the opaque local-person admission instead of an invented run. Lark send-as-user resolves the exact Host-enqueued delivery execution through send and refresh; persisted source/message/card labels never grant personal admission. Local Inbox UI binds opaque proof at enqueue, paired Inbox RPC stays unproven, scheduled pushes record an unproven schedule, and presence/escalation jobs record service identity. IM `continue_safely` attempts and their delivery jobs inherit the original identity root even when attempts share a source message; missing or non-owner identities refuse without bot fallback, and token/epoch snapshots remain atomic. Automatically mounted MCP Apps resolve the exact tool-call execution from the Host journal and additionally require ephemeral Host builtin-dispatch proof; unknown, external-engine and terminal history loads refuse OAuth and remain unloaded. Mounting a card never grants local-person admission. MCP OAuth servers and tool namespaces are withheld on refusal, external engines receive no personal OAuth configuration, and retained AI-SDK contexts rebuild when their MCP credential map cannot be verified. Integration HTTP reads/writes and builtin Issue Loop git credentials use that admission before provider/connection credential resolution; user-scoped connections, legacy PAT/OAuth providers and unclassified legacy providers are personal, while verified bot/service connections and the Host GitHub App installation provider remain service. Ambient GitHub PAT and `gh auth token` fallbacks refuse without admission. Deferred integration jobs atomically receive their own execution row at enqueue, inherit the exact identity root, and keep it live through approval/retry until terminal settlement; `actor: person` does not grant credentials. Job terminal transitions and execution settlement share the owning DB transaction, covering outbound deletion/veto, receipts and queue caps, integration cancellation and expired-claim recovery. Policy-denied jobs create no live execution; startup drains reconcile terminal or missing jobs without closing held/retry work. An explicit execution id admits a standalone local-person Squad without a session; a supplied session must still match. Squad publishing/parking runs inside the real lifecycle completion hook before durable/execution settlement, and Aside OAuth admission uses only the final routed runtime after fallback. The credential inventory covers typed/aliased Lark auth snapshots and their native command; existing account setup and admitted token/epoch checks are explicitly reviewed. No new persisted fields are added. Explicit operator-selected Bot `credentialBindings` are unchanged in this slice; their bound-person consent, scope and `needs_setup` migration belongs to phase 5. Document providers, twin API/CLI ingest, Lark user HTTP and ambient connector personal-token probes use the same admission; unproven Slack presence-token use also refuses. Host proof is stripped before plugin callbacks. ADR-0246 Host user connections (including Lark), Host-managed user sessions, backup GitHub PATs and Drive OAuth use the same admission; manual backup UI forwards Host proof, unproven schedules refuse, and verified bot/service/app connections remain service. `auth:exchange` releases no stored personal token: the plugin supplies its authorization code or refresh token, the Host injects only its configured client secret (service), and plugin-held user token material is governed later in phase 5/6. No schema or persisted-field change; personal marking remains phase 2A-1.

Phase 2-0b (2026-10-31): Bot turns use installation/topic-owned app transcripts, persist ordinary user/reply messages and engine resume ids, and fence final reply/resume writes in one transcript-generation transaction; plugins share this persistence. Dedicated non-indexed `imAuthorityBinding` reaches root/child skill gates without exposing a delivery binding to composer, Inbox, history, projections or paired sync. Connector lookups retain ownership isolation, including legacy/indexed, active/private-thread, sibling/link and group-context paths. External senders remain event actors; Lark uses explicit app/service-data auth and final-result identity metadata, while personal/user-only actions explain phases 4 and 5. Unattended writes keep the approval park and wall-clock hold. Confirmed connector callbacks get a new host run and exact execution id; requester replays name the clicker, while Bot/plugin replays retain their original service lane. No Dexie schema change. Retries reuse the delivery/step user row while retaining distinct attempt ids and rebuilding history without that row; the capture owner persists full SDK/external tool and A2UI parts with the existing converters. QQ confirmation regressions cover completed or absent original-run provenance; its fixture supplies the production runtime translator. Fixes 3–5 (focused regressions verified): open Bot/plugin panes refresh from committed transcript revisions, and stale full writes retain omitted rows as connector writes do. Delivery targets reuse `deliveryTargetFromEvent` and are checked against the event's structured address and source message, without parsing conversation keys; topic session keys remain installation plus the event's opaque conversation key, including older queued events carrying only a target. Media is prepared before the generation-fenced reply transaction; valid SDK image/file and external artifact content can settle a media-only capture, while empty media cannot. Lark resolves run identity independently of the IM binding: external events, schedules and unbound runs default to explicit bot/service-data auth, a requester in a bound IM conversation keeps the delegated owner-checked default, local desktop defaults stay unchanged, and explicit user-only requests retain the personal-lane guard. The binding still pins the adapter. Concurrent first triggers lock lookup/create by caller, installation/topic key, character, cwd and IM authority, then serialize complete turns by the actual session id. Same-origin Web Locks cover windows/workers; the in-memory fallback covers one realm, while deterministic insert-only session ids make creation idempotent across contexts without a schema change, including new slots after an explicit cwd repin. Unbound Bot/plugin children inherit the root durable unattended approval park and cannot finish successfully while approval remains pending. Middleware-transformed text replaces captured prose and its derived codeblock surfaces/citations while retaining tools, media and non-prose surfaces; an otherwise empty filtered reply follows capture refusal semantics. The old engine context is invalidated before the filtered commit so subsequent turns rebuild from canonical history. Further review fixes distinguish opaque, request-bound human approval proof from automated permission allows; children inherit both interactive root cards and unattended root parks. Desktop send/regenerate/edit/steer respect published capture occupancy and whole-session admission shared with Bot/plugin turns. Operation completions are committed atomically with replies in the existing recovery journal, locked by operation namespace, and replay without model execution while completing lifecycle/usage settlement from the original booking and cost authority. Internal fallback/plan/steer continuations retain their turn lease; independent triggers acquire their own admission. Session deletion, message clearing/deletion and transcript truncation remove completion payloads and retain a non-replayable tombstone. Fixes 8–9: a content follow-up during the session's own running turn reaches steering or the queue, while a send refused for another owner throws so the composer keeps its input. The logical user row is checked (present, same session, role and content) before dispatch, inside the final commit and on failure; a changed row cancels the turn as a terminal, non-retryable cancellation. A pending operation record is written with the user row at admission and tombstoned when that row is removed, so a retry never revives a deleted prompt. Every intentional desktop removal passes explicit delete ids, while unknown rows from another writer survive a stale full write. Stop keeps the session lease until its interrupt command settles, so a late interrupt cannot reach the next turn. A background child keeps an approval route bound to its originating run and opens its own durable park after the parent turn ends; only a human approval satisfies it. A reply that middleware produced without dispatching to the engine leaves the engine history stale: no resume id is saved, the invalidation is not acknowledged, and the next turn rebuilds from the stored transcript. A Stop that fails before sending its interrupt lifts its admission fence. Permanently deleting a workspace tombstones its sessions' operation completions in the same transaction. A steer drain or next plan/goal/loop step decided while an SDK or HostState turn settles joins exactly the lease that held the session when the frame was handled, even before the dispatch returns; it re-enters admission when another turn has taken the session or a Stop is still pending, and a deferred step always does. The lease is held only across the synchronous steer drain, so the nested store notification from clearing the queue cannot release it before the replay joins; it is never held across a handler's awaits (such as a goal judge), so a new message can still take over. Stop fences the shared session admission before its first await, whether or not a desktop lease still exists, until its interrupt settles or Stop fails before sending it: nonblocking desktop admission and continuations are refused, and queued Bot/plugin turns wait, including behind a turn that held the lock when Stop began and behind overlapping Stops; a shared Web Lock carries the fence to other windows, and a synchronous failure on the way cannot leave it up. Each lease holds the stop barrier exclusively for its whole lifetime, so a Stop from any window queues its shared fence behind the running turn and is granted before any later admission; one shared lock is held per pending fence until its last overlapping Stop settles, a queued producer yields to a Stop requested behind it, joining an existing lease checks other windows' Stops, the target session is pinned at admission, and a producer that waited re-checks the account database. A dispatched turn that ends without committing (failure or a changed prompt row) invalidates the engine context so the next operation rebuilds from stored rows; the durable invalidation marker is written on the turn's own database even when closing the live runtime fails. Residual (pre-existing, unchanged here): Stop does not cancel a desktop send still in its async preparation before dispatch. A completion keeps its prompt and reply message ids and a digest of those rows: deleting or truncating other messages leaves its replay intact, while replay is refused once any of its rows is missing or changed by any writer, including plugin repositories and raw-table access that never tombstone.

Phase 2-0 fix 9 (2026-10-31): Personal Lark tokens now require the executing run's recorded root to have `trigger: local` and a `local-person` authorizing principal; the existing IM owner check is unchanged. Session bindings, creator markers and plugin invocation context remain refusals, never grants. Host sends bind the existing IPC turn/attempt to the exact run; an unknown correlation refuses, and uncorrelated calls require exactly one active run of any kind. Missing identities, roots, reads and account/target changes refuse. Children inherit their fixed root. Host-only admission uses an in-memory symbol, so caller-supplied origin labels cannot mint local authority. Authenticated paired chat and manual Squad UI actions act for the paired person and receive the same host admission; the remote Run API does not. Account sync's creator field and schema bump remain unchanged. Untrusted native/model content loses run-control routing fields, and the bus independently requires the persisted host run-card binding, matching adapter, conversation and platform message. A forged callback cannot consume a genuine card's dedup key.

### Fix 9 writer audit

| Writer                                                                | Trigger                                                                               | Reason                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct-chat-run.ts`                                                  | `local` only with host admission; otherwise `external-event`                          | Desktop send/edit/regenerate and typed queued follow-ups carry host proof; automatic continuations do not mint it.                                              |
| `acting-authority.ts:startToolExecutionRun`                           | Host `local`, inherited root for `child`, otherwise `external-event`                  | Minimal records for slash commands and local room members; foreground/background tools inherit an exact recorded parent.                                        |
| `work-submission/service.ts`                                          | Admitted `local`; connector `requester`; internal `child`; otherwise `external-event` | Chat adapters forward proof. Authenticated paired-turn and HostState chat admissions issue it; source labels and remote Run API input do not.                   |
| `squad-run-records.ts`                                                | Admitted `local`, inherited `child`, or classified origin                             | Desktop manual Start, typed `/squad` and authenticated paired manual Start issue proof. Plugin `runTeam` forces plugin origin, including a supplied `ui` value. |
| `agent-team-bridge.ts`, `durable-runtime.ts`, `legacy-run-history.ts` | `requester`, `schedule`, otherwise `external-event`                                   | Origin projection cannot create local proof; an existing admitted canonical run keeps its identity.                                                             |
| `workflow-bridge.ts`                                                  | `requester`, `schedule`, `child`, otherwise `external-event`                          | A manual-looking origin alone is insufficient, including automated workflow starts.                                                                             |
| `agent-state-bridge.ts`, `delegation.ts`                              | `requester`, `schedule`, otherwise `external-event`                                   | Unbound goal/plan/delegation records do not infer a local person.                                                                                               |
| `bot/runtime/run.ts`                                                  | `requester`, `schedule`, otherwise `external-event`                                   | Even manual/desktop Bot triggers are Bot automation.                                                                                                            |
| `security-scan-bridge.ts`, Fusion `outbox-appliers.ts`                | `external-event`                                                                      | Plugin scans and caller-supplied projection origins cannot mint proof.                                                                                          |
| `connectors/runtime.ts`                                               | `requester` or inherited `child`                                                      | Inbound sender or explicit recovery parent.                                                                                                                     |
| `job-bridge.ts`, `managed-desktop-results.ts`, `db/execution-runs.ts` | Inherited root or unproven `child`                                                    | Only recorded parents confer identity; a missing parent never confers local authority.                                                                          |
| `unattended-park.ts`                                                  | `schedule` or `child`                                                                 | Its private entry callers are scheduled or inherited unattended work.                                                                                           |
| `recordRunAuthority`                                                  | Unchanged                                                                             | Narrows recorded ceilings; never creates an identity or local trigger.                                                                                          |

### Fix 9 legitimate personal paths

- Desktop chat send, edit/resend and regenerate create an admitted direct-chat run. Automated goal/loop/background deliveries use the unadmitted core send.
- A typed follow-up queued during a turn retains host admission in memory until drain. A mixed or restored queue without that proof refuses personal access; an explicit new desktop send can admit a new run.
- Foreground and background children enter with the exact caller root; their IPC correlation names the canonical job run.
- Local team conversation member turns receive minimal admitted member entries before dispatch and settle them during cleanup.
- Desktop manual Squad Start, composer-started Squads, typed `/squad` and authenticated paired manual Start create admitted Squad roots; teammates inherit them.
- Typed `/lark` is registered in the host composer and creates a minimal admitted entry. Model/plugin slash invocation cannot supply the symbol.
- Desktop skills use the tool IPC entry and exact run context; plugin skills cannot borrow a desktop session. Authenticated paired chat and room UI paths follow the same person decision.

Validation: 42 touched suites / 1573 tests pass, including persisted-run, actual sync/branch/fork flows, production callback codecs and full bus-dispatch regressions. Minimal host entry creation and its first journal event commit atomically; failed admission leaves no active authority. Remaining acceptance limits: the required legacy `lark/auth-bridge.test.ts` positives lack execution runs and are outside the permitted Lark edit set; installed Lark CLI dry runs require unavailable keychain setup, and the checked-out dependency graph has missing packages. The expanded plugin checks also report missing staged artifacts under the out-of-scope `public/_cognia/builtin-plugins/` directory and failures in untouched compatibility/catalog tests; the expanded process subsequently exhausted its Node heap. No live provider or native UI acceptance is claimed.

Phase 2-0 fix 8 (2026-10-31): Native callback cleanup covers WeCom `button_list[].key` and QQ callback `action.data`, alongside Lark `value.actionId`, Slack `action_id`/`callback_id`, Discord `custom_id` and Telegram `callback_data`. Regression tests use real serializers and callback parsers; opaque cards are downgraded or rejected on Slack, Discord, Telegram, WeChat, DingTalk, Matrix and OneBot according to their existing contracts. WeChat personal numeric callbacks and QQ C2C callbacks retain trusted sender addresses; WeCom single-chat callbacks now use `from.userid` when `chatid` is absent, without relaxing conversation authorization. Lark/Slack callbacks without a chat address remain unverified; Discord requires a channel and Telegram requires an anchoring message. Account sync preserves `programmaticCreator` under `SYNC_SCHEMA_VERSION = 2` (ADR-0215 schema-skew parking); the pinned `@cognia/sync-protocol` accepts positive schema versions and arbitrary clocked fields, so no cognia-services wire-contract change or pin update is required. Paired-Host projection, backup/restore, session re-import and shared conversion retain nonlocal provenance; older backup overwrites and re-imports cannot erase a known marker. Synced/restored plugin roots still refuse the personal lane. No Dexie version change; real provider delivery remains unverified.

Phase 2-0 fix 7 (2026-10-31): Host workflow/fan-out approvals resolve the triggering session's complete conversation reference and delivery target, preserving topic anchors and refusing missing addresses. Lineage crosses row-less members/cleaned middle nodes using Host codecs/routes and validates the existing root, conflicts, cycles and depth. Scheduler task/execution persistence and both `im-push` and deferred `connection:outbound:send` delivery remove model/tool callback hints and namespaced values; digest replies use the same cleanup. Fan-out targets must match both their binding and the clicking conversation. Confirmation bindings persist the invoking session, workspace root, project and character while replay rehydrates root IM authority and verifies the clicker, including Lark personal-token checks after child cleanup. No index or Dexie version change. Local regressions use production Lark/Telegram serializers; live provider delivery remains unverified. Legacy confirmations without an execution snapshot retain their recorded root context.

Phase 1A records acting identity and resolved run authority on `ExecutionRun` in observe mode. Credential selection and existing refusals remain unchanged; revision mismatches are recorded privately and do not block execution. Children retain the parent's fixed identity (including its original trigger); when that identity is unavailable they record a `child` trigger with no inferred principal. Enforcement and shared pool accounting remain later rollout steps.

New identities name their `rootRunId`; children keep historical identity snapshots while live observations and requester absorption use the root. Metadata recording leaves `updatedAt` unchanged, skips unchanged values, and reaches other devices with the run's next real update. Automatic sources without known human provenance record `external-event`.

Phase 1B labels every tenant-token use by purpose (`transport`, `service-data`, or `adapter-admin`), without changing credential selection or request behavior.

Phase 2-0 closes the child-binding and model-minted-binding holes: child skills inherit root IM rules, model/tool surfaces lose callback binding hints, only dispatcher-issued bindings confirm skills, and conversation-scoped callbacks require matching keys on both sides. Personal Lark access requires a verified local desktop session root or the existing IM owner check; session-less Squad runs retain non-personal skills with unverified personal authority. Phase 3 will restore personal access for locally started Squads through persisted run identity.

### Phase 2-0 fix 6 — host cards and session creation audit (2026-10-31)

Workflow run and fan-out approval cards are sent by the Host through governed in-thread delivery after their bindings are recorded. Both APIs re-read the named session's IM origin, reject target mismatches, and use only the Host's live initiator. Workflow-ai supplies its current tool session; the existing `connectors:send` plugin capability remains the boundary for selecting a stored IM session. The workflow-ai tools return `sent: true` acknowledgements without a `surface`, and instruct the model not to re-emit the card. `prepareWorkflowApproval` retains its existing surface fields for contract compatibility. There is no model-relay registry, issuance window or asynchronous projection. Model/tool projection removes every `binding*` hint and every namespace-shaped callback value, including prefixes unknown to the Host. Direct Host builders keep their callbacks. Plugins cannot register dispatcher-only `skill_invoke` bindings.

A confirmation stores the durable root session id; a click after child cleanup hydrates that root and uses the clicker's sender identity. A persisted local team root has the same personal-lane proof as a direct desktop conversation. Session-less Squad runtime remains unverified. The new `programmaticCreator` field is non-indexed and needs no Dexie version change; it never grants `runPluginAgentTurn` ownership.

The audit below enumerates chat-session `createSession` / `sessions.add` callers under `lib/`, `hooks/` and `components/`, plus lifecycle adapters and the shared/Host row projections encountered while tracing them. Classification is about the entry, not its display title; a child follows durable root ancestry before personal authority is decided.

| Entry point                                                                             | Classification                                  | Durable proof / delegation                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/plugin/agent-sdk/session.ts` — `createPluginAgentSession` / resume                 | programmatic, marked                            | `plugin-agent-sdk`; resume stamps legacy rows before another send                                               |
| `lib/ai/agent/agent-executor.ts` — temporary tool session                               | programmatic, marked                            | `plugin-agent-executor`                                                                                         |
| `lib/plugin/api/session-api.ts` — `ctx.session.createSession`                           | programmatic, marked                            | `plugin:<id>`; awaited durable row and cache use the same id                                                    |
| `lib/plugin/api/session-seed.ts` — `startSeededSession`                                 | programmatic, marked                            | `plugin-seed`, including workflow session nodes                                                                 |
| `lib/plugin/api/agent-turn.ts` — owned agent turn                                       | programmatic, marked                            | Existing `agentTurnOwner`; creator markers grant no adoption rights                                             |
| `lib/workflow/nodes/teams/index.ts` — character-send session                            | programmatic, marked                            | `workflow`                                                                                                      |
| `lib/ai/agent/team/teammate/dispatch-teammate.ts` — tool-enabled teammate               | programmatic, marked                            | `team-teammate`; registered run ancestry still resolves the root                                                |
| `lib/ai/eval/targets/chat.ts` — default evaluation dependency                           | programmatic, marked                            | `evaluation`                                                                                                    |
| `lib/agent/composition/verified-fresh-agent.ts` — verification session and DB adapter   | programmatic, marked                            | `verification-agent`; adapter forwards the seed                                                                 |
| `lib/harness/runtime/editor-runner.ts` — agentic editor                                 | programmatic, marked                            | `harness-editor`                                                                                                |
| `lib/harness/runtime/probe-runner.ts` — probe, surface discovery, DB adapter            | programmatic, marked                            | `harness-probe`; adapter forwards the seed                                                                      |
| `lib/best-of-n/runtime.ts` — candidate rows / `sessions.add`                            | programmatic, marked                            | `best-of-n` on the shared native/external candidate row                                                         |
| `lib/scheduler/executors/index.ts` — scheduled chat/team                                | programmatic, marked                            | `scheduler`                                                                                                     |
| `lib/scheduler/executors/goal-executor.ts` — scheduled goal                             | programmatic, marked                            | `scheduler-goal`                                                                                                |
| `lib/integrations/events.ts` — projected inbox thread                                   | programmatic, marked                            | `integration-event` and existing `integrationBinding`                                                           |
| `lib/connectors/session-bindings.ts` — `createPlatformSession` / `sessions.add`         | programmatic, marked                            | `connector` and existing `platformBinding`                                                                      |
| `lib/connectors/commands/dispatch.ts` — both command creation branches                  | programmatic, marked                            | Delegates to `createPlatformSession`                                                                            |
| `lib/db/background-tasks.ts` — admitted persistent child / `sessions.add`               | programmatic, marked                            | `background-task` plus parent/attached-child ancestry                                                           |
| `lib/sync/host-state-store.ts` — `session.create` and `session.import` / `sessions.add` | programmatic, marked                            | `host-state` on both rows                                                                                       |
| `lib/browser-companion/service.ts` — agent/session creation branches                    | programmatic, marked                            | `browser-companion`                                                                                             |
| `lib/browser-companion/host-dispatch.ts` — production session adapter                   | programmatic, marked                            | Stamps `browser-companion` at the Host boundary                                                                 |
| `lib/files-library/remote/host-dispatch.ts` — new attachment conversation               | programmatic, marked                            | `remote-files`                                                                                                  |
| `lib/router-fusion/api/run-api-host.ts` — session port                                  | programmatic, marked                            | `run-api` and existing gateway `origin`                                                                         |
| `lib/skills/recording/controller.ts` — controlled trial                                 | programmatic, marked                            | `skill-trial`                                                                                                   |
| `lib/dev/expose-test-globals.tsx` — anchor/performance and staged fixtures              | programmatic, marked                            | `dev-fixture` on both creation branches                                                                         |
| `lib/project-coordinator/thread-session.ts` — thread creation adapter                   | programmatic, marked                            | `project-thread`, then attached-child ancestry                                                                  |
| `lib/db/sessions.ts` — `createSession`                                                  | trusted desktop UI entry / programmatic, marked | Shared persistence primitive; retains the caller seed verbatim                                                  |
| `lib/db/sessions.ts` — `forkSessionFromParent`                                          | trusted desktop UI entry / programmatic, marked | Inherits creator/owner/origin/integration provenance; legacy IM/shared/default-plugin forks get `nonlocal-fork` |
| `lib/chat/start-session.ts` — `startNewSession`                                         | trusted desktop UI entry / programmatic, marked | Shared lifecycle owner; preserves `programmaticCreator`                                                         |
| `hooks/chat/use-sessions.ts` — `create`                                                 | trusted desktop UI entry                        | Forwards the explicit new-conversation seed                                                                     |
| `components/desktop/desktop-chat-workspace.tsx` — New Team Conversation                 | trusted desktop UI entry                        | Persisted unbound `kind: team` root; member ids decode to it                                                    |
| `components/goal/goal-quick-create-dialog.tsx`                                          | trusted desktop UI entry                        | User submits a goal                                                                                             |
| `components/onboarding/flow.tsx`                                                        | trusted desktop UI entry                        | User selects the first task                                                                                     |
| `components/settings/chat-templates-section.tsx`                                        | trusted desktop UI entry                        | User chooses a template                                                                                         |
| `lib/files-library/use-in-chat.ts` — `resolveUseInChatTarget`                           | trusted desktop UI entry                        | User sends a selected file to chat                                                                              |
| `lib/pet/chat/seed-main-chat.ts`                                                        | trusted desktop UI entry                        | User hands pet text to the main-chat draft                                                                      |
| `lib/shell/start-guild-conversation.ts` — both new-conversation branches                | trusted desktop UI entry                        | Explicit shell agent/team conversation actions                                                                  |
| `components/workspace/workspace-recent-conversations.tsx`                               | trusted desktop UI entry                        | Workspace new-chat action                                                                                       |
| `components/providers/initializers/selection-toolbar-initializer.tsx` — both branches   | trusted desktop UI entry                        | Selection-toolbar handoff                                                                                       |
| `components/settings/data/webdav-sync-card.tsx`                                         | trusted desktop UI entry                        | User requests setup help                                                                                        |
| `components/data/export/schedule-card.tsx`                                              | trusted desktop UI entry                        | User requests cloud setup help                                                                                  |
| `components/settings/agent-runtime/sdk-session-manager.tsx`                             | trusted desktop UI entry                        | User explicitly continues a native SDK conversation                                                             |
| `lib/ai/agent/external/session/open-native-session-in-chat.ts` — chat adapter           | trusted desktop UI entry                        | User explicitly continues a selected native agent session                                                       |
| `components/providers/initializers/tray-panel-initializer.tsx`                          | trusted desktop UI entry                        | Tray handoff                                                                                                    |
| `components/providers/tauri-provider.tsx`                                               | trusted desktop UI entry                        | Launch new-chat action                                                                                          |
| `hooks/system/use-tauri-events.ts`                                                      | trusted desktop UI entry                        | Native new-chat menu event                                                                                      |
| `hooks/agents/use-start-agent-chat.ts`                                                  | trusted desktop UI entry                        | User starts an agent chat                                                                                       |
| `hooks/codeserver/use-code-server-chat-bridge.ts` — staging session                     | trusted desktop UI entry                        | Editor handoff stages selected diagnostics/files                                                                |
| `components/chat/message-im-actions.tsx`                                                | trusted desktop UI entry                        | Continue quoted IM text locally, staged for the operator                                                        |
| `components/chat/composer.tsx` and `components/chat/composer/bottom-toolbar.tsx`        | trusted desktop UI entry                        | Composer launch/runtime choices                                                                                 |
| `components/agents/builder/agent-builder-setup.tsx` — session adapter                   | trusted desktop UI entry                        | User opens the agent builder                                                                                    |
| `lib/project-coordinator/coordinator-session.ts`                                        | trusted desktop UI entry                        | User enables/opens the workspace coordinator                                                                    |
| `lib/slash-commands/actions/issue.ts`                                                   | trusted desktop UI entry                        | User opens an issue conversation and stages its prompt                                                          |
| `lib/slash-commands/actions/sessions.ts` and `lib/slash-commands/builtin.ts`            | trusted desktop UI entry                        | New-chat actions delegate to the host UI callback                                                               |
| `lib/collab/shared-chat-sync.ts` — shared row projection                                | programmatic, marked                            | `shared-chat`; legacy `collaboration` also refuses local personal authority                                     |
| `lib/sync/host-state-service.ts` — new summary rows                                     | programmatic, marked                            | `host-state`; existing rows retain their original provenance                                                    |

The similarly named calls in `lib/browser/{agent-engine,document-viewer-session,local-client,shared-local-browser}.ts`, `hooks/browser/use-local-browser-session.ts`, `lib/ai/agent/external/manager.ts`, `hooks/agent/use-external-agent.ts`, `lib/canvas/collaboration/crdt-store.ts`, `lib/plugin/api/canvas-api.ts`, `hooks/canvas/use-collaborative-session.ts`, `lib/plugin/api/external-agent-api.ts` and `lib/integrations/github-auth.ts` create browser, external-engine, CRDT or OAuth sessions, not `ChatSession` rows. The `sessions.add` calls under `lib/usage/` and the external manager are `Set.add`. Branches/asides use their existing `parentSessionId` / session `surfaceBinding` lineage; editor/resource workbenches are desktop UI entry points. Import/restore writers were not changed by this creator-field audit.

**Residual risk.** Legacy plugin rows with default titles, `agentTurnOwner`, `origin` or `integrationBinding` are refused without a migration. Resuming through the plugin agent SDK stamps missing provenance before execution, and SDK forks preserve known nonlocal provenance. A legacy plugin-created session with a custom/renamed title and no surviving provenance remains indistinguishable from a desktop row until it is resumed through that SDK; this audit does not infer ownership from arbitrary titles or blanket-relabel existing sessions. Local queue/binding tests do not prove live IM provider delivery.

**Generated contract.** `scripts/plugin/generate-contract.mjs` owns the Rust CLI catalog, Python contract, TypeScript resource effects, plugin-point catalog and plugin-dev API reference. The sandbox blocks the tsx CLI's IPC socket, so generation/check invoke the same exported `generate` function with child tsx execution routed through `node --import tsx`. `pnpm i18n:build` includes the codeserver extension NLS outputs. `crates/cognia-cli/assets/author-types.json` is owned by another session and was not regenerated; its staged declaration has no `prepareFanoutApproval`, so a later `pnpm author-types:bundle` must add that method (and the `sent` result field).
