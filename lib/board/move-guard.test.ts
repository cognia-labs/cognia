import { allowedTargets, canMove, defineMoveRules, type MoveRules } from "./move-guard"

type S = "todo" | "wait" | "run" | "check" | "done" | "dropped"
type R = "read-only" | "derived" | "busy" | "machine" | "rest" | "illegal"
interface Ctx {
  locked: boolean
  running: boolean
}

const STATUSES: readonly S[] = ["todo", "wait", "run", "check", "done", "dropped"]
const IDLE: Ctx = { locked: false, running: false }

const ok = { allowed: true }
const no = (reason: R) => ({ allowed: false, reason })

function rules(overrides: Partial<MoveRules<S, R, Ctx>> = {}): MoveRules<S, R, Ctx> {
  return defineMoveRules<S, R, Ctx>({
    statuses: STATUSES,
    humanMoves: "any",
    illegal: "illegal",
    ...overrides,
  })
}

describe("move-guard engine", () => {
  it("returns its argument unchanged from defineMoveRules", () => {
    const set = rules()
    expect(defineMoveRules(set)).toBe(set)
  })

  it("allows every move under a permissive rule set", () => {
    for (const from of STATUSES) {
      expect(allowedTargets(rules(), from, IDLE)).toEqual(STATUSES.filter((s) => s !== from))
    }
  })

  it("refuses a read-only row everything, its own column included", () => {
    const set = rules({ readOnly: (ctx) => (ctx.locked ? "read-only" : null) })
    const locked = { ...IDLE, locked: true }
    expect(canMove(set, "todo", "todo", locked)).toEqual(no("read-only"))
    expect(canMove(set, "todo", "done", locked)).toEqual(no("read-only"))
    expect(allowedTargets(set, "todo", locked)).toEqual([])
    expect(canMove(set, "todo", "done", IDLE)).toEqual(ok)
  })

  it("always allows a same-column reorder of a movable row", () => {
    const set = rules({
      derived: { statuses: ["wait"], reason: "derived" },
      runtime: { statuses: ["run"], reason: "busy", active: (c) => c.running, atRest: "free" },
      humanMoves: { todo: [], wait: [], run: [], check: [], done: [], dropped: [] },
    })
    for (const status of STATUSES) {
      expect(canMove(set, status, status, { locked: false, running: true })).toEqual(ok)
    }
  })

  it("closes derived columns in both directions", () => {
    const set = rules({ derived: { statuses: ["wait"], reason: "derived" } })
    expect(canMove(set, "todo", "wait", IDLE)).toEqual(no("derived"))
    expect(canMove(set, "wait", "todo", IDLE)).toEqual(no("derived"))
  })

  it("checks derived columns before runtime ones", () => {
    const set = rules({
      derived: { statuses: ["wait"], reason: "derived" },
      runtime: { statuses: ["run"], reason: "busy", active: () => true, atRest: "free" },
    })
    expect(canMove(set, "run", "wait", IDLE)).toEqual(no("derived"))
  })

  it("locks runtime columns both ways while active and frees them at rest", () => {
    const set = rules({
      runtime: { statuses: ["run"], reason: "busy", active: (c) => c.running, atRest: "free" },
    })
    const running = { ...IDLE, running: true }
    expect(canMove(set, "todo", "run", running)).toEqual(no("busy"))
    expect(canMove(set, "run", "done", running)).toEqual(no("busy"))
    expect(canMove(set, "todo", "done", running)).toEqual(ok)
    expect(canMove(set, "todo", "run", IDLE)).toEqual(ok)
    expect(canMove(set, "run", "done", IDLE)).toEqual(ok)
  })

  it("lets a runtime column be left only through its exits at rest", () => {
    const set = rules({
      runtime: {
        statuses: ["run", "check"],
        reason: "busy",
        active: (c) => c.running,
        atRest: { exits: ["todo"], reason: "rest" },
      },
    })
    expect(canMove(set, "run", "todo", IDLE)).toEqual(ok)
    expect(canMove(set, "run", "done", IDLE)).toEqual(no("rest"))
    expect(canMove(set, "run", "check", IDLE)).toEqual(no("rest"))
    expect(canMove(set, "todo", "run", IDLE)).toEqual(no("rest"))
    expect(canMove(set, "run", "todo", { ...IDLE, running: true })).toEqual(no("busy"))
  })

  it("keeps runtime-entered columns closed as targets but not as sources", () => {
    const set = rules({ runtimeEntered: { statuses: ["run"], reason: "machine" } })
    expect(canMove(set, "todo", "run", IDLE)).toEqual(no("machine"))
    expect(canMove(set, "run", "done", IDLE)).toEqual(ok)
  })

  it("allows only the table's transitions and calls the rest illegal", () => {
    const set = rules({
      humanMoves: {
        todo: ["dropped"],
        wait: [],
        run: ["check"],
        check: ["done", "todo"],
        done: [],
        dropped: [],
      },
    })
    expect(canMove(set, "todo", "dropped", IDLE)).toEqual(ok)
    expect(canMove(set, "todo", "done", IDLE)).toEqual(no("illegal"))
    expect(canMove(set, "done", "todo", IDLE)).toEqual(no("illegal"))
    // Board order, not table order.
    expect(allowedTargets(set, "check", IDLE)).toEqual(["todo", "done"])
  })
})
