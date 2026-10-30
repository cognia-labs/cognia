# Turn diff implementation research

Date: 2026-10-29 (Asia/Shanghai)

Scope: the current checked-out Cognia source, including concurrent uncommitted changes. This is implementation research, not a claim about a released build or the behavior of the installed Codex desktop app. No production source was changed for this investigation.

Follow-up: [the adversarial review and agent/environment support matrix](2026-10-29-turn-diff-adversarial-review.md) reproduces additional byte-integrity, settlement, message-binding and Undo-scope defects. Read that review before treating the workflow below as fully supported or accepting the original Undo characterization without qualification.

This report is a separate research artifact because the request asks for a cross-module implementation inventory; extending a production module would not be appropriate.

## Assessment

Cognia has a wired, provider-neutral, settled-turn diff workflow: an isolated Task Workspace run is snapshotted, its patch is retained on the execution Host, a local attribution row binds it to the closing assistant message, and the chat card opens that run in Review. Selected historical turns and conditional exact Undo are implemented. This is not yet a complete diff experience: the current desktop loader demonstrably drops later hunks in a file, several file kinds have no textual diff body, and the chat projection loses additional-root run identities.

The native Codex `turn/diff/updated` string is a separate, incomplete ingestion path. It does not drive the existing Review UI. The observations below concern this checkout on 2026-10-29, rather than a released or installed binary.

## Task Workspace and chat path

```text
Send a turn that owns a managed working copy
  -> acquire a bundle turn and per-root TaskRun leases
  -> agent executes against the leased execution roots
  -> chat status streaming/awaiting_approval -> idle/error
  -> settleTaskWorkspaceTurn (ready/failed/cancelled)
  -> Host captures current bytes and reconciles against baseline
  -> SQLite patch metadata + content-addressed forward/inverse blobs
  -> codeAdoptionTurns local Dexie row + assistantMessageId
  -> TurnChangesCard / ReviewScopePicker
  -> scope=lastTurn, runId=<specific historical run>
  -> getTaskPatchSet -> readTaskResourceDiff -> DiffViewer
```

The send controller acquires workspace execution for `managedWorktree` contexts and compatible legacy cwd turns; explicit Local contexts do not enter that branch ([send branch](../../hooks/chat/use-claude-chat-controller.ts#L4067)). It acquires a bundle/lease and redirects execution before sending to the selected runtime ([lease handling](../../hooks/chat/use-claude-chat-controller.ts#L4200)). The separate legacy fingerprint window remains best effort and Tauri-only ([begin](../../hooks/chat/use-claude-chat-controller.ts#L4341), [legacy guard](../../lib/code-adoption/client.ts#L43)). Therefore a workspace cwd alone does not establish that a turn has a retained per-turn patch.

The Host stops the watcher, snapshots the execution root, reconciles against the run baseline, retains source blobs and writes a PatchSet ([settle implementation](../../crates/cognia-task-workspace/src/service.rs#L4104)). The ledger builds forward and inverse patch blobs for modified text files ([hunk construction](../../crates/cognia-task-workspace/src/ledger.rs#L634)). Watcher/tool events provide hints; the retained baseline/current comparison is the settled change record. ADR-0086 specifies the isolated engine and Host-local patch storage; ADR-0108 specifies the provider-neutral review boundary ([ADR-0086](../content/docs/en/adr/0086-task-scoped-resource-workspaces.md), [ADR-0108](../content/docs/en/adr/0108-codex-inspired-desktop-workflows.md#L22)).

The tracker observes terminal chat status edges and persists agent-origin, non-generated resource counts. It resolves the closing assistant message from the active transcript, background session slice or persisted tail ([projection](../../lib/code-adoption/turn-tracker.ts#L118), [settlement and message binding](../../lib/code-adoption/turn-tracker.ts#L157)). Its subscription is refcounted so two mounted initializers do not settle the same turn twice ([subscription](../../lib/code-adoption/turn-tracker.ts#L226)). The initializer is mounted by the boot chunks ([initializer](../../components/providers/initializers/code-adoption-tracker-initializer.tsx#L23)); the chat renderer actually mounts the card under a finished assistant message ([renderer](../../components/chat/message-renderer.tsx#L1217)).

## User-visible capabilities and boundaries

| Capability             | Current implementation and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-turn summary       | A live Dexie query reads the row by session and assistant message. The card displays changed paths, line totals and six initial files, with expansion. Empty/unavailable turns hide the card. [Hook](../../hooks/chat/use-turn-changes.ts#L16), [card](../../components/chat/turn-changes-card.tsx#L63).                                                                                                                                                                                                                      |
| Review a specific turn | The card reveals the existing workspace dock with `scope: lastTurn` and the retained run ID, optionally focused on one file. Historical selections do not use Git's current worktree diff. [Reveal](../../components/chat/turn-changes-card.tsx#L108), [scope reader](../../lib/review/scope.ts#L219).                                                                                                                                                                                                                        |
| Earlier turns          | `useSessionTurnReviews` selects Task Workspace rows with at least one changed file; the picker exposes newest and older turns, prompt labels and counts. `lastTurn` is a scope name that also represents any selected historical run. [Projection](../../hooks/git/use-session-turn-reviews.ts#L60), [picker](../../components/source-control/review-scope-picker.tsx#L188).                                                                                                                                                  |
| File diff              | Listing reads patch metadata; opening a file fetches its retained unified patch. The loader returns hunks with empty full-file texts and `contentOmitted: true`. SnapshotReview is read-only and does not wire full-file expansion, staging or discard. [Loader](../../lib/review/scope.ts#L352), [surface](../../components/artifacts/workspace-mode/snapshot-review.tsx#L297).                                                                                                                                              |
| Undo                   | Offered only when the patch is applied and reversible. The confirmation calls the Task Workspace inverse operation and distinguishes reverted, conflict, non-applied and failure results. This is an undo of retained contribution data rather than repository-wide discard. [Card](../../components/chat/turn-changes-card.tsx#L98), [Undo](../../components/chat/turn-changes-card.tsx#L118), [ledger](../../crates/cognia-task-workspace/src/ledger.rs#L233).                                                              |
| Persistence            | Counts/message bindings live in local-only `codeAdoptionTurns`; only the newest 10,000 rows are retained. Patch metadata and blobs remain Host-owned. A synced transcript does not itself carry these local card records. [Persistence](../../lib/code-adoption/persist.ts#L1), [pruning](../../lib/code-adoption/persist.ts#L73).                                                                                                                                                                                            |
| Mobile remote review   | Uses Host task/run enumeration and patch reads instead of the local adoption table. Metadata classifies sensitive, binary, symlink and no-text-diff files before fetching a body; the surface labels unavailable bodies. This path should not be equated with desktop card availability. [Run discovery](../../components/mobile/remote-sessions/use-session-changes.ts#L111), [body guard](../../components/mobile/remote-sessions/use-session-changes.ts#L196), [projection](../../lib/task-workspace/run-changes.ts#L128). |

## Confirmed gaps and verification limits

### F1: Desktop Review drops later hunks in the same file

**Reproduced against the actual TypeScript loader.** The Host stores each hunk as an independently applicable patch, including the same file preamble ([split_patch_hunks](../../crates/cognia-task-workspace/src/ledger.rs#L731)). `read_patch_diff` concatenates those stored patches ([reader](../../crates/cognia-task-workspace/src/service.rs#L4811)). `parseUnifiedPatch` opens a new file segment for every `diff --git` preamble ([parser](../../lib/git/unified-patch.ts#L185)). `loadReviewScopeDiff` uses `.find(...)` and takes only that first segment's hunks ([selection](../../lib/review/scope.ts#L362)).

The minimal check supplied two stored-style patch segments for `example.ts`, with changes at lines 1 and 20. It transpiled the checked-out `lib/review/scope.ts` in memory, injected only the resource-read boundary, and used the real `parseUnifiedPatch` implementation. Output:

```json
{
  "check": "multi-hunk turn diff",
  "storedHunks": 2,
  "parsedFileSegments": 2,
  "displayedHunks": 1,
  "displayedHeaders": ["@@ -1 +1 @@"],
  "secondChangeVisible": false
}
```

This establishes the loader/serialization-format defect; it was not a real Codex or Tauri run. The existing `loadReviewScopeDiff` test supplies one hunk only, so it passes without detecting this format boundary ([test](../../lib/review/scope.test.ts#L380)). The repair should merge all segments belonging to the selected file, with a regression using the Host's repeated-preamble representation, or change Host serialization while preserving independently applicable stored hunks.

### F2: Several real change kinds have no desktop textual body

`build_patch_set` creates textual hunks only for `modified`, non-binary, regular files; created, deleted, renamed and symlink entries retain metadata/hashes with an empty hunk list ([condition](../../crates/cognia-task-workspace/src/ledger.rs#L52)). The diff reader returns an empty string for ordinary created/deleted/renamed files, and refuses binary/symlink textual reads ([reader](../../crates/cognia-task-workspace/src/service.rs#L4803)). The desktop scope loader then returns empty hunks for an empty string, while binary/symlink reads become generic errors. The mobile metadata projection already models these availability reasons explicitly ([availability](../../lib/task-workspace/run-changes.ts#L128)); desktop SnapshotReview does not use it.

This is a presentation/body-availability limitation, not proof that apply/undo cannot handle those resource kinds: the ledger retains hashes and modes separately. Full before/after retrieval is also not wired into SnapshotReview's DiffViewer props ([viewer props](../../components/artifacts/workspace-mode/snapshot-review.tsx#L303)).

### F3: Fingerprint-only records do not provide historical turn diff

When no Task Workspace resources exist, the tracker can retain legacy fingerprint counts and labels them `legacyFingerprint` ([fallback](../../lib/code-adoption/turn-tracker.ts#L77)). Such a card's View action opens `uncommitted`, which means the current workspace, and offers no patch Undo ([fallback reveal](../../components/chat/turn-changes-card.tsx#L108)). The history picker excludes those rows ([picker projection](../../hooks/git/use-session-turn-reviews.ts#L67)). Thus “a turn has an edited-files card” does not always mean its historical diff exists.

### F4: The chat projection loses additional-root run identity

Bundle acquisition activates every per-root run, ordering the primary run last so it becomes `activeBySession` ([activation](../../lib/task-workspace/client.ts#L232)). Settlement flattens resources from every root ([flatten](../../lib/task-workspace/client.ts#L465)). The tracker converts that combined resource list to files containing only relative paths, and stores only the single `active.runId` as `taskWorkspaceRunId` ([file projection](../../lib/code-adoption/turn-tracker.ts#L118), [run binding](../../lib/code-adoption/turn-tracker.ts#L206)). The card then opens one root/run and invokes Undo on that one run.

The data flow therefore cannot faithfully represent a bundle-wide turn in that card: additional-root changes can appear in the counts/list without being in the selected primary patch, and identical relative paths lose their root identity. This is a source-confirmed structural mismatch; no multi-root real-runtime reproduction or destructive Undo was performed. The lower-level Review collector accepts per-root run refs, so this is not a claim that the entire backend lacks multi-root support ([per-root refs](../../lib/review/scope.ts#L82)).

### Remaining runtime acceptance

The findings establish code wiring, focused unit behavior and one reproduced loader defect. They do not establish a working released desktop flow, actual Host filesystem capture, real-provider notifications, cross-device reconnection or the full runtime matrix. No dedicated turn-diff E2E hit was found by the targeted search of `tests/e2e`; that search alone does not prove no broader test exercises it.

Recommended order: fix the silently omitted multi-hunk data first; add accurate desktop availability states and textual create/delete/rename support; preserve root/run identity through chat projection; then validate multi-turn, Local/managed, restart, multi-root and remote-Host scenarios with the actual shell. Treat native Codex diff streaming as a separate product decision because the retained Host patch currently owns review and undo.

## Codex protocol ingestion

The app registers `codex-app-server` with `createCodexAppServerAdapterFactory` in [manager.ts](../../lib/ai/agent/external/manager.ts#L398). The factory constructs `CodexAppServerAdapter`, supplies the process host, launch environment, outbound PII gate and approval policy, and wires the optional completed-file-change sink in [integrations/codex.ts](../../lib/ai/agent/external/integrations/codex.ts#L27).

Incoming notifications resolve a session before dispatch in [app-server-client.ts](../../packages/agent-codex/src/app-server-client.ts#L2379). Session identity comes from `threadId`, `conversationId`, `thread.id`, or `turn.threadId`; if all are absent, the single open session is used. This resolver does not use `turnId` ([resolver](../../packages/agent-codex/src/app-server-client.ts#L4752)).

`turn/diff/updated` accepts a string `params.diff`, falling back to `params.unifiedDiff.text`. It replaces `session.metadata.turnDiff` on the existing in-memory session and returns ([handler](../../packages/agent-codex/src/app-server-client.ts#L2604)). Empty strings are accepted; missing/non-string values leave the previous value untouched.

The implemented data path is therefore:

```text
Codex app-server notification
  -> resolve native thread/session ID
  -> _sessions[sessionId].metadata.turnDiff = latest unified diff string
  -> no emitted turn-diff/presentation event
```

## Propagation and lifetime

The session contract exposes `metadata` only as `Record<string, unknown>`; `turnDiff` has no dedicated typed field ([session contract](../../packages/agent-contracts/src/external-agent.ts#L2008)). The canonical event union has no dedicated turn-diff event ([event types](../../packages/agent-contracts/src/external-agent.ts#L2282)). A generic `session_info_update.metadata` patch exists ([contract](../../packages/agent-contracts/src/external-agent.ts#L2638)), but the diff handler does not emit it.

`BaseProtocolAdapter` holds `_sessions` in a `Map`, and its getters return live sessions ([base adapter](../../packages/agent-runtime-kit/src/base-adapter.ts#L134)). The manager's `getSession` delegates to the owning adapter for non-gateway sessions ([manager getter](../../lib/ai/agent/external/manager.ts#L4327)). Consequently a caller explicitly polling this live object can see the latest diff; there is no automatic diff-specific event delivery. A repository-wide literal search for `turnDiff` and `turn/diff/updated` found only this handler and its unit test, excluding this report; no UI/store/persistence reader of the field was found.

Specific lifetime limits follow from the source:

- A new prompt changes status and sends input but does not clear or partition `turnDiff` ([prompt](../../packages/agent-codex/src/app-server-client.ts#L1822)). Without a subsequent diff notification, the previous turn's value remains.
- The handler stores neither the notification's `turnId` nor a Cognia run/message ID. It has no check against `activeTurns` or revoked turns, although `turn/started` and `turn/completed` do check turn ownership ([lifecycle checks](../../packages/agent-codex/src/app-server-client.ts#L2396)). A delayed notification for an earlier turn can therefore replace the session's latest string; this is a source-level consequence, not an exercised real-provider scenario.
- Resume builds fresh metadata from session-create options and reconstructs messages from native turns, rather than restoring `turnDiff` from history ([resume](../../packages/agent-codex/src/app-server-client.ts#L1471), [hydration](../../packages/agent-codex/src/app-server-client.ts#L1520)).
- Fork copies source-session metadata wholesale before applying requested defaults ([fork](../../packages/agent-codex/src/app-server-client.ts#L1565)). This can carry the source's last `turnDiff` into a new fork without recomputing it for the selected fork boundary.
- Clearing/forgetting the adapter's sessions loses this in-memory value ([forgetSessions](../../packages/agent-runtime-kit/src/base-adapter.ts#L180)). No dedicated durable turn-diff write/read path was found.

The handler's comment says storing the string will let the UI render a turn-level diff. The current source establishes storage of the latest string only; the comment does not establish a completed UI feature.

## Separate completed-file-change evidence

`item/completed` with a `fileChange` invokes `onFileChanges(sessionId, itemId, changes)` only for `status === "completed"`; failed/declined items still emit error-marked tool results, without claiming an applied edit ([fileChange handler](../../packages/agent-codex/src/app-server-client.ts#L2947)). This is independent of `turn/diff/updated`.

The app sink dynamically imports `recordToolFileChanges` and swallows sink failures ([host sink](../../lib/ai/agent/external/integrations/codex.ts#L20)). That function requires `activeBySession[sessionId]`, normalizes paths relative to the active execution root, rejects outside-root/traversal paths, and records only `runId`, path/oldPath, change kind and tool-call ID ([tool-evidence.ts](../../lib/task-workspace/tool-evidence.ts#L33)). It does not persist the unified diff from the notification. Its own comment identifies these records as causal hints and the watcher/snapshot as authoritative.

The sink receives the adapter's native thread ID, whereas the manager also maintains a separate `metadata.cogniaSessionId` binding ([binding](../../lib/ai/agent/external/manager.ts#L4302)). Bundle activation uses the Cognia chat session ID from `request.run.sessionId` ([activation](../../lib/task-workspace/client.ts#L242)). The sink performs no native-to-chat mapping before looking up `activeBySession`, so different IDs can cause these causal hints to be dropped. This is a source-level integration risk, not a demonstrated loss of the settled snapshot diff: watcher/snapshot capture is independent, and a real-provider integration reproduction remains unrun.

## Verification performed

Normal `pnpm test` attempted a dependency-status install and failed before Jest at an existing postinstall check: `@cognia/agent-config-types/plugin-interception` resolved to TypeScript source, while the bundled sidecar requires a compiled JavaScript `node` export. No unrelated source fix was made. The installed pnpm supports `--config.verify-deps-before-run=false`; using that flag retained the repository's `pnpm test`/`scripts/test/jest.mjs` entry point and avoided repeating the automatic install.

Executed successfully:

```sh
pnpm --config.verify-deps-before-run=false test -- --runInBand --runTestsByPath \
  lib/code-adoption/turn-tracker.test.ts \
  lib/task-workspace/client.test.ts \
  hooks/chat/use-turn-changes.test.ts \
  hooks/git/use-session-turn-reviews.test.ts \
  components/chat/turn-changes-card.test.tsx \
  lib/review/scope.test.ts \
  components/artifacts/workspace-mode/snapshot-review.test.tsx \
  components/source-control/review-scope-picker.test.tsx \
  lib/task-workspace/run-changes.test.ts
```

Result: **9 suites passed, 245 tests passed**. The two live-query hook suites emitted React `act(...)` warnings; Jest still reported success. No coverage run was requested or performed. These tests cover settlement, message binding, local persistence projection, historical turn selection, reveal, conditional Undo, scope parsing, readonly SnapshotReview and metadata availability. F1 remains reproducible despite those passing tests.

```sh
pnpm --config.verify-deps-before-run=false test -- --runInBand --runTestsByPath packages/agent-codex/src/app-server-client.test.ts -t 'streams item/plan/delta as thinking, dedupes the plan item, and records turn/diff'
```

Result: 1 suite passed; 1 test passed, 222 skipped. The test checks that an incoming notification leaves `+++ b` in private session metadata after turn completion ([assertion](../../packages/agent-codex/src/app-server-client.test.ts#L3545)). It does not establish streaming UI delivery, per-turn history, persistence, stale-notification rejection, multi-turn clearing, or fork-boundary correctness.

```sh
pnpm --config.verify-deps-before-run=false test -- --runInBand --runTestsByPath lib/task-workspace/tool-evidence.test.ts lib/ai/agent/external/integrations/codex.test.ts
```

Result: 2 suites passed; 5 tests passed. These cover factory/protocol wiring, unavailable-host behavior, outbound PII gating, independent adapter instances, and in-root evidence-path normalization. They do not run a real provider or native workspace watcher.

CodeGraph exploration was unavailable because this checkout has no `.codegraph/` index. Investigation used `rg`, source reads and line-numbered evidence. No full build, full typecheck/lint, browser flow, Tauri shell or real Codex provider acceptance was performed for this read-only research.
