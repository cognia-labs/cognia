# Evidence ledger: shared content safety and default bot protection

- Status: verifying
- Lane: standard
- Created: 2026-11-02
- Updated: 2026-11-03

## Original request

Implement the evaluated shared content-safety capability completely, preserve the existing architecture, enable bot protection by default with a persistent opt-out, and wire appropriate enforcement boundaries.

## Knowledge

| ID  | Statement                                                                                               | State    | Basis                                                                   | Depends on |
| --- | ------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ---------- |
| O1  | PII, RAG trust, tool-output privacy and connector admission have different contracts.                   | Verified | Current owning sources, 2026-11-02                                      | -          |
| O2  | Edits bypass normal ingress; group context and transcript hydration can reintroduce historical content. | Verified | bus.ts, runtime.ts, claude-chat-send-options.ts; explorer safety_paths  | -          |
| G1  | Share assessment while retaining PII behavior and Host-owned enforcement; default-on bot opt-out.       | Agreed   | User approval in this chat                                              | O1         |
| C1  | No extra model calls, automatic bans, raw incident previews, or destructive code sanitization.          | Verified | Accepted evaluation and source contracts                                | G1         |
| G2  | Extend useful protection features and ensure every owned execution boundary is integrated.              | Agreed   | User follow-up in this chat, 2026-11-02                                 | G1         |
| O3  | Queued/recovered consumers can execute after the adapter protection setting changes.                    | Verified | Independent wiring audit of current bus queues and recovery, 2026-11-02 | O2         |
| O4  | Text attachments, object keys and MCP discovery metadata bypass the initial text-only checks.           | Verified | Independent structured payload and fake-MCP probes, 2026-11-02          | O1         |
| G3  | Replace dense option lists with checkbox multiselect menus and a compact responsive layout.             | Agreed   | User layout feedback in this chat                                       | G2         |
| O5  | Invalid Base64-shaped code identifiers consumed decoding budgets and blocked benign tools.              | Verified | Failing identifier regression and real package.json read, 2026-11-03    | O4         |

## Problem frame

Implement G1 with a runtime-neutral package and explicit source/stage findings. Preserve original data for UI and existing PII gates (C1); assess content at execution boundaries, including O2. Native third-party agents' private tool loops remain outside Cognia's control.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                             |
| ------------ | ------ | --------------------------------------------------------------------------------------- |
| scale        | high   | Shared package, IM, RAG, sidecar, settings, history                                     |
| technical    | medium | Deterministic bounded detection; no model dependency                                    |
| coupling     | high   | Default setting, packaging, cached runtime options                                      |
| requirement  | low    | User accepted the evaluated architecture                                                |
| verification | high   | Unit/integration tests plus browser UI; real providers not required for local decisions |
| risk         | high   | False positives, privacy regression, historical re-entry                                |

## Risks

| ID  | Risk (impact)                                                                                      | Severity | Source                          | Claim                                                                                       | Refuted by                                                                   |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| R1  | Injection opt-out disables privacy.                                                                | high     | ADR-0217, redact contract       | Privacy remains independent.                                                                | PII passes after opt-out                                                     |
| R2  | Legitimate quoted code is deleted or blocked.                                                      | high     | Upstream isolated reproductions | Authored examples remain intact.                                                            | Benign example regression                                                    |
| R3  | Fan-out, edits or resume bypass inspection.                                                        | high     | Explorer safety_paths, ADR-0174 | Every affected owned boundary assesses its actual content.                                  | Attack reaches a consumer through another path                               |
| R4  | Oversized/encoded payload exhausts host or reads as clean.                                         | high     | lens:STRIDE                     | Bounded inspection reports incompleteness.                                                  | Unbounded expansion or silent truncation                                     |
| R5  | Switch changes leave cached tools on old policy.                                                   | high     | Explorer safety_paths           | Runtime policy identity changes with setting.                                               | Toggle retains old tool behavior                                             |
| R6  | Non-text prompt containers and discovery metadata smuggle model-visible instructions.              | high     | O4                              | Structured payload and discovery boundaries inspect text while preserving binary transport. | Document, object key or tool metadata reaches a model unchecked              |
| R7  | Deferred work bypasses a newly enabled protection setting.                                         | high     | O3                              | Current Host policy is reassessed immediately before owned consumers execute.               | Queued/recovered attack runs after protection is enabled                     |
| R8  | Added decoding or operator diagnostics causes false positives, unbounded work or source retention. | high     | G2,C1                           | Decoding stays bounded; diagnostics remain local and do not store samples.                  | Benign code fails, work expands without bounds or test samples enter storage |

## Verification obligations

| ID  | Risk     | Method                                                                     | Independence | Evidence                                                                                                                          | Coverage                                                                                                                        | Status  |
| --- | -------- | -------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1,R2,R4 | Package adversarial and benign unit cases                                  | tool         | Final Jest: 52 core cases passed; independent source/dist matrix 57/57 passed                                                     | Direct, normalized, encoded, quoted/mixed, budget, MIME and privacy cases                                                       | passed  |
| V2  | R3       | IM and context integration tests                                           | tool         | Final root Jest: 28 suites / 2,358 tests passed                                                                                   | Admission/fan-out, queues/recovery, callback/live controls, current/history/attachments, retained originals                     | passed  |
| V3  | R1,R5    | Tool gates, policy identity and setting tests                              | tool         | Sidecar 228/230 passed; two owner-ID failures reproduced without safety edits. Root policy/persistence suites passed.             | Native/AI SDK builtins/plugins/MCP; authenticated tool-host; CLI bridge; opt-out and policy changes                             | passed  |
| V4  | R1,R3    | Preflight auditors and deterministic gates                                 | subagent     | Six applicable audit areas reviewed; scoped lint, package types/build, i18n and static export passed. Global gates blocked by X3. | Wiring, privacy, translations, exports and test seams; no full-app/native acceptance                                            | blocked |
| V5  | R5       | Browser settings inspection                                                | real-env     | Playwright Chromium: default on, checkbox selection and Save/Confirm/reload opt-out passed; no page errors                        | Actual components/app CSS in an isolated fixture; mocked persistence; audited DB writer separately covered by Jest              | passed  |
| V6  | R3,R5    | Package build and isolated staged import                                   | tool         | tsup build, fresh staged Node v2 import, direct/encoded block and benign package.json passed; freshness tests 6/6                 | Self-contained Node export; redact source edits invalidate build                                                                | passed  |
| V7  | R4,R6,R8 | New detector and structured-payload regressions                            | tool         | Core 52 passed; independent source/dist 57/57 probes; identifier regression failed before correction and passed after             | Every rule under layered encodings; keys, tagged text/bytes, media/resource siblings, opaque binaries and bounded inspection    | passed  |
| V8  | R5,R7    | Deferred execution and retained-runtime policy regressions                 | tool         | Root 2,358 passed and safety sidecar cases passed; forwarding audit closed all three test gaps                                    | Queue/recovery and observer setting changes; prompt/history/control admission; local/host/CLI forwarding; stable session policy | passed  |
| V9  | R6       | MCP discovery and owned external resource tests                            | tool         | Final MCP/plugin/relay and bridge tests passed, including real in-memory MCP resources and JSON projection checks                 | Discovery metadata, relay responses, final envelopes, wiki evidence; authorized instruction resources preserved                 | passed  |
| V10 | R8       | Local diagnostics and audit-view interaction tests plus browser inspection | real-env     | 21 UI cases passed; Chromium checked en/zh, multiselect/reset, local samples, persistence and 390px no overflow                   | Draft detection/action distinction, clear-on-collapse, no sample storage, compact menus and bounded loaded-view counts          | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                       | Action    | Based on    | Reversal trigger                                                                             |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------- | -------------------------------------------------------------------------------------------- |
| D1  | 2026-11-02 | Add content-safety package; reuse redact unchanged; Host owns settings and side effects.                                       | implement | O1,G1,C1    | A reverse dependency or changed PII contract                                                 |
| D2  | 2026-11-02 | Reassess model-visible history rather than trusting stale ingress labels.                                                      | implement | O2,G1       | Edited text bypasses provider preparation                                                    |
| D3  | 2026-11-02 | Extend the existing package, Host boundaries and settings/audit views; keep security authority with their existing owners.     | implement | G2,O3,O4,C1 | A duplicate policy owner, disabled PII or retained sample text                               |
| D4  | 2026-11-03 | Use existing checkbox menus and single-select primitives; count only successfully decoded Base64 text against the view budget. | implement | G3,O5,R8    | Dense controls return, opaque media is decoded as instructions or limits stop failing closed |

## Residual risks

| ID  | Residual                                                                     | From  | Why still open                                                                                                    | Next action                                                                               | Status |
| --- | ---------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| X1  | Heuristics cannot establish complete semantic attack resistance.             | R2,R3 | Finite deterministic rules                                                                                        | Maintain adversarial corpus and bounded findings                                          | open   |
| X2  | Native external agents own some tool loops outside Cognia MCP.               | R3    | No Host interception primitive                                                                                    | Preserve native approvals; state this boundary                                            | open   |
| X3  | Global lint/type checks and two unrelated sidecar owner-ID tests remain red. | V4    | Concurrent worktree changes outside this feature; exact failures below                                            | Re-run global checks after their owners resolve the listed failures                       | open   |
| X4  | No live IM provider, full production build or real Tauri acceptance was run. | R3    | Browser verification used an isolated component fixture; live outbound messages were not part of this local check | Exercise a configured bot and production desktop after global build blockers are resolved | open   |
| X5  | Protected native seed reconstruction may reduce resume/cache reuse.          | R5    | Local tests do not measure provider latency or cost.                                                              | Measure on a configured provider; retain explicit safety policy.                          | open   |

## Outcome

| ID  | Signal                                                                                       | How / when measured                            | Result                                                       | Status |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | ------ |
| M1  | Default bot blocks known attacks, normal coding survives, opt-out persists, privacy remains. | Focused suites and browser fixture, 2026-11-02 | Met within tested local boundaries; X1/X2/X4 limit the claim | met    |
| M2  | Compact checkbox-based settings and audit controls preserve selection and persistence.       | Jest and browser inspection, 2026-11-03        | Met in desktop and 390px isolated fixture; X4 remains.       | met    |

## Implementation and reproducibility

The independently implemented `packages/content-safety` owns assessment, bounded
normalized/decoded views, typed reason codes, inspection completeness and external
framing. `@cognia/redact` retains its existing privacy and reversible-redaction
contracts. The Host owns decisions, audit records and the persisted setting.

Old and new adapters default to protection enabled. The existing permissions
editor saves an explicit opt-out through the audited configuration writer; adapter
transfer preserves it. Current policy travels in `SendOptions.contentSafety` and
changes retained-runtime identity. Bot-owned authority-only sessions inherit the
same protection without adopting connector routing, history or model defaults.
RAG quarantine remains independent when a bot
opts out. Stored source messages are preserved; only provider-bound context is
withheld. No model calls, automatic bans or copied AstrBot implementation were
added.

Enhancement wiring also includes structured attachments/history, deferred policy
rechecks, retained controls, stable external-session policy, streaming execution,
MCP discovery/relay metadata and final serialized output. Local diagnostics do
not persist samples. Permissions and audit filters now use checkbox dropdowns;
time range uses a single-select, with responsive toolbar wrapping.

Verification used repository entry points on macOS, 2026-11-03:

- `node scripts/test/jest.mjs --runInBand` with 28 affected test files:
  **2,358 passed**. This includes the public chat-controller harness and actual
  CLI assembler/steering and paired-host admission seams.
- `node scripts/test/run-sidecar-tests.mjs` with 13 affected files:
  **228 passed, 2 failed**. Both failures expect `renderer-lease-0123456789`
  but receive a generated process-owner UUID. Removing only safety edits in an
  isolated snapshot reproduces both failures; production sources/tests were
  not changed to hide them.
- `node --test scripts/build/lib/build-linked-packages.test.mjs`: **6 passed**.
- Shared-package typecheck, tsup ESM build, fresh isolated staged Node export,
  scoped ESLint with zero warnings, `git diff --check`, i18n build/check/lint/sort,
  sidecar architecture and static-export checks passed. Static export audited
  **12,082 TypeScript files**.
- Independent final detector source/dist matrix: **57/57 passed**. It includes
  benign long identifiers, real package JSON, all five rule families under
  layered encodings, incomplete-budget refusal and independent privacy policy.
- Playwright Chromium used real components, real locale messages and app CSS
  with fixture persistence. Checkbox selection, local preview/source modes,
  clear/no sample storage, Save/Confirm/reload opt-out, audit filters/reset and
  390px mobile wrapping passed; page errors: **0**. This is not a real-account,
  provider or Tauri result. Artifacts are in `.cache/antiprompt-assessment/`:
  `browser-result.json`, `settings-compact-desktop.png`,
  `audit-compact-desktop.png`, `audit-checkbox-menu.png`,
  `settings-compact-mobile.png`.

Current global blockers (not changed or suppressed here):

- Full `pnpm lint`: zero errors, **11 unused-variable warnings** in
  `scripts/gates/check-baseline-growth.test.mjs`, `check-convergence.test.mjs`,
  `convergence/counter.mjs` and `convergence/plugin-api-matrix.mjs`; the script
  requires zero warnings.
- Root typecheck: a concurrent unfinished `tmp/ui-polish/picker-head.tsx`
  has a missing closing brace in the direct run. An isolated check excluding
  only that file reports 31 diagnostics, all outside the 95 owned paths:
  `gateway-task.test.ts`, `lib/plugin/core/manager.test.ts`,
  `lib/twin/ingest/stage.test.ts` and `tmp/ui-polish/popover-rows.tsx`. This
  isolation does not turn the global typecheck into a passing gate.
- Sidecar typecheck: existing `leases.map(destroy)` passes a numeric index into
  an optional boolean parameter in `mcp/servers/tool-host.ts`; `tools/session.ts`
  passes an unsupported `executorId` option. Neither is introduced by safety.
- CLI typecheck: **passed** with the configured TypeScript 6 compiler and an
  explicit 8 GiB heap. The first default-heap attempt exhausted 4 GiB; the
  successful rerun is in `enhancement-cli-types-final-result.log`.

The ledger remains `verifying` because global blockers and real-environment
limits are open residuals, without claiming full CI/native acceptance.
