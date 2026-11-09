/**
 * Shared move-guard evaluation for the Squad and single-Agent task boards.
 *
 * The Squad and single-Agent task boards each decide which status changes a
 * person may make. Their rules differ: a Squad locks its active columns while
 * the team runs, and an Agent task may be paused or cancelled mid-run. They share
 * the SHAPE of a rule set, and that shape lives here, so each guard is a table
 * of data rather than a hand-written cascade of `if`s.
 *
 * A rule set is checked in a fixed order, and the first rule that speaks
 * decides:
 *   1. `readOnly`        the row is not this surface's to move at all, not
 *                        even within its own column;
 *   2. same column       a reorder, always allowed;
 *   3. `derived`         columns the machine fills (dependency `blocked`),
 *                        closed to people in both directions;
 *   4. `runtime`         columns a run owns. While the run is active they are
 *                        closed in both directions; at rest they are either
 *                        ordinary columns (`"free"`) or may only be left
 *                        through `exits`;
 *   5. `runtimeEntered`  columns only the runtime may ENTER, whatever is
 *                        running (leaving them falls through to the table);
 *   6. `humanMoves`      `"any"`, or the explicit table of person-owned
 *                        transitions. Anything else is `illegal`.
 *
 * Denial reasons are each surface's own wire values (they reach toasts, RPC
 * replies and the plugin contract), so the engine only carries them.
 */

export type MoveVerdict<R extends string> = { allowed: true } | { allowed: false; reason: R }

export interface MoveRules<S extends string, R extends string, C> {
  /** Every status, in board order. `allowedTargets` lists targets in this order. */
  statuses: readonly S[]
  /** A reason when the row may not be moved at all, else null. */
  readOnly?: (context: C) => R | null
  /** Machine-filled columns, closed to people both ways. */
  derived?: { statuses: readonly S[]; reason: R }
  /** Columns a run owns. */
  runtime?: {
    statuses: readonly S[]
    reason: R
    active: (context: C) => boolean
    /** At rest: ordinary columns, or columns that may only be left through `exits`. */
    atRest: "free" | { exits: readonly S[]; reason: R }
  }
  /** Columns only the runtime may enter, regardless of what is running. */
  runtimeEntered?: { statuses: readonly S[]; reason: R }
  /** Person-owned transitions: everything, or an explicit table. */
  humanMoves: "any" | Readonly<Record<S, readonly S[]>>
  /** The reason for a transition no rule allows. */
  illegal: R
}

/** Identity helper: type-checks a rule set and keeps its literal types. */
export function defineMoveRules<S extends string, R extends string, C = void>(
  rules: MoveRules<S, R, C>
): MoveRules<S, R, C> {
  return rules
}

const ALLOWED = { allowed: true } as const

function deny<R extends string>(reason: R): MoveVerdict<R> {
  return { allowed: false, reason }
}

/** Decide whether a row may move `from` → `to` under `rules`. */
export function canMove<S extends string, R extends string, C>(
  rules: MoveRules<S, R, C>,
  from: S,
  to: S,
  context: C
): MoveVerdict<R> {
  const readOnly = rules.readOnly?.(context) ?? null
  if (readOnly !== null) return deny(readOnly)

  if (from === to) return ALLOWED

  const derived = rules.derived
  if (derived && (derived.statuses.includes(from) || derived.statuses.includes(to))) {
    return deny(derived.reason)
  }

  const runtime = rules.runtime
  if (runtime) {
    const leaving = runtime.statuses.includes(from)
    const entering = runtime.statuses.includes(to)
    if (leaving || entering) {
      if (runtime.active(context)) return deny(runtime.reason)
      if (runtime.atRest !== "free") {
        if (leaving && runtime.atRest.exits.includes(to)) return ALLOWED
        return deny(runtime.atRest.reason)
      }
    }
  }

  const entered = rules.runtimeEntered
  if (entered && entered.statuses.includes(to)) return deny(entered.reason)

  if (rules.humanMoves === "any") return ALLOWED
  return rules.humanMoves[from].includes(to) ? ALLOWED : deny(rules.illegal)
}

/**
 * Every status a row in `from` may move to now, excluding `from` itself (a
 * reorder target that is always open to a movable row), in board order.
 */
export function allowedTargets<S extends string, R extends string, C>(
  rules: MoveRules<S, R, C>,
  from: S,
  context: C
): S[] {
  return rules.statuses.filter((to) => to !== from && canMove(rules, from, to, context).allowed)
}
