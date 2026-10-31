---
title: "0250 — The runtime is a headless kernel the desktop embeds"
description: "Every long-running behaviour lives in one kernel, designed for an always-on host with no UI. It is registered once and booted by every host that runs agents: the brain, the person brain and the desktop. The desktop is that kernel plus a UI, not a React app that also happens to run things. The kernel shares four primitives: a durable queue, an origin-aware limiter, one run ledger and one commitment. It reaches the outside only through chokepoints whose callers a gate can enumerate. The migration is strangler-style and ratcheted: characterize on both hosts, move, delete the old path, lower the baseline. A fixed share of capacity goes to it while features continue on the new primitives."
---

# ADR 0250 — The runtime is a headless kernel the desktop embeds

**Status:** Proposed
**Date:** 2026-11-01
**Related:**
- [ADR-0059](./0059-cloud-deployment-headless-brain) (headless brain, registry rule)
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (always-on host)
- [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (unified execution)
- [ADR-0137](./0137-delegation-runtime) (delegation)
- [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request) (outbound authorization)
- [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads), [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work), [ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent)

Evidence: `docs/research/architecture-convergence-audit-2026-11-01.md`. Plan: `docs/plans/2026-11-01-convergence-phase-0.md`.

## Context

The architecture audit of 2026-11-01 measured what had been felt for a while. The desktop is a React application that also runs the product, and the always-on host is the same front-end code run headless with a registry patched alongside. The headline numbers follow.

**The runtime lives in the UI.**
- Of 105 provider initializers, 75 own a runtime behaviour. 29 of those have a headless counterpart.
- 46 do not. 14 of those are documented; **32 are recorded nowhere**.
- Chat turn orchestration is a 7,299-line React hook (`hooks/chat/use-claude-chat-controller.ts`) with no headless counterpart, so the CLI reimplemented steering and background results for itself.
- 294 `lib/` files read or write Zustand UI stores imperatively.
- Several behaviours are defined by "when the session is next opened". Background results are delivered then. Auto-archive exemptions read the chat store, which is empty on the brain.

**The two hosts drift.**
- `check-host-parity` has 183 baselined gaps and 65 subsystems classified as unmigrated, including `lib/agent`, `lib/ai`, `lib/chat` and `lib/claude`. It currently fails on 27 unclassified subsystems.
- `check-headless-registry` passes while missing gaps, because it recognizes runtime effects by name (`install*`, `start*`, `register*`).

**Every feature rebuilds the same machinery.**
- 383 Dexie tables.
- About 23 run or task records, spelling success four ways.
- About 17 durable queues with at least five backoff curves, beside a shared retry policy few of them use.
- About 22 concurrency limiters that know nothing of each other.
- About 15 dedup mechanisms, several of them non-unique check-then-write.

**Chokepoints are conventions.**
- No gate enumerates the callers of the outbound planners.
- The delivery gateway's static test sees one import spelling in five directories.
- The PII gate checks imports, not calls.
- `observeActingAuthority` is audit-only by contract, and "only writer" rules are mostly comments.

**A confirmed defect shows the cost.** The router-fusion outbox retries a failing effect forever, with no backoff or cap. Once more than 500 poison rows exist, it starves every newer effect.

None of this comes from bad parts. Many parts are careful and the gates exist. It comes from how they are assembled and from features growing faster than convergence.

The registry needed to fix it already exists. `lib/headless/types.ts` states the intended design: "the provider becomes a thin wrapper on desktop and `bootstrapHeadlessRuntimes()` starts the same code in Node". But only the brain boots from it. The desktop never does, so the registry is a port destination rather than the source of truth.

## Decision

### 1. One kernel, every host boots it

- **The kernel** is every long-running behaviour Cognia has: schedulers, delivery runners, recovery, connectors, bots, sync, chat turn orchestration, steering, background results, wakeups, watchers.
- **It lives in `lib/`** as `HeadlessRuntime` entries in `lib/headless/registry.ts`. The registry keeps its path and gains a host, `"desktop"`, beside `"brain"` and `"person-brain"`.
- **The desktop boots from the registry.** It boots the kernel through one provider that calls `bootstrapHeadlessRuntimes({ host: "desktop", bridge })` with the Tauri bridge.
- **What initializers keep.** A provider initializer that owns a runtime is replaced by a registry entry. Initializers keep only renderer-bound work, such as window reveal, the webview lease and PWA badges, each listed in the exclusions file with a physical reason.
- **Host differences are capabilities, not branches.** A runtime asks the bridge or a capability object what the host can do. It does not test `isTauri()` or read UI state to decide. A runtime that genuinely cannot run on a host declares that in its entry; the parity gate reads the declaration.
- **Mobile and paired clients are clients** of a host's kernel, not hosts of their own.

### 2. Kernel rules

- **No React.** Kernel code imports nothing from `@/components/` or `@/hooks/`, and no React.
- **No decisions from UI stores.** State the kernel needs lives in the kernel's own state, Dexie or the host store, and UI stores subscribe to it. An import of `@/stores/` from kernel code is allowed only for the UI to observe the kernel, never the reverse, and is ratcheted to zero.
- **No "when it next opens".** A behaviour that must happen happens when its trigger happens. Whether a person is looking only changes how it is shown.
- **One chat engine.** Chat turn orchestration (send, steer, approve, stop, background-result delivery) is a kernel module, `lib/runtime/chat-engine/`. The desktop hook, the brain and the TUI drive it. The duplicates are deleted, not kept.

### 3. Four shared primitives

1. **Durable queue.** One module provides lease and claim, a due time, retry through the existing `decideNextAttempt` policy (`packages/plugin-contract/src/lib/queue/retry-policy.ts`), a dead-letter state, and a **unique** idempotency key. It also takes a per-queue concurrency and an inspection view. Every persisted queue moves onto it.
2. **Limiter.** One origin-aware limiter (ADR-0248): permits, a reserved person permit, a two-band queue, stop never queued. Every concurrency cap becomes an instance with its own limit.
3. **Run ledger.** `executionRuns` is the only record of a run. Engine-specific tables keep engine detail and point at their run. The status vocabulary is the ledger's: `completed` is the success state, and other spellings are projections at the edge.
4. **Commitment.** Long-lived work is a delegation promoted to an issue (ADR-0247), and it is where every entry point's work lands.

A new feature that needs a queue, a limit, a run or a commitment uses these. A second implementation fails a gate (§5).

### 4. Chokepoints a gate can enumerate

Each of these is reached through one module, and a gate enumerates its callers:
- outbound review planning (ADR-0239);
- connector delivery;
- network egress;
- PII redaction before a model call;
- authority checks at resume.

A gate is a check that walks the source and lists every call site, not one that checks an import exists. Shadow modes switch to enforce per category only once the gate shows full coverage (ADR-0239, ADR-0247 §7).

### 5. Ratchets

`scripts/gates/check-convergence.mjs` records a baseline and fails when any count rises. Each phase lowers its counts and locks them with `:baseline`.

| Metric | Baseline (2026-11-01) |
| --- | --- |
| Runtime-owning initializers with no registry entry and no exclusion | 32 |
| `check-host-parity` baselined findings | 183 |
| Kernel (`lib/`) files reading `@/stores/` imperatively | 294 |
| `lib/` files importing `@/hooks/` or `@/components/` | 64 |
| Persisted queues not on the durable-queue primitive | ~17 |
| Concurrency caps not on the limiter | ~22 |
| Run-like tables not linked to `executionRuns` | measured in phase 0 |

The headless-registry gate stops matching on names. Any `@/lib/**` function an initializer calls inside an effect must be reachable from the brain's module graph, be desktop-booted through the registry, or be excluded with a physical reason.

### 6. How a piece moves (strangler, never a rewrite)

1. **Characterize.** Write a test that drives the behaviour on both hosts (desktop provider and Node brain) and pins what it does today, bugs included and labelled.
2. **Move.** Make the behaviour a registry entry or a primitive instance; the old path calls the new one.
3. **Delete** the old path in the same phase. Two live implementations never outlast the phase that created the second one.
4. **Lower the baseline** and lock it.

Each phase runs in its own worktree branch. Mechanical migrations, such as moving a queue onto the primitive or turning a cap into a limiter instance, go to Codex in batches. Architecture, kernel extraction and review stay with Claude. Every phase keeps an evidence ledger under `docs/evidence/`.

### 7. Capacity

A fixed share of capacity, about half, goes to convergence until phase 4 exits. Features continue, but on the primitives and the registry. The phase 0 gates make the old way fail, so new work cannot add to the debt being paid down.

### 8. Phases and exit criteria

| Phase | Scope | Exit when |
| --- | --- | --- |
| 0. Stop the bleeding | Convergence gate and baselines; name-agnostic headless-registry gate; host-parity gate green again; fix the router-fusion outbox; verify the audit's two high-risk items; this ADR | All gates green on `dev`; every baseline recorded; both high-risk items answered with a test |
| 1. Primitives | Durable queue and limiter modules; every queue and cap migrated | Queue and limiter counts at 0; ADR-0248 implemented through the limiter |
| 2. Kernel out of the UI | Desktop boots from the registry; chat engine extracted; every runtime initializer migrated or excluded with a reason | Undocumented gaps 0; kernel `getState()` 0; `lib`→`hooks`/`components` 0; host-parity findings only of the physically-impossible class |
| 3. Work spine | Run-like tables point at `executionRuns`; one status vocabulary; ADR-0247 commitments | Every run is in the ledger; one success spelling inside the kernel |
| 4. Chokepoints, then enforce | Caller-enumerating gates for every chokepoint; per-category enforce | Gates show full coverage; enforce on by default for categories that pass |

Phase 2 is the largest, and the one this ADR exists for. Phases 0 and 1 come first because they are cheap and they stop new debt, and because the primitives are what the kernel is built from.

## Consequences

- Feature parity between the desktop and an always-on host becomes structural: both run the same registered kernel. The rule ADR-0059 stated becomes how the desktop boots, not a rule the desktop is exempt from.
- About half of capacity goes to convergence for several months, and features slow by that much. The ratchets make the progress measurable, and any phase can stop at an exit without leaving two live implementations.
- Some desktop behaviour that only worked because a window was open will change. It will happen when its trigger happens, not when someone looks. Each such change is a characterized, labelled difference in its phase's evidence ledger.
- Local data is not migrated (CLAUDE.md), which makes reshaping tables cheaper. Whether that holds for account-sync replicas and host stores is checked per phase before any shape change.
