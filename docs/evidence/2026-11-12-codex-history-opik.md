# Codex desktop history reuse for Opik

- Status: closed
- Lane: standard
- Updated: 2026-11-12

## Original request

Reuse Cognia's parser in the local Codex-to-Opik syncer; the user authorized changes to the package. Preserve existing Opik IDs, redacted raw JSON, configurable display rules and deduplication.

## Problem frame

The pure history entry already exists. Current desktop lifecycle aliases, message roles and per-response usage receipts need explicit support. Python remains the host for file discovery, completed-turn selection, redaction, outbox persistence and Opik identity. A local bundled Node bridge delegates message and tool decoding to the package without loading the app or runtime.

## Knowledge

| ID  | Statement                                                                                            | State    | Basis                                                              | Depends on |
| --- | ---------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ | ---------- |
| O1  | The history entry is pure and already used by the app import adapter.                                | Verified | history.ts, adapters/codex.ts and ADR-0217 inspected on 2026-11-12 | -          |
| O2  | The baseline parser missed desktop lifecycle/usage receipts and treated non-assistant roles as user. | Verified | Baseline source and failing regressions on 2026-11-12              | -          |
| G1  | Reuse the package and update existing Opik records in place with redacted raw data retained.         | Agreed   | Explicit user requests in this chat                                | -          |

Follow-up on 2026-11-12: tool outputs were still raw text-block arrays and escaped nested execution results. The target stored result includes malformed nested JSON, so the output projector must label partial recovery honestly and retain raw data.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                   |
| ------------ | ------ | ------------------------------------------------------------- |
| scale        | medium | 693 traces and 28836 spans already delivered before migration |
| technical    | medium | Pure TypeScript decoder and local Python-to-Node IPC          |
| coupling     | medium | Shared app history import also consumes the parser            |
| requirement  | low    | Existing IDs and raw fields must remain stable                |
| verification | medium | Unit regressions plus real Opik readback                      |
| risk         | high   | Private session data and historical updates                   |

## Risks

| ID  | Risk (impact)                                                                               | Severity | Source | Claim                                                                                | Refuted by |
| --- | ------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------ | ---------- |
| R1  | Usage receipts and fallback counters double-count tokens or attach to another turn.         | high     | O2     | Canonical receipts supersede fallback for their turn and deduplicate by response ID. | V1         |
| R2  | A decoder change exports internal instructions or changes historical identities/raw JSON.   | high     | G1     | Host filtering, redaction and identity stay outside the package.                     | V2         |
| R3  | Historical rewrites leave duplicate or pending records and the scheduler stays stopped.     | high     | G1     | In-place migration is drained and read back before resuming.                         | V3         |
| R4  | Tool output formatting drops unknown fields, invents truncated content, or changes raw/IDs. | high     | O2     | Only recognized envelopes are decoded; partial output is marked; raw remains exact.  | V4         |

## Verification obligations

| ID  | Risk | Method                                                                     | Independence | Evidence                                                                                                                                                                               | Coverage                                                            | Status |
| --- | ---- | -------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| V1  | R1   | Failing regressions, package tests/typecheck/lint/build/pack-test          | tool         | 50 related tests passed; package typecheck/build, focused ESLint, isolated tarball ESM/CJS/data-only/NodeNext checks passed                                                            | Desktop aliases, roles, phases, usage repeats and turn isolation    | passed |
| V2  | R2   | Real-corpus parity, Python regression tests, protected database comparison | tool         | 352 files / 751 ended-turn occurrences matched exactly; 65 Python tests passed; IDs/raw JSON matched the protected backup                                                              | Stable IDs, preserved raw inputs/outputs, private message exclusion | passed |
| V3  | R3   | Full Opik readback and LaunchAgent execution                               | real-env     | Full 693 traces / 28836 spans read back; scheduled increment 24 traces / 1581 spans also read back; all 29529 baseline entities unchanged; 2 job runs exit 0; pending/blocked/errors 0 | Historical count, IDs, fields, queue and incremental sync           | passed |

The read-only wiring reviewer found multi-block commentary losing separators and JSON-null tool input changing raw shape. Both were corrected and have regression tests. The reviewer confirmed LaunchAgent-to-package reachability and the redaction gate before persistence/transport.
| V4 | R4 | Output behavior tests, raw/ID/untouched-field comparison, server readback and real UI | real-env | 78 tests and Ruff/format/compile passed; real Pretty UI verified; all 17175 tool outputs compared with backup; full 730 traces / 30979 spans read back; automatic increment 17 traces / 456 spans read back with baseline unchanged; queue/errors 0 | Valid/malformed JSON, budgets, redaction, empty-result exit codes and scheduled updates | passed |
| V5 | R1 R2 | Native-field fixtures, privacy tests and source correlation | tool | 98 tests passed; scoped audit reproduced nested instruction leakage and settings attribution, both fixed and independently rechecked; original source backup comparison passed | Scope, deduplication, units, unavailable values | passed |
| V6 | R3 | Protected backup comparison, API readback and scheduled run | real-env | All 802 traces / 33074 spans fully read back; 33876 baseline entities retained with original raw/IDs/accounting; scheduled increment 53 traces / 2283 spans read back; pending/blocked/source_errors/failed 0 | Original IDs/raw/cutoff, metadata, queue, no duplicate records | passed |

The output wiring review found empty execution results hiding exit codes and decoded generic JSON losing sensitive-key semantics before the second gate. Both were fixed with regressions and independently rechecked. Real UI verified six separate result sections, exit codes/timing and an incomplete-prefix notice. The deployed Opik detector requires a string output field, so the projector uses output.output plus output.raw.

The bulk update hit ENOSPC. SQLite quick_check passed. EXPLAIN QUERY PLAN confirmed a temporary B-tree sorting full pending payloads; an additive delivery-order index removed the temporary sort, with a regression test. Only syncer-owned backups were compressed, with original/decompressed SHA-256 equality checked before removing uncompressed copies.

| V7 | R2 R4 | Failing patch fixtures, independent review, protected backup comparison and real Pretty UI | real-env | 111 tests, Ruff check/format and compile passed; dynamic recovery, cached toggle and 512-character budget regressions independently rechecked; all 1730 historical writes fully read back; project counts remained 817 traces / 33604 spans; original IDs/raw/outputs/usage retained | Literal-only patch display, privacy, partial legacy recovery, budgets and no duplicates | passed |
| V8 | R3 | Actual restored LaunchAgent execution and parent-scoped complete API verification | real-env | 34421 baseline entities retained; 1757 changed entities including 1642 new were verified through 26 traces / 3266 spans; pending/blocked/source_errors/failed 0; activation cutoff unchanged | Fresh incremental job, delivery, IDs and metadata/content | passed |

## Decisions

| ID  | Date       | Decision                                                                               | Action    | Based on | Reversal trigger                                             |
| --- | ---------- | -------------------------------------------------------------------------------------- | --------- | -------- | ------------------------------------------------------------ |
| D1  | 2026-11-12 | Extend the existing pure entry and consume a local bundled bridge; retain host policy. | implement | O1 O2 G1 | Package import loads app/runtime code or corpus parity fails |
| D2  | 2026-11-12 | Add an independently fingerprinted tool_output projection and requeue only tool spans. | implement | G1 O1    | Raw preservation, privacy or UI verification fails           |

## Residual risks

| ID  | Residual                                                         | From | Why still open                                                                                                  | Next action                                              | Status   |
| --- | ---------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| X1  | Existing multi-session-meta identity interpretation is retained. | V2   | Repair would change already published identities and is outside this display migration.                         | Preserve current host identity policy                    | accepted |
| X2  | Native sources are missing for 7 chats / 64 traces.              | V6   | Source state and checkpoints point to deleted files; native settings/TTFT cannot be recovered from absent data. | Retain stored redacted facts and explicit unknown values | accepted |

## Outcome

| ID  | Signal                                                                                   | How / when measured                                        | Result                                                                                              | Status |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| M1  | Readable records using the shared parser, no duplicate history, incremental sync active. | Tests and real readback on 2026-11-12                      | 717 traces / 30417 spans delivered; raw preserved; interval 30s active                              | met    |
| M2  | Tool output readable in Pretty with raw retained, old IDs reused and auto sync active.   | Tests, protected backup and real Opik UI/API on 2026-11-12 | 17175 historical tool outputs updated; total 747 traces / 31435 spans verified; interval 30s active | met    |

## Numbering follow-up

On 2026-11-12 the user requested removal of generated numbering from both
inputs and outputs. Output result headings and result-index labels are hidden
by default; input command blocks have no ordinal captions. Actual numbered
source text is preserved. All 17,557 existing tool inputs/outputs were updated
under their original IDs; raw and other payload fields matched pre-change
hashes. Every one of the 31,702 span fingerprints matched API readback after
each pass, with 13 full-content samples. The real UI showed unnumbered input
blocks and output sections. All 79 syncer tests and Ruff/format checks passed.
Automatic collection resumed after the queues drained.

A separate read-only check of the user-selected usage receipt confirmed model
gpt-6.1-sol, configured provider openai and all recorded token detail fields.
The receipt contains no individual request start/end timing or billing cost.
The exported codex provider label identifies the collector source; a 0-second
receipt span and absent cost do not establish instantaneous inference or a
free request.

## Comprehensive metadata follow-up

The user requested all useful available information. A read-only inventory of
370 rollout files found native turn duration/TTFT, completed-item intervals,
context/settings, rate limits and scoped usage snapshots that the syncer did
not export. Native receipt records still do not identify model request
start/end or billed cost. OpenAI's official advanced configuration documents
optional OTel request telemetry; it is not enabled locally.

Plan and acceptance: (1) add allowlisted metadata extraction, behavioral
regressions and typed redaction; (2) enrich only existing IDs while retaining
all input/output/raw fields and the activation cutoff; (3) read back server
metadata, usage details and TTFT, verify counts/IDs, then resume the actual
30-second incremental job. A separate pure Python telemetry module keeps
metadata accounting apart from the shared message parser and renderers.

Preparation found seven native source paths no longer present (confirmed in both
local thread state and existing source checkpoints), covering 64 traces / 2641
entities. The fallback derives only facts from stored redacted payloads, labels
source availability, retains unknown TTFT/latency/cost as null, and is idempotent
in both unit tests and the independent reviewer probe. All 802 traces / 33074
spans retain their IDs, original input/output/raw, execution timestamps, models,
providers and existing usage counters. 703 traces have recorded native TTFT.

The real Opik sample readback matched complete trace/span metadata, existing raw
inputs/outputs, normalized token details and native trace TTFT. The browser
confirmed configured_provider=openai and effort=xhigh, reasoning/cache-write
usage details, and whole-turn recorded_duration_ms=572925 with TTFT=6979 ms.
All historical writes drained; project counts remained exactly 802 traces and
33074 spans. Full metadata-aware server verification is running before resume.

Full server verification passed for all 802 traces / 33074 spans with unchanged
queue digest. Subsequent source/queue comparison checked all 33876 baseline
entities: zero differences in IDs, raw/content, execution times, names, models,
providers, tags or original usage counters.

The first actual scheduled scan exposed volatile local-thread updated_at_ms
fan-out starving parent delivery. Two behavioral regressions reproduced it.
Snapshot comparison and checkpoint hashes now ignore only that volatile field;
the timestamp is sampled when meaningful thread metadata or turn content changes.
Title/pin/archive updates remain independent of rollout availability. All 97
tests and Ruff checks passed. Checkpoints were upgraded only where their stored
inode/size/mtime matched exactly, after native metadata had passed full readback.
The durable backlog drained to pending=blocked=0 before the final fresh job.

## Metadata completion

The final real LaunchAgent run scanned three changed files / 28 ended turns with
source_errors=failed=0 and no timestamp-only rewrites. All 33876 baseline entities
remain present. The 365 changed entities (324 new) were verified through their
53 parent traces / 2283 spans, including complete metadata, token details and
content. Queue pending=blocked=0; capture_after is unchanged. Title/pin/archive
refresh remains wired for both sync and explicit enrich even without a native
rollout. Final unit count: 98 passed; Ruff check/format and Python compilation
passed. The full historical server readback and the increment together cover
the final exported data; current service health is recorded in the syncer's
protected operational receipts.

## Apply-patch display follow-up

The selected exec span contains a nested tools.apply_patch string. The current
projector recognizes shell calls only and falls back to escaped JavaScript. Its
legacy redacted source also has damaged string boundaries (confirmed by a
Tree-sitter error and a truncated argument node), although the patch terminator
remains present. The shared Codex decoder correctly preserves this tool input.

Acceptance: add configurable inert patch extraction; label legacy recovery as
partial without rebuilding lost text; extract new patch literals before the
first typed redaction gate; keep existing raw/IDs/output/usage unchanged; update
only affected display records, verify real UI/API and resume incremental sync.
Use a separate patch presentation fingerprint to avoid rewriting shell records
for a patch-only renderer change.

Patch implementation verification: 111 syncer tests and Ruff passed. The scoped
review found dynamic-expression recovery, a cached recovery toggle bypass and
a small-budget overflow; failing fixtures reproduced all three, then passed
after fixes and independent recheck. The selected span was correlated to its
native call/turn IDs and its in-memory literal re-extracted without changing
stored raw. The real Pretty UI now shows multiline diff text. The migration
compared every local entity with its protected backup, preserving original IDs,
raw inputs, outputs, usage and non-display metadata. All 1730 historical writes
were fully read back and counts stayed 817 traces / 33604 spans. Shell and
trace/output rule fingerprints are unchanged.

The restored 30-second LaunchAgent completed a real scan with no source or
transport failures. The baseline 34421 entities remain present. All 1757 changed
entities (1642 new) passed complete API verification through their 26 parent
traces / 3266 spans, with pending=blocked=0. The activation cutoff is unchanged.
Older patch text that cannot be recovered from available native source remains
explicitly incomplete; static extraction is never proof of successful execution.
