---
title: "0255 — Runs that share a directory keep their diffs and lose Undo"
description: "Several runs may write the same directory at once. The Host cannot tell which run wrote which file, so every run whose lifetime overlaps another on that directory keeps a readable diff and gives up Undo. A stop that cannot be proven does the same to its own turn and leaves the directory usable. Only a whole-directory restore needs the directory to itself. Hashed write receipts from the built-in file tools later give Undo back, file by file."
---

# ADR 0255 — Runs that share a directory keep their diffs and lose Undo

**Status:** Proposed
**Date:** 2026-11-11

**Related:**
- [ADR-0086](./0086-task-scoped-resource-workspaces): TaskRun and PatchSet, the capture this ADR constrains.
- [ADR-0111](./0111-managed-workspace-registry-and-bundle): managed roots stay the default way to isolate agents. Unchanged.
- [ADR-0227](./0227-agent-changes-integrate-through-one-host-queue): changesets and the integration queue. Unchanged.
- [ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so): stop proof for remote workers. Unchanged; this ADR covers in-app runs that have no such proof.

**Evidence:** plan `docs/plans/2026-11-11-change-lifecycle-stopgap-and-history.md` §2 (source facts checked on 2026-11-10 and 2026-11-11) and §4, §6. It replaces `docs/plans/2026-11-10-change-lifecycle-convergence.md`, whose W02 proposed exclusive root reservations.

## Context

A turn's diff is the difference between the directory at begin and at settle. Undo merges that difference back out.

- **The diff covers the whole directory.** Settle compares every tracked path against the baseline. It does not filter by which paths the run touched.
- **Nothing records who wrote a file.** The built-in write tools and the Claude SDK path report no per-run write to the Host. The one tool-time command carries a path and no hash, and only the Codex and SIWC adapters call it. The hashed receipt channel exists and has no production caller.
- **Today the second run is refused.** When a run already observes a directory in place, a second in-place run on that directory, or on a parent or child of it, fails at begin.
- **People share directories anyway.** A parent agent and its sub-agents, two chat sessions on one repository, Squad teammates without isolated worktrees, and editors or other CLI agents outside Cognia all write the same directory at the same time.

With two runs active, each run's diff contains the other's changes. Undo of one run then removes work the other run did. The earlier plan answered this with a durable reservation per physical root, registered participants and a fixed lock order. That keeps attribution exact by forbidding the sharing people rely on.

A second gap sits beside it. After a cancel or a timeout, an in-app executor may still be writing. ADR-0244 gives remote workers a stop proof. In-app runs have none, and holding a directory until a proof arrives would lock a user's repository after one timeout.

## Decision

### 1. Sharing a directory is allowed

A run may begin on a directory that another run is observing. Begin no longer refuses for that reason. Managed roots remain the way to get exact attribution, and nothing here changes them.

The existing refusal for a directory that intersects a remote run whose stop is unconfirmed stays (ADR-0244).

### 2. Overlap makes a turn read-only

Two runs **overlap** when both are running or settling on directories where one equals, contains or is contained by the other. The Host marks both runs when it sees the overlap: at begin, when an Apply or Undo writes into a directory that has an active run, and when it admits an executor that runs there without a capture of its own. The mark is stored on the run and is never cleared.

A marked run settles into a patch that is not reversible, with the reason `overlap`. The diff stays readable. Undo and snapshot restore from that patch are refused with the reason shown.

A parent agent and the sub-agents of the same turn share one capture and do not overlap.

Writers outside Cognia cannot be seen. Undo already merges three ways and reports a conflict when the file no longer merges; that remains the only protection against them.

### 3. An unproven stop makes its own turn read-only

When an in-app executor is cancelled or times out and its completion signal does not arrive in time, the turn still settles so its diff is kept. Its patch is not reversible, with the reason `stop_unproven`. The directory is not held: the next turn may begin there and takes its baseline from the disk as it is.

Remote worker runs keep the confirmation flow of ADR-0244.

### 4. Only a whole-directory restore needs the directory to itself

Restoring a snapshot replaces everything in a directory. It runs only when no run is active on that directory, its parents or its children, and begin is refused while it runs. The restore builds the new contents in a staging directory first and swaps them in only when complete.

No other operation takes a directory exclusively. There is no durable root reservation, no participant registration and no cross-root lock order.

### 5. Write receipts give Undo back, one file at a time

The built-in file tools (write, edit, apply-patch) report a receipt for each write: run, path, hash before and hash after. A patch file gains its own reversible flag.

In an overlapped run, a file is reversible when the run's receipts explain its whole change: the first receipt's before-hash equals the baseline and the last receipt's after-hash equals the content at settle. Every other file in that patch stays read-only.

Shell commands, MCP tools and external agents produce no receipt. Their writes in an overlapped run stay read-only. A path-only event is not a receipt.

This step ships after steps 1 to 4.

## Consequences

- Two sessions on one repository both work, and both lose Undo for the turns that overlap, until receipts land. After that they lose it only for files written by a shell command or an external agent.
- A reason accompanies every non-reversible patch (`capacity`, `stop_unproven`, `overlap`, `path_unsupported`, `fidelity_unknown`), so the UI can say why Undo is off.
- A late write after an unproven stop lands in the next turn's baseline. That turn's diff is correct; the cancelled turn's diff may be incomplete, and it says so.
- Attribution inside an overlap is never guessed. Changes are not assigned to the last agent or the closing message.
- Runs that need exact attribution and full Undo use a managed root.

## Not done

- Exclusive reservations, participant sub-leases and quarantine of in-app directories. Reopen if a writer must be kept out of a directory for safety and not only for attribution.
- Receipts for shell commands and external agents.
- Detecting writers outside Cognia.
