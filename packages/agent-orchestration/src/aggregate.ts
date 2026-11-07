/**
 * Aggregating several agents' answers into one (ADR-0252 §8).
 *
 * Four surfaces aggregate: the Squad consensus vote, the workflow ensemble,
 * the judge panel and the council. They agree on these rules, which live
 * here once:
 *
 *   - An answer is an object, or text that is not blank. Text is compared
 *     without its surrounding whitespace, so `"yes"` and `"yes\n"` are one
 *     answer. A blank reply is a failed reply, not a vote for the empty
 *     string.
 *   - A tie goes to the first candidate in order: the first declared option
 *     of a closed ballot, the first answer seen on an open one, the first
 *     attempt among equal scores. Re-running the same inputs picks the same
 *     winner.
 *   - A weight that is not a finite, non-negative number counts for nothing.
 *     A negative weight would let one voter take votes away from an option.
 *   - A candidate nobody scored has no score. It ranks after every scored
 *     candidate, never as a zero, and cannot win; with no score at all there
 *     is no winner.
 *
 * Kept differences, decided per surface and not here:
 *
 *   - The Squad vote decides a quorum (`quorumMet`) against its voter pool.
 *     The ensemble's `majority-vote-on-field` reports the most common answer
 *     with its count and total and decides nothing; its `threshold-count`
 *     policy is the one that decides, against an absolute count.
 *   - The judge panel ranks by the mean of several judges' scores; the
 *     ensemble's `best-of-by-score` has one score per sample. Both rank with
 *     `rankByScore`, where one score is a mean of one.
 *   - The council's agreement ("unanimous", "majority", "split") is the
 *     synthesizer's own rating, parsed from its report: councillors answer in
 *     free text, so there is nothing to tally.
 */

/** One vote for `key`, worth `weight` (default 1). */
export interface Ballot<K> {
  key: K
  weight?: number
}

/** The votes one candidate received. */
export interface Tally<K> {
  key: K
  /** The summed weight of its ballots. */
  weight: number
  /** How many ballots it received, whatever their weight. */
  count: number
}

export interface TallyOptions<K> {
  /**
   * A closed ballot's candidates, in order. Every one is reported (with zero
   * votes when nobody chose it) and a ballot for anything else is ignored.
   * Without it the ballot is open: candidates appear in the order first seen.
   */
  candidates?: readonly K[]
  /** Identity of a key, for keys that are not primitives. Default `valueKey`. */
  keyOf?: (key: K) => string
}

/**
 * A stable identity for any value: object keys in sorted order, so two
 * objects with the same fields in a different order are the same answer.
 */
export function valueKey(value: unknown): string {
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(norm)
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k])
    return out
  }
  try {
    return JSON.stringify(norm(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

function ballotWeight(weight: number | undefined): number {
  if (weight === undefined) return 1
  return Number.isFinite(weight) && weight >= 0 ? weight : 0
}

/** Count the ballots per candidate, in ballot order (see `TallyOptions`). */
export function tally<K>(ballots: Iterable<Ballot<K>>, options: TallyOptions<K> = {}): Tally<K>[] {
  const keyOf = options.keyOf ?? valueKey
  const tallies = new Map<string, Tally<K>>()
  for (const key of options.candidates ?? []) {
    const id = keyOf(key)
    if (!tallies.has(id)) tallies.set(id, { key, weight: 0, count: 0 })
  }
  const closed = options.candidates !== undefined
  for (const ballot of ballots) {
    const id = keyOf(ballot.key)
    let entry = tallies.get(id)
    if (!entry) {
      if (closed) continue
      entry = { key: ballot.key, weight: 0, count: 0 }
      tallies.set(id, entry)
    }
    entry.weight += ballotWeight(ballot.weight)
    entry.count += 1
  }
  return [...tallies.values()]
}

/** The summed weight of every counted ballot. */
export function totalWeight(tallies: ReadonlyArray<Tally<unknown>>): number {
  return tallies.reduce((sum, entry) => sum + entry.weight, 0)
}

/**
 * The candidate with the most weight, the first in order on a tie, or
 * `undefined` when no ballot carried any weight.
 */
export function leader<K>(tallies: ReadonlyArray<Tally<K>>): Tally<K> | undefined {
  let best: Tally<K> | undefined
  for (const entry of tallies) if (!best || entry.weight > best.weight) best = entry
  return best && best.weight > 0 ? best : undefined
}

/**
 * How much agreement settles a decision.
 *
 * `majority`, `supermajority` and `unanimous` are fractions of `denominator`
 * (the voter pool, or the total weight cast, as the surface decides);
 * `at-least` is an absolute count and ignores the denominator.
 */
export type QuorumRule =
  | { kind: "majority" }
  | { kind: "supermajority" }
  | { kind: "unanimous" }
  | { kind: "at-least"; count: number }

/** Whether `support` settles the decision under `rule`. */
export function quorumMet(rule: QuorumRule, support: number, denominator: number): boolean {
  switch (rule.kind) {
    case "majority":
      return denominator > 0 && support > denominator / 2
    case "supermajority":
      return denominator > 0 && support > (denominator * 2) / 3
    case "unanimous":
      return denominator > 0 && support === denominator
    case "at-least":
      return support >= rule.count
  }
}

/** One candidate's place in a ranking by score. */
export interface RankedByScore<T> {
  item: T
  /** Its position in the input, the tie-break. */
  index: number
  /** The scores it received that are finite numbers. */
  scores: number[]
  /** Their mean, or `null` when it received none. */
  mean: number | null
}

/**
 * Rank candidates by the mean of their scores, highest first. Ties keep input
 * order. Candidates without a usable score come last, in input order.
 */
export function rankByScore<T>(
  items: readonly T[],
  scoresOf: (item: T, index: number) => readonly unknown[]
): RankedByScore<T>[] {
  const ranked = items.map((item, index) => {
    const scores = scoresOf(item, index).filter(
      (score): score is number => typeof score === "number" && Number.isFinite(score)
    )
    const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null
    return { item, index, scores, mean }
  })
  return ranked.sort((a, b) => {
    if (a.mean === null || b.mean === null) {
      if (a.mean === b.mean) return a.index - b.index
      return a.mean === null ? 1 : -1
    }
    return b.mean - a.mean || a.index - b.index
  })
}

/** The best-scored candidate, or `undefined` when none was scored. */
export function bestByScore<T>(
  ranked: ReadonlyArray<RankedByScore<T>>
): RankedByScore<T> | undefined {
  const first = ranked[0]
  return first && first.mean !== null ? first : undefined
}

/** Text as an answer: trimmed, or `undefined` when blank or absent. */
export function answerText(text: string | undefined | null): string | undefined {
  const trimmed = text?.trim()
  return trimmed ? trimmed : undefined
}

/** Whether a reply is an answer: an object, or text that is not blank. */
export function isAnswer(reply: { text?: string | null; object?: unknown }): boolean {
  return reply.object !== undefined || answerText(reply.text) !== undefined
}
