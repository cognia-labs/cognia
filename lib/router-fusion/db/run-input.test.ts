import { decodeRunInput, encodeRunInput } from "./run-input"

describe("stored run input", () => {
  it("round-trips the messages and the options that judge the run", () => {
    const input = {
      messages: [
        { role: "system" as const, content: "answer in JSON" },
        { role: "user" as const, content: "rate?" },
      ],
      allowDegraded: true,
      jsonSchema: { type: "object" },
    }
    expect(decodeRunInput(encodeRunInput(input))).toEqual(input)
  })

  it("round-trips the questions a person answered, round by round", () => {
    const input = {
      messages: [
        { role: "user" as const, content: "fix the list" },
        { role: "user" as const, content: "the users list" },
      ],
      allowDegraded: false,
      jsonSchema: null,
      clarifications: [["Which list?"]],
    }
    expect(decodeRunInput(encodeRunInput(input))).toEqual(input)
    expect(
      decodeRunInput(
        JSON.stringify({ ...input, clarifications: [[], ["", 3, "Which list?"], "nope"] })
      )?.clarifications
    ).toEqual([["Which list?"]])
  })

  it("keeps only well-formed messages and refuses input with none", () => {
    expect(
      decodeRunInput(
        JSON.stringify({
          messages: [
            { role: "tool", content: "x" },
            { role: "user" },
            { role: "user", content: "kept" },
          ],
          allowDegraded: "yes",
          jsonSchema: ["not", "a", "schema"],
        })
      )
    ).toEqual({
      messages: [{ role: "user", content: "kept" }],
      allowDegraded: false,
      jsonSchema: null,
    })
    for (const content of [
      null,
      undefined,
      "",
      "not json",
      "42",
      "[]",
      // A bare message array is not a stored input.
      JSON.stringify([{ role: "user", content: "hi" }]),
      JSON.stringify({ messages: [] }),
    ]) {
      expect(decodeRunInput(content)).toBeNull()
    }
  })
})
