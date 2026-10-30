# Independent adversarial review of connector repairs

Current follow-up: the seven findings below have been repaired locally, including two further auth/upload edge cases found by a fresh independent review. See [G14 repair and independent re-review](#g14-repair-and-independent-re-review-2026-10-28) for current evidence and remaining verification limits. The original review below is retained as the pre-repair snapshot.

Date: 2026-10-28, Asia/Shanghai. Request: “再对这轮连接器修复做一次独立对抗性审查，重点检查飞书授权与刷新身份绑定、历史回执迁移和取消竞态，用可复现证据验证问题。”

Three new fresh-context reviewers examined current authentication, receipts and cancellation separately. They received current source paths and extracted behavioral contracts, without author reports, previous reviewer conclusions or ledger Decisions. The main session reconciled the source and reran all reported reproductions. The user's prior additional cross-model opt-out was retained; no external model CLI ran. Product/test source was not changed and no real account, private document or user database was accessed.

## Verdict

**Seven confirmed contract gaps: three P1 and four P2.** The previous local repair-closure claim is reopened. Each issue has an executable synthetic counterexample; scope and substitutions are stated below. These are current local implementation findings, not claims of a live-provider incident.

| ID  | Priority | Finding                                                                                   | Executed observation                                                                                             |
| --- | -------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A1  | P1       | A partial token-pair edit can refresh into a different identity under the same new epoch. | All eight credential/API/mutation combinations accept the cross-identity publication.                            |
| A2  | P1       | One outbound send can change user between preflight and final dispatch.                   | Actual image send checks A, waits for upload, sends as B and returns success.                                    |
| A3  | P1       | Default API callers do not fence authorization changes.                                   | Real task-list pagination sends a second page with A after A is locally revoked; epoch-supplied control refuses. |
| H1  | P2       | Historical migration destroys unrelated callback receipts.                                | Valid opaque callback result becomes host-semantic; retry is InProgress while operation lookup is None.          |
| H2  | P2       | Every headless auth snapshot creates a non-expiring hash binding.                         | After a one-year sweep, 0/1000 bindings are removed and all retain their conflict locks.                         |
| C1  | P2       | CLI lazy-import continuation dispatches after cancellation.                               | Caller rejects, then native CLI port is still invoked once.                                                      |
| C2  | P2       | Public pending Promise can resolve content after abort.                                   | Raw API/CLI and API wrapper reproduce; real signal-capable staging returns one document after abort.             |

## A1 — P1: mixed credentials are admitted as a new legacy identity

Locations: [legacy fallback](../../crates/cognia-connectors/src/keyring.rs#L202), [refresh guard](../../crates/cognia-connectors/src/keyring.rs#L311).

Sequence: authorize A through the native owner, directly replace only `user_token` with B, then snapshot. Existing dependencies delete `USER_EPOCH`, but leave `refresh-A` in place. Capture treats the mixed B/refresh-A pair as a valid new legacy lineage. A subsequent refresh can publish the response from refresh-A as access-A2 while preserving that post-edit epoch. Thus content can cross identities without a further epoch change. The inverse refresh-only edit can publish B2 from an A access state.

The native probe compiles current `keyring.rs` and `host_secrets.rs` by path. It tests access-only/refresh-only × set/delete-recreate × keyring/direct-host-secret APIs: **all eight accept**. Ordinary legacy refresh and current managed refresh with label/scopes are positive controls and pass. The secret-store persistence port is an atomic in-memory map, and unrelated OA/storage integration is stubbed; no OS keyring, real encrypted file or provider ran. The tokens are synthetic identity markers; real OAuth refresh uses the captured refresh credential independently of the access credential.

Existing tests check that a direct edit changes the epoch, but do not continue by refreshing from the resulting mixed snapshot. Reuse the pair owner/dependency mechanism to keep partial pair states from refreshing; preserve legitimate legacy and atomic current refresh as controls. No second identity store is needed.

Evidence: [native probe source](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/native-probe/src/main.rs), [main-session output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/parent-native-output.log). Classification: valid + actionable, unresolved.

## A2 — P1: send loses its checked identity across media upload

Locations: [preflight](../../lib/connectors/adapters/lark/index.ts#L821), [dispatch after upload](../../lib/connectors/adapters/lark/index.ts#L861), [new wrapper capture](../../lib/connectors/adapters/lark/index.ts#L386).

`deliverCardRequest` checks the connected user through `requireUserSendIdentity`, but carries no captured epoch into later upload/serialization and `doRequest`. The probe sends an actual image segment. Production `index`, `auth`, `auth-retry`, `upload`, `serialize`, `card` and `private-threads` execute. The native image-upload port completes after authority changes from A to B. Actual serialization emits an image message with the uploaded key; final dispatch independently captures B and sends `Bearer access-B`, despite preflight having checked A, then returns `ok: true`.

HTTP/native upload results and unrelated collaborators are synthetic. The real media/serializer path is executed; no image was fetched or uploaded externally. Bind the originating epoch across the whole send transaction and reject replacement before final side effect, using the existing retry/credential owner.

Evidence: [JS probe](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/js-identity-probe.cjs), [main-session output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/parent-js-output.log). Classification: valid + actionable, unresolved.

## A3 — P1: omitted expected epoch disables authorization fencing

Location: [conditional check](../../lib/connectors/adapters/lark/authed-api.ts#L126).

When `expectedAuthorizationEpoch` is absent, `assertCurrent` performs only cancellation checks. The wrapper captures a token at the first attempt, but neither each API call nor successful completion revalidates the authority by default. Production `listLarkTasklists`/pagination retrieves page one, locally revokes A, then sends page two with `Bearer access-A` and returns both pages. Supplying the expected epoch causes the control to refuse after the first response.

This default is reachable: [Lark task sync](../../lib/issues/sync/providers/lark-task.ts#L106), [Bitable sync](../../lib/issues/sync/providers/lark-bitable.ts#L153), and Twin UI → [stageLarkDoc](../../lib/twin/ingest/stage.ts#L440) → [raw fetcher](../../lib/twin/ingest/lark-doc-fetcher.ts#L166) omit an epoch. The native HTTP owner forwards the bearer without another identity check. This is local revocation, not a claim that Feishu revoked the provider token remotely. Picker provider paths that supply an epoch remain protected in the tested sequence.

Capture a default operation epoch inside the existing harness and enforce it around each request/result; a caller-supplied epoch should add an origin check, not be required to enable revocation safety.

Evidence: the same [JS probe/output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/parent-js-output.log), executing the production pagination helper with synthetic native/API ports. Classification: valid + actionable, unresolved.

## H1 — P2: DTO-subset migration corrupts unrelated retry results

Location: [migration predicate](../../crates/cognia-companion-security/src/security_store.rs#L3453).

The migration scans all receipt records and classifies a field subset as Lark auth state. It checks neither command ownership nor an exact DTO shape. `plugin_invoke_js_callback` is a reachable required-idempotent Replay command; its [runtime owner](../../crates/cognia-plugin-runtime/src/lifecycle.rs#L1034) returns arbitrary callback JSON verbatim. A callback may return a legitimate object with the auth-like fields, null tokens, and an extra `callbackMarker`.

The file-backed SQLite fixture shows that upgrade deletes this unrelated result and sets status to host-semantic. The command's current policy remains Replay, so same-key/same-hash retry returns InProgress, while operation lookup returns None. A completed plugin action loses its result and obtains an unresolvable pending retry.

The probe links the cached native SecurityStore library matching current source and invokes actual public open/migration/retry/query methods against new fixture databases. Source tracing establishes the opaque callback route; the plugin process itself was not launched. Keep migration ownership narrow enough to preserve unrelated opaque results; current request/hash admission can identify a command during retry, while historical proactive cleanup needs an explicit ownership strategy.

Evidence: [native fixture](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/receipt_probe.rs), [main-session output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/parent-native-output.log), [full storage review](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/receipt-findings.md). Classification: valid + actionable, introduced by this migration, unresolved.

## H2 — P2: headless snapshots accumulate permanent bindings

Locations: [new Lark policy](../../crates/cognia-companion-contract/src/command_manifest.rs#L144), [binding insertion](../../crates/cognia-companion-security/src/security_store.rs#L1862), [retention predicate](../../crates/cognia-companion-security/src/security_store.rs#L1813).

Every ordinary headless auth snapshot obtains a fresh logical UUID, enters HostSemantic execution and inserts a NULL-receipt hash binding. The existing retention sweep deletes only rows with non-NULL receipts. Service principals cannot be forgotten through device cleanup; person-account cleanup does not cover these service UUID rows.

The native fixture creates 1000 bindings at time 100 and sweeps at 365 days later: purged=0, with all 1000 still rejecting changed hashes. No production traffic rate or disk exhaustion was measured. The shared helper's retention gap predates this repair, but its application to every high-frequency Lark snapshot is new in this repair. Define a bounded lifecycle for these bindings or separate current-state snapshots from durable mutation retry bindings within existing command/execution owners.

Evidence: the [native receipt output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/parent-native-output.log). Classification: valid + actionable, existing helper gap newly amplified, unresolved.

## C1 — P2: cancelled CLI work still dispatches after lazy import

Locations: [dynamic import](../../lib/twin/ingest/lark-doc-fetcher.ts#L313), [exec invocation](../../lib/twin/ingest/lark-doc-fetcher.ts#L324).

Use `channel: cli`, provide a signal and omit `execImpl`, so production awaits the dynamic import. Abort immediately while it is pending. The caller rejects, but the import continuation invokes `execLarkCli` once, because no signal check precedes that side effect. This is a new command after cancellation, outside the exception for already-dispatched native work.

The probe runs the current fetcher and stubs only the native CLI module and peripheral/native ports. It asserts zero calls and fails with one actual call. Reuse the existing synchronous abort helper after import and before exec.

## C2 — P2: inner completion leaves a public-Promise cancellation window

Locations: [async return of wrapper](../../lib/connectors/adapters/lark/authed-api.ts#L123), [raw API/CLI return](../../lib/twin/ingest/lark-doc-fetcher.ts#L150), [abort-listener removal](../../lib/network/request-abort.ts#L23).

An inner promise completes and removes its abort listener while the public async wrapper still adopts that promise. Abort during the remaining continuation cannot reject the public result, and document content is returned after cancellation.

The deterministic probe records whether the **public Promise is pending immediately before abort** using Node `util.inspect`. Fixed scheduling parameters exercise earlier rejection, the failing window, and an already-settled control; post-settlement aborts are excluded:

| Public boundary           | Early cancellation rejects | Pending-at-abort but success | Already-settled control |
| ------------------------- | -------------------------- | ---------------------------- | ----------------------- |
| Authenticated API wrapper | 5                          | 6                            | 8                       |
| Raw API fetch             | 7                          | 8                            | 12                      |
| Raw CLI fetch             | 1                          | 2                            | 4                       |

Numbers are recursive microtask depths in this probe, not timing estimates. Production `stageLarkDoc` with a signal returns one staged document in the failing raw-API schedule. This is staged source data, not proof of a committed attachment or memory write. Current Twin UI does not pass a signal; its present UI cancellation exposure is not established. Provider fetch/search final guards prevented publication in the tested schedules.

Recheck abort in the final public continuation before returning a plain result, or remove unnecessary adoption layers while preserving the Promise/error contract. Keep already-dispatched rotating-token publication intact.

Evidence for C1/C2: [fixed-schedule probes](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/cancellation/probes.test.ts), [isolated Jest config](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/cancellation/jest.config.cjs), [main-session failure output](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/cancellation/parent-probe-results.txt): **5 contract assertions failed / 4 controls passed, 9 cases**. Classification: two independent valid + actionable gaps, unresolved.

## Verification and limits

- Existing focused baseline rerun: 6 Jest suites / 154 tests, 12 native keyring tests and 98 SecurityStore tests passed. Passing baseline tests coexist with the counterexamples above.
- The main session independently reran both auth probes and the native receipt fixture successfully as counterexample-observation harnesses. Their exit 0 means the observed defects matched their assertions; it does not mean product contracts passed.
- Main-session cancellation suite rerun: 5 contract failures / 4 passes. No coverage command ran.
- Hash-conflict refusal, matching failed/running retries, reopen reconciliation, late generic completion refusal, migration-failure transaction rollback and 5000 mixed-row iteration produced no new defect in the native fixture.
- All primary reviewed source hashes still match the initial snapshot. Only this report, the continuing evidence ledger, review-status pointers and diagnostic artifacts were written. Concurrent product work was preserved.
- Conditional observations are excluded from the seven findings: a one-use rotating refresh provider can reject the losing concurrent refresh, but that provider behavior was synthetic and not established as Feishu's real contract; a legacy body wrapper is skipped, but a feasible historical version ordering was not established. OAuth DB display projection and generic HTTP OAuth-result receipts remain adjacent pre-existing risks.
- No live OAuth/provider ACLs, real keyring/encrypted-file backend, native WebView UI, full production build, independent old Host process or forensic SQLite cleanup certification. The cached-library receipt fixture records its exact linker command and source hashes in the storage review.

## Reproduction

Run from the repository root. The native receipt probe output directory must be new.

```sh
rtk proxy node .cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/js-identity-probe.cjs
rtk proxy cargo run --offline --manifest-path .cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/native-probe/Cargo.toml --target-dir .cache/diagnostics/connector-repair-independent-review-2026-10-28/auth/native-probe/target -j 1
rtk proxy rustc --edition=2024 -L dependency=target/debug/deps --extern cognia_companion_security=target/debug/deps/libcognia_companion_security-06b76061640d63be.rlib .cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/receipt_probe.rs -o .cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/receipt_probe
rtk proxy .cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/receipt_probe .cache/diagnostics/connector-repair-independent-review-2026-10-28/receipts/repro-fresh
rtk proxy pnpm test -- --config .cache/diagnostics/connector-repair-independent-review-2026-10-28/cancellation/jest.config.cjs --runInBand --no-coverage
```

[Source snapshot](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/source-snapshot.json) · [Source stability](../../.cache/diagnostics/connector-repair-independent-review-2026-10-28/source-stability.json) · [Evidence ledger](../evidence/2026-10-21-feishu-document-support-audit.md).

## G14 repair and independent re-review — 2026-10-28

Request: “继续按 evidence-driven-dev 修复这七个问题，优先处理三个 P1，复用现有模块，补齐回归测试并验证，完成后自动再做一轮独立对抗性审查。”

All seven finding groups are repaired in the existing native credential/dependency owner, Lark retry/API/adapter modules, shared abort helper, Twin fetch/staging owners and Companion security ledger. No new production module, duplicate connector stack or provider was added. Concurrent work remains uncommitted and preserved; this task did not commit or push.

| Finding | Current behavior                                                                                                                                                                                                                                                                                                                           | Regression evidence                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 — P1 | Credential mutations invalidate the counterpart and lineage. A never-managed legacy pair is adopted once under atomic revision guards; recorded lineage history survives deletion of both credentials. Partial or recreated mixed pairs cannot refresh into another user.                                                                  | Eight partial edit combinations, legacy/managed double deletion, failed batch publication, ABA, valid legacy and current refresh. Native keyring and secret-store tests.                                                                  |
| A2 — P1 | The initial validated epoch follows a send through media and final dispatch. Media uses the captured app credentials; each uploader is checked before/after I/O, so replacement during tenant-token acquisition starts no upload and replacement during the first upload starts no second upload or message.                               | Actual adapter/upload/serializer co-tests; independent native-port probes cover image/file, token resolution, 401 retry and serialization boundaries.                                                                                     |
| A3 — P1 | The default authenticated API harness captures its own epoch before asynchronous credential reads and rechecks user/tenant requests, pages and successful publication. Explicit caller epochs remain an additional origin check.                                                                                                           | Undefined/explicit epoch page revocation tests; independent user/tenant credential/page matrices and valid two-page controls.                                                                                                             |
| H1 — P2 | Auth-shaped historical result-wrapper receipts are encrypted without assigning command ownership. Canonical command+args hash proof permits exact ordinary callback replay; typed auth discards old ciphertext and consults current credentials. The envelope DEK lives in the existing encrypted secret map and survives master rotation. | File-backed upgrade/rollback/old-schema/reopen, exact bytes and callback metadata, hash/command conflicts, row substitution, corrupted/missing keys, canonical execute→replay→operation lookup and cross-process rotation.                |
| H2 — P2 | Existing 24-hour terminal retention includes hash-only semantic rows and encrypted receipts. Normal semantic traffic runs the sweep; active generic operations remain retained.                                                                                                                                                            | 1000 expired semantic bindings, within-window conflicts, exact 24-hour boundary, encrypted receipt expiry and active generic controls.                                                                                                    |
| C1 — P2 | The fetcher rechecks cancellation after lazy import and immediately before CLI dispatch.                                                                                                                                                                                                                                                   | Co-test plus an independent genuinely delayed ESM import: 0 new CLI dispatch after cancellation.                                                                                                                                          |
| C2 — P2 | The shared helper has no extra async adoption layer; public API/raw fetch and staging recheck abort in their final continuation. Original reasons, including null, are retained.                                                                                                                                                           | Pending-public-Promise regressions, API/CLI/stage checks, 808 independent timing probes: all 144 pending cases rejected, all 664 settled controls retained. Already-dispatched rotating refresh may complete its conditional publication. |

### Independent review and reconciliation

Three new artifact-only reviewers independently covered authorization, receipts and cancellation. They received the incremental diff, source hashes and contract without author reports or ledger Decisions. The first review found two remaining actionable auth boundaries: legacy double deletion could erase provenance, and later media uploads could continue after replacement. The main session reproduced both with failing co-located tests, fixed them, and the reviewer reran independent probes on the revised production source with no remaining confirmed defect. A pre-existing null abort-reason mismatch was also reproduced and corrected. The user's earlier extra cross-model opt-out remains in force; no external model CLI ran.

The receipt reviewer found no confirmed remaining issue and independently exercised transaction failure, corrupt/missing keys, command/hash proof, exact replay, bounded retention and three separate persisted-envelope processes across offline master-key rotation. A supported older body-wrapper format bypasses this candidate migration, but investigation did not establish a historical typed-auth/callback writer reachable through that format; it remains conditional hardening and is excluded from confirmed defects.

Scoped preflight PII/wiring and test-gap audits found no incremental bypass, dormant helper or remaining missing behavior test. The test audit prompted direct token/epoch and post-success replacement regressions in auth-retry.test.ts. This does not certify the unchanged Twin embedding chain's explicit PII-gate implementation: its existing redactText call and absence of an explicit hasNoLeakingPii check are outside this incremental repair.

Independent evidence: [auth re-review](../../.cache/diagnostics/connector-seven-fixes-2026-10-28/diagnostics/seven-review-auth/round2-review.md), [receipt/encryption review](../../.cache/diagnostics/seven-review-receipts/review.md), [cancellation reconciliation](../../.cache/diagnostics/connector-seven-fixes-2026-10-28/diagnostics/seven-review-cancel/final-reconciliation.md). The auth review's first turn ended with a model-capacity error after producing two executed findings; a resumed review completed and reconciled both. Review production hashes match the revised artifact; subsequent changes added tests/documentation only.

### Verification

The failing checks were recorded before each behavioral correction, including fresh-review failures. Commands ran from the repository root using the repository Jest entry point, no coverage. Evidence directory: [connector-seven-fixes-2026-10-28](../../.cache/diagnostics/connector-seven-fixes-2026-10-28/).

- Root Jest focused on Lark, document providers including Google, raw Twin/stage, abort helper and remote picker hook: **74 suites / 1364 tests passed** (ts-final-verified.log).
- Native tests: **347 connector**, **111 secret-store**, **101 SecurityStore**, **47 canonical execution**, **1 API error mapping**, and **10 Companion contract** tests passed. The canonical test exercises actual execute/hash/migration/replay/query, with a synthetic runtime rather than a plugin/provider process.
- Root pnpm lint and final scoped ESLint/Prettier passed. Scoped cargo clippy for cognia-secrets, cognia-connectors and cognia-companion-security, including tests, passed with -D warnings. Companion Clippy completed with pre-existing warnings; it is not a warnings-free result.
- Root pnpm typecheck failed with **11 diagnostics outside this task**: context-workbench.test.tsx (3), use-claude-chat.test.ts (4), Discord avatar source/tests (4). The chained sidecar typecheck did not run after the root failure.
- pnpm lint:static-export failed with **14 pre-existing imports** in agent-codebuff/agent-crush. No production Node import was added by this task.
- Full cognia-companion-security suite: **260 passed / 3 failed**. The three JWT source-audit tests expect 7 service checks in untouched host_surface_gate.rs and find 8. All 101 SecurityStore tests passed. These external source-count failures were preserved.
- No production export, full Tauri suite/native WebView interaction, live OAuth/Feishu/Google document ACL test, real plugin process or private account/database operation ran. Local/native synthetic evidence is not deployed-provider acceptance.

### Data and runtime limits

Historical receipts have no recoverable command/args, only their hash. Therefore operation GET hides an unproven encrypted receipt until the original matching canonical retry attests ownership. If an earlier destructive migration already deleted the bytes, this change cannot reconstruct them: generic retry returns terminal, non-retryable 410 receipt_unavailable instead of an endless pending response or blind side-effect execution. Existing 24-hour retry retention still applies.

Encryption protects current logical records; it does not certify forensic erasure of old SQLite pages/WAL/backups. Pre-existing generic HTTP OAuth response receipts remain separate scope. The host must have its existing secret store available for encrypted migration; key unavailability fails closed without marking a failed migration complete. Already-dispatched native I/O can finish; cancellation prevents later caller publication and new guarded work, not physical rollback of an accepted provider request. Cross-process credential ownership races and live-provider behavior remain unverified boundaries.

The continuing [evidence ledger](../evidence/2026-10-21-feishu-document-support-audit.md) records G14/V52–V60, local outcome and the unresolved repository/native/provider acceptance requirements.
