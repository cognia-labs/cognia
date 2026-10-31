import { extractJson } from "./extract-json"

describe("extractJson", () => {
  it.each([
    "",
    "brackets } ] { [",
    'quotes " and backslashes \\',
    "中文\n日本語",
    "literal `code`",
  ])("round-trips nested JSON containing %j through surrounding prose", (text) => {
    const value = { text, nested: [null, { text, values: [1, false] }] }
    expect(extractJson(`Response: ${JSON.stringify(value)} End.`)).toEqual(value)
  })

  it("reports missing and truncated structured responses distinctly", () => {
    expect(() => extractJson("nothing structured")).toThrow(
      "extractJson: no JSON object or array found in response"
    )
    expect(() => extractJson('[{"nested":true}')).toThrow(
      "extractJson: unterminated JSON span in response"
    )
  })
})
