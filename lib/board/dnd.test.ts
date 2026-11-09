import {
  columnDropId,
  parseBoardDndId,
  resolveBoardDrop,
  resolveBoardDropPreview,
  type BoardDropRules,
} from "./dnd"
import type { MoveVerdict } from "./move-guard"

type S = "todo" | "doing" | "done"
type R = "frozen" | "illegal"

interface Card {
  id: string
  status: S
  lane: string
  order: number
  frozen?: boolean
}

const cards: Card[] = [
  { id: "a", status: "todo", lane: "x", order: 0 },
  { id: "b", status: "todo", lane: "x", order: 1 },
  { id: "c", status: "todo", lane: "x", order: 2 },
  { id: "d", status: "doing", lane: "x", order: 0 },
  { id: "e", status: "done", lane: "x", order: 0 },
  { id: "f", status: "todo", lane: "y", order: 0 },
  { id: "g", status: "doing", lane: "x", order: 1, frozen: true },
]

function rules(overrides: Partial<BoardDropRules<S, Card, R>> = {}): BoardDropRules<S, Card, R> {
  return {
    itemsById: new Map(cards.map((card) => [card.id, card])),
    idOf: (card) => card.id,
    statusOf: (card) => card.status,
    columnOf: (card, status) =>
      cards
        .filter((other) => other.lane === card.lane && other.status === status)
        .sort((p, q) => p.order - q.order),
    canReorder: (card): MoveVerdict<R> =>
      card.frozen ? { allowed: false, reason: "frozen" } : { allowed: true },
    canMove: (card, _from, to): MoveVerdict<R> =>
      card.frozen
        ? { allowed: false, reason: "frozen" }
        : to === "done"
          ? { allowed: false, reason: "illegal" }
          : { allowed: true },
    ...overrides,
  }
}

describe("board dnd ids", () => {
  it("round-trips a column id and passes card ids through", () => {
    expect(columnDropId("doing")).toBe("col:doing")
    expect(parseBoardDndId<S>("col:doing")).toEqual({ kind: "column", status: "doing" })
    expect(parseBoardDndId<S>("task-1")).toEqual({ kind: "card", itemId: "task-1" })
  })
})

describe("resolveBoardDrop", () => {
  it("is a no-op for missing ids, a self drop, a column as the active id, or an unknown card", () => {
    expect(resolveBoardDrop(null, "col:doing", rules())).toBeNull()
    expect(resolveBoardDrop("a", null, rules())).toBeNull()
    expect(resolveBoardDrop("a", "a", rules())).toBeNull()
    expect(resolveBoardDrop("col:todo", "col:doing", rules())).toBeNull()
    expect(resolveBoardDrop("zz", "col:doing", rules())).toBeNull()
    expect(resolveBoardDrop("a", "zz", rules())).toBeNull()
  })

  it("does nothing when a card goes back onto its own column", () => {
    expect(resolveBoardDrop("a", "col:todo", rules())).toBeNull()
  })

  it("reorders to the index of the card dropped on within the column", () => {
    expect(resolveBoardDrop("a", "c", rules())).toEqual({
      type: "reorder",
      itemId: "a",
      targetIndex: 2,
    })
  })

  it("ignores a same-status card outside the column the consumer scoped", () => {
    expect(resolveBoardDrop("a", "f", rules())).toBeNull()
  })

  it("denies a reorder the rules refuse", () => {
    expect(resolveBoardDrop("g", "d", rules())).toEqual({
      type: "denied",
      itemId: "g",
      reason: "frozen",
    })
  })

  it("moves onto another column, through its column or one of its cards", () => {
    expect(resolveBoardDrop("a", "col:doing", rules())).toEqual({
      type: "move",
      itemId: "a",
      to: "doing",
      targetIndex: 2,
    })
    expect(resolveBoardDrop("a", "d", rules())).toEqual({
      type: "move",
      itemId: "a",
      to: "doing",
      targetIndex: 0,
    })
  })

  it("denies a move the guard refuses, with the guard's reason", () => {
    expect(resolveBoardDrop("a", "col:done", rules())).toEqual({
      type: "denied",
      itemId: "a",
      reason: "illegal",
    })
  })

  it("reorders freely when no reorder rule is given", () => {
    expect(resolveBoardDrop("g", "d", rules({ canReorder: undefined }))).toEqual({
      type: "reorder",
      itemId: "g",
      targetIndex: 0,
    })
  })
})

describe("resolveBoardDropPreview", () => {
  it("is null without a resolvable target", () => {
    expect(resolveBoardDropPreview(null, "col:doing", rules())).toBeNull()
    expect(resolveBoardDropPreview("col:todo", "col:doing", rules())).toBeNull()
    expect(resolveBoardDropPreview("a", "zz", rules())).toBeNull()
  })

  it("appends when over a column and inserts before the card when over a card", () => {
    expect(resolveBoardDropPreview("a", "col:doing", rules())).toEqual({
      status: "doing",
      index: 2,
    })
    expect(resolveBoardDropPreview("a", "d", rules())).toEqual({ status: "doing", index: 0 })
  })

  it("counts the target column without the dragged card", () => {
    expect(resolveBoardDropPreview("a", "c", rules())).toEqual({ status: "todo", index: 1 })
    expect(resolveBoardDropPreview("a", "col:todo", rules())).toEqual({ status: "todo", index: 2 })
  })

  it("appends when the card hovered is outside the scoped column", () => {
    expect(resolveBoardDropPreview("a", "f", rules())).toEqual({ status: "todo", index: 2 })
  })

  it("draws nothing where the guard refuses the card", () => {
    expect(resolveBoardDropPreview("a", "col:done", rules())).toBeNull()
    expect(resolveBoardDropPreview("g", "d", rules())).toBeNull()
  })
})

describe("cross-column placement", () => {
  it.each(["b", "col:todo"])("keeps the preview index in a move onto %s", (overId) => {
    const preview = resolveBoardDropPreview("d", overId, rules())
    expect(resolveBoardDrop("d", overId, rules())).toMatchObject({
      type: "move",
      to: preview?.status,
      targetIndex: preview?.index,
    })
  })
})
