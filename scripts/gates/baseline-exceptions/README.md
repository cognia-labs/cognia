# Baseline exception records

A ratchet baseline may only fall (ADR-0250 §11). `scripts/gates/check-baseline-growth.mjs` compares every file listed in `scripts/gates/baseline-growth.json` against the merge base and fails when a measure rose.

When a change has to raise one, it adds a record here in the same change. Name it `<YYYY-MM-DD>-<slug>.json`:

```json
{
  "file": "scripts/gates/host-parity-baseline.json",
  "measure": "findings",
  "allowGrowth": 2,
  "owner": "lib/sandbox",
  "repaymentPhase": "2",
  "reason": "Why the growth is accepted now and what repays it."
}
```

- `file` and `measure` must name a ratchet and one of its measure ids in the HEAD or base revision's `baseline-growth.json`. For an `eachValue` measure, `ceilings` covers every leaf and `ceilings:opaque-response-schema` covers one.
- `allowGrowth` is the most the measure may rise. It is a positive integer. It does not authorize a removal.
- `allowRemoval: true` explicitly approves removing the named measure path, numeric leaf, baseline file or ratchet entry. A removal-only record can omit `allowGrowth`; a record can supply both fields when both operations are intended. No other `allowRemoval` value is valid. It never approves changing a numeric leaf to a string, null or non-finite number.
- Removing a ratchet requires a record for **each** of its base measure ids, using its base `file`. Removing a single `eachValue` leaf can name that leaf instead. For a moved ratchet that keeps its stable `id`, use its HEAD `file` for growth or measure-removal records.
- `repaymentPhase` is an ADR-0250 §13 phase: `0a`, `0b`, `S1`, `1`, `2`, `3` or `4`.
- `reason` has at least 20 characters.

Only a record that is new in the change counts. A record already on the base branch cannot excuse later growth. Records stay here as the history of accepted growth. `pnpm audit:baseline-growth -- --exceptions` prints them as a table for the phase ledger.

For example, an approved retirement of one ceiling uses:

```json
{
  "file": "scripts/gates/rpc-semantic-parity-baseline.json",
  "measure": "ceilings:opaque-response-schema",
  "allowRemoval": true,
  "owner": "lib/companion",
  "repaymentPhase": "1",
  "reason": "The retired response family is now enforced by its replacement contract."
}
```

Ratchet entries have a stable `id` as well as `file`. Preserve the id when moving a baseline: the check reads the base config and compares the new file with the old path's content. Dropping an id and its old file from the config is a `ratchet removed` failure, even if a new path is listed. Changing an id while retaining a file also retains that file's base comparison. On the first rollout, when the base has no config, files are compared at their HEAD paths as before.
