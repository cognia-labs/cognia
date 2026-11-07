---
title: "0252 — A room talks, a Squad works, a delegation promises"
description: "Rooms, Squads and delegations stay three separate axes: a conversation shape, an executor and a commitment. Every asynchronous child of a run is one executionRuns row linked by parentRunId and started by one launcher, steered through one entry and controlled by one state machine. A room member can hand work to a Squad after a person in the room confirms it. ADR-0177's IM and shared-room batches are completed, ADR-0247 and ADR-0249 are adopted with the amendments recorded here, and the duplicate trackers, steer paths, control machines and dormant exports found by the 2026-11-05 audit are merged, wired or deleted."
---

# ADR 0252 — A room talks, a Squad works, a delegation promises

**Status:** Accepted
**Date:** 2026-11-05

**Related:**
- [ADR-0137](./0137-delegation-runtime): the `delegation` run kind, T0/T1/T2, steer, handoff to a person. Amended.
- [ADR-0140](./0140-squad-as-an-executor) and [ADR-0169](./0169-one-runtime-one-review-one-control-machine): the Squad as an executor with one runtime, one review and one control machine. Amended.
- [ADR-0177](./0177-a-room-is-one-conversation-shape): a room is one conversation shape with three memberships. Amended.
- [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads) and [ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent): adopted by this ADR with the amendments in §9.
- [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work): stays with ADR-0250 phase 1. §5 holds the person-first rule until then.
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds): this ADR brings forward the multi-agent part of phase 3 ("work spine") and follows §14's direction rules.
- [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched): every child run is customised by a capability grant.
- [ADR-0217](./0217-agent-integrations-are-packages-behind-host-ports): `packages/agent-orchestration` owns the durable coordinator and its records.
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who): the live authority check ADR-0247 §7 needs.

**Evidence:** a four-way read-only audit and a grill session, both on 2026-11-05. Paths and counts below were taken from `dev` at `03d7e75b43`. Implementation plan: `docs/plans/2026-11-05-multi-agent-convergence.md`.

## Context

Three ADRs drew three axes and kept them apart. ADR-0177 says a **room** is a conversation shape. ADR-0140 says a **Squad** is an executor and not a place. ADR-0137 says a **delegation** names a commitment, not an engine. The axes are right. What grew around them is not.

**The axes do not meet where they should.**

- **A room member is offered tools it can never use.** `resolveSendOptions` adds the `team_*` collaboration tools, `team_delegate` among them, to every session with `kind === "team"` when `selfInvokeTools.teamCollaboration` is on (`lib/claude/build-options.ts:4496`). The caller identity those tools need is only registered by `dispatchTeammate`, so the host answers every room member's call with "only available to a teammate during a team run" (`lib/claude/plugin-tool-ipc.ts:989-1000`). A room cannot hand work to anyone.
- **A delegation is minted by one command.** `acceptDelegation` (`lib/execution/delegation.ts:121`) is the only producer of kind `delegation`, and `/delegate` in IM is its only caller. `team_delegate`, `dispatch_agent`, the SDK `Task` tool, plugin agent dispatch, best-of-N and router-fusion all start children that never reach a delegation. T1 automatic acceptance and T2 `promoteDelegationToIssue` were never built.
- **A plain IM group reply bypasses the room.** It goes through `runAndCapture`, not `RoomRunner`, so room instructions and the room memory default never apply. `initialRoomMemoryFields` has no caller, so an IM or shared room is never created memory-off. `characterTeamId` has no hits: an IM group cannot bind a character team. ADR-0177 batches 4 and 5 are mostly unbuilt.
- **A shared room is not guarded.** `isLocallyOrchestratedRoom` exists and nothing calls it. `RoomRunner` and the `room_send` arm check `kind === "team" && teamId` and never ask whether the collab server owns the room.

**The same thing is built several times.**

| Concern | Copies |
| --- | --- |
| Who is whose child | 7: `executionRuns.parentRunId`, the `backgroundTasks` registry (re-projected by `lib/execution/job-bridge.ts`), `subagent-runtime-store`, `TeamDelegationRecord`, durable team child runs, `fusionDelegateSteps`, best-of-N records |
| Starting an agent child | `dispatch_agent` (`lib/claude/agents/dispatch-run.ts`), `team_delegate` background mode (`delegation-orchestrator.ts`, 904 lines), plugin `dispatchSubagent`, best-of-N `runExternalCandidate`, four callers of `ExternalAgentManager` |
| Stopping a child | 5: `cancel-subagent`, `background-agent-manager.cancelAgent`, `cancelDelegation`, SDK `stopTask`, the `job` branch in `control-handlers.ts` |
| Subtree nesting | 3: `buildSubagentTree` over message parts, `buildRuntimeTree` over store records, the SDK bridge's owner correlation |
| Steering | about 10: three branches in `control-handlers.ts`, `steerSession`, `steerDurableRun`, `steerIssueRun`, `live-steer.ts`, `routeSteer`, the renderer queue, and a copied `STEER_PREFIX` literal in the CLI |
| Control state machine | 2: `squad/squad-control.ts` (which calls itself "the one control state machine") and `durable/durable-control.ts` |
| Replay safety | 3: `packages/agent-orchestration/src/replay.ts`, `assessSquadRunReplay`, `isDurableChildReplaySafe` |
| Vote or panel aggregation | 3: `consensus-orchestrator.ts`, `lib/ai/ensemble/run-ensemble.ts`, `patterns/judge-panel.ts` |
| Squad entry | `startSquadRun` has 11 callers, but `action.team.run` calls `runTeamLifecycle` directly and skips readiness, the live-run check and admission. `agentTeamManager` survives as a facade over it with about ten callers. |
| Terminal and live predicates | at least 4 on three status types |
| Squad code | two trees, `lib/agent-team/` and `lib/ai/agent/team/` |

The word **delegation** has four meanings: the run kind, `TeamDelegationRecord`, `delegation-router` (rule-based agent routing) and router-fusion's delegate steps.

**Dormancy.** About 50 exports in the area have no production reader. Checked one by one, they split into needed but never wired (10), superseded by another copy (6), unneeded (14), and used only inside their own file (about 40). Four reported as unused are in fact wired.

**What is unfinished from earlier ADRs.** ADR-0140's two deferred items (one board component shared with Issues, deleting `/agent-teams`) are still open. `/agent-teams` is a redirect, and the `agentTeamsWorkspace` namespace still holds 929 keys. `lib/chat/room` imports from `hooks/chat` in four places, which ADR-0250 §14 forbids.

## Decision

### 1. Three axes, one word each

| Term | Is | Is not |
| --- | --- | --- |
| **Room** | a conversation with more than two participants (ADR-0177). Members speak in the transcript. | an executor. A room hands work out (§4). |
| **Squad** | an executor with a lead, teammates, a task board and a review (ADR-0140, ADR-0169). One message in the conversation that started it. | a conversation shape. A Squad never speaks in a room as several members. |
| **Delegation** | the commitment behind asynchronous work (ADR-0137, ADR-0247): one card, one owner, outlives its engine attempts. | an engine, a routing rule or a tool. |
| **Child run** | any run started on behalf of another run, linked to it by `parentRunId`. | a record kept anywhere but `executionRuns`. |

The room supervisor's `<dispatch to>` protocol and the Squad lead's JSON plan stay separate. The supervisor chooses who speaks next in a conversation. The lead plans tasks for an executor. Merging them would make one of the two pretend to be the other.

**Words.** `delegation` names only the run kind and what belongs to it. `TeamDelegationRecord` becomes a projection of a child run and is renamed to match. `delegation-router` becomes agent routing. Router-fusion keeps "delegate" as an internal word, and its types and UI say "step". The glossary entry is in `CONTEXT.md`.

### 2. One child-run tree

**`executionRuns.parentRunId` is the only record of who is whose child.** Every asynchronous child is an `executionRuns` row: a background subagent, a plugin agent, an external CLI agent, a twin answer, a Squad run, a best-of-N candidate, a Room hand-off. ADR-0137's weights are unchanged:

| Weight | What exists |
| --- | --- |
| T0 | the turn and its in-turn work. An SDK `Task` subagent that runs inside the turn stays a message part, projected by the SDK bridge. It is not a run. |
| T1 | a `delegation` run when the work outlives the turn: `/delegate`, a Room hand-off (§4), automatic acceptance (ADR-0247 §2), or `delegation_accept`. Engine runs are its children. |
| T2 | an Issue that references the delegation (ADR-0247). |

A child of a plain turn that does not outlive it (a background `dispatch_agent` the turn waits on) is a child run of the turn, without a delegation.

**Inside a Squad**, teammate runs stay in the durable coordinator's own records (`packages/agent-orchestration`, ADR-0217). They are the executor's internals, the same way a workflow's steps are. The Squad run itself is one `team` run in `executionRuns`, and that is what a delegation or a turn points at.

**What the other trackers become:**

| Today | Becomes |
| --- | --- |
| `backgroundTasks` | a delivery outbox only: settled results waiting to reach a parent session (§9, ADR-0249). For run-backed entries the status is read from the run. Only `shell-job` and `monitor` entries, which are not runs, keep their own status. |
| `lib/execution/job-bridge.ts` | deleted. The launcher writes the `executionRuns` row itself, so nothing is projected back. |
| `subagent-runtime-store` | a read model over `executionRuns` plus live progress events. It persists nothing of its own. |
| `TeamDelegationRecord` | a projection of the child run plus the Squad's approval and depth policy. |
| `fusionDelegateSteps` | unchanged. They are router-fusion's step journal inside one `fusion` run. |
| best-of-N records | group and candidate records stay. Each candidate is a child run of the group's run. |

**Nesting has one rule:** a node's parent is its `parentRunId`. The message-part tree, the settings runtime tree and the SDK bridge read that rule from one module.

### 3. One launcher, one stop

**`launchChildRun`** (in `lib/execution/`) is the only way to start a child run. It takes the parent run id, a target (`agent`, `external`, `twin` or `squad`), an `AgentCapabilityGrantV1` (ADR-0198), and the delegation it belongs to, if any. It writes the row, links the parent, starts the engine and records dispatch latency (`recordSquadDispatchLatency` becomes the launcher's generic dispatch metric). Its callers:

- `dispatch_agent` (renderer and CLI),
- `team_delegate` (inside a Squad),
- plugin Agent SDK dispatch,
- best-of-N candidates,
- the Room hand-off,
- `/delegate` and automatic acceptance when they need a new engine run.

`delegation-orchestrator.ts` keeps only Squad policy: approval, depth and cycle checks. They run as guards before `launchChildRun`.

**Stopping a child is a run-control stop** on its run. The five cancel paths become one, which dispatches by kind to the engine. A stop still needs the engine's stop proof where ADR-0244 requires it.

### 4. A room hands work to a Squad

- **The member proposes.** The `team_*` tools are removed from room sessions; they stay for Squad teammates. A room member instead gets `room_handoff_to_squad({ squadId?, brief })`. The call creates a proposal card in the room. It starts nothing.
- **A person confirms.** A person in the room confirms the card, on whichever surface they are on: desktop, phone, IM or the host's channel. `roomSettings.squadHandoff: "confirm" | "auto"` defaults to `confirm`. `auto` lets the call start the run at once, still bounded by the room's capability grant and the risk policy.
- **Confirmation mints a T1 delegation.** Its origin is the room turn, and the Squad run is its child, launched through `launchChildRun`. The Squad defaults to the one bound to the room (§6) and can be chosen on the card.
- **The result returns as one message.** The Squad's result enters the room as one folded message (ADR-0140 §6). It reaches the proposing member through ADR-0249's delivery, which wakes the room's runner at its next turn boundary.
- **Steer and stop** on the card go through §5 to the delegation.

### 5. One steer entry, one control machine

**Steer.** Every caller steers through run control's `steer`: a chat follow-up to a running Squad, IM `steer:`, a card button, a tool, an issue wakeup and an ADR-0249 completion. Run control dispatches by kind to the engine (`routeSteer` in the sidecar, the durable runtime, the issue runtime, the collab server's `steerSessionRun` for a shared session). The engines remain. The entries above them collapse into one.

**Queue rule, people first.** It is shared with ADR-0247 §6 and ADR-0249:
- **A person's message and any stop are delivered live** and are never coalesced.
- **Derived inputs queue.** Reviews, CI results, job completions and wakeups wait while the run streams and drain at the turn boundary, merged into one brief.
- **People go first.** In a session's queue a person's turn is always placed ahead of queued derived inputs.

This holds the person-first rule per session until ADR-0248's limiter lands, which keeps it across sessions. The steer text rules (`STEER_PREFIX`, the IM prefixes) live in one module. `steer_degraded` keeps its meaning (ADR-0137).

**Control.** `durable-control.ts` is the one control state machine. What was Squad-specific in `squad-control.ts` becomes guards before it: legacy runs, readiness, and the replay check. That check exists once, in `packages/agent-orchestration/src/replay.ts`. `controlSquadRun` and `controlSquadTeam` become one entry.

**Entry.** `startSquadRun` is the only way to start a Squad run. `action.team.run` goes through it. `agentTeamManager` is deleted: callers use `startSquadRun`, the control entry or the read model directly. One builder makes `startSquadRun`'s input for every caller.

**Best-of-N** keeps calling the durable coordinator directly, because it is not a Squad. Its candidates are child runs (§2).

### 6. Rooms finish ADR-0177

- **IM groups bind character teams.** A conversation override gains `characterTeamId`.
  - **One bot.** A group bound to a character team is a room of kind `im` whose personas reply through the connector's one bot identity. Each reply is signed with the persona's name, and with an avatar header where the platform renders rich content.
  - **Several bots.** A platform that allows several bot identities may map personas to bots. That mapping is optional.
- **A Squad and a character team can both be bound.** The existing override `teamId` is a Squad id and is renamed `squadId`.
  - **Both bound.** The character team converses, and the bound Squad is the default target of §4.
  - **Squad only.** Every turn goes to the Squad, as today.
- **Plain IM group replies run through `RoomRunner`**, so room instructions, reply mode, mutes and the memory default apply on every plane.
- **Defaults.**
  - **Memory off.** `initialRoomMemoryFields` is applied when an IM or shared room is created.
  - **Completeness.** The `partial` tier is returned when a platform exposes only a count or admins.
  - **Inbox.** The inbox separates groups from direct chats.
- **One reply-mode knob.** The inbox's activation policy and `roomSettings.replyMode` become one setting. The room settings editor covers IM and shared rooms, not only team rooms.
- **Shared rooms are detected, not flagged.**
  - **Detection.** `NEXT_PUBLIC_SHARED_CHAT_ENABLED` is removed. Shared rooms are available when a collab server is configured and its `/health` reports a supported protocol.
  - **When unavailable.** The entry says so and why (Rule 7). The per-install preference stays.
  - **Settings.** Shared rooms honour `roomSettings`.
  - **Silence and catch-up.** A silence verdict is written to the audit, and the catch-up card ships.
- **The runner refuses rooms it does not orchestrate.** `RoomRunner` and `room_send` check `isLocallyOrchestratedRoom` first. A shared room is orchestrated by the collab server only.
- **Layering.** `lib/chat/room` no longer imports `hooks/`. The steer queue, stream coalescing and effective-cwd helpers it needs move into `lib/`.

### 7. One status vocabulary in this area

Squad runs, child runs, delegations and room member runs use `ExecutionRunStatus` and one terminal/live predicate module built on `EXECUTION_TERMINAL_STATUSES`. The Squad's coordinator statuses are mapped to it in one place. Status types outside this area (workflow runs, router-fusion, the plugin contract's public types) are left to the rest of ADR-0250 phase 3.

### 8. One aggregation module

Vote tallying, thresholds, the winner and the merging of panel verdicts live in one pure module with no `@/` imports, `packages/agent-orchestration/src/aggregate.ts`. Squad consensus, the workflow ensemble node, the ultracode judge panel and the council read it. The four surfaces keep their own meaning. Where a surface's current behaviour differs from the shared rule, the difference is either kept and named in the module or removed after checking which is right. It is never flattened silently.

### 9. ADR-0247 and ADR-0249, as amended

**ADR-0247 is accepted, all of §1 to §9**, including handback and the observe log. That log needs a Dexie version bump for `workObservations`. Amendments:
- **Children.** Its "engine runs" are §2's child runs, started through §3's launcher.
- **Steering.** Its §6 delivery uses §5's steer entry and queue rule.
- **Scope.** Automatic T1 acceptance stays where ADR-0247 puts it: always-on hosts, IM-bound sessions, GitHub-triggered work. A desktop direct chat is not auto-accepted, because the person is present and the session is the carrier. Explicit async work (a Room hand-off, `delegation_accept`, `/delegate`) mints a delegation on every host.
- **The live authority check waits for ADR-0243** phases 2B to 2D. Until then:
  - the check reports `live_authority_unavailable`;
  - in shadow mode that is a `mandate.would_park` receipt and the run proceeds;
  - `mandateEnforcement: "enforce"` is refused for a workspace while that check is unavailable, so enforcement can never pass a start without it.
  
  Switching any workspace to `enforce` is out of scope here. It needs the shadow evidence ADR-0247 asks for.

**ADR-0249 is accepted.** Amendments:
- **Outbox.** Its journal is §2's delivery outbox.
- **Kinds.** `shell-job` and `monitor` are the outbox's two kinds that are not runs.
- **Waking.** Its wake is a derived input under §5's queue rule.
- **Room hand-offs.** Room hand-off results use the same delivery.

**ADR-0248 is not adopted here.** It stays on ADR-0250 phase 1's limiter.

### 10. Where the code lives

- **Squad code moves to `lib/squads/`.** `lib/agent-team/` and `lib/ai/agent/team/` merge into it in one move-only commit. Moves that follow the same rule: `stores/agent/agent-team-store` to `stores/squads/`, `components/agent/workspace` to `components/squads/`. These are ADR-0250 §14's default module paths for the id `squads`. ADR-0250 M1 (`4333cfabc0`) already created `lib/squads/` and `components/squads/` with the module's manifests, search provider and slash command, and the moved files join them under their existing names. The move also follows M1's gates: the `agent-team` ownership row and its `lib/ai/agent/team/` override are dropped once nothing is left under them, and G2 edge fingerprints are rebaselined only if their count does not grow.
- **Delegation stays in `lib/execution/`** as part of the run ledger, which is kernel.
- **Rooms stay in `lib/chat/room/`.**

Every move checks that no other session holds uncommitted changes under the moved paths.

### 11. Cleanup

- **ADR-0140's deferred items.**
  - The Squad board and the Issues board share one component and one board model.
  - `/agent-teams` is deleted and the surface contract updated.
  - `agentTeamsWorkspace` is split into the namespaces that still use it, and unused keys are dropped.
- **Persisted fields read by nothing are dropped** with a persist-version bump: `displayMode`, `workspaceTab`, and the three downgrade mirror fields on `agent-runtime-store`. The downgrade window is closed.
- **The dormant exports are settled by the verdict table in the plan.** Each one is wired, merged, deleted or made internal. A wired item ships with its test (Rule 7).
- **Stale text is corrected.** Comments and docs that describe callers that do not exist are fixed in the same change.

## Consequences

- **Room members can ask for work** and see it happen inside the room. The tools that always failed are gone.
- **One question per run tree.** "What did this run start?", "is anything still running under it?" and "stop all of it" each have one answer, from one table.
- **Delegation cards appear for every asynchronous hand-off on every host,** not only `/delegate` in IM. Answers and in-turn subagents still produce no card.
- **Steering and stopping behave the same whatever the surface or the engine.** A person is never queued behind a review comment or a finished job.
- **Some old local data is not migrated:** the in-memory subagent store, `TeamDelegationRecord` blobs and the old `backgroundTasks` status. In-flight background work at upgrade time is reconciled from the engine where it can be and is otherwise marked interrupted.
- **ADR-0250 phase 3 shrinks.** What is left there is the ledger reference for every other run kind and the status vocabulary outside this area.

## Amends

- **ADR-0137.** Child runs are created only by the launcher, and every async hand-off can be a delegation (§2, §3). The steer entry is §5. T2 promotion is ADR-0247's.
- **ADR-0140 / ADR-0169.**
  - Squad code lives in `lib/squads/`.
  - `agentTeamManager` and the second control machine are gone.
  - `action.team.run` uses the one entry.
  - The deferred items are closed.
  - A room reaches a Squad through §4.
- **ADR-0177.**
  - Batches 4 and 5 are finished as §6 states.
  - Room members lose the `team_*` tools.
  - An IM group binds `characterTeamId` and `squadId`.
  - The runner checks `isLocallyOrchestratedRoom`.
- **ADR-0247, ADR-0249.** Accepted with §9's amendments.
- **ADR-0250.** The multi-agent part of phase 3 is delivered here (§7, §9). The `squads` module, created by M1, takes in the rest of the Squad code.
