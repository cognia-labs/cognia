---
title: "0250 — The runtime is a headless kernel the desktop embeds"
description: "Every long-running behaviour lives in one kernel, designed for an always-on host with no UI. Each host has one kernel and one data authority. On the desktop the kernel runs in the WebView, with one owner per process. A one-week spike measured the alternative, a local brain process, and rejected it for now on startup time and memory. Paired devices are clients. The standalone browser and mobile path stays a lightweight BYOK path outside the kernel. Clients queue intents while disconnected, and no host writes to a fallback authority. The kernel shares four primitives and gives execution engines explicit owners. Contracts are checked across languages. Plugins move to a new host/UI contract in one cutover. Migration is strangler-style, measured against reproducible inventories, and guarded by a dual-host test lane."
---

# ADR 0250 — The runtime is a headless kernel the desktop embeds

**Status:** Proposed
**Date:** 2026-11-01
**Revised:** 2026-11-01, after an adversarial review and an independent audit (see the audit's §10). §2 was decided on 2026-11-01 from spike S1.

**Related:**
- [ADR-0059](./0059-cloud-deployment-headless-brain): headless brain, registry rule
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings): always-on host
- [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility): unified execution
- [ADR-0137](./0137-delegation-runtime): delegation
- [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request): outbound authorization
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who): acting identity
- [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads), [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work), [ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent)

**Evidence:** `docs/research/architecture-convergence-audit-2026-11-01.md`. **Plan:** `docs/plans/2026-11-01-convergence-phase-0.md`.

## Context

The architecture audit (revised after a second, adversarial pass) found two root causes and several problems that cut across them.

**The runtime lives in the UI.**
- 105 provider initializers. 75 own a runtime behaviour. 29 have a headless counterpart.
- Up to 32 of the rest are recorded nowhere. 32 is an upper bound: some are documented after all.
- Chat turn orchestration is a 7,299-line React hook with no headless counterpart, so the CLI reimplemented parts of it.
- Kernel code is coupled to Zustand stores. Counting static imports, 355 `lib/` files import `@/stores/`. Counting dynamic imports, 475 do and 409 call them imperatively. Not all of those stores hold UI state.
- Some behaviours wait for "when the session is next opened".
- `check-host-parity` has a baseline of 183 findings, but the tree now has 200: 26 new, 9 closed.
- The registry that ADR-0059 introduced (`lib/headless/registry.ts`) is booted only by the brain. The desktop never uses it.

**There is no shared work kernel.**
- 393 Dexie tables.
- About 23 run-like records.
- About 17 durable queues on at least five backoff curves.
- About 22 caps that know nothing of each other.
- About 15 dedup mechanisms.

**Chokepoints are conventions.**
- No gate enumerates the outbound planners' callers.
- The delivery gateway's static test sees one import spelling.
- The PII gate checks imports, not calls.
- Resume authority checks are audit-only.
- 122 gates exist, but a PR can raise a ratchet baseline in the same change, because CI does not compare against the base commit.

**What the second pass added:**
- **Data authority switches with connectivity.** `DataPlane::pick` (`crates/cognia-companion/src/data_plane.rs:77`) prefers a connected brain, then the desktop renderer, then a writable SQLite fallback. Writes made during a brain outage have no reconciliation.
- **Plugins are a public boundary.** The contract has 938 methods across 91 namespaces, and only 120 of them declare headless support. `context.ts` builds runtime and UI APIs in one object.
- **Contracts have several semantic sources.** Rust signatures, dispatch, the manifest, Zod and the response schemas each define them. Generated output can be byte-identical while behaviour differs; `check-rpc-semantic-parity` currently fails at 114 opaque response schemas against a ceiling of 110. Business rules have already diverged: the workflow cron editor accepts `L` and `#`, the Rust daemon rejects them, and the failure is swallowed by `safeInvoke`.
- **Execution has about 17 paths:** two sidecar engines, 14 external protocol adapters and the completion rail. Their process, session, approval, cancellation and recovery ownership is implicit. Some caps protect real native resources, such as the Python host's semaphore; they are not business admission.
- **Standalone mode executes.** An unpaired phone and a browser with no Companion run chat turns in the WebView with the user's own keys (`lib/ai/chat/standalone-engine.ts`, 400 lines).
- **The dual-host safety net is thin.** 200 e2e specs exist, 24 of them for Tauri. Only 2 run against a real Web↔headless stack, and the Compose tier that runs them is not on the pull-request path.

## Decision

### 1. One kernel and one data authority per host

The **kernel** is every long-running behaviour: schedulers, delivery runners, recovery, connectors, bots, sync, chat turn orchestration, steering, background results, wakeups and watchers.

- It is registered as `HeadlessRuntime` entries in `lib/headless/registry.ts`.
- A host runs exactly one kernel.
- That kernel is the only writer of the host's application data.

### 2. Where the desktop runs its kernel

**Decision: the kernel runs in the WebView (2b).** The desktop keeps its single-process shape and meets four requirements explicitly:
- **One owner per process.** The kernel is started once per desktop process, by the main window or an elected leader. It has a start, a cancel, and an awaited teardown, all safe under StrictMode replay. Secondary windows are clients of that owner, never second kernels.
- **Account lifecycle.** The kernel joins the account and runtime-target lifecycle through `registerRuntimeTargetCleanup`. A lock or an account switch waits for the kernel's teardown before the database selection changes.
- **A host adapter matrix.** Each registry entry states how it is assembled on each host; the matrix lives in `docs/research/` (phase 0a A5). A brain entry cannot be reused on the desktop by swapping the bridge, because the event publisher, the connector server lifecycle and the plugin adapters differ. Parity between the desktop and a Host is held by the one registry, this matrix, and the dual-host lane (§12).
- **A storage budget for heavy accounts.** Today's WebView path is slow at scale. On a 200,000-message dataset, the first sidebar list arrives 5.6–6.8 s after a cold open, and the session-list p95 is 630–785 ms. Phase 2 carries its own budget for that path.

**Rejected for now: the desktop runs a local brain (2a).** Spike S1 measured 2a against ranges fixed before any measurement. The evidence ledger is `docs/evidence/2026-11-01-convergence-s1.md` on branch `spike/local-brain-s1`.
- **Storage passed.** The brain store was faster than the WebView on every operation. On the heavy dataset, the session-list p95 was about 50 ms, against about 700 ms for the WebView.
- **Startup and memory failed by a wide margin, for structural reasons.**
  - Added cold start was about +3.0 s on a real-sized account and about +37 s on the heavy one. The ranges were +0.8 s and +2.5 s.
  - Idle memory was 883 MB and 3.8 GB. The ranges were 400 MB and 800 MB.
  - The causes are fixed costs. An empty brain already needs 2.5 s and 669 MB to load its module graph, and the store restores every row into memory on boot.
  - Meeting the ranges needs an on-disk brain store and a much smaller module graph. Phase 2 cannot credibly deliver either.
- **More work besides.** 2a would also need:
  - the desktop's renderer fallback in `DataPlane::pick` removed;
  - four new brain-to-Tauri adapters: `browser_local_rpc`, `proxy_http_request`, `ocr_http_fetch` and `perf_start_sampling`;
  - several host stores re-homed.

**Reversal trigger.** Revisit 2a when both of these hold:
- A disk-backed brain store, with a reduced module graph, measures inside the S1 startup and memory ranges on both datasets.
- Non-JSON values round-trip through brain durability.

### 3. Clients and the standalone path

- **Paired devices** (mobile and browser with a Companion target) are clients of a host's kernel.
- **The standalone path is not part of the kernel.** An unpaired phone and a browser with no Companion target keep a lightweight BYOK path (`lib/ai/chat/standalone-engine.ts`).
  - Its capability list is stated (chat, search, documents) and pinned by a test.
  - It reuses the kernel's pure libraries: provider resolution, prompt composition, event mapping.
  - The kernel does not have to run in a browser for it.

### 4. One authority; clients queue intents

- **No silent fallback writes.** A host never writes application data to a fallback authority when its kernel is unavailable. The `Direct` branch of `DataPlane::pick` becomes read-only or reports the host unavailable.
- **A remote Host's brain is supervised.** `cognia-server` restarts it, and clients show a disconnected state while it is down.
- **Clients queue intents.** A client that cannot reach its host keeps what the person did as intents, not data, following the `mobileOutboundQueue` pattern. It replays them with idempotency keys when the host returns, and the host accepts or refuses each one. There is no second copy of the data to reconcile.

### 5. Kernel rules

- **No React.** Kernel code imports no React and nothing from `@/components/` or `@/hooks/`.
- **State has one owner.** State the kernel decides on is owned by the kernel, in its stores or database. A Zustand store holding domain state the kernel needs moves into the kernel, and UI stores subscribe to the kernel. Imperative reads of UI stores from kernel code are ratcheted to zero.
- **No "when it next opens".** A behaviour that must happen does so when its trigger happens.
- **One chat engine.** Chat turn orchestration is one kernel module, `lib/runtime/chat-engine/`. The desktop and TUI clients drive it through the host; duplicates are deleted.

### 6. Shared primitives

1. **Durable queue.**
   - Provides lease and claim, a due time with a scheduled wake, retry through `decideNextAttempt`, a dead-letter state, a unique idempotency key and an inspection view.
   - Queues in separate databases (for example `fusionOutbox`) migrate too.
   - Existing rows are upgraded, never hidden by a new index.
2. **Admission limiter, for business admission only.**
   - Origin-aware (ADR-0248), with a reserved person permit, two bands, and stops never queued.
   - Native resource backpressure stays where it protects a real resource, such as the Python host semaphore, sandbox pool slots and node install slots. It is listed in an inventory with its owner, and it is not migrated.
3. **Run ledger.** `executionRuns` is the only record of a run. Engine tables point at it by a real reference, not a field that happens to be named `runId`. Inside the kernel, success is spelled `completed`.
4. **Commitment** (ADR-0247). A thread followed by a commitment as owner has exactly one executor: the commitment.

### 7. Execution ownership

Each execution path declares one owner for each of its process, session, tool approval, cancellation, recovery and drain:
- the two sidecar engines;
- each external protocol adapter;
- the completion rail.

The declaration is an engine/host port contract, checked by a test per path. Merging paths is out of scope; making ownership explicit is not.

### 8. Contracts and shared business rules

- **One authority per contract kind.** Each kind of contract names its authoritative source: command signatures, requests, responses, events, errors, cancellation.
- **Cross-language fixtures.** Behavioural parity is checked with fixtures built from real serialization on both sides, not only by comparing generated bytes.
- **Shared business rules have shared test vectors.** This covers rules that exist in both TypeScript and Rust: cron, time zones, status vocabularies, serialization.
- **Failures are not swallowed.** A required registration or persistence call that fails is surfaced as a health state, never returned as `null`. The workflow cron divergence is the first case fixed.

### 9. Plugins: a new contract in one cutover

- **What breaks.** The plugin author API is replaced, not extended:
  - **Scope:** TypeScript, Python and WASM move to one new contract with a host layer (runs in the kernel) and a UI layer (runs in a client).
  - **Old contracts** are frozen and archived the way WASM `cognia:plugin@0.1.0` was.
  - **Untouched:** the VS Code extension compatibility layer, which follows VS Code's own API.
- **Whom it affects.** Only first-party plugins are migrated; there are no external authors to support.
- **When.** The cutover happens with phase 2, when the kernel moves.
- **Host-side UI calls.** A plugin running on the host that asks for UI work, such as a dialog or a selection change, is routed to an online client. With no client online, the call fails with a named error.
- **The contract itself** is its own ADR, written during phases 0a and 1 from the plugin API matrix (§13).

### 10. Chokepoints a gate can enumerate

These are each reached through one module, and a gate lists every call site:
- outbound review planning;
- connector delivery;
- network egress;
- PII redaction before a model call;
- resume authority checks, live per ADR-0243 §2 and ADR-0247 §7.

Shadow modes switch to enforce per category only after their gate shows full coverage. Enforcement decisions are persisted with the work they authorize, so a mode switch never has to guess what was decided earlier.

### 11. Ratchets that cannot be quietly raised

- **Reproducible inventories.** Baselines are inventories with members (file, symbol, table and owner), produced by a committed counter at a recorded commit. They are not heuristic counts.
- **Baselines cannot grow quietly.** `scripts/gates/check-convergence.mjs` fails when a count rises. A baseline check compares every ratchet file against the merge base and fails on growth, unless the PR carries an exception record with an owner and a repayment phase.
- **The headless-registry gate** keeps its "called inside the reachable set" rule and widens only which symbols it considers.

| Metric | Baseline (to be fixed by phase 0a's counter) |
| --- | --- |
| Runtime-owning initializers with no registry entry and no exclusion | ≤ 32 (member list in 0a) |
| `check-host-parity` findings | 200 (A 96, C 104) |
| `lib/` files using `@/stores/` imperatively | 294 static / 409 with dynamic imports |
| `lib/` files importing `@/hooks/` or `@/components/` | 64 static / 74 with dynamic imports |
| Durable queues not on the primitive | inventory in 0a (~17) |
| Business caps not on the limiter | inventory in 0a (~22 total caps, native ones listed separately) |
| Run-like tables without a real `executionRuns` reference | inventory in 0a |

### 12. How a piece moves

1. **Characterize** it on both hosts, using the dual-host harness from phase 0a. Changes to the kernel or to contracts run a blocking brain integration lane on pull requests.
2. **Move** it, and **delete** the old path in the same phase.
3. **Lower the baseline.**

Each phase has its own worktree branch and evidence ledger. Codex does the mechanical migrations in batches; Claude does architecture, extraction and review. About half of capacity goes to convergence until phase 4 exits. Features continue on the new primitives, and phase 0 gates block the old way.

### 13. Phases and exit criteria

| Phase | Scope | Exit when |
| --- | --- | --- |
| 0a. Truth and safety net | Gate health on a clean worktree; reproducible inventories and counter; baseline-growth check; dual-host harness and PR lane; host adapter matrix; plugin API matrix | Inventories committed; baselines exact; harness drives one behaviour on both hosts in CI |
| S1. Local-brain spike (parallel to 0a, one week) | Five measured questions: storage, startup, migration, one turn across two windows, crash and restart | Done: 2a rejected for now; §2 decided as 2b |
| 0b. Fixes (parallel, not waiting for S1) | Router-fusion outbox with row upgrade and due wake; cron divergence and swallowed failures; no fallback writes; persisted outbound authorization provenance; the 26 new host-parity findings; headless-registry gate widened | All gates green on `dev`; each fix has its test |
| 1. Primitives | Durable queue and limiter; every queue and business cap migrated; native backpressure inventoried | Queue and business-cap inventories empty; ADR-0248 on the limiter |
| 2. Kernel out of the UI | Single-owner WebView kernel booted from the registry, with the adapter matrix and the heavy-account storage budget; chat engine extracted; every runtime initializer moved or excluded with a physical reason; plugin contract cutover | Undocumented gaps 0; kernel UI-store reads 0; `lib`→`hooks`/`components` 0; host-parity only physical; first-party plugins on the new contract |
| 3. Work spine | Run tables reference the ledger; one status vocabulary; ADR-0247 commitments | Every run in the ledger |
| 4. Chokepoints, then enforce | Caller-enumerating gates; per-category enforce | Full coverage shown; enforce on for passing categories |

## Consequences

- **The desktop and a Host stay two hosts of one kernel.** They boot the same registry in different processes. Parity therefore depends on the adapter matrix and the dual-host lane, not on running the same binary. In exchange, the desktop avoids a second process, the startup cost and a data migration.
- **S1 exposed known costs in the always-on host's brain.** On a heavy account, it takes about 37 s to serve again after a crash and holds about 3.8 GB resident. Durability also lost non-JSON values, which phase 0b fixes. A disk-backed brain store is follow-up work for ADR-0224 hosts, and it is also the precondition for revisiting 2a.
- **Plugins break once,** in phase 2. First-party plugins are rewritten then; the old contracts stay readable as frozen history.
- **About half of capacity** goes to convergence for several months. Progress is measured against inventories that cannot be quietly raised.
- **Some behaviours change.** Behaviour that worked only because a window was open will now happen when its trigger happens. Writes during an outage now wait as intents instead of landing in a fallback store. Each change is recorded in its phase's evidence ledger.

## Open questions

- **The new plugin contract.** It gets its own ADR.
- **The heavy-account storage budget** for the WebView kernel. It is set at the start of phase 2.
