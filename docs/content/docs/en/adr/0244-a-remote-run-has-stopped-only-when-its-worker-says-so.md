---
title: "0244 — A remote run has stopped only when its worker says so"
description: "Stopping, pausing and recovering a run on another device name what is actually known: a stop is requested, confirmed or unconfirmed, and nothing else counts as proof. A worker fences itself when it loses its dispatch lease, so lease expiry plus a declared grace is proof. Same-host retry, cross-host retry and recovery at startup all wait for that proof, or hand the decision to a person. Revocation ends authority, never claims the process stopped, and an approval binds to the attempt it was raised for."
---

# ADR 0244 — A remote run has stopped only when its worker says so

**Status:** Proposed
**Date:** 2026-10-31
**Related:** [ADR-0113](./0113-agent-team-multi-host-remote-dispatch) (multi-host dispatch, the brain settles), [ADR-0136](./0136-cross-device-placement) (placement; its "Not done" list names the lease fence), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (phase B: lease-level fencing), [ADR-0245](./0245-a-paired-device-is-granted-workspaces-not-a-host) (workspace grants; revocation re-checks), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (execution runs and interrupts)

## Context

A durable Agent Team child can run on another device (ADR-0113). The brain claims a 60 s dispatch lease, renews it every 20 s and settles the child itself. What the brain can observe about the remote turn is less than what the code treats as known:

- **No stop vocabulary.** Nothing records "stop requested", "stop confirmed" or "stop unconfirmed". `durable-control.ts` writes the run `cancelled` (or `pausing`) before any child operation runs; if a child operation throws, the run stays `cancelled` with no completion and no trajectory event.
- **Remote pause does not interrupt.** `worker-rpc-pool.ts` implements pause as `session.waitForIdle({ timeoutMs: 30000 })` with no abort. A turn longer than 30 s leaves the child in `pausing`. Terminate (`turn/abort`, wait idle, close) is the only interrupting path, and its success is an RPC acknowledgement.
- **Disconnect does not stop the worker.** The Host sends no abort on `worker_detach`, and the stdio RPC server drains an admitted turn after EOF before closing the service (probe in the evidence ledger: `side_effect_after_eof` precedes `service_closed`).
- **A "safe" checkpoint is about the past.** `isStoredChildReplaySafe` (`packages/agent-orchestration/src/replay.ts`) requires the last checkpoint to be replay-safe and no unsettled tool intent. It says nothing about the tool calls the still-draining old turn makes next. The recovery probe shows a child whose last `Write` settled being failed by "connection closed" and then retried on `device:b` with no stop evidence.
- **Three recovery paths, three rules.** Cross-host `retryChild` requires a safe checkpoint; same-host retry does not (it stays pinned to the source host, where the old turn may still be draining). Recovery at startup (`coordinator.recover`) reads neither the lease nor host liveness.
- **No fencing token.** Renew and settle compare only the lease id, and a reclaim reuses `existingChild.dispatchLeaseId` when the lease expired without being cleared, so a stalled old holder can renew and settle again.
- **Revocation is not stop.** Revoking `agent.worker` closes the socket within a second; outbound frames are not re-checked in that window, queued children are judged only when a dispatch attempt runs, and pending interrupts from the revoked device stay pending.
- **Approvals are not bound to an attempt.** `ExecutionRunInterrupt` has no child or attempt field; a team-recovery approval freezes child ids at arm time and is applied to whatever attempt those children are on now.

## Decision

1. **Stop has three states, and only one is proof.** A stop or terminate request moves a child to `stop_requested`. It becomes `stopped` only on stop proof (decision 3). If the request fails, times out, or the control channel is lost first, the child is `stop_unconfirmed`: visible, never shown as stopped, and handled by a person or by later proof. The run is `cancelling` until every child is `stopped` or settled; `cancelled` is written last.

2. **Pause says which pause it is.** A worker that advertises `turn-interrupt-v1` pauses by aborting the current turn and checkpointing; otherwise pause is `pause_after_turn` and the UI says it waits for the turn to finish. A pause that cannot complete is `pause_unconfirmed`, never `pausing` forever.

3. **Stop proof is one of two things.**
   - **Acknowledged stop:** the worker reports the turn aborted and the session idle for this child and attempt.
   - **Self-fence expiry:** the worker advertises `worker-self-fence-v1` in its manifest `hardCapabilities`, the child's lease has expired, and the declared fence grace has elapsed since expiry.

   Tool results, a closed connection, a lease that expired on a worker without `worker-self-fence-v1`, or silence are not proof.

4. **A worker fences itself.** A `worker-self-fence-v1` worker holds each child's lease epoch locally. Before every tool call it checks that its last successful renewal is within the lease TTL. When renewal fails or the control channel is lost, it stops starting tools, aborts the turn within the grace, and records the abort for the next contact. The grace is declared in the manifest and measured before it becomes a release gate.

5. **The lease has a fencing epoch.** Every claim increments a monotonic `dispatchEpoch` on the child. Renew, settle, event advance and result projection compare the epoch, not only the lease id; a write from an older epoch is rejected and recorded. A reclaim never reuses an expired lease's identity.

6. **One recovery rule.** Same-host retry, cross-host retry and recovery at startup all require stop proof for the previous attempt, plus a replay-safe checkpoint. Without proof the child goes to `needs_input` with a `stop_unconfirmed` recovery item. First release offers no forced takeover that bypasses this rule.

7. **Revocation ends authority, not processes.** A confirmed revocation refuses new operations under that authority at once, including outbound frames. Queued children re-check authority at dispatch, and pending interrupts raised under it are expired. Revocation never moves a child to `stopped`; it starts the stop path in decision 1.

8. **Approvals bind to an attempt.** Interrupts carry `childRunId` and `dispatchEpoch`. A decision applies only while the child is still on that epoch, and a team-recovery approval re-validates each child's epoch before acting. Storage writes for decisions are compare-and-set on `status = pending`.

9. **The UI shows the evidence.** A recovery or retry offer names the previous attempt's state, the proof (or its absence) and the target. Disconnect is shown as "control lost; the remote run may still be running", not as offline-and-stopped.

## Consequences

- Retrying is slower when a worker vanishes: either the fence grace elapses or a person decides. This is the price of never running the same work twice on two hosts.
- Old workers without `worker-self-fence-v1` never produce self-fence proof. Their failures always need an acknowledged stop or a person.
- New wire fields: `dispatchEpoch` on dispatch, renew, settle and events; `childRunId` and `dispatchEpoch` on interrupts; the two capability names. Older clients keep working against the old semantics, refused where proof is required.
- The Attention items "stop unconfirmed" and "recovery choice" (milestone M1b of the cross-device workspace plan) are fed from decisions 1 and 6.

## Not done

- Tool-level idempotency keys. Arbitrary tool side effects cannot be deduplicated generically, so they are not a basis for recovery here.
- Forced takeover of an unconfirmed child.
- Grace and propagation numbers. They are measured on the macOS ↔ Linux box rig before any is written into a release gate.

## Alternatives considered

- **Brain-only proof (no worker change).** Refuse every retry without an acknowledged stop. Safe, but every network partition becomes a manual case; kept as the fallback for workers without self-fencing.
- **Treat lease expiry alone as proof.** Rejected: the EOF probe shows an admitted turn keeps running after its controller is gone.
