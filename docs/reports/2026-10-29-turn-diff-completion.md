# Turn diff completion — 2026-10-29

This implementation follows the [adversarial review](2026-10-29-turn-diff-adversarial-review.md). Work is implemented across the existing native ledger, execution lifecycle, retained projection and Review surfaces. Verification is still open: see the [evidence ledger](../evidence/2026-10-29-turn-diff-completion.md). This shared checkout contains substantial unrelated concurrent changes; no commit was created.

## Architecture

`cognia-task-workspace` remains the single source of reversible file history. Provider-native diff events remain hints. Chat adoption rows hold bounded metadata and execution references, while the execution Host retains patches and blobs. Each root carries its own run and Host/account; reads, leases, settlement and client database writes validate that ownership across asynchronous boundaries.

Managed runs retain Registry/Bundle isolation. Explicit interactive Local runs use `observeInPlace` / `IsolationKind::Observed`: baseline before execution, already-applied patch and inverse after execution stops, exclusive root ownership and no second forward apply. Unknown authors remain Unknown. Archive/prune never remove the live root. Older Hosts that ignore the flag are rejected before agent execution.

Historical Review aggregates roots. Undo explicitly names one root and its actual applied file/hunk selection. The visible scope includes user uploads and unknown-origin changes; adoption metrics remain agent-only. Restore-from-message carries every run/Host reference, skips already-reverted roots, includes user-only patches and blocks missing/unavailable history.

Standalone CLI uses the existing workspace helper's persistent bounded JSONL interface and the same ledger. No network service or parallel provider-specific patch database is added.

## Audit closure map

| Audit                               | Repair                                                                                    | Evidence                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1 payload corruption               | Normalize structural Git headers only; preserve body bytes and decode quoted paths        | Native RED to GREEN, actual helper smoke                                   |
| A2 lost later hunks                 | Canonical full-file diff; combine retained legacy segments; validate partial replay       | Native and parser/scope regressions                                        |
| A3 late message binding             | Pin closing message at settle edge; receiver uses allocated assistant identity            | Tracker/remote/controller tests                                            |
| A4 hidden user contribution in Undo | Complete capture scope and provenance; exact applied-selection confirmation               | Native upload/undo and production card tests                               |
| A5 primary-only multi-root controls | Retain every root/run; aggregate View and explicit per-root Undo                          | Picker/snapshot/card/restore integration tests                             |
| A6 stale selected body              | Key file list and body by root, run and selection                                         | Deferred-body regression and browser fixture                               |
| A7 chmod-only settle                | Record metadata-only changes without requiring text hunks                                 | Native mode-only regression                                                |
| A8 header-shaped payload            | Track unfinished hunk line counts before interpreting headers                             | TS/native payload regressions                                              |
| A9 missing history shown clean      | Explicit missing-patch/unavailable state; restore fails closed                            | Scope/UI/restore tests                                                     |
| A10 current Host redirects history  | Retain original authority, owner-filter leases, reject identity changes, pin DB namespace | Deferred transport/account/database tests                                  |
| A11 OpenCode V1 cwd ignored         | Directory-bound per-session SDK clients; validate create/resume/fork                      | Package tests and typecheck                                                |
| A12 Host-owned external gap         | Execution Host owns begin/settle; bounded terminal refs; settle after executor stops      | Completed/failed/cancelled/acquisition tests                               |
| Additional explicit Local gap       | Native observed runs on Git and non-Git roots                                             | Native observed/owner tests; latest nested ignored-root fix awaiting GREEN |
| Additional CLI gap                  | Shared persistent worker; logical turn lifecycle and inherited worker lease               | Initial CLI unit suites passed; latest integration awaiting rerun          |

## Support contract

| Execution                                                                             | Capture behavior                                                                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in/Claude SDK, managed Chat                                                     | Existing isolated ledger lifecycle, complete retained patch references                                                                             |
| Explicit interactive Local                                                            | Observed root on the execution Host; no cwd redirection; conservative authorship                                                                   |
| ACP, Codex, Pi, Aider, OpenClaude, Continue, DSH, Codebuff on Host-visible filesystem | Shared lifecycle when adapter consumes the supplied cwd                                                                                            |
| OpenCode V1/V2, Crush/Rovo owned local process                                        | Capture only when the Host owns process placement and cwd authority                                                                                |
| Host-owned external agent                                                             | Host captures and settles before terminal reply; receiver indexes original references                                                              |
| Arbitrary HTTP/WS endpoints, A2A, remote clone/E2B without visible filesystem         | Explicit capture unavailable; never claim an empty verified turn                                                                                   |
| Docker/Kubernetes bind/PVC execution                                                  | Requires actual Host-visible execution root and placement receipt; independent provider acceptance remains required                                |
| CLI one-shot/API/SDK/RPC and worker handoff                                           | Existing worker-based capture; inherited ownership transfers once and unused leases close; final validation pending                                |
| CLI REPL/TUI                                                                          | Shared per-send capture; failed/cancelled executor teardown precedes settle; existing rewind checkpoints remain separate; final validation pending |
| Plain browser without execution Host                                                  | No filesystem capture authority; unavailable state                                                                                                 |

Catalog membership alone does not establish filesystem authority or provider acceptance. Agent execution may continue when capture is unavailable; historical mutation controls must not imply reversibility.

CLI retained history is reachable through `cognia-agent worker tasks [--session-id ID]`, `worker runs --task-id ID`, `worker diff --run-id ID [--path FILE]` and `worker undo --run-id ID`, with optional `--json`. These commands open the same helper ledger as capture, using `COGNIA_DATA_DIR` or `<CLI home>/worker-data`. The legacy one-shot run adapter now forwards the bounded receipt into text/JSON/error output. `--no-session` disables capture and uses a transient transcript for one-shot/readline execution. Persistent TUI mode explicitly refuses that flag before session creation.

## Verification

Results are separate batches and overlap; do not sum them into a unique test count.

| Check                                                        | Actual result                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native full suite before final worker/root additions         | 558 passed                                                                                                                                        |
| Native worker/owner focused suite; schema parity             | 5 passed; 1 passed                                                                                                                                |
| Native all-target check; production clippy                   | Passed before latest nested-root change                                                                                                           |
| Public-service repro and compiled helper dual-process smoke  | Passed: capture, diff, Undo, exclusive ownership and EOF                                                                                          |
| Parent controller/restore/DTO suites before final follow-ups | 421 passed                                                                                                                                        |
| Parser/scope/snapshot/picker/store batch                     | 70 passed                                                                                                                                         |
| Origin/lease/lifecycle/card batch                            | 7 suites, 238 passed                                                                                                                              |
| External runtime batch                                       | 6 suites, 248 passed                                                                                                                              |
| DB namespace regression batch                                | 4 suites, 90 passed; real Dexie rerun 17 passed                                                                                                   |
| Initial CLI integration suite                                | 99 passed; expanded smoke found nested ignored-root failure                                                                                       |
| Full `pnpm lint` before final follow-ups                     | Passed; final CLI/lifecycle additions still need rerun                                                                                            |
| i18n build/check/lint/sort before final TUI additions        | Passed; new TUI split-source keys need generator rebuild and rerun                                                                                |
| Sidecar typecheck                                            | Passed                                                                                                                                            |
| Root typecheck                                               | Blocked by unrelated `cli/src/tui/components/Transcript.tsx`, `lib/account-sync/data/tables.ts`, `stores/artifact/dock-documents-store.ts` errors |
| Static-export gate                                           | 14 pre-existing imports in codebuff/crush Node entries; scoped audit found no newly introduced violation                                          |
| Native Host crate test build                                 | Blocked by unrelated `cognia-companion-rpc` missing `ACCEPTANCE_COMMANDS` import                                                                  |
| Final native/CLI rerun                                       | Blocked by workstation process startup stall; latest 563-test attempt has child-launch timeouts; current native test count 564                    |

Read-only test-gap, i18n, static-export, wiring and PII audits are complete. Test-gap findings led to an integrated multi-Host restore regression and CLI transport-boundary tests. Wiring findings led to reachable legacy blob reads, Host-owned unowned marking, captured-run reconciliation and retained CLI commands. The PII finding led to a gate before OpenCode places session-derived cwd in directory headers/query parameters. Source-only follow-up found no additional obvious contract defect in the final REPL/retained-read/directory-gate paths. These latest regression additions still need execution. No coverage check was requested or run.

The repository's installed Prettier standalone API was used in an already-running JavaScript runtime to parse/format the final parent/lifecycle/TUI files while new OS processes were blocked. This is syntax/format evidence, not a Jest, lint or typecheck result. Generated locale files were not hand-edited.

## Browser and real-environment evidence

The browser fixture mounts the production `TurnChangesCard` and `SnapshotReview` with deterministic transport and a lightweight diff-body stub. It verified aggregate roots with identical relative paths, correct root-specific body navigation, user-contribution disclosure, per-root Undo confirmation/action, and missing-history/unavailable labels. It does not prove native IPC, full app styling, live providers or installed desktop parity.

![Production component fixture after Undo of /docs; /project remains undoable](../../../.cache/turn-diff-completion/ui/per-root-undo.png)

The compiled native helper was separately exercised against real temporary files and two processes. A later TypeScript-client smoke exposed the nested ignored-root issue; that source repair and the final helper build still need rerunning after the OS process startup stall clears. Sample: `.cache/turn-diff-audit/native-stalled.sample`. No OS security settings were changed.

## Remaining acceptance

1. Run final CLI/REPL/TUI/inherited-owner integration checks.
2. Rebuild the helper; obtain GREEN for `selected_workspace_does_not_inherit_ancestor_git_or_ignore_scope`; rerun the native suite and the actual TS-client smoke.
3. Rebuild new TUI locale sources with `pnpm i18n:build`; run build freshness/key/ICU gates and integrated test/type/lint rerun.
4. Verify actual installed Tauri, paired/headless Host, physical platforms and chosen live agents/providers. Remote filesystems need execution-side capture authority, not optimistic adapter declarations.

The implementation is not yet a verified release candidate while these items remain open.

Start the remaining checks from the repository root after process startup recovers:

```bash
pnpm --config.verify-deps-before-run=false i18n:build
pnpm --config.verify-deps-before-run=false i18n:build:check
pnpm --config.verify-deps-before-run=false lint:i18n
pnpm --config.verify-deps-before-run=false i18n:sort:check
cargo build --locked -p cognia-task-workspace --bin cognia-task-workspace-worker
cargo test -p cognia-task-workspace --lib
COGNIA_TEST_WORKSPACE_HELPER="$PWD/target/debug/cognia-task-workspace-worker" \
pnpm --config.verify-deps-before-run=false test -- --runInBand --runTestsByPath \
  lib/task-workspace/client.test.ts lib/task-workspace/run-changes.test.ts \
  lib/code-adoption/turn-tracker.test.ts lib/review/scope.test.ts \
  packages/agent-opencode/src/client.test.ts hooks/chat/use-claude-chat.test.ts \
  cli/src/worker/workspace-client.test.ts cli/src/worker/worker-connect.test.ts \
  cli/src/agent/runtime/unified-runtime.test.ts cli/src/agent/rpc/runtime-service.test.ts \
  cli/src/agent/transcript.test.ts cli/src/agent/run.test.ts \
  cli/src/cli/chat.test.ts cli/src/cli/run-command.test.ts cli/src/cli/worker-command.test.ts \
  cli/src/tui/hooks/turn-engine.test.ts cli/src/tui/hooks/useAgentSession.test.tsx
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false lint
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check \
  docs/evidence/2026-10-29-turn-diff-completion.md --final
```
