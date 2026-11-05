# Evidence ledger: Issue tracker state flow overhaul

- Status: building
- Lane: deep
- Created: 2026-11-05
- Updated: 2026-11-05
- Related: [plan](../plans/2026-11-05-issue-tracker-state-flow-overhaul.md) (`45e95be92a`); [ADR-0132](../content/docs/en/adr/0132-issue-tracker.md); P1 commit `83497840c4`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> research the Issue task panel state flow, find gaps, clean up dead code and duplicate logic

## Knowledge

| ID  | Statement                                                                                                                                                          | State    | Basis                                                                                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Fix the issue tracker's state flow without simplification, close the gaps, and remove the dead and duplicated code inside the Issue subsystem, in six phases.      | Agreed   | Grill session 2026-11-05, decisions D1–D26 in the plan                                                                                        | -          |
| C1  | Shared working tree: commit only this task's paths; commit from a detached worktree while other sessions have files staged.                                        | Verified | CLAUDE.md rule 8; P1 committed from `~/p1-issue-commit`, `git show --stat` listed exactly the 57 planned paths                                | -          |
| O1  | `moveIssue` trusted a caller-supplied `runActive` that defaulted to false; the board drop, bulk status, phone and sync paths did not pass it.                      | Verified | `lib/db/issues.ts:297` at `1039587667`, read by Claude; caller census by a haiku Explore agent                                                | -          |
| O2  | The agent-team adapter fired `startTeam` without awaiting it, and its `onStartError` hook was never wired, so a Squad refusal was lost.                            | Verified | `lib/issues/run/agent-team-adapter.ts:366-377`, `install.ts` at `1039587667`                                                                  | -          |
| O3  | The agent-task adapter awaited the Scheduler's `runTaskNow`, which resolves with the settled execution, so an issue reached in_progress only after its task ended. | Verified | `lib/scheduler/task-scheduler.ts:2192` (`onAccepted` docblock); `lib/agent-tasks/runtime.ts:58-67`                                            | -          |
| O4  | `settleIssueRunAndIssue` used two transactions; a crash between them left a terminal run beside an in_progress issue that nothing revisited.                       | Verified | `lib/issues/run/registry.ts:269-286` at `1039587667`                                                                                          | -          |
| O5  | A team task left in `review` when its team stopped was settled as failed; a cancel wrote `run_failed` and always handed back to todo.                              | Verified | `agent-team-adapter.ts:384-412`, `lib/db/issue-runs.ts:350-356` at `1039587667`                                                               | -          |
| O6  | `startSquadRun` already resolves on acceptance (journalled, lifecycle fire-and-forget), so no Agent Team-side acceptance signal is needed.                         | Verified | `lib/ai/agent/team/squad/start-squad-run.ts:446-496`                                                                                          | -          |
| O7  | The sync engine already refused remote status writes while a run was active, so moving the check into `moveIssue` keeps its semantics.                             | Verified | `lib/issues/sync/engine.ts:295,355` at `1039587667`                                                                                           | -          |
| O8  | `lib/issues/sync/kept-copy-source.test.ts` fails at HEAD independent of this work: it expects a two-argument `resolveReadClient` call that now gets three.         | Verified | Jest run 2026-11-05; `lib/issues/sync/providers/github.ts` untouched by P1, last changed in `d881d6f702`                                      | -          |
| Q1  | Does the authoring-kit pin need a rebuild and publish for the `run_cancelled` / `statusBefore` contract change?                                                    | Open     | CLAUDE.md: any `packages/plugin-contract` change invalidates `lib/plugin/distribution/authoring-kit.json`; publishing pushes to a public repo | -          |

## Problem frame

The Issue tracker's runtime/human boundary held only where callers remembered to ask (O1), and the run bridge lost dispatch failures (O2), mistimed acceptance (O3), could strand issues on crash (O4) and misreported reviews and cancels (O5). P1 frames the outcome as: every door that moves an issue is held to the run lock by the write itself, a run reaches a truthful terminal state, and the issue lands where that state says. UI data flow, write-path consolidation, deduplication and dead code are later phases (plan §2) and out of this round.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                              |
| ------------ | ------ | ---------------------------------------------------------------------------------------- |
| scale        | high   | Six phases over ~150 files; P1 alone touched 57                                          |
| technical    | medium | Dexie transaction composition and two-phase dispatch; no new storage                     |
| coupling     | high   | Plugin contract (`run_cancelled`), Scheduler accept hook, Squad run records, wakeups, IM |
| requirement  | low    | 26 decisions settled with the user                                                       |
| verification | medium | Unit-level with fake-indexeddb; no real engine run in P1                                 |
| risk         | medium | Wrong locking strands or double-dispatches work; covered by tests but not by a real run  |

## Risks

| ID  | Risk (impact)                                                                     | Severity | Source               | Claim                                                                   | Refuted by                                             |
| --- | --------------------------------------------------------------------------------- | -------- | -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| R1  | Two dispatches race and both run against one issue                                | high     | Explore audit, O1    | `claimIssueRun` admits exactly one active run per issue                 | Two concurrent `startIssueRun` calls both resolving    |
| R2  | A reconcile polls a claim before its engine accepted and fails a healthy dispatch | medium   | design review        | Unbound claims are skipped until `ISSUE_RUN_DISPATCH_STALE_MS`          | A fresh unbound claim settled by reconcile             |
| R3  | The boot repair moves an issue a person deliberately put in in_progress           | medium   | design review        | Repair touches only issues the run's own window moved                   | A person-moved issue changed by `repairStrandedIssues` |
| R4  | Plugins listening to `run_failed` stop hearing about cancels they relied on       | low      | ADR-0132, plugin API | A cancel is a distinct `run_cancelled` kind, documented in the contract | A shipped plugin depending on cancel-as-failure        |

## Verification obligations

| ID  | Risk   | Method                                                                                                                                 | Independence | Evidence                                                                                    | Coverage                                                                      | Status |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| V1  | R1     | Concurrent claims and concurrent `startIssueRun` in `lib/db/issue-runs.test.ts` and `lib/issues/run/registry.test.ts`                  | tool         | Jest 2026-11-05: 22/22 and 36/36 passed                                                     | fake-indexeddb serialisation, one window; not two windows or a phone          | passed |
| V2  | R2     | Reconcile with a fresh and a stale unbound claim in `registry.test.ts`                                                                 | tool         | "reconcile skips a claim in flight and fails one left unbound past the stale window" passed | Boundary at exactly the stale window                                          | passed |
| V3  | R3     | `repairStrandedIssues` positive cases (succeeded, failed, cancelled, checked-in) and negatives (by hand, after a run, active, unbound) | tool         | `registry.test.ts` repair describe passed; `install.test.ts` boot repair passed             | Trail-ordered window check; rows from before `statusBefore` fall back to todo | passed |
| V4  | R1, R2 | Affected suites across issues, db, agent-tasks, skills, workspace, workflow, components, i18n                                          | tool         | Jest 2026-11-05: 208/209 suites, 3060/3061 tests; the one failure is O8                     | Unit and component level only                                                 | passed |
| V5  | R4     | Root typecheck with a temp config excluding foreign `tmp/` and `.claude/`                                                              | tool         | Only foreign error left: `lib/ai/agent/external/config/gateway-task.test.ts`                | Whole root project; sidecar checked separately by its own gate, not run       | passed |
| V6  | R1     | Real agent-task / agent-team / github-loop dispatch on the desktop                                                                     | real-env     | Not run: the user chose Jest + Playwright only (plan D26)                                   | -                                                                             | waived |

## Decisions

| ID  | Date       | Decision                                                                                                                       | Action    | Based on   | Reversal trigger                                          |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- | --------------------------------------------------------- |
| D1  | 2026-11-05 | Read the run lock inside `moveIssue`'s transaction; remove `runActive`                                                         | implement | O1, O7     | A door that must override the lock (none found)           |
| D2  | 2026-11-05 | Claim, dispatch, bind: the issue moves only after the engine accepts; dispatch failure settles the claim and rethrows          | implement | O2, O3, O6 | An engine whose acceptance cannot be observed             |
| D3  | 2026-11-05 | Accept-time agent-task start through the Scheduler's `onAccepted` (`startAgentTaskNow`), not the settle-time `runAgentTaskNow` | implement | O3         | `onAccepted` not called for some start path that does run |
| D4  | 2026-11-05 | One-transaction settle plus a boot repair ordered by the trail's own clock                                                     | implement | O4         | A stranded issue the repair misses, or a false repair     |
| D5  | 2026-11-05 | Team task in review when the Squad run ended counts as succeeded; cancel is `run_cancelled` and hands back to `statusBefore`   | implement | O5         | User revisits D7/D8 of the plan                           |

## Residual risks

| ID  | Residual                                                                                                    | From | Why still open                                                              | Next action                           | Status |
| --- | ----------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- | ------------------------------------- | ------ |
| X1  | No real engine dispatch has exercised the two-phase start or the Squad run id path                          | V6   | User scoped verification to Jest + Playwright                               | P6 Playwright spec covers the UI side | open   |
| X2  | The authoring-kit pin is stale after the contract change                                                    | Q1   | Rebuild needs a clean checkout and a push to the public cognia-plugins repo | Ask the user before publishing        | open   |
| X3  | Generated author-types also show nondeterministic key-order drift in provider-types, left out of the commit | V5   | Not caused by this work                                                     | None in this plan                     | open   |

## Outcome

| ID  | Signal                                                                                        | How / when measured                | Result | Status  |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------- | ------ | ------- |
| M1  | A cancelled or refused run never leaves an issue stuck in in_progress or a Run button blocked | P6 Playwright spec; later real use | -      | pending |
