# External Agent brand gaps

Observed on 2026-10-30, independently of the Provider/brand catalog convergence.

The existing `components/icons/brand-icon.test.tsx` suite requires brand assets
for these 16 external Agent IDs, but the original catalog has no corresponding
alias/resource selection:

- `openclaude`
- `crush`
- `continue-dev`
- `rovo-dev`
- `codebuff`
- `auggie`
- `autohand-code`
- `codebuddy`
- `command-code`
- `kilocode`
- `mistral-vibe`
- `mimo-code`
- `hermes-agent`
- `oh-my-pi`
- `muse`
- `zcode`

Each ID fails both the built-in-preset resource assertion and the teammate-runtime
alias assertion: **32 existing failures**. Before convergence the suite had
149 passing / 32 failing tests; after convergence it has 151 passing / the same
32 failing tests. The two added passing tests cover reserved object keys.
Failure names were compared exactly using `.cache/provider-brand-baseline-failures.json`
and `.cache/provider-brand-after.json`.

The convergence keeps these assertions and the monogram fallback. It does not
download assets, substitute unrelated vendor marks, or claim these missing
brands are fixed. Follow-up work should establish each intended brand identity,
confirm an appropriate resource and its license, add the resource under
`public/icons/` and its alias in `packages/brand-assets/src/index.ts`, then rerun
the existing BrandIcon suite and the shared asset contracts.
