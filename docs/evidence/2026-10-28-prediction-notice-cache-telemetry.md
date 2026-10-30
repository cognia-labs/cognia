# Evidence ledger: prediction notice cache telemetry

- Status: verifying
- Lane: standard
- Created: 2026-10-28
- Updated: 2026-10-28
- Related: paired Web deployment; sibling aiden-llm-proxy; ADR-0043

## Original request

> 这个应该是一行的，然后为什么多轮对话的缓存没有命中，是什么情况

## Knowledge

| ID  | Statement                                                                                                                         | State       | Basis                                                                                                                                         | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Prediction setup text and actions occupy separate rows at current pane width.                                                     | Verified    | Screenshot and grid-cols-1 until a 42rem container threshold; regression red, 2026-10-28                                                      | -          |
| O2  | Toolbar input tokens are cumulative and include cached tokens.                                                                    | Verified    | SessionCostBadge and normalized usage contracts; independent read-only trace                                                                  | -          |
| H1  | Proxy discards positive upstream cache usage.                                                                                     | Invalidated | Raw proxy SSE preserves cached_tokens=6039 on a 6042-token synthetic prompt                                                                   | -          |
| H2  | Missing stable session affinity prevents cache reuse on this Aiden route.                                                         | Verified    | Default requests report cached_tokens=0; stable header reaches6039; after-warm default/stable comparison remains0/6039; identical prefix hash | -          |
| H3  | Manual multi-leg aggregation undercounts cache usage.                                                                             | Verified    | Independent injected two-leg probe: input300, read20 instead100; code sums only input/output                                                  | -          |
| H5  | Partial final usage can erase step cache counters or mismerge one-sided TTL writes.                                               | Verified    | Regression matrix for omitted fields, explicit zero and one-sided TTL; fixed presence-aware fallback merge, 2026-10-28                        | -          |
| H4  | Retained conversation mutates its prompt prefix every turn.                                                                       | Invalidated | System constructed once, tools sorted/cached, existing prefix stability test; no observed timestamp churn                                     | -          |
| G1  | Keep the setup notice in one accessible row and make paired multi-turn cache reuse and reported totals correct.                   | Agreed      | User correction and cache diagnosis request                                                                                                   | -          |
| C1  | Preserve account, pairing, prior repairs, authorization fences, and credentials; do not log prompts or tokens in instrumentation. | Verified    | Existing session authorization and concurrent-tree protocol                                                                                   | -          |

## Problem frame

Repair O1 and the confirmed session-affinity and cache-aggregation defects H2/H3. Validate actual cache counters rather than inferring misses from cumulative input O2. Preserve C1 and avoid changing model selection or forcing cache hits.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                          |
| ------------ | ------ | -------------------------------------------------------------------- |
| scale        | medium | UI wrapper, sidecar request/usage, sibling proxy                     |
| technical    | medium | Existing request-header seam and normalizers can be reused           |
| coupling     | medium | Static Web plus Host sidecar and proxy must be deployed coherently   |
| requirement  | low    | One-row notice and evidence-backed cache explanation                 |
| verification | high   | Real upstream raw usage and paired Web cache counters needed         |
| risk         | medium | Incorrect counters or metadata scoping could mislead across sessions |

## Risks

| ID  | Risk (impact)                                                              | Severity | Source                                                         | Claim                                                                                                    | Refuted by                                                                                    |
| --- | -------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1  | One-row layout clips actions or hides the full message.                    | medium   | User screenshot; shadcn accessibility rules                    | Fixed actions remain accessible; full text remains readable; no horizontal overflow                      | Narrow DOM rectangles show stacked/overlapping controls                                       |
| R2  | Stable affinity mixes different conversations or exposes raw session data. | medium   | Lens STRIDE; proxy explicit-header contract                    | Opaque per-conversation identifier, explicit user override preserved, separate IDs for separate sessions | Same generated identifier across different conversations or credentials/raw prompts in header |
| R3  | Cache aggregation double counts resolved and fallback step usage.          | medium   | Independent cache_trace reproduction; existing interrupt tests | Sum each billed leg/step once, preserve writes and TTL splits                                            | Aggregate mismatches known two-leg or interrupted-step counters                               |
| R4  | Synthetic cache evidence is mistaken for real paired Web success.          | medium   | Incident memory; independent trace                             | Verify raw upstream and actual paired-browser usage separately                                           | Only synthetic probe or UI token totals are presented as proof                                |

## Verification obligations

| ID  | Risk     | Method                                                 | Independence | Evidence                                                                                                                                                                                                            | Coverage                                                                                              | Status  |
| --- | -------- | ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1       | Regression plus rendered widths                        | real-env     | Deployed static artifact 20261028-prediction-cache,299 assets verified; 390/707/1440px DOM and screenshots: all40px high, matching text/button centers, no overflow, full title; previous707px height64             | Existing paired account, narrow/current/desktop panes                                                 | passed  |
| V2  | R2       | Header and proxy precedence regressions                | tool         | Installed AI SDK fetch capture and adapter tests pass; local and remote proxy pnpm check exit0                                                                                                                      | Same/different sessions; credential/request overrides; no-session UUID fallback                       | passed  |
| V3  | R3       | Usage regressions and related sidecar suites           | tool         | Local and remote four-suite run265/265; pre-fix two-leg read20 vs expected100; post-fix read100/write12/TTL5+7                                                                                                      | Multi-leg, step fallback, cancellation, missing final usage, explicit zero, one-sided TTL writes      | passed  |
| V4  | R4,R2    | Raw SSE and real paired multi-turn use                 | real-env     | Synthetic default0/stable6039; real paired session s_mvryhe42_rf5usw: input5558/read0, input5596/read5555, input5653/read5593; all success; Web cache Read17k after reload                                          | Debian10 Host, Aiden gpt-5.6-luna, existing Owner/browser account; original context recalled          | passed  |
| V5  | R1,R2,R3 | Lint/type/static checks and independent scoped reviews | tool         | UI83/83; full lint exit0; final scoped ESLint/Prettier/sidecar typecheck exit0; i18n parity clean; independent i18n/test/security reviews clean; root typecheck11 unrelated errors; static gate14 unrelated imports | Source ownership and prior repairs preserved; full repository gates remain blocked by unrelated paths | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                              | Action    | Based on | Reversal trigger                                                     |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | -------------------------------------------------------------------- |
| D1  | 2026-10-28 | Keep notice text/actions in one grid row with ellipsis and complete title text.                                                       | implement | O1,G1    | Narrow layout hides actions or text cannot be recovered              |
| D2  | 2026-10-28 | Carry an opaque stable Cognia conversation header; proxy prefers explicit Aiden identity, then Cognia identity, then random fallback. | implement | H2,C1    | Paired requests still change identity or actual cache does not reuse |
| D3  | 2026-10-28 | Reuse normalized usage fields to accumulate cache reads/writes across completed legs and current-step fallback exactly once.          | implement | H3,C1    | Resolved usage and step fallback count the same tokens twice         |

## Residual risks

| ID  | Residual                                         | From  | Why still open                                                                                                                                       | Next action                                                | Status |
| --- | ------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| X1  | Single-row rendered acceptance completed.        | V1,V4 | Deployed artifact; three widths measured; existing account restored after reload; cache totals persisted                                             | None                                                       | closed |
| X2  | Full repository type/static gates are not green. | V5    | Root typecheck has11 unrelated pre-existing errors; static-export gate finds14 Node imports in agent-codebuff/agent-crush packages; task paths clean | Repair separately; do not absorb concurrent source changes | open   |

## Outcome

| ID  | Signal                                                     | How / when measured                                     | Result                                                                                                             | Status |
| --- | ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Notice uses a single row without losing actions/full text. | Rendered DOM and screenshot, 2026-10-28                 | All390/707/1440px:40px high, text and three controls share centerline, no horizontal overflow; full title retained | met    |
| M2  | Real paired subsequent turns report cache reuse.           | Host normalized result and Web cost details, 2026-10-28 | Second5555/5596, third5593/5653 and post-reload5650/5697 input tokens cached; Web Read17k; original code recalled  | met    |
| M3  | Multi-leg cache totals match billed calls.                 | Controlled dispatcher regression                        | Read100/write12/TTL5+7 across two legs; resolved plus step data not doubled; partial final matrix passes           | met    |

## Evidence artifacts

Artifacts are in `.cache/cognia-headless-setup/prediction-cache-2026-10-28/` and the same remote verification job under `~/.local/share/cognia-server/verification/aiden-proxy-2026-10-28/prediction-cache/`. `cache-host-events.json` records only the target session, synthetic reply markers and numeric usage. `backend-activation.json` confirms five idle sessions before activation, three active services and no Host restart. Existing account, Owner pairing and TLS identity were retained.

The current OpenAI-compatible route reports input including cache reads. The toolbar accumulates that input. The existing `Cache hit` field means read/(read+write), rather than the fraction of all session input; use the raw per-turn counters above for the measured input cache share. Provider cache routing/eviction and future cache hits remain upstream-dependent.

Production static export completed with129 pages. Guarded publication retained the prior immutable artifact for rollback and old hashed assets for existing tabs; new index SHA256 `eeb1c6280f27234cf4ac4e22113313087132a304cf5fa68515c8d9482188ddfd`. The temporary16GiB build swap was removed. Host binary SHA256 `f8d7daa736587f02ad48e83a340cc4c362232282acb7c3829c6915e06d2deef3` and public TLS fingerprint stayed unchanged. Proxy post-activation probes: models200, missing/wrong key401, browser-origin403.

After deploying and fully reloading the new Web, the same existing account/session sent `CACHE_WEB_RELOAD_OK_20261028` successfully. Host result: input5697, cache read5650, output13; Web persisted6 turns and cache Read17k. `reload-host-events.json`, `final-cost.txt`, `layout-summary.json` and `single-row-final.png` retain this combined deployment evidence. The viewport override was reset. The evidence ledger remains `verifying` only because unrelated repository-wide gates in X2 are open; all task behavior outcomes M1–M3 are met.
