# Bot slot and shell/delegate form control adoption — 2026-10-31

This records the third implementation batch from the corrected native HTML
checklist. A separate record preserves the earlier Checkbox/confirm/group and
Button/Progress/Kbd acceptance evidence.

## Implemented scope and contracts

| Source                                              | Change                                         | Preserved contracts                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/bots/sections/triggers-section.tsx`     | `NativeSelect native` and `NativeSelectOption` | Real select change events, parent capture/bubble handlers, implicit label, empty value → `null`, controlled value, per-trigger slot binding, automation/pending disabling, conditional visibility                                        |
| `components/terminal/ai-shell/ai-shell-panel.tsx`   | Shared `Textarea`                              | Existing ref, `rows=2`, multiline drafts, trimmed submit, Enter/Shift+Enter, IME guards, clearing after submit, generating/executing/advisory disabling, plan action wiring                                                              |
| `components/tray-panel/tray-panel-delegate-bar.tsx` | Shared `Textarea`                              | Existing ref, `rows=1`, ResizeObserver and layout effect, 100px height cap, width reflow, shrinking and scrolling, maxLength, validation state, reveal autofocus, runner field mapping, option selection and required/busy send behavior |

The tray input remains editable while its send button is busy, matching its
original behavior. No runner, execution protocol, Host route, shared primitive,
or translation source was changed.

Both Textarea consumers explicitly use `field-sizing-fixed`. AI Shell removes
the shared minimum height; the tray retains its own minimum height and removes
the shared border/padding. Responsive font overrides keep 11px/13px text instead
of inheriting the primitive's larger desktop font. The existing refs continue
to reach the actual textarea nodes.

## Findings resolved during migration

1. **Bot form capture semantics:** the default desktop NativeSelect branch
   produced an additional encoded `option:two` event at the parent form's
   capture listener. Its internal capture handler runs after the ancestor's
   capture handler. The existing `native` mode preserves the original system
   picker and real select event path on desktop and touch devices, while
   adopting the shared theme. The regression assertions remain strict:
   `capture == bubble == ["two", ""]`, with exactly two lifecycle writes and
   no encoding. The shared desktop picker itself was not modified.
2. **Tray IME confirmation:** the original tray handler checked only
   `nativeEvent.isComposing`; a reproducible `keyCode=229` Enter was prevented
   and submitted. It now uses the existing `isImeComposing` helper, as AI Shell
   already does. Both candidate-confirmation forms retain the draft and avoid
   submission; a subsequent ordinary Enter still submits.

## Verification

New tests ran before implementation: **3 suites failed, 5 failed / 56 passed**.
Failures covered adoption and the actual tray 229 regression. The independent
test audit subsequently identified the desktop capture regression; it confirmed
that the native-mode resolution closed its sole blocker. The i18n auditor found
no new UI strings, missing bilingual keys, or orphan keys in this batch.

| Check                                                         | Actual result                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Focused Jest                                                  | **7 suites / 110 tests passed**, exit 0                                                                |
| Included regression suites                                    | Three changed features, tray runner and field control, AI Shell plan view, shared IME helper           |
| Chromium real-component fixture                               | **8 checks passed**, exit 0                                                                            |
| Playwright WebKit fixture                                     | **8 checks passed**, exit 0                                                                            |
| Scoped ESLint / Prettier                                      | Passed for all six source/test files                                                                   |
| `pnpm lint:i18n`                                              | Passed; parity and referenced keys passed; 70 legacy hardcoded-string findings within the 370 baseline |
| `pnpm i18n:sort:check`                                        | Passed                                                                                                 |
| Source lint excluding concurrent `cli/.cache/**` build output | Passed with `--max-warnings=0`                                                                         |
| Scoped `git diff --check`                                     | Passed                                                                                                 |

Browser checks exercised native select events and slot writes, automation and
pending disabling, synthetic IME confirmations, Enter/Shift+Enter, trimmed
submission, all AI Shell busy guards, real tray runner option/prompt mapping,
autofocus/ref behavior, maxLength, width changes, scrolling, and shrinking.
English/light desktop and Chinese/dark narrow screenshots were inspected;
the touch viewport uses device emulation, not a physical device.

The fixture separately bundles the saved pre-change source for direct dimension
comparison. Both Chromium and WebKit produced identical before/after width,
height, font size, line height, padding and field-sizing measurements at 1280px
and 390px viewports:

| Textarea      | Empty | Long content      | Shortened again |
| ------------- | ----- | ----------------- | --------------- |
| AI Shell      | 47px  | 47px              | 47px            |
| Tray delegate | 24px  | 100px, scrollable | 24px            |

These fixtures render the actual changed components, vendored primitives,
repository CSS and tray runner. Lifecycle/Host/model action ports are supplied
by deterministic fixture data; no real Bot credentials, LLM call or native IPC
is exercised. IME key events are synthesized, not entered through an OS input
method in a running Tauri shell.

**E2E decision:** no new full-product E2E is required for this bounded adoption:
routes, persistence and Host/model protocols are unchanged. Co-located behavior
tests own the event contracts; the browser fixtures check native DOM behavior,
layout and the WebKit-sensitive keyboard guard. A fresh production export and
native Tauri acceptance remain unverified.

## Repository-wide check limits

The recorded `pnpm typecheck` exits 2 with **15 diagnostics in eight files
outside this batch**. No diagnostics remain in the six changed files:

- `hooks/automation/use-sandbox-desktop.test.ts:62`: missing stream `input`.
- `lib/connectors/adapters/_shared/a2ui-mapper.test.ts:189`: missing `surfaceId`.
- `lib/db/integrations.test.ts:40`: incompatible `ingressEndpoint` fixture.
- `lib/sandbox/session-runtime.test.ts:173`: three obsolete
  `operationsQualified` fixture properties, also at lines 242 and 262.
- `lib/skills/built-in/lark/_helpers.test.ts:128` and `_helpers.ts:67`:
  five schema/unknown argument diagnostics across these files.
- `plugins/feishu-auth/src/oauth.test.ts:60` and `oauth.ts:305`:
  four `fetchImpl`/implicit parameter type diagnostics.

`pnpm lint` exits 1 after scanning concurrent generated plugin copies in
`cli/.cache/plugin-extraction-js/`: 1,399 errors and 29,750 warnings. Running the
same source lint with only `--ignore-pattern 'cli/.cache/**'` added passes.
The repository configuration and concurrent cache were left intact. The owning
build/lint workflow needs to exclude those generated copies or clean them when
its task finishes before the unmodified command can pass.

`pnpm lint:static-export` exits 1 with 14 Node-only imports in
`packages/agent-codebuff/src/{native-process,node-bridge}.ts` and
`packages/agent-crush/src/node-bridge.ts`. These modules need separate repairs.
A full production build was not run while the type/static-export gates failed.
Coverage was not requested and was not run.

## Evidence and worktree safety

Starting copies, hashes, final scoped diff, exact logs, screenshots and the
browser fixture are under `.cache/shared-form-controls-2026-10-31/`. Key files:
`baseline.json`, `verification.json`, `red.log`, `unit.log`, `browser.log`,
`browser-webkit.log`, `browser-dimensions.json`, `webkit/browser-dimensions.json`,
`typecheck.log`, `lint.log`, `lint-source.log`, `static-export.log`, and
`final.diff`.

The six files were clean at the starting snapshot. Earlier batches and
concurrent changes were preserved. Changes remain uncommitted.
