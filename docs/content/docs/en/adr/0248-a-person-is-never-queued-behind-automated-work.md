---
title: "0248 — A person is never queued behind automated work"
description: "Every start that competes for an execution limit says whether a person did it or something derived it. Stop, pause and cancel never take a permit and never wait. Each limiter keeps one permit that derived work cannot take, and a person's start goes ahead of derived starts in every queue. The origin is set by the door that admits the work, never by the agent."
---

# ADR 0248 — A person is never queued behind automated work

**Status:** Proposed
**Date:** 2026-11-01
**Related:** [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads) (derived starts), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (always-on host), [ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background) (coordinator admission), [ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so) (stop proof), [ADR-0243](./0243-a-run-acts-for-someone-and-says-who) (requester). Research: `docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`.

## Context

DeepSeek's prototype reserves one extra worker slot for human messages and status requests on existing tickets. Without it, new automatically created tickets could fill every slot and a person could not reach the work they started. Cognia has three independent limiters, and none of them knows whether a start came from a person:

- **Execution broker** (`lib/execution/broker.ts`). A weighted FIFO semaphore over `ai-turn`, `DEFAULT_AI_TURN_LIMIT = 16`. A lease for a session that already has an active leg is exempt (the continuation exemption), so a follow-up into a running turn is never blocked. A person's new message to an idle session, for example on an IM conversation the host answers, waits behind whatever automated legs are queued.
- **Scheduler** (`lib/scheduler/concurrency-limit.ts`, `decideConcurrencyAdmission`). `maxConcurrentExecutions`, default 5. Over the cap, a start is buffered or dropped by the task's overlap policy. Agent-task issue runs go through it.
- **Durable Agent Team** (`packages/agent-orchestration/src/fair-scheduler.ts`). A fair scheduler with numeric priority and aging, `globalConcurrency` 8. No door assigns priority by origin.

The only origin-aware rule is `admitThreadStart` (`lib/project-coordinator/admission.ts`). It lets a thread the user asked for start above `maxConcurrentThreads` and stages the coordinator's own starts. On an always-on host, schedules, bots, wakeups and the event-driven runs of ADR-0247 are all derived. They can fill all three limiters, and a person's stop or new request then has to wait for them.

Stops are already mostly outside the permits. Broker cancellation fires a lease's signal, and team stop writes intent and calls the coordinator directly. But that is not stated as a rule anywhere, and no test pins it.

## Decision

1. **Stop, pause and cancel never take a permit and never wait in a queue.** This is an invariant of all three limiters and is pinned by a test in each. A stop path that today has to go through a queued operation is a defect under this ADR. Stop *proof* still follows ADR-0244. This rule covers only the request reaching the work without waiting.
2. **Every start carries an origin.** Leases, scheduler starts and team dispatches gain `origin: "person" | "derived"`.
   - **Person**: an interactive chat send; a person's own message in an admitted IM conversation (mentioned or direct) or on a followed thread; a run a person names (`isNamedRunOrigin`, the `interactive` run origin); a person's follow-up or steer on a commitment.
   - **Derived**: schedules, bot deliveries, wakeups, coordinator-initiated threads, event-driven commitment runs (ADR-0247), retries and recoveries.
   - **Who sets it.** The door that admits the work sets the origin, reading the ADR-0243 requester when the triggering act is a person's own. The agent cannot set or change it, and a derived run's children are derived.
3. **One reserved permit per limiter.** Derived work may use at most `limit − 1` permits. Person work may use any free permit, including the reserved one. A limiter configured to `1` reserves nothing; there, rule 4 alone applies.
4. **People go first in every queue.** In the broker's FIFO and the scheduler's buffer, a queued person start is admitted before any queued derived start. The fair scheduler gives person starts the highest priority band, and aging applies within a band.
5. **Nothing else changes.** Person work still counts against the limits once admitted. The broker's continuation exemption and the coordinator's user bypass stay as they are. The limits themselves and their settings are unchanged.
6. **Visible.** The broker's "what's running" view and the scheduler dashboard show each leg's origin. A derived start that waits only because of the reserved permit is reported as such, not as a generic cap.

## Implementation surfaces

| Concern | Where |
| --- | --- |
| Origin type and doors | `packages/plugin-contract/src/types/execution/` (origin on lease/start inputs), chat send controller, connector runtime (`enqueueRouteHandlerTurn`), issue run doors, scheduler executors |
| Broker | `lib/execution/broker.ts` (reserved permit, two-band FIFO, stop invariant test) |
| Scheduler | `lib/scheduler/concurrency-limit.ts` (`decideConcurrencyAdmission` takes origin), task scheduler buffer order |
| Team | `packages/agent-orchestration/src/fair-scheduler.ts`, `coordinator.ts` (priority band, stop invariant test) |

Every touched module updates its co-located tests (Rule 3). Labels in the running view are i18n-wired (Rule 4).

## Consequences

- On a loaded host, a person's request starts as soon as one permit frees, at worst. A stop never waits.
- Derived throughput drops by one permit per limiter. That is the price of the guarantee.
- A door that forgets to set an origin defaults to `derived`, which can only make a person wait. It can never let automation take the reserved permit. A test asserts the default.
