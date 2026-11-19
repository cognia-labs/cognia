---
name: audit-fix
description: >-
  Take a pasted list of problems (audit report, code-review findings, bug list, "F01–F16", a doc path) and work it
  through dialectically: verify every item against the real code before believing it, give each a verdict with
  evidence, fix the confirmed ones at the root cause with a regression test, delete old/dead/compat code outright
  instead of patching it, and look things up online whenever behaviour of a library, API, platform or spec is
  uncertain. Ends with a per-item verdict table. Use whenever the user pastes or points at a list of issues to fix,
  even without naming this skill. Triggers: 辩证的看待下面的问题, 辩证地看, 修复下面的问题, 逐条修复, 审计问题,
  审查结果, review findings, audit findings, 问题清单, 老代码/死代码直接删除, 不确定就联网搜索.
argument-hint: <问题清单，或包含问题的文件路径>
---

# Audit fix: verify, then fix precisely

The problems to work through:

$ARGUMENTS

If that is empty, the list is in the user's message. If it is a path (a review doc, a
`docs/evidence/` ledger, a findings file), read it. If there is still no list, ask the
user for it in Chinese before doing anything else.

A findings list is a set of claims, not a set of facts. Reviewers (human, Codex,
subagents) misread code, report things already fixed, flag by-design behaviour as a
bug, name the symptom instead of the cause, and propose fixes that just move the bug.
Fixing every item as written produces churn and new defects. So every item gets
checked against the code first, and only what survives gets fixed. The fixes
themselves are exact and complete, not approximations.

`CLAUDE.md`'s Working Rules apply throughout: tests ship with every change, user-facing
strings go through i18n, a changeset goes with user-facing fixes, and the working tree
is shared.

## 1. Intake

Split the input into items. Keep the user's IDs (F01, ES-12, B07…). Give unnumbered
items `F01`, `F02`… in the order given. For each item, write down three separate
things, because reviewers often blur them:

- **Observation**: what the reviewer says happens.
- **Claimed cause**: why they think it happens.
- **Proposed fix**: what they want done, if anything.

Group items that touch the same subsystem or file, and check for duplicates.
Two items can be one bug seen from two places.

## 2. Verify each item dialectically

For each item, try to prove it wrong before you accept it. Read the code it points
at and the code around it: callers, the test file, the owning module's manifest
and its ADR (the Subsystem Map in `CLAUDE.md` says where to look). Then give it one
verdict:

| Verdict                 | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Confirmed**           | Real, and the claimed cause is right.                                                          |
| **Confirmed, reframed** | Real, but the cause, the scope or the proposed fix is wrong. Say what it really is.            |
| **Not a defect**        | By design. Cite the ADR, test or comment that makes it intended.                               |
| **Already fixed**       | Cite the commit or the line that fixes it (`git log -S`, `git log -L`).                        |
| **Stale**               | The code it describes no longer exists or has moved on.                                        |
| **Needs a decision**    | Fixing it means a product or architecture choice the code can't settle. Ask the user.          |

Each verdict carries evidence: `path:line`, a test you ran, a command's output, or a
cited source. "Looks fine" is not evidence. When you can cheaply reproduce the bug
with a failing test, do that: the test then becomes the regression test.

When an item is confirmed, look for its siblings. The same mistake usually exists in
the parallel code path (the other shell, the Rust twin of a TS function, the other
connector adapter, the mobile variant). Fix the class, not one instance, and mention
the extra sites in the report.

For long lists, subagents may gather evidence per group in parallel (use
`model: "haiku"` for Explore agents). They locate code; the verdict stays yours.

## 3. Look it up when you are not sure

If a verdict or a fix depends on how something outside this repo behaves (a library
API, a framework's version-specific behaviour, a browser/WebView/OS quirk, an RFC, a
vendor API such as Feishu, GitHub or an LLM provider, a Rust crate's semantics), do
not answer from memory. Your knowledge may be older than the version installed here.

- Library or framework docs: context7 (`resolve-library-id`, then `query-docs`).
  Check the installed version first (`package.json`, `Cargo.lock`, `node_modules/<pkg>/package.json`).
- Current facts, vendor APIs, changelogs, issue trackers: `codex-web-search`,
  WebSearch or exa.
- Installed source beats docs: when docs and `node_modules/` or `~/.cargo/registry`
  disagree, the installed code is what runs.

Cite what you found (URL or file) in the item's evidence. If the search still leaves
it open, say so and mark the item **Needs a decision** rather than guessing.

## 4. Fix what survived

For each **Confirmed** / **Confirmed, reframed** item:

- Fix the root cause, not the symptom. If the reviewer's fix only hides the symptom
  (a retry around a race, a null check around a bad invariant), don't take it.
- Implement the full behaviour: error handling, edge cases, both locales, every host
  the code runs on. No stubs, no `// TODO`, no quiet narrowing of scope. If part of it
  can't be done now, say what blocks it.
- Add or update a co-located test that fails without the fix. Pin the bug, not just
  the happy path.
- Reuse what exists (grep `lib/`, `components/`, `hooks/`, `crates/` first). Don't add
  a second helper beside an existing one.

## 5. Delete old and dead code

When the work runs into old code, dead code or compatibility layers, delete them
instead of fixing or working around them. Local data is not migrated, and shapes
carry no version suffix, so legacy readers, `v2`/`Legacy` paths, deprecated aliases,
fallbacks for formats nothing writes any more, and unused exports should go.

Prove it is dead before deleting. This repo reaches code in ways a plain grep misses:

- Module manifests (`lib/*/module.ts`, `components/*/module.ui.ts`) and the generated
  registries under `lib/modules/generated/` (regenerated, gitignored).
- Lazy `import()` specifiers, string-keyed lookups (tool names, task types, slash
  commands, settings keys, i18n keys), plugin catalogs (`packages/plugin-contract/contract/catalog.json`).
- Rust: `#[tauri::command]` registration in `src-tauri`, `invoke("…")` names in TS,
  serde wire names, feature-gated modules.
- Sidecar launchers (`sidecar/*.mjs` paths are a contract), `scripts/`, CI config, docs.

Delete the whole thing: the code, its tests, its i18n keys (both locales, then
`pnpm i18n:build`), its settings keys, its docs mentions, and any baseline entry it
had (baselines only shrink). If something only looks dead but a contract may depend on
it (a wire format a paired device or an older Host still sends, a plugin API surface),
it is not dead. Mark it **Needs a decision** and ask.

Never delete uncommitted work another session left in the tree. If a file you want to
remove has foreign changes in `git diff`, leave it and report it.

## 6. Verify

Run what proves the fixes, scoped to what you touched. Don't run full suites or
coverage.

- Jest: `pnpm test -- <paths> --runInBand`.
- Types: `pnpm typecheck` (or the narrower project config if it is too heavy).
- Rust: `cargo test -p <crate>` for the crates you changed.
- The gates your change touches: `pnpm audit:modules`, `pnpm audit:colocated-tests`,
  `pnpm lint:i18n`, `pnpm i18n:build:check`, `pnpm sidecar:typecheck`, …
- UI-visible fixes: check them in the browser preview when it can show them.

A failure in a file you did not touch is pre-existing: report it, don't fix it.

## 7. Commit

Commit in coherent batches (one subsystem or one class of bug per commit), following
Rule 8: `git commit --only <paths>`, never `-a` or `git add .`, check
`git diff --cached --name-only` first, never `--no-verify`. Conventional Commit
messages that name the item IDs (`fix(connectors): …(F03, F07)`). Add a changeset for
user-facing fixes. If the user said not to commit, leave the diff and say so.

## 8. Report (in Chinese)

End with one table covering every item, so nothing silently drops:

| ID  | 结论 | 依据 | 处理 | 测试 |
| --- | ---- | ---- | ---- | ---- |

- **结论**: the verdict from step 2.
- **依据**: `path:line`, commit, or source URL.
- **处理**: what changed, or why nothing did.
- **测试**: the test that pins it, or what was run.

Then, briefly:

- **删除的代码**: what was removed and how you proved it dead.
- **需要你决定**: each **Needs a decision** item as a concrete question with the
  options and your recommendation.
- **未验证 / 残余风险**: what was not run (Tauri shell, real device, real provider,
  Rust crate tests skipped for disk) and anything still open.
- Commits made (short hashes).
