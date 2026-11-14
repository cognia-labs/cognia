import { extractContextText, extractPlainText } from "./extract-plain-text"

describe("extractPlainText", () => {
  it("returns empty string when parts is not an array", () => {
    expect(extractPlainText(null)).toBe("")
    expect(extractPlainText(undefined)).toBe("")
    expect(extractPlainText({})).toBe("")
  })

  it("concatenates text parts with a single space and trims whitespace", () => {
    expect(
      extractPlainText([
        { type: "text", text: "hello" },
        { type: "text", text: "world  " },
      ])
    ).toBe("hello world")
  })

  it("walks markdown parts via the `md` field", () => {
    expect(extractPlainText([{ type: "markdown", md: "**bold**" }])).toBe("**bold**")
  })

  it("handles code blocks via `text` and falls back to `code`", () => {
    expect(extractPlainText([{ type: "code", text: "const x = 1", language: "ts" }])).toBe(
      "[ts] const x = 1"
    )
    expect(extractPlainText([{ type: "code", code: "echo hi" }])).toBe("echo hi")
  })

  it("includes an `[image]` marker so search hits image-only conversations", () => {
    expect(extractPlainText([{ type: "image" }])).toBe("[image]")
    expect(extractPlainText([{ type: "image", alt: "logo" }])).toBe("[image: logo]")
  })

  it("uses the A2UI plainTextMirror for surface parts", () => {
    expect(extractPlainText([{ type: "a2ui", plainTextMirror: "Approve | Reject" }])).toBe(
      "Approve | Reject"
    )
  })

  it("falls back to A2UI `text` when the renderer stashed the mirror there", () => {
    expect(extractPlainText([{ type: "a2ui", text: "legacy mirror" }])).toBe("legacy mirror")
  })

  it("skips unknown part types but keeps surrounding text", () => {
    expect(
      extractPlainText([
        { type: "text", text: "before" },
        { type: "future" },
        { type: "text", text: "after" },
      ])
    ).toBe("before after")
  })

  it("collapses repeated whitespace and trims edges", () => {
    expect(
      extractPlainText([
        { type: "text", text: "  spaced   out  " },
        { type: "text", text: "\nlines\n" },
      ])
    ).toBe("spaced out lines")
  })
})

it("preserves context formatting without changing the Inbox projection or exposing reasoning", () => {
  const parts = [
    { type: "text", text: "  root:\r\n    child: true\r\n" },
    { type: "reasoning", text: "private reasoning" },
    { type: "markdown", md: "| a | b |\n| - | - |\n| 1 | 2 |" },
    { type: "code", language: "ts", code: "if (ok) {\n  run()\n}\n  " },
  ]
  expect(extractContextText(parts)).toBe(
    "  root:\n    child: true\n\n| a | b |\n| - | - |\n| 1 | 2 |\n[ts] if (ok) {\n  run()\n}"
  )
  expect(extractPlainText(parts)).toBe(
    "root: child: true | a | b | | - | - | | 1 | 2 | [ts] if (ok) { run() }"
  )
})

it("projects attachment metadata only in context, without reading a URL or content", () => {
  const parts = [
    { type: "file", filename: "diagram.png", mediaType: "image/png", url: "data:secret" },
    { type: "file", filename: "spec.pdf", mediaType: "application/pdf", data: "secret" },
  ]
  expect(extractContextText(parts)).toBe(
    "[attached file: diagram.png (image/png)]\n[attached file: spec.pdf (application/pdf)]"
  )
  expect(extractPlainText(parts)).toBe("")
  expect(extractContextText(null)).toBe("")
})
