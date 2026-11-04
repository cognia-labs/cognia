# Evidence ledger: OpenCode V2 Agent authentication

- Status: verifying
- Lane: standard
- Created: 2026-11-03
- Updated: 2026-11-03
- Related: ADR-0217, ADR-0025

## Original request

Implement the confirmed V2 Agent OAuth entry and login discovery. OpenCode owns credentials; preserve Cognia Zen/Go API keys, repair legacy discovery, and test the complete flow.

## Knowledge

| ID  | Statement                                                                                                                                                                     | State    | Basis                                                                                                 | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| G1  | OAuth belongs to the chosen V2 Agent service; Zen/Go keys remain supported                                                                                                    | Agreed   | User confirmation 2026-11-03                                                                          | -          |
| O1  | Installed SDK exposes integration.list and OAuth connect/status/complete/cancel                                                                                               | Verified | @opencode/client 2.0.23 installed declarations, 2026-11-03                                            | -          |
| O2  | Legacy discovery ignores XDG_DATA_HOME                                                                                                                                        | Verified | crates/cognia-subscription/src/opencode/discovery.rs before patch, 2026-11-03                         | -          |
| C1  | Reuse authenticated Host transport; never copy OAuth tokens into Cognia vault                                                                                                 | Verified | User scope and ADR-0217, 2026-11-03                                                                   | -          |
| O3  | Isolated OpenCode 2.0.23 completed user-approved Console OAuth, rediscovered the healthy account after service restart, and returned OK from a free model through the adapter | Verified | .cache/opencode-v2-login/live/{oauth-result,restart-result,free-model-result}.json, macOS, 2026-11-03 | C1         |

## Problem frame

Make V2 login reachable from the existing Agent card, discover service-owned accounts, and prevent stale/cancelled attempts from updating another service. Repair legacy path resolution without treating legacy OAuth snapshots as usable Cognia accounts (G1, C1). New protocol lifecycle and React binding modules isolate cancellation and external-service state from the large existing session adapter; the existing status card is extended rather than replaced.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                       |
| ------------ | ------ | ----------------------------------------------------------------- |
| scale        | medium | Package controller, hook, panel, Rust path resolution             |
| technical    | medium | Typed public SDK; late responses and cancellation                 |
| coupling     | medium | Existing Host ports and Agent lifecycle listener                  |
| requirement  | low    | Scope explicitly confirmed                                        |
| verification | high   | Real browser and provider consent differ from deterministic tests |
| risk         | high   | Authentication and cross-service identity                         |

## Risks

| ID  | Risk (impact)                                         | Severity | Source                     | Claim                                                                  | Refuted by                                                                  |
| --- | ----------------------------------------------------- | -------- | -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| R1  | Credentials leak or model PII gate bypass             | high     | ADR-0217 and auth boundary | Narrow auth client uses Host fetch; model client retains gate          | Auth client exposes model/credential operations or model data bypasses gate |
| R2  | Cancelled or old-service authorization updates new UI | high     | Async failure analysis     | Attempts bound to client, project, lifecycle; cancellation coalesces   | Late response or repeated dismissal reaches wrong controller                |
| R3  | Wrong legacy account imported                         | medium   | O2                         | Explicit paths authoritative; XDG honored; Windows fallback controlled | Custom data root silently resolves to stale default                         |
| R4  | Feature built but unreachable                         | high     | Preflight wiring auditor   | Existing desktop/mobile Agent card mounts the panel                    | Standalone tests pass but real card omits panel                             |

## Verification obligations

| ID  | Risk       | Method                                                                | Independence   | Evidence                                                                                                                                                                                                                                                                                                                                                        | Coverage                                                                                                                                            | Status  |
| --- | ---------- | --------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2     | Focused Jest and typed adapter boundary tests                         | tool           | pnpm test -- --runInBand --runTestsByPath targeted files: 10 suites, 205 tests passed; existing managed-key act warnings                                                                                                                                                                                                                                        | Auth lifecycle, code/poll race, form defaults/conditional fields, same-Agent service replacement, cancellation, parent mounting, Zen/Go chat bridge | passed  |
| V2  | R3         | cargo test -p cognia-subscription opencode:: --lib --offline --locked | tool           | 48 passed, 200 filtered, 2026-11-03                                                                                                                                                                                                                                                                                                                             | Path precedence, legacy parsing, Zen/Go adoption                                                                                                    | passed  |
| V3  | R4         | Parent card assertion and read-only preflight                         | fresh-reviewer | Wiring, PII, i18n and test-gap auditors reviewed current source; reported fixes applied and regression tests passed                                                                                                                                                                                                                                             | Parent card reachable on desktop/mobile; narrow auth boundary; package exports                                                                      | passed  |
| V4  | R1, R4     | Typecheck, lint, i18n, static-export and build                        | tool           | Package typecheck, scoped ESLint, i18n build/check/lint and static-export pass. Root typecheck fails tmp/ui-polish/picker-head.tsx:168; root lint fails 11 existing gate-script warnings; build preflight fails plugin authoring-kit ABI mismatch. Scoped app dependency check has 7 pre-existing sidecar BigInt target errors. Logs: .cache/opencode-v2-login/ | Current dirty checkout; no unrelated source changes to conceal failures                                                                             | failed  |
| V5  | R1, R2, R4 | Real service and provider OAuth smoke                                 | real-env       | OpenCode 2.0.23 real runtime smoke: 16 checks passed; user Console authorization complete; restart retained 1 healthy OAuth account; opencode/flint-40b-free returned OK through Cognia adapter                                                                                                                                                                 | Real service, public SDK, authenticated Host transport, actual external inference; paid model separately rejected insufficient funds                | passed  |
| V6  | R2, R4     | Isolated browser panel flow                                           | tool           | .cache/opencode-v2-login/ui/result.json: 5 checks passed, no page errors; screenshots visually inspected                                                                                                                                                                                                                                                        | Production panel/hook/controller with mocked manager, HTTP transport and opener; desktop/mobile layout                                              | passed  |
| V7  | R4         | Full application browser/static-export journey                        | real-env       | Playwright discovers 2 tests; both runs failed during /onboarding navigation before login. Direct Next cold compilation exhausted disk; normal dev/build blocked by ABI preflight. Generated dev output removed after stopping compiler.                                                                                                                        | Full application and Tauri remain unverified; isolated panel does not substitute                                                                    | blocked |

## Decisions

| ID  | Date       | Decision                                                                   | Action    | Based on   | Reversal trigger                               |
| --- | ---------- | -------------------------------------------------------------------------- | --------- | ---------- | ---------------------------------------------- |
| D1  | 2026-11-03 | Extend existing Agent card; service owns persistence; keep legacy key flow | implement | G1, O1, C1 | SDK contract or user scope changes             |
| D2  | 2026-11-03 | Add narrow auth client over same Host fetch; keep model client gate intact | harden    | C1         | Auth interface exposes a model-bound operation |

## Residual risks

| ID  | Residual                                                           | From   | Why still open                                                                                     | Next action                                                                                                           | Status |
| --- | ------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Repository-wide gates are not green                                | V4     | Shared checkout has unrelated syntax/lint/plugin ABI failures                                      | Repair owning changes, then rerun root typecheck/lint/build                                                           | open   |
| X2  | Full-app browser/static export and native Tauri acceptance pending | V7, M1 | Cold compile exhausted disk before application boot; macOS is outside Windows WebView2 E2E harness | Restore build prerequisites and sufficient disk, run new Playwright spec against fresh export, then native acceptance | open   |

## Outcome

| ID  | Signal                                                        | How / when measured                                                                 | Result                                                                               | Status  |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| M1  | User can authorize and use an OpenCode account from its Agent | Real OAuth/provider plus isolated UI passed; complete application journey awaits V7 | Partially observed across independent checks; full application outcome carried in X2 | pending |

## Verification artifacts and operational state

- `.cache/opencode-v2-login/native-smoke-final.log`: real runtime and local model fixture; 16 checks.
- `.cache/opencode-v2-login/live/oauth-result.json`, `restart-result.json`, `free-model-result.json`: safe summaries only. Paid model attempt returned `Insufficient account funds`; the free model returned `OK`.
- `.cache/opencode-v2-login/ui/result.json` and screenshots: isolated component browser evidence, not an application E2E pass.
- `.cache/opencode-v2-login/e2e-2.log`: application boot failures with Playwright traces under `test-results/`.
- The isolated OpenCode service was stopped after restart verification. Its test account state remains in the gitignored `.cache/opencode-v2-login/live/` directory, protected with mode 0700. No credentials were copied into the Cognia vault or committed.
- Only this task's generated `.next/dev/static` and `.next/dev/cache/webpack` output was removed after its compiler exhausted disk. Source and other sessions' changes were preserved.
