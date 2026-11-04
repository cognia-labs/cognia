# PackageInfo in About technology/dependency credits — 2026-11-01

The user's clarified target is the technology stack and dependency explanation
in About. UpdateCard and its update behavior are unchanged.

## Implementation

- `components/settings/about/tech-stack.tsx` composes the existing PackageInfo
  name, version, description, content and dependency primitives. Its original
  nine brand marks, project names and website actions remain in place.
- The dependency disclosure is closed initially and supports Enter/Space with
  focus retained on the trigger. Its contents scroll within a 320px cap, and
  long package names/source requirements wrap on narrow screens.
- `lib/app-metadata.ts` derives `APP_RUNTIME_DEPENDENCIES` from the root app's
  `dependencies`, sorted by name. No parallel handwritten package inventory
  was added. The verified build contains 235 direct runtime declarations.
- Requirement strings are displayed unchanged, including workspace/catalog
  references and source URLs. Localized copy explicitly says these are
  declarations, not resolved installed versions. Development-only, transitive,
  and Cargo dependency inventories are outside this list.
- `config/ai-elements-adoption.json` now names the actual production consumer,
  `components/settings/about/tech-stack.tsx`, instead of the plugin dependency
  panel. The existing AboutSection → LegalCreditsCard → TechStack path mounts it
  in both desktop settings and the mobile About route.
- Three matching English/Chinese keys were added to split About sources and
  catalogs regenerated. No shared primitive, dependency declaration or update
  workflow was modified.

## Verification

The new metadata and UI tests first failed against the original implementation:
**2 suites failed, 4 failed / 23 passed**. After implementation:

| Check                              | Actual result                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| All About suites plus app metadata | **13 suites / 93 tests passed**, exit 0                                                                         |
| Existing update behavior           | UpdateCard tests passed in the same run                                                                         |
| Consumer audit tests               | **5 passed**, exit 0                                                                                            |
| Scoped ESLint                      | Passed, exit 0                                                                                                  |
| Formatting                         | Scoped Prettier CLI passed for the seven changed source/test/config/split-message files and this report, exit 0 |
| `pnpm i18n:build`                  | Passed                                                                                                          |
| `pnpm i18n:build:check`            | Passed, including ICU validation                                                                                |
| `pnpm lint:i18n`                   | Passed; parity/references valid, 70 legacy literal findings within the 370 baseline                             |
| Message sorting                    | `pnpm i18n:sort:check` passed; both catalogs also match the sort helper's canonical serialization               |
| Chromium / WebKit component checks | Root `pnpm test:e2e` runner: **3 + 3 passed**, both exit 0, with no page errors                                 |
| Scoped static-export scan          | Both changed production sources have no violations or invalid exemption markers                                 |
| Independent read-only reviews      | Test-gap and i18n reviewers reported no findings                                                                |

Behavior assertions cover completeness of declarations, exclusion of dev-only
packages, exact requirement/source strings, real shared PackageInfo rendering,
initial collapse, Enter/Space, focus retention, and original website actions.
Browser checks compare every displayed dependency to the built manifest,
exercise the real LegalCreditsCard/TechStack composition, and check Chinese
narrow-screen wrapping and scrolling. Desktop English/light and mobile
Chinese/dark screenshots were inspected.

The About test run includes existing console warnings from other About tests;
the pass result does not mean warning-free logs.

## Browser harness and recovered runtime startup

The ordinary Playwright CLI attempt timed out waiting for its web server while
new local runtime processes were stalled at startup. A sampled owned Node
process was still at `_dyld_start`. The already-running persistent runtime could
bundle the real components, but its native CSS binding was rejected by macOS
library validation because the process and binding had different Team IDs.
No signing or host security settings were changed.

Interim verification used the existing runtime and the installed pure
JavaScript Tailwind compiler, compiling the current application stylesheet with
literal candidates from the rendered components and primitives. The same three
Playwright-spec callbacks were then executed in-process against real Chromium
and WebKit pages with the installed assertion library. All six passed.

After ordinary Node startup recovered, both suites were rerun through the
repository's normal `pnpm test:e2e` entry point with the fixture's normal
esbuild/PostCSS/Tailwind builder. Chromium passed 3 tests (47.4s), and WebKit
passed 3 tests (3.5s), both exit 0. These final CLI runs are the browser acceptance
evidence; the initial timeout and interim checks are retained in separate logs.

The browser fixture supplies only the external opener port; it renders the real
business/shared components, metadata, translations and current CSS. This is
isolated component/browser verification, not a full application static export,
native Tauri run, or physical-device acceptance.

## Repository-wide gates

- `pnpm audit:ai-elements` exits 1 only for the existing Confirmation consumer
  without its import and the missing Task consumer at `components/chat/todo-list.tsx`.
  PackageInfo no longer appears in the failures. Those two entries were not
  changed in this bounded task.
- `pnpm typecheck` exits 2 with five diagnostics outside this change:
  `hooks/automation/use-sandbox-desktop.test.ts:62` (missing stream `input`),
  `lib/sandbox/session-runtime.test.ts:173`, `:242`, `:262` (obsolete
  `operationsQualified` fixtures), and `packages/agent-acp/src/client.test.ts:3316`
  (`size` on `{}`). No diagnostics were reported in the changed files.
- Full `pnpm lint` exits 1 after scanning concurrent generated copies under
  `cli/.cache/plugin-extraction-js/`: 1,399 errors and 29,750 warnings. The
  concurrent cache and lint configuration were left intact.
- `pnpm lint:static-export` eventually ran and exits 1 with 14 Node-only imports
  in `packages/agent-codebuff/src/{native-process,node-bridge}.ts` and
  `packages/agent-crush/src/node-bridge.ts`. Its scan API also reports no
  violations in this batch's two production sources. Full production build
  acceptance remains unverified while repository gates fail. Coverage was not
  requested and was not run.

## Local evidence

`.cache/package-info-about-2026-11-01/` contains starting copies/hashes, exact
unit and gate logs, browser specifications, current compiled fixture assets,
`browser-cli-final.log`, `browser-webkit-cli-final.log`,
`browser-in-process.json`, `verification.json`, `api-checks.json`,
`static-scope.json`, the startup sample, and screenshots (WebKit under `webkit/`).
Changes are uncommitted.
