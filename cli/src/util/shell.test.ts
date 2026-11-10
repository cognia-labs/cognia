import { execFileSync } from "node:child_process"
import { shellQuote } from "./shell"

describe("shellQuote", () => {
  it.each([
    "",
    "plain",
    "a b",
    "'single'",
    '$HOME `echo injected` $(echo injected) "double"',
    "line\nbreak",
  ])("round-trips a literal POSIX shell argument: %j", (value) => {
    expect(
      execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], {
        encoding: "utf8",
      })
    ).toBe(value)
  })
})
