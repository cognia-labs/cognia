# Shared control adoption — 2026-10-31

## Scope and result

This implements the first batch from the corrected native-HTML audit:
two checkbox locations, two browser confirmations, two Memory tab strips,
and four single-choice groups across three feature components. Application
changes remain uncommitted. Concurrent work elsewhere in the checkout was
preserved.

| Surface                             | Shared owner              | Behavior retained or added                                                                                                 |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Managed desktop screenshot criteria | Checkbox + Label          | Stable label association, Space activation, boolean updates, row editing and validation                                    |
| Managed desktop cost consent        | Checkbox + Label          | Explicit current-quote consent before Start; toggling consent alone never starts acceptance                                |
| A2UI event-history clearing         | useConfirmDialog          | Destructive themed decision, cancellation/Escape/unmount refusal, clear only after approval                                |
| A2UI template deletion              | useConfirmDialog          | Request-specific template identity and translated delete aria-label; cancellation/Escape/unmount refusal                   |
| Desktop Memory tabs                 | Tabs/List/Trigger/Content | Arrow-key selection, one group tab stop, trigger/panel associations, existing list/health/external branches                |
| Mobile Memory tabs                  | Tabs/List/Trigger/Content | Same keyboard and panel contract while retaining the main landmark, platform-specific tabs, inspector and refresh behavior |
| Glance usage scope                  | RadioGroup/RadioGroupItem | Arrow-key selection; All tools still requires a separate explicit consent before sending the request                       |
| Discover sort and filter            | RadioGroup/RadioGroupItem | Two independent groups, immediate exact values, reset, desktop Popover and mobile Sheet                                    |
| Subagent tool scope                 | RadioGroup/RadioGroupItem | Distinct undefined, empty array and remembered custom list; selecting the current choice cannot clear it                   |

The local RadioGroupItem now accepts custom children. This serves the compact
text choices in three feature components; callers without children still
receive the existing Indicator and circle. There were no existing production
consumers passing children before the extension. A real SiteDomainsTab test
checks the default indicator, and ToolScopeField tests check the text-only path.
No tests were added inside the coverage-exempt UI or AI Elements directories.

Native file-dialog targets, form grouping elements, content renderers,
specialized editors, media controls and other justified native implementations
were retained. This batch does not migrate the Bot Select or the audit's
ordinary Button, Progress and Kbd follow-ups.

## Behavioral verification

- Before implementation, all 17 new targeted cases failed across the nine
  feature suites for the expected missing shared-control or keyboard behavior.
- After implementation, `pnpm test --runInBand --no-cache` over the nine
  changed feature suites plus SiteDomainsTab and useConfirmDialog passed:
  **11 suites, 184 tests, 0 failures**.
- After the final mobile root arrangement, its suite passed again:
  **21 tests, 0 failures**. Subsequent mobile cleanup restored only original
  whitespace in untouched code.
- Focused ESLint passed with zero warnings on the changed source/test files.
- Prettier passed with the project's ignore configuration. The existing mobile
  ignore was respected; unrelated legacy formatting was preserved.
- Scoped i18n review found no new hard-coded user-facing strings or missing
  English/Chinese keys. No translation files were changed by this task.
- The test-gap review's only finding was closed by the default-indicator and
  custom-child regressions above.

Tests use the actual shared Radix controls. Radio arrow checks separate
keydown and keyup so Radix's deferred focus handler runs while the key is held;
the selection and callback assertions remain intact.

## Browser verification

`pnpm test:e2e --config
.cache/shared-controls-fix-2026-10-30/browser/playwright.config.ts` passed
**8 Chromium tests**. The standalone fixture bundles the real affected
components and shared controls with the application's compiled CSS. It checks:

1. English and Chinese checkbox labels, Space and controlled state.
2. Event clearing only after themed approval, Escape cancellation and focus return.
3. Template deletion identity and cancellation in the dark theme.
4. Desktop Memory keyboard selection and visible associated panels.
5. Mobile Memory keyboard selection and associated panels at 390px.
6. Tool-scope keyboard changes preserving inherited, empty and remembered values.
7. Discover sort/filter keyboard changes inside the visible mobile Sheet, with no horizontal overflow.
8. All tools remaining unrequested until the additional consent is confirmed.

The fixture replaces data/Host ports, Memory content/state services and
Next routing/image adapters. Its unused pricing calls throw if invoked.
It does not exercise a real provider, unlocked account, billing, native Host,
Tauri or physical mobile device. The cost-consent surface is covered by its
integration suite rather than a live acceptance run.

Screenshots were captured with finite animations settled and visually inspected:
mobile Memory and Discover, text-radio selected states, Chinese checkbox labels,
and themed confirmation dialogs. Nine images and all browser scaffolding remain
under `.cache/shared-controls-fix-2026-10-30/browser/`.

## Repository-wide checks and limits

The full checkout was not green at the recorded verification runs. None of
the following owning paths is part of this implementation:

| Check                   | Actual result                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm typecheck          | Two remaining diagnostics: missing NativeFrameStream.input in hooks/automation/use-sandbox-desktop.test.ts:62; Uint8Array/BufferSource overload mismatch in lib/remote-desktop/native-stream.ts:207. Root failure prevents the subsequent sidecar typecheck. |
| pnpm lint               | Two no-assign-module-variable errors in mobile/scripts/android.test.mjs:605 and scripts/plugin/build-frontend-plugins.test.mjs:23, plus an unused valueSha256 warning in scripts/plugin/test-authoring-kit.mjs:10.                                           |
| pnpm lint:i18n          | Eight referenced-key findings in concurrently edited managed-desktop-settings.tsx, sandbox-desktop-viewer.tsx and sandbox-file-transfer.tsx. The scoped review of this task found none.                                                                      |
| pnpm lint:static-export | Fourteen Node-only imports in packages/agent-codebuff and packages/agent-crush. This batch adds no Node/server imports.                                                                                                                                      |

An existing zero-argument Jest mock in the edited handoff test was typed to
accept its actual unknown input; the corresponding type diagnostic disappeared
on the subsequent real typecheck. The two other diagnostics above remained.

No full production build, packaged Tauri acceptance, real Host acceptance or
physical-device acceptance is claimed. Detailed command output is retained in
`.cache/shared-controls-fix-2026-10-30/`: `red.log`, `targeted-tests.log`,
`mobile-final.log`, `browser-e2e.log`, `scoped-lint.log`, `format.log`,
`typecheck.log`, `lint.log`, `i18n.log` and `static-export.log`.
