# Evidence ledger — pet feature gap audit

- Status: verifying
- Lane: standard
- Created: 2026-11-17
- Updated: 2026-11-17
- Related: [ADR-0058](../content/docs/en/adr/0058-desktop-pet-subsystem.md), [ADR-0219](../content/docs/en/adr/0219-pet-console-remote-care.md), [earlier Live2D audit](2026-10-23-pet-live2d-support-audit.md)
- Snapshot: shared `dev` checkout at `34e6103799`. Existing unrelated working-tree changes were present. The pet source paths inspected were clean against HEAD when checked.
- Current inventory: 22 defect categories with controlled reproduction evidence and 9 capability/documentation findings across three rounds. The Sprite overlay finding uses a source-derived secondary-bootstrap experiment; real native rendering remains unverified.
- Scope: implementation audit, deterministic diagnostic experiments, primary-source product comparison and prioritized follow-up. A new ledger covers the broader pet feature. The earlier ledger covers Live2D and media acceptance.

## Original request

> 帮我分析一下现在的宠物功能的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

| ID  | Statement                                                                                                                              | State        | Basis                                                                                                                                                      | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Identify current pet defects and capability gaps, compare relevant products, and prioritize follow-up.                                 | Agreed       | User request, 2026-11-17.                                                                                                                                  | -          |
| C1  | Preserve concurrent work and collect evidence with isolated test storage.                                                              | Verified     | Repository rules, shared checkout status, 2026-11-17.                                                                                                      | -          |
| O1  | The feature has care, progression, economy, achievements, character bindings, four renderer families, desktop windows and paired care. | Verified     | Current source inventory and ADR-0058/0219, 2026-11-17.                                                                                                    | -          |
| O2  | Existing focused tests pass, with 254 suites and 2,408 tests.                                                                          | Verified     | Repository Jest wrapper, command recorded below, exit 0, 2026-11-17.                                                                                       | O1         |
| O3  | Switching away from a streaming conversation emits a pet review event while that conversation still streams.                           | Verified     | Diagnostic check 1, real chat store and pet source, 2026-11-17.                                                                                            | -          |
| O4  | A saved repeated message five seconds older than a new request clears that request's pending state.                                    | Verified     | Diagnostic check 2, real remote hook and injected transport, 2026-11-17.                                                                                   | -          |
| O5  | Successful replies with no saved row disappear in both local and paired chat hooks.                                                    | Verified     | Diagnostic checks 3–4 and respondent memory-off branch, 2026-11-17.                                                                                        | -          |
| H1  | Persistent attention state survives passive pet events.                                                                                | Invalidated  | Integration check 2 leaves a live attention item pending, then an idle event changes waiting to idle, 2026-11-17.                                          | -          |
| H2  | Clearing conversation history fences writes from already-running pet replies.                                                          | Invalidated  | Integration check 1 clears real test IndexedDB, then the pending respondent writes a row back, 2026-11-17.                                                 | -          |
| O6  | A pending attention item loses its waiting visual after an idle heartbeat.                                                             | Verified     | Integration check 2, real source and controller with test IndexedDB, 2026-11-17.                                                                           | -          |
| O7  | Clearing pet history permits an already-running reply to recreate a saved turn.                                                        | Verified     | Integration check 1, real respondent and conversation CRUD with test IndexedDB, 2026-11-17.                                                                | -          |
| Q1  | Which product emphasis should drive future work, work monitoring or care and collection?                                               | Open         | The user requested an audit without choosing that trade-off, 2026-11-17.                                                                                   | -          |
| A1  | Prioritize reliable work status, useful task navigation and low interruption for Cognia's agent-workflow context.                      | Hypothesized | Proposed prioritization assumption, subject to user revision, 2026-11-17.                                                                                  | -          |
| G2  | Continue into related modules to discover additional problems.                                                                         | Agreed       | User follow-up, 2026-11-17.                                                                                                                                | G1         |
| H3  | Item precheck, inventory spending and applied care remain consistent under concurrent requests.                                        | Invalidated  | Concurrent berry/cookie use spends two items and commits one fed effect, follow-up probe 1, 2026-11-17.                                                    | -          |
| H4  | Profile mutation and activity recording recover together after a storage failure.                                                      | Invalidated  | Injected journal add failure leaves 3 XP and a committed cooldown without its activity row, follow-up probe 3, 2026-11-17.                                 | -          |
| H5  | A pet reset fences queued work and an older pending hatch.                                                                             | Invalidated  | Follow-up probes 4–5 restore a deleted profile and apply an old soul to a replacement egg, 2026-11-17.                                                     | -          |
| H6  | Automated care reports and charges only rewards committed by the controller.                                                           | Invalidated  | The documented grant contract is violated by concurrent care, charging 6 XP while committing 3 XP, follow-up probe 2, 2026-11-17.                          | -          |
| H7  | Pending pet replies and hatch results remain bound to their originating account and target.                                            | Invalidated  | Follow-up probe 6 writes account A text into account B after switching real encrypted partitions, 2026-11-17.                                              | -          |
| O8  | A pending reply can persist its original account's text into a different encrypted account partition.                                  | Verified     | Follow-up probe 6, real account activation and content ciphers, 2026-11-17.                                                                                | -          |
| O9  | Two concurrent item uses consume two foods while only one care event commits.                                                          | Verified     | Follow-up probe 1, real shop and controller, 2026-11-17.                                                                                                   | -          |
| O10 | Concurrent automated care charges 6 XP of allowance while applying 3 XP.                                                               | Verified     | Follow-up probe 2, real access gate and controller, 2026-11-17.                                                                                            | -          |
| O11 | Activity-write failure leaves profile progression committed and the journal empty.                                                     | Verified     | Follow-up probe 3, injected storage add failure, 2026-11-17.                                                                                               | -          |
| O12 | A pending controller write can recreate the pet after reset returns.                                                                   | Verified     | Follow-up probe 4, controlled real profile put, 2026-11-17.                                                                                                | -          |
| O13 | An old hatch can install its generated soul into a replacement egg.                                                                    | Verified     | Follow-up probe 5, real reset, ensure and hatch, 2026-11-17.                                                                                               | -          |
| O14 | Reset with stable settings leaves an already mounted PetMount without a new egg.                                                       | Verified     | Mounted-runtime reset probe with real profile CRUD, 2026-11-17.                                                                                            | -          |
| O15 | A previous host's delayed transcript fetch overwrites the newly selected host's transcript.                                            | Verified     | Follow-up probe 8, real hook and two controlled clients, 2026-11-17.                                                                                       | -          |
| O16 | Latest-row subscriptions drop batched goal outcomes and older concurrent workflow outcomes.                                            | Verified     | Follow-up probes 7 and 9, real Dexie queries and writes, 2026-11-17.                                                                                       | -          |
| O17 | An unmounted speech hook still records the reply, invokes TTS and publishes its bubble.                                                | Verified     | Speech-unmount probe observes saved=1, spoken=1 and a late reply bubble, 2026-11-17.                                                                       | -          |
| G3  | Continue deeper into pet modules and append new findings and reproduction evidence to this same report.                                | Agreed       | User follow-up, 2026-11-17.                                                                                                                                | G2         |
| H8  | Deleting a remembered inactive appearance preserves the currently selected skin family.                                                | Invalidated  | Both Live2D and Sprite deletion change media to SVG in real CRUD probes, 2026-11-17.                                                                       | -          |
| H9  | A secondary desktop window can resolve the active Sprite pack from its owner account.                                                  | Invalidated  | Source-derived lightweight bootstrap plus real account/asset lookup returns undefined; native UI not exercised, 2026-11-17.                                | -          |
| H10 | An older bubble producer cannot shorten a newer producer's message lifetime.                                                           | Invalidated  | Template expiry clears the newer six-second authored message after three seconds, 2026-11-17.                                                              | -          |
| H11 | Remote care receipts describe exactly their own committed operation.                                                                   | Invalidated  | Two successful receipts for one care row; separate probe reports 14 coins for a two-coin feed, 2026-11-17.                                                 | -          |
| H12 | Clearing pet conversation removes private reply copies from replay receipts.                                                           | Invalidated  | Domain replay survives real clear. Rust SecurityStore probe confirms a plaintext, reopenable reply receipt; canonical wiring traced in source, 2026-11-17. | -          |
| H13 | Rename and proactive profile writes preserve concurrent controller updates.                                                            | Invalidated  | Controlled local rename rolls XP/coins back from 3/102 to 0/100. Proactive writer shares the unqueued patch path but was not separately raced, 2026-11-17. | -          |
| H14 | Idle proactive speech reserves its in-flight slot before awaited memory work.                                                          | Invalidated  | Two minute ticks blocked in recall produce two model calls when released, 2026-11-17.                                                                      | -          |
| O18 | Cleared private replies survive domain replay, and the native receipt store can persist them without account encryption.               | Verified     | Domain clear/retry probe plus actual Rust SecurityStore and ordinary SQLite read after reopen, 2026-11-17.                                                 | -          |
| O19 | A delayed local rename overwrites newly earned XP and coins.                                                                           | Verified     | Real rename, profile CRUD and controller, with the first put held at a scheduling seam, 2026-11-17.                                                        | -          |
| O20 | Remote care uses a non-unique timestamp and whole-profile coin delta as an operation receipt.                                          | Verified     | Two dispatcher/controller diagnostic assertions fail with two successes/one row and 14 versus 2 coins, 2026-11-17.                                         | -          |
| O21 | Sprite asset resolution cannot cross the account/secondary-window boundary through the current local-only loader.                      | Verified     | Actual account storage lookup under source-derived fresh-secondary state, plus missing Sprite asset bridge trace, 2026-11-17.                              | -          |
| O22 | An old template timer clears a newer authored message.                                                                                 | Verified     | Real template hook, authored speech function and store with fake timers, 2026-11-17.                                                                       | -          |
| O23 | Slow recall allows overlapping proactive generations before the in-flight flag is set.                                                 | Verified     | Real proactive hook with a controlled recall collaborator issues two model calls, 2026-11-17.                                                              | -          |
| O24 | Live2D and Sprite deletion reset a different selected skin family.                                                                     | Verified     | Two real CRUD probes with remembered old IDs and current media selection, 2026-11-17.                                                                      | -          |

## Problem frame

G1 asks for a current-state assessment. Establish each capability through its production entry point, test suspected failures through the owning code, and map the gaps to independently documented practices. Findings require an explicit evidence level and a concrete acceptance condition. A1 guides the proposed order of future work and remains a product choice for the user.

## Current capability baseline

The implementation already spans the following user flows.

| Area              | Current implementation                                                                                                                                                 | Owning entry points                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Pet lifecycle     | Account-derived body, egg, generated personality with deterministic fallback, rename, XP, levels, stages, needs, illness and recovery.                                 | `lib/pet/runtime/init-pet.ts`, `hatch.ts`, `apply-event.ts`, `care/condition.ts`                              |
| Care and rewards  | Feed, play, pet, sleep, clean, treats, cooldowns, inventory, shop, coins, streaks and achievements.                                                                    | `components/pet/console/home-tab.tsx`, `pet-action-grid.tsx`, `lib/pet/economy/`, `interaction/gate.ts`       |
| Appearance        | Built-in SVG, Cubism 3–5 Live2D, Sprite v2 and transparent video/frame media packs. Character bindings and invalid-asset diagnostics are implemented.                  | `components/pet/skins/`, `components/settings/pet/`, `lib/pet/skin-governance.ts`                             |
| Desktop presence  | Transparent overlay and popup, saved position and size, click-through, tray and shortcut summon, dragging, throwing, wandering and platform-dependent window climbing. | `components/pet/pet-overlay-view.tsx`, `hooks/pet/use-pet-locomotion.ts`, `src-tauri/src/pet_window/`         |
| Work reactions    | Chat, attention, capture, terminal, Git, teams, background tasks, connectors, goals, workflows, schedules, birthdays and Radar events.                                 | `lib/pet/events/wire-sources.ts`                                                                              |
| Conversation      | Template bubbles, optional LLM replies, proactive speech tiers, local 200-turn rolling history, read-only recall of personal facts and TTS.                            | `lib/pet/chat/respond.ts`, `hooks/pet/use-pet-speak.ts`, `use-pet-proactive.ts`, `lib/db/pet-conversation.ts` |
| Cross-device care | A paired browser/phone can read the desktop pet and request care, purchases, rename, hatch and chat through host-owned RPC.                                            | `app/me/pet/page.tsx`, `lib/pet/console/console-mode.ts`, `lib/pet/remote/`                                   |
| Resource controls | Renderer leases, resource counters, hidden/suspended pause, reduced-motion support, low-power mode, local pointer tracking and structured fallback.                    | `lib/pet/skin-runtime.ts`, `components/pet/pet-renderer.tsx`, `hooks/pet/use-pet-look-target.ts`              |

The local runtime belongs to the desktop main window. Mobile uses the paired desktop's pet, and remote customization and certain desktop tabs are explicitly capability-gated. Those boundaries are documented in ADR-0219 and `lib/pet/console/action-capabilities.ts`. Remote appearance uses SVG because model, sprite and media resources stay on the desktop.

## Reproduced defects

Priorities below are proposed under A1. P1 affects core correctness or a destructive operation's result. P2 affects recovery and usability.

### F1 — P1 — Turning conversation memory off makes successful chat replies disappear

- Trigger the normal pet chat with `petMemory.enabled = false`.
- `respondAsPet` returns the generated reply and skips `recordTurn`. Local `usePetChat` clears the pending message on success and expects Dexie's live query to provide the reply. The hook keeps no ephemeral successful turn. Paired `useRemotePetChat` inserts an optimistic reply, then replaces it with the empty saved transcript on refresh.
- Two diagnostic assertions reproduced the missing local reply and disappearing remote reply. A failed best-effort history append exposes the same presentation dependency. A remote reply that exceeds the bridge time window also depends on a future saved row, so memory-off slow replies have no durable completion lookup.
- Relevant source is `lib/pet/chat/respond.ts:132`, `:175`, `hooks/pet/use-pet-chat.ts:53`, `:79`, and `hooks/pet/use-remote-pet-chat.ts:98`, `:142`.
- Acceptance requires a successful reply to stay visible with memory disabled or a failed history append. Sending another message, clearing the transcript and reopening the page must have explicit ephemeral-history semantics.

### F2 — P1 — Switching conversations emits a completion reaction for work still running

- Start streaming in conversation A and focus idle conversation B.
- The chat store projects B's status into top-level `status`. `wireChatSource` watches only that field, maps streaming-to-idle to `review`, and includes 2 XP. The source loses session and turn identity.
- The diagnostic uses the real chat store. A remains `streaming`, while the pet receives `review`. Background-session transitions also lack an independent per-conversation subscription through this source.
- Relevant source is `stores/chat/chat-store.ts:387`, `:1076`, `lib/pet/events/sources/chat-source.ts:9`, `:31`, and `lib/pet/xp/award-table.ts:12`.
- Acceptance requires tab changes to emit no false completion or XP, and each actual completed turn to emit once with its session/run identity. Background completion must be represented while another conversation is active.

### F3 — P1 — Heartbeat clears unresolved needs-input state

- Keep one live attention item pending, then deliver the periodic idle heartbeat.
- `createAttentionSource` emits on zero/nonzero edges. The controller maps the latest passive event to a needs-derived resting state. A still-pending attention item emits no new edge to restore waiting.
- The integration diagnostic verified `waiting` before the idle event and `idle` afterward with the attention item still present. Other successful or ambient subsystem events can compete through the same latest-event design.
- Relevant source is `lib/pet/events/sources/attention-source.ts:29`, `:47`, `heartbeat-source.ts:23`, `:40`, and `runtime/pet-controller.ts:151`.
- Acceptance requires a persistent work-state projection with explicit priority. Unresolved attention must survive heartbeats, care actions and unrelated work events. Brief interaction animation can finish into the still-current work state.

### F4 — P1 — Clearing conversation history allows late replies to recreate it

- Start a pet model reply, clear conversation history, then let the pending reply finish.
- `clearPetConversation` clears the table. The running respondent retains its input and later calls `recordTurn`. Clear and send carry no shared conversation generation or cancellation fence. Both the chat clear control and the settings memory-clear control remain reachable while a reply is running.
- The integration diagnostic uses the real respondent and conversation CRUD over fake IndexedDB. The table is empty immediately after clear, then contains the old request and late reply after completion.
- Relevant source is `lib/db/pet-conversation.ts:53`, `lib/pet/chat/respond.ts:150`, `:175`, `components/pet/console/chat-tab.tsx:181`, and `components/pet/settings/pet-interaction-controls.tsx:55`.
- Acceptance requires clear to invalidate earlier in-flight conversation writes across local and remote callers. Late results need a defined UI outcome. Future turns should remain usable after clearing.

### F5 — P2 — Repeated text and device-clock differences can incorrectly settle paired chat

- Send a repeated message while a turn with identical text is already in recent history.
- Remote completion checks `row.userText === waiting.text && row.at >= waiting.sentAt - 60_000`. A saved row five seconds before the new request satisfies it. The two timestamps come from different devices. The response has no request-to-turn identifier for this reconciliation.
- The real-hook diagnostic reproduced a new pending request becoming completed after fetching only the older row. Polling is bounded to 3, 7, 15 and 30 seconds after the pending result. Re-entering or refreshing can help later, but there is no explicit terminal operation status for a reply that eventually fails.
- Relevant source is `hooks/pet/use-remote-pet-chat.ts:35`, `:80`, `:105`, `:157`, `lib/pet/remote/client.ts:135`, and `remote/host-dispatch.ts:409`.
- Acceptance requires a stable intent/turn ID through send, pending response and transcript/status lookup. Cover repeated text, clock skew, lost acknowledgements, late success and late failure.

## Capability and product gaps

These findings are established from current source paths. Their value and order depend on the desired product role.

| ID  | Proposed priority | Gap and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Acceptance for a follow-up                                                                                                                                                                                                                     |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F6  | P1                | Work events lack a complete action path. `PetBubbleAction` has one `open-console` variant and only `radarReport` gets an action. Attention carries a count without the target task. The pet surface has no dedicated multi-run activity list with per-run unread/input/blocked state. Existing Control Center attention data can supply the targets. See `lib/pet/bubbles/action.ts:17`, `:34` and `events/sources/attention-source.ts:30`.                                                                              | Show the pending/running/completed tasks, preserve their identities, open the exact conversation/approval, and clear attention when its underlying task resolves. Reuse `lib/attention/` and current run state.                                |
| F7  | P2                | Full-chat continuation carries only one user message. `ChatTab.openFullChat` seeds the pending or last user text, and `seedMainChat` creates a fresh session without the pet reply or prior conversation context. See `components/pet/console/chat-tab.tsx:85` and `lib/pet/chat/seed-main-chat.ts:23`.                                                                                                                                                                                                                  | A user can review which recent exchanges and character/project context will accompany the handoff, then continue coherently in main chat.                                                                                                      |
| F8  | P2                | Complete pet migration is missing. Portable backup includes the profile, achievements, inventory, bindings and Live2D metadata. Binary model files, sprite atlases and media packs stay device-local, as does pet conversation history. Import managers support installation and removal. There is no unified pet asset export/restore path. See `lib/data-governance/table-catalog.ts:557`, `lib/data/build-package.ts:331`, and `components/settings/pet/`.                                                            | Export a versioned package with selected owned assets, validated references and a restore preview. On a clean device, restore the chosen appearance and progress, or enumerate every asset requiring re-import before proceeding.              |
| F9  | P2                | Quiet behavior is fragmented. Bubble mute, proactive frequency, SFX quiet hours, notification quiet hours, motion preference and click-through each govern a subset. macOS collection behavior deliberately joins Spaces and fullscreen. There is no pet-level timed focus/presentation policy coordinating those surfaces. See `packages/plugin-contract/src/types/agent-config/pet-settings.ts`, `hooks/pet/use-pet-proactive.ts:131`, `lib/pet/audio/sfx-gate.ts`, and `src-tauri/src/pet_window/macos_panel.rs:366`. | Define a timed focus/presentation control and its resume behavior. Show whether it affects visual presence, speech, motion and notifications. Verify fullscreen, meetings and screen sharing in the native app.                                |
| F10 | P2                | A care break has no explicit progression policy. Needs decay over all wall-clock elapsed time, including time closed or disabled. Defaults drain energy by 4/hour and mood by 2.5/hour. No vacation/care-pause setting exists. Existing unwell/recovery and streak mechanics make this a product decision. See `lib/pet/needs/decay.ts:36`, `defaults.ts:42`, and `care/condition.ts:48`.                                                                                                                                | Choose and label the intended absence policy. A break mode could preserve streaks and suspend decay until its end, with tests for clock changes and returning after several days. User research should establish whether that mode is desired. |
| F11 | P2                | The native pet's direct spatial interaction is pointer-only. The body is an image-role div with pointer handlers and no focus/keyboard handlers. Existing commands cover summon and care, while the non-key sprite panel has no keyboard relocation path. The main console provides keyboard-operable care controls. See `components/pet/pet-overlay-view.tsx:443`, `lib/pet/command-ids.ts`, and `src-tauri/src/pet_window/macos_panel.rs:307`.                                                                         | Provide keyboard commands or an accessible control surface for relocation, reset-to-visible position and opening the popup. Validate discoverability and focus behavior with a screen reader.                                                  |
| F12 | P2                | Agent-created appearance has an unverified capability dependency and manual return path. The creation button seeds a `$hatch-pet` task, navigates to main chat and relies on the user to import `pet.json` plus the sheet. This entry point performs no skill-capability check or generated-artifact installation callback. A selected external agent may have that skill, so universal creation failure is unproven. See `components/settings/pet/pet-sprite-pack-manager.tsx:124` and `lib/pet/hatch-prompt.ts:45`.    | Resolve the selected agent's creation capability, explain requirements, retain task progress, and offer validated preview/import of generated artifacts on completion. Test both skill-present and skill-absent paths.                         |
| F13 | P3                | Long-term play content is comparatively shallow. Current toys are consumable effects mapped to `played`, while shop/XP/achievements provide the main loop. Additional interactive toys, scenes or multiple pets would expand that loop. See `lib/pet/economy/item-catalog.ts:77` and `needs/decay.ts:19`.                                                                                                                                                                                                                | Select one interaction with repeatable value and measure return use. Scope a single toy or scene with pause, cleanup and persistence before expanding the catalog.                                                                             |
| F14 | P3                | Subsystem documentation has drifted. It describes three governed renderers despite implemented media packs, and says web/mobile settings never offer the pet despite ADR-0219's paired console. See `docs/content/docs/en/subsystems/desktop-pet.mdx:114`, `:147`, the Chinese counterpart, and `app/me/pet/page.tsx`.                                                                                                                                                                                                   | Refresh both language pages against the runtime and remote-console capability matrix.                                                                                                                                                          |

## Industry comparison

The following practices were read in primary documentation on 2026-11-17. Product popularity and retention were outside this measurement. The implications are recommendations under A1.

| Reference            | Documented practice                                                                                                                                                                                                                    | Implication for Cognia                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT desktop Pets | A multi-chat activity tray prioritizes input requests, failures, unread completions and running work. Controls start chats and navigate to their conversations. Motion follows the OS preference. Creation installs its bundled skill. | Address F2/F3/F6 together through an identity-preserving work projection. Extend quick talk with a context-preserving handoff. Detect creation capability for F12. Cognia already implements motion preferences and care functionality. |
| VS Code Pets         | Commands expose spawning, ball play, removal, configuration and pet-list import/export. Multiple pets can interact inside its panel.                                                                                                   | Improve command discoverability and asset portability, then evaluate one direct toy interaction. Cognia already offers bindable care commands and desktop motion.                                                                       |
| VPet                 | Rich interaction animation, Workshop distribution and a Mod Maker cover pets, animations, items, work, dialogue and themes.                                                                                                            | Build a coherent content-authoring and distribution path around existing skin/item/plugin contracts. Keep package compatibility and user-visible diagnostics integrated through installation.                                           |
| Finch                | Manual and automatic backups protect progression. Pause Mode preserves streaks while the user takes a break.                                                                                                                           | Treat complete migration and care-break semantics as user-facing features, with an explicit choice about Cognia's absence behavior.                                                                                                     |
| W3C WCAG guidance    | Keyboard operation and user controls over nonessential motion are independently specified.                                                                                                                                             | Validate keyboard-equivalent pet operations and motion controls. Current reduced-motion support and the bubble's status role are existing strengths. Native conformance requires its own acceptance evidence.                           |

Sources for the documented practices are [ChatGPT Pets](https://learn.chatgpt.com/docs/pets), [VS Code Pets](https://tonybaloney.github.io/vscode-pets/pets/), [VPet](https://github.com/LorisYounger/VPet/blob/main/README_en.md), [Finch backups](https://help.finchcare.com/hc/en-us/articles/37780313999757-Data-Backup-and-Recovery), [Finch Pause Mode](https://help.finchcare.com/hc/en-us/articles/37936144770701-Pause-Mode), [W3C keyboard guidance](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html), and [W3C animation guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html).

## Proposed implementation order

1. Fence account, deletion and private-result lifetimes in F4/F15/F24/F25. Cover clear during generation, clear after a completed reply, account switch/lock and receipt replay. Preserve idempotent side-effect protection while removing retained private copies.
2. Make progression and lifecycle writes consistent in F16–F21/F26/F27. Serialize profile writers, make inventory/effect and profile/journal updates atomic, fence old hatch/reset work, and attribute remote rewards to unique committed operations.
3. Repair reply presentation and request identity in F1/F5/F22. Add regressions for memory-off local and paired chat, repeated text, skewed clocks and host replacement. Protocol changes must retain compatibility for paired clients already installed.
4. Repair F2/F3/F23 and connect F6. Retain persistent task identities and approval priority, deduplicate terminal outcomes, and expose a path to the exact work item. Repair bubble expiry and proactive admission in F29/F30 to preserve message visibility and interruption pacing.
5. Close asset ownership and continuation flows in F7/F8/F12/F28/F31. Validate a clean-device asset restore, real account-owned Sprite rendering in the overlay, overlapping asset deletion and selection, and a pet-to-main-chat handoff with visible context.
6. Resolve the product choices in F9/F10, complete F11 keyboard access, then run the remaining native acceptance. Content expansion in F13 can follow measured usage. Documentation in F14 can accompany the corresponding work.

## Native and outcome acceptance still needed

| Scenario                                      | Required observation                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS Spaces/fullscreen and Windows focus     | Summoning, dragging, popup input and hiding behave predictably while another app owns typing focus.                                                                                                                                                    |
| Monitor hot-plug, scale and work-area changes | Pet and popup remain reachable across negative coordinates, mixed DPI and removing the saved monitor.                                                                                                                                                  |
| A waiting task plus concurrent running tasks  | Input requests remain identifiable and actionable after heartbeats, unrelated completions and UI navigation.                                                                                                                                           |
| Real Live2D/Sprite/media resources            | Import, renderer fallback, repeated settings changes, context loss and reopen recover with bounded resources.                                                                                                                                          |
| Long-session resource use                     | Capture baseline and active/idle/hidden measurements for SVG, Live2D, sprite and media. Record process CPU/GPU, memory and wakeups under the same procedure. Current resource counters establish ownership behavior but do not measure battery impact. |
| Paired phone plus desktop                     | Delayed replies, host disconnect/reconnect, duplicate acknowledgements and clear-during-send preserve intent and outcome.                                                                                                                              |
| User validation                               | Measure whether users can identify a task needing input, reach it, take a break and restore their pet on another device. Evaluate interruption feedback before setting frequency defaults.                                                             |

## Additional module findings — 2026-11-17

The follow-up covered inventory use, automated grants, partial storage writes, pet reset, pending model work, account/host changes and related event sources. Eleven diagnostic checks cover ten additional defect categories. Each diagnostic asserts expected behavior and fails on the audited implementation. Model and native services remain controlled test collaborators.

### F15 — P1 — A late pet reply crosses the active account boundary

Start a delayed pet reply in account A, activate account B, then finish A's reply. `respondAsPet` retains A's text across the model wait. Its later history append calls `getDb()` again and receives B's current database. The isolated reproduction activates real content ciphers for both partitions and records A's request and reply in B. Encryption correctly encrypts the misplaced content for B.

Account activation awaits registered pending-write flushers, while pet model work registers with neither that mechanism nor an account-lifetime cancellation owner. The account selector's local-state cleanup covers other subsystem stores. Relevant source is `lib/pet/chat/respond.ts:150`, `:175`, `lib/db/pet-conversation.ts:33`, `lib/db/schema.ts:2466`, and `stores/account/account-store.ts:480`, `:2194`.

Acceptance requires each async operation to retain and validate its account, runtime target and pet/conversation generation before publishing or persisting. Cover switching accounts, switching targets, locking, logging out and a response arriving after teardown. The deterministic partition test establishes the storage defect. Native account-selector and lock-flow acceptance remain pending.

### F16 — P1 — Concurrent item use spends inventory for a dropped care effect

With one berry and one cookie owned, call both item-use operations concurrently through the real shop and controller. Both items disappear, and one `fed` activity is recorded. `consumeItem` serializes its precheck and decrement, then emits the care event after leaving that queue turn. The second spend can enter the queue before the first effect has advanced the cooldown. The controller subsequently refuses the second event.

The normal console and popup use `createLocalPetItemOps` and `usePetItemActions`. Pending state is per item, so two different foods can be used through those surfaces. Relevant source is `lib/pet/economy/shop.ts:118`, `:127`, `hooks/pet/pet-item-ops.ts:48`, and `hooks/pet/use-pet-item-actions.ts:47`.

Acceptance requires the inventory decrement and accepted care effect to share one committed operation. A refused or failed effect must preserve the item, including concurrent different items with the same care kind and a failed profile write.

### F17 — P2 — Automated care charges and reports rewards the controller refuses

Two concurrent agent `fed` calls pass the advisory precheck before either event commits. Both debit the daily budget and report a grant. The controller accepts one and rejects the other on cooldown. The diagnostic measures 6 XP charged against the allowance and 3 XP committed to the profile.

This violates the documented plugin/agent applied-grant result. Relevant source is `lib/pet/access/gate.ts:291`, `:315`, `:325`, `runtime/pet-controller.ts:80`, and `docs/content/docs/en/plugin-dev/pet.mdx:87`. The earlier broad H6 inquiry is refined to this explicit grant/charge contract. This experiment establishes debit and outcome inconsistency.

Acceptance requires an operation result tied to the controller's committed outcome, with allowance reserved or debited once for accepted work. Cover parallel plugin/agent requests, cooldown refusal and failed persistence.

### F18 — P2 — A failed activity write leaves partially committed progression

Inject a failure into the activity table's `add`, then process one feeding. The profile already contains 3 XP, 2 coins and the new cooldown while the activity ledger stays empty. The controller catches and logs the failure, and its promise resolves. Counter-based achievements and callers using the ledger therefore see a different outcome from the profile.

Relevant source is `lib/pet/runtime/pet-controller.ts:123`, `:128`, `:244`, and `lib/db/pet.ts:60`. Remote care also falls back to the profile difference when its matching activity row is absent.

Acceptance requires a transaction or explicit recoverable operation record covering profile, inventory and journal changes. A caller needs an outcome that reflects a committed or recoverable operation. Inject failures at every persistence boundary and verify retry behavior.

### F19 — P1 — Reset can be undone by an in-flight controller write

Pause the controller immediately before its profile `put`, run `resetPet`, verify the profile is absent, then release the original write. The deleted pet returns with its previous identity and newly computed progression. Reset clears tables outside `enqueuePetWork` and supplies no generation fence. Its independent table clears also create partial-reset failure windows.

Relevant source is `lib/db/pet.ts:222`, `:232`, `lib/pet/runtime/pet-controller.ts:123`, `:263`, and the reset caller in `components/pet/settings/pet-customization-workspace.tsx:108`.

Acceptance requires reset to establish a new generation, exclude older queued/in-flight writes and commit its tables consistently. Include controller events, item consumption, remote writes, model replies and tombstone publication in the lifecycle review.

### F20 — P1 — A pending hatch modifies a replacement egg

Start hatch generation, reset the pet, create a replacement egg, then finish the old generation. The replacement pet receives the old result's name and personality. The hatch re-reads the global row after generation, but only checks whether it exists and already has a soul. The existing regression covers a deleted row that stays absent.

Relevant source is `lib/pet/runtime/init-pet.ts:35`, `:39`, `lib/pet/runtime/hatch.ts:35`, `:71`, and `init-pet.test.ts:81`. The diagnostic reproduces reset/recreate in one partition. Account/target switching has the same missing identity comparison in source.

Acceptance requires hatch to compare the originating database and pet generation before installing the result. Concurrent calls should join only within that generation. A stale result must leave the replacement pet eligible for its own hatch.

### F21 — P1 — A normal reset leaves the mounted runtime without a new egg

Mount the runtime with stable enabled settings, initialize the pet, reset it, then render the same mounted runtime again. The profile stays absent. Initialization runs only when `petEnabled`, settings or `save` change. Reset mutates pet tables and leaves those dependencies stable. The local console treats an absent profile as loading and renders its skeleton.

The diagnostic mounts the actual `PetMount` with native/window collaborators controlled and uses real profile initialization/reset. Relevant source is `components/pet/pet-mount.tsx:87`, `components/pet/settings/pet-customization-workspace.tsx:108`, and `components/pet/console/pet-console.tsx:319`.

Acceptance requires a successful reset to produce a usable fresh-egg state through the ordinary UI, including the desktop overlay and paired mirror. Verify this while settings stay stable and without a route remount.

### F22 — P2 — A previous remote host's response overwrites the current host's transcript

Start a transcript refresh against host A, select host B, and complete a fresh B refresh. When A's older response arrives, it replaces the visible transcript with A's content. `useRemotePetChat` guards mounted state but carries no host/scope/request generation. Its provider is keyed by local/remote mode, so a remote-to-remote host switch can retain the same hook instance.

The two-client hook diagnostic reproduces that overwrite. Relevant source is `hooks/pet/use-remote-pet-chat.ts:98`, `:103`, `:136`, `components/pet/console/pet-console.tsx:125`, and `stores/remote-host/remote-host-store.ts:703`.

Acceptance requires host identity to scope transcript, pending text, timers, in-flight results and clear operations. Cover delayed A results arriving after B has loaded, both chat sends and transcript reads, and repeated switches.

### F23 — P2 — Latest-row subscriptions lose real work outcomes

The goal adapter queries only the newest event in the entire goal-event table. Two successful goal exits committed in one batch produce only the last completion reaction and reward. The workflow adapter queries only the most recently started run. Once B starts, an older concurrently running A can complete without changing that query's row, so A's outcome never reaches the pet.

Two real-Dexie diagnostics reproduce those cases. Goal writes use `appendGoalEvent` inside one transaction. The workflow case starts a newer run and updates the older run to `succeeded`. Relevant source is `lib/pet/events/sources/goal-source.ts:59`, `:75`, and `workflow-source.ts:31`, `:47`.

Acceptance requires a cursor or identity-aware projection that processes every eligible terminal outcome once. Cover batched goals, overlapping workflows, reload baselines, duplicate observations and record pruning.

### F24 — P2 — Speech completion survives hook disposal

Start a pet speech request, unmount the hook, then complete the controlled model call. The real hook still appends the reply to history, invokes TTS and publishes its bubble. The diagnostic observes one history append, one TTS invocation and the late reply in the global bubble store. Cleanup only unsubscribes from future events and clears the timer that existed at cleanup time.

Relevant source is `hooks/pet/use-pet-speak.ts:225`, `:240`, `:253`. Proactive speech similarly publishes and patches the current profile after its awaited model call in `use-pet-proactive.ts:198`.

Acceptance requires a disposed/generation check and cancellation ownership across model work, recalled context, TTS and persistence. Exercise disabling speech, muting bubbles, unmount, reset and account changes while a reply is pending.

The follow-up priorities begin with F15 account scope, F19/F20/F21 reset lifecycle and F16 item consistency. F17/F18 should be addressed alongside operation-result and transaction ownership. F22/F23 extend the work-state and remote-correlation repairs already identified in F2/F3/F5/F6.

## Deeper boundary findings — 2026-11-17

This round adds seven categories, F25–F31. Nine expected-behavior assertions fail at their intended assertions after successful setup. A separate Rust diagnostic positively confirms the native receipt storage behavior. None of these probes calls a real model, sends a real paired request or exercises a native window.

### F25 — P1 — Private pet replies survive history clearing in replay receipts outside account encryption

Evidence: domain reproduction, native persistence reproduction and canonical-routing source trace, rather than a full paired-device test.

Send `pet_chat_send` with a unique key and a deterministic reply containing `private-reply-marker`. Clear with the real `pet_chat_clear`, confirm the conversation table is empty, then retry the same send/key. The domain dispatcher returns the old private reply and does not call the respondent again. Expected deletion semantics would remove or invalidate retained private response copies as well as transcript rows. This is separate from F4: no model call is still running and no conversation row is recreated.

The canonical companion path also persists full replies: `pet.chat` falls under `CommandReceiptPolicy::Replay` in `crates/cognia-companion-contract/src/command_manifest.rs:141`; `lib/pet/remote/host-dispatch.ts:446` returns reply text; `crates/cognia-companion/src/remote_execution.rs:636` serializes the complete result into the durable receipt. Replay returns before entering the domain handler at `remote_execution.rs:603`. The clear handler at `host-dispatch.ts:469` only clears conversation CRUD. No receipt invalidation is wired there or in pet reset.

An isolated Rust integration probe opens the actual `SecurityStore`, completes an operation with the exact successful reply envelope, closes it, reads `receipt_json` through an ordinary new `rusqlite::Connection`, then reopens the store and obtains `IdempotencyDecision::Completed` containing the marker. It passes without installing a Cognia account content cipher or key. The desktop path is application data plus `companion-security.sqlite` (`src-tauri/src/companion_api/commands.rs:123`, `:1052`); opening uses ordinary SQLite (`crates/cognia-companion-security/src/security_store.rs:608`) and its schema stores `receipt_json TEXT` at `:4169`. The completed-receipt GC threshold is 24 hours (`:17`, `:1948`); that threshold is not a demonstrated prompt erasure deadline.

This establishes a retained private copy outside Cognia account encryption. It does not establish unauthenticated remote access, cross-account replay authorization, or the absence of operating-system disk encryption. Full native send → clear → retry acceptance is still open.

Acceptance: choose an explicit private-result receipt policy, preserve idempotent side-effect protection, and make history clearing/reset invalidate applicable private copies. Verify a completed reply cannot be recovered from either ledger after clearing, and account locking does not leave plaintext private pet results in generic application receipts.

### F26 — P1 — A local rename can roll back progression earned during its write

Evidence: real `renamePet`, controller and profile CRUD with one controlled write delay. Start a local rename and pause its first profile `put` after the snapshot has been built. Apply a real feed through `handlePetEvent` and confirm XP=3, coins=102. Release the rename. The name becomes `NewName`, but XP returns to 0 and coins to 100, while the feed activity row remains.

The local caller directly awaits `renamePet` (`hooks/pet/use-local-pet-actions.ts:161`). The helper reaches `patchPetProfile` without the controller queue (`lib/pet/runtime/rename-pet.ts:34`). That patch reads a whole row and later replaces it with a shallow merge (`lib/db/pet.ts:41`). The rename helper's stated “touches only soul.name” contract is therefore violated under concurrency. Remote rename already uses the serialization boundary. Proactive speech writes through the same unqueued patch at `hooks/pet/use-pet-proactive.ts:201`; that caller was traced but not independently raced here.

Acceptance: serialize profile mutation against the controller, or use an atomic update of the owned fields. Preserve newly committed XP, coins, cooldown and care state when local rename or proactive counters complete. Cover both interleavings with the journal/profile invariant.

### F27 — P2 — Remote care receipts can acknowledge a refused action or include another event's coins

Evidence: two real dispatcher/controller/IndexedDB probes, with distinct callers and idempotency keys. First, freeze the host clock and issue two concurrent feeds. Only one `fed` activity commits, but both requests return `{ok:true, grantedXp:3, grantedCoins:2}`. The expected one-success assertion receives two successes.

Second, emit a normal `goalComplete` immediately after the requested feed. Both events commit. The feed receipt reports `grantedXp:3, grantedCoins:14`; the feed itself awards two coins and the unrelated goal contributes twelve. This is inaccurate attribution, rather than an extra coin mint.

`lib/pet/remote/host-dispatch.ts:284` treats `(kind, timestamp)` as an exact outcome identity. Equal timestamps make the dropped request indistinguishable from the accepted one. The coin receipt uses the entire profile balance difference at `:327`, even though other queued work can change that balance. These differ from F17's automation allowance issue: the paired user receives an incorrect confirmation despite the controller correctly applying only one care action.

Acceptance: attach a unique operation identity to the committed outcome and return its actual XP/coin deltas. A refused request must receive a refusal; unrelated rewards or purchases must not alter its receipt.

### F28 — P2 — Sprite assets lack the desktop overlay projection used by the other asset families

Evidence: complete source path and a real-storage probe using a source-derived fresh-secondary bootstrap; native rendering remains unverified.

Install `owner-pack` in an activated, encrypted test account and load it successfully through `loadSpriteSkinAsset`. Reset the per-realm asset runtime and clear the in-memory account selection to model a newly created secondary window. The same production loader now returns `undefined`. The experiment uses actual account activation and asset CRUD; it does not create two webviews.

The bootstrap precondition comes from `components/runtime/app-runtime.tsx:160`: lightweight windows render settings hydration and followers without the main account initializer/gate. Database selection is realm-local and defaults to the legacy DB in `lib/db/schema.ts:2538`. `hooks/pet/use-active-sprite-pack.ts:23` always queries local Dexie, and `lib/pet/skin-assets.ts:36` has no mirror branch for Sprite assets. The cross-window owner starts asset bridges for Live2D and media only (`lib/pet/events/cross-window-bridge.ts:85`, `:96`). Receiving an appearance-selection ID does not transfer its Sprite row/blob. `components/pet/pet-overlay-view.tsx:89` consequently resolves a missing Sprite row to the SVG fallback.

Acceptance: project approved Sprite metadata/blobs from the main account to the secondary renderer, using owner invalidation and bounded leases, without opening the whole account database in the overlay. Verify a newly imported pack in the real desktop overlay, then account switch, deletion, reload and missing-pack fallback.

### F29 — P2 — An older bubble timer clears a newer producer's message early

Evidence: the real template hook, `sayAsPet` and store with controlled timers. Emit a feed at t=0, then at t=1 second publish “A newer message” through `sayAsPet` with a six-second duration. At t=4 seconds the old template timer clears the current bubble. The authored message disappears after three seconds, before its t=7-second expiry.

`hooks/pet/use-pet-bubbles.ts:45` clears the shared store unconditionally; speech and proactive hooks own separate timers with the same pattern. They are mounted together at `components/pet/pet-main-runtime.tsx:55`. `sayAsPet` has a text-equality guard, which cannot prevent an unrelated producer's unconditional clear and also does not uniquely identify repeated identical text.

Acceptance: give each published bubble an identity and let only its owner expire that identity. Cover template → LLM/authored, LLM → template, and repeated identical messages with different lifetimes.

### F30 — P2 — Slow memory recall bypasses proactive speech concurrency and pacing

Evidence: real proactive hook with deterministic memory-recall and model collaborators. Use normal-tier idle chatter, an idle user and no greeting trigger. Hold recall for the first minute tick; allow a second minute tick while recall is still pending, then resolve both recalls. The model collaborator is called twice instead of once. Both calls passed pacing against the same prior proactive state.

`hooks/pet/use-pet-proactive.ts:140` checks the in-flight flag and spends the limiter slot, but does not reserve the flag until `:177`, after awaited dependency construction and recall at `:171`. A recall taking more than the tick interval admits another generation. Both completions calculate advanced counters from their pre-await state, so overlapping completions can also overwrite rather than accumulate counters. The observed result here is two calls; exact daily-limit overshoot under a live provider has not been measured.

Acceptance: reserve ownership before the first await, release it on every refusal/error/cancellation path, and commit pacing counters against current state. While recall is delayed across multiple ticks, permit at most one generation and charge the completed utterance once.

### F31 — P2 — Deleting a remembered inactive asset resets a different selected appearance

Evidence: two real CRUD probes. Store a current media selection plus a remembered old Live2D ID or Sprite ID. Delete that old asset through `deletePetModel` or `deletePetSpritePack`. Both change the persisted current `skinId` from `media` to `svg`, rather than retaining media and clearing only the deleted family's reference.

`lib/db/pet-models.ts:156` and `lib/db/pet-sprite-packs.ts:68` test only the remembered active ID before overwriting `skinId`. The media deletion implementation already checks the currently selected family. Family changes at `components/pet/settings/pet-appearance-controls.tsx:86` intentionally preserve the other families' remembered IDs.

The ordinary single-window UI hides inactive managers, so this is not a claim that an idle user can directly delete a hidden family's asset. The violated CRUD contract matters when selection changes while deletion is pending or another authorized settings caller changes it. The overlapping native/UI flow has not been exercised.

Acceptance: clear the deleted reference but switch to SVG only when that asset's family is currently selected. Cover the two deletion helpers and a delayed delete overlapping an appearance change.

### Candidates ruled out or kept narrower

A short-lived TypeScript idempotency ledger alone does not prove duplicate effects on normal paired retries. The canonical Rust path durably caches both successful and failed outcomes before transport retries. `lib/tauri/transport-companion.ts:1172` and `:1212` preserve the idempotency key across retry and RTC/HTTPS fallback. No new duplicate-execution finding is recorded from TypeScript TTL/eviction alone.

Global asset-cache keys and signature-only import validation were inspected but lack a demonstrated normal-flow failure beyond the findings above; they are not counted. The unqueued proactive profile writer is recorded as a related exposure under F26, rather than counted as an independently reproduced defect. The two receipt attribution probes share F27, and the two asset-deletion probes share F31.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                            |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Pet UI, hooks, event sources, Dexie, companion RPC, plugins and native windows participate.                                            |
| technical    | medium | Individual paths are familiar, while renderer and cross-window resource ownership require careful inspection.                          |
| coupling     | high   | Three shells, paired host routing, settings followers, shared chat state and asynchronous model replies.                               |
| requirement  | medium | Audit outcome is clear. The relative value of companionship and work monitoring remains a product choice.                              |
| verification | high   | Logic is reproducible headlessly. Focus, fullscreen, monitors, power use, real model assets and paired devices need native acceptance. |
| risk         | medium | Audit is reversible. Follow-up fixes can affect deletion semantics, saved progress and shared protocols.                               |

## Risks

| ID  | Risk (impact)                                                                                  | Severity | Source                                                                | Claim                                                                                        | Refuted by                                                                                          |
| --- | ---------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R1  | Existing green unit tests hide user-visible composition defects.                               | medium   | Evidence-driven risk catalog and FMEA of chat presentation            | A successful chat reply stays visible and task state describes actual work.                  | A successful reply vanishes or navigation emits completion.                                         |
| R2  | Delayed or repeated requests produce incorrect state across paired clients.                    | medium   | ADR-0219 and failure-injection checklist                              | Pending replies correlate to the intended request and clearing history survives late writes. | An older repeated turn settles a new request or cleared content reappears.                          |
| R3  | A visual work signal loses actionable task identity or priority.                               | medium   | ADR-0058, attention source contract and primary product documentation | Needs-input state remains visible and can lead to the corresponding work.                    | Passive events clear waiting or a bubble cannot identify its task.                                  |
| R4  | Renderer breadth is mistaken for complete asset portability or native acceptance.              | medium   | Data-governance catalog, ADR-0058 and FMEA                            | The report explains backup contents, shell boundaries and measured acceptance.               | Claiming complete migration or power behavior from mocked tests.                                    |
| R5  | Product comparison inflates preferences into defects.                                          | medium   | Primary product documentation and W3C guidance                        | Recommendations identify their product assumption and acceptance conditions.                 | Treating a competitor's optional feature as an existing contractual requirement.                    |
| R6  | Concurrent inventory use spends items for a refused effect.                                    | medium   | ADR-0219 and failure-injection checklist                              | An item is spent exactly when its care effect applies.                                       | Two accepted spends yield one effect or a write failure loses the item.                             |
| R7  | Partial persistence or reset revives or corrupts progression.                                  | medium   | FMEA of profile, activity and lifecycle storage                       | Progression and its journal commit together, and reset invalidates older work.               | Profile changes without a journal or pre-reset work writes into a replacement pet.                  |
| R8  | Daily automation limits miss growth or report a grant that was refused.                        | medium   | Plugin/agent contract and failure-injection checklist                 | Reported rewards match committed rewards across concurrent operations.                       | An action spends allowance without applying, or another growth channel exceeds the intended policy. |
| R9  | A pending pet reply writes personal text or a hatch identity into another account's partition. | high     | Fresh lifecycle review and STRIDE information-disclosure lens         | Async completion can write only into its originating account, target and pet generation.     | Switch scope during model work and find the prior account's result in the replacement partition.    |
| R10 | Asset and profile ownership races silently replace unrelated state.                            | medium   | Asset lifecycle and profile writer FMEA                               | Appearance deletion and profile patches preserve concurrent state.                           | Deleting an inactive asset resets a different family, or a late patch rolls back rewards.           |
| R11 | Competing bubble timers erase a newer message prematurely.                                     | medium   | Composition review of independent producers                           | The current message owns its expiry.                                                         | An older producer clears a newer bubble before its advertised expiry.                               |
| R12 | Private replies remain readable after conversation clearing or account locking.                | high     | STRIDE disclosure and retention review                                | Private reply retention respects account encryption and deletion scope.                      | A full reply survives in a replay receipt outside account encryption.                               |
| R13 | Slow memory recall admits overlapping proactive generations and stale pacing counters.         | medium   | Async admission FMEA                                                  | One utterance owns the full awaited pipeline.                                                | Two ticks issue two model calls before the first reserves its slot.                                 |

## Verification obligations

| ID  | Risk          | Method                                                                                          | Independence | Evidence                                                                                                                                     | Coverage                                                                                                | Status  |
| --- | ------------- | ----------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R3        | Run existing pet suites through the repository Jest wrapper.                                    | tool         | 254 suites / 2,408 tests passed, exit 0, command below.                                                                                      | Current pet unit and component contracts with repository mocks.                                         | passed  |
| V2  | R1, R2        | Probe tab switching, repeated messages and unsaved successful replies.                          | tool         | Four expected-behavior assertions failed on current source, each at its intended assertion.                                                  | Real stores/hooks, injected transport and transcript seam.                                              | passed  |
| V3  | R2, R3        | Probe clear-during-reply and waiting-during-heartbeat.                                          | tool         | Both expected-behavior assertions failed at their intended assertions, exit 1. See `integration-probes.log`.                                 | Real conversation CRUD/controller, fake IndexedDB and deterministic model response.                     | passed  |
| V4  | R4            | Trace local/remote UI, backup ownership, native window configuration and renderer controls.     | self         | Source inventory and paths below.                                                                                                            | Source-level capability and boundary claims.                                                            | passed  |
| V5  | R5            | Read primary product and accessibility documentation.                                           | tool         | Official ChatGPT Pets, VS Code Pets, VPet, Finch and W3C pages, retrieved 2026-11-17.                                                        | Documented practices, without comparative usability measurements.                                       | passed  |
| V6  | R4            | Re-run native multi-monitor, focus, fullscreen, paired-device and long-session power scenarios. | real-env     | The app binary `target/debug/cognia-next` and `/Applications/Cognia.app` are absent at the inspected paths.                                  | Native acceptance remains to be scheduled with a build from the audited source.                         | blocked |
| V7  | R6, R7, R8    | Trace normal callers and run isolated concurrency/fault diagnostics.                            | tool         | Follow-up economics/reset/source/host diagnostics reproduce the stated failures. See followup-probes.log and lifecycle logs.                 | Real pet CRUD, controller, access, Dexie observation and React lifecycle with controlled collaborators. | passed  |
| V8  | R9            | Switch account partitions during a controlled reply, then inspect the receiving partition.      | tool         | Account B gains account A text after the delayed reply. Both account content ciphers were active through production middleware.              | Real DB activation, encryption and conversation write functions with a deterministic model response.    | passed  |
| V9  | R10, R11, R13 | Run controlled asset, profile, timer and proactive composition diagnostics.                     | tool         | Six intended assertion failures cover deletion variants, rename, secondary Sprite lookup, bubble expiry and overlapping recall.              | Real CRUD and hooks with controlled scheduling; Sprite bootstrap emulated from source.                  | passed  |
| V10 | R2, R8, R12   | Trace canonical remote routing and test care receipts and private reply replay.                 | tool         | Three intended domain failures plus one passing Rust persistence/read/reopen probe. See third-round-probes.log and native-receipt-probe.log. | Real dispatcher/controller and actual SecurityStore; full paired native flow remains open.              | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                     | Action   | Based on                                           | Reversal trigger                                                                                             |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1  | 2026-11-17 | Audit current production paths and run targeted diagnostic checks.                                                           | diagnose | G1, C1, O1                                         | User requests implementation or a narrower assessment.                                                       |
| D2  | 2026-11-17 | Use the repository Jest wrapper directly after pnpm dependency preparation fails.                                            | diagnose | C1                                                 | The wrapper cannot resolve the installed test runtime.                                                       |
| D3  | 2026-11-17 | Extend diagnostics to asynchronous clear and persistent attention before concluding.                                         | diagnose | O3, O4, O5                                         | The suspected paths prove unreachable through normal entry points.                                           |
| D4  | 2026-11-17 | Report five reproduced defects, source-confirmed capability gaps and explicit native acceptance work.                        | diagnose | O1, O2, O3, O4, O5, O6, O7, G1                     | Owning source changes, new reproduction evidence or user changes the product emphasis.                       |
| D5  | 2026-11-17 | Extend the audit into economics, operation retries and reset lifecycle using bounded experiments.                            | diagnose | G2, C1, O1                                         | Source inspection disproves reachability or user redirects scope.                                            |
| D6  | 2026-11-17 | Refine H6 to the documented applied-grant contract, and report ten additional reproducible defects.                          | diagnose | G2, O8, O9, O10, O11, O12, O13, O14, O15, O16, O17 | A production caller supplies an independent scope/lifecycle fence or a reproduction changes outcome.         |
| D7  | 2026-11-17 | Extend the same audit into asset ownership, shared timers, profile writers and canonical remote receipts.                    | diagnose | G3, C1                                             | Candidates prove unreachable or a current regression protects the claimed boundary.                          |
| D8  | 2026-11-17 | Add seven boundary defect categories; retain native and UI scope limits and reject the unproven retry-duplication candidate. | diagnose | G3, O18, O19, O20, O21, O22, O23, O24              | A production ownership bridge/fence changes the experiment precondition or canonical receipt policy changes. |

## Residual risks

| ID  | Residual                                                                                       | From                        | Why still open                                                                                                                               | Next action                                                                                               | Status |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Native behavior and long-session CPU, GPU, memory and battery measurements.                    | V6, R4                      | Source and mocked tests cannot establish operating-system behavior.                                                                          | Build the audited source and run the acceptance scenarios below.                                          | open   |
| X2  | Existing defects remain in the product after this analysis.                                    | R1, R2, R3                  | User requested analysis.                                                                                                                     | Review the findings and implement prioritized fixes with regressions.                                     | open   |
| X3  | Diagnostic concurrency checks have completed.                                                  | V3                          | Both defects are reproducible in the isolated test environment.                                                                              | Carry repairs in X2.                                                                                      | closed |
| X4  | Recommended product emphasis requires user prioritization.                                     | R5                          | A1 remains a proposed assumption.                                                                                                            | Confirm the relative value of workflow monitoring, care and collection when planning implementation.      | open   |
| X5  | Additional economics and lifecycle experiments have completed.                                 | V7, R6, R7, R8              | The listed failures are independently reproducible in isolated test storage.                                                                 | Carry repairs in X2.                                                                                      | closed |
| X6  | Account/host UI transitions and native cancellation still need real-shell acceptance.          | V8, R9                      | Primitive account activation and late-write failure are reproduced. Full account-selector UI and lock transitions remain outside this round. | Add regression fences and exercise the native account/host selectors with delayed replies.                | open   |
| X7  | Native Sprite projection, overlapping settings deletion and paired private-receipt acceptance. | V9, V10, R10, R11, R12, R13 | Controlled diagnostics are complete. Real webviews/devices, OS storage protection and real-provider delays were not exercised.               | Add regressions and run native account/appearance transitions plus send, clear, lock and retry scenarios. | open   |

## Outcome

| ID  | Signal                                                                                       | How / when measured                                                                                            | Result                                                                                                            | Status  |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | Audit yields traceable, prioritized defects and capabilities with primary-source comparison. | Source inventory, six diagnostic assertions, focused tests and completed report, 2026-11-17.                   | Five reproduced defects and nine capability/documentation findings with explicit evidence and acceptance.         | met     |
| M2  | Product repairs improve reliability and native experience.                                   | Follow-up regression and native acceptance after authorized implementation.                                    | Carried to follow-up work.                                                                                        | pending |
| M3  | Follow-up finds additional defects through related module boundaries.                        | Eleven targeted checks and source review, 2026-11-17.                                                          | Ten additional defect categories, with goal and workflow loss grouped under one subscription defect.              | met     |
| M4  | Deeper boundary review adds reproducible evidence without duplicating prior findings.        | Nine targeted assertion failures, one positive native-store diagnostic and canonical source trace, 2026-11-17. | Seven additional categories F25–F31, bringing the defect inventory to 22 plus nine capability/documentation gaps. | met     |

## Verification notes

The normal command `pnpm test --lane=unit --runInBand lib/pet/ hooks/pet/ components/pet/ components/settings/pet/ stores/pet/ lib/tauri/pet-window.test.ts` triggered pnpm dependency preparation. Preparation failed before Jest because `@cognia/agent-config-types/agent-capability-grant` and `agent-composition` resolved to TypeScript source in the sidecar's Node export check.

The installed repository wrapper ran successfully with `node scripts/test/jest.mjs --lane=unit --runInBand lib/pet/ hooks/pet/ components/pet/ components/settings/pet/ stores/pet/ lib/tauri/pet-window.test.ts`. Actual result was 254 suites and 2,408 tests passed in 86.18 seconds. Existing React `act` warnings and an intentionally exercised Dexie failure warning appeared.

Storage-specific verification used `node scripts/test/jest.mjs --lane=unit --runInBand --runTestsByPath lib/db/pet.test.ts lib/db/pet-conversation.test.ts lib/db/pet-models.test.ts lib/db/pet-sprite-packs.test.ts lib/db/pet-media-packs.test.ts --json --outputFile=.cache/pet-gap-audit-2026-11-17/storage-tests.json`. All 5 suites and 49 tests passed, exit 0. Total existing verification was 259 suites and 2,457 tests.

Diagnostic source and output are stored locally under `.cache/pet-gap-audit-2026-11-17/`. Diagnostic test files are briefly copied into `hooks/pet/` for the repository's Jest discovery, then removed by an exit trap. Jest uses isolated memory storage. Diagnostic assertions express expected behavior and intentionally remain red while the audited defect exists.

The four hook/store checks returned exit 1 with four failures in 2.35 seconds. The two respondent/controller/IndexedDB checks returned exit 1 with two failures in 2.718 seconds. All failures were behavioral assertions after successful module loading and test setup. Their local source files are `behavior-probes.test.tsx` and `integration-probes.test.ts`, alongside their corresponding logs. These local cache artifacts may be removed by cache cleanup, while the reproduction procedures and source references above remain in this ledger.

Native UI and real-provider acceptance remain pending for this audit. App build outputs were unavailable at the inspected launch paths. A full native rebuild and cross-platform/device campaign remain V6. Full lint, typecheck and production build were outside the documentation-only deliverable. The ledger checker and formatter apply to the report itself.

### Follow-up verification

The follow-up diagnostic files under `.cache/pet-gap-audit-2026-11-17/` are `followup-probes.test.tsx`, `mount-reset-probe.test.tsx` and `speech-unmount-probe.test.ts`. Their final output is in `followup-probes.log`, `mount-reset-probe.log` and `speech-unmount-probe.log`. The reset and speech probes extend the corresponding existing component/hook test setup and select only the new diagnostic by name.

The nine integration/hook checks returned exit 1 with nine intended assertion failures in 3.373 seconds. The mounted-reset check returned exit 1 at the expected missing-egg assertion in 6.193 seconds. The final speech check returned exit 1 with one intended assertion failure in 0.867 seconds, showing the late history write, TTS and bubble together. The eleven checks cover ten defect categories because the goal and workflow observations share the subscription defect F23.

Initial probe setup exposed an inactive account cipher and an incomplete platform mock. Those setup failures were corrected before the final runs and contribute no findings. The final account-switch check uses real test-generated content ciphers and production encryption middleware in both partitions. No real model/provider or native TTS service is called by the diagnostic collaborators.

Current counterpart verification ran these existing suites through `node scripts/test/jest.mjs --lane=unit --runInBand --runTestsByPath`, with JSON output in `followup-existing-tests.json`.

```text
lib/pet/economy/shop.test.ts
lib/pet/access/gate.test.ts
lib/pet/runtime/pet-controller.test.ts
lib/pet/runtime/init-pet.test.ts
lib/pet/events/sources/goal-source.test.ts
lib/pet/events/sources/workflow-source.test.ts
hooks/pet/use-remote-pet-chat.test.ts
hooks/pet/use-pet-speak.test.ts
components/pet/pet-mount.test.tsx
lib/db/pet.test.ts
```

All 10 existing suites and 196 tests passed, exit 0, in 10.893 seconds. These suites overlap the earlier baseline and are a follow-up check, so they do not add to its unique suite/test count. Source inspection and an independently assigned read-only lifecycle review supplied the normal reset, account-switch and remote-host caller paths.

### Third-round verification

The final diagnostic source is retained locally under `.cache/pet-gap-audit-2026-11-17/` as `third-round-domain-probes.test.tsx`, `third-round-bubble-probe.test.ts`, `third-round-proactive-probe.test.ts` and `native-receipt-probe.rs`. Output is `third-round-probes.log` and `native-receipt-probe.log`. Source tests were copied briefly into repository-discoverable paths and removed with exit traps. All native storage uses a fresh temporary directory; all TypeScript storage uses isolated fake IndexedDB and test account keys.

The final repository Jest wrapper run returned exit 1 with nine intended diagnostic assertion failures and five passing pre-existing bubble checks, across three suites in 3.251 seconds. The first asset-deletion run omitted a settings singleton ID and failed fixture setup; it is excluded. After fixing the fixture, both deletion checks fail at the intended `media` versus `svg` assertion. The other seven final failures also reach their stated behavioral assertions.

The native diagnostic used `cargo test -p cognia-companion-security --test pet_gap_audit_receipt -- --nocapture`. It returned exit 0, one test passed, in 0.04 seconds after a 13.98-second build. Its assertions positively verify ordinary-SQLite plaintext read and reopened-store replay. It does not execute remote HTTP/RTC, clear the native receipt store, or test account locking; those end-to-end consequences are inferred from the traced canonical storage/clear paths and remain explicit acceptance work.

Current counterpart verification ran these ten existing suites with `node scripts/test/jest.mjs --lane=unit --runInBand --runTestsByPath ... --json --outputFile=.cache/pet-gap-audit-2026-11-17/third-round-existing-tests.json`:

```text
lib/db/pet-models.test.ts
lib/db/pet-sprite-packs.test.ts
lib/pet/runtime/rename-pet.test.ts
lib/pet/remote/host-dispatch.test.ts
lib/pet/remote/idempotency.test.ts
hooks/pet/use-pet-bubbles.test.ts
hooks/pet/use-pet-proactive.test.ts
hooks/pet/use-active-sprite-pack.test.ts
lib/pet/skin-assets.test.ts
lib/pet/bubbles/say.test.ts
```

All ten existing suites and 85 tests passed, exit 0, in 6.004 seconds. They overlap the earlier baseline and do not increase the unique baseline count. Existing green checks do not cover the demonstrated composition/interleaving cases. No product source or permanent product test was changed by this audit round.
