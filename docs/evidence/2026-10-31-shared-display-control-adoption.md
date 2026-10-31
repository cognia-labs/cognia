# Shared Button, Progress, and Kbd adoption — 2026-10-31

This records the second implementation batch from the corrected native HTML audit.
It keeps the earlier Checkbox/confirm/Tabs/RadioGroup evidence intact in
`2026-10-31-shared-control-adoption.md`. Scope is the manually reviewed controls,
not every native HTML element in the repository.

## Implemented scope

| Feature                      | Replacement            | Behavior retained or corrected                                                                                             |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| RunPanel queue edit/remove   | Two `Button` instances | Existing callbacks, Enter commit, Escape cancel, queue/transcript synchronization, explicit non-submit type, 16px controls |
| PreviewClampNote             | Link `Button`          | Expansion callback, localized label, compact text size, explicit non-submit type                                           |
| WebFetchCard                 | Link `Button`          | Full-content expansion, copying the complete payload before expansion, explicit non-submit type                            |
| DiagnosticCard detail toggle | Ghost `Button`         | Local disclosure state, technical evidence, localized labels, `aria-expanded`, explicit non-submit type                    |
| QuotaBar                     | `Progress`             | Status colors, 8px track, 500ms transition; missing readings now omit `aria-valuenow`, distinct from known 0%              |
| TaskProgressBar              | `Progress`             | Done/total value text, empty/overflow calculation, warning fill, 6px track, reduced-motion support                         |
| AssessmentCard               | `Progress`             | Rounded score, severity fill, track size, existing localized assessment label as accessible name                           |
| KeyboardShortcutsDialog      | `Kbd`                  | Effective/rebound shortcut text, unbound-row omission, native kbd semantics, selectable monospace text                     |
| ComposerCheatsheet Keycap    | `Kbd`                  | Send/newline settings, history visibility, prefix characters, natural keycap height, selectable monospace text             |

`components/ui/progress.tsx` adds only an optional `indicatorClassName`, merged
through `cn()`. This keeps business-specific colors, rounding and transitions
in existing wrappers. The default progress styling and transform are unchanged.
No new component, route, dependency, translation key, or UI-directory test was added.

AST comparison against the saved starting files confirms five native button
sites, three custom progressbar sites, and two native kbd wrapper sites adopted
the shared primitives. These are source locations, not rendered element counts.

## Native implementations retained

- RunPanel's four remaining native buttons: summary disclosure, queue chip,
  drag handle, and transcript locator. The drag handle retains dnd-kit attributes,
  listeners and touch behavior; the locator retains its disabled behavior.
- Media/seek controls, multi-segment indicators, layout measurement ghosts,
  editor controls, and other sites outside the manually confirmed batch.
- `Kbd` continues rendering semantic `<kbd>`; raw semantic HTML inside shared
  primitives is expected.

## Verification

| Check                            | Actual result                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests before implementation      | New adoption/null-reading checks failed against the original source; WebFetch's copy selector was corrected to its actual accessible name and its adoption failure reconfirmed before replacement |
| Focused Jest, final uncached run | **11 suites / 154 tests passed**                                                                                                                                                                  |
| Included regressions             | `run-panel.drag.test.tsx` and existing `ui/loading-region.test.tsx` passed alongside all nine feature suites                                                                                      |
| Browser verification             | **7 Chromium checks passed**, using real changed feature components and shared primitives                                                                                                         |
| Browser interactions             | Enter/Space activation, no form submission, full-content copy/expansion, diagnostic disclosure, queue edit/cancel/remove, disabled locator and drag attributes                                    |
| Browser presentation             | Progress transforms, colors, track heights, 500ms quota transition, reduced-motion task progress, unknown vs zero, default Progress styling; shared keycaps and settings updates                  |
| Browser visual review            | Inspected desktop English/light and 390×844 Chinese/dark screenshots; checked no horizontal overflow and mobile action/keycap visibility                                                          |
| Scoped ESLint / Prettier         | Passed for all 19 source/test files                                                                                                                                                               |
| Full `pnpm lint`                 | Passed, exit 0                                                                                                                                                                                    |
| `pnpm lint:i18n`                 | Passed; key parity and referenced-key checks passed, 70 hardcoded-string findings within the existing 370 baseline                                                                                |
| `pnpm i18n:sort:check`           | Passed, exit 0                                                                                                                                                                                    |
| Scoped diff whitespace check     | Passed                                                                                                                                                                                            |
| Independent read-only audits     | Test-gap and i18n reviewers reported no findings in this batch                                                                                                                                    |

Jest still reports React `act` warnings from the pre-existing test that reseeds
the store while RunPanel is mounted. The new queue test uses real store/steer
logic and mocks the persistence boundary, asserting the synchronized transcript
and persistence call; it does not require IndexedDB.

Browser checks use an isolated fixture with real components, installed Radix
and repository CSS. Host/store ports, unrelated heavy renderers, clipboard
storage and shortcut data are supplied by the fixture. This is component/browser
verification, not a full application, real-account, native Tauri, or provider run.

## Repository-wide blockers and residual limits

`pnpm typecheck` exits 2 with two diagnostics outside this batch:

- `hooks/automation/use-sandbox-desktop.test.ts:62`: TS2741, mocked
  `NativeFrameStream` is missing `input`.
- `lib/connectors/bus.test.ts:981`: TS2322, mocked `LiveSteerResult` is missing
  `activeRun`.

No diagnostics were reported in the changed files. The root check stops before
the later sidecar typecheck command.

`pnpm lint:static-export` exits 1 with 14 Node-only imports in
`packages/agent-codebuff/src/{native-process,node-bridge}.ts` and
`packages/agent-crush/src/node-bridge.ts`. This batch adds no Node imports.
Those owning modules need separate repairs before the repository-wide gates can
pass. A full production export was not attempted while these checks were failing.
Coverage was not requested and was not run.

## Local evidence

The starting copies, file hashes, before/after AST counts, exact diff, command
logs, browser harness and screenshots are under
`.cache/shared-display-controls-2026-10-31/`. Key records are `baseline.json`,
`verification.json`, `unit.log`, `browser.log`, `typecheck.log`, `lint.log`,
`i18n.log`, `i18n-sort.log`, `static-export.log`, and `final.diff`.

Changes remain uncommitted. Previous-batch and unrelated concurrent work were
preserved.
