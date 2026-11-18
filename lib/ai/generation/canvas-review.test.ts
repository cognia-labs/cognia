import { computeDiff } from "@/lib/artifacts/diff"
import {
  rebaseCanvasProposal,
  generateDiffPreview,
  isCanvasReviewStale,
  buildCanvasReview,
  applyAcceptedCanvasReviewItems,
} from "./canvas-review"

describe("generateDiffPreview", () => {
  it("returns unchanged for identical content", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb\nc")
    expect(diff.every((d) => d.type === "unchanged")).toBe(true)
  })

  it("identifies pure additions", () => {
    const diff = generateDiffPreview("a\nb", "a\nb\nc")
    expect(diff.find((d) => d.type === "added")?.content).toBe("c")
  })

  it("identifies pure removals", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb")
    expect(diff.find((d) => d.type === "removed")?.content).toBe("c")
  })

  it("recognises mid-stream additions", () => {
    // a, b, c (orig) vs a, X, b, c (modified): X is an add, b/c stay unchanged
    const diff = generateDiffPreview("a\nb\nc", "a\nX\nb\nc")
    const added = diff.filter((d) => d.type === "added")
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe("X")
  })

  it("recognises mid-stream removals", () => {
    const diff = generateDiffPreview("a\nX\nb\nc", "a\nb\nc")
    const removed = diff.filter((d) => d.type === "removed")
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe("X")
  })

  it("handles a replacement as remove plus add", () => {
    const diff = generateDiffPreview("a\nold\nb", "a\nnew\nb")
    expect(diff.some((d) => d.type === "removed" && d.content === "old")).toBe(true)
    expect(diff.some((d) => d.type === "added" && d.content === "new")).toBe(true)
  })
})

describe("buildCanvasReview / applyAcceptedCanvasReviewItems", () => {
  it("groups added/removed lines into review items with proper change types", () => {
    const review = buildCanvasReview({
      requestId: "req-1",
      actionType: "improve",
      originalContent: "line1\nline2\nline3",
      proposedContent: "line1\nline2 modified\nline3\nextra",
    })
    expect(review.items.length).toBeGreaterThan(0)
    expect(["replace", "insert", "delete"]).toContain(review.items[0].changeType)
    expect(review.id).toMatch(/.+/)
    expect(review.requestId).toBe("req-1")
  })

  it("handles a pure-insert change type", () => {
    const review = buildCanvasReview({
      requestId: "req-2",
      actionType: "expand",
      originalContent: "a",
      proposedContent: "a\nb\nc",
    })
    const insert = review.items.find((i) => i.changeType === "insert")
    expect(insert).toBeDefined()
  })

  it("handles a pure-delete change type", () => {
    const review = buildCanvasReview({
      requestId: "req-3",
      actionType: "simplify",
      originalContent: "a\nb\nc",
      proposedContent: "a",
    })
    expect(review.items.some((i) => i.changeType === "delete")).toBe(true)
  })

  it("applyAcceptedCanvasReviewItems applies only accepted items in reverse order", () => {
    const review = buildCanvasReview({
      requestId: "r",
      actionType: "improve",
      originalContent: "alpha\nbeta\ngamma",
      proposedContent: "ALPHA\nbeta\ngamma",
    })
    review.items.forEach((item) => (item.status = "accepted"))
    const applied = applyAcceptedCanvasReviewItems("alpha\nbeta\ngamma", review.items)
    expect(applied).toContain("ALPHA")
  })

  it("applyAcceptedCanvasReviewItems leaves content untouched when no items are accepted", () => {
    const out = applyAcceptedCanvasReviewItems("orig", [])
    expect(out).toBe("orig")
  })

  it("applyAcceptedCanvasReviewItems handles inserts (deleteCount=0)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb", [
      {
        id: "x",
        actionType: "expand",
        changeType: "insert",
        originalText: "",
        proposedText: "INS",
        status: "accepted",
        range: { startLine: 2, endLine: 1 },
        diffLines: [{ type: "added", content: "INS", newLineNumber: 2 }],
      },
    ])
    expect(out.split("\n")).toEqual(["a", "INS", "b"])
  })

  it("applyAcceptedCanvasReviewItems supports empty proposed text (pure deletion)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb\nc", [
      {
        id: "x",
        actionType: "simplify",
        changeType: "delete",
        originalText: "b",
        proposedText: "",
        status: "accepted",
        range: { startLine: 2, endLine: 2 },
        diffLines: [{ type: "removed", content: "b", lineNumber: 2 }],
      },
    ])
    expect(out.split("\n")).toEqual(["a", "c"])
  })
})

/**
 * The independent oracle: walk the diff the reader saw, taking each accepted
 * hunk's new side and every other hunk's old side. Whatever the apply step
 * computes from anchors must agree with this, for every subset of hunks.
 */
function expectedFromDiff(original: string, proposed: string, accepted: Set<number>): string {
  const out: string[] = []
  let hunk = -1
  let inHunk = false
  for (const line of generateDiffPreview(original, proposed)) {
    if (line.type === "unchanged") {
      inHunk = false
      out.push(line.content)
      continue
    }
    if (!inHunk) {
      hunk += 1
      inHunk = true
    }
    const keepNew = accepted.has(hunk)
    if (line.type === "added" && keepNew) out.push(line.content)
    if (line.type === "removed" && !keepNew) out.push(line.content)
  }
  return out.join("\n")
}

function applySubset(original: string, proposed: string, accepted: Set<number>): string {
  const review = buildCanvasReview({
    requestId: "r",
    actionType: "custom",
    originalContent: original,
    proposedContent: proposed,
  })
  return applyAcceptedCanvasReviewItems(
    original,
    review.items.map((item, index) => ({
      ...item,
      status: accepted.has(index) ? ("accepted" as const) : ("rejected" as const),
    }))
  )
}

describe("hunks are applied where the reader saw them (C01)", () => {
  it("anchors a pure insertion on the original side after a hunk that grew the text", () => {
    const original = "a\nb\nc\nd"
    const proposed = "A1\nA2\nb\nx\nc\nd"
    const review = buildCanvasReview({
      requestId: "r",
      actionType: "custom",
      originalContent: original,
      proposedContent: proposed,
    })
    expect(review.items.map((item) => [item.changeType, item.range])).toEqual([
      ["replace", { startLine: 1, endLine: 1 }],
      // Before original line 3 ("c"), not before new line 4.
      ["insert", { startLine: 3, endLine: 2 }],
    ])
    expect(applySubset(original, proposed, new Set([0, 1]))).toBe(proposed)
    // Only the later insertion: it must still land between b and c.
    expect(applySubset(original, proposed, new Set([1]))).toBe("a\nb\nx\nc\nd")
  })

  it("anchors an insertion after a hunk that shrank the text", () => {
    const original = "a\nb\nc\nd\ne"
    const proposed = "e0\nd\nINS\ne"
    expect(applySubset(original, proposed, new Set([0, 1]))).toBe(proposed)
  })

  it("keeps an accepted insertion of a single empty line", () => {
    expect(applySubset("a\nb", "a\n\nb", new Set([0]))).toBe("a\n\nb")
  })

  it("keeps accepted blank lines inside a multi-line insertion", () => {
    expect(applySubset("a\nb", "a\n\n\nmid\n\nb", new Set([0]))).toBe("a\n\n\nmid\n\nb")
  })

  it("fills an empty document without a stray newline", () => {
    expect(applySubset("", "filled", new Set([0]))).toBe("filled")
    expect(applySubset("", "one\ntwo", new Set([0]))).toBe("one\ntwo")
  })

  it("empties a document completely", () => {
    expect(applySubset("a\nb", "", new Set([0]))).toBe("")
  })

  it("appends after the last line and keeps a trailing newline", () => {
    expect(applySubset("a\nb\n", "a\nb\nc\n", new Set([0]))).toBe("a\nb\nc\n")
    expect(applySubset("a\nb", "a\nb\nc", new Set([0]))).toBe("a\nb\nc")
  })

  it("agrees with the rendered diff for every subset of hunks on generated edits", () => {
    // A small deterministic generator: random line-level edits over a short
    // alphabet, so moves, duplicates and blank lines all occur.
    let seed = 20261118
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const alphabet = ["", "a", "b", "c", "d", "x", "  indented", "}"]
    const randomDoc = () =>
      Array.from({ length: Math.floor(next() * 7) }, () => alphabet[Math.floor(next() * 8)]).join(
        "\n"
      )
    for (let run = 0; run < 300; run++) {
      const original = randomDoc()
      const proposed = randomDoc()
      const review = buildCanvasReview({
        requestId: "r",
        actionType: "custom",
        originalContent: original,
        proposedContent: proposed,
      })
      const hunks = review.items.length
      for (let mask = 0; mask < 1 << hunks; mask++) {
        const accepted = new Set(
          Array.from({ length: hunks }, (_, index) => index).filter((i) => mask & (1 << i))
        )
        expect(applySubset(original, proposed, accepted)).toBe(
          expectedFromDiff(original, proposed, accepted)
        )
      }
      expect(applySubset(original, proposed, new Set(review.items.map((_, i) => i)))).toBe(proposed)
    }
  })
})

describe("one diff, not two", () => {
  // `CanvasReviewView` renders `computeDiff` while the hunks came from a second,
  // hand-written diff with a five-line lookahead. On a block move the two
  // disagreed about which lines changed, so an accepted hunk was applied at
  // line numbers the reader never saw.
  it("builds hunks from the same engine the review UI renders", () => {
    const original = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n")
    const modified = ["e", "f", "g", "h", "a", "b", "c", "d"].join("\n")

    const shown = computeDiff(original, modified)
    const used = generateDiffPreview(original, modified)

    expect(used.map((line) => `${line.type}:${line.content}`)).toEqual(
      shown.map((line) => `${line.type}:${line.content}`)
    )
  })

  it("carries the review's own line-number field names", () => {
    const lines = generateDiffPreview("a\nb", "a\nB")
    const changed = lines.filter((line) => line.type !== "unchanged")
    expect(
      changed.every((line) => line.lineNumber !== undefined || line.newLineNumber !== undefined)
    ).toBe(true)
  })

  it("round-trips: accepting every hunk reproduces the proposal", () => {
    // The property that matters. If the hunk math and the diff ever diverge
    // again, this is what catches it.
    const original = ["one", "two", "three", "four", "five"].join("\n")
    const proposed = ["one", "TWO", "three", "four and a half", "five", "six"].join("\n")

    const review = buildCanvasReview({
      requestId: "r1",
      actionType: "improve",
      originalContent: original,
      proposedContent: proposed,
    })
    const accepted = review.items.map((item) => ({ ...item, status: "accepted" as const }))

    expect(applyAcceptedCanvasReviewItems(original, accepted)).toBe(proposed)
  })
})

describe("isCanvasReviewStale", () => {
  function review(original: string) {
    return buildCanvasReview({
      requestId: "r1",
      actionType: "improve",
      originalContent: original,
      proposedContent: `${original}\nextra`,
    })
  }

  it("stamps the baseline it was diffed from", () => {
    expect(review("a\nb").baseContentHash).toBeTruthy()
  })

  it("is fresh against the content it was built from", () => {
    const built = review("a\nb")
    expect(isCanvasReviewStale(built, "a\nb")).toBe(false)
  })

  it("is stale once the buffer moves, with no flag having been set", () => {
    // This is the case the `isStale` flag missed: a proposal that outlives the
    // write that would have set it, or arrives from a path that does not.
    const built = review("a\nb")
    expect(built.isStale).toBeUndefined()
    expect(isCanvasReviewStale(built, "a\nB")).toBe(true)
  })

  it("honours an explicitly flagged proposal even when the content matches", () => {
    const built = { ...review("a\nb"), isStale: true }
    expect(isCanvasReviewStale(built, "a\nb")).toBe(true)
  })

  it("falls back to the baseline text for a proposal written before the hash", () => {
    const built = { ...review("a\nb"), baseContentHash: undefined }
    expect(isCanvasReviewStale(built, "a\nb")).toBe(false)
    expect(isCanvasReviewStale(built, "changed")).toBe(true)
  })
})

describe("rebaseCanvasProposal (C10)", () => {
  it("keeps a manual edit elsewhere and carries the proposal's own change over", () => {
    expect(
      rebaseCanvasProposal("header\nkeep\nold", "manual\nkeep\nold", "header\nkeep\nnew")
    ).toEqual({ content: "manual\nkeep\nnew", applied: 1, conflicts: 0 })
  })

  it("re-anchors through lines the user inserted above", () => {
    expect(rebaseCanvasProposal("a\nb\nc", "intro\nmore\na\nb\nc", "a\nB\nc").content).toBe(
      "intro\nmore\na\nB\nc"
    )
  })

  it("drops a hunk whose lines the user also changed", () => {
    expect(rebaseCanvasProposal("a\nb\nc", "a\nb-mine\nc", "a\nb-ai\nc")).toEqual({
      content: "a\nb-mine\nc",
      applied: 0,
      conflicts: 1,
    })
  })

  it("drops an insertion at the very spot the user inserted", () => {
    expect(rebaseCanvasProposal("a\nb", "a\nmine\nb", "a\nai\nb")).toMatchObject({
      content: "a\nmine\nb",
      conflicts: 1,
    })
  })

  it("drops a replacement the user split with an insertion", () => {
    expect(rebaseCanvasProposal("a\nb\nc\nd", "a\nb\nmine\nc\nd", "a\nX\nd")).toMatchObject({
      conflicts: 1,
      content: "a\nb\nmine\nc\nd",
    })
  })

  it("applies the clean hunks and counts the conflicting ones", () => {
    expect(
      rebaseCanvasProposal(
        "one\nmid\ntwo\nend",
        "one\nmid\nTWO-mine\nend",
        "ONE\nmid\ntwo-ai\nend\nfive"
      )
    ).toEqual({ content: "ONE\nmid\nTWO-mine\nend\nfive", applied: 2, conflicts: 1 })
  })

  it("is the proposal itself when nothing changed in between", () => {
    const base = "a\nb\nc"
    const proposed = "A\n\nb\nc\nd"
    expect(rebaseCanvasProposal(base, base, proposed).content).toBe(proposed)
  })

  it("fills an empty document when it is still empty", () => {
    expect(rebaseCanvasProposal("", "", "x").content).toBe("x")
  })
})
