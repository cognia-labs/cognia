# Chat surface overhaul: reading area and Composer

Status: converged design (grill 2026-11-16), not started.

## Goal

Make the chat reading area and the Composer fast, consistent and calm across every place they run: browser, Tauri desktop, Capacitor mobile, local sessions, sessions on a paired Host, and shared runs. One rendering pipeline with thin per-surface adaptation, measured performance before and after, and no dead code left behind.

Non-goals: a visual redesign (the ADR-0114 language stays), migrating the rest of `lib/claude` (the chat layer only, see D5), replacing either Markdown engine, the TUI, a CI performance gate, renaming wire or storage keys (`claudeAgentSdk` and friends).

## Facts the design rests on

Six read-only audits and one benchmark (2026-11-16). Line numbers are as of `dev` at `441d0e684f` plus the uncommitted tree; re-check before editing.

**Rendering stacks.** Every live surface draws a message with `MessageRenderer` / `renderPart` (`components/chat/message-renderer.tsx`). Around it:

| Divergence                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three list shells pass different props: `MessageList`, `TranscriptTimelineSurface`, `TranscriptMessageList`; the phone's `remote-session-detail.tsx` passes only `messageDisplay` (no characters, copy/edit/regenerate, long-press, refused-host messages) | `remote-session-detail.tsx:192`, `companion-transcript-messages.tsx:162-172`                                                                                  |
| Two Markdown engines with drifted features: streaming has no heading ids, LaTeX preprocessing, `diff` fence, `onOpenProjectFile`; passing our rehype list replaces Streamdown's defaults, so `rehype-harden` is off                                        | `streaming-fence-renderers.tsx:142-144`, `streaming-text-part.tsx:304-377`                                                                                    |
| Reasoning builds its own Streamdown options without the fence renderers                                                                                                                                                                                    | `message-renderer.tsx:2508-2530`                                                                                                                              |
| Nested `MarkdownRenderer` calls ignore display settings (subagent answer, canvas inline, MCP content, wiki card, file preview, async questions, selection result, `ai-elements/tool.tsx`)                                                                  | `subagent-part.tsx:189` and 7 more                                                                                                                            |
| A text part containing an @mention loses all Markdown                                                                                                                                                                                                      | `message-renderer.tsx:2416-2423`                                                                                                                              |
| `FinalizedLongTextPart` renders 8-block groups as separate trees: heading-id dedupe restarts, cross-group footnotes/reference links break                                                                                                                  | `streaming-text-part.tsx:207-231`                                                                                                                             |
| Export/share keep their own part switches; a2ui, artifact, canvas, subagent and `sources` are dropped; shared HTML only renders inline Markdown                                                                                                            | `lib/export/html/beautiful-html.ts:119`, `lib/export/text/rich-markdown.ts:170`, `safe-inline-markdown.ts`                                                    |
| Five text extractors; mobile copy includes reasoning, desktop does not                                                                                                                                                                                     | `message-action-sheet.tsx:753`, `message-renderer.tsx:613`, `lib/chat/message-share.ts`, `lib/inbox/extract-plain-text.ts`, `ai-elements/conversation.tsx:94` |
| Share view renders visitor-facing `chat-md` without `untrusted`                                                                                                                                                                                            | `components/share/payload-view.tsx:616`                                                                                                                       |
| HTML export opens reasoning backwards                                                                                                                                                                                                                      | `beautiful-html.ts:125` vs `:139`                                                                                                                             |

**Local vs remote data.**

- Local: sidecar event → `applySdkEvent` mirror → post-processing (`claude-chat-events.ts:1270-1513`) → rAF commit → `MessageList`.
- Remote collapsed turns carry text and media only (`lib/chat/transcript/projection.ts:63-114`); tools, reasoning and sources appear only after expanding.
- The in-flight turn is likely drawn twice on remote surfaces: no caller passes `activeTurnKey`, so the unfinished turn returns as `completed-turn` beside the live tail (`desktop-message-source.ts:875,901`, `transcript-timeline-surface.tsx:356-395`). Not covered by a test.
- Expanded remote turns drop `senderId` / `senderKind` (`transcript-timeline-surface.tsx:95-107`), which `MessageRenderer` reads for room/team attribution.
- The phone's live tail runs a bare `applySdkEvent` (`hooks/data/use-remote-session-stream.ts`) without desktop post-processing; the phone never subscribes to `transcript://live`. Three live reducers exist.
- The Host ignores the selected branch for the final response (`projection.ts:193`); its `branchSummary` is never read; the `active-turn` timeline kind is never produced.

**Performance.**

| Hotspot                                                                                                                                                                                                                                                        | Evidence                                                                                                    | Measured                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| O(n²) diff on every SDK event                                                                                                                                                                                                                                  | `claude-chat-events.ts:1244`                                                                                | 3.65 ms/event at 2,000 messages; `Set` 0.08 ms |
| Every token sent twice (raw + canonical) and the batcher flushes on channel change                                                                                                                                                                             | `sidecar/src/host/events/envelope.ts:159-178`, `crates/cognia-companion-bus/src/event_batcher.rs:18`        | by reading                                     |
| `jumpToMessage` / `revealEarlier` change identity every frame → ~4 viewport-store writes per frame, timeline/run panel/usage panel re-render, idle reveal never fires while streaming                                                                          | `message-list.tsx:378,776`, `chat-viewport-store.ts:82-104`                                                 | by reading                                     |
| Streamdown `remend` rewrites the full text each render and breaks the incremental parser                                                                                                                                                                       | `incremental-markdown-blocks.ts:26`                                                                         | full reparse on 17–24% of frames               |
| Per-character ink spans stay on settled blocks                                                                                                                                                                                                                 | Streamdown ink                                                                                              | DOM 0.85 → 4.4 MB on a 50 KB reply             |
| Large fence re-highlighted per delta                                                                                                                                                                                                                           | `@streamdown/code`                                                                                          | 3–7 ms/delta vs 1.7 ms plain                   |
| ~10 full transcript passes per frame (`selectVisibleMessages` always allocates, `selectableKey`, find-bar index, `CompactBoundaryMarker` subscribing to all messages)                                                                                          | `chat-store.ts:2178`, `message-list.tsx:472`, `message-search.ts:65`, `compact-boundary-part.tsx:64`        | by reading                                     |
| Remote: every revision bump refetches the newest page and reloads expanded turns; Host projects each page twice; offset paging                                                                                                                                 | `lib/companion/desktop-message-source.ts:826,875,901`                                                       | by reading                                     |
| Composer: `canResume` runs `selectVisibleMessages` on every store write; every keystroke re-renders `ComposerBox`, `ComposerPopover` (18 hooks before its early return) and closed dialogs; inline parent callbacks re-render the toolbar and its layout reads | `composer.tsx:~4197`, `composer-popover.tsx:508`, `chat-view.tsx:978-1004`, `use-fitted-fold-tier.ts:83-98` | by reading                                     |

Markdown benchmark (CPU, renderToString / jsdom, Node 26): finished render is at parity (react-markdown 57 ms vs Streamdown static 66 ms at 50 KB); streaming Streamdown is 4–6× cheaper than re-rendering react-markdown per delta (p95 9 ms vs 62 ms at 50 KB) but grows 1.5 → 8 ms per delta over a long reply; with remend and ink off it halves.

**Composer bugs.** Enter/Esc/↑↓ check only `isComposing`, never `keyCode === 229`, so confirming an IME candidate on WebKit may send (`composer.tsx:~2930-2967`, needs device check). `#` project memory calls raw `invoke("memory_append")` on the local machine even when the session runs on a remote Host (`composer.tsx:1884,4606`, `lib/files/memory.ts:19-29`). Custom slash commands come from the active Host, not the session's bound Host (`composer.tsx:988-1001`).

**UX.** The turn reflows at completion (fold appears only after streaming, footer rows pop in: `message-renderer.tsx:571-577,1240-1349`); the mobile action sheet caps at `80vh` without inner scroll or safe-area padding and lists primary actions last (`message-action-sheet.tsx:418,705`); it lacks about half the desktop actions because `resolveMessageActionCommands` has no placement (`lib/chat/message-action-commands.ts:85-149`); tool-row actions cover result text on touch; tool rows have no focus ring; status is colour-only with raw palette colours; action bar never wraps; two "…" menus and a duplicate Reply; up to 10 chip rows per turn; `.touch-hit` unused; lazy-block placeholders use fixed heights; no search entry or timeline on mobile; touch-narrow browsers get desktop chrome because shells switch on `isNativeShell`.

**Dead code (grep-proven, no production importer).** `MCPToolCard` (keep `McpToolBodyOrContent`, `toolNameOf`); `ai-elements/confirmation.tsx`, `ai-elements/task.tsx` (and the untracked stories added for them), `Tool` / `ToolHeader` / `ToolContent` in `ai-elements/tool.tsx`; `messagesToMarkdown` / `ConversationDownload` in `ai-elements/conversation.tsx`; the `active-turn` timeline kind; `branchSummary`; `useFittedFoldTier`; `isCommandPinned`; default exports of `ChatColumn` and `useChatViewportStore`; test-only exports `VIRTUALIZE_THRESHOLD` (from `message-list.tsx`) and `thinkingMode`; unreferenced exported types `TranscriptTimelineLabels`, `MessageShellProps`, `MetadataDetailRow`, `TranscriptMessageListProps`; about 20 Composer helpers exported only for tests (drop `export`, test through the component). Not dead: `METADATA_FIELDS`, `session-host-prompt.tsx` exports (side-effect import).

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Scope: message reading area and Composer, all shells, local and remote. Visual language stays (ADR-0114); only where tool-call visuals diverge do I show 2–3 options for the user to pick.                                                                                                                                                                                                       |
| D2  | Platform adaptation switches on input capability and width (touch / narrow), not on `isNativeShell`. The native shell gates only native features (haptics, system share, Capacitor plugins).                                                                                                                                                                                                     |
| D3  | Dead code is deleted aggressively, including components reached only by stories or tests (with those stories/tests), each with grep proof in the commit body. `ai-elements` files in use are not modified internally; unused ones and unused exports go.                                                                                                                                         |
| D4  | Performance is accepted against a reproducible benchmark (see Verification), before and after, plus Tauri and Android device smoke. No CI gate.                                                                                                                                                                                                                                                  |
| D5  | Chat layer renamed to vendor-neutral names in this plan: `hooks/chat/*claude*` and the chat cohort of `lib/claude` (P4 rows of `docs/plans/2026-10-20-claude-directory-ownership-migration.md`). No forwarding exports: every import, test, mock path and gate config moves in the same commit. The rest of `lib/claude` stays with that plan. Wire, storage and settings keys keep their names. |
| D6  | Leftover uncommitted fixes in the files this plan touches are reviewed and committed by theme before anything else, never mixed into overhaul commits.                                                                                                                                                                                                                                           |
| D7  | Two Markdown engines stay (finished: react-markdown via `MarkdownRenderer`; streaming: Streamdown) behind one shared configuration object; the parity test moves from "shared semantics" to "same feature set".                                                                                                                                                                                  |
| D8  | `remend` applies to the trailing block only; settled blocks are never rewritten. Large fences are not re-highlighted on every delta.                                                                                                                                                                                                                                                             |
| D9  | Ink animation runs on the trailing block only; settled blocks render plain text. Off for long replies and under reduced motion.                                                                                                                                                                                                                                                                  |
| D10 | One `MessageRenderContext` supplies characters, actions, `canMutate(id)`, project root, resolved display settings and action-sheet capability to `MessageRenderer` and nested renderers; explicit props still override. List shells keep owning scroll, virtualization and data source.                                                                                                          |
| D11 | Export, share and text extraction: fix defects first, then one part-descriptor registry (`plainText(part, purpose)`, `markdown`, `html`, `shareable`) that exporters, extractors, share and copy derive from; purposes (clipboard, search, model context, redaction) are parameters.                                                                                                             |
| D12 | Remote timeline: collapsed turns gain an activity summary under 1 KiB (tool names and states, reasoning present, source count), with a `TRANSCRIPT_PROTOCOL_VERSION` bump; the in-flight turn is deduplicated; expanded turns keep `senderId` / `senderKind`; the phone's live tail reuses the desktop post-processing (three live reducers become one).                                         |
| D13 | Composer is split by responsibility into hooks and subcomponents; `ComposerInner` only assembles. Behaviour unchanged; existing tests keep passing.                                                                                                                                                                                                                                              |
| D14 | Turn fold: each tool/reasoning segment folds into the process row as it settles; only the running segment is open; the turn's final structure exists before it ends. Post-turn cards, chips and badges merge into one footer row with reserved space.                                                                                                                                            |
| D15 | Mobile text: long-press opens the sheet, "Select text" lives in it (current model). Fix clipping and missing actions; the hint becomes an overlay that takes no layout.                                                                                                                                                                                                                          |
| D16 | Order below; every step is its own commit (or a few by theme) and leaves `dev` releasable.                                                                                                                                                                                                                                                                                                       |

## Steps

Each step lists its scope, tests (Hard Rule 3: co-located, updated in the same change), i18n (Hard Rule 4: both locales, `pnpm i18n:build`), and whether it needs a changeset (Hard Rule 6). Gates per step: the touched suites via `pnpm test -- <paths> --runInBand`, `pnpm typecheck`, `pnpm lint:i18n`, `pnpm audit:colocated-tests`, `pnpm audit:modules` when imports cross modules. No full-suite or coverage runs.

### 1. Commit the leftover fixes (D6)

Review and commit, by theme, the uncommitted changes in files this plan touches. Themes found: code-block accessibility (`role="region"`, `tabIndex`), Shiki theme inputs (`chatCodeThemeInputs` in `streamdown-plugins.ts`, `ai-elements/code-block.tsx`), slash command output into the draft (`insertIntoDraft` in `composer.tsx` and the slash context), external steer failure not replayed, confinement roots remapped into bundle aliases, `startedAt` on the last send (failure latency, span end), timeline collapse counting tool parts (`projection.ts`), plus related tests, stories, `empty-state`, `room-participants-chip`, `rich-block-frame` and the `lib/claude` files (`build-options`, `ocr-tool-gate`, `provider-telemetry`, `routing-fallback`, `plugin-tool-dispatch-bridge.test`).

- For each theme: read the diff, run its suites, commit with `git commit --only <paths>`. A theme that does not stand (fails, half-done, unclear intent) is listed to the user, not committed or reverted.
- Untracked `ai-elements/{confirmation,task}.stories.tsx` stay out; step 8 deletes them with their components.
- Done when `git status` shows no uncommitted change in this plan's files except ones the user chose to hold.

### 2. Benchmark baseline (D4)

Build the measuring tools first, then record numbers on the unchanged code.

- **Node benches**, following `lib/connectors/outbound-runner.benchmark.test.ts` (env-gated, `--runInBand`). Run with `CHAT_BENCHMARK=1 node scripts/test/jest.mjs hooks/chat/claude-chat-events.benchmark.test.ts components/chat/streaming-text-part.benchmark.test.ts --runInBand`; a `benchmark:chat` script waits until `package.json` is not in flux under other sessions.
  - `hooks/chat/claude-chat-events.benchmark.test.ts`: per-token cost of `handleEvent` (real SDK adapter, `message_start` + text deltas) and of one forced commit, at 200 / 2,000 / 5,000 messages.
  - `components/chat/streaming-text-part.benchmark.test.ts`: Jest mocks Streamdown, so this bundles `tests/integration/fixtures/streaming-markdown-benchmark.tsx` with esbuild (the `markdown-renderer.heavy.test.ts` recipe) and runs the real `StreamingTextPart` in a jsdom root: 5-document corpus (short, 5 KB, 50 KB, 20 KB fence, CJK) in 20-char deltas, per-delta p50/p95 and p50 per quarter, streaming DOM size, plus a finished `MarkdownRenderer` render.
- **Browser bench**: reuses the existing opt-in `tests/e2e/mobile/chat-render-perf.spec.ts` (ADR-0127 tiers; `adr0127-long` is 2,000 messages; `CHAT_PERF_SHELL=web` selects the `web-chat-perf` project). Its open/scroll/heap/long-task test stays; a second `@perf streaming and typing` test plays a reply into the live store at one commit per frame (`__cogniaStreamReply`, `lib/dev/expose-test-globals.tsx`) and types 50 keystrokes into the Composer, recording frame gaps, long tasks, layout shift, transcript DOM size, and `PerfBoundary` commits for `chat:list`, `chat:message` and a new `chat:composer` (dev server only; production elides the Profiler). Timing on the static build (`test:e2e:build` + `PLAYWRIGHT_STATIC=1`), commit counts on a dev server.
- Output JSON; record the numbers in "Results". No changeset.

### 3. Correctness and security fixes

Each is small and user-visible; one commit per item, each with a regression test and a `patch` changeset.

1. Share view renders visitor-facing `chat-md` with `untrusted` (`components/share/payload-view.tsx`).
2. HTML export reasoning `open` flag (`beautiful-html.ts:125`). The exporters' hard-coded English labels (Thinking, You, Date, Model, Exported, Input, Output, …) move to i18n in step 6, where the part descriptors rebuild these exporters.
3. Streaming path restores `rehype-harden` (compose our rehype plugins with Streamdown's defaults instead of replacing them).
4. Composer IME: one guard `isComposingEvent(e)` (`nativeEvent.isComposing || keyCode === 229 || isComposing`) on Enter, Esc and history keys.
5. `#` project memory goes through the session's Host transport with the same availability verdict as `!` shell; paired browser and phone get it where the Host allows.
6. Custom slash commands are keyed to the session's bound Host (`session.hostBinding.origin`).
7. Remote: dedupe the in-flight turn (pass `activeTurnKey` from the Host, or drop the trailing `completed-turn` the live tail covers); keep `senderId` / `senderKind` / `collaboration` in `fullMessage`; the Host's final response follows the selected branch.
8. Mobile copy/quote/share use `buildMessageShareContent` (same text as desktop).

### 4. Hot-path performance

One commit per item, each with a test that pins the behaviour (identity stability, no reparse, call counts), `patch` changeset where users feel it.

1. `claude-chat-events.ts`: id `Set` instead of `some` inside `filter`; skip the diff for `stream_event` frames that keep every id; reverse index loops instead of copy-and-reverse.
2. `message-list.tsx`: `jumpToMessage` and `revealEarlier` read messages through a ref (stable identity); the viewport store stops churning; idle reveal fires during streaming.
3. `selectVisibleMessages` returns its input when no branch metadata exists; `canResume` (Composer) and `selectableKey` select primitives; find-bar search text cached per message in a `WeakMap`; `CompactBoundaryMarker` subscribes to its pane's messages and memoizes per boundary; `SharedRoomCatchUpCard` checks collaboration first.
4. Streaming Markdown (D8, D9): remend on the trailing block only, so the incremental parser reuses every settled block; ink only on the trailing block, settled blocks plain, off for long replies (threshold from the benchmark) and reduced motion; large fences highlighted on settle or throttled.
5. Sidecar → renderer and companion clients: stop emitting the raw copy of an event when the canonical copy carries it, or batch across channels so ADR-0127 batching holds. Which of the two depends on which consumers still need the raw channel; list them first, and if dropping a channel changes what any consumer receives, bring that choice to the user before coding. Touches `sidecar/`, `crates/cognia-sidecar/` and `crates/cognia-companion-bus/` (`sidecar:typecheck`, `audit:sidecar-architecture`, `cargo test -p cognia-sidecar -p cognia-companion-bus`).
6. Remote: the Host projects a page once; revision bumps refetch only what changed (the bumped turn), not the newest page plus every expanded turn; keyset paging (`createdAt`) instead of `offset`.
7. Composer render isolation: memo `ComposerBox` and `ComposerPopover` with stable props, mount the popover's search hooks only under a trigger, render `SaveAsTemplateDialog` only when open, stable callbacks from `ChatPaneContent` and memo `BottomToolbar`, cap the band stack by the visual viewport (`useKeyboardViewport`).

Re-run the benches after this step; record the numbers.

### 5. Rename the chat layer and split the large files (D5, D13)

Pure structure, no behaviour change. Mechanical moves first (one commit), splits after (one commit per extracted responsibility).

- Rename: `hooks/chat/use-claude-chat.ts`, `use-claude-chat-controller.ts`, `claude-chat-events.ts`, `claude-chat-send-options.ts`, `claude-chat-turn-tasks.ts`, `claude-chat-tool-hooks.ts` and their tests to `use-agent-chat*` / `agent-chat-*` (exact names fixed in the first commit); exported hook names follow (`useClaudeChat` → `useAgentChat`). Move the `lib/claude` P4 cohort to the destinations the migration plan lists (`adapter.ts` → `lib/chat/sdk-message-adapter.ts`, `citations.ts`, `compaction-undo.ts`, `dropped-capability-toast.ts`, `guild.ts`, `optical-archive-persist.ts`, `over-budget-toast.ts`, `run-record.ts`, `run-status.ts`, `sdk-subagent-bridge.ts`, `sidecar-info.ts`, `steer.ts`, `subagent-bridge.ts`, `subagent-tool-parts.ts`, `subagent-tree.ts`). Update every import, `jest.mock` path, gate JSON (`module-ownership.json`, baselines) and the migration plan's register (mark these rows done). `pnpm audit:modules` must pass; no forwarding exports.
- Split `use-agent-chat-controller.ts` (8,539 lines) by responsibility: send pipeline, steer/queue, external-agent rail, approvals, stream subscription, session lifecycle. The live reducer becomes one module that the desktop controller, the phone's remote stream and the paired-browser tail all call (D12 groundwork).
- Split `composer.tsx` (5,246 lines; `ComposerInner` ~3,300): trigger detection and popover, slash/`!`/`#` modes, templates, link and paste folding, attachments/OCR/video intake, draft and history, ghost text, `@` routing, IM platform mode, best-of-N, keyboard. Existing composer tests stay green; new hooks get co-located tests.
- No changeset (internal).

### 6. Convergence (D7, D10, D11, D12)

1. **One Markdown configuration**: a single module builds remark/rehype lists, components, fence renderers, URL transform and sanitize schema from resolved display settings; `MarkdownRenderer`, `StreamingTextPart` and reasoning all take it. Streaming gains heading ids, LaTeX preprocessing, a `diff` fence renderer and `onOpenProjectFile`. Display settings travel through `MessageRenderContext`, so nested renderers inherit them. Mentions render inside Markdown (a remark/rehype step) instead of replacing it. `FinalizedLongTextPart` keeps lazy sections but resolves heading ids and footnote/reference definitions across the whole message. Pet chat and the skill AI popup use the chat configuration. Parity test covers the feature matrix.
2. **`MessageRenderContext`** in `components/chat/message-render-context.tsx` (pure types in `lib/chat/`); the three shells and `remote-session-detail` provide it; the phone's remote view gains characters, copy/edit/regenerate where `canMutate` allows, long-press sheet and refused-host messages.
3. **Message actions** get a placement in `resolveMessageActionCommands`; the desktop bar, the "…" menu and the mobile sheet render from it (fixes the missing mobile actions, the duplicate Reply, the separate plugin "…").
4. **Part descriptors** in `lib/chat/parts/descriptors.ts`; HTML and rich-Markdown export, share, copy, inbox extraction and search derive from them; shared HTML renders block Markdown; exports stop silently dropping a2ui, artifact, canvas, subagent and sources (each gets a representation or an explicit "not exported" note). The vendored `messagesToMarkdown` path is deleted (D3). Every exporter label (role names, part headings, metadata terms) comes from i18n keys in both locales instead of English literals.
5. **Remote activity summary**: contract field in `packages/plugin-contract/src/types/agent-config/transcript.ts`, `TRANSCRIPT_PROTOCOL_VERSION` bump, Host projection fills it, `previewMessage` draws it as the same fold row local turns use. The phone subscribes to `transcript://live` for member-agent replies. Changing a plugin-contract source invalidates the authoring kit pin (`lib/plugin/distribution/authoring-kit.json`): rebuild it from a clean worktree, publish on cognia-plugins' `authoring-kits` branch and bump its lock in the same delivery.

`minor` changeset for the user-visible parts. New ADR for the transcript timeline protocol (none exists): next free number at the time. Amend ADR-0114 (fold model, action placement), ADR-0127 (one configuration, remend/ink policy, event-channel batching) and ADR-0218 (fence renderers in both branches) with the shipped decisions.

### 7. UI/UX polish (D1, D2, D14, D15)

- Turn fold per D14; post-turn footer row with reserved height; lazy-block placeholders sized from the source (line count).
- Mobile sheet: inner scroll, `env(safe-area-inset-bottom)`, primary actions first; hint as overlay.
- Touch shell by capability and width (D2): `+` sheet, long-press, always-visible actions in the expanded body instead of over result text, `touch-hit` on every control under 44 px (tool rows, rich-block actions, reactions, composer chip removes, attachment and artifact chips, corner buttons).
- Desktop: focus ring on tool-row toggles; action bar wraps or folds into "…" by width; one "…" menu.
- Status in aria labels; `--success` / `--warning` / `--info` tokens instead of raw palette colours, dark variants; composer chip overlay palette on tokens.
- Mobile: search entry in the chat header; timeline decision documented (stays off on phones unless the benchmark shows room).
- Text sizes normalized to the type scale (the 58 `text-[10px]` / `text-[9px]` uses); `message-bubble.ts` radius class made scannable (no template-built class).
- Tool-call visuals: where they diverge (the main renderer's terminal/file/structured rows vs `ToolCallRow` inside subagents, `TurnChangesCard`), prepare 2–3 options as screenshots and let the user pick before implementing.

`minor` changeset. i18n keys for any new label in both locales.

### 8. Dead code, final measurement, smoke

- Delete everything in the dead-code list plus whatever steps 3–7 replaced, each with grep proof (`rg` across `*.ts(x)`, `*.mjs`, `jest` mocks, stories, e2e harnesses).
- Re-run all benches; fill the "Results" table with before/after.
- `tauri-smoke` on desktop (local session and a paired Host session: stream, fold, copy, `#` memory, IME Enter with the macOS Pinyin input method).
- Android device smoke on the Huawei test phone (`android-device-testing` recipe): open the 2,000-message conversation, stream a long reply, long-press sheet on a small viewport, remote session view, Composer with the Chinese IME.
- `preflight`, then the gates verbatim.

## Verification summary

| Risk                                                                 | Obligation                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Rename breaks a hidden import (mocks, dynamic `import()`, gate JSON) | `typecheck`, `audit:modules`, `rg` for old names returns nothing outside docs                        |
| Remend/ink change alters final output                                | parity test: streamed then finalized output equals a direct render for the corpus                    |
| Remote protocol bump strands an older Host or client                 | version negotiation test both directions; an old Host without the field renders today's text preview |
| Composer split changes behaviour                                     | existing composer suites unchanged and green before and after each split commit                      |
| IME fix only provable on device                                      | macOS Tauri and Android device checks in step 8                                                      |
| Fold-as-settled jumps differently                                    | browser bench records layout shift during a streamed tool-heavy turn; target: no shift at turn end   |
| Event-channel change starves a raw-channel consumer                  | list consumers before changing; companion and CLI paths covered by their suites                      |

## Results

Node benches, 2026-11-16, Apple Silicon, shared machine. Load varied between runs (the 50 KB stream p50 read 7.8 ms once and 4.0 ms once), so compare medians of several back-to-back runs.

| `handleEvent` per token | 200 msgs         | 2,000 msgs        | 5,000 msgs  |
| ----------------------- | ---------------- | ----------------- | ----------- |
| handler p50 / p95 (ms)  | 0.05 / 0.13–0.15 | 2.9–3.7 / 5.0–5.6 | 27.3 / 29.9 |
| commit p50 (ms)         | 0.02             | 0.08–0.09         | 0.24        |

| `StreamingTextPart`              | short (0.5 KB)    | medium (5 KB) | long (50 KB)       | code (20 KB fence) | CJK (5 KB)        |
| -------------------------------- | ----------------- | ------------- | ------------------ | ------------------ | ----------------- |
| per-delta p50 / p95 (ms)         | 0.8–0.9 / 1.2–1.3 | 1.1 / 2.3     | 4.0–7.8 / 7.8–14.1 | 2.5–4.3 / 5.8–9.5  | 0.6–0.7 / 1.6–1.7 |
| p50 first → last quarter (ms)    | flat              | flat          | 1.6→5.7 … 2.3→12.7 | 0.7→4.9 … 1.9→8.6  | flat              |
| streaming DOM (bytes)            | 50 K              | 521 K         | 4.38 M             | 979 K              | 643 K             |
| finished `MarkdownRenderer` (ms) | 0.67              | 8.0–8.1       | 56.0               | 2.8–3.0            | 6.5–6.7           |

Browser baseline: not recorded yet. The static build refuses to run while other sessions' uncommitted changes to the authoring-kit inputs (`app/globals.css`, `pnpm-lock.yaml`, `packages/plugin-contract/src`) make the working tree differ from the kit pin, and `pnpm dev` runs the same check. It needs those changes committed, or a clean worktree at the pre-fix commit.

| Metric                                    | Baseline | After step 4 | Final |
| ----------------------------------------- | -------- | ------------ | ----- |
| First transcript paint, 2,000 messages    |          |              |       |
| Dropped frames, scripted scroll           |          |              |       |
| Commits / renders per streamed token      |          |              |       |
| `handleEvent` per event at 2,000 messages |          |              |       |
| Streaming per-delta p95, 50 KB            |          |              |       |
| Streaming DOM size, 50 KB                 |          |              |       |
| Composer renders per keystroke            |          |              |       |
| JS heap after open / after stream         |          |              |       |
