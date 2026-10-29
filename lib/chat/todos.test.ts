import { countCompletedTodos, parseTodoInput, type TodoEntry } from "./todos"

describe("parseTodoInput", () => {
  it("parses a valid todo snapshot", () => {
    expect(
      parseTodoInput({
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress", activeForm: "Doing b" },
          { content: "c", status: "completed" },
        ],
      })
    ).toEqual([
      { content: "a", status: "pending", activeForm: undefined },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
      { content: "c", status: "completed", activeForm: undefined },
    ])
  })

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 7],
    ["missing todos", {}],
    ["non-array todos", { todos: "x" }],
    ["empty todos", { todos: [] }],
    ["only unusable entries", { todos: [1, { status: "pending" }, { content: "  " }] }],
  ])("returns null for %s", (_label, input) => {
    expect(parseTodoInput(input)).toBeNull()
  })

  it("skips malformed entries instead of rejecting the whole snapshot", () => {
    expect(
      parseTodoInput({
        todos: [
          { content: "a", status: "completed" },
          1,
          { content: 2, status: "pending" },
          { status: "pending" },
          { content: "b" },
        ],
      })
    ).toEqual([
      { content: "a", status: "completed", activeForm: undefined },
      { content: "b", status: "pending", activeForm: undefined },
    ])
  })

  it("reads an unknown status as pending", () => {
    expect(parseTodoInput({ todos: [{ content: "a", status: "blocked" }] })).toEqual([
      { content: "a", status: "pending", activeForm: undefined },
    ])
  })

  it("drops a non-string activeForm to undefined", () => {
    const parsed = parseTodoInput({ todos: [{ content: "a", status: "pending", activeForm: 3 }] })
    expect(parsed).toEqual([{ content: "a", status: "pending", activeForm: undefined }])
  })
})

describe("countCompletedTodos", () => {
  it("counts only completed entries", () => {
    const todos: TodoEntry[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d", status: "pending" },
    ]
    expect(countCompletedTodos(todos)).toBe(2)
  })

  it("returns 0 for an empty list", () => {
    expect(countCompletedTodos([])).toBe(0)
  })
})
