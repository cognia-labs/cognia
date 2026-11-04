# `scripts/`

Repository maintenance, build, gate, test and smoke scripts. Nothing here is
imported by the shipped app (one exception, see
[Known layout debt](#known-layout-debt)). Most scripts are reached through a
`package.json` command. To find a script's trigger:

```bash
grep -n 'scripts/<dir>/<file>' package.json .github/workflows/*.yml
```

This file indexes the folders, their entry points and the scripts that have no
command and must be run by hand. It does not list every file. Read a script's
header comment for its contract.

## Layout

```
scripts/
  build/          predev/prebuild asset staging, sidecar/CLI/plugin artifact builds, gen-* generators
    lib/          shared build helpers (staging, esbuild plugins, generated-JSON writer)
  gates/          read-only CI gates and audits (check-*), their baselines and allowlists
    lib/          shared gate helpers
    convergence/  architecture-convergence counter, inventories and reconciliation notes
    baseline-exceptions/  dated records that allow a ratchet baseline to grow
  sync/           generators and mirrors that double as drift gates (--check)
  test/           Jest / node --test entry points, sharding, coverage, fixture audits
  e2e/            static server for out/ and the E2E governance debt ledger
  smoke/          runtime smoke harnesses (Compose, WebRTC, ACP/CLI agents, TUI)
    agents/       shared external-agent smoke kit, generic ACP lane, vendor modules
    im-live/      live IM bot smoke (Lark, Discord, Matrix, ...) with drivers/
    fixtures/     inputs for smoke harnesses
  dev/            developer CLIs: tauri dev wrapper, headless host, ports, DB reset
  ci/             CI-only steps: change planning, CI report, Feishu notify, release handoff
    report/       CI report builder (JUnit, Playwright, coverage, bundle size)
    feishu/       Feishu CI notification pipeline
  release/        offline update-catalog signer
  i18n/           build the i18n aggregates from split sources, ICU validation, VS Code NLS
  plugin/         plugin SDK/contract build and checks, authoring kit, plugin artifacts
    artifacts/    plugin artifact producers
  scaffold/       plugin scaffolding and typed config codegen
  tauri/          agent-debug bridge into the real Tauri webview (see AGENT_DEBUG.md)
  bootstrap/      cross-platform project bootstrap scripts and presets (product asset)
  eval/           MultiAgentBench, HTE CEM grader, tool-search probe, plugin eval (plugin-eval.ts)
    benchmarks/   Host/sidecar JS runtime and code-index benchmarks
    certify/      billable vendor certification and bundle rollback (ADR-0090)
```

Top-level files:

| File                  | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `postinstall.mjs`     | Root `postinstall`: sidecar deps, linked package builds, VS Code ext-host sidecar. |
| `tsconfig.audit.json` | `ts-node` project for the TypeScript gates; `include` reaches every subfolder.     |

## Folders

### `build/`

Staging and build steps run by `predev` / `prebuild` (Monaco, OCR, Cubism,
built-in plugins and skills, sidecars, native hosts), plus standalone builds
(`cli:build`, sidecar bundles, Agent Host packages, managed-desktop release,
status site, support docs). `gen-*` files generate checked-in sources
(companion API, agent capabilities, settings sync, external agent runtimes,
CLI API index). Generators without a command are listed under
[Run by hand](#run-by-hand). Tests: `pnpm scripts:test:build`.

Never copy or import the staged assets by hand: the build steps own them.

### `gates/`

Read-only checks. `check-all.mjs` (`pnpm check:all`) runs every registered
gate with ordered lanes, resource locks and a summary.
`check-gate-registry.mjs` (`pnpm gates:registry`) fails when a
verification-shaped `package.json` script is neither registered in
`check-all.mjs` nor exempted with a reason, so a new gate must be wired in
before it can land.

Each gate keeps its data next to it: `*-baseline.json` ratchets may only fall
(`check-baseline-growth.mjs`, ratchets listed in `baseline-growth.json`), and
`*-allowlist.json` / `*-exceptions.json` are reviewed exception lists. Raising
a baseline needs a record under `baseline-exceptions/` (see its README).
`lint-i18n.ts` reads `i18n-baseline.json` (grandfathered hard-coded strings,
rewritten by `pnpm lint:i18n:baseline`) and `i18n-ignore.txt` (paths the scan
skips). `check-cognia-services.mjs` (`pnpm cognia-services:check`) and
`check-browser-companion-contract.mjs` verify the pinned external repositories;
CI runs them against a checkout under `.cache/`.
Tests: `pnpm scripts:test:gates`.

### `sync/`

Idempotent generators whose output is checked in: models.dev catalog, WIT
mirrors, release public key, app version (`version-sync.mjs`, run by
`release:version`), shared config constants, the frozen WASM API digest, and
i18n key sorting, the bundled Pi extension pin (`pin-pi-extension.mjs`,
ADR-0119), the model price catalog from LiteLLM's cost map
(`build-price-catalog.mjs`, `pnpm pricing:sync`) and the Live2D compatibility
fixtures (`generate-live2d-fixtures.mjs`). Most offer `--check` and run as a
drift gate. Tests: `pnpm scripts:test:sync`.

### `test/`

`jest.mjs` is the entry point for every `pnpm test*` command. The rest covers
sharding and timing, coverage merge and ratchet (opt-in, see CLAUDE.md), the
sidecar `node --test` runner, CLI bundles for Jest plans, DB fixture audits and
the real-binary Pro IDE E2E. Tests: `pnpm scripts:test:ci`.

### `e2e/`

`serve-out.mjs` serves the static export for Playwright.
`governance-exceptions.json` is the reviewed debt ledger consumed by
`gates/check-e2e-governance.mjs`. Counts are exact and entries expire for
review; it is not a general ignore file.

### `smoke/`

Harnesses that drive real runtimes: Compose tiers (`compose:smoke*`), WebRTC
pairing, Agent SDK hosts, the CLI/TUI, built-in agent streaming, desktop
automation and external agents.

External agents run through `pnpm smoke:agent` (`agent.ts`, kit in `agents/`):
`--list` shows every catalog runtime, whether it is installed and which lane
covers it; `pnpm smoke:agent <runtime…>` or `--installed` runs the generic ACP
lane (version probe, sandboxed connect, ACP v1 handshake, session or
authentication refusal, reconnect, list/load/delete) plus the runtime's
vendor module under `agents/vendors/`; `--live` adds real model turns on the
local login. It needs the sandbox launcher (`pnpm cli:external-host:build`).
New vendor checks belong in a vendor module, not a new top-level smoke.
`pnpm smoke:subagent-models [pi|opencode]` checks that real Pi and OpenCode
processes send each subagent to the model its Cognia slot names, against the
loopback fixture model in `agents/fixture-model.ts` (set `OPENCODE_V1_BIN` and
`OPENCODE_V2_BIN`); `pnpm smoke:opencode-v2` runs the OpenCode V2 service and
adapter checks against the same kind of fixture.
`tui/` is the real-PTY TUI acceptance (`pnpm smoke:tui-live [phase]`, against
one local model; `docs/evidence/2026-10-22-tui-v41-acceptance.md`) with its
evidence and project-acceptance helpers. `fixtures/` holds what other smokes
run: the stub ACP agent the Compose smokes start inside the server image,
the cloud-docs and desktop-automation fixtures.
Vendor smokes not yet moved run through `build-and-run-smoke.mjs`
(`pnpm smoke:external-parity --<lane>`). `im-live/` is the live
IM bot smoke (`pnpm im:*`). Live harnesses against real services:
`lark-entry-verify.mts` (`pnpm lark:verify-entry`, ADR-0091),
`lark-live-smoke.mts`, `provider-diagnostics-live.mjs`
(`pnpm provider-diagnostics:live`) and `router-fusion-live.mjs`
(`pnpm router-fusion:live-smoke`, ADR-0188). Editing anything here also
triggers the Compose E2E workflow (`compose-e2e.yml` watches `scripts/smoke/**`).
Several per-agent smokes were written to collect
evidence for one audit and have no command. They are listed under
[Run by hand](#run-by-hand) with the record that uses them.

### `dev/`

Developer CLIs: `tauri.mjs` (the `tauri dev` feature set), `headless.mjs` and
`web-headless.mjs` (headless Host for browser development), `free-port.mjs`,
`clean-app-databases.mjs` (`pnpm clean:db`), `ensure-cognia-cli.mjs` (predev),
`im-test-target.mjs`, `workspace-runtime.mjs`, `agent-proxy.mjs`,
`analyze-next-trace.mjs`, `fetch-live2d-corpus.mjs` (`pnpm pet:corpus:fetch`),
`capture-pwa-screenshots.mjs` (`pnpm screenshots:pwa`), `logto-seed.mjs`
(`pnpm logto:seed`, seeds the local Logto stack in `deploy/compose/LOGTO.md`) and `move-to-crate.mjs`
(shared-tree-safe Rust module moves, ADR-0196). `headless.mjs` is the reference for a new CLI (see
[Conventions](#conventions)).

### `ci/`

Steps that only make sense inside a workflow: `change-plan.mjs` (which lanes a
diff needs), `report/` (the CI report and PR comment), `feishu/` (Feishu
notifications), the Compose pair invitation, the Agent Host release handoff and macOS
signing requirements.

### `release/`

`update-catalog.mjs` signs the update catalog offline (ADR-0224 A10). The
version bump itself is `sync/version-sync.mjs` and the key mirror is
`sync/release-sync-keys.mjs`.

### `i18n/`

`build-messages.mjs` (`pnpm i18n:build`, `:check`) assembles
`i18n/messages/{en,zh-CN}.json` from the split sources. `validate-icu.mjs`
checks every message is valid ICU. `build-vscode-nls.mjs` generates the VS Code
extension NLS files. `split-messages.mjs` is the historical one-shot split; it
stays because `build-messages.test.mjs` uses it as the inverse in a round-trip
test. Tests: `pnpm scripts:test:i18n`.

### `plugin/` and `scaffold/`

`plugin/` builds and checks the plugin SDK and contract (standalone build,
author imports, author types, plugin points, selection-action parity),
produces plugin artifacts (`artifacts/`), builds frontend plugins and the
`cognia plugin import` converter bundle, and holds the authoring-kit tests.
`node-plugin-host.mjs` is the Node plugin host the Rust runtime and the server
image launch. `scaffold/` holds `pnpm plugin:create` and the typed config
codegen. Tests: `pnpm scripts:test:plugin`.

### `tauri/`

The agent-debug bridge that evaluates and captures inside the real desktop
webview. Read [AGENT_DEBUG.md](./tauri/AGENT_DEBUG.md) before using it.

### `bootstrap/`

The `cognia-bootstrap.sh` / `.ps1` project bootstrap scripts and
`presets.json`, which the app reads at runtime. Contract in
[preset-contract.md](./bootstrap/preset-contract.md), usage in
[README.md](./bootstrap/README.md), validation reports in `docs/reports/`.
CI: `.github/workflows/bootstrap-scripts.yml`.

### `eval/`

MultiAgentBench (`docs/development/multiagentbench.md`), the HTE CEM grader
(`docs/development/hte-cem-grading.md`), the tool-search cache probe, the Agent
Team live evaluation (`team-eval-live.ts`) and the
plugin eval runner (`plugin-eval.ts`, `pnpm plugin:eval`). `benchmarks/` holds
the Host runtime benchmarks and `certify/` the billable vendor certification
(ADR-0090 Phase 5). Most need provider keys or spend money; read the header
first. The `benchmarks/` tests have no command yet; run them with
`node --test scripts/eval/benchmarks/*.test.mjs`.

## Run by hand

These scripts have no `package.json` command. They are either generators whose
output is checked in, or harnesses tied to a specific record. Run them with
`node` (`.mjs`) or `tsx` (`.ts` / `.mts`) from the repo root.

| Script                                                             | What it is for                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `build/build-sign-in-icons.mjs`                                    | Regenerates the sign-in callback icons used by `app/logto/callback` and the CLI.                       |
| `build/bundle-tui-fixture.mjs`                                     | Bundles the TUI fixture used by `cli/src/tui/pty/node-pty-harness.ts`.                                 |
| `build/gen-sidecar-gh-command.mjs`                                 | Regenerates `sidecar/src/policy/shell/gh-command.generated.ts` (ADR-0239).                             |
| `sync/generate-live2d-fixtures.mjs`                                | Regenerates the Live2D compatibility fixtures.                                                         |
| `plugin/build-github-delivery.ts`                                  | Builds the plugin GitHub delivery bundle (see `packages/plugin-sdk/contract/compat`).                  |
| `plugin/test-sdk-package.mjs`                                      | Packs and installs the SDK as a third-party consumer would.                                            |
| `dev/move-to-crate.mjs`                                            | Moves Rust modules from `src-tauri` into a crate without touching the shared index.                    |
| `eval/certify/run-vendor-certification.mjs`, `rollback-bundle.mjs` | Billable vendor certification and its rollback (ADR-0090).                                             |
| `eval/toolsearch-cache-probe.mjs`                                  | Wire-level tool-search cache experiment (`docs/evidence/2026-10-24-eval-tui-gap-audit.md`).            |
| `eval/benchmarks/code-index-workers.mjs`, `host-first-request.mjs` | Host runtime measurements (`docs/evidence/2026-11-03-bun-host-runtime.md`).                            |
| `smoke/lark-live-smoke.mts`                                        | Live Lark smoke (`docs/content/docs/en/connectors/local-live-testing.mdx`).                            |
| `smoke/lume-sandbox.mjs`                                           | Lume sandbox smoke (`docs/development/lume-sandbox.md`).                                               |
| `smoke/scheduler-tauri.mjs`                                        | Scheduler smoke in the desktop shell.                                                                  |
| `eval/team-eval-live.ts`                                           | Agent Team live evaluation (`docs/reports/2026-10-25-team-squad-live-evaluation.md`).                  |
| `smoke/builtin-agent-budget-live.ts`                               | Built-in agent budgets (`docs/evidence/2026-10-21-builtin-agent-budgets.md`).                          |
| `smoke/{antigravity-acp,gemini-history}-smoke.ts`                  | Gemini / Antigravity CLI support (`docs/evidence/2026-10-24-gemini-antigravity-cli-support-audit.md`). |
| `smoke/minimax-acp-smoke.ts`                                       | MiniMax ACP smoke (`packages/agent-acp/README.md`).                                                    |

A script nothing else references (no command, workflow, import or path in
code) must also be listed under `manual` in `gates/scripts-layout.json` with
why; `pnpm audit:scripts-layout` fails otherwise. When a record above is closed
and its harness is no longer worth keeping, delete the harness. It stays
recoverable from git history.

## Conventions

- `.mjs` scripts are plain ESM run under bare Node; their co-located tests use
  `node --test` (not Jest), grouped under the `scripts:test:*` commands.
- `.ts` gate scripts run via `ts-node --project scripts/tsconfig.audit.json`;
  their tests are Jest (`*.test.ts`). `.mts` scripts run via `tsx`.
- Treat [`dev/headless.mjs`](./dev/headless.mjs) as the baseline for a
  user-facing development or operations CLI: use `commander` for help and
  option parsing, then validate the parsed shape with `zod`. Do not hand-roll
  flag scanning when either installed library expresses the contract.
- Use `execa` with an executable plus an argument array for one-shot child
  processes. Never interpolate user-controlled values into a shell command.
  Keep `node:child_process` only where its streaming, IPC, or long-lived child
  lifecycle is the behavior being implemented, and cover that boundary with a
  co-located test.
- Use `glob` for recursive file discovery instead of custom directory walkers.
  Use `write-file-atomic` for generated files and downloaded assets instead of
  hand-rolled temporary-file renames.
- Preserve each script's operational contract while modernizing it. For
  example, best-effort dev guards may log and continue on preflight failure;
  validation must make that outcome explicit rather than turning it into a
  silent fallback.
- A script that mutates files should be **idempotent** and offer a `--check`
  mode so it can double as a CI drift gate.
- Scripts derive the repo root from their own location. A script one folder
  deep uses `../..`; adjust when nesting deeper.
- Put a new script in the folder for what it does (build, gate, sync, test,
  smoke, dev, ci), not in a new folder named after its subsystem, and never at
  the top level. `pnpm audit:scripts-layout` enforces the folder list and
  top-level files in `gates/scripts-layout.json`. Give it a `package.json` command, or list it under
  [Run by hand](#run-by-hand) with the record that uses it.
- One-shot migrations are deleted once they have run. Dated reports and
  working notes belong in `docs/evidence/` or `docs/reports/`, not here.

## Moved paths

Folders were consolidated on 2026-11-04 (plan:
`docs/plans/2026-11-04-scripts-layout-phase2.md`). Older records still name the
old paths; this table maps them.

| Old path                                  | New path                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `i18n-baseline.json`                      | `gates/i18n-baseline.json`                                                         |
| `i18n-ignore.txt`                         | `gates/i18n-ignore.txt`                                                            |
| `pi/pin-extension.mjs`                    | `sync/pin-pi-extension.mjs`                                                        |
| `pricing/build-catalog.mjs`               | `sync/build-price-catalog.mjs`                                                     |
| `pet/generate-compatibility-fixtures.mjs` | `sync/generate-live2d-fixtures.mjs`                                                |
| `pet/fetch-live2d-corpus.mjs`             | `dev/fetch-live2d-corpus.mjs`                                                      |
| `screenshots/capture-pwa-screenshots.mjs` | `dev/capture-pwa-screenshots.mjs`                                                  |
| `ci/check-cognia-services.mjs`            | `gates/check-cognia-services.mjs`                                                  |
| `ci/check-browser-companion-contract.mjs` | `gates/check-browser-companion-contract.mjs`                                       |
| `router-fusion/live-smoke.mjs`            | `smoke/router-fusion-live.mjs`                                                     |
| `lark-live-smoke.mts`                     | `smoke/lark-live-smoke.mts`                                                        |
| `lark-entry-verify.mts`                   | `smoke/lark-entry-verify.mts`                                                      |
| `provider-diagnostics-live.mjs`           | `smoke/provider-diagnostics-live.mjs`                                              |
| `benchmarks/*`                            | `eval/benchmarks/*`                                                                |
| `certify/*`                               | `eval/certify/*`                                                                   |
| `plugin-eval/run-eval.ts`                 | `eval/plugin-eval.ts`                                                              |
| `smoke/kimi-acp-smoke.ts`                 | `pnpm smoke:agent kimi` (`smoke/agents/vendors/kimi.ts`)                           |
| `smoke/qoder-acp-smoke.ts`                | `pnpm smoke:agent qoder` (`smoke/agents/vendors/qoder.ts`)                         |
| `smoke/pi-subagent-models.ts`             | `pnpm smoke:subagent-models pi` (`smoke/agents/subagent-models/pi.ts`)             |
| `smoke/opencode-subagent-models.ts`       | `pnpm smoke:subagent-models opencode` (`smoke/agents/subagent-models/opencode.ts`) |
| `smoke/acp-live.mjs`                      | `pnpm smoke:agent <runtime> --live`                                                |
| `smoke/team-eval-live.ts`                 | `eval/team-eval-live.ts`                                                           |
| `smoke/logto-seed.mjs`                    | `dev/logto-seed.mjs`                                                               |
| `smoke/stub-acp-agent.mjs`                | `smoke/fixtures/stub-acp-agent.mjs`                                                |
| `smoke/tui-v41-live.mjs`                  | `smoke/tui/live.mjs` (`pnpm smoke:tui-live`)                                       |
| `smoke/tui-live-evidence.mjs`             | `smoke/tui/live-evidence.mjs`                                                      |
| `smoke/tui-project-acceptance.mjs`        | `smoke/tui/project-acceptance.mjs`                                                 |

## Known layout debt

The layout above grew one subsystem at a time and still has overlaps that a
later pass will fold together. Until then, follow the conventions above for
new scripts and do not copy these patterns:

- Gates outside `gates/`: `plugin/check-*.mjs`, kept with the rest of the
  plugin tooling while the plugin repository extraction is in progress.
- Generators outside `sync/`: `build/gen-*.mjs` stay in `build/` because
  their outputs embed the generator path and the CI lane rules, cache keys and
  Android fingerprint select on `scripts/build/`; `plugin/generate-*.mjs` stay
  with the plugin tooling.
- `bootstrap/` is a product asset: `lib/project-environment/bootstrap-presets.ts`
  imports `bootstrap/presets.json`, the only app import from `scripts/`.
- `gates/convergence/*.md` are working notes of the in-flight convergence
  refactor; they move to `docs/evidence/` when that work merges.
