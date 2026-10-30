# Adversarial review of the six cloud-document repairs

Latest follow-up: [G14 connector repairs and independent re-review](2026-10-28-connector-repair-independent-review.md#g14-repair-and-independent-re-review-2026-10-28) locally repairs the subsequent 3 P1 / 4 P2 findings, including fresh-review corrections. Repository-wide, native UI and real-provider acceptance remain limited as recorded there. Earlier review and repair snapshots below remain historical.

Date: 2026-10-28, Asia/Shanghai. Request: “做一次对抗性审查”. This is a new review of the current uncommitted repair, after the earlier automatic review and its corrections. It records counterexamples separately so the earlier audit and test history remain attributable. Product source was not edited.

Three fresh-context reviewers independently examined authentication/storage, readers/cancellation, and UI/IPC/RPC wiring. They received artifact paths and behavioral contracts without the author's report, ledger decisions or previous review conclusions. The main session checked every finding against source and executable probes. The user's earlier extra cross-model opt-out was retained; no external model CLI ran.

The findings below describe the reviewed snapshot before the subsequent authorized repair. See the repair follow-up at the end for current implementation and validation status.

## Verdict

Four defect groups remain: **two P1, two P2**. The prior local completion claim is reopened. There is also one conditional Wiki input/type finding that needs provider evidence; it is not counted among the four confirmed groups. Existing passing tests do not cover these counterexamples.

## R1 — P1: refresh can recreate a revoked access identity

Locations: [native guard](../../crates/cognia-connectors/src/keyring.rs#L303), [refresh capture](../../lib/connectors/adapters/lark/auth.ts#L420), [existing retry wrapper](../../lib/connectors/adapters/lark/auth-retry.ts#L156).

The native refresh guard requires configured app credentials, a matching epoch and matching refresh revision, but never requires a currently connected access identity. `refreshUserToken` also accepts a snapshot with no access token as long as refresh credentials remain.

Concrete sequence:

1. A user-authenticated request is dispatched.
2. `user_token` is deleted; `user_refresh_token` is still present, including the interval between separate credential deletes.
3. The old request reports 401. Its retry captures the **post-delete** bot/revoked epoch rather than the original request's epoch.
4. The remaining refresh token obtains a new access token. Conditional native publication accepts the post-delete epoch and restores the access identity.

A refresh already captured before deletion is correctly rejected. That existing test does not exercise a refresh starting after deletion. Source inspection confirms the native acceptance predicate. A probe executing production `auth.ts` with synthetic HTTP and a native-port substitute matching that predicate reproduced one refresh request and `restoredAccess: true`. The probe did not execute the Rust owner or actual IPC; native acceptance here is source-confirmed, not a claimed native reproduction.

Repair direction: retain the originating request's authorization binding through retry and reject native Refresh when no user access identity remains. Add a native regression for delete-access → capture revoked state → Refresh, plus an end-to-end old-401 interleaving. Reuse the existing keyring transition.

Classification: **valid + actionable**, unresolved. This contradicts the current scope of V32.

## R2 — P1: internal auth RPC persists and replays raw tokens

Location: [new auth command's required idempotency](../../protocol/companion-commands.json#L29782).

The command returns `accessToken` and `refreshToken` for snapshot/authorize/refresh. Its default receipt policy is `Replay`, since [the HostSemantic policy](../../crates/cognia-companion-contract/src/command_manifest.rs#L141) only recognizes a different resource. The headless connector invoker routes through the actual companion RPC path.

The source-backed path is:

1. [Headless invoker](../../lib/headless/runtimes/connector-runtime.ts#L202) → `transport.call` → internal RPC with an idempotency key.
2. [Remote execution](../../crates/cognia-companion/src/remote_execution.rs#L587) packages the complete result into a success receipt.
3. [SecurityStore](../../crates/cognia-companion-security/src/security_store.rs#L2048) writes its JSON unchanged into `idempotency_records.receipt_json TEXT`. [Database opening](../../crates/cognia-companion-security/src/security_store.rs#L494) uses ordinary SQLite; this is outside the encrypted connector secret store.
4. [A completed-key retry](../../crates/cognia-companion/src/remote_execution.rs#L554) returns the saved result without entering the current Lark authorization owner. Rotation/deletion therefore does not prevent replay of old token/epoch data.

This affects the headless/internal RPC path; direct desktop Tauri invocation does not use this receipt layer. Generic RPC authentication still runs. The missing check is the current Lark credential state, and the persistence issue is raw credentials copied to the generic receipt store. No real secrets or database were read/written during this review. The result follows from the current execution/storage source, not a live-server probe. Existing HTTP commands have related receipt exposure; this review identifies the new auth command's additional path rather than claiming it is the first such path.

Repair direction: extend the existing host-semantic/no-secret receipt policy for this credential owner. Snapshot must always read current state; token-bearing results must not enter generic receipts. Test actual canonical internal execution, inspect persisted receipts, and retry the same key after revoke/rotation. Preserve required retry-key binding without adding a second credential store.

Classification: **valid + actionable**, unresolved. This introduces a verification obligation at the RPC/storage boundary that the prior internal-only schema test did not cover.

## R3 — P2: refresh-token ABA restores the old authorization lineage

Locations: [one-sided dependency](../../crates/cognia-connectors/src/keyring.rs#L152), [value-only metadata admission](../../crates/cognia-connectors/src/keyring.rs#L184).

`USER_EPOCH` is invalidated by direct writes/deletes of `user_token`, but not `user_refresh_token`. Once valid lineage metadata exists, delete the refresh credential and then restore the same value. The metadata remains stored. After restoration both value fingerprints match again, so the original epoch, account label and scopes are admitted again despite a new refresh revision. Old document bindings, and an unexpired pending OAuth record carrying that epoch, can become valid again.

This is a source-confirmed transition through the actual dependency/snapshot rules. No new native execution was run. The existing direct-credential ABA test changes only `user_token`, so its passing result does not cover this branch.

Repair direction: include direct refresh-credential writes/deletes in the existing lineage invalidation dependencies. Atomic legitimate refresh must continue to republish the same lineage in its transaction. Extend the native ABA regression to delete/same-value restore the refresh credential and assert that the old epoch never returns.

Classification: **valid + actionable**, unresolved. This also reopens V32.

## R4 — P2: asynchronous checks leave cancellation gaps

Locations: [HTTP dispatch](../../lib/connectors/adapters/lark/authed-api.ts#L161), [retry handoff](../../lib/connectors/adapters/lark/authed-api.ts#L214), [provider snapshot](../../lib/docs-providers/providers/lark/index.ts#L45), [final publication](../../lib/docs-providers/providers/lark/index.ts#L185).

Checking the signal inside an async helper does not make its caller's continuation atomic. A queued abort can run after the helper's last check and before the caller dispatches or returns. The retry helper can likewise start refresh after the authenticated call has failed and the outer abort wrapper has already released its caller.

Four executed synthetic interleavings produced these observations:

| Boundary                                      | Actual observation                                                 | Required behavior                      |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Dispatch after an authorization snapshot      | HTTP port called with `signal.aborted === true`                    | Reject before calling the port         |
| 401 after a post-response authorization check | One `refreshUserToken` call after abort                            | No new refresh                         |
| Final provider authorization check            | `fetch` resolves document text while the signal is already aborted | Reject instead of publishing content   |
| Initial provider snapshot still pending       | Caller remains unsettled until the native-port promise completes   | Caller cancellation releases this wait |

The probes execute the production provider, fetcher, authenticated harness and abort helper. DB/keyring snapshots, token helpers, HTTP/native ports and events are synthetic. They prove calls/publication at those boundaries, not actual network packets or a committed chat attachment. Existing staging/session guards were not demonstrated bypassed. Already-dispatched native I/O lacking physical cancellation remains the separately documented limitation; these counterexamples include work beginning after abort and publication after abort.

Repair direction: synchronously recheck the signal in the continuation that dispatches, refreshes or publishes, and wrap the provider's preflight snapshot wait with the existing caller-abort helper. Add these microtask-order regressions beside the current harness/provider tests.

Classification: **valid + actionable**, unresolved. This reopens V34.

## W1 — Conditional: Wiki resource type can be replaced by token-prefix inference

Locations: [resolved body reference](../../lib/docs-providers/providers/lark/index.ts#L173), [parser precedence](../../lib/twin/ingest/lark-url.ts#L87).

Synthetic Wiki metadata `{obj_type: "doc", obj_token: "doxcnAbCdEfGh1234567890"}` is sent to the docx endpoint even though an explicit `kind: "doc"` was passed. The parser accepts the recognizable prefix before applying the supplied type. The parameterized production test uses this same combination but its generic `raw_content` stub does not assert the endpoint, so it hides the mismatch.

The probe confirms routing behavior for that input; this review did not establish that a real Feishu response can contain such a prefix/type combination. Classification: **contract/input assumption requiring verification**, not a confirmed production P2. If `obj_type` is authoritative for opaque tokens, carry it through without re-inferring the type; otherwise document and test the provider's prefix/type invariant. A real Wiki fixture or primary API guarantee is needed to decide that boundary.

## Evidence and limits

- Reviewer's existing regression run: 3 suites / 114 tests passed; the closed Lark/bounded-HTTP schema test also passed. Existing React `act` warnings remain.
- Main-session root Jest entry point with an isolated review config: **5 additional behavioral assertions failed**. Four exercise R4; one exercises conditional W1. These are diagnostic probes under `.cache`, not new production tests or a full-suite failure claim.
- Production `auth.ts` probe: one synthetic refresh, access identity restored after deletion. Native port behavior is substituted as described under R1.
- Receipt and refresh-ABA findings were checked against actual owning source. No actual secret store, provider account, private document, remote write, native launch or heavy build was used. Earlier Tauri/production acceptance remains open.
- No product fixes were made in this review. The report and evidence ledger reopen the affected repair claims for a subsequent fix.

Local artifacts: [reader probes](../../.cache/diagnostics/cloud-documents-review-2026-10-28/readers/readers-adversarial.test.ts), [isolated Jest config](../../.cache/diagnostics/cloud-documents-review-2026-10-28/readers/jest.config.cjs), [actual failed assertions](../../.cache/diagnostics/cloud-documents-review-2026-10-28/readers-run.log), [refresh probe](../../.cache/diagnostics/cloud-documents-review-2026-10-28/auth/revoked-refresh-probe.cjs), [refresh result](../../.cache/diagnostics/cloud-documents-review-2026-10-28/auth-run.log).

## Authorized four-defect repair follow-up (2026-10-28)

R1-R4 now have local implementation and behavioral regressions in their existing owners. The earlier findings and reproduction evidence above remain historical; they are not current unresolved verdicts.

| Finding | Existing-owner repair                                                                                                                                                                                                                                                                                                                                                                                                                     | Regression evidence                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1, P1  | Native Refresh requires a connected access identity. The retry wrapper captures the original epoch before the request, rechecks that epoch after refresh, and passes the atomically captured token to every existing callback instead of rereading a replacement account.                                                                                                                                                                 | Native revoked-access test, delayed old 401 after revoke/account change, commit-to-retry replacement and snapshot-to-callback replacement.                                                                                                |
| R2, P1  | The auth resource uses existing HostSemantic execution: hash binding remains, credential DTOs never become generic receipts, and same-key snapshots re-enter current authority. A transactional upgrade retires identifiable old auth DTO receipts before other migration backups. Matching canonical hashes lazily convert old failed/running requests; old runs become terminal and late generic completion cannot write receipts back. | Actual canonical execute with a synthetic Runtime and file-backed SQLite inspection: current-state retries, NULL receipts, no new runs, hash conflicts and failed/running retries. Store tests preserve unrelated and malformed receipts. |
| R3, P2  | Existing dependency groups register both user credentials, including absent members before first publication. Metadata carries an internal version marker; markerless data cannot prove absence of prior same-value mutation and no longer admits its old lineage, label or scopes. Normal current-format refresh preserves metadata and lineage.                                                                                         | Same-value refresh-token writes and delete/recreate, each under current and emulated pre-repair indexes; old pending OAuth rejected; positive label/scope/epoch preservation.                                                             |
| R4, P2  | Existing abort helper releases the initial native snapshot wait. Synchronous guards sit in the continuations that dispatch, refresh, retry or return fetch/search content. An already-dispatched token rotation still conditionally publishes its pair.                                                                                                                                                                                   | The four original microtask-order counterexamples plus search publication, real multi-section readers and cancellation during refresh.                                                                                                    |

Old markerless authorization metadata fails closed: tokens remain in their existing keyring accounts, while old bindings/pending authorization and projected label/scopes are invalidated. Reauthorization restores the search-scope projection. This is a deliberate upgrade boundary; unchanged current-format refresh retains its lineage and projection.

Current deterministic evidence:

- Root Jest: **73 suites / 1,310 tests passed**, including related Lark, Google document-provider, Twin and staging-hook tests.
- Native: **345 connector tests**, **98 SecurityStore tests**, **47 canonical remote-execution tests**, and **10 contract tests passed**. Synthetic secrets/provider ports only.
- Root lint, scoped ESLint, i18n lint, scoped Prettier and diff checks passed. Clippy passed for connectors/security/contract libraries with `-D warnings`. No coverage command ran. The broader security-crate run had 256 passed / 3 failed: unchanged JWT service-trust source-count assertions; its scoped SecurityStore suite is green.
- Root typecheck still fails with **14 diagnostics outside this repair's paths**; chained sidecar checks were not reached. Companion generated-artifact check reports drift in seven existing shared-tree artifacts; this four-defect follow-up changes no protocol catalog or IPC signature and does not regenerate unrelated contracts. Full production export, packaged/native UI and real provider OAuth/document ACLs remain unverified, with prior native-launch limits retained in the evidence ledger.

The requested automatic fresh-context adversarial round found two further actionable boundaries (commit-to-retry identity replacement and legacy failed/running receipt retries), and a follow-up found the old-index first-snapshot ABA case. All were reproduced or source-confirmed, repaired and regressed. Test-gap review added direct same-value refresh-token coverage. PII/wiring rechecks found no new issue. The final bounded native reconciliation found no remaining actionable issue and is recorded in the evidence ledger; no external model CLI ran, retaining the user's prior opt-out.

Scope limits: the typed Lark auth command is fixed; pre-existing generic HTTP OAuth-response receipt handling is a separate owner/risk. Clearing active receipt rows is not forensic erasure of old SQLite pages, WAL files or backups. Physical cancellation of already-dispatched native HTTP and independent old Host processes remain outside this guarantee. Conditional W1 remains unverified by a real provider fixture and was not added to this repair scope.

Artifacts: [task scope](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/task-paths.json), [incremental patch](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/incremental.patch), [final Jest](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/final-ts.log), [connector tests](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/connectors-final.log), [security tests](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/security-final.log), [canonical tests](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/canonical-reviewed.log), [typecheck](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/typecheck-reviewed.log).

Final review record: [reconciled findings, independent checks and limits](../../.cache/diagnostics/cloud-documents-four-review-fixes-2026-10-28/review-reconciliation.md).
