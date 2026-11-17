---
title: ADR-0114 — Unified chat message presentation
description: "Use presets and session overrides to control message presentation. Show accurate run metadata, reveal technical details progressively, and keep message controls under host ownership."
---

# ADR-0114 — Unified chat message presentation

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Builds on | ADR-0057 — Chat rendering completeness |

## Context

ADR-0057 made rich chat parts complete, but presentation policy remained distributed across the message renderer, the standalone agent-flow setting, mobile actions, and transcript surfaces. Assistant identity, model provenance, timing, usage, actions, and technical parts therefore had inconsistent visibility. Historical messages could also be mislabeled if a renderer inferred their model from the session's current selection.

## Decision

### One resolved presentation contract

Global settings store `MessageDisplayPreferences`. A `ChatSession` may add `messageDisplayOverride`. `resolveMessageDisplayOptions` is the only precedence boundary and produces the complete renderer contract. Its presets are `focused`, `balanced`, and `inspector`. The default is `balanced`. Legacy `agentFlowMode` remains a read fallback for old settings, while new writes go through the unified preference.

The preference is classified as shared settings. Ordinary branches, SDK forks, desktop, Web, and Capacitor therefore retain the same presentation unless a session explicitly resets to inheritance.

### Host-owned shell, extension-owned bodies

`MessageShell` owns layout, semantic identity/time, live or completed status, available runtime details, and footer placement. Existing renderers continue to own Markdown, reasoning, tools, sources, files, artifacts, A2UI, subagents, diagnostics, and plugin bodies. Plugins keep part, tool, and extension slots but cannot replace the host's complete message chrome.

`focused` minimizes technical detail, `balanced` uses automatic disclosure, and `inspector` expands the available trace. Errors, approvals, diagnostics, unknown parts, attachments, artifacts, and security-relevant state remain reachable under every preset. Unknown raw parts are recursively redacted and capped before display.

### Honest immutable run metadata

New assistant turns may persist `metadata.run` with the actual resolved `providerId`, `modelId`, `startedAt`, `completedAt`, `durationMs`, and reported `finishReason`. Built-in, external-agent, and team paths stamp only values known at generation time. Existing `metadata.usage` remains the source for token, cache, and cost metrics.

Old or imported messages are not rewritten, and missing fields are omitted. Renderers never fall back to the session's current model for historical attribution.

### Shared commands and stable rendering

`resolveMessageActionCommands` supplies one capability and safety model to desktop controls, keyboard/overflow menus, and the mobile long-press sheet. Copy and More are stable in the default preset; edit and retry stay directly reachable when available; destructive actions retain confirmation.

Motion uses `motion/react` and is limited to structured block entrance, status, menus, and disclosure. Global or OS reduced-motion overrides message preferences. Streaming and finalized Markdown share geometry and policy, and the streaming caret occupies zero layout width. Virtualized transcripts invalidate row measurements when resolved presentation changes without repinning a reader who has scrolled away from the bottom.

## Persistence and compatibility

The settings and session fields are optional JSON properties, and run data stays inside the existing message metadata blob. No Dexie schema or historical rewrite is required. Session branches copy the optional override; sessions without one continue inheriting global settings.

## Consequences

- Message information density is predictable and configurable without forking rich-part renderers.
- Historical provenance remains truthful, at the cost of leaving unavailable legacy fields blank.
- New presentation options must be added to the resolver and its tests before renderers consume them.
- Plugins remain compatible but cannot take ownership of the whole message shell.

## Amendment — 2026-11-17: the turn fold, one render context, placed actions

Recorded by the chat-surface overhaul (`docs/plans/2026-11-16-chat-surface-overhaul.md`, D10 and D12).

### The turn fold

A finished turn folds its process into one "Worked for …" row (`TurnProcessFold`, in place since `4ad63e3941`). `foldTurnParts` (`lib/chat/turn-fold.ts`) decides which parts are process: tool calls and reasoning before the conclusion. The row is the disclosure only:

- Closed, it is one muted line, so the conclusion under it reads as the answer.
- Open, it shows the turn's tool calls as plain rows. A tool group inside the fold drops its own header, because the fold already is the group.
- Its body mounts only while open, and open/closed is remembered per message (`lib/chat/disclosure-memory`), so a virtualized list that scrolls it away and back keeps the reader's choice.

A turn a paired device reads from the Host draws the same row from the turn's activity summary, before its detail is loaded ([ADR-0257](./0257-a-remote-reader-folds-the-hosts-transcript-without-its-detail) §4). Opening it fetches the turn, whose messages bring their own folds.

### One render context

`MessageRenderContext` (`lib/chat/message-render-context.ts`, provider in `components/chat/message-render-context.tsx`) supplies what every message row needs: characters, row actions, `canMutate(id, kind)`, the project root, the resolved display settings, the shell's long-press sheet, and the commands a surface allows.

- `MessageList`, `TranscriptMessageList`, `CompanionTranscriptMessages` and the phone's `RemoteSessionDetail` provide it. A prop on the row still wins.
- Nested providers merge: inner keys win, while `canMutate` and `allowedCommands` only narrow. An empty value passes the parent through, so a scope that narrows nothing re-renders no row.
- `MessageRenderer` re-provides its resolved display settings, so Markdown nested inside a message draws with the transcript's settings.
- The shell supplies the sheet component; the chat surface never imports a mobile shell.

### Placed actions

`resolveMessageActionCommands` gives every command a placement, `bar` or `menu`, and returns them in one order, the bar's first. The desktop hover bar, its "…" menu, the always-visible bar and the phone's long-press sheet all draw from that one list, and `useMessageCommands` holds the work the commands share. Plugin items join the message's own "…" and the sheet, after a separator. A surface passes `allowed` for the commands it can carry out. A paired device reading the Host's transcript allows copy, share, share card, bookmark, read aloud and select text. It adds edit, resend and regenerate only when the Host runs them as branches (ADR-0257 §6).
