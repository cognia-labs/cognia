# Evidence ledger: Codex 0.167 integration gaps

- Status: verifying
- Lane: standard
- Created: 2026-11-07
- Updated: 2026-11-07
- Related: ADR-0217; https://github.com/openai/codex/releases/tag/rust-v0.167.0

## Original request

> 把这三处接入缺口修复一下，补齐人工审批、跨 Provider 历史列表和网络策略展示，注意还是要符合架构，并完成相关回归验证。

## Knowledge

| ID  | Statement                                                                                                                          | State    | Basis                                                                        | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- | ---------- |
| O1  | The baseline omits the requiredHumanApproval handshake capability and auto-approves humanCommand as an ordinary command.           | Verified | Adapter inspection and failing behavioral regressions, 2026-11-07.           | -          |
| O2  | Baseline history requests omit modelProviders; network requirements are discarded.                                                 | Verified | Failing pagination and mapper/UI regressions, 2026-11-07.                    | -          |
| O3  | CLI yes, read-only and remembered-tool shortcuts can approve external requests after adapter dispatch.                             | Verified | Independent human_approval_boundary_review source investigation, 2026-11-07. | -          |
| G1  | Preserve fresh one-time human decisions, show all-provider history and managed network requirements.                               | Agreed   | User request, 2026-11-07.                                                    | O1, O2, O3 |
| C1  | Keep Codex wire logic in agent-codex, generic authority constraints in contracts/host policy, presentation in existing components. | Observed | ADR-0217 and repository instructions, 2026-11-07.                            | -          |

## Problem frame

Repair the three demonstrated gaps (G1) in their existing owning modules (C1). No runtime migration, Session Broker, credential change or installation upgrade is required. Network enforcement stays with Codex; the UI reports the effective read-only policy.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Three related features, including multiple approval consumers.                                                                            |
| technical    | medium | Schema verified from isolated official 0.167.0 binary.                                                                                    |
| coupling     | high   | Automatic grants exist in both adapter and host/CLI.                                                                                      |
| requirement  | low    | Three explicit acceptance criteria.                                                                                                       |
| verification | medium | Unit/component regressions, loopback protocol and browser fixtures available; deployed enterprise/native UI requires separate acceptance. |
| risk         | high   | Incorrect human capability advertisement could authorize a command without a person.                                                      |

## Risks

| ID  | Risk (impact)                                                                     | Severity | Source                                                     | Claim                                                                             | Refuted by                                                                                                                  |
| --- | --------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1  | A managed checkpoint is auto-approved or remembered.                              | high     | ADR-0217; independent boundary reviewer; upstream PR 58045 | Required-human requests skip automatic grants and only return one-time decisions. | A yes/bypass/list/remembered decision grants without prompting, or acceptForSession is emitted.                             |
| R2  | Other-provider or archived history disappears on a later page.                    | medium   | Upstream ThreadListParams; failing regression              | Every history page explicitly requests all providers.                             | Any list page omits modelProviders or drops fixture rows.                                                                   |
| R3  | Network-only, false or empty constraints appear unrestricted or wholly forbidden. | medium   | Schema; Cognia risk catalog input-boundary and i18n rules  | Typed read-only mapping and bilingual display preserve policy meaning.            | False/empty constraints disappear, legacy views override canonical maps, or network-only policy says no limits/forbids all. |
| R4  | Added constraint never reaches the real approval UI.                              | high     | Independent boundary reviewer; ADR-0217                    | Existing chat, session, manager and CLI projections retain the constraint.        | A UI exposes persistent approval or a host shortcut bypasses it.                                                            |

## Verification obligations

| ID  | Risk           | Method                                                                     | Independence | Evidence                                                                                                                                                                                                                                                                     | Coverage                                                                                                                                                                          | Status  |
| --- | -------------- | -------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R4         | Behavioral unit/component regressions and independent boundary review.     | tool         | Final combined run: 19 suites passed, 782 tests passed, 1 skipped; .cache/codex-0167-audit/final-jest-summary.txt and final-jest-args.json. Review found a TUI auto-approval bypass; fixed in turn-engine and independently rechecked.                                       | Capability, bypass/list/yes, remembered grants, TUI overlay, one-time UI/replies, plan/dontAsk denial, resolved checkpoint and late reply.                                        | passed  |
| V2  | R2             | Multi-page regression and real Codex loopback through the patched adapter. | real-env     | Official codex-cli 0.167.0 created completed conversations on fixture_a and fixture_b, archived fixture_b, listed both, and resumed fixture_a with two messages; .cache/codex-0167-audit/loopback-result.json.                                                               | Active/archived providers; real executable and adapter; loopback Responses only, no supplier inference, user credentials or user history.                                         | passed  |
| V3  | R3             | Mapper/component regressions and browser inspection.                       | real-env     | English/Chinese headless Chrome checks passed, no page errors or horizontal overflow; .cache/codex-0167-audit/ui-result.json and four screenshots.                                                                                                                           | Production components/CSS with fixture status hook/platform detection; canonical/legacy conflict and empty-map precedence, false/empty policy values, one-time approval controls. | passed  |
| V4  | R1, R2, R3, R4 | Scoped typecheck/lint, i18n, static-export, formatting and diff review.    | tool         | agent-codex typecheck exit 0; all 30 scoped TS/TSX files lint exit 0; i18n build/check/sort/lint passed; static export audited 12255 TS files successfully; git diff --check clean. Logs under .cache/codex-0167-audit/. Independent i18n and co-located-test audits passed. | Changed modules and integration boundaries; no coverage command requested or run.                                                                                                 | passed  |
| V5  | R4             | Repository-wide lint.                                                      | tool         | pnpm lint failed on 13 warnings outside this change, 0 errors; .cache/codex-0167-audit/lint.log.                                                                                                                                                                             | Global lint gate remains unpassed; no unrelated source edited to silence it.                                                                                                      | blocked |
| V6  | R4             | Repository-wide typecheck.                                                 | tool         | User explicitly requested skipping the full typecheck. An earlier attempt stopped at unrelated tmp/ui-polish/picker-head.tsx:168 TS1005; no subsequent full typecheck run.                                                                                                   | Only agent-codex package typing was verified after the instruction.                                                                                                               | waived  |

## Decisions

| ID  | Date       | Decision                                                                                                 | Action    | Based on   | Reversal trigger                                               |
| --- | ---------- | -------------------------------------------------------------------------------------------------------- | --------- | ---------- | -------------------------------------------------------------- |
| D1  | 2026-11-07 | Add a generic optional human-required constraint and preserve it through existing policy/UI seams.       | implement | O1, O3, C1 | Another automatic grant path or an upstream protocol mismatch. |
| D2  | 2026-11-07 | Request all providers per history page and display native network requirements without rewriting policy. | implement | O2, C1     | Schema or runtime evidence contradicts field meanings.         |

## Residual risks

| ID  | Residual                                                                                                                    | From   | Why still open                                                                | Next action                                                                        | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| X1  | Enterprise prompt-user deployment and full Tauri/device matrix are not exercised by loopback or browser/component fixtures. | R1, R4 | No deployed enterprise policy or paired native test environment in this task. | Run native acceptance with a managed checkpoint on the intended deployment.        | open   |
| X2  | Repository-wide lint is not green.                                                                                          | V5     | 13 warnings outside the owned scope.                                          | Owning workstreams repair their warnings, then rerun pnpm lint.                    | open   |
| X3  | Whole-application typing remains unverified.                                                                                | V6     | Full typecheck explicitly skipped by the user.                                | Run the full typecheck only when requested; scoped package check is already green. | open   |

## Outcome

| ID  | Signal                                                                                            | How / when measured                                                                   | Result                                                                                                                                                                                                         | Status |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Three original regressions no longer reproduce in scoped tests and isolated integration fixtures. | 2026-11-07 unit/components, official Codex 0.167.0 loopback and browser verification. | Human checkpoints remain one-time, both provider histories are visible including archive, and bilingual network policy renders correctly. Native enterprise deployment acceptance is separately carried in X1. | met    |

## Reproduction and scope

The owned file list is .cache/codex-0167-audit/scope.json. The final Jest invocation is saved in final-jest-args.json: it preserves every repository module-discovery exclusion and additionally excludes the unrelated temporary checkout under tmp/. Earlier runs collided with that temporary checkout; no tests were removed or weakened, and no temporary checkout was deleted. An unrelated installed-plugin package collision under cli/.cache emitted warnings but did not fail the final 19 suites.

The verification browser harness uses real components and app CSS with a fixture status hook and platform detection. Screenshots: .cache/codex-0167-audit/network-en.png, network-zh-mobile.png, approval-en.png and approval-zh-mobile.png. It is not a full Tauri or deployed-provider acceptance claim.
