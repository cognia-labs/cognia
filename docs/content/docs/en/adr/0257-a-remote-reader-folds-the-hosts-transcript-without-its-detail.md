---
title: "0257 — A remote reader folds the Host's transcript without its detail"
description: "Paired devices read a conversation the Host holds through three read-only transcript calls: a capability handshake, a paged timeline of folded turns, and the detail of one turn on demand. A folded turn carries display-safe previews and, from protocol 2, an activity summary under 1 KiB, so a phone draws the same fold row as the desktop without fetching tool inputs, results or reasoning. Revision notices name the turns a write changed, each turn has its own version, and cursors are keysets the Host alone reads. The in-flight turn is drawn once, a member agent's reply arrives as live frames, and edits and regenerates go through HostState, never through the transcript calls."
---

# ADR 0257 — A remote reader folds the Host's transcript without its detail

**Status:** Accepted
**Date:** 2026-11-17

**Related:**
- [ADR-0114](./0114-chat-message-presentation): the fold row and message actions a remote turn reuses.
- [ADR-0127](./0127-chat-render-transport-efficiency): Companion frame batching, which carries the revision notices and live frames.
- [ADR-0241](./0241-a-shared-run-streams-to-its-members) and [ADR-0253](./0253-a-members-standing-reaches-the-host-and-every-partition-effect-answers-to-it): the live-frame format (`transcript://live`) a member agent's reply uses.
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds) §4: `HOST_UNAVAILABLE` when the Host's brain is not connected.

**Plan:** `docs/plans/2026-11-16-chat-surface-overhaul.md`, decision D12 and steps 3.7, 4.6, 6.2b and 6.5.

## Context

The transcript protocol shipped in 2026-08 (`9ca43bb0d6`) with no ADR. It lets a paired browser or phone show a conversation the Host stores without copying the conversation to the device. The chat-surface overhaul changed it in four places:

- **Freshness (step 4.6).** A reply streaming into one turn invalidated every turn the reader held, and page cursors were row offsets that drifted while the session grew.
- **Branches and authors (step 3.7).** A folded turn showed whichever reply was stored last, not the one the reader selected, and expanded messages lost who wrote them.
- **Folded turns (step 6.5).** A folded turn was its text preview alone. A phone could not tell that a turn had run tools, so it could not draw the fold row a desktop draws.
- **The in-flight turn (steps 3.7 and 6.5).** The phone drew the running turn twice, from its own stream and from the timeline, and never saw a member agent's reply live.

This ADR records the protocol as it stands after those changes. The contract is `packages/plugin-contract/src/types/agent-config/transcript.ts`; the Host projection is `lib/chat/transcript/projection.ts`.

## Decision

### 1. Three reads, no writes

| Call | Answers |
| --- | --- |
| `transcript_capabilities` | The protocol version and the page, byte and media limits (`transcriptCapabilitiesV1`). |
| `session_timeline` | A page of timeline items, newest first by default (default 30, at most 100). |
| `session_turn_messages` | The full messages of one completed turn, by `turnKey`, at the `revision` and `detailRevision` the reader saw (default 100, at most 200 messages and 2 MiB a page). |

A timeline item is one of:

- **`completed-turn`**: the user messages and the final reply as `TranscriptMessagePreview` (text and media references only; tool inputs and results and reasoning are omitted), the counts of what is folded (`collapsed`), the branch groups (`branchSummary`) and, from protocol 2, the activity summary (§4).
- **`active-turn`**: the running turn's full messages.
- **`system`**: a system message preview.

The protocol is read-only. Writes go through HostState (§6). Errors are `TranscriptProtocolError` codes; `TRANSCRIPT_STALE` tells the reader to read the newest page again.

### 2. Versions and cursors

- `TRANSCRIPT_PROTOCOL_VERSION` is **2**. Version 2 adds only the activity summary, which a reader draws when present, so a client accepts a Host that answers 1 or 2 (`lib/sync/session-history.ts`).
- Cursors are opaque to the client and read only by the Host that issued them. Their format has its own version (`TRANSCRIPT_CURSOR_VERSION`, 1), so a protocol bump that leaves the cursor alone keeps every cursor valid.
- A backward timeline cursor is a keyset, `(createdAt, id)` of the oldest row on the page, not a row count from the newest edge. It stays valid while replies stream in at the newest edge. A cursor in the older `position` form reads as stale, and the reader starts again from the newest page.

### 3. Freshness by turn

- Every transcript write publishes `transcript://revision` with the session's new `revision` and, when the writer can name them, the `turnKeys` it changed (at most 16; `TRANSCRIPT_REVISION_TURN_KEYS_MAX`). A notice with no keys means "any turn may have changed", as before keys existed. Notices carry ids only, never content.
- Each completed turn has its own `detailRevision`, `transcriptTurnVersion` over its rows' ids and their durable per-write stamp (`syncRevision`). A write elsewhere in the session, or a reply streaming into another turn, leaves it unchanged, so a reader keeps a turn's fetched detail across session revisions.
- On a notice that names its turns, the controller (`lib/chat/transcript/controller.ts`) re-reads only the newest page and splices it in. Older items keep their place and their cursor, and an expanded turn reloads only when its `detailRevision` changed. Anything the splice cannot prove equivalent to a whole re-read falls back to one, as does a notice with no keys.

### 4. A folded turn carries its activity

`CompletedTurnTimelineItem.activity` (`TranscriptTurnActivity`) says what the turn did on the way to its answer:

| Field | Meaning |
| --- | --- |
| `toolCount`, `failedCount` | Tool calls, and those that ended in an error. |
| `tools` | Up to 8 tools by name (each name at most 64 characters), with their counts and failures, in order of first use. |
| `reasoningCount` | Reasoning parts. |
| `sourceCount` | Citations and source documents the replies carry. |
| `runDurationMs` | The sealed run's recorded duration, when it has one. |

- The Host counts the replies of the thread the reader selected (§5), the same messages the previews come from. It drops tools from the end of the list until the summary is under `TRANSCRIPT_ACTIVITY_BYTE_LIMIT` (1 KiB) as JSON.
- A turn whose replies called no tool and did not reason has no `activity`, because such a turn has no fold row locally either.
- The reader stamps the summary onto the preview it renders (`lib/chat/transcript/turn-activity.ts`). `MessageRenderer` draws it as the same `TurnProcessFold` row a local turn uses, with its duration and a detail line (tool names, sources). Opening the row asks for the turn's detail through `expandTurn` in `MessageRenderContext`; it does not open an empty fold.

### 5. The selected branch, and who wrote it

- The Host applies the same visibility rules as the chat store (`visibleThread` in `lib/chat/branch-visibility.ts`) with the session's `activeBranchByGroup`, so a folded turn previews the reply the reader picked, and its activity counts that reply.
- Full messages (`TranscriptMessage`, in active turns and turn detail) keep `senderId`, `senderKind` and the shared-session `collaboration` record. The reader hoists them into message metadata, as `rowToUIMessage` does locally, so a team member or a shared-room author is named the same way on both sides.

### 6. The in-flight turn, and writes

- **Drawn once.** The phone streams the turn it started over its own session stream and also reads it from the timeline. `withLiveTurn` (`lib/chat/transcript/live-turn-view.ts`) drops the timeline's copy of whatever the stream tail draws.
- **A member agent's reply** runs in the member's person brain, never in the Host's sidecar, so no session stream carries it. The brain sends it as `transcript://live` frames (format in ADR-0241 and ADR-0253). The phone subscribes (`useTranscriptLiveTurn`) and draws the live reply in place of the timeline's older copy until its timeline has read past the frame's `afterRevision`.
- **Writes are HostState actions.** A paired device edits, resends or regenerates with `message.enqueue` carrying `branch` (`HostStateMessageBranch` in `packages/plugin-contract/src/types/agent-config/host-state.ts`). The Host turns it into the desktop's branch: the replaced replies or question stay as siblings, and the turn's prompt is rebuilt from the Host's stored rows. A client offers these only when the Host advertises `host_state_message_branch` and the device controls the conversation; an older Host's closed guard refuses the field.

## Consequences

- A phone draws a Host conversation with the desktop's fold rows and branch choice, and fetches a turn's detail only when the reader opens it. A folded turn costs its previews plus at most 1 KiB.
- A client built before protocol 2 refuses a version-2 Host's handshake (it accepted exactly 1), so it must be updated with the Host. The cost was accepted with D12: the summary needed a version a reader could detect.
- A new field on a timeline item needs a protocol version a reader can detect, unless every reader already ignores it. `protocol/companion-response-schemas.json` leaves `TranscriptTimelineItem` open, so the Rust bridge passes new fields through unchanged.
- Changing `transcript.ts` or `host-state.ts` changes the plugin contract, which invalidates the authoring kit pin (`lib/plugin/distribution/authoring-kit.json`). Kit `e0fbfe49147e` carries both changes.

## Not decided here

- Per-tool elapsed times on the phone: the activity summary carries counts, not timings.
- One live reducer for the desktop, the phone and the paired browser: the three folds take different inputs (SDK events, external-agent events, live-frame patches), so merging them would change the protocol (plan step 5).
