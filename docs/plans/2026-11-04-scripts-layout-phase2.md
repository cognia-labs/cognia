# Scripts layout, phase 2: path mapping for review

Status: done 2026-11-04, one commit per group: F `f32b397b53`, B `eae131c27a`,
E `b47e17ece6`, A `176ba92e98`, C `23235c6ebd`, D `9c378f0e4d`. Two references
the search below missed were found while executing and fixed in their group:
the rollback hint in `i18n/messages/{en,zh-CN}/providers.json` (D) and the
`lib/support-agent/support-docs.generated.json` corpus entries of the edited
docs (C, D). Line numbers below are as of `12d5c20691`, before the moves.

Phase 1 (`12d5c20691`) removed dead scripts and rewrote `scripts/README.md`.
This phase folds the overlapping folders that README lists as layout debt. It
covers every reference to every moved path. References were found by an exact
path search across all tracked files, a regex-escaped search (`scripts\/…`),
a folder and glob search, and by resolving every relative import in
`scripts/`.

## Recommended scope

| Group | What moves                                                                                 | Files | Why                                                                  |
| ----- | ------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------- |
| A     | `ci/check-cognia-services`, `ci/check-browser-companion-contract` → `gates/`               | 4     | Both are gates that also run locally (`pnpm cognia-services:check`). |
| B     | `pi/`, `pricing/`, `pet/generate-compatibility-fixtures` → `sync/`                         | 5     | Regenerators of checked-in files; dissolves two single-file folders. |
| C     | `router-fusion/live-smoke`, top-level `lark-*.mts`, `provider-diagnostics-live` → `smoke/` | 6     | Live smokes kept in four places.                                     |
| D     | `benchmarks/`, `certify/`, `plugin-eval/` → `eval/benchmarks/`, `eval/certify/`, `eval/`   | 12    | Four evaluation folders become one.                                  |
| E     | `pet/fetch-live2d-corpus`, `screenshots/capture-pwa-screenshots` → `dev/`                  | 3     | Developer tools; dissolves `pet/` and `screenshots/`.                |
| F     | top-level `i18n-baseline.json`, `i18n-ignore.txt` → `gates/`                               | 2     | Every other gate keeps its baseline next to it in `gates/`.          |

Result: 8 folders disappear (`benchmarks`, `certify`, `pet`, `pi`,
`plugin-eval`, `pricing`, `router-fusion`, `screenshots`); 23 tracked folders
become 15. The top level keeps `README.md`, `postinstall.mjs` and
`tsconfig.audit.json` (its `include: ./**/*.ts` must sit at the root).

No `package.json` command is renamed. Every user-facing `pnpm …` stays the same;
only the paths behind them change.

### Deliberately left in place

- **`plugin/`** stays whole, including its `check-*` and `generate-*` files. The
  plugin repository extraction (`docs/plans/2026-10-30-plugins-repository-extraction.md`,
  edited 2026-11-04) is built on that subtree, and `plugin/extraction-inventory.mjs`
  imports `./check-author-imports.mjs`. Splitting it now works against that plan.
- **`build/gen-*.mjs` and `build/generate-lucide-catalog.mjs`** stay. Moving them
  costs far more than it returns:
  - Their outputs embed the generator path in a header (`cli/src/api/generated/command-index.ts`,
    `crates/cognia-companion-contract/src/generated/known_commands.rs`,
    `crates/cognia-companion-contract/src/settings_sync_generated.rs`,
    `sidecar/src/policy/shell/gh-command.generated.ts`,
    `cli/src/serve/headless-contract-identity.ts`), so every output has to be
    regenerated and the companion response-schema catalog touched.
  - `scripts/test/coverage-changed.mjs:233,275` select the `frontend` and
    `globalJS` CI lanes by `scripts/build/`, and the workspace-dist cache key
    in `test.yml:116` / `quality.yml:227` hashes `scripts/build/**`
    (asserted by `scripts/ci/workflow-contract.test.mjs:1095`).
  - `mobile/scripts/android-artifact.mjs:88` fingerprints `scripts/build/`.

  README will instead say that generators feeding the build live in `build/`.

- **`bootstrap/`** is phase 3: the app reads `bootstrap/presets.json` at runtime.
  Done on 2026-11-04: moved to `crates/cognia-bootstrap-agent/standalone/`.
- **`gates/convergence/*.md`** belong to the convergence refactor that has not
  merged yet.
- **Historical records** (`docs/evidence`, `docs/reports`, `docs/plans`,
  `docs/research`) are not rewritten. They describe the tree as it was. The
  last section lists them; README gains an old → new table so a reader can
  follow an old path.

## Mapping and references, by group

Kinds: `package.json`, `ci` (`.github/`), `code` (app, crates, packages, tests),
`scripts` (other scripts and gate data), `agent-config` (`.claude/`, `.codex/`),
`docs-living` (`docs/development`, READMEs), `docs-published`
(`docs/content`, both locales), `self` (usage text inside the moved file).
Line numbers are as of `12d5c20691`.

### A. CI-run gates → `gates/`

| Old                                            | New                                               |
| ---------------------------------------------- | ------------------------------------------------- |
| `ci/check-browser-companion-contract.mjs`      | `gates/check-browser-companion-contract.mjs`      |
| `ci/check-browser-companion-contract.test.mjs` | `gates/check-browser-companion-contract.test.mjs` |
| `ci/check-cognia-services.mjs`                 | `gates/check-cognia-services.mjs`                 |
| `ci/check-cognia-services.test.mjs`            | `gates/check-cognia-services.test.mjs`            |

References to rewrite:
| scripts (escaped regex, CI lane rules) | `scripts/test/coverage-changed.mjs:252` | `ci/check-browser-companion-contract.mjs` |
| scripts (escaped regex, CI lane rules) | `scripts/test/coverage-changed.mjs:270` | `ci/check-cognia-services.mjs` |

| Kind         | Location                                                 | Points at                                 |
| ------------ | -------------------------------------------------------- | ----------------------------------------- |
| package.json | `package.json:268`                                       | `ci/check-cognia-services.mjs`            |
| package.json | `package.json:269`                                       | `ci/check-cognia-services.mjs`            |
| package.json | `package.json:270`                                       | `ci/check-cognia-services.test.mjs`       |
| ci           | `.github/actions/checkout-cognia-services/action.yml:26` | `ci/check-cognia-services.mjs`            |
| ci           | `.github/workflows/test.yml:1219`                        | `ci/check-browser-companion-contract.mjs` |
| ci           | `.github/workflows/test.yml:1728`                        | `ci/check-cognia-services.mjs`            |
| ci           | `.github/workflows/test.yml:1768`                        | `ci/check-cognia-services.test.mjs`       |
| code         | `lib/diagnostic-service/types.test.ts:28`                | `ci/check-cognia-services.mjs`            |
| scripts      | `scripts/test/coverage-changed.test.mjs:233`             | `ci/check-cognia-services.mjs`            |
| scripts      | `scripts/test/coverage-changed.test.mjs:252`             | `ci/check-browser-companion-contract.mjs` |
| docs-living  | `docs/development/browser-extension-extraction.md:16`    | `ci/check-browser-companion-contract.mjs` |
| docs-living  | `docs/development/browser-extension-extraction.md:26`    | `ci/check-browser-companion-contract.mjs` |
| docs-living  | `docs/development/services-extraction.md:23`             | `ci/check-cognia-services.mjs`            |
| docs-living  | `docs/development/services-extraction.md:34`             | `ci/check-cognia-services.mjs`            |
| self         | `scripts/ci/check-cognia-services.mjs:10`                | `ci/check-cognia-services.mjs`            |
| self         | `scripts/ci/check-cognia-services.mjs:13`                | `ci/check-cognia-services.mjs`            |
| self         | `scripts/ci/check-cognia-services.mjs:16`                | `ci/check-cognia-services.mjs`            |

### B. Single-file sync folders → `sync/`

| Old                                            | New                                      |
| ---------------------------------------------- | ---------------------------------------- |
| `pi/pin-extension.mjs`                         | `sync/pin-pi-extension.mjs`              |
| `pricing/build-catalog.mjs`                    | `sync/build-price-catalog.mjs`           |
| `pricing/build-catalog.test.mjs`               | `sync/build-price-catalog.test.mjs`      |
| `pet/generate-compatibility-fixtures.mjs`      | `sync/generate-live2d-fixtures.mjs`      |
| `pet/generate-compatibility-fixtures.test.mjs` | `sync/generate-live2d-fixtures.test.mjs` |

References to rewrite:
| package.json (glob) | `package.json:241` `pet:compat:test` runs `scripts/pet/*.test.mjs` | becomes `scripts/sync/generate-live2d-fixtures.test.mjs scripts/dev/fetch-live2d-corpus.test.mjs` |
| scripts | `scripts/gates/check-gate-registry.mjs:128` exemption reason names `scripts/pet/*.test.mjs` | `pet/` |

| Kind         | Location                                   | Points at                   |
| ------------ | ------------------------------------------ | --------------------------- |
| package.json | `package.json:389`                         | `pricing/build-catalog.mjs` |
| package.json | `package.json:392`                         | `pi/pin-extension.mjs`      |
| package.json | `package.json:393`                         | `pi/pin-extension.mjs`      |
| scripts      | `scripts/gates/check-price-catalog.mjs:46` | `pricing/build-catalog.mjs` |

Relative imports inside moved files (2):

| File:line                                        | Old specifier                           | New specifier                    |
| ------------------------------------------------ | --------------------------------------- | -------------------------------- |
| `pricing/build-catalog.test.mjs:10`              | `./build-catalog.mjs`                   | `./build-price-catalog.mjs`      |
| `pet/generate-compatibility-fixtures.test.mjs:7` | `./generate-compatibility-fixtures.mjs` | `./generate-live2d-fixtures.mjs` |

### C. Live smokes → `smoke/`

| Old                                  | New                                        |
| ------------------------------------ | ------------------------------------------ |
| `router-fusion/live-smoke.mjs`       | `smoke/router-fusion-live.mjs`             |
| `router-fusion/live-smoke.test.mjs`  | `smoke/router-fusion-live.test.mjs`        |
| `lark-live-smoke.mts`                | `smoke/lark-live-smoke.mts`                |
| `lark-entry-verify.mts`              | `smoke/lark-entry-verify.mts`              |
| `provider-diagnostics-live.mjs`      | `smoke/provider-diagnostics-live.mjs`      |
| `provider-diagnostics-live.test.mjs` | `smoke/provider-diagnostics-live.test.mjs` |

References to rewrite:

| Kind               | Location                                                    | Points at                           |
| ------------------ | ----------------------------------------------------------- | ----------------------------------- |
| package.json       | `package.json:419`                                          | `lark-entry-verify.mts`             |
| package.json       | `package.json:420`                                          | `provider-diagnostics-live.mjs`     |
| package.json       | `package.json:421`                                          | `router-fusion/live-smoke.mjs`      |
| package.json       | `package.json:422`                                          | `router-fusion/live-smoke.test.mjs` |
| code               | `lib/connectors/tenant-token-purpose.test.ts:128`           | `lark-live-smoke.mts`               |
| code               | `lib/router-fusion/live/live-smoke-cli.ts:4`                | `router-fusion/live-smoke.mjs`      |
| self (moving test) | `scripts/router-fusion/live-smoke.test.mjs:18`              | `router-fusion/live-smoke.mjs`      |
| self (moving test) | `scripts/router-fusion/live-smoke.test.mjs:47`              | `router-fusion/live-smoke.mjs`      |
| docs-published     | `docs/content/docs/en/connectors/local-live-testing.mdx:10` | `lark-live-smoke.mts`               |
| docs-published     | `docs/content/docs/zh/connectors/local-live-testing.md:8`   | `lark-live-smoke.mts`               |
| self               | `scripts/lark-entry-verify.mts:20`                          | `lark-entry-verify.mts`             |
| self               | `scripts/lark-live-smoke.mts:11`                            | `lark-live-smoke.mts`               |
| self               | `scripts/router-fusion/live-smoke.test.mjs:1`               | `router-fusion/live-smoke.test.mjs` |

Relative imports inside moved files (28):

| File:line                              | Old specifier                                               | New specifier                                                  |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `router-fusion/live-smoke.test.mjs:16` | `./live-smoke.mjs`                                          | `./router-fusion-live.mjs`                                     |
| `lark-live-smoke.mts:151`              | `../lib/connectors/tauri/commands`                          | `../../lib/connectors/tauri/commands`                          |
| `lark-live-smoke.mts:178`              | `../lib/connectors/adapters/lark/index`                     | `../../lib/connectors/adapters/lark/index`                     |
| `lark-live-smoke.mts:179`              | `../lib/connectors/adapters/lark/whoami`                    | `../../lib/connectors/adapters/lark/whoami`                    |
| `lark-live-smoke.mts:180`              | `../lib/connectors/adapters/lark/http`                      | `../../lib/connectors/adapters/lark/http`                      |
| `lark-live-smoke.mts:181`              | `../lib/connectors/adapters/lark/auth`                      | `../../lib/connectors/adapters/lark/auth`                      |
| `lark-live-smoke.mts:182`              | `../lib/db/schema`                                          | `../../lib/db/schema`                                          |
| `lark-live-smoke.mts:186`              | `../packages/plugin-contract/src/types/connectors/event`    | `../../packages/plugin-contract/src/types/connectors/event`    |
| `lark-live-smoke.mts:188`              | `../packages/plugin-contract/src/types/connectors/event`    | `../../packages/plugin-contract/src/types/connectors/event`    |
| `lark-live-smoke.mts:190`              | `../packages/plugin-contract/src/types/connectors/outbound` | `../../packages/plugin-contract/src/types/connectors/outbound` |
| `lark-live-smoke.mts:563`              | `../lib/connectors/outbound-runner`                         | `../../lib/connectors/outbound-runner`                         |
| `lark-live-smoke.mts:564`              | `../lib/db/outbound-jobs`                                   | `../../lib/db/outbound-jobs`                                   |
| `lark-entry-verify.mts:86`             | `../lib/connectors/tauri/commands`                          | `../../lib/connectors/tauri/commands`                          |
| `lark-entry-verify.mts:104`            | `../lib/connectors/adapters/lark/whoami`                    | `../../lib/connectors/adapters/lark/whoami`                    |
| `lark-entry-verify.mts:105`            | `../lib/db/schema`                                          | `../../lib/db/schema`                                          |
| `lark-entry-verify.mts:107`            | `../lib/connectors/adapters/lark/chat-seed`                 | `../../lib/connectors/adapters/lark/chat-seed`                 |
| `lark-entry-verify.mts:108`            | `../lib/connectors/adapters/lark/chat-tabs`                 | `../../lib/connectors/adapters/lark/chat-tabs`                 |
| `lark-entry-verify.mts:109`            | `../lib/connectors/adapters/lark/group-menu`                | `../../lib/connectors/adapters/lark/group-menu`                |
| `lark-entry-verify.mts:110`            | `../lib/connectors/adapters/lark/surface-removal`           | `../../lib/connectors/adapters/lark/surface-removal`           |
| `lark-entry-verify.mts:111`            | `../lib/db/lark-chat-surfaces`                              | `../../lib/db/lark-chat-surfaces`                              |
| `lark-entry-verify.mts:113`            | `../lib/connectors/principal/admin`                         | `../../lib/connectors/principal/admin`                         |
| `lark-entry-verify.mts:114`            | `../lib/db/feishu-principals`                               | `../../lib/db/feishu-principals`                               |
| `lark-entry-verify.mts:115`            | `../lib/connectors/principal/resolve`                       | `../../lib/connectors/principal/resolve`                       |
| `lark-entry-verify.mts:116`            | `../lib/connectors/commands/registry`                       | `../../lib/connectors/commands/registry`                       |
| `lark-entry-verify.mts:212`            | `../lib/connectors/adapters/lark/http`                      | `../../lib/connectors/adapters/lark/http`                      |
| `lark-entry-verify.mts:213`            | `../lib/db/adapter-instances`                               | `../../lib/db/adapter-instances`                               |
| `lark-entry-verify.mts:214`            | `../lib/db/lark-chat-surfaces`                              | `../../lib/db/lark-chat-surfaces`                              |
| `provider-diagnostics-live.mjs:6`      | `../sidecar/src/host/feature-call/index.ts`                 | `../../sidecar/src/host/feature-call/index.ts`                 |

### D. Evaluation → `eval/`

| Old                                      | New                                           |
| ---------------------------------------- | --------------------------------------------- |
| `benchmarks/code-index-workers.mjs`      | `eval/benchmarks/code-index-workers.mjs`      |
| `benchmarks/code-index-workers.test.mjs` | `eval/benchmarks/code-index-workers.test.mjs` |
| `benchmarks/host-first-request.mjs`      | `eval/benchmarks/host-first-request.mjs`      |
| `benchmarks/host-first-request.test.mjs` | `eval/benchmarks/host-first-request.test.mjs` |
| `benchmarks/host-js-profile.mjs`         | `eval/benchmarks/host-js-profile.mjs`         |
| `benchmarks/host-js-profile.test.mjs`    | `eval/benchmarks/host-js-profile.test.mjs`    |
| `benchmarks/host-js-runtime.mjs`         | `eval/benchmarks/host-js-runtime.mjs`         |
| `benchmarks/host-js-runtime.test.mjs`    | `eval/benchmarks/host-js-runtime.test.mjs`    |
| `certify/rollback-bundle.mjs`            | `eval/certify/rollback-bundle.mjs`            |
| `certify/run-vendor-certification.mjs`   | `eval/certify/run-vendor-certification.mjs`   |
| `certify/vendor-suite.mjs`               | `eval/certify/vendor-suite.mjs`               |
| `plugin-eval/run-eval.ts`                | `eval/plugin-eval.ts`                         |

References to rewrite:
| scripts (escaped regex, CI `gateway` lane) | `scripts/test/coverage-changed.mjs:259` `scripts\/certify` | `certify/` → `eval\/certify` |
| code (comment) | `components/settings/provider/deployment-certification-panel.tsx:6` | `certify/` |

| Kind           | Location                                                                                  | Points at                              |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| package.json   | `package.json:155`                                                                        | `plugin-eval/run-eval.ts`              |
| code           | `tests/conformance/cases/certification.test.mjs:94`                                       | `certify/rollback-bundle.mjs`          |
| code           | `tests/conformance/cases/certification.test.mjs:135`                                      | `certify/run-vendor-certification.mjs` |
| docs-published | `docs/content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md:409`  | `certify/rollback-bundle.mjs`          |
| docs-published | `docs/content/docs/en/subsystems/unified-agent-execution/policy-and-certification.mdx:54` | `certify/run-vendor-certification.mjs` |
| docs-published | `docs/content/docs/zh/adr/0090-unified-agent-execution-and-gateway-compatibility.md:252`  | `certify/rollback-bundle.mjs`          |
| docs-published | `docs/content/docs/zh/subsystems/unified-agent-execution/policy-and-certification.mdx:30` | `certify/run-vendor-certification.mjs` |
| self           | `scripts/certify/run-vendor-certification.mjs:12`                                         | `certify/run-vendor-certification.mjs` |

Relative imports inside moved files (8):

| File:line                               | Old specifier                                               | New specifier                                                  |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `benchmarks/code-index-workers.mjs:121` | `../../sidecar/src/services/code-graph/store.ts`            | `../../../sidecar/src/services/code-graph/store.ts`            |
| `benchmarks/code-index-workers.mjs:181` | `../../sidecar/src/services/code-graph/index-service.ts`    | `../../../sidecar/src/services/code-graph/index-service.ts`    |
| `benchmarks/host-js-runtime.mjs:15`     | `../build/esbuild-shared.mjs`                               | `../../build/esbuild-shared.mjs`                               |
| `certify/rollback-bundle.mjs:46`        | `../../packages/agent-config-types/src/runtime-versions.ts` | `../../../packages/agent-config-types/src/runtime-versions.ts` |
| `certify/vendor-suite.mjs:9`            | `../../tests/conformance/suite-manifest.mjs`                | `../../../tests/conformance/suite-manifest.mjs`                |
| `certify/vendor-suite.mjs:13`           | `../../tests/conformance/harness/emit-manifest.mjs`         | `../../../tests/conformance/harness/emit-manifest.mjs`         |
| `certify/vendor-suite.mjs:14`           | `../../tests/conformance/harness/sidecar-process.mjs`       | `../../../tests/conformance/harness/sidecar-process.mjs`       |
| `certify/vendor-suite.mjs:15`           | `../../packages/agent-config-types/src/runtime-versions.ts` | `../../../packages/agent-config-types/src/runtime-versions.ts` |

Repo-root resolution that gains a level (`"../.."` → `"../../.."`):

- `benchmarks/code-index-workers.mjs:12`
- `benchmarks/host-first-request.mjs:12`
- `benchmarks/host-js-profile.mjs:11`
- `benchmarks/host-js-runtime.mjs:17`

### E. Dev tools → `dev/`

| Old                                       | New                                |
| ----------------------------------------- | ---------------------------------- |
| `pet/fetch-live2d-corpus.mjs`             | `dev/fetch-live2d-corpus.mjs`      |
| `pet/fetch-live2d-corpus.test.mjs`        | `dev/fetch-live2d-corpus.test.mjs` |
| `screenshots/capture-pwa-screenshots.mjs` | `dev/capture-pwa-screenshots.mjs`  |

References to rewrite:

| Kind           | Location                                                            | Points at                                 |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| package.json   | `package.json:180`                                                  | `screenshots/capture-pwa-screenshots.mjs` |
| package.json   | `package.json:242`                                                  | `pet/fetch-live2d-corpus.mjs`             |
| package.json   | `package.json:243`                                                  | `pet/fetch-live2d-corpus.test.mjs`        |
| code           | `app/manifest.ts:78`                                                | `screenshots/capture-pwa-screenshots.mjs` |
| docs-published | `docs/content/docs/en/adr/0027-mobile-offline-and-discovery.md:278` | `screenshots/capture-pwa-screenshots.mjs` |
| docs-published | `docs/content/docs/zh/adr/0027-mobile-offline-and-discovery.md:111` | `screenshots/capture-pwa-screenshots.mjs` |
| self           | `scripts/screenshots/capture-pwa-screenshots.mjs:28`                | `screenshots/capture-pwa-screenshots.mjs` |

### F. Root i18n gate data → `gates/`

| Old                  | New                        |
| -------------------- | -------------------------- |
| `i18n-baseline.json` | `gates/i18n-baseline.json` |
| `i18n-ignore.txt`    | `gates/i18n-ignore.txt`    |

References to rewrite:
| agent-config (escaped regex) | `.claude/hooks/protect-generated-files.mjs:13` | `i18n-baseline.json` |

| Kind           | Location                                                         | Points at            |
| -------------- | ---------------------------------------------------------------- | -------------------- |
| scripts        | `scripts/gates/baseline-growth.json:293`                         | `i18n-baseline.json` |
| scripts        | `scripts/gates/check-baseline-growth.test.mjs:664`               | `i18n-baseline.json` |
| scripts        | `scripts/gates/lint-i18n.ts:17`                                  | `i18n-baseline.json` |
| scripts        | `scripts/gates/lint-i18n.ts:83`                                  | `i18n-baseline.json` |
| scripts        | `scripts/gates/lint-i18n.ts:84`                                  | `i18n-ignore.txt`    |
| agent-config   | `.claude/agents/i18n-reviewer.md:12`                             | `i18n-baseline.json` |
| agent-config   | `.claude/hooks/protect-generated-files.mjs:14`                   | `i18n-baseline.json` |
| agent-config   | `.codex/agents/i18n-reviewer.toml:9`                             | `i18n-baseline.json` |
| docs-living    | `docs/development/CI_CD.md:269`                                  | `i18n-baseline.json` |
| docs-published | `docs/content/docs/en/adr/0020-computer-use-completeness.md:296` | `i18n-baseline.json` |
| docs-published | `docs/content/docs/zh/adr/0020-computer-use-completeness.md:189` | `i18n-baseline.json` |

## Historical records (not rewritten)

- `docs/evidence/2026-10-23-pet-live2d-support-audit.md`: `pet/fetch-live2d-corpus.test.mjs`, `pet/generate-compatibility-fixtures.test.mjs`
- `docs/evidence/2026-11-03-bun-host-runtime.md`: `benchmarks/host-first-request.mjs`, `benchmarks/host-js-runtime.mjs`, `benchmarks/host-js-runtime.test.mjs`
- `docs/plans/2026-07-09-tutti-inspiration-verified-optimizations.md`: `i18n-baseline.json`, `i18n-ignore.txt`
- `docs/plans/2026-10-24-services-repo-split.md`: `ci/check-browser-companion-contract.mjs`
- `docs/research/im-bot-automation-testing-comparison-2026-08-27.zh.md`: `lark-live-smoke.mts`
- `docs/research/lark-bot-automation-testing-2026-08-27.zh.md`: `lark-live-smoke.mts`

## Side effects to know about

### Tests that start running

Moving into a globbed folder brings in tests that no command runs today:

| Test                                              | Runner after the move                                                      | Today                                |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `sync/build-price-catalog.test.mjs`               | `scripts:test:sync` (`sync/*.test.mjs`)                                    | never runs                           |
| `gates/check-browser-companion-contract.test.mjs` | `scripts:test:gates` (`gates/*.test.mjs`)                                  | never runs                           |
| `sync/generate-live2d-fixtures.test.mjs`          | `scripts:test:sync`, `pet:compat:test`                                     | `pet:compat:test`                    |
| `dev/fetch-live2d-corpus.test.mjs`                | `scripts:test:ci` (`dev/*.test.mjs`), `pet:compat:test`, `pet:corpus:test` | `pet:compat:test`, `pet:corpus:test` |

The first two have to pass before their group is committed. The last one will
run in two gate lanes; drop it from `pet:compat:test` if that is unwanted.

### Tests that still run nowhere

`eval/benchmarks/*.test.mjs` (4) and `smoke/provider-diagnostics-live.test.mjs`
have no runner before or after. Wiring them is out of scope for a move, so they
are left as they are and recorded in README.

### CI triggers

- `.github/workflows/compose-e2e.yml:35` triggers on `scripts/smoke/**`. Editing
  the moved Lark, Router-Fusion or provider-diagnostics smokes will now start
  the Compose E2E workflow. Accept it, or add `!scripts/smoke/{lark-*,router-fusion-live*,provider-diagnostics-live*}`.
- `coverage-changed.mjs:259` puts `scripts/certify/` in the `gateway` lane; the
  rewrite keeps `eval/certify/` there. `eval/benchmarks/` and `eval/plugin-eval.ts`
  join no lane, as today.

## Execution

One commit per group, in the order F, B, E, A, C, D (least coupled first). For
each group:

1. Check `git status` for every file the group touches (`package.json`,
   workflows, the referencing files above). If another session has uncommitted
   edits in one, wait or hand-stage only my hunks.
2. Move with plain `mv`, not `git mv`, so the rename is not staged in the
   shared index before the commit.
3. Rewrite every row in that group's tables, the relative imports and the
   repo-root lines, then update `scripts/README.md` (layout, Run by hand,
   Known layout debt, old → new table).
4. Verify, then commit with explicit paths only.

Verification per group:

| Group | Commands                                                                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | `pnpm cognia-services:test`; `node --test scripts/gates/check-browser-companion-contract.test.mjs scripts/test/coverage-changed.test.mjs`; `pnpm gates:registry`                                                                                               |
| B     | `pnpm pi:extension:pin:check`; `pnpm pet:compat:test`; `node --test scripts/sync/build-price-catalog.test.mjs`; `pnpm pricing:catalog:check`                                                                                                                   |
| C     | `pnpm router-fusion:live-smoke:test`; `node --test scripts/smoke/provider-diagnostics-live.test.mjs`; `esbuild --bundle` dry run of both `.mts` (proves every import resolves without credentials); `pnpm test -- lib/connectors/tenant-token-purpose.test.ts` |
| D     | `node --test scripts/eval/benchmarks/*.test.mjs tests/conformance/cases/certification.test.mjs scripts/test/coverage-changed.test.mjs`; `esbuild --bundle` dry run of `eval/certify/*.mjs`                                                                     |
| E     | `pnpm pet:compat:test`; `pnpm pet:corpus:test`; `esbuild --bundle` dry run of `dev/capture-pwa-screenshots.mjs`                                                                                                                                                |
| F     | `pnpm lint:i18n`; `node --test scripts/gates/check-baseline-growth.test.mjs`; the hook's own test if it has one                                                                                                                                                |

Every group also runs `node scripts/gates/check-docs-links.mjs` (it has two
failures today from ADR-0242's meta.json, not from this work) and a final
repo-wide search for each old path.
