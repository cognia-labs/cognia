# Cognia repository instructions

These project-specific requirements supplement inherited instructions. Use the repository configuration and package manifests as the source of truth for membership, versions, and commands.

## Project boundaries

- The main app uses Next.js 16, React 19, TypeScript, and Tailwind CSS v4. Its production build is a static export in `out/`, shared by the browser and Tauri; Capacitor uses the mobile build variant. Do not introduce dependencies on a runtime Next.js server into exported functionality.
- `pnpm-workspace.yaml` defines the JavaScript workspaces: the root app, `mobile/`, `cli/`, `packages/*`, and `services/workspace-runtime/` (the other services live in cognia-labs/cognia-services, pinned by `integrations/cognia-services.json`). Install workspace dependencies from the repository root. Independently managed sidecars and services may have their own manifests and lockfiles. The browser extension lives in `cognia-labs/cognia-browser-extension`. Its driving profile `agent-safe-v1` is frozen: add browser operations only as a named capability in `hello.features`, mapped in `operationFeatures` of `packages/companion-client/src/browser-agent-protocol.json` and refused by the Host for a browser that did not name it (ADR-0242).
- `Cargo.toml` defines the Rust workspace containing `src-tauri/` and shared crates. Place new Rust logic in the lowest-layer crate that can own it, following `scripts/gates/rust-architecture.json`; keep desktop integration in the Tauri shell.
- Main-app code lives in `app/`, `components/`, `hooks/`, `lib/`, and `stores/`; static assets live in `public/`. Follow the existing App Router file conventions. The main development server uses port 3000; docs development uses port 3001.
- Keep contributor guides in `docs/development/` and repository-root-context Dockerfiles in `deploy/docker/`. Keep their Docker build context at the repository root; update CI, Compose, gates, and links when moving build inputs. See [the directory guide](docs/README.md) for ownership.
- Keep local caches and verification output under `.cache/` when the tool supports an explicit output path. TypeScript's API/build caches use `.cache/typescript/`; the native CLI typecheck uses `.cache/typecheck/`.

## Implementation constraints

- Before adding code, inspect existing implementations in the affected modules or workspaces and the relevant ADRs. Use the navigation tools available in the session. New files require an explanation of why an existing module cannot be extended.
- Import existing UI primitives directly from `components/ui/` and `components/ai-elements/`. Check the actual directories before invoking component scaffolding; do not reinstall an existing component or maintain a fixed component-count assumption.
- `TooltipProvider` is already supplied by `components/runtime/app-runtime.tsx`; reuse the existing runtime provider instead of adding another wrapper.

## Tests and i18n

- New or edited source files under `components/**`, `hooks/**`, `lib/**`, and `src-tauri/src/**` require co-located unit tests in the same change, except the two component directories excluded below. TypeScript tests use `*.test.ts` or `*.test.tsx` beside the source; do not put unit tests in separate `__tests__/` or `tests/` directories. Rust unit tests belong in an in-file `#[cfg(test)]` module; Rust integration tests may live in `src-tauri/tests/`.
- Do not add new unit-test files under `components/ui/` or `components/ai-elements/`. These directories remain excluded from Jest coverage; existing tests there do not authorize expanding that exception.
- Use the repository's Jest entry point, `pnpm test`, for unit tests and Playwright for E2E. Root scripts wrap the runners and handle repository-specific setup; do not substitute a default Vitest workflow.
- Coverage is opt-in for local task execution: do not run coverage commands or enforce coverage thresholds unless the user explicitly requests a coverage check. When requested, retain the ≥90% target for lines, branches, and functions, prioritizing `lib/`, `hooks/`, `stores/`, and `src-tauri/src/`. `pnpm test:coverage` runs sharded Jest coverage and merges the results.
- Distinguish that requested target from existing automated gates: `scripts/test/coverage-thresholds.json` defines per-path Jest thresholds; full-mode PR CI separately checks changed files at 90% per metric. Local opt-in does not disable CI policy, and Jest coverage does not measure Rust. Do not silently lower either a requested target or an existing gate.
- Wire user-facing strings in `.tsx` through `next-intl` (`useTranslations` / `getTranslations`). Aria labels, placeholders, toasts, and error messages count. Add matching keys to split source files under both `i18n/messages/en/**` and `i18n/messages/zh-CN/**`.
- Never directly edit generated `i18n/messages/en.json` or `i18n/messages/zh-CN.json`. After editing split sources, run `pnpm i18n:build`, `pnpm i18n:build:check`, and `pnpm lint:i18n`. The lint has a legacy baseline; also review newly added strings and keys, and do not refresh the baseline to conceal new findings.

## Development and verification entry points

Run commands from the repository root unless a workspace is explicitly selected. `package.json` owns the current scripts and lifecycle preparation; the table lists common entry points rather than duplicating their implementation.

| Commands                                                  | Purpose                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm dev` / `pnpm build`                                 | Main-app development / production static export                  |
| `pnpm lint` / `pnpm lint:fix`                             | ESLint checks / fixes; the lint gate permits no warnings         |
| `pnpm format:check` / `pnpm format`                       | Prettier checks / formatting                                     |
| `pnpm typecheck`                                          | Repository type checks, including sidecar preparation and checks |
| `pnpm test` / `pnpm test:watch`                           | Jest unit tests / watch mode                                     |
| `pnpm test:e2e`                                           | Playwright E2E tests                                             |
| `pnpm lint:static-export`                                 | Static-export compatibility checks                               |
| `pnpm tauri dev` / `pnpm tauri build` / `pnpm tauri info` | Tauri development / packaging / environment information          |

## Documentation ownership

- The public Fumadocs site and product guides live in [cognia-labs/cognia-docs](https://github.com/cognia-labs/cognia-docs), with independent install, tests, build and deployment. Follow that repository's AGENTS.md; do not recreate its app/components/lib or product-guide tree here.
- ADRs stay under `docs/content/docs/{en,zh}/adr/`; API contracts, plans, research, evidence, development guides and runbooks remain in this repository. Generated SDK reference stays owned by its generator and is published as a read-only snapshot.
- The application consumes a committed offline corpus and page index pinned by `integrations/cognia-docs.json`. `pnpm docs:check` verifies hashes without fetching or reading a sibling checkout. Update intentionally with `pnpm docs:sync --docs-root <committed docs checkout>`.
- `pnpm audit:docs-links` validates retained source links against the pinned publication index; the docs repository owns full-site sidebar, route, MDX and Pages checks.

## Security and PR requirements

- Use `.env.local` for local secrets and do not commit `.env*` files. Only safe client-visible values may use `NEXT_PUBLIC_*`.
- Keep Tauri permissions narrow. Review `src-tauri/capabilities/*.json` as well as security configuration in `src-tauri/tauri.conf.json`; avoid broad filesystem access.
- PRs require a brief scope and intent, validation steps/results, screenshots for UI changes, and a passing `pnpm lint`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
