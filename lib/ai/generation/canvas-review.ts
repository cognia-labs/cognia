/**
 * Canvas/Artifact review engine: diff, hunk, apply.
 *
 * Extracted from `canvas-actions.ts` so consumers that only need the review
 * math (e.g. the artifact store, which is persisted and widely imported) don't
 * pull in the `ai` SDK + provider-core that `canvas-actions` loads at module
 * top. `canvas-actions` re-exports these for backward compatibility.
 *
 * The diff itself is `lib/artifacts/diff.ts:computeDiff`, an LCS diff that the
 * review UI was ALREADY using to render. This module used to carry a second,
 * hand-written diff with a five-line lookahead, so the hunks the user accepted
 * were computed by one algorithm and the diff they read was drawn by another.
 * On a block move the two disagree about which lines changed, and the accepted
 * hunk is applied at line numbers the reader never saw.
 */

import { nanoid } from "nanoid"
import { computeDiff } from "@/lib/artifacts/diff"
import { hashCanvasContent } from "@/lib/canvas/content-hash"
import type {
  CanvasPendingReview,
  CanvasReviewDiffLine,
  CanvasReviewItem,
  CanvasWorkbenchActionType,
} from "@/types/artifact/artifact"

export type DiffLine = CanvasReviewDiffLine

export interface CanvasReviewBuildInput {
  requestId: string
  actionType: CanvasWorkbenchActionType
  originalContent: string
  proposedContent: string
}

/**
 * The line diff a review is built from, in the review's own line-number shape.
 *
 * A thin translation of `computeDiff` rather than a second implementation:
 * `DiffLine` (artifacts) names its fields `oldLineNum`/`newLineNum`, while
 * `CanvasReviewDiffLine` names them `lineNumber`/`newLineNumber`. Keeping the
 * two shapes is cheap; keeping two diff algorithms was not.
 */
export function generateDiffPreview(original: string, modified: string): DiffLine[] {
  return computeDiff(original, modified).map((line) => ({
    type: line.type,
    content: line.content,
    ...(line.oldLineNum !== undefined ? { lineNumber: line.oldLineNum } : {}),
    ...(line.newLineNum !== undefined ? { newLineNumber: line.newLineNum } : {}),
  }))
}

/**
 * Group a line diff into per-hunk review items (contiguous added/removed runs),
 * each independently accept/reject-able.
 *
 * Every hunk is anchored on the ORIGINAL side, because that is the text
 * `applyAcceptedCanvasReviewItems` edits: `range.startLine` is the first
 * original line the hunk replaces, or for a pure insertion the original line it
 * is inserted before (`endLine = startLine - 1`, an empty range). Taking a pure
 * insertion's anchor from its *proposed* line number put it as many lines off
 * as every earlier hunk had grown or shrunk the document.
 */
export function buildCanvasReview(input: CanvasReviewBuildInput): CanvasPendingReview {
  const diffLines = generateDiffPreview(input.originalContent, input.proposedContent)
  const items: CanvasReviewItem[] = []
  let block: DiffLine[] = []
  /** Original lines consumed so far, i.e. the 0-based index of the next one. */
  let originalCursor = 0
  let blockStart = 0

  const flushBlock = () => {
    if (block.length === 0) {
      return
    }

    const removedLines = block.filter((line) => line.type === "removed")
    const addedLines = block.filter((line) => line.type === "added")
    const startLine = blockStart + 1
    const endLine = startLine + removedLines.length - 1

    let changeType: CanvasReviewItem["changeType"] = "replace"
    if (removedLines.length === 0 && addedLines.length > 0) {
      changeType = "insert"
    } else if (removedLines.length > 0 && addedLines.length === 0) {
      changeType = "delete"
    }

    items.push({
      id: nanoid(),
      actionType: input.actionType,
      changeType,
      originalText: removedLines.map((line) => line.content).join("\n"),
      proposedText: addedLines.map((line) => line.content).join("\n"),
      status: "pending",
      range: {
        startLine,
        endLine,
      },
      diffLines: block.map((line) => ({ ...line })),
    })

    block = []
  }

  for (const line of diffLines) {
    if (line.type === "unchanged") {
      flushBlock()
      originalCursor += 1
      continue
    }

    if (block.length === 0) blockStart = originalCursor
    if (line.type === "removed") originalCursor += 1
    block.push(line)
  }
  flushBlock()

  return {
    id: nanoid(),
    requestId: input.requestId,
    actionType: input.actionType,
    originalContent: input.originalContent,
    proposedContent: input.proposedContent,
    baseContentHash: hashCanvasContent(input.originalContent),
    createdAt: new Date(),
    status: "pending",
    items,
  }
}

/**
 * Whether a proposal still describes the document in front of the user.
 *
 * Derived, not remembered. `isStale` was a flag `updateCanvasDocument` had to
 * remember to set, so a proposal that survived a reload, or a buffer changed by
 * a path that did not go through that action, could be applied against content
 * it was never diffed from. Applying accepted hunks by line number onto moved
 * content corrupts the document silently.
 *
 * A proposal written before the hash existed falls back to comparing the
 * baseline text, which is what the flag was approximating.
 */
export function isCanvasReviewStale(
  review: Pick<CanvasPendingReview, "originalContent" | "baseContentHash" | "isStale">,
  currentContent: string
): boolean {
  if (review.isStale === true) return true
  if (review.baseContentHash) return review.baseContentHash !== hashCanvasContent(currentContent)
  return review.originalContent !== currentContent
}

/**
 * Split text into lines exactly as `computeDiff` does, so the indices a hunk
 * was built from address the same lines here. `"".split("\n")` is one empty
 * line, while the diff reads an empty document as none: filling an empty
 * document used to leave a stray trailing newline.
 */
function toLines(text: string): string[] {
  return text === "" ? [] : text.split("\n")
}

/**
 * Reconstruct content by applying only the accepted hunks, at their original
 * side anchors, back-to-front so earlier indices stay valid as later ones
 * mutate.
 *
 * A hunk's lines come from its own `diffLines`, not from `proposedText`: the
 * joined text cannot tell "insert one empty line" (`""`) from "insert nothing"
 * (also `""`), so an accepted blank-line insertion silently vanished.
 */
export function applyAcceptedCanvasReviewItems(
  originalContent: string,
  items: CanvasReviewItem[]
): string {
  const lines = toLines(originalContent)
  const acceptedItems = items
    .filter((item) => item.status === "accepted")
    .sort((a, b) => b.range.startLine - a.range.startLine)

  for (const item of acceptedItems) {
    const startIndex = Math.max(0, item.range.startLine - 1)
    const deleteCount = item.diffLines.filter((line) => line.type === "removed").length
    const replacementLines = item.diffLines
      .filter((line) => line.type === "added")
      .map((line) => line.content)
    lines.splice(startIndex, deleteCount, ...replacementLines)
  }

  return lines.join("\n")
}

/** The outcome of carrying a proposal over onto content that changed since. */
export interface RebasedCanvasProposal {
  /** `current` with every proposal hunk that still applies cleanly. */
  content: string
  /** Proposal hunks carried over. */
  applied: number
  /** Proposal hunks dropped because the user changed the same lines. */
  conflicts: number
}

/**
 * Carry a proposal written against `base` over onto `current`: a three-way
 * merge where only the proposal's OWN hunks move, so the user's intervening
 * edits are kept.
 *
 * Re-diffing used to compare `current` with the proposal's full text, which
 * presented every manual edit made since as a change the proposal wanted to
 * undo. Here a proposal hunk is re-anchored through the base → current diff
 * when the original lines it touches are still there, unchanged and adjacent;
 * a hunk whose lines the user also edited — or an insertion at the very spot
 * the user inserted — is a conflict and is left out rather than guessed at.
 */
export function rebaseCanvasProposal(
  base: string,
  current: string,
  proposed: string
): RebasedCanvasProposal {
  const baseLength = toLines(base).length
  const currentLines = toLines(current)
  /** For each base line, its index in `current`, or -1 once the user changed it. */
  const mapped = new Array<number>(baseLength).fill(-1)
  /** For each gap before base line g (g = baseLength is the end), whether the user inserted there. */
  const insertedAt = new Array<boolean>(baseLength + 1).fill(false)
  let baseIndex = 0
  let currentIndex = 0
  for (const line of generateDiffPreview(base, current)) {
    if (line.type === "unchanged") {
      mapped[baseIndex] = currentIndex
      baseIndex += 1
      currentIndex += 1
    } else if (line.type === "removed") {
      baseIndex += 1
    } else {
      insertedAt[baseIndex] = true
      currentIndex += 1
    }
  }

  const hunks = buildCanvasReview({
    requestId: "rebase",
    actionType: "custom",
    originalContent: base,
    proposedContent: proposed,
  }).items
  const placed: { at: number; deleteCount: number; lines: string[] }[] = []
  let conflicts = 0

  for (const hunk of hunks) {
    const start = hunk.range.startLine - 1
    const deleteCount = hunk.diffLines.filter((line) => line.type === "removed").length
    const lines = hunk.diffLines.filter((line) => line.type === "added").map((line) => line.content)
    let at = -1
    if (deleteCount > 0) {
      // Every original line it replaces must survive untouched, in one run.
      let clean = true
      for (let k = start; k < start + deleteCount; k++) {
        if (mapped[k] === -1 || (k > start && (insertedAt[k] || mapped[k] !== mapped[k - 1] + 1))) {
          clean = false
          break
        }
      }
      if (clean) at = mapped[start]
    } else if (!insertedAt[start]) {
      // An insertion needs a surviving neighbour to stand next to.
      if (start < baseLength && mapped[start] !== -1) at = mapped[start]
      else if (start > 0 && mapped[start - 1] !== -1) at = mapped[start - 1] + 1
      else if (baseLength === 0) at = 0
    }
    if (at === -1) {
      conflicts += 1
      continue
    }
    placed.push({ at, deleteCount, lines })
  }

  const merged = [...currentLines]
  for (const hunk of placed.sort((a, b) => b.at - a.at)) {
    merged.splice(hunk.at, hunk.deleteCount, ...hunk.lines)
  }
  return { content: merged.join("\n"), applied: placed.length, conflicts }
}
