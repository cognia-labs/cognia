# Evidence ledger: ADR-0243 phase 2B-2 paired owner and member devices

- Status: verifying
- Lane: deep
- Created: 2026-11-13
- Updated: 2026-11-13
- Related: ADR-0243; baseline f41a1057d2

## Original request

Implement phase 2B-2: a paired member can send, but its turns have no personal reader and no personal credentials. Preserve owner behavior, project every paired history read, prevent placeholder write-back, and enforce the Host history/resume decision.

## Knowledge

| ID  | Statement                                                                                                                   | State    | Basis                                                                                                                       | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | The five read arms previously dropped caller identity and the paired helper always used owner readers.                      | Verified | Read `rpc/data_sync.rs`, `personal-visibility.ts`, desktop message/sync sources, 2026-11-13.                                | -          |
| O2  | Both HTTP and canonical RPC entry points pass a verified tenant; no production tenant-less owner case was found.            | Verified | `crates/cognia-companion-rpc/src/rpc.rs`, `dispatch_canonical` and HTTP dispatch; independent read-only review, 2026-11-13. | -          |
| O3  | SecurityStore owner lookup requires matching tenant/device, role owner and status active.                                   | Verified | `crates/cognia-companion-security/src/security_store.rs::is_owner_device`, 2026-11-13.                                      | -          |
| O4  | Direct is the headless SQLite degraded store; canonical TS filtering is unavailable there.                                  | Verified | `DataPlane::pick` and module contract, 2026-11-13.                                                                          | -          |
| O5  | Work submission without LOCAL_PERSON_RUN records external-event; personal credential admission refuses that lane.           | Verified | `work-submission/service.ts`, `personal-credential.ts`, Lark `auth.ts::getUserAccessToken`, 2026-11-13.                     | -          |
| O6  | Desktop transcript preparation accepts an exact run id and rebuilds native/AI SDK history from filtered canonical messages. | Verified | `hooks/chat/claude-chat-send-options.ts::prepareTranscriptRuntimeSend`, 2026-11-13.                                         | -          |
| C1  | No dependencies, Dexie schema, git-state mutation, network, or out-of-scope file changes.                                   | Observed | Binding task constraints, 2026-11-13.                                                                                       | -          |
| C2  | Native compilation/tests cannot run here; they belong to the external verifier.                                             | Observed | Binding brief Verify section, 2026-11-13.                                                                                   | -          |
| G1  | Member reads and turns never receive owner-private canonical content or personal credentials.                               | Agreed   | Binding user decision, 2026-11-13.                                                                                          | -          |

## Problem frame

The authenticated device boundary must decide the audience before data or a turn leaves the Host (O1, O3, G1). Filtering must cover body and derived fields, and placeholders must not become canonical content. Opaque retained engines need the same audience check as stored rows. Existing person partitions remain isolated under their trusted runtime profile. This change makes no claim about live device/provider acceptance (C2).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                  |
| ------------ | ------ | -------------------------------------------------------------------------------------------- |
| scale        | high   | Rust RPC/transport, TS readers/writers, turn admission, guards and bilingual ADR.            |
| technical    | medium | Existing portable filter and desktop rebuild path are reused.                                |
| coupling     | high   | Both desktop and headless bridges, degraded store, SDK identity, isolated person partitions. |
| requirement  | low    | The member reader/credential decision is explicit.                                           |
| verification | high   | Local JS checks are available; native compilation and live devices are external.             |
| risk         | high   | A wrong audience leaks private content; placeholder write-back destroys canonical content.   |

## Risks

| ID  | Risk (impact)                                              | Severity | Source                    | Claim                                                                                 | Refuted by                                                                 |
| --- | ---------------------------------------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R1  | Client role or failed owner lookup grants private history. | high     | ADR-0243; boundary review | Only a positive active-owner lookup grants Owner; all five reads carry Host identity. | Member sees a marked body/title/preview/seed or a spoofed role reaches TS. |
| R2  | A projected row replaces canonical content.                | high     | Brief write-back ruling   | Hidden member mutations and all placeholder updates refuse before writing.            | Canonical body changes after a refused update/delete/edit/truncate.        |
| R3  | An owner engine or credential is reused by a member turn.  | high     | ADR engine-memory rule    | Member runs are readerless external-event; Host prepares history and controls resume. | Private context or a Lark user token reaches the member run.               |
| R4  | Shared source filtering breaks isolated person partitions. | high     | Independent review        | Trusted runtime profile preserves the existing partition read policy.                 | A marked row in the caller's own partition becomes a placeholder.          |

## Verification obligations

| ID  | Risk           | Method                                             | Independence | Evidence                                                                                                                                                                    | Coverage                                                                          | Status  |
| --- | -------------- | -------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3, R4 | Focused Jest via the brief runner, no cache.       | tool         | Final required run: exit 1; 717/718 tests, 21/22 suites. Only the untouched egress primitive inventory fails. Last focused admission/visibility rerun: exit 0, 28/28 tests. | All changed TS co-tests, personal guards, IPC, paired turns, partition and media. | failed  |
| V2  | R1, R2, R3     | TypeScript, ESLint, formatting and diff checks.    | tool         | Frozen-source tsc: exit 2, 23 diagnostics in unchanged files, zero in changed files. ESLint, prettier and diff checks recorded below.                                       | Changed files have no TypeScript diagnostics; root baseline remains.              | failed  |
| V3  | R1, R2, R3     | Native in-file tests, external cargo check/test.   | tool         | In-file cases added; cargo intentionally not run under C2.                                                                                                                  | Positive/negative owner lookup, payload stamping and real data-plane arms.        | blocked |
| V4  | R1, R3, R4     | Real desktop/headless paired-device/provider flow. | real-env     | Not run in this restricted worktree.                                                                                                                                        | Native transport, provider retention and real Lark token boundary.                | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                             | Action    | Based on   | Reversal trigger                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- | --------------------------------------------------------------- |
| D1  | 2026-11-13 | Stamp role at transport emission because bus request structs live outside the allowed crates. No bus edits or public schema changes. | implement | O1, O3, C1 | A bridge emits without the decorator.                           |
| D2  | 2026-11-13 | Refuse Member on Direct with typed personal_visibility_unavailable; preserve Owner.                                                  | implement | O4, G1     | Direct gains the canonical filter.                              |
| D3  | 2026-11-13 | Reuse desktop builtin history reconstruction; refuse changed private external-route reuse with personal_visibility_changed.          | implement | O5, O6, G1 | Paired sidecar gains external-manager reconstruction authority. |
| D4  | 2026-11-13 | Refuse legacy member HostState engine actions that mint local authority; keep member agent_send admission readerless.                | harden    | O5, G1     | HostState carries per-action readerless run admission.          |

## Residual risks

| ID  | Residual                                                                                                                                                             | From | Why still open                                                                                                                                                                                                                                                                                                             | Next action                                                                                            | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Native code has not been compiled or executed in this sandbox.                                                                                                       | V3   | Compiled and run outside the sandbox: `cargo check --tests` passes for cognia-companion and cognia-companion-rpc; cognia-companion data_plane, paired_turn, rpc_error, session_media and signaling::dispatch tests pass (53); cognia-companion-rpc data_sync and chat pass except one test that also fails on dev (below). | None for 2B-2.                                                                                         | closed |
| X2  | Real paired-device/provider acceptance remains unmeasured.                                                                                                           | V4   | Local JS fixtures cannot establish native or provider behavior.                                                                                                                                                                                                                                                            | Drive owner/member turns and Lark refusal on a real Host.                                              | open   |
| X3  | Member reads fail closed while only degraded SQLite is available.                                                                                                    | R1   | That store cannot apply canonical mark filtering.                                                                                                                                                                                                                                                                          | Retry after the brain reconnects, or implement canonical filtering there.                              | open   |
| X4  | Changed private external routes refuse rather than reconstruct.                                                                                                      | R3   | The paired sidecar does not own the external manager.                                                                                                                                                                                                                                                                      | Rebuild through the external manager's Host-owned route.                                               | open   |
| X5  | Members use agent_send rather than legacy HostState local-authority engine actions.                                                                                  | R3   | Those dispatchers still mint owner admission.                                                                                                                                                                                                                                                                              | Add a distinct readerless HostState execution lane before enabling them.                               | open   |
| X6  | Conversation media is conservatively refused when any row is withheld; member binary HTTP/RTC also refuses in multi-tenant mode without a selected person partition. | R1   | The legacy hash reference lacks row visibility and binary routes do not own person-fleet routing.                                                                                                                                                                                                                          | Add canonical per-row visibility and authenticated partition binary routing before enabling that flow. | open   |
| X7  | Required egress inventory still reports three untouched artifact sites.                                                                                              | V1   | The scripts resolved TypeScript 7 from docs/node_modules and scanned gitignored build output and plugin virtualenvs. Fixed on dev in 44744dc2a6; the egress guard passes on this change.                                                                                                                                   | None.                                                                                                  | closed |
| X8  | Root type checking still reports 23 diagnostics in unchanged files.                                                                                                  | V2   | Root tsc diagnostics are identical to a clone of the baseline (23 / 23, all in untouched files).                                                                                                                                                                                                                           | None.                                                                                                  | closed |

## Outcome

| ID  | Signal                                                                                           | How / when measured                                 | Result                                                                | Status  |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| M1  | A real member can send while owner-private history and personal credentials remain inaccessible. | Paired-device acceptance after native verification. | Local verification recorded below; real environment remains external. | pending |

## Implementation and verification record

- No new production module was needed. The new ledger is explicitly required by the brief; existing ADRs, sources and co-tests were extended.
- The five read arms are sync_pull, session_list, message_get_by_session, session_timeline and session_turn_messages. Transport stamping also covers message update/delete/media. Internal paired_turn_admit now returns Host-prepared options, transiently; credentials are never stored in execution bundles.
- Reviewed write surfaces: message update/delete; HostState transcript edit/truncate and session deletion. HostState session import refuses an already existing session and uses bulkAdd (never overwrites colliding message ids); connector_send generates a new message id. No additional existing-row write arm was found in desktop-write-source.
- The first Jest attempt passed its selected assertions but exited with EPERM on the shared timing manifest. Later commands set JEST_TIMING_OUTPUT to a writable temporary file. Docs subprocesses resolve a native-only TypeScript package; a temporary Node preload selects the already-installed root compiler API. No dependency files changed.
- Initial core run: 198/201 tests passed; three legacy owner fixtures were updated to name Owner explicitly. A later run passed 709/710 tests; the remaining egress inventory failure names only three pre-existing generated/virtualenv artifacts outside the touched source set. Final results follow after all required checks.

### Final verification record

Implementation started at 2026-11-13T13:46:06+08:00. The last source/test change was at 2026-11-13T14:26:05+08:00, before the forty-minute cutoff; subsequent edits only record verification here.

- Required Jest command: JEST_ROOT="$PWD" JEST_NO_CACHE=1 JEST_TIMING_OUTPUT="$WRITABLE_TIMING_FILE" NODE_OPTIONS="--import=$ROOT_TYPESCRIPT_PRELOAD" NODE_ENV=test NODE_PATH="$SHARED_NODE_MODULES" SWC_NATIVE_BINDING_CACHE="$SWC_CACHE" node "$BRIEF_JEST_RUNNER" "$ABSOLUTE_TEST_PATH_LIST" run. Final exit 1: 21/22 suites, 717/718 tests. The only failure is personal-egress-guard G6. All changed co-tests and the personal visibility/credential guards pass. The focused final two-suite rerun passed 28/28 tests, exit 0; trusted partition rerun passed 5/5, exit 0.
- G6 unclassified sites (untouched, not silently accepted): packages/agent-host-darwin-arm64/bin/sidecar/pi-extension/cognia-pi-extension.ts; plugins/cognia-laya-guard/.venv/lib/python3.12/site-packages/torch/utils/model_dump/code.js; plugins/repowiki/.venv/lib/python3.12/site-packages/urllib3/contrib/emscripten/emscripten_fetch_worker.js. They are not added to the classification manifest by this change.
- Root native compiler command: node_modules/@typescript/typescript-darwin-arm64/lib/tsc --noEmit -p tsconfig.json --incremental false. Final exit 2: 23 diagnostics, all outside changed files. Two intermediate dynamic fake-indexeddb test import diagnostics were corrected using the existing side-effect import pattern, and the final run has zero changed-file diagnostics.
- Without-fix proof: the temporary harness changed the paired helper to owner policy, ran only the three new reader tests, and restored in a finally block. Child Jest exited 1 with all three tests failing. The harness exited 0 after immediately comparing source SHA-256: 3a2889dc5c744aa5dbdfe5befcea8644d70c2876d6606d8e07a03153e0afefc7. The mutation is absent from the final source.
- Native source review covered the actual bus responder tests, SecurityStore fixtures, options roundtrip, HTTP DeviceContext and RTC role binding. rustfmt --edition 2021 ran successfully on each changed Rust file. Existing unrelated formatting in the RTC dispatcher was preserved. Rust compilation/test execution remains V3, not implied by formatting or review.
- Public request/response schemas and generated command indexes are unchanged: all added role/prepared-options fields are internal. No public shape, dependency, schema, translation or UI changes were introduced.

- Frozen-source ESLint: node node_modules/eslint/bin/eslint.js --max-warnings 0 over every changed TypeScript source/co-test, exit 0. Prettier --check over those files and this ledger, exit 0. git diff --check, exit 0. The required ledger.mjs check, exit 0. No source/test changes followed the cutoff.

## Claude verification at commit time

- Review of role derivation (owner only on positive `is_owner_device` proof, Host-stamped after serialization, client value removed), the five reads plus media, the write-back rule (members cannot change rows withheld for them; nobody can write the placeholder) and paired-turn admission (no local-person proof for members, client history and digest fields stripped, desktop transcript-runtime preparation, external route refusal): no defects.
- 177-suite focused list (every changed file's tests, all personal suites and guards, the phase 2C-2/2D list): 176 passed first; the egress guard passed after the tooling fix in 44744dc2a6.
- Rust: as in X1. `rpc::data_sync::p5_tests::p5d_dispatch_binds_partition_manifest_and_attach_without_changing_legacy` fails deterministically on this change and on dev: the test installs no security store, and since ADR-0253 WP6 the caller-grant injector leaves `callerDeviceGrants` out when no store is readable, while the test expects `[]`. This change touches neither the test body nor the injector. It belongs to the multi-user work.
- rustfmt: changed Rust files are formatted; `signaling/dispatch.rs` keeps its pre-existing unformatted lines (identical rustfmt complaints before and after). ESLint with zero warnings and prettier on every changed TypeScript and docs file.

## Follow-up fix (2026-11-13)

- The full cognia-companion-rpc suite, which this phase's scoped run had not covered, failed two headless dispatch tests: the loopback `service` scope was classified Member, so a headless Host refused its own CLI's `session_list` and returned a personal-visibility conflict instead of `HOST_UNAVAILABLE` for degraded writes. `PairedReader::for_caller` now treats the exact `service` scope as Owner, the trust rule the capability checks already use; `person-brain`, `device` and a missing scope still need owner-device proof. Pinned by `only_the_exact_service_scope_reads_as_owner_without_device_proof`.
- `server::tests::challenge_fails_closed_without_security_store_after_spawn` assumed no store was installed without holding the store test lock, so it raced the store-installing role test. It now holds `security_store::test_guard()` and clears the store.
- The p5d test now installs an in-memory store, so the Host-derived empty grant set is asserted again.
- After the fix: cognia-companion-rpc library 509/509; cognia-companion library 914/914 three times in a row, excluding the `backup::` tests, which need a JavaScript install the fresh worktree lacks.
