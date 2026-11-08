# Evidence ledger: Developing multiple repositories with Cognia

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-08
- Related: ADR-0065, ADR-0144, ADR-0147, ADR-0151

## Original request

> 辩证参考下面的资料，看看现在到底能不能支持多仓开发（指的是使用cognia去开发）

The supplied proposal recommends a unified sibling-repository workspace,
mise, Process Compose, and optionally West. This task assesses current
product capability and that recommendation; it does not adopt the tools,
change application behavior, or publish changes.

## Knowledge

| ID  | Statement                                                                                                                                                                        | State       | Basis                                                                                                                                                                                                             | Depends on                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| G1  | Assess whether Cognia can develop independent sibling repositories, distinguishing present support from required additions.                                                      | Agreed      | User request, 2026-11-08.                                                                                                                                                                                         | -                                        |
| C1  | Preserve concurrent changes and repository independence.                                                                                                                         | Observed    | User instructions and dirty working tree, 2026-11-08.                                                                                                                                                             | -                                        |
| O1  | Project has multiple roots, one primary cwd, and derived additional directories.                                                                                                 | Verified    | `lib/workspace/roots.ts`; roots and workspace-manager add/save assertions ran on macOS, 2026-11-08.                                                                                                               | -                                        |
| O2  | Main chat managed execution acquires every Project root and redirects cwd, additionalDirectories, and trust proof to bundle aliases.                                             | Verified    | `lib/task-workspace/session-bundle.ts:110-225`, `hooks/chat/use-claude-chat-controller.ts:613-625,4571-4588`; session-bundle and root-alias tests passed, 2026-11-08. Source/unit scope only.                     | O1                                       |
| O3  | Managed bundles do not preserve sibling repository names; each physical repository is materialized below a workspace storage key.                                                | Verified    | Source-level path construction in `crates/cognia-task-workspace/src/service.rs:2935-2944,3101-3116`; no real Rust/runtime execution in this audit, 2026-11-08.                                                    | O2                                       |
| O4  | External Agent adapters differ: Codex native writableRoots are separate from additionalDirectories; ACP requires native capability or Cognia tools; Aider and A2A reject extras. | Verified    | Adapter source and 24 selected assertions in four suites; A2A refusal source-only because name filtering selected no A2A tests, 2026-11-08. See Findings for MCP nuance.                                          | O1                                       |
| O5  | merge-all loses cross-repository prerequisites and can integrate an app while its SDK task requests changes.                                                                     | Verified    | Read-only actual-source coordinator probe: `.cache/multi-repo-audit/cross-repository-integration-probe.cjs`; output `counterexampleReproduced: true`; external I/O ports replaced, no real Git merge, 2026-11-08. | -                                        |
| O6  | Repository configuration supports setup/actions/variables/roots behind trust and content approval, but declared paths must stay inside its root.                                 | Verified    | `workspace-config.ts:81-90,193-205`, `workspace-config-trust.ts`; config, trust and executor suites passed, 2026-11-08.                                                                                           | -                                        |
| O7  | SCM can switch mounted source roots; plugin development already has local watching and reload.                                                                                   | Observed    | `root-switcher.tsx:57-62,134-137`, mounted by `source-control-panel.tsx:383`; `lib/plugin/devtools/file-watch.ts`, called by `plugin-watch-card.tsx:88,113`; watcher not exercised here, 2026-11-08.              | O1                                       |
| O8  | Cognia already pins its services dependency across manifests and lockfiles.                                                                                                      | Verified    | `pnpm cognia-services:check` returned `cognia-services pin is consistent`; `integrations/cognia-services.json`, 2026-11-08. No live contract checkout/CI validation.                                              | -                                        |
| O9  | Existing authenticated Tauri bridge is unreachable.                                                                                                                              | Observed    | `pnpm tauri:debug:agent:status` returned `bridge_unavailable`, endpoint exists but unreachable; 2026-11-08.                                                                                                       | -                                        |
| O10 | The focused workspace-manager suite has two deletion assertion failures in this checkout.                                                                                        | Observed    | First Jest run: 253 passed, 2 failed; failures at `workspace-manage-dialog.test.tsx:502,522`; `.cache/multi-repo-audit/focused-jest.log`, 2026-11-08.                                                             | -                                        |
| O11 | A separate cross-repository delivery graph exists, but GitHub wiring is opt-in and selects repositories with at least two layers.                                                | Verified    | `delivery-graph.ts:117-152`; `github-delivery-adapter.ts:618-648,754-760`; graph tests passed, 2026-11-08. Single-layer prerequisites can be filtered out.                                                        | -                                        |
| O12 | Remote code supply and several generic/Team execution paths still center on a single repository/root.                                                                            | Verified    | `project_source.rs:123-159`, `host-project-source.ts:129-146`, `agent-execution-service.ts:314-325`, `local-tauri-environment.ts:182-193`; source scope, 2026-11-08.                                              | -                                        |
| H1  | Installing orchestration tools is the principal missing step for complete multi-repository coding in Cognia.                                                                     | Invalidated | O1-O5 and O12 show existing coding support and product-level gaps outside those tools. This tests an interpretation of the proposal, not a claim that the proposal ignores its own listed mechanisms.             | -                                        |
| H2  | Cognia supports multi-directory coding, with separate boundaries for isolation, integration, and orchestration.                                                                  | Verified    | O1-O8 and O11-O12 discriminate basic local coding from complete workflow parity; source/unit/probe scope, 2026-11-08.                                                                                             | O1, O2, O3, O4, O5, O6, O7, O8, O11, O12 |
| Q1  | Which Agent paths, execution modes, and Git surfaces consume multiple roots?                                                                                                     | Answered    | Findings and capability matrix below, 2026-11-08. Real-environment acceptance remains V4/X2.                                                                                                                      | O1, O2, O4, O7, O12                      |

## Problem frame

Determine the usable boundary of multi-repository coding inside Cognia (G1):
workspace configuration, Agent access, Git, isolated execution, and integration.
A directory declaration alone is insufficient end-to-end evidence. Compare the
proposal with existing mechanisms before recommending tools. Keep C1; product
implementation and environment migration are outside this audit.

A new ledger is needed because the existing cross-device workspace ledger
addresses device placement rather than sibling-repository development.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                              |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Trace UI and persistence through native/external Agents, Git, task workspaces, and environment setup.                                    |
| technical    | low    | Reuse source, tests, and upstream documentation; no new runtime mechanism.                                                               |
| coupling     | high   | Root identity crosses UI, execution, authorization, isolation, and delivery.                                                             |
| requirement  | low    | User explicitly means developing with Cognia, not only developing Cognia.                                                                |
| verification | high   | Source and tests establish wiring; real multi-repository Agent acceptance needs a runtime.                                               |
| risk         | medium | Overstated support can direct Agents into shared checkouts or recommend redundant infrastructure. This audit changes documentation only. |

## Risks

| ID  | Risk (impact)                                                              | Severity | Source                                   | Claim                                                                      | Refuted by                                                           |
| --- | -------------------------------------------------------------------------- | -------- | ---------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R1  | Multi-root declarations are mistaken for runnable support.                 | medium   | ADR-0147 built-but-dormant incident      | Claims follow reachable callers and focused tests.                         | Roots disappear before execution or lack a consumer.                 |
| R2  | A worktree is mistaken for a complete cross-repository isolation boundary. | high     | ADR-0144; lens: unsafe control actions   | Report root remapping and checkout exposure per execution path.            | A secondary repository remains shared or disappears after isolation. |
| R3  | Orchestration tools duplicate setup without closing product gaps.          | medium   | ADR-0147; upstream tool responsibilities | Separate process/toolchain/Git manifests from Cognia repository semantics. | Installing tools alone supplies missing Agent or Git behavior.       |
| R4  | Mocked tests are mistaken for desktop/provider/platform acceptance.        | medium   | Skill verification-and-outcome reference | State evidence scope and carry unrun acceptance.                           | Report asserts real-environment success without a run.               |

## Verification obligations

| ID  | Risk | Method                                                                                         | Independence   | Evidence                                                                                                                          | Coverage                                                                                                                            | Status  |
| --- | ---- | ---------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1   | Trace UI, root consumers, Agent options, and file authorization; run focused tests.            | tool           | Two Jest commands below: 277 passed, 2 failed; services pin gate passed. Logs in `.cache/multi-repo-audit/`.                      | Root/add-save/acquire/alias/trust/confinement/adapter assertions ran. Workspace deletion assertions failed. No provider acceptance. | failed  |
| V2  | R2   | Inspect root remapping, slots, SCM, delivery; seek fresh counterexamples.                      | fresh-reviewer | Read-only Agent execution audit and independent failure hunt; root reran the actual-source integration probe and reproduced O5.   | Review obligation completed; discovered feature gaps remain X3. No real Git/provider execution.                                     | passed  |
| V3  | R3   | Verify mise bootstrap, Process Compose lifecycle, and West snapshots in primary documentation. | tool           | Official mise repos/bootstrap, Process Compose launcher/health, and West manifests documentation read on 2026-11-08; links below. | Documentation only; no installation or claim of Cognia integration.                                                                 | passed  |
| V4  | R4   | Check real-shell route and record whether a two-repository Agent journey runs.                 | real-env       | `pnpm tauri:debug:agent:status`: `ok: false`, `status: bridge_unavailable`. No fresh native build or real-provider turn was run.  | Desktop/browser-with-host/mobile and remote multi-repo acceptance remain unverified.                                                | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                                     | Action     | Based on                        | Reversal trigger                                                                                                                       |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 2026-11-08 | Audit before adoption; compare H1 and H2.                                                                                                                    | diagnose   | G1, C1, O1                      | Implementation requested or source changes the boundary.                                                                               |
| D2  | 2026-11-08 | Recommend explicit multi-root local coding now, with per-repository review and validation. Do not describe managed/remote/Squad paths as feature-equivalent. | scope-down | G1, O1, O2, O3, O4, O5, O7, O12 | A real two-repository acceptance run and fixes close the recorded gaps.                                                                |
| D3  | 2026-11-08 | Keep mise and Process Compose optional adapters to existing environment actions; defer West until exact version-combination recovery is required.            | diagnose   | G1, O5, O6, O8, O11, O12        | Repeated onboarding/service-lifecycle failures establish a stronger need, or a minimal integration experiment proves sufficient value. |

## Residual risks

| ID  | Residual                                                                                                                    | From                 | Why still open                                                                                                                                         | Next action                                                                             | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| X1  | Two workspace-deletion assertions fail; this audit does not establish a fully passing UI suite.                             | V1, O10              | Assessment-only task; no application/test sources changed by this task. Cause not diagnosed and clean-HEAD behavior not compared.                      | Diagnose deletion flow separately; preserve the failed evidence.                        | open   |
| X2  | No real two-repository Agent/desktop/remote acceptance.                                                                     | V4, O9               | Existing debug bridge unreachable; cold native build and real-provider run were not undertaken for this source audit.                                  | Launch an authenticated current build and execute the acceptance scenario below.        | open   |
| X3  | Dependency loss, sibling-layout breakage, single-root paths, and shared provisioning prevent a complete workflow guarantee. | O3, O5, O11, O12, R2 | These are assessed gaps, not fixes delivered by this task. Only O5 has a behavioral counterexample; others are source-derived unless stated otherwise. | Fix and regress each owning path before claiming complete multi-repository development. | open   |

## Outcome

| ID  | Signal                                                                  | How / when measured                                                                           | Result                                                                                                            | Status |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Source-backed capability matrix and practical recommendation answer G1. | Source, focused tests, independent audit, isolated counterexample, upstream docs, 2026-11-08. | Assessment delivered: basic local multi-root coding exists; complete multi-repository workflow has material gaps. | met    |

## Capability assessment

Scope: checked-out source at HEAD `560b948d4a0dac9b30b3b66229ff2d619d7a263e`
with concurrent uncommitted changes, macOS arm64, Node `v26.12.1`, pnpm
`11.18.0`, 2026-11-08. This is not acceptance evidence for a released binary.
CodeGraph has no index in this checkout, so exploration used `rg` and source
reads. No index was created.

| User journey                                                          | Assessment                                                       | Boundary                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount sibling repositories in one Cognia workspace                    | Implemented and covered by focused assertions                    | Add each repository as a root and choose a primary cwd. VS Code `.code-workspace` alone is not a Cognia root registration mechanism found in this audit.                                      |
| Read/edit multiple roots in main native Claude or built-in Agent chat | Reachable source path; selected tests passed                     | `build-options.ts:2598-2617`; Claude SDK options and built-in permission gate consume the roots. Requires the appropriate Host and permissions.                                               |
| Acquire isolated worktrees across all roots in main chat              | Implemented at source/unit level                                 | `session-bundle.ts:110-225`; all-root alias forwarding exists. Named sibling layout and independent setup rules are not preserved automatically.                                              |
| Use any external Agent interchangeably                                | Partial                                                          | Codex native writable roots, ACP capability negotiation, and Cognia MCP bridge differ. Aider/A2A refuse extra roots. Local bridge behavior cannot be generalized to remote/sandbox execution. |
| Inspect Git across roots                                              | Implemented selector; managed alias gap                          | SCM switches roots individually. Default local selector reads raw Project paths, not the selected bundle's additional aliases.                                                                |
| Run long-lived cooperating services                                   | Commands are available; no native Process Compose adapter found  | Existing setup/actions are one-shot scripts. Native shell runner reaps process groups after exit; backgrounding a daemon in setup is not reliable lifecycle ownership.                        |
| Develop plugins from local source                                     | Existing partial workflow                                        | Local/unpacked/dev-folder watching and verified reload already exist. WASM/VS Code extension source still needs the CLI build/install/reload path.                                            |
| Coordinate cross-repository Squad delivery                            | Partial, with reproduced prerequisite failure                    | merge-all is not dependency-safe across roots; optional stacked GitHub delivery does not cover ordinary one-layer-per-repo changes.                                                           |
| Recreate a complete workspace on another Host/sandbox                 | Not established; singular supply paths found                     | Project repository identity and remote materialization do not describe every root independently.                                                                                              |
| Obtain reproducible versions and compatibility checks                 | Specific integration exists; universal mechanism not established | Services SHA consistency gate exists. It is not a whole-workspace snapshot or all-consumer compatibility check.                                                                               |

## Findings that change the proposal

1. **Register roots explicitly.** The current workspace manager accepts sibling
   absolute paths (`workspace-manage-dialog.tsx:343-365`). By contrast,
   `.cognia/workspace.json` roots use confined relative paths and reject `..`
   (`workspace-config.ts:81-90,193-205`). Putting that file in `cognia-next`
   cannot declare `../cognia-services`. A parent configuration repository is
   a possible declaration boundary, but reading its file depends on which
   root supplies configuration and it does not solve managed layout.

2. **Preserve or reconstruct the execution layout before relying on sibling
   dependencies.** Rust places independent repos under storage-key directories
   (`service.rs:2935-2944`); only same-repository subdirectory suffixes survive
   (`3101-3116`). Chat redirects root options, not package manifests or process
   configuration (`use-claude-chat-controller.ts:613-625`). Therefore
   `file:../cognia-sdk`, a parent `mise.toml`, or Process Compose relative
   working directories do not automatically target the correct worktrees.
   This is a source-derived failure mode, not a reproduced package install.
   Provisioning has only confined sparse/cache/include paths
   (`lib/task-workspace/types.ts:94-105`), not a sibling-layout overlay.

3. **Repair per-root setup and execution propagation.** The bundle contract
   has one base and one provisioning object. Main chat resolves it once;
   Squad resolves provisioning from the selected primary source
   (`registry-controller.ts:164-177`); Rust reuses it for every physical root
   (`service.rs:2984-2991`). A main-app sparse/include/cache policy can be
   inappropriate for an SDK. Squad runtime returns only the primary alias
   (`lib/squads/agent-team-runtime.ts:513-517`) and child dispatch forwards one
   execution root, so cloning all roots is not proof that all child tools or
   downstream builds receive them. These are source-derived limitations.

4. **Do not equate a multi-repository graph with every integration path.**
   `integrate-team-run.ts:212-246` groups candidates by repository and resets
   the task-to-changeset map. Review-held state is also per repository
   (`273-310`). The probe supplies `app-task -> sdk-task`, requests changes on
   the SDK, and approves the app: both captures have empty `dependsOn`, and
   `cs-app` enters integration while `cs-sdk` remains held. The separate
   delivery graph models cross-repository edges, but its GitHub adapter is
   opt-in and filters for at least two layers per repo
   (`github-delivery-adapter.ts:618-648,754-760`). Neither path proves atomic
   multi-repository commits or publication.

5. **Keep source-control operations on the intended checkout.** Main local
   SCM mounts `RootSwitcher` without execution aliases
   (`source-control-panel.tsx:383-386`); selecting an item calls
   `setRootDir(r.path)` (`root-switcher.tsx:134-137`). With managed execution,
   selecting the SDK source root is not selecting the SDK worktree. Check
   the displayed absolute path before reviewing or committing. Native UI
   interaction was not run here.

6. **Retain existing independent-build contracts.** The real sibling checkouts
   include `cognia-services`, `cognia-plugins`, `cognia-browser-extension`,
   `cognia-docs`, and `cognia-website`. The example `cognia-sdk`,
   `cognia-server`, and `cognia-runtime` are not these current local checkout
   names; SDK packages remain in the main pnpm workspace. The existing services
   integration pins a SHA across app/CLI manifests and both lockfiles. A local
   dependency mode must coexist with that release path rather than silently
   replacing it. Pin consistency passed; cross-repository compatibility was
   not thereby established.

## Recommended next work

The proposal's responsibility split is useful. Its claim that mise and Process
Compose are core prerequisites is too strong for the product capability:
Cognia can already code across explicit roots without either tool. Their value
is reproducible setup and process lifecycle, not repository identity, Agent
permissions, worktree layout, or cross-repository delivery correctness.

For use now, keep existing sibling checkouts, register the intended roots,
use main chat on the local Host with native Claude or the built-in Agent, and
validate each repository independently. Local execution retains the original
layout but edits those real checkouts; managed execution requires checking
aliases and local dependency paths. Do not rely on multi-agent merge-all to
enforce cross-repository prerequisites.

For development, prioritize these increments:

1. Define a two-repository acceptance journey and turn the reproduced
   prerequisite-loss case into an owning regression/fix.
2. Carry repository/root identity, aliases, per-root base/setup, and downstream
   execution context consistently through main chat, SCM, Squad, and remote
   code supply. Decide how named sibling paths are materialized.
3. Add a minimal optional mise/Process Compose integration through the existing
   environment entry points. Bind service ownership, ports, shutdown, logs,
   and working directories to the execution bundle; do not run all tasks
   against the original checkout by accident.
4. Add explicit local dependency mode, consumer compatibility checks, and a
   version-combination record. Reuse services pin validation and plugin
   authoring/watch/reload workflows. Introduce West only when Git manifest
   management justifies it; it does not replace artifact versions or checks.

Acceptance should change an SDK API and its app consumer, build the app against
the changed SDK, start a dependent service, review both repositories at their
actual execution paths, and hold app integration when SDK validation fails.
Repeat in managed execution and on a second Host before claiming parity.
Changing a source checkout must not silently substitute for changing its
isolated alias; standalone release builds must still work without the parent
workspace.

## Reproduction and results

Commands ran from the repository root through `rtk proxy`; logs contain exact
commands and selected paths. No coverage, full build, full typecheck, or full
repository lint was run for this documentation-only audit.

```sh
pnpm test -- --runInBand --runTestsByPath \
  lib/workspace/roots.test.ts \
  lib/task-workspace/session-bundle.test.ts \
  lib/task-workspace/root-aliases.test.ts \
  lib/files/allowed-roots-sync.test.ts \
  components/shell/workspace-manage-dialog.test.tsx \
  components/source-control/root-switcher.test.tsx \
  lib/project-environment/workspace-config.test.ts \
  lib/project-environment/workspace-config-trust.test.ts \
  lib/project-environment/executor.test.ts \
  lib/squads/delivery/delivery-graph.test.ts \
  lib/squads/workspace/integrate-team-run.test.ts \
  cli/src/agent/session-context.test.ts
# 11 suites passed, 1 failed; 253 assertions passed, 2 failed.

pnpm test -- --runInBand --runTestsByPath \
  lib/claude/build-options.test.ts \
  packages/agent-codex/src/app-server-client.test.ts \
  packages/agent-acp/src/client.test.ts \
  packages/agent-aider/src/cli-client.test.ts \
  packages/agent-a2a/src/client.test.ts \
  --testNamePattern 'additional|writable|workspace.*root|confinement'
# 4 suites passed, 1 skipped; 24 assertions passed, 1261 filtered/skipped.

pnpm cognia-services:check
# cognia-services pin is consistent

node .cache/multi-repo-audit/cross-repository-integration-probe.cjs
# counterexampleReproduced: true

pnpm tauri:debug:agent:status
# ok: false; status: bridge_unavailable
```

Artifacts:

- `.cache/multi-repo-audit/focused-jest.log`
- `.cache/multi-repo-audit/agent-root-jest.log`
- `.cache/multi-repo-audit/cross-repository-integration-probe.cjs`
- `.cache/multi-repo-audit/cross-repository-integration-result.json`

The probe transpiles the actual coordinator in memory and substitutes only
external host/review/integration ports. Its source SHA256 is
`21ab2cd68814358451ad6323a982d6a8f5df34003c6a9c573d982a0db9a499aa`.
It proves coordinator behavior under those inputs, not a live GitHub merge.

## Primary external sources

Read on 2026-11-08. These validate tool responsibilities, not Cognia adoption.

- [mise Git repositories](https://mise.jdx.dev/bootstrap/repos.html): current
  `[bootstrap.repos]` supports clone/ref declarations and
  `mise bootstrap repos apply`, including dry-run/status operations. The
  supplied command is real in current documentation; verify the installed
  version before using it. No mise configuration was added by this audit.
- [Process Compose process lifecycle](https://f1bonacc1.github.io/process-compose/launcher/)
  and [health checks](https://f1bonacc1.github.io/process-compose/health/):
  per-process working directories, dependency conditions, shutdown/restart,
  readiness and liveness provide an appropriate optional service layer.
- [West manifests](https://docs.zephyrproject.org/latest/develop/west/manifest.html):
  `west manifest --freeze` emits SHA revisions for manifest projects. A Git
  revision manifest does not identify all published binary/image/plugin
  artifacts or establish consumer compatibility.
