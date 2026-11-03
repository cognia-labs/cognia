# Evidence ledger: plugin storage write errors

- Status: verifying
- Lane: standard
- Created: 2026-11-03
- Updated: 2026-11-03
- Related: ADR-0246; P8c commit `9406caedfb`

## Original request

> Make the non-durable path surface write failures to the caller (reject), matching the durable path. First check every in-tree caller of `ctx.storage.set` / `createStorageAPI` under `plugins/`, `lib/` and `packages/` for code that relies on the silent behaviour, and adjust those callers so nothing that used to work starts failing at activation. `remove` has the same shape; check it too.

## Knowledge

| ID  | Statement                                                                                                                         | State    | Basis                                                                           | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- | ---------- |
| O1  | Browser `set` logs and resolves after `setItem` failures; headless `set` rethrows.                                                | Observed | `lib/plugin/api/storage-api.ts`, inspected 2026-11-03                           | -          |
| O2  | Browser `remove` directly calls `removeItem` and already rejects; `delete` awaits `remove`.                                       | Observed | Same source, inspected 2026-11-03                                               | -          |
| O3  | Quest activation and event updates detach persistence promises without a rejection handler.                                       | Observed | `plugins/pet-daily-quests/src/index.ts`, `quest-store.ts`, inspected 2026-11-03 | -          |
| G1  | Reject failed writes, preserve optional persistence at activation, test quota rejection, audit callers and add a patch changeset. | Agreed   | User request 2026-11-03                                                         | -          |
| C1  | Preserve Feishu read-back verification and unrelated shared-tree edits; commit explicit task paths only.                          | Verified | User request; task paths and staged index initially clean                       | -          |

## Problem frame

An acknowledged browser write can lose a checkpoint (O1). Propagate the original failure at the API boundary and protect optional detached quest persistence (O3). Keep removal behavior (O2) and Feishu's safeguard (C1). Storage format, reads, quota accounting and headless durability are outside this change.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                 |
| ------------ | ------ | --------------------------------------------------------------------------- |
| scale        | low    | One API catch and one plugin callback with co-located tests.                |
| technical    | low    | Rethrow the original exception; catch optional writes at the caller.        |
| coupling     | medium | Shared plugin API, including secure writes and sync checkpoints.            |
| requirement  | low    | Explicit behavior, compatibility and release criteria.                      |
| verification | low    | Browser-storage fault injection and activation tests exercise the contract. |
| risk         | medium | Unhandled rejection at startup or falsely successful checkpoints.           |

## Caller audit

All source references to `createStorageAPI`, context storage and storage `set`, `setSecure`, `remove`, and `delete` under `plugins/`, `lib/`, and `packages/` were searched, including TSX/JavaScript and injected aliases, excluding generated build outputs. CodeGraph has no index here; source searches and call-path reads were used.

| Caller / path                                                                                                               | Failure contract and activation impact                                                                                                                                        | Action                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `lib/plugin/core/context.ts`; `lib/plugin/api/index.ts`                                                                     | Full context constructs the API without writing; barrel re-exports it. Legacy base-context storage already propagates writes and is replaced by the full API for activation.  | Preserve.                                                           |
| `lib/plugin/vscode-shim/webview-restoration.ts`                                                                             | Deferred factory; queued panel metadata writes end in `.catch(warn)`.                                                                                                         | Preserve.                                                           |
| `plugins/pet-daily-quests/src/index.ts`, `quest-store.ts`                                                                   | Activation hydration, events and reward claims detach writes while retaining in-memory state.                                                                                 | Catch/log in the injected persistence callback, covering all paths. |
| `plugins/cognia-glance-example/src/index.ts`                                                                                | Command-only writes; `persist` already catches/logs.                                                                                                                          | Preserve.                                                           |
| `plugins/clipboard-history/src/index.ts`                                                                                    | Secure writes occur in capture/clear tools and polling, not activation. Detached poll catches errors; tools await persistence before success.                                 | Preserve error propagation.                                         |
| `plugins/prompt-templates/src/template-store.ts`, `index.ts`                                                                | Save/remove are awaited commands; activation only reads/listens. Subscribers are notified only after successful persistence.                                                  | Preserve `set` and `remove` propagation.                            |
| `plugins/config-governance/src/host.ts`, `runtime/store.ts`, `runtime/runtime.ts`, `index.tsx`                              | Injected writes belong to explicit audit/configuration actions. Activation loads enforcement with reads only. Exclusive tasks expose errors; scheduler catches task failures. | Preserve propagation.                                               |
| `plugins/example-sync/src/index.ts`                                                                                         | Driver apply/tombstone await mirror writes; activation registers/requests sync. Host handles driver failures without advancing cursors.                                       | Preserve propagation.                                               |
| `plugins/feishu-calendar/src/sync.ts`, `index.ts`                                                                           | Sync awaits checkpoints and reads back write-ahead state. Activation registers handlers without writing; subscription sync catches per-calendar failures.                     | Keep all verification unchanged.                                    |
| `plugins/github-devin-bot/src/monitor.ts`, `execute.ts`, `index.ts`                                                         | Awaited Bot-run writes cover publication recovery, dispatch/backfill/repair deduplication, cursors and retry state. Activation only captures context.                         | Preserve propagation: failed checkpoints must fail the run.         |
| `plugins/github-comment-bot/src/handler.ts`, `receive.ts`, `readiness.ts`, `tracking.ts`, `index.ts`                        | Awaited Bot-run cursors, seen revisions, trigger claims and tracking. Activation only captures context; best-effort tracking updates already catch/log.                       | Preserve propagation.                                               |
| `packages/plugin-sdk/src/testing/index.ts`; `packages/plugin-contract/src/types/plugin/plugin.ts`, `contracts/generated.ts` | In-memory test context and type/contract declarations; no production browser-storage writer.                                                                                  | No caller changes.                                                  |
| Other `storage.set/remove` matches                                                                                          | Account storage is Capacitor Preferences; companion transport uses an injected config store. Package RAG/eval stores and browser-tools page storage are independent APIs.     | Outside `ctx.storage`.                                              |

`setSecure` awaits `set` and rethrows, so it now receives browser failures too. `getSecure` migration already catches failures. No production `ctx.storage.remove/delete` caller besides the template store was found.

## Risks

| ID  | Risk (impact)                          | Severity | Source       | Claim                                                                      | Refuted by                                               |
| --- | -------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| R1  | Lost checkpoint reported as success    | medium   | O1; ADR-0246 | Browser write failures reject with the original exception.                 | Quota/security/generic write failure resolves.           |
| R2  | Detached quest write becomes unhandled | medium   | O3           | Activation, progress and claims retain in-memory behavior and log failure. | Rejection escapes or registration/progress/claims break. |
| R3  | Removal semantics regress              | low      | O2           | Remove/delete reject browser refusal and retain the value.                 | Either resolves or removes the value.                    |

## Verification obligations

| ID  | Risk       | Method                                                  | Independence | Evidence                                                                                                                                                                                                                                                                               | Coverage                                                                         | Status |
| --- | ---------- | ------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| V1  | R1, R3     | API fault injection before/after fix                    | tool         | Before fix: four write tests failed with `Received promise resolved instead of rejected`; removal tests passed. After fix: focused run below passed 4 suites / 62 tests.                                                                                                               | Quota/security/generic and secure writes; remove/delete; existing headless tests | passed |
| V2  | R2         | Activation/event/claim regression                       | tool         | Before fix: quest test failed because no warning was logged. After fix: activation, event progress and reward claim pass with rejected saves (same 62-test run).                                                                                                                       | Optional persistence failure is logged; in-memory behavior works                 | passed |
| V3  | R1, R2, R3 | Caller tests, scoped review, lint, typecheck and format | tool         | Caller run: 19 suites / 285 tests passed. Scoped ESLint and Prettier passed. Simplify reviewed reuse, simplification, efficiency and altitude; one duplicate rethrow was simplified and retested. Test-gap audit found no gaps. Full lint/typecheck failed outside task paths; see X1. | In-tree callers; no live provider credentials needed                             | failed |
| V4  | R1         | Plugin contract and SDK gates                           | tool         | `pnpm plugin:contract:check` passed; `pnpm plugin:author-imports` passed for 81 plugins; `pnpm author-types:check` reported a stale SDK bundle; see X2.                                                                                                                                | Existing public API shape/import boundaries; no signatures changed               | failed |

## Decisions

| ID  | Date       | Decision                                                                                                                                       | Action    | Based on           | Reversal trigger                                          |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | --------------------------------------------------------- |
| D1  | 2026-11-03 | Rethrow shared API writes; handle optional quest persistence at its injection point. Test remove/delete without changing their implementation. | implement | O1, O2, O3, G1, C1 | Another activation path depends on silent writes.         |
| D2  | 2026-11-03 | Preserve task scope and carry unrelated full-repository gate failures; do not regenerate the unrelated SDK type bundle.                        | ship      | G1, C1, O1, O2, O3 | A gate reports a diagnostic in this task's changed files. |

## Residual risks

| ID  | Residual                                   | From | Why still open                                                                                                                                                                                                                                                                                                                                                                                                                   | Next action                                                                                                                           | Status |
| --- | ------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Full lint and typecheck are not green.     | V3   | Lint: 11 unused-variable warnings in `scripts/gates/check-baseline-growth.test.mjs`, `check-convergence.test.mjs`, `convergence/counter.mjs`, `convergence/plugin-api-matrix.mjs`. Typecheck: TS2352 in `lib/ai/agent/external/config/gateway-task.test.ts:26`; TS2820 for `storage:read` in `lib/plugin/core/manager.test.ts:3963`. Both type-error files contain other sessions' edits. No changed task file has a diagnostic. | Owning work resolves those diagnostics, then rerun `pnpm lint` and `pnpm typecheck` (root failure prevented the later sidecar check). | open   |
| X2  | Author type bundle freshness is not green. | V4   | `author-types bundle is stale` for `types/cognia-plugin-sdk.d.ts`; this change alters no public signatures. The check built its temporary declarations but did not rewrite tracked bundles.                                                                                                                                                                                                                                      | Owners of concurrent API/type changes regenerate their bundle and rerun `pnpm author-types:check`.                                    | open   |

## Outcome

| ID  | Signal                                                                      | How / when measured                                      | Result                                                                                                                                                     | Status |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | A browser-refused checkpoint rejects while the quest plugin remains usable. | Deterministic before/after fault injection on 2026-11-03 | Original regression checks fail before the patch and pass after it. Feishu source is unchanged and its sync tests pass, including the read-back safeguard. | met    |

## Validation commands

Focused final run:

```sh
rtk pnpm test -- lib/plugin/api/storage-api.test.ts lib/plugin/api/storage-api-secure.test.ts plugins/pet-daily-quests/src/index.test.ts plugins/pet-daily-quests/src/quest-store.test.ts --runInBand --silent
```

Result: `Test Suites: 4 passed, 4 total`; `Tests: 62 passed, 62 total`.

The separate 19-suite caller run used the audited plugins' activation suites, the template/governance stores and governance runtime, Feishu sync, GitHub Comment Bot handler/readiness/receive/tracking, GitHub Devin Bot execute/monitor, and webview restoration. Result: `Test Suites: 19 passed, 19 total`; `Tests: 285 passed, 285 total`.

`pnpm exec eslint` on the four changed TypeScript files and `pnpm exec prettier --check` on all six task paths passed. `pnpm lint:i18n` passed key parity, baseline and referenced-key checks. `pnpm lint:static-export` passed: 12,082 TS files audited with no disallowed Node imports. Full-check logs are under `.cache/verification/plugin-storage-write-errors/`. No coverage, full production build, real Tauri shell or live provider acceptance is claimed.
