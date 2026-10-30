# Evidence ledger: route search console errors

- Status: verifying
- Lane: standard
- Created: 2026-10-29
- Updated: 2026-10-29
- Related: `app/page.tsx`, `components/global-search/`, `lib/db/encrypted-content-middleware.ts`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> Console Error: params are being enumerated; The keys of searchParams were accessed directly; Runtime TransactionInactiveError: Transaction has already completed or failed; likely sidebar search.

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                  | State        | Basis                                                                                                                                                                                    | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | The original `/` session reported both asynchronous route-prop enumeration warnings and TransactionInactiveError.          | Observed     | Next.js 16.4.2 MCP get_errors and `.next/dev/logs/next-development.log`, macOS, 2026-10-29. Original error stacks were empty.                                                            | -          |
| O2  | Transaction errors also occurred in background outbox, notification and read-marking operations before the route warnings. | Observed     | Development log around 07:14:57 and 07:15:41; these are log timestamp fields, not reconstructed local event times.                                                                       | O1         |
| O3  | A fresh browser profile opened search, searched for `test`, and returned two results without captured errors or warnings.  | Verified     | In-app browser, `/`, 2026-10-29. This profile does not contain the original account's history.                                                                                           | -          |
| O4  | After the existing Tauri page reloaded, its earlier error loop stopped and Next.js MCP returned empty sessionErrors.       | Observed     | Tauri debug console and Next.js MCP get_errors, 2026-10-29; no production code was edited by this investigation.                                                                         | O1         |
| O5  | The user confirmed that opening sidebar search no longer reports the errors.                                               | Observed     | User response: 现在已不再报错, 2026-10-29 Asia/Shanghai.                                                                                                                                 | O4         |
| H1  | Home directly enumerates asynchronous route props.                                                                         | Invalidated  | `app/page.tsx` does not consume route props; its query consumers use useSearchParams under Suspense. Installed Next.js page API documentation was inspected.                             | O1         |
| H2  | A recursive diagnostic serializer traverses a Promise proxy.                                                               | Hypothesized | Next.js emits these exact warnings from Promise proxy ownKeys traps. Logging and agent-debug serializers traverse arbitrary objects, but no original caller stack establishes this path. | O1         |
| H3  | Transaction scope or keep-alive timing fails during concurrent encrypted reads and writes.                                 | Hypothesized | Original transaction error and existing middleware's native WebCrypto awaits; focused tests and a real WebKit fixture did not reproduce it.                                              | O1         |
| G1  | Sidebar search works without the three reported errors.                                                                    | Agreed       | Original error report, sidebar-search clarification, and recovery confirmation, 2026-10-29.                                                                                              | -          |

## Problem frame

Investigate the reported errors without treating their temporal proximity as proof of a shared cause. Success for the observed incident is restored sidebar search (G1); a permanent root-cause fix additionally requires a reproducible failing path. The current incident recovered after page reload and the user confirmed recovery (O4, O5). No production source, account data, schema, dependency, or retry policy was changed.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating  | Why / what would resolve it                                                                             |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| scale        | unknown | Original enumeration and transaction call sites are absent from captured stacks.                        |
| technical    | medium  | Native WebCrypto, IndexedDB transaction activity, and Next.js Promise proxies require runtime evidence. |
| coupling     | medium  | Encryption middleware is shared by many database consumers and shells.                                  |
| requirement  | low     | User identified sidebar search and confirmed recovery.                                                  |
| verification | medium  | Fresh browser and real WebKit checks are available, but the original failure no longer reproduces.      |
| risk         | low     | This investigation made no production change and used an isolated disposable fixture database.          |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                           | Severity | Source                                                                                            | Claim                                                       | Refuted by                                                                    |
| --- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R1  | A speculative route-prop change fails to address the actual enumerator. | medium   | Installed Next.js page API documentation and independent source review                            | Change only a demonstrated failing path.                    | Production code is changed without identifying an enumerating caller.         |
| R2  | Fake IndexedDB hides browser transaction timing failures.               | medium   | Existing encrypted-content-middleware tests document this limitation; Dexie waitFor documentation | Run a real WebKit check in addition to unit tests.          | A transaction fails in WebKit while the unit suite passes.                    |
| R3  | Recovery is misreported as a permanent root-cause fix.                  | medium   | Original logs and runtime recovery observation                                                    | Explicitly separate current recovery from root-cause proof. | Report claims a code fix or permanent resolution despite no reproduced cause. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                          | Independence | Evidence                                                                                                                                                        | Coverage                                                                                                                                                                      | Status  |
| --- | ---------- | --------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1         | Inspect route props and search call paths                       | subagent     | Read-only review found no direct route-prop access by Home/global search; Next.js warning traps confirmed.                                                      | Rules out direct Home access; does not identify the original serializer.                                                                                                      | passed  |
| V2  | R2         | Focused encryption regression suite                             | tool         | `rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --runTestsByPath lib/db/encrypted-content-middleware.test.ts`: 1 suite, 20 tests passed. | Existing ciphertext, lock, cursor, cache, and read-then-write cases; no coverage run.                                                                                         | passed  |
| V3  | R2         | Isolated native WebKit transaction fixture                      | real-env     | `rtk proxy node .cache/route-db-errors/probe.mjs`: `{after:60, failures:[], ok:true}`.                                                                          | Temporary database with 30 sessions and 60 messages; 30 concurrent encrypted cursor, projection-read, and transactional-write operations. Fixture database deleted afterward. | passed  |
| V4  | R3         | Recheck running application and original user path              | human        | Next.js MCP returned `sessionErrors: []`; user confirmed sidebar search no longer errors.                                                                       | Current recovery only; original historical failure was not reproduced.                                                                                                        | passed  |
| V5  | R1, R2, R3 | Capture original failing call stack and verify a root-cause fix | real-env     | Original stacks were empty; fresh browser and current Tauri session did not reproduce the failure.                                                              | Cannot establish a permanent fix without a failing path.                                                                                                                      | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                 | Action   | Based on   | Reversal trigger                                                  |
| --- | ---------- | -------------------------------------------------------------------------------------------------------- | -------- | ---------- | ----------------------------------------------------------------- |
| D1  | 2026-10-29 | Investigate both errors independently; avoid adding React.use() to a component that ignores route props. | diagnose | O1, O2     | A captured stack identifies direct route-prop access.             |
| D2  | 2026-10-29 | Finish this investigation with recovery evidence and no production patch. H2 and H3 remain unproven.     | stop     | O3, O4, O5 | Recurrence with exact search text, steps, or a useful call stack. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                         | From | Why still open                                                                                           | Next action                                                                                                                          | Status |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Original enumeration and inactive-transaction causes remain unconfirmed.                                         | V5   | Reload cleared the failure before a discriminating stack was captured.                                   | On recurrence, capture the stack at enumeration/rejection and replay the exact search steps before editing source.                   | open   |
| X2  | Standard pnpm invocation attempted dependency verification and failed in an unrelated sidecar postinstall check. | V2   | `@cognia/agent-config-types/plugin-interception` resolved to TypeScript instead of compiled Node output. | The same repository Jest entry point ran successfully with verify-deps-before-run=false; dependency repair is outside this incident. | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                       | How / when measured                                        | Result                                                  | Status |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- | ------ |
| M1  | Sidebar search no longer produces the three reported errors. | Current Next.js runtime plus user confirmation, 2026-10-29 | Recovered after reload; no production code fix claimed. | met    |

## Sources

- [Next.js asynchronous dynamic APIs](https://nextjs.org/docs/messages/sync-dynamic-apis); also inspected the installed 16.4.2 documentation under `node_modules/next/dist/docs/`.
- [Dexie.waitFor](<https://dexie.org/docs/Dexie/Dexie.waitFor()>); also inspected the installed Dexie implementation.
- Context7 documentation lookup was unavailable because its monthly quota was exhausted; official documentation and installed sources supplied the library evidence.
