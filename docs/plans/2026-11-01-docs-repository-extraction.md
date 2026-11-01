# Extract the documentation site into cognia-docs

Status: Code published; main migration in draft review; Cloudflare upload awaits environment configuration

Date: 2026-11-01

Owner: Codex

Source baseline: origin/dev at be4e03e4f856c55f3a211282ce51ca1fd1390a86

## Outcome and boundaries

The public documentation site and product guides move to cognia-labs/cognia-docs with independent install, lint, unit tests, browser tests, static build and Cloudflare Pages deployment. ADRs, OpenAPI/AsyncAPI and development/research/evidence/runbooks stay in cognia. The parallel working tree and its unpublished commits are not included in this extraction.

The docs repository keeps checked-in, read-only publication snapshots of the main repository's ADRs and generated SDK reference. An explicit source import records repository, commit, per-file SHA-256 and timestamps. Normal install, build, tests and deployment never require another checkout or network source import.

The application keeps a checked-in Support Agent corpus and a pin naming its docs repository commit and SHA-256. Normal app builds verify this local artifact. An explicit docs sync command copies a committed docs artifact and updates the pin. The application does not fetch documentation at runtime or during normal builds.

## Work and acceptance

| Phase | Work                                                                                                                 | Verification                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1     | Extract only published docs history into an independent repository; retain license and provenance                    | Filtered history scan, source ownership check, independent lockfile installation                                        |
| 2     | Add immutable source imports, local i18n, source-aware links/timestamps, static preview, independent quality tooling | Unit and script tests; strict typecheck; lint; format; no parent or sibling source dependency                           |
| 3     | Preserve static export, compressed search Worker and LLM/Markdown surfaces                                           | Production build, Chromium browser journeys, actual Pages local runtime                                                 |
| 4     | Add CI, artifacts and staging/production deploy workflow with configuration validation                               | GitHub CI and deployment dry run; actual upload requires Cloudflare configuration                                       |
| 5     | Replace main-repository source coupling with a pinned offline corpus; remove site workspace and jobs                 | Snapshot tamper/missing tests, Support Agent tests, workflow contract tests, i18n checks, lint and applicable typecheck |
| 6     | Publish the docs repository and a reviewable main-repository change                                                  | Verified author/committer, focused staged paths, remote CI, final diff review                                           |

## Existing modules and new files

Extend build-support-docs.mjs and knowledge.ts rather than introducing a second runtime help system. A new explicit cross-repository sync script is required because the existing builder must remain offline and deterministic. The docs repository needs its own configuration, publication importer, preview/deployment helpers and tests because no parent or sibling tooling may be required after extraction.

## Compatibility and recovery

Preserve /en, /zh, localized docs paths, shared plugin-dev pages, Markdown routes, llms surfaces and the current Cloudflare search response contract. Page origin determines edit links and timestamps, so imported ADRs point at cognia and product guides at cognia-docs. Preserve the current search gzip size guard.

The main application retains the previous pinned corpus until an explicit update succeeds. Sync validates the complete new artifact before changing either file. A failed deployment never silently falls back to localhost metadata. Deployment is serialized by environment; old production publication is retired only with the main-repository switch. Rollback consists of the prior docs revision and a prior corpus pin; main published history is not rewritten.

## Verification evidence

Results and remaining environment limitations will be recorded in docs/evidence/2026-11-01-docs-repository-extraction.md. No local coverage command is authorized; existing full-mode CI coverage policy is retained in the extracted repository.
