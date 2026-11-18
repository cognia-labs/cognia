---
title: "0258 — Every environment replaces a plugin package under one contract"
description: "Installing over, updating and rolling back a plugin is one operation, replacing an installed package, and every environment that performs it (the desktop updater and rollback, the CLI, the VS Code extension install, the headless Host, paired clients) follows the same five clauses: it installs only what was reviewed, honours a cancel until the commit, returns the runtime to the state it was in, keeps the package, the runtime entry, the Dexie row and the install origin in agreement, and after a failure leaves one of two named recoveries. The clauses are data in lib/plugin/lifecycle/contract.ts, each environment runs them through its own test harness, and the gaps it has not closed are listed and pinned."
---

# ADR 0258 — Every environment replaces a plugin package under one contract

**Status:** Accepted
**Date:** 2026-11-18

**Related:**
- [ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs): install origins. The reconcile clause includes keeping the origin current.
- [ADR-0145](./0145-python-plugin-runtime-alignment): the Python runtime whose environment preparation the readiness states describe.
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings): the headless Host, one of the environments this contract covers.

**Evidence:** audit `docs/evidence/2026-11-08-plugin-support-audit.md` (findings PL01–PL19, gaps ENV01–ENV07). Fixes `de7889b157..81c5c55bc4` aligned the desktop updater and rollback, the CLI and the VS Code extension install. Plan: `docs/plans/2026-11-18-plugin-environment-readiness.md`.

## Context

A plugin's package is replaced in several places, each written separately:

- the desktop registry updater (`lib/plugin/lifecycle/updater.ts`) and explicit rollback (`rollback.ts`);
- the CLI's GitHub install and update (`cli/src/plugin/install.ts`, `cli/src/plugin/host.ts`, `cli/src/tui/runtime/plugin-controller.ts`);
- the VS Code extension install (`lib/plugin/vscode-shim/install-vscode-extension.ts`) and the Open VSX graph that drives it;
- the headless Host's reconcile after a native install (`cli/src/serve/plugin-runtime-adapter.ts`);
- paired clients, whose installs and staged updates run on the Host over companion RPC (`crates/cognia-companion-rpc/src/rpc/plugins.rs`).

The audit found the same defects in different combinations across them. Some installed bytes other than the reviewed ones (PL02, PL03, PL12, PL14, PL15). Some kept going after a cancel (PL16). Some activated a plugin that had only been loaded, or that the user had disabled (PL07, PL18). Some left the row, the store entry or the origin describing another version than the one on disk (PL04, PL05, PL10). Some left a stopped runtime, or a half-replaced package, after a failure (PL08, PL09, PL13). Each fix was local, so nothing stopped the next environment from repeating the mistake.

## Decision

### 1. One operation, five clauses

Install over an existing copy, update, and rollback are all one operation: **replacing an installed package**. Every environment that performs it meets these clauses:

1. **Identity binding.** The package committed is the one that was reviewed: same plugin id, same version, and the same digest where the source has one (a VSIX sha256, a GitHub commit, a bundled catalog's file inventory). A mismatch is refused before anything installed is touched.
2. **Cancellation.** A cancel is honoured until the commit, the moment the package on disk changes. After the commit the operation finishes its records and does not report success.
3. **Runtime state restoration.** The runtime returns to the state it was in, one of `enabled`, `suspended`, `loaded` or `stopped` (`lib/plugin/lifecycle/runtime-state.ts`). A replacement is never a reason to activate a plugin that was loaded, wake one that was suspended, or start one that was stopped or disabled.
4. **Reconcile.** Afterwards the package on disk, the runtime store entry, the Dexie row and the install origin describe the same version, and the plugin's data is at a data version that package can read. The data version is the package's major version. A rollback past a data migration brings the data back from the snapshot taken before that migration, after the user has confirmed what is discarded. With no snapshot, it refuses before touching anything.
5. **Recovery acceptance.** A failure is never reported as success. A failure before the commit leaves everything as it was, runtime included. A failure after the commit leaves one of two recoveries:
   - the previous package is back, and the runtime is either in its prior state or stopped with a restart requested;
   - the new package stays, its records describe it, its runtime is stopped, and the caller is told it must be restarted.

   Nothing in between is acceptable: a new package running on old records, old bytes with a new row, or a runtime left running on a half-finished replacement.

### 2. Readiness is part of the contract

Preparing a plugin's environment (Python dependencies today) is its own operation with its own consent. It is not hidden inside install. Its result is a readiness state the Host computes from what it recorded when it built the environment, never from guessing import names:

| State | Meaning |
| --- | --- |
| `not-required` | The plugin declares no environment. |
| `not-prepared` | The environment was never built for this package. |
| `needs-uv` | The plugin is locked (`uv.lock`) and uv is not installed; there is no fallback to an unlocked install. |
| `stale` | The environment was built for other requirements, another lock, or another interpreter. |
| `preparing` | Preparation is running. |
| `ready` | The environment matches the package. |
| `failed` | The last preparation failed. |
| `user-managed` | The user runs their own interpreter without a managed environment; readiness is not checked. |

An interpreter that does not meet the plugin's requirement adds a warning (`interpreterWarning`) and does not block. Implementing these states is step P3 of the plan; this ADR fixes the vocabulary.

### 3. The clauses are data, run by each environment's harness

`lib/plugin/lifecycle/contract.ts` holds the contract as data:

- `REPLACEMENT_SCENARIOS`: every prior runtime state, plus an identity mismatch, a failure before the commit, a failure after it, and a cancel;
- `contractViolations(scenario, versions, observed)`: the clauses an observation breaks, the data clause included when the harness reports a `dataVersion`;
- `CONTRACT_GAPS`: the clauses an environment has not closed, each with its reason;
- `NOT_YET_CONFORMING`: the environments that do not run the suite yet.

Each environment runs `scenariosFor(environment)` through the test harness it already has, observing the outcome, the package on disk, its records and the runtime afterwards. This keeps the adapters next to the code they exercise. A shared harness would have had to mock every environment's world again. `contract.test.ts` pins both lists, so closing a gap or adding an environment means editing this ADR, the module and the test together.

### 4. Where each environment stands

| Environment | Identity | Cancel | Runtime state | Reconcile | Recovery | Runs the suite |
| --- | --- | --- | --- | --- | --- | --- |
| Desktop registry update (`updater.ts`) | yes | **no**: `installUpdate` takes no signal | yes | yes | previous package back, runtime stopped, restart requested | `updater.test.ts` |
| Desktop rollback (`rollback.ts`) | **no**: the installed version is checked only after the package changed | **no**: takes no signal | yes | yes, data included | safety snapshot restores the previous package, stopped, restart requested | `rollback.test.ts` |
| CLI update (`plugin-controller.ts`) | yes | yes | yes | yes | new package kept, runtime stopped, restart requested | `plugin-lifecycle.integration.test.ts` |
| VS Code extension install | yes | **no**: cancel means not committing the staged graph | yes | yes | previous package, row, entry and origin back, runtime in its prior state | `install-vscode-extension.test.ts` |
| Headless Host reconcile | n/a (the native install already ran) | n/a | **no**: always enables | partly | none | not yet |
| Paired client (via the Host) | unverified per RPC command | unverified | Host-side | Host-side | Host-side | not yet |
| Capacitor mirror | read-only | — | — | queued versus applied labels only | — | not yet |

## Consequences

- A new environment that replaces packages, or a new failure mode, starts by adding a scenario or a gap to `contract.ts`. Code review then sees a contract change instead of a local fix.
- The gaps are explicit: no cancel point in the desktop update, the rollback or the VS Code commit, and a rollback that checks the installed version only after the package changed. Closing one means adding the check or cancel point before the commit, then deleting the gap entry.
- Plugin data takes part in the contract (plan P1). Before a data migration, the plugin's rows are copied into a snapshot in the same transaction. A failed update and a crash recovery undo the migration that update ran from that snapshot. An explicit rollback restores it only after confirmation. When the copy will not fit, the user chooses between migrating without one and cancelling the upgrade. A headless Host, with nobody to ask, migrates without one. Either way, the plugin's page shows which data version has no snapshot.
- The headless Host and paired clients are aligned last (plan P5). Until then their rows stay in `NOT_YET_CONFORMING` with the behaviour they still have.
- The contract is about the host's behaviour. It does not change the plugin contract (`@cognia/plugin-contract`), so the authoring kit pin is unaffected.
