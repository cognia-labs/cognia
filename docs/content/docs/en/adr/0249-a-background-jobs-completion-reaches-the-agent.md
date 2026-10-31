---
title: "0249 — A background job's completion reaches the agent"
description: "A shell job or a monitor the agent started reports its completion into the session that started it, through the same journal and delivery path subagent results already use. An idle session wakes with the merged results, a streaming one receives them at its next turn boundary, and a session no one has open on a host or under a background hold still wakes. Wakes are capped per session and counted against the run's budget. This makes the Monitor tool's promise to deliver its result when it fires true."
---

# ADR 0249 — A background job's completion reaches the agent

**Status:** Proposed
**Date:** 2026-11-01
**Revised:** 2026-11-01 after adversarial review
**Related:** [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads) (turn-boundary delivery), [ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background) (background holds), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (always-on host), [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work) (wakes are derived). Research: `docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`.

## Context

DeepSeek's article describes asynchronous ("full-duplex") tools: a long tool returns `Started`, and its completion arrives later as an event the agent handles after its current step, while it stays free to take new input. The article says this exists in DeepSeek Harness but is not on by default. Cognia already has half of it:

- **Jobs run in the background.** `run_in_background` shells run under the Rust job supervisor (`crates/cognia-jobs`: SQLite, process groups, `MAX_JOBS_PER_SESSION = 8`), reached through `sidecar/src/tools/state/host-background-shells.ts`. The agent reads them with `bash_output` (a long poll with `wait_ms`) and stops them with `kill_shell`.
- **Completions never reach the agent.** The supervisor emits `jobs://exited` and `jobs://monitor-fired`. `hooks/system/use-tauri-events.ts` relays both only to scheduler events (`job:exited`, `monitor:fired`), so a schedule can trigger on them, but the agent that started the job learns nothing unless it polls.
- **Monitor promises a delivery that nothing performs.** The `Monitor` tool (`sidecar/src/tools/builtin/core-files/monitor.ts`) blocks for up to five minutes, then returns a `monitorId`. Its description tells the model "the result is delivered when it fires". No consumer injects a fired monitor into a session, so the promise is dormant. That is the kind of half-labelled dormancy Rule 7 forbids.
- **Subagent results already re-enter.** `hooks/chat/background-result-runtime.ts` and `lib/background-tasks/completion-delivery.ts` (`frameBackgroundResults`) do this for subagents. A settled background run (`BackgroundTaskKind` = `subagent | plugin-agent | team-delegation`) is journaled, then delivered into its parent session as a framed turn:
  - parent streaming: stays queued until the turn settles;
  - parent closed: drains when it next opens idle;
  - parent deleted: notification only.
  
  The batch identity is reserved durably, and delivery completes only when the chat's work ledger acknowledges it. The TUI has its own consumer (`cli/src/tui/components/app/use-background-results.ts`).
- **"When it next opens" never happens on a host.** On an always-on host, or for a session kept live by a background hold (ADR-0204 §3), no one opens the session, so a result queued that way waits indefinitely.

## Decision

1. **Jobs and monitors are background tasks, recorded race-safely.** `BackgroundTaskKind` gains `shell-job` and `monitor`, keyed by job or monitor id and linked to the session and run that started them. The scheduler relay stays as it is.
   - **Upsert, not insert.** The supervisor starts its exit listener before it returns the job record (`crates/cognia-jobs/src/supervisor.rs:249-326`), and the sidecar only learns the id when the RPC returns (`sidecar/src/tools/state/host-background-shells.ts:171-183`). A fast job can therefore exit before the journal entry exists. The entry is written as an idempotent upsert keyed by job id that accepts a terminal state arriving first: an exit seen before the start record creates a settled entry, and the later start record only fills in the session link.
   - **Correlation id.** The session and run are passed into the start call itself, so the supervisor's exit event already carries them.
2. **One delivery path.** Settled entries use the existing completion delivery. A streaming session takes them at its next turn boundary, and several settlements are merged into one framed turn. The frame carries:
   - kind and id;
   - exit code or fire reason;
   - duration;
   - a bounded tail of output (the same budget as the bash tool's inline output; the full log stays readable through `bash_output`).
   
   Output is framed as untrusted data, like peer messages.
3. **Wake when nobody opens.** A session that is host-owned (ADR-0224) or under a background hold wakes when idle, instead of waiting to be opened. Desktop sessions without a hold behave as today. The wake is a derived start (ADR-0248).
4. **Bounded.** Each session has a wake cap (default 6 per hour) and a coalescing window (default 10 s).
   - **Over the cap.** Settlements queue for the next turn the session takes for any other reason, and one notification says results are waiting.
   - **Budget.** Wakes are charged to the run's budget through the existing ledger. A session whose budget is exhausted is not woken.
5. **The agent chooses per job.** `run_in_background` gains `notify: "on_exit" | "none"`, default `on_exit`. A job the agent stops itself with `kill_shell` does not wake it. A blocking `Monitor` call that returns its outcome inline does not also deliver it later.
6. **Every shell that runs agent sessions has a consumer**: the desktop chat hooks, the headless brain and the TUI. The host already publishes both events (`crates/cognia-server/src/main.rs:2797,2806`), so the gap there is the consumer, not the event.
7. **Events can be missed, so the state is reconciled.** Events are lost across a WebView reload, a brain restart or a dropped connection. On every consumer start and reconnect, the consumer queries the supervisor's persisted jobs and monitors (SQLite in `cognia-jobs`). It settles every journal entry still `running` whose job has ended, and creates entries for ended jobs the journal never saw.
   - **Delivered once.** Delivery stays exactly-once through the existing reserved batch identity.
   - **Inline results.** A result a blocking `Monitor` call already returned inline is marked delivered, so reconciliation never sends it again.
   - **Acceptance cases:** a job exits before the start ACK; the consumer reloads mid-job; an event arrives twice; inline and asynchronous delivery of the same monitor.

## Implementation surfaces

| Concern | Where |
| --- | --- |
| Journal kinds | `lib/background-tasks/registry-core.ts`, `lib/background-tasks/completion-delivery.ts` (framing for jobs and monitors) |
| Settlement | `hooks/system/use-tauri-events.ts` (settle alongside the scheduler relay), headless brain event wiring, `cli/src/tui/components/app/use-background-results.ts` |
| Tools | `sidecar/src/tools/builtin/core-files/bash.ts` (`notify`), `monitor.ts` (description matches behaviour), `sidecar/src/tools/state/host-background-shells.ts` |
| Wake policy | `hooks/chat/background-result-runtime.ts` (wake-when-idle for held/host sessions, cap, coalescing, budget check) |
| Reconciliation | consumer start/reconnect query of `cognia-jobs` persisted jobs and monitors; start call carries session and run ids |

Co-located tests for every touched module (Rule 3), sidecar suites under `pnpm sidecar:test`, i18n for the notification text (Rule 4).

## Consequences

- An agent can start a build or a test run, take the next request, and react when the job ends. It no longer has to spend turns polling or sit in a blocking call.
- A forgotten long job can cost a turn when it ends. The cap, the budget check and `notify: "none"` bound that.
- The Monitor tool's description becomes true. Until this ships, its description must stop promising delivery.
