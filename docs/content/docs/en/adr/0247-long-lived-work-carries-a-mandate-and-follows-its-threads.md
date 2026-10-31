---
title: "0247 — Long-lived work carries a mandate and follows its threads"
description: "Work that something outside started on an always-on host is a commitment, not a session. It is a delegation while it runs and is promoted to an issue the moment it leaves a branch, a pull request or a coordinator thread behind. The commitment carries a versioned mandate (who allowed it, from which message, within what scope, under which policy) that is re-evaluated by rules before every derived resume. It follows the threads it came from and the ones it created, so a review, a CI failure or a follow-up in the original IM thread reaches it through issue wakeups without a router. A worker hands back what is out of scope. Unmentioned group messages are judged by a model only to record what would have become work."
---

# ADR 0247 — Long-lived work carries a mandate and follows its threads

**Status:** Proposed
**Date:** 2026-11-01
**Revised:** 2026-11-01 after adversarial review
**Related:** [ADR-0137](./0137-delegation-runtime) (delegation runs, T0/T1/T2), [ADR-0132](./0132-issue-tracker) (issues, issue runs, wakeups), [ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background) (coordinator threads), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (always-on host), [ADR-0243](./0243-a-run-acts-for-someone-and-says-who) (acting identity), [ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so) (stop proof), [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request) (outbound authorization), [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (capability grants), [ADR-0131](./0131-cross-shell-inbox-relay) (rule-only inbound routing), [ADR-0194](./0194-a-judgment-is-a-provider-not-a-prompt) (decision runner), [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work), [ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent). Research: `docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`.

## Context

DeepSeek's Super-agent prototype (`deepseek-ai/dsh-superagent-prototype`, MIT, first commit `6337fc8`) separates what happened (Trigger), which discussion it belongs to (Thread), what the agent was authorized to do (Ticket + Mandate), who is doing it now (Assignment) and which later events reach the work (`Thread.subscriptions`, with a context-only subset). The research note compares it with Cognia in detail. Cognia already has most of the parts, but they are not connected, and an always-on host (ADR-0224) that answers a team's IM and repository is where the missing connections show:

- **The commitment has two carriers that do not meet.** A `delegation` run (ADR-0137, `lib/execution/delegation.ts`) is the commitment behind asynchronous work: one card, children through `parentRunId`, steer, stop, hand to a person, retry by replacement. It is minted only by `/delegate` in IM (`lib/connectors/commands/delegate.ts`). The T2 step, `promoteDelegationToIssue`, is named in the module header and does not exist. An `Issue` (ADR-0132) is the other carrier: it outlives runs (`issueRuns`), can be reopened, holds indexed links to other systems (`externalRefs`, `*externalKeys`), tracks linked pull request state and CI (`recordIssuePullRequestState`, `recordIssuePullRequestChecks`) and owns wakeups. Coordinator threads (ADR-0204) produce worktrees, branches and pull requests and belong to neither.
- **Wakeups already route events to work, but threads do not reach them.** An issue wakeup (`lib/issues/wakeups/`) steers an input into the active run, holds it when the run cannot take it, or starts a run, with loop and hourly caps. But the only events are the issue's own trail (`issue:activity`). A message in the IM thread the work came from goes to the session bound to its `conversationKey` (`lib/connectors/session-bindings.ts`). A pull request review or CI result reaches an issue only through the 15-minute `github-issue-sync`. `lib/issues/github-event-refresh.ts` turns a webhook into a mirror refresh and nothing else. Coordinator threads poll their pull request every 60 s (`pr-watch.ts`) and Agent Team every 30 s.
- **A woken issue loses its context.** A wakeup with no active run starts a new run through `startIssueRun`, which starts a new session.
- **Nothing records why the work was allowed.** `ActingIdentityV1` (ADR-0243) records who a run acts for, and `observeActingAuthority` is audit-only by contract ("callers must never branch on this result"). Nothing records the message that asked, the scope that was granted, or the policy in force. The inbound routing decision hard-codes `policyRef.version: "1"` (`lib/governance/producers/connector.ts`).
- **A worker cannot say "not mine".** Within a followed thread, a request that widens the work arrives as ordinary input. The model either quietly does it or ignores it.
- **Unmentioned messages leave no evidence.** Inbound admission is rule-only by decision (ADR-0131 lists AI triage of inbound messages as a non-goal; `dispatch-rules.ts`: "no AI triage in v1"). The connector `autonomy: "observe"` setting stores messages, but it does not record what a judge would have made of them. So there is no evidence for or against ever widening admission.

What this ADR does not adopt from the prototype, and why, is listed under Consequences.

## Decision

### 1. Words

- **Commitment**: the record that owns a piece of long-lived work across runs. It is a `delegation` run (T1) until it is promoted, then an `Issue` (T2) that references the delegation.
- **Mandate**: the versioned authorization basis a commitment carries.
- **Followed thread**: an external discussion the commitment receives events from: an IM thread, a pull request, a GitHub issue. A follow is `owner` or `context`.
- **Derived start**: any run start or resume a person did not perform directly: a wakeup, an event, an unattended resume, a child launch, a retry.

### 2. When work becomes a commitment

Applies to work owned by an always-on host and to IM-bound sessions on the desktop. A plain answer stays T0.

1. **T1 automatically on an explicit implementation request.** When an admitted IM or GitHub message (mentioned, or a direct chat) leads to a turn that starts changing a repository, the host mints a delegation and adopts the running turn into it (`acceptDelegation` + `adoptIntoDelegation`). This is the automatic form of the rule `/delegate` already applies by hand. The signal is the turn's first write into a git root, which is deterministic. It is not the model's opinion of the message. A turn may also adopt itself earlier through a tool (`delegation_accept`) when the work is long but writes no code.
2. **T2 when the work leaves a durable code artifact.** A delegation is promoted to an issue the first time one of its runs creates a branch or opens a pull request. A coordinator thread (ADR-0204) is promoted when it starts, because it is a worktree and branch by construction. `promoteDelegationToIssue` is implemented here. It files the issue in the workspace's default issue project with:
   - `origin` = the delegation's source message;
   - assignee = the agent;
   - status `in_progress`;
   - an `IssueRun` whose `targetId` is the delegation run.
   
   It copies the mandate (§4) and the follows (§3), and installs the system wakeup (§5). This amends ADR-0137 §"T2 tracked": promotion is still never minted for a turn that only answers. A durable code artifact is the evidence that the work will outlive its run and be reviewed, so promotion no longer waits for a person.
3. **A promoted delegation keeps its card.** The IM thread keeps its binding (`executionRunBindings`) and the issue keeps the delegation as its run. Nothing about the card changes for the person who asked.

### 3. A commitment follows threads

- **Representation.** A follow is an `IssueExternalRef` with a new non-indexed field `follow?: "owner" | "context"`. The existing `*externalKeys` index answers "who follows thread X" through `externalKeyOf`. New provider ids:
  - `im-thread`, with `externalId` = the full `conversationKey` including its thread segment;
  - existing `github-pr`;
  - `github-issue`.
  
  Before promotion, the same refs live on the delegation run under `followRefs` and move to the issue when it is promoted. Sync providers ignore providers they do not own; that is asserted by a test before the field ships. No schema bump is needed, because the indexed key set does not change.
- **The host creates owner follows.** It adds one for the thread the request came from and one for every pull request or GitHub issue the work creates (from the task workspace's pull request record and the `pr-observe` discovery path).
- **An agent can add context follows only.** It uses a tool, `commitment_follow(threadRef)`. A context follow never authorizes, never starts a run and never wakes a commitment that has ended. The agent may remove a context follow it added (`commitment_unfollow`, DeepSeek's `markUnrelated`). It can never add or remove an owner follow.
- **A person upgrades or removes follows** in the issue detail panel or on the delegation card.

### 4. The mandate

```ts
interface CommitmentMandateV1 {
  revision: number // bumps only when a person changes it, or at creation
  basis:
    | { kind: "message"; conversationKey: string; messageId: string }
    | { kind: "github"; ref: string; deliveryId?: string }
    | { kind: "coordinator"; coordinatorSessionId: string; threadSessionId: string }
    | { kind: "person"; actor: IssueActor }
  requesterRef?: string // ADR-0243 requester / authorizing principal id
  scope: {
    workspaceId: string
    roots?: string[] // git roots the work may write
    authority: RunAuthorityV1 // ceiling; meetRunAuthority only narrows
    outboundGrantRefs?: string[] // ADR-0239 grants the work may use
  }
  brief: string // what was asked, in the requester's terms
  policy: { digest: string; at: number } // policy in force at grant time
}
```

- **Where it lives.** It lives on the delegation run while the work is T1, next to `actingIdentity`. From promotion on it lives on `Issue.mandate`, and the delegation keeps a pointer. Every `ExecutionRun` that carries the work records `mandateRef: { commitmentId, revision }`.
- **Scope is enforced by the host.** The capability grant for every run of the commitment (ADR-0198 `AgentCapabilityGrantV1`) is derived from `scope`. A resolver never widens it. Roots bound the task workspace, and outbound grant refs bound ADR-0239 plans. `brief` is not enforced. It is what §7 judges "out of scope" against.
- **Policy digest.** It is a hash over everything that decided admission and authority when the grant was made:
  - the conversation's admission policy (`evaluateAdmissionPolicy` inputs, `ConversationOverrideRow`);
  - outbound authorization modes per category;
  - the grants referenced;
  - the acting identity's `authorityRevision`.
  
  The same digest replaces the hard-coded `policyRef.version: "1"` in `lib/governance/producers/connector.ts`, so routing receipts name the rules actually in force.

### 5. Thread events become issue activity

- **New `IssueEventKind`s:**
  - `thread_message`: a message in a followed IM thread;
  - `pr_review`: a review or review comment;
  - `pr_comment`: a conversation comment on a followed pull request or issue.
  
  `pr_state_changed` and `pr_checks_changed` stay. Each entry records the follow mode, the actor and a deterministic `sourceEventId`.
- **IM: one executor per message.**
  - After the connector bus has deduplicated a message (bus Step 1, `ensureConnectorInboundJob`) and admitted it, it looks up commitments following `im-thread:<conversationKey>` as **owner**.
  - **If one does,** the bus hands the message to that commitment's delivery and does not also enqueue a route-handler turn or live-steer it itself.
  - **Commitment delivery** (§6) is then the only path that executes it: it steers the commitment's active run, continues its last session, or starts a run. A person's message still arrives immediately, because delivery steers it live (§6.2).
  - **If no commitment follows the thread,** today's session path is unchanged.
  - **Receipt.** Every hand-off writes a durable acceptance receipt keyed by `(commitmentId, sourceEventId)` in the same transaction as the trail entry. A replay after a crash finds the receipt and does nothing. That is what keeps two consumers from acting on one message.
- **GitHub.** An integration event for a followed `github-pr` or `github-issue` (`lib/integrations/events.ts`; App webhooks in `github-webhook.ts`, personal-token webhooks in `github-repo-webhook.ts`) is appended as activity right away. For pull request state and checks, it calls `recordIssuePullRequestState` / `recordIssuePullRequestChecks` from the payload, which write only the ref's `meta` and never the mirror watermark. It still schedules the mirror refresh `github-event-refresh.ts` already schedules. Duplicates collapse on the integration event's `[accountId+deliveryId]` and on `sourceEventId`.
- **Polling becomes reconciliation.** The 15-minute sync, `ProjectPrWatch` and `PrFeedbackController` keep running and append only what webhooks missed, keyed by the same `sourceEventId`.
- **System wakeup rule.** Promotion installs one system wakeup rule matching `thread_message | pr_review | pr_comment | pr_state_changed | pr_checks_changed` from owner follows, with `actorKinds` excluding the agent itself. System rules are already exempt from the chain-visit cap. The hourly rate cap applies.
- **Context-follow events** are appended to the trail and delivered only into an active run, as context. They never fire a wakeup.
- **Before promotion** a delegation follows only its origin thread (it has no pull request yet, or it would have been promoted). The bus hands that thread's messages to the delegation in the same way: the delegation's delivery steers or continues its session, keyed by the same receipt. The issue-activity trail and the system wakeup start at promotion.

### 6. Delivery and continuation

The wakeup executor's existing three-way delivery stands, with three changes:

1. **Coalescing.** Owner events for one commitment that arrive within a short window (default 30 s, settable per workspace) fold into one brief (`buildWakeupBrief` over the chained inputs). Five review comments wake one turn.
2. **Join at a turn boundary, people live.** An active run takes event briefs (reviews, CI, comments) through the steer-queue rule, the same rule ADR-0249 uses for job completions: while the run streams the brief is queued, and it drains when the turn settles. A person's message in an owner-followed thread, and any stop, is steered live and never coalesced. That preserves what the bound session gave people before the bus started handing their messages to the commitment.
3. **Continue, do not restart.** With no active run, `startIssueRun` is given `continueSessionId`, the newest session of the latest run (`issueRunSessionIds`), when that session still exists, is not archived and its runtime can resume. Only otherwise does it start a new session seeded with the issue summary.

### 7. Resume re-evaluates the mandate

Before every derived start (§1), the host re-evaluates deterministically:

- **whether the requester still holds authority, checked live.** This is not the revision comparison alone. `checkActingAuthority` only checks that the identity exists and that `authorityRevision` has not advanced (`packages/plugin-contract/src/types/execution/acting-identity.ts:132-139`), and a revoked credential or binding does not advance it. A live authority resolver reads:
  - the current credential authorization epoch;
  - for a bound person, the current binding and consent revision.
  
  These are the live checks ADR-0243 §2 already requires of every call ("the snapshot never grants on its own"). The revision comparison stays as a separate snapshot check;
- whether the origin thread's admission still admits that requester;
- whether the scope still fits the current ceilings (workspace, roots, the RunAuthority ceiling of the current policy, the grants referenced).

The outcomes:

- **Pass.** The run proceeds. The run records the current policy digest; the mandate revision does not change, because only a person changes it.
- **Fail.** The commitment parks: the delegation raises an interrupt and the issue holds its wakeup inputs, which ADR-0132 already guarantees are never dropped. A card goes to the requester, or to the coordinator when there is one, saying what no longer holds.
- **A person stopped it.** A commitment a person stopped (cancelled run, issue moved to `canceled`) is never resumed by an event. Inputs are held and shown.
- **A person revokes it** (mandate revoked, follow removed, the requester's grant withdrawn). The active run is stopped through the ADR-0244 stop path, and the commitment does not show as stopped before stop proof.

**Acceptance cases** for this section include:
- the revision is unchanged but the credential was revoked;
- the revision is unchanged but the binding was withdrawn;
- a person stopped the commitment and an event arrives afterwards.

**Rollout is shadow first**, the same pattern as ADR-0239 and ADR-0243. Setting `agentPermissions.mandateEnforcement: "shadow" | "enforce"` defaults to `shadow`. In shadow, a failing check writes a `mandate.would_park` receipt, the run proceeds, and the shadow report lists them. Enforcement is switched on per workspace, once the report shows the check parks what it should and nothing else. Under `enforce`, `observeActingAuthority` is replaced at the `unattended-resume` and `child-launch` sites by a check callers branch on. The shadow state is documented on the setting's type, labelled in the settings UI and pinned by a test.

### 8. Handback

A run bound to a commitment has `commitment_handback({ sourceEventId, reason })`. It is for input the run judges outside the mandate's `brief` or `scope`.

1. **The trail.** The event is marked `handed_back` on the trail, and that event id is never delivered to this commitment's runs again. This is DeepSeek's `handedBackHere` guard, keyed by `(commitment, sourceEventId)`.
2. **Where it goes.**
   - If the commitment belongs to a project coordinator, the handback is a peer report to the coordinator (ADR-0204 §5), which decides.
   - Otherwise a card goes into the source thread for the person who wrote it, with three choices:
     - **New issue**, through the existing IM proposal path (`lib/issues/im/propose.ts`, origin = that message);
     - **Widen scope**, a new mandate revision, which only a person with authority over the commitment can approve;
     - **Ignore**.
3. **A handback is not a refusal.** The run keeps working on what is in scope.

### 9. Unmentioned group messages: observe only

- **Off by default.** A conversation override `workObservation: "off" | "observe"` defaults to `off`.
- **The pre-filter.** Under `observe`, messages that admission did not route to a turn pass a deterministic pre-filter first:
  - the sender is a member, not a bot or the agent;
  - the message is not quoted or forwarded content;
  - it is not already in an owner-followed thread.
- **The judge.** Messages that pass go to `runDecision` (ADR-0194, PII gate first) with an admission prompt that requires all three of: the discussion is about this workspace, a participant clearly wants a specific change made, and the direction is settled. Quoted or forwarded instructions never count.
- **The record.** The verdict (would-accept / would-ignore, reason, the scope it would have proposed, the prompt revision, the model) is written to a new table `workObservations`. That needs a Dexie bump, a `CORE_TABLE_NAMES` entry and `pnpm db:governance:write`.
- **What observe never does.** Nothing is replied, filed, proposed or run.
- **Review.** A settings page lists observations per conversation, and a person marks each verdict right or wrong.
- **Moving past observe needs its own ADR.** The bar it must show: at least 50 marked verdicts in that conversation, precision of "would-accept" at least 90%, and no accepted verdict on quoted or forwarded content. ADR-0131's non-goal stands until then; this section adds evidence-gathering, not routing.

## Implementation surfaces

| Concern | Where |
| --- | --- |
| Promotion, auto-adoption | `lib/execution/delegation.ts` (`promoteDelegationToIssue`), `lib/issues/run/` (delegation-backed `IssueRun`), task workspace branch/PR hooks, `lib/project-coordinator/thread-session.ts` |
| Follows | `packages/plugin-contract/src/types/issues/index.ts` (`IssueExternalRef.follow`, providers), `ExecutionRun.followRefs`, `lib/db/issues.ts`, issue detail panel, delegation card |
| Mandate | `packages/plugin-contract/src/types/execution/` (`CommitmentMandateV1`, `mandateRef`), `lib/execution/acting-authority.ts`, `lib/governance/producers/connector.ts` (policy digest) |
| Thread events | `lib/connectors/bus.ts` (after Step 1 / admission), `lib/integrations/events.ts`, `lib/issues/github-event-refresh.ts`, `lib/issues/wakeups/` (kinds, system rule, coalescing, continuation) |
| Handback | sidecar tool + `lib/issues/im/propose.ts`, coordinator peer report |
| Observe | conversation override, `lib/decisions/run-decision.ts`, `workObservations` (Dexie), settings page |

Every new module ships with its co-located test (Rule 3) and every new string is i18n-wired (Rule 4). Headless parity: the brain already boots the issue tracker (`lib/headless/runtimes/issue-tracker.ts`). Each phase is verified on the host as well as the desktop.

## Rollout

1. Mandate type, policy digest, `mandateRef`, shadow check and report.
2. Follows plus IM and GitHub thread events, the system wakeup, coalescing.
3. Automatic T1 adoption and T2 promotion (branch/PR, coordinator thread).
4. Session continuation on wake.
5. Handback.
6. Observe log and review page.
7. Enforcement, per workspace, after the shadow evidence.

Each phase records its evidence ledger under `docs/evidence/`.

## Consequences

- One commitment can now receive a review, a CI failure and a follow-up in the original IM thread, and it continues in the session that has the context. Polling no longer sets the latency; webhook delivery does.
- Work started from outside can always answer "who allowed this, from which message, within what, under which rules". Under `enforce`, a stale answer stops a derived resume instead of only being logged.
- The issue board gains rows for every pull request a host's agent opens. That is the accepted cost of amending ADR-0137. Answers and non-code delegations still do not take issue numbers.

**Not adopted from the prototype:**

- An LLM router that triages every inbound message. ADR-0131 stands; §9 only gathers evidence.
- A separate Ticket entity. That would be a seventh task-like record next to delegation, issue, agent task, goal, plan and team run.
- The prototype's Effects/Outbox engine. Cognia's governed outbound queue already refuses blind resends (`delivery_unknown`), and chat acceptance and notifications already commit state and effect together.
- Prompt-only merge rules. ADR-0239 enforces at the chokepoint.
- Ordering that lets later messages overtake one that failed three times.
- Notify-only policy changes for running work. §7 parks instead.

## Open questions

- **Session continuation across runtimes.** It depends on each runtime's resume support. The rule in §6 falls back to a new session, and which runtimes qualify is measured in phase 4.
- **The coalescing default** of 30 s is a starting value. Phase 2 measures review bursts on real repositories.
