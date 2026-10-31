# Evidence ledger: Provider and brand identity convergence

- Status: verifying
- Lane: standard
- Created: 2026-10-30
- Updated: 2026-10-31
- Related: ADR-0068; packages/provider-types; components/icons/brand-icon.tsx

## Original request

> 统一 Provider 图标元数据和品牌资源目录，修正本地路径及 fallback，保留现有显示名称和公开接口，补齐共享行为测试并清理重复实现和死代码；外部 Agent 品牌缺失单独记录。

## Knowledge

| ID  | Statement                                                                                                                                                    | State    | Basis                                                                        | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------- | ---------- |
| O1  | App/core duplicate 28 metadata entries; all 26 claimed local provider paths are absent. Actual brand assets already live under public/icons/lobe and brands. | Verified | Source and filesystem probes, 2026-10-30.                                    | -          |
| O2  | App/core differ in 55 of 82 built-in metadata names; reserved IDs can hit object prototypes.                                                                 | Verified | Real helper probes and RED shared tests: 146 failed / 70 passed, 2026-10-30. | -          |
| G1  | One brand resource catalog and one Provider metadata implementation; preserve display labels, exports and subscription brand overrides.                      | Agreed   | User instruction, 2026-10-30.                                                | -          |
| C1  | Generic brand resources serve sign-in/search/OCR/agents as well as AI providers and must not depend on AI runtime or React.                                  | Observed | BrandIcon consumers and existing 142 aliases, 2026-10-30.                    | -          |
| C2  | Provider metadata must not import provider-core from provider-types. Local files remain in public/icons for existing platform delivery.                      | Observed | Existing package dependency direction and static export conventions.         | -          |

## Problem frame

Move the generic asset catalog/resolver into a dependency-free brand-assets package. This new package is justified by actual cross-domain consumers: BrandIcon, Provider metadata, sign-in and non-component brand lookups. Move Provider icon metadata and pure models.dev ID metadata into provider-types, keeping provider-core and app public entry points as forwards. Preserve app model naming helpers and public convenience helpers; remove duplicate tables and implementations rather than deleting exported interfaces. Keep external Agent missing brands as a separate existing issue.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| scale        | medium | One small package, two metadata moves, aliases and test/build wiring.                     |
| technical    | low    | Pure data extraction and compatibility exports.                                           |
| coupling     | medium | Browser/static exports, Provider projections and ESM/CJS package consumers.               |
| requirement  | low    | Preserve labels/public interfaces; fix local paths and fallback explicitly authorized.    |
| verification | medium | Deterministic tests plus asset checks, isolated package smoke and UI preview.             |
| risk         | medium | Brand aliases span several product surfaces; no permission or provider execution changes. |

## Risks

| ID  | Risk (impact)                                                     | Severity | Source                                    | Claim                                                                                                   | Refuted by                                                               |
| --- | ----------------------------------------------------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Broken paths, changed labels or inconsistent fallbacks remain.    | medium   | O1; O2                                    | Public metadata entries share real assets and existing app names.                                       | Shared contract tests fail or a declared local file is missing.          |
| R2  | Package move adds runtime/framework coupling or misses packaging. | medium   | ADR-0068; C1; C2                          | Brand assets are independent; metadata remains in the lower Provider package; existing entries resolve. | Dependency audit, standalone type/build or isolated runtime smoke fails. |
| R3  | React labels, monograms or subscription brand overrides regress.  | medium   | Existing BrandIcon/ProviderIcon contracts | Shared resource extraction preserves renderer behavior.                                                 | Component tests or UI preview differ for supported brands.               |

## Verification obligations

| ID  | Risk | Method                                                                                   | Independence | Evidence                                                                                                                                                                                              | Coverage                                                                                                                 | Status  |
| --- | ---- | ---------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1   | Shared behavior tests, asset existence and naming/color compatibility checks.            | tool         | RED recorded; latest 9 suites / 354 tests passed on 2026-10-31; all 85 resources match public bytes in fresh out and return HTTP 200.                                                                 | App/core APIs, built-in names, local resources, unknown/prototype IDs, projection and Kimi declarations.                 | passed  |
| V2  | R2   | Package builds/typechecks, browser closure and installed ESM/CJS smoke.                  | tool         | All 3 package builds/typechecks passed; ESM/CJS runtime smoke passed; 87 author declarations checked; 5 linked-build tests passed.                                                                    | Portable resource/metadata packages, core compatibility entries, SDK cold-source resolution and warm-build invalidation. | passed  |
| V3  | R3   | Renderer tests and real interface checks of supported/local/unknown/subscription brands. | tool         | Fresh normal production UI passed known local resources, llama.cpp and custom P fallbacks, light/dark rendering. Desktop subscription capability unavailable; registry override unit contract passed. | Browser static UI verified; real Tauri plugin activation/brand override remains unverified.                              | blocked |
| V4  | R2   | Run the full configured production pipeline and verify fresh static-export delivery.     | tool         | pnpm build exit 1 at native bridge pins; direct configured Next build exit 0, 129/129 pages, all 85 brand assets byte-identical and HTTP 200.                                                         | Full pipeline not accepted; current frontend production compilation/export independently verified.                       | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                              | Action    | Based on   | Reversal trigger                                                                                           |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-30 | Use brand-assets for cross-domain resources and provider-types for Provider metadata; move pure ID map down to avoid reverse dependencies.            | implement | G1, C1, C2 | Any consumer requires app/React/model runtime in the portable modules.                                     |
| D2  | 2026-10-30 | Add a source alias for SDK declarations and an explicit bundled-input edge to linked-package freshness after wiring audit found cold/warm build gaps. | implement | C2, G1     | SDK declarations require prebuilt brand output or a brand-only edit fails to invalidate Provider metadata. |

## Residual risks

| ID  | Residual                                                                       | From | Why still open                                                                                                                                                                                                                         | Next action                                                                                                                             | Status |
| --- | ------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Desktop subscription plugin activation and brand override remain unverified.   | V3   | Browser verification now passes, but the subscription page refuses an unsupported Host. Debug status is bridge_unavailable; normal native debug startup invokes the failing native bridge predev check.                                | Resolve the native build prerequisite, launch a valid Tauri Host, and verify the declared Kimi brand in the actual plugin path.         | open   |
| X2  | External Agent brands remain missing, as explicitly excluded from this change. | V3   | Same 16 IDs / 32 failure names before and after convergence. Assertions were retained.                                                                                                                                                 | Follow docs/reports/2026-10-30-external-agent-brand-gaps.md for resource identity/licensing and shared catalog follow-up.               | open   |
| X3  | Full configured production pipeline and repository-wide gates remain blocked.  | V4   | pnpm build stops at unrelated Hermes bridge pins; the separate Next stage exports 129 pages. Root typecheck has 14 outside-scope diagnostics, lint scans existing CLI generated cache, and static-export gate flags 14 native imports. | Resolve the separately documented native/gate owners and repeat the full production pipeline; keep successful frontend/export evidence. | open   |

## Outcome

| ID  | Signal                                                                       | How / when measured                                                                  | Result                                                                                                | Status  |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------- |
| M1  | App, core and renderer agree on supported asset paths with preserved labels. | Shared tests and fresh static UI on 2026-10-31.                                      | Web resources/fallbacks and light/dark views agree; desktop subscription acceptance carried in X1.    | pending |
| M2  | Duplicate registries/implementations are removed and public helpers remain.  | Scoped source/export review, compatibility tests and preflight auditors, 2026-10-30. | One brand table and one Provider metadata implementation; old paths forward; public helpers retained. | met     |

## Validation record

Environment: macOS arm64, Node 26.12.1, pnpm 11.18.0, 2026-10-30. No coverage command was run. Changes remain uncommitted.

- `pnpm test --runInBand` with the seven changed brand/Provider contract suites: **7 suites / 341 tests passed** (`.cache/provider-brand-focused.log`).
- Full `components/icons/brand-icon.test.tsx`: **151 passed / 32 failed**; the exact failure-name set matches the original **149 passed / 32 failed** baseline (`.cache/provider-brand-after.json`). The added reserved-key cases pass.
- Broader Provider catalog/consumer run: **89 suites passed / 1 failed; 1329 tests passed / 1 failed** (`.cache/provider-brand-consumers.log`). `catalog-baseline.test.ts` expects every default offering to resolve, but `magpie.defaultModel` is empty; confirmed also in HEAD's untouched catalog.
- `node --test scripts/build/lib/build-linked-packages.test.mjs`: **5 passed**, including brand-only invalidation and rebuild scheduling. The new regression first failed with `true !== false` (`.cache/provider-brand-linked-red.log`, `-green.log`).
- `pnpm --filter @cognia/brand-assets --filter @cognia/provider-types --filter @cognia/provider-core typecheck`: passed (`.cache/provider-brand-types.log`). Builds of all three packages passed; core's explicit compatibility reexports passed after replacing a star reexport that esbuild could not expose (`.cache/provider-brand-build.log`, `-author-types.log`, `-core-rebuild.log`).
- Direct runtime smoke loaded ESM and CJS builds of brand-assets, provider-types/provider-icons, core/providers/provider-icons and core/providers/models-dev-id-map; resource paths and reserved-ID behavior passed in all eight entries.
- SDK's TypeScript resolver points `@cognia/brand-assets` to `src/index.ts` without a dist prerequisite. `pnpm author-types:bundle` and `pnpm author-types:check` passed: **87 declarations**, including the new lower-layer subpaths (`.cache/provider-brand-author-types.log`, `-author-check.log`).
- Frozen filtered workspace install passed with no dependency version changes (`.cache/provider-brand-install.log`). Scoped ESLint and `git diff --check` passed (`.cache/provider-brand-scoped-lint.log`).
- Read-only preflight i18n, test-gap/export, static-import closure, wiring and PII audits found no remaining scoped issue. Static closure includes the brand catalog and Provider constants, without React/Next/Node/AI runtime dependencies; all 85 distinct original brand resource paths exist. The two wiring findings were fixed and reviewed.
- `pnpm lint`: **2 errors / 1 warning**, outside this task: `mobile/scripts/android.test.mjs:605`, `scripts/plugin/build-frontend-plugins.test.mjs:23`, `scripts/plugin/test-authoring-kit.mjs:10` (`.cache/provider-brand-lint.log`).
- `pnpm typecheck`: fails on **3 diagnostics** in `managed-desktop-handoff.test.tsx`, `use-sandbox-desktop.test.ts`, and `lib/remote-desktop/native-stream.ts`; sidecar typecheck is not reached (`.cache/provider-brand-root-types.log`).
- `pnpm lint:static-export`: **14 Node-only imports** in untouched `packages/agent-codebuff` and `packages/agent-crush` (`.cache/provider-brand-static-export.log`). A production app export was not run; package builds do not establish full app/platform acceptance.
- Browser preview did not yield a verified UI: IAB CDP focus/navigation timed out, and isolated Next SSR returned 500 on the transitive app dependency graph (`.cache/provider-brand-preview-small.log`). Preview processes were stopped. Only this task's preview `.next` cache was deleted after disk exhaustion; approximately 1.7 GiB was recovered. No pre-existing app cache was removed.

## Follow-up review: 2026-10-30

The user requested another review of package boundaries, fallback, public API
compatibility and the build chain, with direct fixes for confirmed problems.
Review baseline: `38ad1c605ac63c5657a02f4a759a3e7c16ed0726` plus this task's
uncommitted/new files only. Unrelated concurrent changes were preserved.

Standards/build review found **one P2, fixed**: `cli/tsconfig.json` replaces the
root `paths` map and omitted the new brand-assets source alias. The real
dependency route is `cli/src/agent/rpc/runtime-service.ts` →
`lib/ai/model-options.ts` → `lib/ai/icons.ts` → Provider metadata. A warm
brand-assets dist hid this omission; a fresh checkout produced `TS2307` for
`@cognia/brand-assets`. The CLI now resolves the package to its source.

`scripts/build/dev-cli.test.mjs` now compiles the actual Provider metadata
with CLI compiler options while hiding brand dist files through their real paths,
including workspace symlinks. It also asserts source resolution explicitly.
The test does not move or delete shared build output. The existing alias-parity
test was RED before the fix; an in-memory no-alias control independently
reproduced `TS2307` (`.cache/provider-brand-review-cold-red.log`,
`-cold-control.log`). The final fix and cold test received independent read-only
review. Other source consumers were checked for actual reachability before
deciding they did not need additional aliases.

Spec/compatibility review found **no confirmed new regression**. Compared with
the baseline, all 82 app Provider names/colors, 142 brand alias paths/mono values,
the 28 registered metadata IDs/order and existing public runtime/type exports
remain compatible. The local-path repair, CDN fallback and UI monogram policy
remain within the authorized scope. Subscription brand overrides remain intact.

Current review verification:

- **8 Jest suites / 350 tests passed**, including Provider projection
  (`.cache/provider-brand-review-tests.log`).
- **11 build-chain tests passed**, including CLI alias parity, cold metadata
  compilation and brand-only warm-build invalidation
  (`.cache/provider-brand-review-build-tests.log`).
- Full CLI typecheck and all three resource/Provider package typechecks passed
  (`.cache/provider-brand-review-cli-types.log`, `-types.log`).
- Package boundary gate passed. A separate explicit check included brand-assets
  and provider-types, and browser bundling of Provider metadata contained only
  four inputs within those two packages. All eight built ESM/CJS entry probes
  passed (`.cache/provider-brand-review-boundaries.log`, `-runtime.log`).
- Scoped ESLint and `git diff --check` passed. This review changed only the CLI
  alias, its co-located build regression test and this ledger. No commit was made.

This follow-up does not close X1/X2/X3: real-browser/platform visual acceptance,
the separately recorded external Agent brands, and the earlier repository-wide
gate failures remain carried. Full production export and browser visual testing
were not repeated for the CLI configuration-only correction.

## Production and interface verification: 2026-10-31

The user explicitly requested the complete production build and actual interface
verification, with direct fixes only for regressions introduced by this task.
The result and separately owned blockers are recorded in
`docs/reports/2026-10-31-provider-production-validation.md`.

- Normal `pnpm build` reached the native bridge integrity check and exited 1.
  No pins were changed. Source/compiled-output probes and an in-memory no-brand
  alias control isolated an unrelated Hermes probe output discrepancy.
- The configured Next production build stage, including the plugin-artifact
  wrapper, completed with exit 0 and exported 129/129 pages. Normal production
  mode was used, without the E2E bridge or type-gate overrides. The existing
  configuration skips Next's own typecheck, so the independent global typecheck
  failure is retained rather than treating a frontend export as all gates green.
- Verified the newly generated static site in the real in-app browser on an
  independent loopback origin/profile: OpenAI, Qwen, OpenCode Go and Zhipu local
  SVGs decode correctly; llama.cpp and a newly added custom Provider show L/P
  monograms without image elements; the OpenAI tile remains legible in system-dark
  and explicit Light mode. All 85 brand resources are byte-identical to public
  sources in the export and return HTTP 200.
- The subscription page shows its real unsupported-host refusal. Desktop-only
  plugin activation and namespaced brand override were not forced into the
  browser. The actual ProviderIcon registry contract and Kimi declarations pass
  in the focused **9 suites / 354 tests** run; native end-to-end acceptance stays
  open in X1.
- Global typecheck, lint and static-export gate failures are separately listed
  in the report. No new Provider product defect was confirmed. No product source
  was changed and no commit was made during this validation.

Coverage conclusion: no new permanent browser harness or product test route was
added. The resource/alias/override contracts retain their deterministic shared
tests, with real fresh-export interface and asset-delivery evidence added here.
The remaining platform-specific contract belongs to the actual Tauri Host.
