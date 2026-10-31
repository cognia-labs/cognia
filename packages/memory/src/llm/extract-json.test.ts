import { extractJson } from "./extract-json"
import { extractJson as extractEvalJson } from "@cognia/eval-core/json"
import { extractJson as extractSharedJson } from "@cognia/primitives/extract-json"

describe.each([
  ["memory", extractJson],
  ["eval-core", extractEvalJson],
  ["primitives", extractSharedJson],
] as const)("%s extractJson shared behavior", (_name, parse) => {
  it.each<[string, unknown]>([
    [
      'prefix {"items":[{"text":"braces } [ and \\\"quotes\\\""}],"ok":true} suffix',
      { items: [{ text: 'braces } [ and "quotes"' }], ok: true },
    ],
    ['prefix [1,{"nested":[null,false]}] suffix', [1, { nested: [null, false] }]],
    ['{"first":1} and {"second":2}', { first: 1 }],
    ['{"outside":true}\n```JSON\n{"fenced":true}\n```', { fenced: true }],
    ["```json\nnull\n```", null],
  ])("preserves nested values and first-candidate/fence precedence for %s", (text, expected) => {
    expect(parse(text)).toEqual(expected)
  })

  it("does not silently skip malformed JSON or recover from an invalid fence", () => {
    expect(() => parse('{"bad":} then {"good":true}')).toThrow(SyntaxError)
    expect(() => parse('```json\n{"bad":}\n``` then {"good":true}')).toThrow(SyntaxError)
    expect(() => parse("true")).toThrow("extractJson: no JSON object or array found in response")
  })
})

describe("memory extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it("parses a bare JSON array", () => {
    expect(extractJson<number[]>("[1,2,3]")).toEqual([1, 2, 3])
  })

  it("strips leading prose and trailing commentary", () => {
    expect(extractJson<{ ok: boolean }>('Sure! {"ok":true} — hope that helps.')).toEqual({
      ok: true,
    })
  })

  it("prefers a fenced ```json block", () => {
    const text = 'Here you go:\n```json\n{"n": 42}\n```\nDone.'
    expect(extractJson<{ n: number }>(text)).toEqual({ n: 42 })
  })

  it("handles a fenced block without the json language tag", () => {
    expect(extractJson<{ x: string }>('```\n{"x":"y"}\n```')).toEqual({ x: "y" })
  })

  it("respects braces inside string literals", () => {
    expect(extractJson<{ s: string }>('{"s":"a } b { c"}')).toEqual({ s: "a } b { c" })
  })

  it("respects escaped quotes inside strings", () => {
    expect(extractJson<{ s: string }>('{"s":"he said \\"hi\\""}')).toEqual({ s: 'he said "hi"' })
  })

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON object or array/)
  })

  it("throws on an unterminated span", () => {
    expect(() => extractJson('{"a":1')).toThrow(/unterminated JSON span/)
  })
})
