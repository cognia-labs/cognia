import { slugify } from "./agent-id"

describe("slugify", () => {
  it.each([
    ["Code Reviewer", "code-reviewer"],
    ["  Foo--Bar  ", "foo-bar"],
    ["a@b#c", "a-b-c"],
    ["", "subagent"],
    ["!!!", "subagent"],
  ])("(%j) -> %j", (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })
})
