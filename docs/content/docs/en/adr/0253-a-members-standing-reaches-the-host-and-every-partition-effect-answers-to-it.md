---
title: "0253 — A member's standing reaches the Host, and every partition effect answers to it"
description: "On a multi-tenant Host a member's brain, turns, sandboxed runs, sockets and data all hang off their standing in the organization, but the Host only learns that standing by asking, caches the answer, and acts on a change only when a sandboxed run happens to re-check. This ADR makes the collaboration server push standing changes through a durable, resumable stream; gives the Host one standing authority that every path uses; defines what each kind of change does to live work; adds operator-only organization suspension; makes session ownership and purge durable; and decides what a Host restart does to a member's interrupted run. It also fixes the member device's single write path and splits the error codes a member can see."
---

# ADR 0253 — A member's standing reaches the Host, and every partition effect answers to it

**Status:** Proposed
**Date:** 2026-11-05

**Related:**
- [ADR-0149](./0149-a-person-is-not-a-device): users, organizations, workspaces, devices. This ADR adds an organization status and leaves the vocabulary unchanged.
- [ADR-0059](./0059-cloud-deployment-headless-brain): the headless brain and the multi-tenant `cognia-server`.
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who): who a run acts for. A member's run acts for that member; this ADR decides when it must stop doing so.
- [ADR-0215](./0215-one-person-one-encrypted-sync-space-many-writable-hosts): account sync. Section 9 records its boundary with the paired-Host channel.
- Plan: `docs/plans/2026-10-20-multi-user-organizations-permissions-and-rollout.md`. §7 (revocation), §9a (partitions), §9b (member turns) and the new §9c (this ADR's inventory and work packages).

**Evidence:** a code audit of the person-partition path on 2026-11-05 (Host crates, person brain, member client, collaboration server). Every gap below was read in the tree at `f88fad3a91` and its location is listed in plan §9c.

## Context

P5 and P6 gave each member of an organization their own partition on a multi-tenant Host: an encrypted data root, a brain process, a personal sandbox workspace, a usage ledger row and device bindings. Members chat with the organization's models and, where a conforming sandbox pool exists, run bundled agents in a sandbox.

All of that is authorized by one fact the Host does not own: the member's standing in the organization, which the collaboration server holds. The audit found that the Host treats that fact loosely.

- **The Host only pulls standing.** Device admission asks the collaboration server and caches the answer for 5 seconds. Execution asks again without a cache. The member list asks a third way. Role to capability is computed by `cognia-tenant-auth` in one place and by hand in others. Nothing tells the Host that a member left.
- **A departure does not stop live work.** Starting a brain checks no standing. A person brain's own requests skip standing. Only a sandboxed run re-checks, every 30 seconds. An unbound device's sockets stay open and are filtered frame by frame. Plan §7.5 says the Host cancels at its next lease boundary and records `revoked_during_run`. Nothing on the Host does that.
- **Ownership of a member's session is held in memory.** After a restart the map is empty, and an operator-scope control may claim a session id that belonged to a member. Observing an unknown id also records it permanently as operator-owned.
- **Purge is not durable.** It destroys the content key first, which is right. But a failure after that leaves the person admissible again, and it leaves the person's frames in the replay buffer for up to 24 hours and their rows in the usage ledger.
- **A restart orphans runs.** Leases and watchdogs exist only in memory. The binding records on disk carry no container, lease or session id, and the sandbox daemon kills an agent whose socket drops, so a run cannot be reattached. The brain's continuity is a transcript replay into a fresh agent.
- **Error codes are ambiguous.** `person_brain_unavailable` covers six different failures and all of them are retryable. `host_data_unpartitioned` is 403 in one place and 503 in another. `host_surface_forbidden` covers non-members, cross-partition sessions and unknown commands alike.
- **A member device has two write paths.** When the HostState channel is not ready, or a message has attachments, the client writes the user row locally and sends directly. The Host refuses that send, so the text is lost after the next transcript sync.

The collaboration server already has an organization feed, but it is an in-process broadcast with per-user grants. Its frames do not cross replicas, are lost while a subscriber is disconnected, and cannot be addressed to a Host. The collaboration server does not know which Hosts exist.

## Decision

### 1. One standing authority on the Host

Every Host path that needs a member's standing asks one service: device admission, execution admission, brain start, the member list, event audiences, organization-policy writes and the departure sweep.

- The caller says how fresh the answer must be: `Cached` (admission of reads and ordinary writes) or `Fresh` (execution, organization-policy writes, brain start after a change notice). There is no third path.
- Role to capability comes only from `cognia-tenant-auth`. The Host and the TypeScript client stop computing it by hand. The TypeScript twin in `types/identity/` stays a hand-written mirror, pinned by the existing parity tests over `protocol/collab-capabilities-v1.json`. Client code calls it instead of comparing roles itself.
- The answer distinguishes `member`, `not-member`, `org-suspended` and `unresolved` (collaboration server unreachable or malformed). Only `unresolved` is retryable.
- The cache is invalidated by section 2's stream, entry by entry or entirely.

### 2. Standing changes are pushed through a durable, resumable stream

The collaboration server writes a `standing_changes` row in the same transaction as every mutation that can reduce or change a person's standing:

| Kind | Written by |
| --- | --- |
| `offboarded` | `offboard_org_member`, removal from the organization |
| `role_changed` | `set_org_member`, `transfer_org_ownership` |
| `workspace_removed` | `remove_workspace_member`, and `set_workspace_member` when it lowers a role |
| `org_suspended`, `org_resumed` | section 4 |

Each row carries a monotonically increasing sequence, the organization, the user (absent for organization-wide kinds), the workspace when relevant, and the commit time.

The collaboration server serves `GET /internal/v1/standing-changes?after=<seq>` as a long-lived stream, authenticated by the internal service credential and filtered to the organizations that credential is scoped to. It sends the rows after the cursor, then live rows as they commit, and a heartbeat. Rows are kept for a bounded window. A cursor older than the window gets a `resync` frame instead of rows.

The Host subscribes at boot, stores its cursor in its data directory, and reconnects with backoff. A `resync`, a sequence gap or a reconnect after an outage flushes the whole standing cache and re-checks every active person with `Fresh`. While the stream is down, the 5-second cache and section 3's sweep keep correctness. The stream reduces latency; it is not the only safeguard.

Rejected alternatives:
- **Subscribing the Host to the existing organization feed.** Its broadcast is in memory, so frames are lost across replicas and while the Host is disconnected, and its grants are per user.
- **Postgres `LISTEN/NOTIFY`.** The Host does not connect to the collaboration database, so the server would have to forward it anyway, without durability.
- **A Host registry with collaboration-server callbacks.** It would make the collaboration server reach into every Host network and track Hosts it does not otherwise need to know.

### 3. What a change does to live work

| Change | Effect on the Host |
| --- | --- |
| `offboarded`, `org_suspended` | Cancel the person's tool-less turns and sandboxed runs; record each as `revoked_during_run` with an audit entry; stop the brain; close every socket of every device bound to the person; refuse new admission with `person_not_member` or `org_suspended`. |
| `role_changed` | Invalidate the person's cache entry. Turns keep running. Writes that need the old role (for example `org.policy.manage`) are refused at once because they ask `Fresh`. |
| `workspace_removed` | Cancel runs whose placement names that workspace, recorded as above. The person's other work continues. |
| `org_resumed` | Invalidate the organization's cache entries. Nothing restarts by itself. |

- Starting a brain asks standing. A person brain's own requests stay exempt from per-request standing, because the brain cannot outlive the standing that started it: a negative change stops it.
- A sweep every 30 seconds re-checks every person with an active brain or run, so a missed notice is bounded. It replaces the sandbox-only watchdog check and keeps that watchdog's other duties.
- Unbinding, suspending or revoking a device closes that device's sockets at once, in addition to filtering its frames.
- Output already produced stays in the partition, where purge (section 6) governs it. Effects already sent outside are shown as unresolved, never as rolled back, as plan §7.5 states.

### 4. Organization suspension

An organization gets a status, `active` or `suspended`. Only the deployment operator changes it, with `cognia-collab-server org suspend|resume <org>` and the matching operator route. An organization owner cannot suspend or resume their own organization.

While suspended, every member request to the collaboration server and to any Host answers `org_suspended` (403, not retryable), and section 3's effects apply. Partition data, organization credentials, usage and membership are kept. Resuming restores normal use. Deleting an organization stays in plan P7.

### 5. Session ownership is durable

The Host's security store gets a table that maps a session id to the partition that owns it, or to the operator. A member's first send binds it to their partition, and an operator control binds it to the operator. Both bind atomically before any await, as today. The table is loaded at boot. Observing an unknown session id while publishing no longer records an owner: an unowned frame is published unstamped, as an operator frame. Purge deletes the person's rows.

### 6. Purge is a durable state

Purge writes a `purging` state into the person's metadata before it does anything else. From then on brain start answers `person_purging` (409, not retryable), and a Host that restarts resumes the purge at boot.

The steps keep their order: stop runs and the brain; remove the workspace and execution records; drop the person's receipts; destroy the content key; remove the data root; remove the metadata. Purge also:
- drops the person's partition frames from the event bus replay buffer;
- removes the person's rows from the organization usage ledger;
- removes the person's session ownership rows (section 5);
- clears the brain's cached artifact key base.

Only the final metadata removal clears the `purging` state.

### 7. A Host restart reconciles member runs

At boot, before admitting members, the Host compares its execution records and its owned containers against live leases. There are none after a restart, so every member run found is terminated with the reason `host_restarted`. Its container is stopped, its record is retired, an audit entry is written, and its session shows a readable failure.

An organization may instead ask that interrupted turns resume. The organization agent policy gains `resumeAfterRestart` (owner or admin, like the rest of that policy). The operator sets the default with `COGNIA_PERSON_RESUME_AFTER_RESTART`, which is off unless set. When it is on, the person's brain starts a fresh agent in the same personal workspace, replays the transcript as history, marks the transcript that the turn is being retried because the Host restarted, and dispatches the interrupted user turn again. This is at-least-once: a tool effect the first attempt already made may be made again. The marker tells the member so.

Reattaching the original agent is rejected. The records hold no container, lease or ACP session id, the sandbox daemon terminates an agent when its socket drops, and no bundled agent is driven through ACP `session/load` today. Making all three hold would change the sandbox daemon and every agent adapter for a case that the replay covers.

### 8. Errors a member can see are distinct

Each code has one meaning, one HTTP status and one retry flag. They live in the protocol catalog, and the client's diagnostics and both locales map every one of them.

| Code | Status | Retryable | Meaning |
| --- | --- | --- | --- |
| `person_not_member` | 403 | no | The person has no standing in the organization. |
| `org_suspended` | 403 | no | The organization is suspended (section 4). |
| `session_partition_mismatch` | 403 | no | The session belongs to another partition or to the operator. |
| `host_surface_forbidden` | 403 | no | The command is outside what this principal may call. |
| `person_purging` | 409 | no | The person's partition is being purged. |
| `person_brain_starting` | 503 | yes | The brain did not become ready in time. |
| `person_brain_stopping` | 503 | yes | The fleet or this brain is stopping. |
| `person_brain_capacity` | 503 | yes | Unchanged. |
| `person_brain_busy` | 409 | yes | Unchanged: purge refused while a turn runs. |
| `person_storage_failed` | 500 | no | Metadata, key or data-root I/O failed. |
| `host_authority_unavailable` | 503 | yes | Standing could not be resolved. |
| `host_data_unpartitioned` | 403 | no | This Host keeps no person partitions. One status everywhere. |

`person_brain_unavailable` is retired.

### 9. A member device has one write path

On a person partition, every member write goes through HostState intents. If the channel is not negotiated yet or its snapshot is not confirmed, the intent waits in the outbox and is sent when it is. It never falls back to a direct send, and the user row is never written before the Host accepts the intent. When an intent cannot be sent at all, the device shows the refusal and returns the text, with its attachments, to the composer.

`message.enqueue` carries attachment references. The device uploads through the existing session attachment upload channel into the member's partition, and both member turn kinds receive them.

Account sync (ADR-0215) and the paired-Host channel both replicate sessions, messages, characters, skills, memories and settings. They serve different audiences: account sync replicates a person's own devices end to end, and the paired-Host channel serves a device the Host's data. A member device on a multi-tenant Host takes the partition's data only through the paired-Host channel. Retiring either pipeline is a separate decision.

### 10. Usage is never lost and is priced

- A member turn's usage row is written through a durable outbox and retried. A failed write is never only logged.
- When an agent reports zero input tokens, the brain books the gateway ledger's figure for that turn instead.
- An organization model's deployment profile may carry input and output prices. Without them the built-in catalog is used by model id. Without either, usage is shown as unpriced, never as free.

### 11. A long live reply keeps streaming

A member's live reply (`transcript://live`, and a shared run's live frames under ADR-0241) used to stop once it passed the 200 KiB frame budget: a growing text part was resent whole, and the periodic keyframe could no longer fit. The frame contract (`protocol/transcript-live-frame-v1.json`) gains two rules, checked the same way by the codec, the Host bridge and the collaboration server:

- A patch may carry `extend`: text appended to the kept part at `base`, with `parts` replacing what follows it. A streaming text or reasoning part costs its new characters.
- `settled` may be a patch. A keyframe too large to send gives way to a patch, so a device that is following draws the reply to its end. A device that missed a frame, or joined after the reply outgrew keyframes, drops the reply at `settled` and reads the transcript.

A frame is still never over 200 KiB. When even the patch is too large, the reply ends with `reset`, as before.

## Consequences

- A departure, a demotion or a suspension takes effect within one stream round trip, and within 30 seconds if the stream is down.
- The Host keeps one more durable cursor, one more security-store table and one more metadata state. A Host older than this ADR is not supported against a newer collaboration server or client. Releases ship together, and the old-Host fallbacks in the client are removed (plan §9c).
- A restart costs members their in-flight turns unless their organization turned resumption on, and then may repeat a tool effect.
- The collaboration server gains an organization status, an outbox table with bounded retention, one internal stream route and two operator commands.

## Dormancy

None of this ADR is dormant. `resumeAfterRestart` defaults to off. That is a setting, not dormant code: both branches are live and tested.
