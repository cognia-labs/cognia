import { runErrorText } from "./run-error"

const t = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ""}`

describe("runErrorText", () => {
  it("translates a stored code with its params", () => {
    expect(runErrorText({ errorCode: "strixError", errorParams: { exit: 1 } }, t)).toBe(
      'run.error.strixError{"exit":1}'
    )
  })

  it("translates a code with no params", () => {
    expect(runErrorText({ errorCode: "interrupted" }, t)).toBe("run.error.interrupted")
  })

  it("is empty when the run carries no reason", () => {
    expect(runErrorText({}, t)).toBeUndefined()
  })
})
