---
title: ADR-0069 — Long-term memory subsystem & external API surfaces
description: "Documents the autonomous long-term memory subsystem (Dexie v65 + v118 governance, budgeted hybrid retrieval, durable learning jobs) and its plugin, MCP, workflow, companion, and governed mobile surfaces."
---

# ADR-0069 — Long-term memory subsystem & external API surfaces

**Status**: Accepted (2026-07-14), amended (2026-07-19)
**Authors**: Max Qian + Claude Fable 5
**Builds on**: the Digital Twin runtime (ADR-0003, shared embedding/vector backend), the external bridge MCP server (ADR-0008), the Companion control plane (ADR-0061 / Wave 4.1), the plugin permission model (ADR-0032, `goal:read`/`goal:write` precedent), and the visual-workflow memory nodes (ADR-0011).

## Context

The autonomous long-term memory subsystem (`lib/memory/**`, `types/memory/`,
Dexie v65 `memories` table) has been fully wired internally since it shipped:
per-turn extraction (`runTurnMemory` from the chat + team hooks), hybrid
BM25+vector recall injected via `resolveSendOptions` (the
"What you remember about the user" section), connector auto-mode recall,
`/remember` explicit capture, workflow store/recall nodes, the `/memory`
console, and a mobile sync mirror (`memories` in
`sync_registry.rs`). It had **no ADR** — code comments pointed at a spec file
that was never committed — and **no callable API surface**: plugins, external
MCP agents, and paired devices could not read or write memory at all.

Known defects fixed alongside: `MemoryConfig.hybridEnabled` was inert (only
the settings toggle read it); the workflow recall node and the pet recall
bridge ignored `decayHalfLifeDays`; a stale docstring claimed team
shared-memory object values bypass the PII gate (they are deep-gated); and
`/remember`'s `openMemory` flag was never consumed.

## Decision

### 1. One shared helper layer — `lib/memory/api/`

Every non-conversational surface writes/reads through four helpers, never
straight at Dexie:

- `store-memory.ts` — `storeMemoryCore` (the `/remember`-parity deliberate
  write: consolidator-preferred, direct-insert + vector-sink fallback) and
  `storeExternalMemory` (external wrapper). The workflow
  `action.memory.store` node now delegates here too.
- `search-memory.ts` — `searchMemoriesExternal`: config-gated hybrid recall
  threading the user's `retrievalTopK` / `relevanceFloor` /
  `decayHalfLifeDays` / `enableQueryExpansion`; `touch` on by default with a
  diagnostics opt-out.
- `mutate-memory.ts` — `updateExternalMemory` (PII-gated text patches, bumps
  `version`, re-upserts the vector doc) and `forgetExternalMemory`
  (soft-invalidate only — hard deletes stay user-panel-only).
- `wire.ts` — `toMemoryWireRow`, the boundary projection that strips internal
  plumbing (`vectorDocId`, access counters, attribution internals).

Policy blocks return structured results (`{ ok: false, reason: "disabled" |
"temporary" | "pii_blocked" | "not_found" | "backend_unavailable" }`);
caller programming errors throw.

### 2. Trust invariants (all surfaces)

- **Provenance `external`** — a new `MemoryProvenance` value for every
  API-surface write, ranked between `explicit` and `system` in retrieval
  veracity (0.85). The concrete surface is stamped in new unindexed row
  fields `sourceChannel: "plugin" | "mcp" | "rpc"` and `sourcePluginId`
  (no Dexie version bump — additive, unindexed).
- **Never procedural** — external writes may only create `semantic` /
  `episodic`; the pre-existing invariant that only `user`/`explicit`
  provenance may rewrite agent behavior is enforced in `storeMemoryCore`.
  An external edit of an existing procedural row's text or key sends it
  back to review instead (§9).
- **PII block gate** — external stores and text updates must pass
  `hasNoLeakingPii` (block-only; the redact option stays workflow-local
  because external callers cannot consent on the user's behalf).
- **Config gates** — `memory.enabled` gates everything; `temporary` blocks
  reads and writes (forget stays allowed — it only reduces data).

### 3. Plugin API — `ctx.memory` (manifest permissions `memory:read` / `memory:write`)

Follows the goal pattern (manifest-level `PluginPermission` + TS validator +
`cognia plugin lint` Rust parity in `cmd_lint.rs` + `createGuardedAPI`),
not the vector API-permission pattern, so grants are visible at install
review. `search/list/get/count` need `memory:read`; `store/update/forget`
need `memory:write` (not dangerous-tier — same as `goal:write`). Reads
degrade to empty when memory is off; `store` throws a typed
`PluginPiiError` on PII. No capability contract or bridge-map entry
(imperative API, like `goals`).

### 4. MCP bridge tools — scopes `memory:read` / `memory:write`, both default OFF

`memory_search` / `memory_list` (read scope), `memory_store` /
`memory_update` / `memory_forget` (write scope, forget flagged
`destructiveHint`). Registered in `registerMemoryTools`
(`lib/external-bridge/mcp-server/server.ts`), handlers in
`lib/external-bridge/handlers/memory.ts`, every call through `runWithGate`
(permission gate + audit log). Both scopes stay out of
`DEFAULT_ENABLED_SCOPES` — memories are distilled personal facts, the same
sensitivity tier as `rag:twin`. Settings toggles render automatically from
`ALL_BRIDGE_SCOPES`.

### 5. Companion RPC — six `/_rpc/memory_*` commands

All route through the desktop_writes_bridge to
`lib/companion/desktop-write-source.ts` arms (`sourceChannel: "rpc"`).
Classification: `memory_store`/`memory_update`/`memory_forget` are
`CONTROL_COMMANDS` (Wave 4.1 policy — every remote mutation of a powerful
surface is gated); `memory_list` is `READ_ONLY_COMMANDS`.
**`memory_search` is deliberately neither** — it updates
`lastAccessedAt`/`accessCount` (the recency signal), so idempotency-caching
it would reuse cached results without updating that recency signal. The mobile panel sends `memory_update` and
`memory_forget` through the durable `MOBILE_OUTBOUND_COMMANDS` queue, then
optimistically updates its local mirror only after enqueue succeeds. The
desktop remains authoritative and re-applies PII, governance, audit, and
vector-lifecycle rules. The sixth command, `memory_mutate`, carries the whole
management vocabulary and is what every paired client now sends (§8).

### 6. `/memory` manage command

`/memory` opens the console; `status` / `list [n]` / `forget <id>` manage it
from chat — the read/manage counterpart to `/remember`, whose `openMemory`
flag is now actually consumed (`ctx.openSettings("memory")`).

### 7. Learned-memory governance and namespace control plane (2026-07-19 amendment)

Dexie v118 adds `memoryEvidence`, `memoryJobs`, and `memoryAuditEvents` plus
governance indexes on the canonical `memories` table. Older rows are preserved
and explicitly backfilled as legacy/unreviewed/unknown rather than being sent
back through an LLM. Source evidence stores durable identities and hashes, never
raw transcripts. Extraction and session distillation use leased, retryable,
deduplicated jobs; backup/restore carries all four tables and remaps references
under duplicate imports.

Recall and learning are independent controls globally and per chat. Temporary
mode disables both. Turns containing Web, MCP, tool-search, screen, or connector
context are blocked from automatic learning by default; local code/file tools do
not contaminate a turn. If the user permits contaminated learning, the resulting
memory and evidence remain labeled `external-context`.

Learned memory supports `global`, `workspace`, `character`, and private `agent`
scopes with optional project, branch, and path restrictions. Readers resolve a
broad-to-narrow view where the narrowest stable-key definition wins; conflicts
are retained for review but excluded from prompt injection. Capacity and stale
memory maintenance run against the complete namespace rather than a whole scope.
Recall shares an explicit token budget across semantic, episodic, and procedural
memory and reports withheld/truncated counts to the chat runtime.

### 8. One responsive console, writes routed to the host (2026-10-11 amendment)

The console at `/memory` and the phone route (`/me/memory`) are two layout
shells over one state hook, `hooks/memory/use-memory-console.ts`: the same
tabs, quick views, facets, sorts, selection, URL `?id`, inspector, Undo and the
single delete confirmation. They stay two components only because the phone
route may not import the desktop console (the mobile route-boundary test); no
rule is implemented twice. Below `lg` the desktop console's inspector is a
controlled sheet, so a tablet or narrow Tauri window opens it instead of
silently dropping it.

Where a write lands is decided once, by
`lib/memory/control-plane/routed-manage.ts:memoryWriteAuthority()`:

- `"host"` when a remote host transport is active, or the runtime target is a
  companion (a browser opened on a headless brain host, a desktop driving a
  remote host, a paired phone);
- `"local"` otherwise — Tauri desktop, standalone web, and a standalone
  Capacitor phone with no host. It deliberately does not read
  `isCompanionShell()`: an unpaired phone has nobody to send the write to.

Every surface that changes memory (console, phone, conflict resolver, chat
memory chips, sources part, the context workbench panel, Settings → Danger
zone) calls `runMemoryCommand()` / `useMemoryCommand()`. On `"local"` that is
`manageMemory()`. On `"host"` the command is PII-gated (`redactText` +
`hasNoLeakingPii`) and queued as the outbound command `memory_mutate`
`{ command, operationId }` (the queue's idempotency key is the operation id),
and the local mirror is updated optimistically through
`applyMirroredMemoryCommand` — commands the mirror cannot reproduce (create,
restore-revision, retrieval feedback) wait for the host's row.

The host runs `manageMemoryForCaller()`: it parses the command strictly
(`command-wire.ts` never accepts an `actorId` or `commandId` from the wire),
checks the caller's namespace grants on every row touched and on any
destination namespace, narrows a `clear` to the rows the device may see,
replays through the operation ledger (kind `"manage"`), and records the
device as the actor. When the host answers, the outbound runner settles the
operation (`remote-outcomes.ts`): success schedules one follow-up `memories`
pull; a refusal rewinds the `memories` sync cursor (`rewindSyncTable`, which an
in-flight pull cannot overwrite), re-pulls the canonical rows and tells the
user why.

The management vocabulary gained `restore` (an archived memory back to active,
vectors re-upserted when PII-clean, audit `restored`) and `relocate` (move a
memory to another namespace; branch and path restrictions survive only within
the same workspace, audit `relocated` with from/to). Archive is immediate with
Undo; delete is the only action that asks first, from every surface — the
context workbench used to delete without asking.

### 9. Write authority holds per operation (2026-11-09 amendment)

A memory support audit (`docs/evidence/2026-11-08-memory-support-audit.md`)
found external and automatic writes that kept more authority than the caller
had. The rules below close them.

- **External edits of procedural memory need review.** `updateExternalMemory`
  (plugin, MCP, Companion `memory_update`) that changes a procedural row's
  text or key sets `reviewStatus: "pending_instruction"` in the same
  transaction, audits `external_procedural_edit_requires_review`, and returns
  `reviewRequired: true`. The row is excluded from injection until a person
  verifies it again from the console. Importance, tags and pinning keep the
  row's review state.
- **Consolidation obeys the operation ceiling.** Every surface that resolves
  an agent policy passes its `canUpdate` / `canForget` and scope check into
  `consolidate()`. A judge decision the caller may not perform (UPDATE,
  DELETE, or the target side of CONFLICT) never touches the target: the
  candidate lands as a review draft (`reviewStatus: "conflict"`,
  `conflictWithIds: [target]`) and the op reports `update_denied` or
  `forget_denied`. Create-only callers therefore cannot rewrite or archive
  existing rows.
- **The target is re-read where it is written.** The judge reasons about a
  snapshot taken before a model call. Each mutation re-reads its target in
  the transaction that writes it (joining a durable job's fence) and checks
  that it is still active, in the same namespace, and permitted for its
  current scope. Otherwise the candidate becomes a review draft with
  `target_moved` or `target_unavailable`. DELETE persists its replacement as
  a draft first and promotes it atomically with the invalidation, so a
  refused write cannot leave a live duplicate. Follow-up governance patches
  (store, project mining) are fenced the same way.
- **One layer per key reaches a prompt.** Stable-key precedence is resolved
  after eligibility and reader visibility and before the type and
  personal/project partitions, over the same candidate read the procedural
  block uses. An ineligible narrow row no longer hides its fallback, and an
  override and its fallback never appear together.
- **The operation ledger never guesses.** A same-key retry never takes over a
  pending key because a wait timed out: `storeExternalMemory` and
  `manageMemoryForCaller` re-reserve atomically and otherwise report the
  operation as still in flight. Companion maps exactly those two errors to a
  retryable `memory_operation_in_flight` (503). A key is released only when
  the command failed before its first canonical write. Commands whose
  canonical write is one Dexie transaction (update, pin, review, retrieval
  feedback, delete, restore-revision, invalidate, restore, relocate) commit
  their receipt in that transaction. `create`, `clear` and `resolve-conflict`
  cannot (consolidation spans model calls); after three failed receipt writes
  they raise `memory_receipt_commit_failed` and keep the key pending until the
  30-day prune rather than risk a second apply. A replay returns the full
  content-free result (`memoryId`, `version`, `clearedCount`, `piiRedacted`,
  `reviewRequired`), never memory text.
- **Workflow recall applies the reader filter.** `action.memory.recall`
  wraps its dependencies with the personal-visibility filter for the
  workflow run's verified readers; webhook and scheduled runs have none and
  do not see memories derived from personal-marked sources (ADR-0243 §5).

Deferred until ADR-0243 decides owner versus member devices: Companion
`memory_mutate` `update` / `review` still set `verified` for any paired
device (correct while a paired device is the owner's console), and
`sync_pull` mirrors the whole account memory profile regardless of
per-device memory grants. Plugin `ctx.memory.search` and MCP
`memory_search` are explicitly granted `memory:read` data APIs and keep
namespace-only filtering by contract.

## Consequences

- Three call surfaces share one gate/consolidation implementation — a PII or
  trust-model fix lands once in `lib/memory/api/`.
- The memory console can attribute and bulk-clean API-written rows via
  `provenance: "external"` + `sourceChannel`.
- Parity gates that must stay green when touching the surfaces:
  `rust-capability-parity.test.ts` (TS ↔ `cmd_lint.rs` permissions),
  `spec_parity.rs` (`KNOWN_COMMANDS` ↔ OpenAPI), the rpc.rs classification
  sentinels, and the en/zh-CN i18n key parity for the new scope/provenance
  strings.

## Out of scope (deliberate)

- **Twin-embedding coupling** — memory recall still borrows the twin's
  embedding/vector backend (`tryBuildMemoryDeps` → `tryBuildTwinDeps`); a
  user who never configured twin embeddings silently gets BM25-only memory.
  An independent memory-embedding config remains future work.
- **Cross-device audit sync** — canonical memories are part of the companion
  sync mirror, while evidence/jobs/audit history currently round-trip through
  encrypted app backup rather than live device sync.
- **Inbound IM content** continues to be excluded from memory writes by the
  provenance gate (read-recall only) — unchanged, by design.
