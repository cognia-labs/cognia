import {
  answerText,
  bestByScore,
  isAnswer,
  leader,
  quorumMet,
  rankByScore,
  tally,
  totalWeight,
  valueKey,
} from "./aggregate"

describe("tally", () => {
  it("reports every candidate of a closed ballot in order and ignores a vote for anything else", () => {
    const tallies = tally([{ key: 2 }, { key: 0 }, { key: 7 }, { key: 2 }], {
      candidates: [0, 1, 2],
    })
    expect(tallies).toEqual([
      { key: 0, weight: 1, count: 1 },
      { key: 1, weight: 0, count: 0 },
      { key: 2, weight: 2, count: 2 },
    ])
  })

  it("lists an open ballot's answers in the order first seen, one per value", () => {
    const tallies = tally<unknown>([{ key: { b: 1, a: 2 } }, { key: "x" }, { key: { a: 2, b: 1 } }])
    expect(tallies.map((entry) => [entry.key, entry.count])).toEqual([
      [{ b: 1, a: 2 }, 2],
      ["x", 1],
    ])
  })

  it("weighs each ballot, and a weight that is not a finite non-negative number counts for nothing", () => {
    const tallies = tally(
      [
        { key: "a", weight: 3 },
        { key: "b", weight: -5 },
        { key: "b", weight: Number.NaN },
        { key: "b", weight: Number.POSITIVE_INFINITY },
        { key: "b" },
      ],
      { candidates: ["a", "b"] }
    )
    expect(tallies).toEqual([
      { key: "a", weight: 3, count: 1 },
      { key: "b", weight: 1, count: 4 },
    ])
    expect(totalWeight(tallies)).toBe(4)
  })

  it("takes a custom identity for keys", () => {
    const tallies = tally([{ key: "A" }, { key: "a" }], { keyOf: (key) => key.toLowerCase() })
    expect(tallies).toEqual([{ key: "A", weight: 2, count: 2 }])
  })
})

describe("leader", () => {
  it("is the heaviest candidate, the first in order on a tie", () => {
    const tallies = tally(
      ["y", "x", "x", "y", "z"].map((key) => ({ key })),
      {
        candidates: ["x", "y", "z"],
      }
    )
    expect(leader(tallies)?.key).toBe("x")
    expect(leader(tally(["y", "x", "x", "y"].map((key) => ({ key }))))?.key).toBe("y")
  })

  it("is nobody when no ballot carried weight", () => {
    expect(leader(tally<string>([]))).toBeUndefined()
    expect(leader(tally([{ key: "a", weight: 0 }]))).toBeUndefined()
  })
})

describe("quorumMet", () => {
  it("measures the fractional rules against the denominator, strictly above the fraction", () => {
    expect(quorumMet({ kind: "majority" }, 2, 4)).toBe(false)
    expect(quorumMet({ kind: "majority" }, 3, 4)).toBe(true)
    expect(quorumMet({ kind: "supermajority" }, 2, 3)).toBe(false)
    expect(quorumMet({ kind: "supermajority" }, 3, 4)).toBe(true)
    expect(quorumMet({ kind: "unanimous" }, 3, 4)).toBe(false)
    expect(quorumMet({ kind: "unanimous" }, 4, 4)).toBe(true)
  })

  it("never settles a fraction of nobody", () => {
    for (const kind of ["majority", "supermajority", "unanimous"] as const)
      expect(quorumMet({ kind }, 0, 0)).toBe(false)
  })

  it("counts an absolute threshold regardless of the denominator", () => {
    expect(quorumMet({ kind: "at-least", count: 2 }, 2, 0)).toBe(true)
    expect(quorumMet({ kind: "at-least", count: 2 }, 1, 10)).toBe(false)
  })
})

describe("rankByScore", () => {
  it("ranks by mean score, ties in input order, the unscored last", () => {
    const ranked = rankByScore(
      ["a", "b", "c", "d"],
      (_item, i) => [[], [4, 6], [5], ["x", Number.NaN]][i]!
    )
    expect(ranked.map((entry) => [entry.item, entry.mean])).toEqual([
      ["b", 5],
      ["c", 5],
      ["a", null],
      ["d", null],
    ])
    expect(ranked[3]!.scores).toEqual([])
  })

  it("lets a scored zero beat a candidate nobody scored", () => {
    const ranked = rankByScore(["unscored", "zero"], (_item, i) => (i === 0 ? [] : [0]))
    expect(bestByScore(ranked)?.item).toBe("zero")
  })

  it("names no best when nothing was scored", () => {
    expect(bestByScore(rankByScore(["a", "b"], () => []))).toBeUndefined()
    expect(bestByScore(rankByScore([], () => []))).toBeUndefined()
  })
})

describe("answers", () => {
  it("trims text and treats blank text as no answer", () => {
    expect(answerText(" yes\n")).toBe("yes")
    expect(answerText("  ")).toBeUndefined()
    expect(answerText(undefined)).toBeUndefined()
    expect(answerText(null)).toBeUndefined()
  })

  it("counts an object or non-blank text as an answer", () => {
    expect(isAnswer({ object: { ok: false } })).toBe(true)
    expect(isAnswer({ object: null })).toBe(true)
    expect(isAnswer({ text: "no" })).toBe(true)
    expect(isAnswer({ text: " \n" })).toBe(false)
    expect(isAnswer({})).toBe(false)
  })
})

describe("valueKey", () => {
  it("is the same for equal values whatever their key order, and survives a cycle", () => {
    expect(valueKey({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      valueKey({ b: [1, { d: 3, c: 2 }], a: 1 })
    )
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(valueKey(cyclic)).toContain("[circular]")
    expect(valueKey(undefined)).toBe("undefined")
  })
})
