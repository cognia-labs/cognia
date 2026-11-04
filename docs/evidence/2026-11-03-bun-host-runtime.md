# Evidence ledger: opt-in Bun for brain and sidecar

- Status: verifying
- Lane: standard
- Created: 2026-11-03
- Updated: 2026-11-04
- Related: ADR-0059, ADR-0196, ADR-0250; `.cache/bun-host-runtime/`

## Original request

> 按这个方案改，先让 brain 和 sidecar 支持 Bun，保留 Node 回退，做好测试和启动速度、内存占用的对比。

> Follow-up: investigate and optimize Bun brain memory and sidecar startup, retain Node default/fallback, then repeat the same comparison.

## Knowledge

| ID  | Statement                                                                                                           | State       | Basis                                                                                                                                              | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Opt-in Bun for brain and sidecar, Node fallback, behavioral tests and startup/RSS comparison.                       | Agreed      | User request, 2026-11-03                                                                                                                           | -          |
| C1  | Preserve verified Node selection and Node-only bridges; never replay admitted work during fallback.                 | Verified    | Owning Rust source, native-bridges.ts and independent failure review, 2026-11-03                                                                   | -          |
| O1  | CLI releases already compile with Bun; Rust supervisors previously selected Node only.                              | Observed    | build-cli-bun.mjs and both supervisors, 2026-11-03                                                                                                 | -          |
| O2  | Native Bun fetch did not honor custom CIDR bypass in a local proxy repro.                                           | Verified    | Failing Node-driven Bun subprocess test, Bun 1.4.0/macOS arm64, 2026-11-03                                                                         | -          |
| O3  | Node brain startup currently fails on window.addEventListener in persisted plugin state.                            | Verified    | Actual benchmark CLI; stack points at stores/persist-storage.ts installLifecycleFlush, 2026-11-03                                                  | -          |
| H1  | Bun improves both startup time and idle RSS on this workload.                                                       | Invalidated | Five samples per role/runtime: brain trades faster startup for more RSS; sidecar trades less RSS for slower startup, 2026-11-03                    | O1         |
| H2  | Bun saves memory while module/library costs make startup slower.                                                    | Contested   | Applies to the sidecar in this experiment, not the brain; no universal speedup or memory saving is established.                                    | O1         |
| G2  | Improve Bun sidecar startup and investigate brain memory while retaining Node default/fallback.                     | Agreed      | User follow-up, 2026-11-03.                                                                                                                        | G1         |
| O4  | Bun auto-loaded two checkout dotenv keys in a value-free probe; Node did not.                                       | Verified    | No values emitted; --no-env-file reduced loaded-key count to zero; actual-Bun Rust regression.                                                     | -          |
| H3  | Higher brain RSS alone establishes a higher macOS charged memory footprint.                                         | Invalidated | Native VM map and five final proc_pid_rusage samples: Bun footprint 256.5 MiB vs Node 533.5 MiB while Bun RSS remains higher.                      | -          |
| H4  | Unconfigured exporter module evaluation adds meaningful sidecar startup cost.                                       | Verified    | CPU profile; isolated no-exporter regressions; final median 1044.3 -> 704.0 ms with all engines still loaded before ready.                         | -          |
| G3  | Diagnose hotspots with visual CPU, startup and memory tools.                                                        | Agreed      | User authorized analysis, 2026-11-03.                                                                                                              | G2         |
| O5  | Bun 1.4 CPU duration weights can assign idle waits to JavaScript frames.                                            | Verified    | Local 200ms CPU plus 400ms timer reproduction: Bun maximum delta 402.496ms and zero idle samples; Node maximum delta 6.048ms and 327 idle samples. | -          |
| O6  | The empty-account brain fixture contributes a five-second event-subscription timeout.                               | Verified    | Four stdout/stderr traces show 5000.9-5002.9ms before gateway-telemetry failure; gateway-telemetry.ts awaits whenSubscribed(channels, 5000).       | -          |
| H5  | The webclone barrel eagerly loads parser/transform dependencies before tool use.                                    | Verified    | registry.ts -> webclone/index.ts -> run.ts -> dist/index.js -> assembler/html parser; isolated five-trial import ablation below.                   | -          |
| G4  | Optimize webclone imports without feature regression, retain Node default/fallback, and repeat the same comparison. | Agreed      | User request and telemetry-priority clarification, 2026-11-03.                                                                                     | G2, G3     |
| O7  | A completed worker pool leaves its overall deadline active and prevents natural runner exit.                        | Verified    | Real Node/Bun emitted snapshot success but parent timed out; worker-deadline subprocess regression failed before cleanup; real jobs now pass.      | -          |

| G5 | Optimize Undici loading, retain Node default/fallback and all network defenses; regress and remeasure startup, memory and first request. | Agreed | User follow-up, 2026-11-03. | G2, G3 |

## Problem frame

Implement G1 at the Rust process ownership boundaries. Node stays default. Opt in independently with COGNIA_BRAIN_RUNTIME=bun and COGNIA_SIDECAR_RUNTIME=bun; COGNIA_BUN_EXECUTABLE optionally supplies an absolute path. Failed Bun discovery or pre-ready boot switches that supervisor to Node until host restart. Once ready, existing crash recovery applies without replay across runtimes (C1). Browser/WebView execution, runtime installation, Node-only bridges and changing the release default are outside this migration.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                            |
| ------------ | ------ | -------------------------------------------------------------------------------------- |
| scale        | medium | Shared Rust selector, two supervisors, source-Bun compatibility and benchmark.         |
| technical    | medium | Existing Bun SQLite/PTY adapters; source process and proxy semantics need actual runs. |
| coupling     | medium | Process ownership, readiness, account authority, proxies and sandbox children.         |
| requirement  | low    | Explicit scope and fallback requirement.                                               |
| verification | high   | Actual processes available on macOS; cross-platform/package matrix is separate.        |
| risk         | medium | Duplicate work, orphan children, authority reuse and network-policy bypass.            |

## Risks

| ID  | Risk (impact)                                                                                             | Severity | Source                                                                            | Claim                                                                                                                                                                              | Refuted by                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Fallback replays work or stale readers clear the successor.                                               | high     | Independent runtime failure review                                                | Failed Bun is reaped before sidecar stdin/generation publication.                                                                                                                  | Duplicate admitted command or stale reader changing Node state.                                                                        |
| R2  | Brain fallback bypasses refusal or account authority fencing.                                             | high     | ADR-0059; independent review                                                      | Exit 78/refusal still parks; old authority is revoked before successor.                                                                                                            | Node after contract refusal or old generation remains authorized.                                                                      |
| R3  | Bun bypasses proxy policy or loses Request semantics.                                                     | high     | Local proxy repro O2; independent review                                          | Same proxy/IP/CIDR policy, Request bodies and cancellation, fail closed.                                                                                                           | Direct request despite failed proxy, wrong bypass or lost body.                                                                        |
| R4  | Source Bun receives V8 flags or loses child resource limits.                                              | high     | Independent review; run-code source                                               | Runtime-specific launch preserves environment allowlist and group RSS enforcement.                                                                                                 | Unsupported flag, broken IPC or uncapped tree.                                                                                         |
| R5  | Benchmark compares different data, endpoints or identities.                                               | medium   | Independent review; ATAM-style scenario                                           | Same JS build, isolated fresh homes, interleaving, actual ready and process/tree RSS.                                                                                              | Reused state, mislabeled fallback, warmup counted or missing process reported as zero.                                                 |
| R6  | Untested platforms or package builds fail.                                                                | medium   | Cognia risk catalog                                                               | Report exact local evidence and keep Node default.                                                                                                                                 | Claiming packaged/cross-platform acceptance from macOS unit tests.                                                                     |
| R7  | Async telemetry initialization races ready or shutdown, or escapes packaging.                             | high     | Independent egress/wiring/lifecycle review                                        | Enabled exporters and AI SDK registration complete before ready; queued init cannot publish after shutdown; literal imports remain bundled.                                        | Early ready, late SDK after shutdown, duplicate registration, or relocated bundle fails.                                               |
| R8  | RSS is mislabeled as charged footprint or an ineffective memory change is retained.                       | medium   | Native VM-map diagnosis and performance contract                                  | Preserve RSS, separately label root physical footprint, and remove candidates failing the RSS threshold.                                                                           | Claim of reduced RSS without passing median/MAD result, or missing process reported as zero.                                           |
| R9  | Profiler artifacts invent CPU hotspots, omit failed stages, or perturb benchmark results.                 | medium   | O5/O6 and a Node profile with one negative timestamp delta                        | Separate diagnostic mode; preserve raw profiles; flag missing idle/long gaps; retain stderr stages; disable duration attribution on out-of-order timestamps.                       | Ordinary benchmark gets profiling flags, a wait is reported as CPU work, or a failed runtime disappears from the timeline.             |
| R10 | Narrow imports or deadline cleanup change webclone validation, isolation, output or queued-work behavior. | medium   | G4, O7; independent review caught an initial rejection/sibling cleanup regression | Use identical canonical exports; leave tool/runner launch contracts intact; stop dequeuing on rejection before clearing deadline; validate actual jobs and both deadline branches. | Changed SSRF/path decision, lost snapshot/conversion output, incomplete job cleanup, or sibling starts queued work after pool failure. |

| R11 | Lazy network initialization changes validated targets, bypasses policy, or hides first-use/cleanup cost. | high | G5 and independent review | Freeze URL before await; preserve socket DNS and proxy gate; coordinate close/import; validate per-session replies and normal process exit; compare cold/warm requests and total latency. | Modified URL reaches fetch, late dispatch after close, direct proxy fallback, forced cleanup counted as success, or undisclosed first-use cost. |

## Verification obligations

| ID  | Risk | Method                                                                                                                                                 | Independence | Evidence                                                                                                                                                                                                                                    | Coverage                                                                                                                                                                            | Status  |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1   | Selection/probe tests, actual exit/hang fallback, shutdown and future-abort cleanup.                                                                   | tool         | optimization-rust-tests.log: core 61 and sidecar 121 passed with actual Bun enabled.                                                                                                                                                        | Prior runtime/fallback/cancellation cases plus explicit dotenv policy and Node flags unchanged.                                                                                     | passed  |
| V2  | R2   | Brain fallback/watchdog/refusal and admission evidence tests.                                                                                          | tool         | optimization-rust-tests.log: server 35 passed; prior companion admission 14 and accepted-generation 1 passed.                                                                                                                               | Refusal/admission fencing and shutdown-probe invariants retained.                                                                                                                   | passed  |
| V3  | R3   | Node drives actual Bun against local origin/proxy servers and guarded dispatchers.                                                                     | real-env     | network-final.log: 13 passed; final independent egress/PII review found no remaining actionable issue.                                                                                                                                      | Proxy/CIDR, Request POST/replacement bodies, AbortSignal, explicit dispatcher, guarded DNS with and without proxy, redaction and fail-closed behavior.                              | passed  |
| V4  | R4   | Runtime args/env/RSS tests and actual source-Bun code execution.                                                                                       | tool         | code-final.log: 7 passed, including real Bun program, tool IPC, wall-time and RSS enforcement.                                                                                                                                              | Process/IPC/resource behavior through an exec-wrapper fixture; not a new OS sandbox security acceptance.                                                                            | passed  |
| V5  | R5   | Harness tests and one warmup plus five interleaved trials per role/runtime.                                                                            | real-env     | optimization-benchmark-final-tests-3.log: 6 passed; optimization-final-verified/results.json: 20 successes, zero failures, same brain roster and stable sidecar source.                                                                     | Fresh empty accounts, warm filesystem cache, explicit environment, same Node/Bun identities and readiness boundaries.                                                               | passed  |
| V6  | R6   | Scoped lint/types, builds/tests, architecture/static-export gates and audits.                                                                          | tool         | Scoped lint/format, Clippy, 217 Rust tests, 24 sidecar tests, 27 Jest tests and static/architecture gates pass. Root typecheck still fails at unrelated tmp TSX; sidecar has two unrelated type errors; root lint has 11 existing warnings. | Local macOS actual-process/relocated-telemetry fixture; full product/package/platform acceptance open.                                                                              | blocked |
| V7  | R7   | Real exporter bundle smoke, delayed registration, concurrent init and combined queued-init/shutdown regressions; real Node/Bun immediate first turn.   | real-env     | optimization-runtime-final-tests-3.log: 24 passed, none skipped; packaging and lifecycle findings fixed, final reviewers report no further scoped defects.                                                                                  | Both engines before ready; OTLP/PostHog/Langfuse from relocated dependency-free bundle; generation fence prevents SDK installation after shutdown.                                  | passed  |
| V8  | R8   | Keep RSS and independently query macOS proc_pid_rusage; inspect VM map and reject ineffective candidates.                                              | real-env     | 6 harness tests include live/absent process; native-heap-vmmap.log; final five-sample RSS and physical-footprint distributions.                                                                                                             | Root footprint is distinct from tree RSS, measured after ready+1s RSS; no other-platform or loaded-account claim.                                                                   | passed  |
| V9  | R9   | Actual Node/Bun profile captures, loadable snapshots, idle control, stderr milestones, negative-delta regression and wiring audit.                     | real-env     | hotspots-tests-final.log: 13 passed, zero skipped; hotspots-profile-smoke-run.log: two captures, no failures, matching full bundle and stable sidecar; independent wiring audit clean after wording correction.                             | Diagnostic JS/VM data from isolated empty accounts; ordinary benchmark and Node default/fallback unchanged.                                                                         | passed  |
| V10 | R6   | Attempt native Allocations capture on both isolated brain processes.                                                                                   | real-env     | Node idle.trace recorded; Bun failed with Failed to attach to target process. VM maps and JS snapshots succeeded for both.                                                                                                                  | Node capture begins after ready and cannot attribute startup allocations; Bun native allocation stacks remain unavailable.                                                          | blocked |
| V11 | R10  | Red-then-green import/process-lifetime/rejected-sibling tests, real Node/Bun jobs, vendored build/type tests, canonical guards and independent review. | real-env     | 28 tool/orchestration tests, 15 engine tests, 20 telemetry/host regressions passed; actual Node/Bun snapshot plus React conversion succeeds; final reviewer reports no remaining blockers.                                                  | Local HTTP fixture, SSRF refusal before spawn, confined paths, tool order, child envelopes/job cleanup, deadlines and error propagation; full packaged Tauri acceptance remains X1. | passed  |

| V12 | R11 | Red/green no-eager-import and URL-race tests, delayed-load lifecycle tests, actual Node/Bun proxy/DNS/body/host regressions, request-harness cleanup failure and independent review. | real-env | undici-regressions-final.log: 99 passed; undici-harness-final.log: 16 passed; root MCP Jest: 20 passed; final reviewers clean. undici-comparison.json validates 20+20 startup and 60+60 request samples with no failures or guardrail regressions. | macOS local fixture only; no-proxy Bun cold guard.fetch adds 117.3ms, total startup+request remains within noise; configured proxy still pre-ready. | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                                                               | Action     | Based on       | Reversal trigger                                                                                                                      |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 2026-11-03 | Keep role-scoped policy beside the strict Node selector.                                                                                                               | implement  | G1, C1, O1     | Existing Node-only callers become affected.                                                                                           |
| D2  | 2026-11-03 | Gate Bun sidecar admission on ready; keep brain contract refusal separate from startup failure.                                                                        | implement  | C1             | Work can be admitted before safe fallback completes.                                                                                  |
| D3  | 2026-11-03 | Compare actual processes with a deterministic Host fixture, retaining failures and workload qualifications.                                                            | experiment | G1             | Workloads or readiness endpoints differ.                                                                                              |
| D4  | 2026-11-03 | Repair the missing browser-lifecycle capability check so Node fallback boots the same account path.                                                                    | implement  | G1, O3         | The fix changes renderer flush behavior.                                                                                              |
| D5  | 2026-11-03 | Skip exporter graph when unconfigured; await all configured telemetry; fence queued initialization during shutdown; retain Node default/fallback.                      | implement  | G2, H4, O4     | Readiness/lifecycle failure, packaging omission, or sidecar gain below the predeclared threshold.                                     |
| D6  | 2026-11-03 | Retain separate optional diagnostic mode and prioritize webclone import-boundary investigation; do not tune brain from raw Bun self-time bars.                         | diagnose   | G3, O5, O6, H5 | Native CPU accounting or a same-workload end-to-end ablation contradicts the candidate attribution.                                   |
| D7  | 2026-11-03 | Narrow only canonical webclone configuration/SSRF imports; repair the existing worker timer leak required for real job completion, including fail-fast queue stopping. | implement  | G4, H5, O7     | Functional/deadline regression, configured readiness changes, or the fresh paired startup experiment fails its predeclared threshold. |

| D8 | 2026-11-04 | Defer unused npm Undici in egress guard; preserve configured proxy readiness and report first-use cost explicitly. | implement | G5, V12 | Policy/lifecycle regression; primary startup gain fails 15 percent/noise rule; first-model, total-first-response or warm-request guardrail regresses. |

## Residual risks

| ID  | Residual                                                                          | From | Why still open                                                                                                                                                                                            | Next action                                                                                                                                                          | Status |
| --- | --------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Windows/Linux, packaged Tauri and real-provider acceptance have not run.          | R6   | Local macOS environment only.                                                                                                                                                                             | Run platform/package/provider matrix before changing the default or publishing.                                                                                      | open   |
| X2  | Repository-wide quality gates are not green.                                      | V6   | Previously recorded root temporary TSX parse error; fresh sidecar typecheck still has two unrelated errors, lint has 11 warnings, and resource closure rejects an unrelated @ai-sdk/provider declaration. | Repair owning changes and rerun full gates before merge; do not bypass or lower them.                                                                                | open   |
| X3  | Bun brain RSS reduction target remains unmet.                                     | M4   | No tested candidate reduced RSS enough; final RSS remains above Node even though macOS charged footprint is lower for this workload.                                                                      | Keep Node default; investigate loaded-account/native profiles before retaining any additional memory policy.                                                         | open   |
| X4  | Bun native allocation stacks and real-Host startup attribution remain unverified. | V10  | Signed Bun rejected Instruments attachment; the deterministic fixture intentionally times out event subscriptions and rejects native RPCs.                                                                | Use a profiling-enabled debug Bun build or approved native capture path; capture a real Host and representative loaded account before production memory/leak claims. | open   |

## Outcome

| ID  | Signal                                                                                                                              | How / when measured                                                                                           | Result                                                                                                                                         | Status  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | Both processes run under Bun and safely fall back to Node.                                                                          | Actual Bun sidecar protocol, actual Bun brain CLI, Rust failure-injection and cancellation tests, 2026-11-03. | Verified within the local process/fixture scope; Node remains default.                                                                         | met     |
| M2  | Startup and RSS differences quantified without assuming improvement.                                                                | Five interleaved measured trials after one warmup per role/runtime; same-source workload.                     | Twenty successful samples; mixed results, detailed below.                                                                                      | met     |
| M3  | Bun sidecar startup improves by at least 15 percent above twice the larger MAD.                                                     | Controlled baseline vs final, five trials each.                                                               | 1044.3 -> 704.0 ms (-32.6 percent); delta 340.2 ms exceeds noise floor 148.4 ms; RSS -5.0 percent and Node guards pass.                        | met     |
| M4  | Bun brain idle RSS decreases by at least 10 percent.                                                                                | All declared candidates plus final five-sample repeat.                                                        | 654.8 -> 653.3 MiB (-0.2 percent); below practical/noise thresholds. No speculative memory tuning retained.                                    | not-met |
| M5  | Distinguish charged memory from RSS under identical runtime workloads.                                                              | Final root proc_pid_rusage snapshots, five trials per role/runtime.                                           | Brain physical footprint Bun 256.5 MiB vs Node 533.5 MiB; this is a different metric, not an RSS optimization.                                 | met     |
| M6  | Produce actionable hotspot evidence and reusable local profile captures.                                                            | CPU profiles, stdout/stderr timeline, JS heaps, VM maps and isolated import probe.                            | Identified fixture timeout, Bun profiler idle misattribution and webclone eager imports; no additional production optimization claimed.        | met     |
| M7  | Bun sidecar startup improves at least 15 percent beyond twice the larger MAD, without memory/Node/brain regression or feature loss. | Fresh paired before/after runs, one warmup and five measured trials per role/runtime; V11 functional tests.   | Startup 635.99 -> 497.81ms (-21.7 percent), delta 138.18ms > 40.64ms noise floor; RSS -15.1 percent, footprint -22.3 percent; all guards pass. | met     |

| M8 | Bun sidecar startup improves at least 15 percent beyond noise while preserving policy, first-response totals and Node default/fallback. | V12 and final serial before/after comparison. | Startup 515.23 -> 346.09ms (-32.8 percent); RSS -5.2 percent and footprint -9.0 percent fall short of the memory practical threshold; cold Bun guard.fetch adds 117.3ms, total 503.99 -> 498.34ms; all declared guards pass. | met |

## Scope and new-file rationale

The new core host_runtime module isolates role-specific policy from unrelated Node-only callers. The new scripts/benchmarks/host-js-runtime.mjs and co-located test provide a repeatable actual-process comparison; no existing brain/sidecar harness exists. Task output and initial affected-file snapshots are under .cache/bun-host-runtime/. Existing uncommitted work is preserved. No runtime installation, provider credential use, commits or publishing are part of this change.

## Operator settings

Set these in the Rust Host's launch environment before starting it:

```sh
export COGNIA_BRAIN_RUNTIME=bun
export COGNIA_SIDECAR_RUNTIME=bun
# Optional: an absolute Bun executable when it is not on the Host PATH.
export COGNIA_BUN_EXECUTABLE=/absolute/path/to/bun
```

The settings are independent; unset them or use `node` to keep the existing runtime. Bun must be at least 1.4.0. Keep Node 26+ available for fallback and the deliberately Node-only external bridges. The desktop brain still runs in its WebView; only its Agent sidecar uses this setting. A Bun discovery/pre-ready failure latches that supervisor to Node until the Host process restarts. Post-admission failures follow existing recovery without replaying work on a second runtime.

## Original measured comparison

Historical run: the implicit-dotenv control was later found incomplete. Use the controlled follow-up below for environment-parity claims. Original raw JSON is preserved at `.cache/bun-host-runtime/optimization-baseline/previous-results.json`; generated bundle/log paths were superseded.

Command: `node scripts/benchmarks/host-js-runtime.mjs 5`.

Host: darwin/arm64, Apple M4 Pro; Node v26.12.1, Bun 1.4.0. Measurement timestamp: `2026-11-03T11:59:35.051Z`. One excluded warmup and five measured fresh-process trials per role/runtime; Node/Bun order alternates. All 20 measured samples succeeded.

The brain uses an isolated empty account and the real compiled CLI graph against a loopback Host fixture. The fixture rejects native RPCs with terminal 404 responses, so gateway telemetry and connector runtimes report the same two expected fixture failures on both runtimes. Startup means completion of the runtime bootstrap, not a healthy production Host or the first model token. Sidecar startup ends at its parsed ready event. Filesystem caches are warm; no OS cache flush is claimed.

RSS comes from `ps`, sampled every 200 ms from ready through 1 second of idle. The table reports the last sample, summarized across trials. Tree RSS sums root plus descendants and may double-count shared pages. This is not a startup high-water mark, PSS, a large-account result or a loaded model session.

| Process | Runtime | Startup median (ms) | Startup p95 (ms) | Idle tree RSS median (MiB) | Idle tree RSS p95 (MiB) |
| ------- | ------- | ------------------: | ---------------: | -------------------------: | ----------------------: |
| sidecar | node    |               581.9 |            876.6 |                      244.7 |                   245.1 |
| sidecar | bun     |              1017.9 |           1739.8 |                      219.8 |                   223.8 |
| brain   | node    |              9167.3 |           9265.7 |                      564.2 |                   565.3 |
| brain   | bun     |              8323.0 |           8671.6 |                      684.5 |                   704.0 |

For brain, Bun changes median startup by -9.2% and median idle RSS by +21.3% versus Node on this workload.

For sidecar, Bun changes median startup by +74.9% and median idle RSS by -10.2% versus Node on this workload.

The results support keeping Bun opt-in and retaining Node as default. They do not establish a universal performance win.

| Process | Runtime | Trial | Startup (ms) | Idle process RSS (MiB) | Idle tree RSS (MiB) |
| ------- | ------- | ----: | -----------: | ---------------------: | ------------------: |
| brain   | bun     |     1 |       8671.6 |                  693.4 |               693.4 |
| brain   | bun     |     2 |       8057.6 |                  659.8 |               659.8 |
| brain   | bun     |     3 |       8323.0 |                  684.5 |               684.5 |
| brain   | bun     |     4 |       8362.8 |                  665.7 |               665.7 |
| brain   | bun     |     5 |       8177.5 |                  704.0 |               704.0 |
| brain   | node    |     1 |       8286.2 |                  564.2 |               564.2 |
| brain   | node    |     2 |       9265.7 |                  563.4 |               563.4 |
| brain   | node    |     3 |       9167.3 |                  565.3 |               565.3 |
| brain   | node    |     4 |       8633.6 |                  557.7 |               557.7 |
| brain   | node    |     5 |       9225.6 |                  564.5 |               564.5 |
| sidecar | bun     |     1 |       1739.8 |                  223.8 |               223.8 |
| sidecar | bun     |     2 |       1014.6 |                  218.1 |               218.1 |
| sidecar | bun     |     3 |       1017.9 |                  219.8 |               219.8 |
| sidecar | bun     |     4 |       1034.6 |                  222.2 |               222.2 |
| sidecar | bun     |     5 |        988.0 |                  216.7 |               216.7 |
| sidecar | node    |     1 |        876.6 |                  245.1 |               245.1 |
| sidecar | node    |     2 |        568.8 |                  244.7 |               244.7 |
| sidecar | node    |     3 |        574.1 |                  245.1 |               245.1 |
| sidecar | node    |     4 |        663.1 |                  220.3 |               220.3 |
| sidecar | node    |     5 |        581.9 |                  221.5 |               221.5 |

Brain bundle SHA-256: `c862cbf99d4f3cb58b78069acde9b391f087fcc9109fe9b4f32dbb405ea2eee1`. Sidecar source/lockfile SHA-256: `3b59be4c44aafa6e8a5a5969b7287d63083e2d09e40afca7755b1d439b359ec7`; unchanged across the run. Raw samples, readiness strings, process identities, system load and stdout/stderr logs are under `.cache/bun-host-runtime/benchmark/`; summary JSON is `results.json`.

## Verification commands and remaining blockers

- `COGNIA_TEST_BUN=/Users/bytedance/.bun/bin/bun cargo test -p cognia-core -p cognia-sidecar -p cognia-server --no-default-features --lib -j 2`: 59 + 121 + 35 = 215 passed.
- `cargo test -p cognia-companion --lib admission -j 2`: 14 passed; `accepted_generation`: 1 passed. This is focused companion coverage, not its complete suite.
- `pnpm test -- --runInBand cli/src/runtime/external/native-bridges.test.ts stores/persist-storage.test.ts lib/i18n/locale-preference.test.ts`: 39 passed.
- Node sidecar runner for fetch-interceptor and egress-guard with `COGNIA_TEST_BUN`: 13 passed. Focused run-code runtime/environment/process-group tests with actual Bun: 7 passed.
- `node --test scripts/benchmarks/host-js-runtime.test.mjs`: 3 passed.
- Full root `pnpm typecheck` stops at `tmp/ui-polish/picker-head.tsx(168,1): error TS1005: '}' expected.` The file is outside this task.
- Sidecar typecheck has two unrelated errors: `sidecar/src/mcp/servers/tool-host.ts(742,82)` callback parameter mismatch and `sidecar/src/tools/session.ts(68,5)` unknown `executorId`. No errors remain in the changed sidecar modules.
- Full `pnpm lint` reported 7 errors / 11 warnings outside the task, including React ref access in `components/feature-shell/feature-page-header.tsx` and unused variables in convergence scripts. Scoped ESLint on the changed TS/JS modules passed.
- `cargo clippy -p cognia-core -p cognia-sidecar --lib --no-default-features -- -D warnings` passed. Sidecar architecture passed with zero baseline findings; co-located-test gate reported no new gaps.
- Static-export gate passed. Rust architecture passed with existing baselines/advisory. The standalone release CLI builder is additionally blocked by the existing Host authoring-kit ABI artifact mismatch; the benchmark therefore uses the production esbuild option set to build the actual JS graph without release-asset staging. No release artifact is claimed.
- The lifecycle review, wiring review, test-gap review and egress/PII review found issues which were repaired and regression-tested. Final scoped lifecycle, wiring and egress rechecks found no remaining actionable defects.

Disk pressure interrupted an early server test build. Only task-created Rust check metadata/incremental caches were removed; final combined tests completed. RTK stalled before launching commands during this session, so later checks used the underlying commands directly. No coverage run was requested or performed. No source reset, staging, commit, publishing or real-provider call was performed.

## Follow-up optimization contract (2026-11-03)

Pre-registered before candidate edits or measurements. User path: fresh-process
brain bootstrap and sidecar readiness under opt-in Bun. Node remains the default
and the existing pre-admission fallback is mandatory.

- Primary metrics: brain idle process-tree RSS in MiB (at ready + 1 second),
  sidecar complete startup duration in milliseconds. Minimum practical changes:
  brain RSS down 10%; sidecar startup down 15%.
- Guardrails: paired metric (brain startup / sidecar idle RSS) may regress at most
  10%; Node startup and RSS may regress at most 10%. All configured engines must
  finish loading before ready; brain must finish the same bootstrap roster. No
  provider, safety, cancellation, authority, or cleanup behavior may be deferred.
- Platform: same Apple M4 Pro darwin/arm64 host, Node v26.12.1, Bun 1.4.0;
  production CLI esbuild graph and source sidecar, matching the original run.
  Current dirty revision and owned input snapshots are recorded in
  `.cache/bun-host-runtime/optimization-baseline/`. Power/thermal state is not
  controlled; record system load and use an adjacent fresh baseline.
- Workload: same empty isolated account/home per process, loopback terminal-404
  Host, no model/network provider calls, warm filesystem cache, no cache flush.
  One warmup plus five measured samples per role/runtime, interleaved Node/Bun.
  Five samples deliberately preserve the user's requested original conditions;
  small-sample percentiles are exploratory, not tail-latency claims.
- Statistic/noise: compare medians and report MAD. An improvement must exceed
  twice the larger baseline/candidate MAD as well as the practical threshold.
  Retain only candidates that pass correctness and reciprocal guardrails. A
  noisy Node control invalidates the comparison and requires a repeat.
- Commands: import `benchmark` from `scripts/benchmarks/host-js-runtime.mjs` with
  iterations=5, warmups=1, idleMs=1000 and separate output directories. Candidate
  probes may use fewer samples for diagnosis, never as final acceptance.
- Side effects: isolated account files, CLI bundle, bounded local process trees,
  fixture server, logs/results under `.cache/bun-host-runtime/`; no credentials,
  installs, model calls, cache resets, commits, or publishing. Permitted source
  edits are limited to justified runtime launch policy / startup loading and
  their tests, benchmark harness and this evidence ledger.
- Correctness: real Node/Bun ready and local scripted-provider turn, both engine
  loading and engine-isolation tests; runtime-default/fallback/cancellation
  regressions; scoped type/lint/build and architecture/preflight gates.
- Hypotheses: JSC's large default heap accounts for brain RSS; sidecar source
  dependency resolution / eager module evaluation accounts for its startup.
  Diagnose each independently; keep readiness and workload boundaries fixed.

### Diagnostic findings and candidates

- The initial follow-up reproduction still showed slow Bun sidecar startup and
  high brain RSS. A value-free dotenv probe proved that Bun implicitly loaded
  two checkout `.env.local` keys; `--no-env-file` loaded zero. The first
  reproduction and the original comparison cannot establish environment parity.
  A replacement controlled baseline disables implicit dotenv; the final
  production launch policy must do the same. Host-injected environment stays
  authoritative. No dotenv values were printed or used as test credentials.
- Sidecar CPU startup profile (all configured engines loaded):
  `.cache/bun-host-runtime/profile-sidecar/CPU.20261103.202323.42521.0.001.md`.
  Exporter / NodeSDK CJS module evaluation accounts for substantial total time
  (OTLP entry ~166 ms; NodeSDK ~103 ms; inclusive stacks overlap). Telemetry is
  unconfigured in this workload yet these heavy modules are statically loaded.
  Candidate: load exporter constructors synchronously only in the already
  configured branch of `initializeTelemetry`, retaining initialization before
  ready when configured. No configured telemetry or engine work is postponed.
- Brain candidate: Bun `--smol` on the brain role only. Bun 1.4 documentation
  describes smaller heap / more frequent collection and an execution-speed
  tradeoff: [versioned runtime documentation](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/runtime/index.mdx).
  Compare the same ready + 1 second RSS; do not force GC in a measured trial.
- Runtime policy, telemetry loading and benchmark/test files extend existing
  owning modules; no new production module or dependency is needed. Node's
  selection and startup fallback semantics must remain unchanged.

### Candidate decisions before final confirmation

- Conditional exporter loading: preliminary five-sample result is positive
  (Bun sidecar startup 1044.3 -> 626.3 ms, MAD 74.2 -> 9.0 ms; RSS 216.3 ->
  204.9 MiB). A fresh reviewer found that local createRequire hides dependencies
  from the release bundler. Replaced it with bundler-visible dynamic imports
  and an awaited, idempotent telemetry gate before ready; final measurements
  and relocated configured-exporter verification must use this corrected form.
- Removed `--smol`: five-sample brain RSS 654.8 -> 676.9 MiB; it fails the
  predeclared improvement threshold. No production smaller-heap flag remains.
- Heap diagnostic (not an accepted benchmark): after boot JSC heap ~150 MB,
  ~200 MB capacity, RSS ~671 MB. Forced collection took 20.7 ms and reduced
  heap used to ~129 MB but did not reduce RSS. Do not add forced GC to production.
  Raw diagnostic: `.cache/bun-host-runtime/optimization-heap-diagnostic/`.
- Next bounded brain hypothesis: large-file runtime transpilation/cache state
  accounts for native resident overhead. Test the documented
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` with a fresh-home single-sample probe;
  promote only if a full five-sample result passes the original RSS/startup
  thresholds. No dependency or production flag is added for the probe.

- Cache-off confirmation failed the RSS threshold: brain Bun 646.5 MiB median
  (MAD 3.25) versus controlled baseline 654.8 MiB (MAD 5.27), only -1.3%.
  Startup 8227.2 ms versus 8158.2 ms (+0.8%). Remove this production tuning;
  the earlier 375 MiB single sample had a shifted Node control and is rejected.
  Accepted baseline remains `optimization-controlled-before/results.json`.
  This rejected run is archived at `optimization-cache-off/results.json`.
  The original comparison raw JSON is preserved at
  `optimization-baseline/previous-results.json` and `benchmark/results.json`;
  its generated bundle/log paths were superseded by the follow-up.
- Next brain hypothesis (pre-registered): the existing CLI i18n JSON plugin
  emits large catalogs as JavaScript object literal ASTs. Decode the same raw
  JSON synchronously with JSON.parse at module evaluation instead. This keeps
  the complete catalog and readiness boundary, while avoiding large JS ASTs
  for data. Change only the existing default-only catalog plugin and tests.
  Use the same five-sample contract; preserve reserved namespace keys, Unicode,
  JSON own-property semantics and both runtime consumers. No minification,
  engine deferral, forced GC, or runtime cache tuning is retained.

- Catalog JSON.parse probe rejected: brain Bun 656.6 MiB, no reduction versus
  654.8 MiB baseline; Node rose to 614.8 MiB in the diagnostic single sample.
  Remove the candidate and its isolated test. Data decoding is not the cause.
- Next bounded brain candidate: compact the existing production CLI JavaScript
  with esbuild syntax/whitespace minification while preserving function names.
  This removes source/parse overhead in a graph that includes a 10.4 MiB generated
  IDE validator; no import, validator, catalog or runtime is removed or delayed.
  Same five-sample thresholds and Node guardrails apply. Existing compiled Bun
  release configuration is inspected before choosing options. No speculative
  global JSC flags or JIT disablement will be introduced.

- Compact-source probe rejected for the Bun memory goal: Bun brain 651.8 MiB, essentially unchanged; Node 487.5 MiB improved, but this does not meet the declared Bun target. Removed all minification and candidate-only tests; existing build configuration is restored. A native VM-map diagnostic will distinguish code residency from JS-heap tuning before further source changes.

### Memory measurement correction (before final rerun)

Native VM map of the original unmodified brain graph: RSS ~684 MiB versus
macOS physical footprint 248 MiB (peak 289 MiB), JS heap ~150 MiB. Raw evidence:
`.cache/bun-host-runtime/native-heap-vmmap.log` and `native-heap-ready.json`.
This is a diagnostic, not an RSS improvement or proof of no leak under load.
[Apple explains footprint versus clean resident pages](https://developer.apple.com/videos/play/wwdc2022/10106/).

Keep the predeclared RSS metric and explicitly report that its 10% reduction
has not been achieved. Add an independent root-process physical-footprint
measurement for both Node and Bun: macOS proc_pid_rusage rusage_info_v2,
ri_phys_footprint, immediately after the same ready+1s RSS window. The installed
macOS SDK resource.h/libproc.h provides the ABI (160-byte v2 structure); the
[Apple kernel header](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h)
defines the fields. No VM map/forced GC occurs in measured trials. This extends
observability without changing startup readiness, workload, or the original
RSS statistic. Other platforms report this additional metric unavailable.
Final repeat: one warmup/five samples per role/runtime, all speculative brain
heap/cache/catalog/minification edits removed; Node default and fallback kept.

## Final follow-up result

Final command (2026-11-03):

```sh
node --input-type=module - <<'JS'
import { benchmark } from './scripts/benchmarks/host-js-runtime.mjs';
await benchmark({ output: '.cache/bun-host-runtime/optimization-final-verified', bun: '/Users/bytedance/.bun/bin/bun' });
JS
```

The same M4 Pro, Node v26.12.1 and Bun 1.4.0, empty-account/loopback workload,
one warmup/five interleaved samples and ready+1s RSS window are retained.
Implicit dotenv is disabled consistently in the corrected baseline and final
run. No build/test/cache-cleanup process was run by this task during the final
verified measurement. Background host load remains uncontrolled and is recorded
per sample. Small-sample p95 values in raw JSON are exploratory only.

| Process | Runtime | Startup median ± MAD (ms) | Idle tree RSS median ± MAD (MiB) | Root physical footprint median ± MAD (MiB) |
| ------- | ------- | ------------------------: | -------------------------------: | -----------------------------------------: |
| sidecar | node    |              527.8 ± 58.7 |                      219.7 ± 3.5 |                                172.9 ± 3.9 |
| sidecar | bun     |              704.0 ± 54.8 |                      205.5 ± 2.5 |                                 84.3 ± 1.1 |
| brain   | node    |            8778.1 ± 130.4 |                      561.9 ± 4.2 |                                533.5 ± 4.5 |
| brain   | bun     |            8341.6 ± 173.4 |                      653.2 ± 5.5 |                                256.5 ± 7.0 |

Bun sidecar startup is 32.6 percent lower than the corrected 1044.3 ms baseline;
RSS is 5.0 percent lower. Node sidecar startup is 26.8 percent lower and RSS
10.4 percent lower. Brain changes are within the declared reciprocal guardrails:
Node startup -1.1 percent/RSS -0.7 percent; Bun startup +2.2 percent/RSS -0.2
percent. No brain speed or RSS improvement is claimed. Bun sidecar still starts
more slowly than Node (704.0 vs 527.8 ms), supporting Node as the default.

Brain Bun RSS remains higher (653.3 vs Node 561.9 MiB). Its macOS physical
footprint is lower (256.5 vs 533.5 MiB) on this empty-account workload. RSS and
footprint are both retained; this diagnosis does not turn the failed RSS target
into a performance win or establish memory behavior under load.

Physical footprint was collected about ready+1.3s, immediately following the
unchanged RSS window; each exact measurement offset is in the raw sample.
It is root process memory, not tree RSS, PSS or startup peak. No model provider,
large account, packaged Tauri, Linux or Windows acceptance is inferred.

Kept: conditional telemetry imports and complete configured startup gate;
queued-init shutdown fence; Bun-only explicit-environment launch flags;
repeatable RSS/physical-footprint reporting. Removed: smaller-heap flag,
transpiler-cache disabling, forced-GC idea, catalog parsing and source compaction.

24 sidecar tests, 6 benchmark tests, 217 Rust tests and 27 Jest tests passed.
Actual Node/Bun hosts ran local scripted-provider turns. Relocated configured
OTLP/PostHog/Langfuse bundles worked on both runtimes. Scoped ESLint, Prettier,
Clippy, static-export and architecture/co-location gates passed. Full root
`pnpm typecheck`, independent sidecar typecheck and `pnpm lint` retain the
unrelated blockers listed in V6/X2. No coverage, commit or publishing occurred.

Final raw samples/logs are in `.cache/bun-host-runtime/optimization-final-verified/`;
corrected before-run data is `optimization-controlled-before/results.json`;
comparison/MAD/deltas are `optimization-comparison.json`. Earlier confirmation
and rejected probes remain recorded separately; they are not the final result.
Only task-owned completed caches/rejected generated bundles were removed for
disk headroom; cleanup manifests are `optimization-cache-cleanup*.json`.

Final brain bundle SHA-256: `825b45b060201f489b70024dfc269736d058902d11cf9eb9800848c216e9d140`.
Final sidecar source/lockfile SHA-256: `23921f69d6866a9b10e69db61f49dc0015d990ca05cf9950ef5c60639a95daf3`.
All 20 measured samples succeeded; brain roster parity and source stability checks passed.

## Hotspot profiling contract (2026-11-03)

User authorized diagnostic analysis with CPU flamegraphs, startup timelines and
native/JS memory inspection. This pass changes no production runtime policy.
Reuse the final verified brain bundle and the same empty-account loopback Host,
explicit environment, Node/Bun executables and completed-ready boundary. Record
source/bundle identities and any drift. Capture two CPU profiles per role/runtime
for attribution, then separate ready+1s memory snapshots and native VM maps.
Profiler timings and heap-snapshot memory are diagnostic, never a new benchmark
or an optimization claim. CPU samples may omit native loader work; parent-observed
log milestones bound phases but do not prove per-runtime start durations.
Attempt Instruments on the isolated brain only; report platform restrictions
without modifying OS permissions. Do not capture or upload real account data.
Allowed edits: bounded optional profiling hooks/mode in the existing benchmark,
focused script tests and this ledger. Generated profiles, traces, temporary
preloads and the visual report stay under `.cache/bun-host-runtime/`.

### Profiling results and interpretation

The new `host-js-profile.mjs` is a diagnostic companion rather than additional
logic in the benchmark timing loop. It shares the existing fixture, explicit
environment and ready boundary. Its CLI is wired through `--profile`; normal
benchmark calls do not import it or enable profilers. The separate module is
needed to keep capture/analysis dependencies out of the ordinary measurement
path. A full bundle digest and runtime identity probe guard capture identity.
The smoke run matches the final benchmark brain SHA-256
`825b45b060201f489b70024dfc269736d058902d11cf9eb9800848c216e9d140`
and sidecar SHA-256 `23921f69d6866a9b10e69db61f49dc0015d990ca05cf9950ef5c60639a95daf3`.

1. **CPU profiles need an idle control.** Local Bun 1.4.0 reproduces the
   behavior reported in [upstream issue 44077](https://github.com/oven-sh/bun/issues/44077):
   roughly 200ms of busy work around a 400ms timer consumes 205.3ms of process
   CPU, yet the exported profile assigns a 402.496ms gap to JavaScript and has
   no idle samples. Node consumes 210.3ms of CPU and exports 327 idle samples;
   its largest delta is 6.048ms. Brain Bun profiles likewise assign a five-second
   wait to changing unrelated frames. Weighted self/inclusive duration is NOT
   CPU accounting. Summaries retain raw weights and sample counts and flag
   missing-idle/long-gap profiles; no synthetic correction is applied to raw
   files. One Node control had a -5us out-of-order delta: its summary now keeps
   hit counts but disables duration attribution, with a regression test.

2. **The dominant brain startup wait is fixture behavior.** Four confirmation
   timelines show gateway telemetry subscription waits of 5000.94, 5001.10,
   5002.91 and 5001.50ms. The fixture acknowledges the internal bridge hello,
   but not gateway event subscription frames; `gateway-telemetry.ts` awaits
   `events.whenSubscribed(channels, 5_000)` and then fails the expected fixture
   check. This is not evidence of a production five-second A2UI/locale CPU
   hotspot. It also means the prior 8-9 second complete-bootstrap benchmark
   includes a large fixed fixture wait. Keep the original benchmark numbers;
   do not subtract the wait and relabel them as real-Host startup results.
   Capturing both stdout and stderr makes the failed stage visible in Perfetto.

3. **Sidecar webclone has a concrete avoidable import candidate.** The eager
   chain is `tools/builtin/registry.ts -> webclone/index.ts -> run.ts ->
webclone/dist/index.js`. That barrel re-exports `assembler.js` and the HTML
   parser even though the parent runner imports only configuration and SSRF
   helpers. The resulting startup profiles contain webclone's debug, CSSOM,
   PostCSS and JS analyzer modules. A separate fresh-process import ablation
   (one warmup, five interleaved samples, warm filesystem, no production edit)
   compares that barrel with `config/index.js` plus `ssrf-guard.js`:

   | Runtime      | Broad barrel import, median / MAD | Narrow helpers, median / MAD | RSS after import, broad / narrow |
   | ------------ | --------------------------------- | ---------------------------- | -------------------------------- |
   | Node 26.12.1 | 167.64 / 18.86ms                  | 2.41 / 0.20ms                | 105.39 / 52.25MiB                |
   | Bun 1.4.0    | 205.74 / 7.05ms                   | 2.88 / 0.42ms                | 84.48 / 16.61MiB                 |

   This is attribution evidence, not a 203ms sidecar speedup claim: shared
   dependencies can already be loaded elsewhere. The next implementation
   candidate is a direct import boundary, preserving both configured engines,
   tool definitions/order, SSRF checks, child isolation and the ready gate.
   Claude Agent SDK and Undici also appear in the module graph; their required
   initialization cannot simply be deferred past readiness.

4. **Brain memory is dominated by the loaded graph, with distinct OS metrics.**
   Before taking heap snapshots, a separate pair reports Node RSS 566.95MiB /
   physical footprint 538.13MiB and Bun RSS 657.48MiB / footprint 252.61MiB.
   The Bun VM map shows Memory Tag 240 at 591.1MiB resident / 219.8MiB dirty;
   reserved gigacage VM has zero resident pages. The JS snapshot contains
   3056 ModuleRecord objects with 58.50MiB reported shallow size and 42.73MiB
   of code objects. Node and JSC classify/charge snapshot nodes differently,
   so these categories cannot be compared as equivalent allocation types.
   This supports investigating module reachability and source/code residency;
   it does not establish a leak, allocator bug or a successful RSS reduction.
   Loaded-account growth/retainers need a separate workload.

5. **Native profiling boundary.** Instruments recorded Node's three-second
   post-ready Allocations/VM Tracker capture. Bun attachment failed with
   `Failed to attach to target process`; the installed binary is signed with
   hardened runtime. No signing or OS security setting was changed. The
   failure alone does not prove the signing flag is the sole cause. The Node
   trace is an idle capture and cannot reconstruct startup allocation stacks.
   Bun VM maps and V8-format JS snapshots remain inspectable.

### Artifacts, commands and validation

- CPU: `hotspots-cpu/` and `hotspots-cpu-confirm/`, each with two profiles per
  role/runtime; `startup.cpuprofile` loads in Speedscope. Confirmation captured
  all eight raw profiles; its initial summary rejected one negative Node delta.
  `hotspots-analysis-validation.json` records successful reanalysis of all 16
  without rewriting the raw files. `hotspots-profile-smoke/` exercises the
  final capture code on both actual runtimes, with complete identity digests.
- Timeline: each capture's `startup.trace.json` loads in Perfetto. The inline
  comparison uses the four confirmation brain runs, with raw data preserved
  in `hotspots-timeline.json`; independent runs align at zero.
- JS memory: `hotspots-heap/brain-{node,bun}-0/ready.heapsnapshot`, load in
  Chrome DevTools Memory. `heap-summary.json` aggregates shallow sizes only;
  `heap-stats.json` and `vmmap.txt` were captured before snapshot generation.
  Bun's API returns an already serialized V8 snapshot string. An initial
  double encoding was normalized losslessly; the original is retained as
  `ready.heapsnapshot.double-encoded.json`. Real Node/Bun tests verify the
  corrected writer emits directly parseable snapshot objects.
- Native: `hotspots-native/brain-node-0/idle.trace`, and both `vmmap.txt` files.
  `instruments.json` preserves successful/failed native capture output.
- Isolated import probe: `import-probe.mjs` and `import-probe/results.json`.
- Final checks: 13 script tests passed, zero skipped; scoped ESLint passed with
  zero warnings; formatter and syntax checks passed. Independent wiring review
  found no blockers; corrected its stdout-only boundary description. Root
  `pnpm lint` still fails on the same 11 unrelated warnings in gate scripts.
  No production source, Node selection/fallback or previous benchmark result
  changed in this analysis. No coverage, commit, publication or real-account
  capture was performed.

Use a new output directory for every capture; existing captures are never
overwritten. From the repository root:

```sh
node scripts/benchmarks/host-js-runtime.mjs --profile cpu \
  .cache/bun-host-runtime/optimization-final-verified/brain-bundle/cognia-agent.mjs \
  .cache/bun-host-runtime/my-cpu-capture
# Replace cpu with heap or native for separate memory / Instruments passes.
```

Interpret format/API details using [Bun 1.4 profiling documentation](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/project/benchmarking.mdx),
[Speedscope import guidance](https://github.com/jlfwong/speedscope/wiki/Importing-from-Node.js)
and [Perfetto's Chrome JSON format](https://perfetto.dev/docs/getting-started/other-formats).

## Webclone import optimization contract (2026-11-03)

User authorized narrowing sidecar webclone imports, retaining Node default and
fallback, preserving functionality, and repeating the same startup/memory
comparison. The only production change planned is to import canonical
configuration and SSRF exports directly instead of the engine's broad barrel.
Do not defer engines, tools or readiness, change the child runner, weaken SSRF
or path confinement, replace canonical parsers, or change runtime selection.

- Primary metric: complete Bun sidecar startup, milliseconds. Keep the change
  only for at least 15 percent improvement and a median delta larger than twice
  the larger MAD. Node startup, either runtime's sidecar RSS/physical footprint,
  and unchanged brain controls must not regress by over 10 percent.
- Memory improvement claims additionally require at least 10 percent and a
  delta beyond twice the larger MAD; otherwise report measurements without a win.
- Same host, installed Node 26.12.1/Bun 1.4.0, full production CLI esbuild graph,
  source sidecar, fresh isolated empty accounts, explicit environment including
  Bun --no-env-file, warm filesystem cache, one excluded warmup, five measured
  interleaved fresh-process samples per role/runtime. Five repeats deliberately
  preserve the prior user-requested conditions rather than the skill's generic
  ten-sample default. No task builds/tests run concurrently with measurements.
- Ready boundaries, loopback terminal-404 Host, expected gateway subscription
  timeout, no model calls, RSS sampling every 200ms through ready+1s and root
  proc_pid_rusage immediately afterward remain unchanged. No profilers or cache
  deletion in the benchmark. Use a fresh before run rather than only historical
  numbers; compile each condition through the same harness options.
- Functional verification: existing webclone orchestration/tool/engine tests;
  a failing load-graph regression before the import edit; real Node and Bun
  snapshot and convert jobs against a local HTTP fixture; packaged sidecar
  import/build checks; engine/readiness regressions; runtime/fallback tests.
- Scope: sidecar/src/tools/builtin/webclone/run.ts and its co-located tests,
  existing release note and this ledger. Additional test files only if process
  isolation cannot be expressed in the existing tests. Raw evidence, source
  snapshots, build outputs and comparison stay in .cache/bun-host-runtime/.

Functional-test discovery expanded the repair narrowly to the existing
webclone worker pool and runner tests. Successful jobs already emitted their
envelope, but a completed Promise.race left its overall timeout timer active,
so the real parent waited for child exit until its own timeout. A subprocess
liveness regression failed before the fix. Clear the timer in finally and
mark the existing dequeue-stop flag on worker rejection before rethrowing;
the independent reviewer caught the rejected-worker/sibling edge case, which
now has its own red-then-green regression. In-flight work and deadline-based
queue stopping remain tested. This repairs existing child lifetime behavior;
it does not move work or readiness in the startup benchmark.

On the user's telemetry-priority clarification, rechecked telemetry before
editing webclone: 20 tests passed, none skipped, including actual unconfigured
Node/Bun exporter exclusion, configured initialization, shutdown fencing and
both engines before an immediately queued first turn. The telemetry code
requires no additional change in this experiment.

### Accepted implementation and functional evidence

- `run.ts` now imports DEFAULTS/parsers/validateOptions from the existing
  `webclone/dist/config/index.js` and evaluateFetchTarget from the existing
  `webclone/dist/ssrf-guard.js`. They are the same exports the barrel forwarded.
  No new validation, engine selection, tool order, Node discovery/fallback or
  ready behavior is introduced. The heavy engine remains in the child.
- The structural subprocess test failed on the original eager assembler import
  (`webclone-import-red.log`) and passes with narrow imports.
- Real Node and Bun jobs verify blocked loopback before spawn, output traversal
  refusal, successful local HTTP bundle snapshots, React conversion/draft
  output, a single expected HTTP request and temporary-job cleanup. Initial
  full-job tests exposed the pre-existing worker deadline leak; the runner
  emitted success but did not exit. No fake spawn, forced child exit or altered
  HTTP keep-alive behavior remains in the accepted real-job tests.
- `worker/pool.ts` now clears its deadline in finally after completion or
  rejection, and sets the existing dequeue-stop flag before propagating a worker
  error. A first cleanup patch allowed a blocked sibling to dequeue after the
  failed pool's cleared deadline; independent review reproduced it and a
  red-then-green multi-worker test now covers the correction. In-flight task
  settlement and actual timeout queue stopping remain intact.
- Accepted test results: 28 orchestration/tool tests, 15 vendored-engine tests,
  20 telemetry/engine-host regressions; zero skipped. Vendored engine build and
  test typechecks passed; parent run.ts/run.test.ts scoped ESLint passed;
  formatter passed for all four edited source/test files. The repository
  intentionally excludes vendored webclone from root ESLint; its build/test
  typechecks and formatter were run separately, without changing ignore rules.
- Rust core 61 and server 35 passed. The first parallel sidecar run had 120
  passes and one existing shared-secret Langfuse fixture failure at
  `langfuse.rs:1145`; that unchanged test passed alone and all 121 sidecar tests
  passed with `--test-threads=1`. This is a test-isolation limitation, not a
  claim that the initial parallel suite was green. Runtime policy/supervisor
  source hashes match the pre-change snapshot byte-for-byte.
- Sidecar architecture passed with zero baseline violations. Combined resource
  and benchmark harness tests had 20 passes and one unrelated resource-closure
  failure: `providers/protocol-adapters/ai-sdk-adapter.ts` imports
  `@ai-sdk/provider`, which is declared only as a devDependency. New config and
  SSRF paths exist in the compiled vendor output and remain covered by the
  unchanged Tauri `webclone/dist/**/*` resource pattern.
- Fresh whole-repository lint still reports zero errors and 11 unrelated
  gate-script warnings. Sidecar typecheck still fails only at
  `mcp/servers/tool-host.ts:742` (map callback signature) and `tools/session.ts:68`
  (executorId). No unrelated manifests, gates, assertions or baselines were
  changed to hide those failures. Full packaged Tauri/provider/platform
  acceptance remains outside this local test boundary.

### Fresh same-condition comparison

Before: `webclone-import-before/results.json`, 2026-11-03T14:46:00.617Z.
After: `webclone-import-after/results.json`, 2026-11-03T15:05:39.578Z.
Same Apple M4 Pro, Node v26.12.1, Bun 1.4.0, empty-account fixture, production
CLI graph/source sidecar, warm filesystem cache, one warmup and five interleaved
measured fresh processes per role/runtime, no profilers. All 20 samples in each
condition succeeded, source stayed stable, identities match and complete brain
runtime rosters match. No task build/test ran during either timing loop. Raw
outliers are retained. Times are medians with MAD; memory definitions remain
tree RSS at ready+1s and separately measured root macOS physical footprint.

| Role/runtime   | Startup before -> after (ms; MAD before / after) | RSS before -> after (MiB) | Physical footprint before -> after (MiB) |
| -------------- | ------------------------------------------------ | ------------------------- | ---------------------------------------- |
| sidecar / Node | 532.62 -> 462.31; 17.25 / 49.95                  | 216.13 -> 188.14          | 168.83 -> 138.98                         |
| sidecar / Bun  | 635.99 -> 497.81; 13.57 / 20.32                  | 203.66 -> 172.88          | 85.63 -> 66.50                           |
| brain / Node   | 8737.07 -> 8493.38; 239.41 / 32.57               | 562.42 -> 564.13          | 533.36 -> 534.93                         |
| brain / Bun    | 7891.59 -> 7968.93; 64.71 / 34.86                | 664.45 -> 656.66          | 256.89 -> 248.55                         |

Bun sidecar startup improves 21.7 percent; its 138.18ms delta exceeds the
40.64ms noise floor and the 15 percent practical threshold. RSS improves 15.1
percent (delta 30.78MiB > 3.31MiB noise floor), root physical footprint improves
22.3 percent (delta 19.13MiB > 4.87MiB noise floor). Both memory gains exceed
the declared 10 percent practical threshold. Keep the import optimization.

Node sidecar startup is measured 13.2 percent lower but its 70.31ms delta does
not exceed the 99.89ms noise floor: do not claim a confirmed Node speedup.
Node sidecar RSS improves 12.9 percent and footprint improves 17.7 percent,
both beyond the declared memory thresholds/noise. Brain controls have no
significant change: Node startup -2.8 percent/RSS +0.3 percent; Bun startup
+1.0 percent/RSS -1.2 percent. Every +10 percent regression guard passes.
The earlier brain RSS reduction goal remains open; this is not a brain-memory
optimization claim or a loaded-account/high-water/leak result.

`webclone-import-comparison.json` preserves full medians/MADs, deltas, noise
floors, guards and digests. `webclone-policy-integrity.json` verifies unchanged
runtime policy, both supervisors and the benchmark harness. Before bundle /
sidecar SHA-256: `825b45b060201f489b70024dfc269736d058902d11cf9eb9800848c216e9d140` /
`23921f69d6866a9b10e69db61f49dc0015d990ca05cf9950ef5c60639a95daf3`.
After bundle / sidecar SHA-256:
`90afb6f5a64ce87a464da697916e3fdb82185e338c9bee863b72c27565cbc547` /
`0a0808115d1b376116684f91d4b86bf8616fa0a4291aaf9aabf28bc90b97b84f`.

No commit, publication, runtime default change, coverage run, provider call,
real-account capture or shared-cache cleanup occurred.

## Post-webclone hotspot refresh (2026-11-03)

The user requested a fresh look at the remaining profile hotspots. This pass
changes no production source or runtime policy. Captured two CPU profiles per
role/runtime and, separately, one heap snapshot per role/runtime using the
accepted optimized bundle and current sidecar. No build, test or heap capture
ran alongside the CPU capture loop. Same versions, isolated empty account,
explicit environment, both engines and full-ready boundaries as before.

CPU report timestamp: 2026-11-03T15:17:04.860Z. All eight CPU captures and four
heap captures succeeded; source and bundle stayed stable. The bundle SHA-256
is `90afb6f5a64ce87a464da697916e3fdb82185e338c9bee863b72c27565cbc547`,
sidecar SHA-256 `0a0808115d1b376116684f91d4b86bf8616fa0a4291aaf9aabf28bc90b97b84f`,
both matching the accepted after-benchmark. These are diagnostic profiles,
not new unprofiled startup or memory benchmark results.

### Sidecar: remaining startup samples

Group each non-idle/non-GC/non-root sample by its nearest source-bearing stack
frame. Native or anonymous leaves inherit the nearest source ancestor. This
is a disjoint source attribution, not inclusive dependency ownership or CPU
time accounting. Bun has 286 and 309 such samples in the two captures. Node's
loader hides more dependency work under internal/native frames, so percentages
must not be compared directly across engines. In particular, Bun's long idle
gaps still cannot be interpreted as JavaScript self time; raw files are intact.

| Bun source group        | Hits in the two captures | Share of selected samples | Current owner / interpretation                                                                                                                                                |
| ----------------------- | ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undici and fetch seam   | 90 / 90                  | 31.5 / 29.1 percent       | egress-guard.ts statically imports undici/index.js; includes dispatcher, Mock, cache and other package entry initialization.                                                  |
| Glob/process helpers    | 59 / 67                  | 20.6 / 21.7 percent       | fast-glob, picomatch/micromatch, @nodelib and cross-spawn; package initialization, not a measured directory search.                                                           |
| Schema libraries        | 45 / 66                  | 15.7 / 21.4 percent       | AJV and Zod module/schema initialization; not a slow user argument validation request.                                                                                        |
| Claude Agent SDK itself | 15 / 21                  | 5.2 / 6.8 percent         | sdk.mjs and its own source frames; transitive dependencies are counted in their own groups, so this is not total SDK cost.                                                    |
| OpenTelemetry API       | 17 / 14                  | 5.9 / 4.5 percent         | Thin API package remains; exporter/integration group has zero attributed samples. Existing unconfigured-runtime tests establish exporter exclusion, not sample absence alone. |

No webclone parser/transform source appears in either fresh sidecar CPU
profile. This supports the intended import-boundary effect, independently of
the already accepted unprofiled startup/RSS comparison.

Source tracing identifies two concrete follow-up candidates, still unmodified:

1. `platform/net/egress-guard.ts:14` imports the full npm Undici entry on module
   load. `mcp/client/tools.ts` and `mcp/client/discovery.ts` make it reachable
   before any remote MCP request. Agent construction is already lazy inside
   getDispatcher; the remaining startup candidate is package loading. The
   installed Undici entry eagerly imports MockClient/MockAgent/SnapshotAgent,
   cache stores and interceptors, and mock/snapshot-agent appears in samples.
   Test a narrower or on-use loading boundary before retaining any change;
   preserve proxy/CIDR, Request/body/abort/dispatcher handling, synchronous URL
   refusal and socket-level DNS rebinding protection.
2. `core-files/js-search.ts`, `platform/fs/gitignore.ts`, file/content-search
   and the code-graph index service statically load fast-glob. Core glob/grep
   use ripgrep when available but already loaded their JavaScript fallback.
   There are multiple importers, so changing one is not proof the closure is
   removed. cross-spawn also comes from MCP SDK client/stdio. A loading
   experiment must preserve gitignore behavior, ordering, limits, cancellation,
   fallback availability and first-tool latency.

Schema work is the next investigation after those: tool-host.ts:106 explicitly
imports AjvJsonSchemaValidator, and the installed MCP SDK server/index.js also
imports its default AJV provider. Removing one host import will not necessarily
remove AJV. Zod definitions are distributed across registered tools. Do not
weaken or skip validation to manufacture a startup reduction.

Node sidecar selected samples are dominated by module loading, file I/O,
parsing and Amaro/WASM type stripping: 85.2-90.8 percent fall under that broad
runtime/loader group. It points toward dependency closure/loading boundaries;
it is not proof of a corresponding percentage speedup opportunity.

### Brain: CPU phases and memory

All four fresh brain timelines retain the expected gateway subscription wait:
5000.47, 5000.87, 5001.44 and 5001.49ms. This remains fixture behavior, not an
application compute hotspot. Other observed boundaries:

- Process spawn to unlocked account: approximately 1.62-1.69s on Bun and
  1.87-2.17s on Node, including module loading and account preparation.
- The plugin-runtime completion interval is approximately 0.78-0.79s on Bun
  and 1.39-1.90s on Node. These are parent-observed intervals since the previous
  log, with profiler overhead; do not use them as before/after benchmark gains.
- A plugin runtime/state/file-lock bundle accounts for 283/290 nearest-source
  Bun samples (18.0/19.0 percent of selected samples). Source maps through
  esbuild comments to cli/src/plugin/plugin-state.ts and file-lock.ts:
  synchronous locking, read/write, link/unlink/rename and fsync. The lifecycle
  adapter writes plugin-state.json through revision checks and an atomic file
  protocol. Any later batching or no-op-write experiment must retain revision,
  ownership, locking and durability semantics.
- Dexie has 125/124 nearest-source Bun samples (about 8 percent). highlight.js
  also appears with 75/82 samples (about 5 percent), and locale JSON plus
  generated manifest validators contribute initialization work. CLI index.ts
  statically imports many commands. These are leads for a finer command/module
  reachability audit, not proof every rendering dependency can be removed.

Fresh Bun heap snapshots still report 3056 brain ModuleRecords with 58.50MiB
shallow size, plus 43.42MiB of code objects. Sidecar has 542 ModuleRecords /
6.20MiB, plus 12.91MiB of code objects. JSC snapshot charges include engine
objects/backing data and differ from process.memoryUsage, Node snapshot
categories, RSS and physical footprint. Do not subtract them across engines or
call them a leak. Snapshot-before counters report brain heapUsed about 143MiB
on Bun and 290MiB on Node, sidecar about 27.5MiB on Bun and 43.6MiB on Node;
snapshot timing/GC makes these diagnostics, not a new optimization result.
The brain memory direction remains module/source/code residency; loaded-account
growth and retaining paths still require a representative workload.

### Raw artifacts and reproduction

- `.cache/bun-host-runtime/post-webclone-cpu/profiles.json`: identities,
  completed captures, ready rosters and unchanged-source/bundle checks.
- Each CPU directory has startup.cpuprofile, cpu-summary.json,
  startup.trace.json and milestones.json; use Speedscope/Perfetto respectively.
- `post-webclone-cpu/hotspots.json` is generated by the cached
  analyze-post-webclone.mjs script. Sample counts and attribution rules above
  are preserved; no raw CPU timeline was rewritten.
- `post-webclone-heap/heap-summary.json` is generated by the cached
  analyze-post-webclone-heaps.mjs script. Per-process heap-stats.json and vmmap.txt
  were written before the ready.heapsnapshot capture. All four snapshots load
  as V8-format JSON objects.

No production code, Node default/fallback, telemetry policy or previous
benchmark result changed in this profiling pass. No native allocation retry,
real account, remote provider, commit or publication was involved.

## Undici on-demand loading experiment (pre-registered)

User request: defer unused Undici work while preserving Node default/fallback,
proxy/CIDR/DNS defenses, existing requests, cancellation and shutdown. Check
first-request latency in addition to startup and memory.

Hypothesis: the eager npm Undici import in egress-guard.ts loads dispatcher,
fetch, mock and cache code before any remote MCP request. Loading it at the
first guarded request removes that unused startup work without changing socket
DNS policy. Configured proxy installation must still complete before ready.

Contract fixed before production edits:

- Same device, runtimes, production CLI graph, isolated empty accounts, loopback
  terminal-404 Host, complete-ready boundary and warm filesystem caches as the
  preceding webclone experiment. No OS cache flush or real provider calls.
- Startup/memory: unchanged host-js-runtime benchmark, both roles/runtimes,
  one warmup plus five measured fresh processes, interleaved runtime order,
  ready + 1s idle RSS and root physical footprint. No concurrent test/build or
  profiler during measurements. Each run records source and build identity.
- Primary metric: Bun sidecar complete startup, task-local minimum improvement
  15 percent and absolute delta greater than twice the larger MAD. Memory
  improvement claims require 10 percent plus the same noise rule. All other
  startup/memory guardrails: no confirmed regression above 10 percent.
- First request: a separate identical before/after harness, one warmup plus
  five measured fresh processes per Node/Bun mode. Measure ordinary full-host
  AI SDK text turns against a loopback scripted SSE provider, and cold/warm
  guarded fetch calls against a local fixture. Record call-to-response and
  spawn-to-first-response separately. No proxy and configured proxy/CIDR
  modes are separate workloads. No credentials or external network required.
- Ordinary first-turn guardrail: no confirmed regression exceeding the larger
  of 10 percent or 20ms. Cold guarded fetch can pay deferred import cost; report
  its absolute increase explicitly. End-to-end spawn-to-first-response must
  not regress above the larger of 10 percent or 20ms beyond noise. Warm guarded
  requests must not regress above the larger of 10 percent or 5ms beyond noise.
  This is an explicit deferred-cost tradeoff, not a claim of zero added cost.
- Correctness is a hard gate: synchronous URL refusals; socket DNS lookup of
  all answers with mixed public/private rejection; proxy install before ready;
  CIDR/exact-IP/hostname bypass; no direct fallback on proxy failure; native
  Request body/init/abort adaptation; shared import/agent initialization;
  close with initialization in flight and no late outbound dispatch.
- Allowed edits: egress guard and co-located regressions; existing fetch
  interceptor only if needed; benchmark harness/tests, this ledger and the
  existing changeset. Preserve concurrent edits and all previous evidence.
- Raw output: .cache/bun-host-runtime/undici-import-{before,after},
  undici-first-request-{before,after}; source snapshot under
  undici-import-snapshot. Production policy/supervisor hashes are controls.
- Verification: focused Node/Bun network, MCP/OAuth/relay/host regressions;
  benchmark tests, scoped lint/type checks, sidecar architecture and static
  export gates; preflight auditors. No coverage requested.

### Undici implementation and correctness evidence

The guard now imports the literal npm Undici entry only when a request needs
its Agent or Bun fetch adapter. It shares initialization across concurrent
requests, preserves Node's captured fetch, and does not load Undici for rejected
URLs, already-aborted calls, unused guards or reviewed private Node fetches.
Configured proxy installation is unchanged and still awaited before host ready.

Initialization and close are coordinated: close fences queued requests, waits
for an in-flight import, and closes an allocated Agent once. Failed imports
refuse dispatch; cleanup does not mask the original fetch error. Socket lookup
continues to inspect every DNS answer, and redirect refusal stays forced.

Read-only PII/wiring review caught a new mutable-URL race before final timing:
validation preceded an async boundary but passed the original URL object to
fetch. The red regression proved a post-call mutation could change the target.
The fix captures the validated href before waiting; tests cover public HTTPS
and explicitly reviewed local HTTP. The final review reports this fixed.
Signal override with null remains supported, including Request body retention.

The new first-request harness extends the existing benchmark family because
the original idle/startup harness has no request driver. Its test-only IPC
preload shares the real full host's module cache; it loads no Undici itself
before ready. It drives two separate real AI SDK sessions or cold/warm guarded
requests and validates each response, exact proxy/bypass routing, and private
DNS denial. Forced/nonzero/signaled process exits fail the sample. A real-host
wrapper deliberately kept alive verifies that cleanup failure is not accepted
as a timing success. No production instrumentation was added.

Pre-timing results after final source restoration:

- undici-regressions-final.log: 99 passed, zero failed/skipped (network, IP/CIDR,
  MCP client/discovery/OAuth/relay, full Node/Bun host, telemetry).
- undici-harness-final.log: 16 passed, zero failed/skipped (runtime/profile and
  first-request harness, including actual Node/Bun and forced-cleanup failure).
- undici-root-mcp-jest.log: 20 passed in lib/mcp/transport.test.ts.
- undici-scoped-lint.log: scoped ESLint passed with zero warnings.
- undici-sidecar-types.log: only the same two unrelated type errors previously
  recorded at tool-host.ts:742 and tools/session.ts:68; no touched-file errors.

Measurement corrections are explicit: an early request-harness smoke overlapped
the original brain baseline. Those brain measurements are retained but excluded.
All ten sidecar samples had already completed before the overlap. Brain was
rerun serially on the identical retained bundle; accepted combined baseline is
undici-import-before-verified/results.json with twenty successful samples.
The request harness first exposed a shutdown/IPC cleanup wait; its corrected
implementation passed real-process tests. A later shared-tree operation restored
only egress-guard.ts byte-for-byte to the experiment's starting snapshot. No git
commit occurred. The final strengthened request baseline was collected on that
verified original source (undici-first-request-before-final/results.json), then
only this task's lazy patch was reapplied and the full regressions above rerun.
The final candidate is separately saved as undici-import-snapshot/guard-candidate.ts;
its identity is checked immediately before and after final serial measurements.
No failed/overlapped/reverted-source sample is used as an optimization result.

### Undici result (2026-11-04)

Verdict: keep. The primary Bun sidecar complete-ready gain exceeds both the
pre-registered 15 percent practical threshold and twice the larger MAD.
There are no confirmed guardrail regressions under the declared rules.
This does not claim the first use of Undici is faster: no-proxy cold guard.fetch
pays the deferred import cost, while its spawn-to-response total stays within
noise. Ordinary model turns do not need this import. Configured proxy paths
still initialize npm Undici before ready, so they do not gain the same startup
reduction or incur the same deferred cost.

Same Node 26.12.1 / Bun 1.4.0, Apple Silicon macOS, one warmup and five measured
fresh processes per runtime/workload. Standard startup report has twenty
successful samples before and after. Each request report has sixty successful
samples before and after across six modes; every accepted process exits
normally. Before/after source hashes match between the two harnesses, stay
stable throughout each run, and runtime identities plus brain ready rosters
match. The original host-js-runtime harness and all three Rust policy/supervisor
files are byte-identical to this task's starting snapshot.

| Process/runtime | Startup median ms before -> after | Idle tree RSS MiB before -> after | Root physical footprint MiB before -> after |
| --------------- | --------------------------------- | --------------------------------- | ------------------------------------------- |
| sidecar / node  | 379.23 -> 346.83                  | 178.97 -> 179.28                  | 128.67 -> 129.17                            |
| sidecar / bun   | 515.23 -> 346.09                  | 172.11 -> 163.16                  | 69.80 -> 63.49                              |
| brain / node    | 8282.48 -> 8251.53                | 562.67 -> 561.81                  | 533.75 -> 532.99                            |
| brain / bun     | 7907.13 -> 7775.13                | 653.25 -> 656.47                  | 240.11 -> 243.24                            |

Bun sidecar startup MAD is 12.45 -> 4.11ms. The 169.14ms median reduction exceeds the 24.89ms noise floor.

Bun sidecar RSS decreases 5.2 percent and footprint 9.0 percent. Neither clears
the predeclared 10 percent practical memory-improvement threshold, so no
substantial memory optimization is claimed. Brain changes remain below the
guardrail limits; no brain memory/startup optimization is claimed.
RSS remains ready+1s root/tree resident memory; footprint is independently
charged root process memory measured after those samples. These are idle,
before-model-call measurements, not post-first-use residency or startup peaks.

| Request fixture / runtime | First request ms before -> after | Spawn to first response ms before -> after | Warm second request ms before -> after |
| ------------------------- | -------------------------------- | ------------------------------------------ | -------------------------------------- |
| model / node              | 31.12 -> 30.02                   | 403.19 -> 353.43                           | 3.88 -> 3.92                           |
| model / bun               | 28.61 -> 31.54                   | 488.17 -> 390.20                           | 1.84 -> 1.84                           |
| model-proxy / node        | 32.46 -> 31.16                   | 407.97 -> 375.26                           | 4.01 -> 3.94                           |
| model-proxy / bun         | 38.95 -> 39.13                   | 492.51 -> 514.13                           | 2.71 -> 2.51                           |
| model-cidr / node         | 32.85 -> 30.82                   | 412.73 -> 380.22                           | 4.20 -> 3.95                           |
| model-cidr / bun          | 40.90 -> 43.25                   | 529.54 -> 480.47                           | 2.73 -> 2.49                           |
| guard / node              | 9.05 -> 11.03                    | 397.79 -> 344.41                           | 1.17 -> 1.12                           |
| guard / bun               | 11.73 -> 129.05                  | 503.99 -> 498.34                           | 1.08 -> 0.92                           |
| guard-proxy / node        | 12.27 -> 8.80                    | 396.54 -> 362.61                           | 1.43 -> 1.21                           |
| guard-proxy / bun         | 11.63 -> 10.34                   | 497.98 -> 441.86                           | 0.95 -> 0.82                           |
| dns-denied / node         | 6.71 -> 26.96                    | 392.18 -> 353.52                           | 3.02 -> 0.56                           |
| dns-denied / bun          | 9.33 -> 104.96                   | 499.59 -> 443.16                           | 0.70 -> 0.59                           |

The guard fixture calls the production guard against reviewed loopback HTTP;
it is not a complete remote MCP handshake. dns-denied invokes the real Agent
with a socket lookup returning loopback and verifies refusal before any origin
hit. The model fixture drives actual full-host AI SDK sessions against local
scripted SSE. Proxy and CIDR modes assert the actual wire route; they are not
merged with no-proxy timings.

The no-proxy Bun cold guard.fetch increase is 117.32ms (11.73 -> 129.05ms).
Its total is 503.99 -> 498.34ms, a 5.65ms change within noise, so no end-to-end
speedup is claimed for immediate first guard use. Bun private-DNS refusal also
pays deferred import (9.33 -> 104.96ms), but total is 499.59 -> 443.16ms.
Node's first DNS refusal increases 6.71 -> 26.96ms; total decreases
392.18 -> 353.52ms. Warm requests and ordinary first model responses remain
within the predeclared guards. With a configured proxy, Bun first model total
is 492.51 -> 514.13ms (+21.62ms), below its 10 percent guard and within noise;
this is not described as a proxy startup speedup.

Raw accepted evidence:

- undici-import-before-verified/results.json (retained original bundle under
  undici-import-before/brain-bundle) and undici-import-after/results.json.
- undici-first-request-before-final/results.json and
  undici-first-request-after/results.json; per-process stdout/stderr retained.
- undici-comparison.json contains median/MAD, deltas, noise floors, every
  guardrail verdict and identity/source/roster validation.
- analyze-undici.py reproduces the comparison from those four reports.

Reproduce in sequence from the root, using a fresh absolute output directory:

```sh
COGNIA_TEST_BUN=/Users/bytedance/.bun/bin/bun node scripts/benchmarks/host-js-runtime.mjs 5
COGNIA_TEST_BUN=/Users/bytedance/.bun/bin/bun node scripts/benchmarks/host-first-request.mjs /absolute/fresh-output
```

The original runtime script's default output can overwrite an existing run;
for preserved evidence use its exported benchmark({output, bun}) as in this
experiment's undici-after-serial command/log. Do not run tests/builds/profile
captures concurrently with timing. No cache flush, coverage run, real-provider
call, default-runtime change, commit or publication was performed.

### Undici final gates and boundaries

- Final independent PII and wiring re-reviews are clean after all three findings
  were fixed; static-export review found no new boundary violation. The final
  integrity report confirms original fetch interceptor, benchmark and all three
  Rust runtime/supervisor controls unchanged, and current guard identical to the
  benchmarked candidate. No unrelated staged edits were touched.
- Focused final verification: 99 sidecar regressions + 16 harness tests + 20
  main-app MCP Jest tests pass, zero skipped. The 16 includes a deliberate stuck
  host fixture whose forced shutdown is correctly recorded as a failed sample.
  Scoped ESLint and Prettier checks pass. No coverage was requested or run.
- pnpm audit:sidecar-architecture passes, zero baselined findings.
- pnpm lint:static-export passes: 12093 TS files audited, 41 existing allowlisted
  imports and six fenced standalone Node sources.
- pnpm typecheck remains blocked at the pre-existing
  tmp/ui-polish/picker-head.tsx(168,1): TS1005 missing closing brace.
- Final standalone sidecar tsc still reports exactly the existing errors:
  mcp/servers/tool-host.ts(742,82) closeAdmission callback versus array index,
  and tools/session.ts(68,5) unknown executorId property. No touched-file
  diagnostics. Raw outputs: undici-root-typecheck-final.log and
  undici-sidecar-types-final.log.
- pnpm lint reports zero errors and the same eleven unrelated unused-variable
  warnings in scripts/gates/check-baseline-growth.test.mjs,
  check-convergence.test.mjs, convergence/counter.mjs and plugin-api-matrix.mjs;
  --max-warnings=0 makes the command fail. undici-root-lint-final.log retained.
- Bundle-resource suite: 14 passed, one failed on the already-recorded
  ai-sdk-adapter.ts -> @ai-sdk/provider runtime dependency declaration. The
  runtime-reference parser supports literal dynamic imports; module staging and
  required-entry checks pass. No dependency allowlist or package declaration
  was changed to hide the unrelated defect. undici-resource-closure-final.log.
- Evidence-ledger final check reports zero errors/warnings. Full packaged Tauri,
  Windows/Linux and real-provider acceptance remain outside this local fixture
  proof; the release default stays Node. No claim of globally green gates or
  zero first-use latency cost is made.

## Two-worker code-index experiment (2026-11-04, pre-registered)

User request: on-demand two-worker index comparison, preserve Node default and
fallback plus existing functionality; regress and compare elapsed time,
main-thread blocking and total memory. No runtime default change is authorized.

Hypothesis: per-file tree-sitter/WASM parsing and AST extraction can run in two
threads while the original owner commits results in input order and performs
cross-file resolution once. SQLite, graph authority, root policy and watchers
stay on the owning thread. Existing serial extraction remains the default and
fallback; explicit COGNIA_CODE_INDEX_WORKERS=2 enables the experiment.

Contract before production edits:

- Fixed source snapshot under .cache/code-index-workers/fixture, with path,
  size and SHA256 manifest fixture.json. Real repository TS/TSX/Rust/Python,
  evenly sampled across eligible paths, at most 96KiB per file. No model calls,
  remote network, root user index or OS cache flush. OS filesystem cache warm.
- Node 26.12.1 and Bun 1.4.0, same macOS Apple Silicon workstation as previous
  comparisons. Source-mode sidecar TypeScript per ADR-0197; real available
  SQLite backend recorded and compared within each runtime. No heavy tests,
  builds, profiler or another benchmark concurrently with timing.
- One warmup and ten measured fresh processes per runtime/configuration.
  Each trial owns a copied fixture and isolated HOME/cache. Cold full index,
  unchanged sync and changed/new/deleted-file incremental sync measured
  separately; cold time includes first-use worker startup and grammar loading.
- Primary: median cold full-index elapsed time improves at least 15 percent,
  with absolute reduction greater than twice the larger MAD, within each runtime.
  Keep a runtime's worker path only if it meets the rule and correctness guards;
  otherwise retain serial there and remove ineffective performance-only hunks.
- Guardrails: representative cold/incremental elapsed time must not regress
  beyond 10 percent and the noise rule; unchanged scan must not regress beyond
  max(10 percent,20ms) and noise. Max main-thread timer lag must not regress
  beyond max(10 percent,5ms) and noise. Memory tradeoff budget: sampled total
  process peak RSS at most baseline +192MiB (two worker runtimes,96MiB each),
  with idle workers retired after a short bounded timeout. This is a task-local
  experimental budget, not a project policy or a memory-saving claim.
- Main-thread responsiveness: same 5ms timer heartbeat, max delay and sum of
  delay above16ms; these are event-loop scheduling probes, not exact CPU time.
  External parent samples process RSS every50ms so main-thread blocking cannot
  hide memory peaks. Worker threads share a PID, so root RSS covers the pool.
  Capture idle-after-retirement RSS and macOS physical footprint separately.
- Correctness hard gates: identical file metadata (excluding timestamps), node,
  edge, unresolved and query behavior; all supported grammars; ignore/large-file
  rules; content-hash unchanged paths; ordered commits; incremental add/change/
  delete, watcher changes, errors and missing grammars. Never share live ASTs
  or SQLite across threads. Worker crash/boot/timeout may replay only pure
  extraction in serial, then latch serial for that session. No post-dispose
  write, late worker publication, worker leak or serial replay after disposal.
- Runtime proof: actual Node/Bun threads, worker start only on changed-file
  extraction, exactly two maximum, bounded queues, serial default, teardown,
  failure fallback and relocated esbuild output. Bun standalone/unsupported
  worker entry must safely retain serial functionality, not hang.
- Allowed edits: services/code-graph lifecycle/pool and co-located tests, lazy
  resolver only if necessary, benchmark harness/tests, this existing ledger and
  changeset. New worker module required for an executable thread entry plus
  pool lifecycle; existing extractor/parser/store implementations are reused.
- Source snapshots and all raw reports under .cache/code-index-workers/.
  Existing Rust runtime/supervisor policies are byte-integrity controls.
- Verification: sidecar regression entry point, parser/extractor/store/resolver/
  index/watcher/tools and actual Node/Bun worker tests; scoped lint/types,
  architecture/static-export/resource gates, relocated bundle and preflight
  PII/wiring/static-export reviewers. No coverage requested.

### Code-index control corrections before formal A/B

The original serial baseline and early smoke reports are preserved as diagnostic
runs. Their glob order was not pinned, and the first harness chose incremental
edits by that unstable order. Across unchanged serial runs, equal-rank FTS hits
and ambiguous-candidate metadata varied; incremental runs could modify different
files. Those incremental numbers cannot support the final A/B conclusion.

The formal comparison uses interleaved serial(0)/worker(2) modes on the same
candidate source, ten fresh measured processes per runtime/mode after one
warmup. A fileOrder:"lexical" option pins the _existing filtered discovery_
only for this controlled experiment; omitted preserves production glob order.
Incremental edit and deletion paths are explicitly sorted. No graph/query
assertions are relaxed: controlled smoke now matches every phase fingerprint,
and complete SQLite files/nodes/edges/unresolved tables after the incremental
phase hash identically across Node/Bun and serial/worker modes, omitting only
timestamps and SQLite surrogate row IDs.

Three preflight findings were corrected before formal timing: thread creation
alone could hide serial fallback; idle wait did not prove threads retired; and
fixture manifest validation omitted extra files/cache DBs. The harness now
records content-free successful worker/serial/fallback counts, errors, maximum
and final live threads, and actual child runtime identity. Worker measurements
fail unless extractions complete in workers without fallback/error, maximum
live count is exactly two and final live count zero. Complete fixture inventory
rejects extra files, symlinks and index caches; negative tests exercise this.

A process-wide pool shares two threads across index sessions. Per-file graph
payloads return to the owner; commits retain the discovery order. Independent
PII review confirms no new external/model call or gate bypass. Idle workers
retire after 1000ms; a retirement fence prevents overlap with replacement
threads. Last-lease disposal rejects pending work. Closing one lease cannot
publish into its disposed index or cancel a sibling's results. Boot/error/
timeout paths latch serial extraction for the affected index, replaying no
writes or resolution.

Relocated split-esbuild Node/Bun worker tests passed with completed extraction,
exactly two threads and zero fallback. Bun standalone is explicitly serial-only
because a virtual /$bunfs self-URL is not a proven dedicated worker entry.
Node default and Rust runtime/fallback policies are unchanged.

Pre-timing validation: regressions-candidate.log has74 passes/no skips;
harness-final-tests.log has3 passes/no skips; bundle-tests2.log has6 passes/no
skips (overlapping pool cases). Scoped ESLint passes; sidecar typecheck has only
the same two unrelated tool-host.ts:742 and tools/session.ts:68 errors.
No coverage or real provider call was performed.

Formal batch restart: controlled-ab was stopped as diagnostic-only before
completion. Parent-side full-table hashing repeatedly serialized rows inside
its sort comparator and added excessive inter-trial verification work. The
harness now canonicalizes each row once and sorts strings, and performs all
full-table checksums only after all timed samples are complete. That validation
change passed all three harness tests again. The pool retirement barrier also
now resolves to undefined, avoiding a chain of retained previous Promise.all
result arrays; eighteen focused lifecycle/runtime/bundle tests pass afterward.
Final accepted batch will be controlled-ab-final, with both serial and worker
modes using the identical final harness and candidate source. Earlier serial
and smoke batches remain diagnostic, not substituted into the paired results.

Final setup correction: Node fs.cp took roughly45seconds to create an isolated270-file snapshot on this host; a native APFS clone of identical files took336.9ms. The partial controlled-ab-final batch is retained as diagnostic only. Final accepted batch is controlled-ab-clone: both modes use fresh independent copy-on-write snapshots, with identical paths/bytes, fresh databases and the same warm OS-cache policy. Copy method/duration are recorded outside indexed elapsed time; complete fixture validation after the run proves edits did not alter the master snapshot. Three actual Node/Bun harness tests passed after the change. RTK-wrapped commands became stalled; owned temporary process control and the unchanged Node command use direct process APIs with explicit argument arrays and an isolated environment.
