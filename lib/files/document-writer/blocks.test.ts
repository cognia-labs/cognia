/** @jest-environment jsdom */
import {
  dataUrlBytes,
  documentLosses,
  embeddableImage,
  imageFormatOf,
  imagePixelSize,
  listDepth,
  parseMarkdownBlocks,
  runsText,
  type DocBlock,
} from "./blocks"

/** A 1×1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`

/** The head of a JPEG declaring 640×480: SOI, an APP0 segment, then SOF0. */
const JPEG_HEAD = [
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]
const base64Of = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

const paragraph = (text: string): DocBlock => ({ kind: "paragraph", runs: [{ text }] })

describe("parseMarkdownBlocks", () => {
  it("parses headings at every level, with their inline styling", () => {
    expect(parseMarkdownBlocks("# A\n## B\n### C\n#### D *e*\n##### F\n###### G")).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "A" }] },
      { kind: "heading", level: 2, runs: [{ text: "B" }] },
      { kind: "heading", level: 3, runs: [{ text: "C" }] },
      { kind: "heading", level: 4, runs: [{ text: "D " }, { text: "e", italic: true }] },
      { kind: "heading", level: 5, runs: [{ text: "F" }] },
      { kind: "heading", level: 6, runs: [{ text: "G" }] },
    ])
  })

  it("reads a soft line break as a space and a hard one as a line break", () => {
    expect(parseMarkdownBlocks("one\ntwo\n\nthree  \nfour\\\nfive<br>six")).toEqual([
      paragraph("one two"),
      paragraph("three\nfour\nfive\nsix"),
    ])
  })

  it("keeps bold, italic, strikethrough and code spans as styled runs (F11)", () => {
    expect(parseMarkdownBlocks("a **b _c_** ~~d~~ `e *f*` ***g***")).toEqual([
      {
        kind: "paragraph",
        runs: [
          { text: "a " },
          { text: "b ", bold: true },
          { text: "c", bold: true, italic: true },
          { text: " " },
          { text: "d", strike: true },
          { text: " " },
          { text: "e *f*", code: true },
          { text: " " },
          { text: "g", bold: true, italic: true },
        ],
      },
    ])
  })

  it("resolves character references in text but not in code, and keeps escapes literal", () => {
    expect(parseMarkdownBlocks("A &amp; B &copy; &#x4E2D; \\*x\\* \\&amp; `&amp;`")).toEqual([
      {
        kind: "paragraph",
        runs: [{ text: "A & B © 中 *x* &amp; " }, { text: "&amp;", code: true }],
      },
    ])
  })

  it("links runs to http, https and mailto targets only (F11)", () => {
    const [block] = parseMarkdownBlocks(
      "[**site**](https://e.com/?a=1&amp;b=2) [mail](mailto:a@b.c) [x](javascript:alert(1)) [rel](./doc.md) <https://a.b> www.c.d"
    )
    expect(block).toEqual({
      kind: "paragraph",
      runs: [
        { text: "site", bold: true, href: "https://e.com/?a=1&b=2" },
        { text: " " },
        { text: "mail", href: "mailto:a@b.c" },
        // A target that could run script, or that means nothing outside the
        // app, keeps its text and drops the link.
        { text: " x rel " },
        { text: "https://a.b", href: "https://a.b" },
        { text: " " },
        { text: "www.c.d", href: "http://www.c.d" },
      ],
    })
  })

  it("parses bulleted, numbered and task lists with their nesting", () => {
    expect(
      parseMarkdownBlocks("- a\n  - b\n    1. c\n    2. d\n- [x] e\n- [ ] f\n\n3. g\n4. h")
    ).toEqual([
      { kind: "listItem", marker: { type: "bullet" }, runs: [{ text: "a" }] },
      { kind: "listItem", marker: { type: "bullet" }, runs: [{ text: "b" }], nest: ["list"] },
      {
        kind: "listItem",
        marker: { type: "number", start: 1, value: 1 },
        runs: [{ text: "c" }],
        nest: ["list", "list"],
      },
      {
        kind: "listItem",
        marker: { type: "number", start: 1, value: 2 },
        runs: [{ text: "d" }],
        nest: ["list", "list"],
      },
      { kind: "listItem", marker: { type: "bullet" }, checked: true, runs: [{ text: "e" }] },
      { kind: "listItem", marker: { type: "bullet" }, checked: false, runs: [{ text: "f" }] },
      { kind: "listItem", marker: { type: "number", start: 3, value: 3 }, runs: [{ text: "g" }] },
      { kind: "listItem", marker: { type: "number", start: 3, value: 4 }, runs: [{ text: "h" }] },
    ])
  })

  it("puts an item's later paragraphs and code in its content column", () => {
    expect(
      parseMarkdownBlocks("- [x] first\n\n  more\n\n  ```\n  if x:\n      y()\n  ```")
    ).toEqual([
      { kind: "listItem", marker: { type: "bullet" }, checked: true, runs: [{ text: "first" }] },
      { ...paragraph("more"), nest: ["list"] },
      { kind: "code", text: "if x:\n    y()", nest: ["list"] },
    ])
  })

  it("nests quotes, lists in quotes and quotes in lists", () => {
    expect(
      parseMarkdownBlocks("> q **b**\n> > deeper\n> - in quote\n\n- item\n  > quoted")
    ).toEqual([
      { kind: "paragraph", runs: [{ text: "q " }, { text: "b", bold: true }], nest: ["quote"] },
      { ...paragraph("deeper"), nest: ["quote", "quote"] },
      {
        kind: "listItem",
        marker: { type: "bullet" },
        runs: [{ text: "in quote" }],
        nest: ["quote"],
      },
      { kind: "listItem", marker: { type: "bullet" }, runs: [{ text: "item" }] },
      { ...paragraph("quoted"), nest: ["list", "quote"] },
    ])
  })

  it("parses a GFM table into header and body cells with alignment (F11)", () => {
    expect(parseMarkdownBlocks("| a | *b* | c |\n|:-|:-:|-:|\n| 1 \\| x | **2** | |")).toEqual([
      {
        kind: "table",
        align: ["left", "center", "right"],
        header: [[{ text: "a" }], [{ text: "b", italic: true }], [{ text: "c" }]],
        rows: [[[{ text: "1 | x" }], [{ text: "2", bold: true }], []]],
      },
    ])
  })

  it("keeps fenced and indented code verbatim, comments and indentation included (F11)", () => {
    const python = "def calculate():\n    # keep me\n    value = 42\n    return value"
    expect(
      parseMarkdownBlocks(`intro\n\n\`\`\`python\n${python}\n\`\`\`\n\n    indented\n      more`)
    ).toEqual([
      paragraph("intro"),
      { kind: "code", text: python },
      { kind: "code", text: "indented\n  more" },
    ])
  })

  it("treats an unterminated code fence as code to the end", () => {
    expect(parseMarkdownBlocks("```\nno close\n# not a heading")).toEqual([
      { kind: "code", text: "no close\n# not a heading" },
    ])
  })

  it("draws a thematic break as a rule", () => {
    expect(parseMarkdownBlocks("a\n\n---\n\nb")).toEqual([
      paragraph("a"),
      { kind: "rule" },
      paragraph("b"),
    ])
  })

  it("writes raw HTML as marked text, drops comments and keeps <br> as a break", () => {
    expect(
      parseMarkdownBlocks("a <kbd>k</kbd> b<!-- note -->\n\n<div>block</div>\n\n<!-- gone -->")
    ).toEqual([
      {
        kind: "paragraph",
        runs: [
          { text: "a " },
          { text: "<kbd>", stand: "html" },
          { text: "k" },
          { text: "</kbd>", stand: "html" },
          { text: " b" },
        ],
      },
      { kind: "paragraph", runs: [{ text: "<div>block</div>", stand: "html" }] },
    ])
  })

  it("embeds a PNG or JPEG data image, splitting its paragraph there", () => {
    expect(parseMarkdownBlocks(`before ![plot](${PNG_URL}) after`)).toEqual([
      paragraph("before"),
      { kind: "image", dataUrl: PNG_URL, format: "PNG", alt: "plot" },
      paragraph("after"),
    ])
  })

  it("writes an image it cannot embed as its alt text and address", () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw="
    const [block] = parseMarkdownBlocks(
      `![remote](https://x.y/p.png) ![](https://x.y/q.png) ![rel](./a.png) ![anim](${gif})`
    )
    expect(block).toEqual({
      kind: "paragraph",
      runs: [
        { text: "remote (https://x.y/p.png)", href: "https://x.y/p.png", stand: "image" },
        { text: " " },
        { text: "https://x.y/q.png", href: "https://x.y/q.png", stand: "image" },
        { text: " " },
        { text: "rel (./a.png)", stand: "image" },
        { text: " " },
        // Never pages of base64.
        { text: "anim", stand: "image" },
      ],
    })
  })

  it("writes an image in a table cell, heading or link as a stand-in", () => {
    const blocks = parseMarkdownBlocks(
      `# ![logo](${PNG_URL})\n\n| fig |\n|-|\n| ![cell](${PNG_URL}) |\n\n[![badge](${PNG_URL})](https://ci.example)`
    )
    expect(blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "logo", stand: "image" }] },
      {
        kind: "table",
        align: [null],
        header: [[{ text: "fig" }]],
        rows: [[[{ text: "cell", stand: "image" }]]],
      },
      {
        kind: "paragraph",
        runs: [{ text: "badge", href: "https://ci.example", stand: "image" }],
      },
    ])
  })

  it("puts a list item's image in the item's content column", () => {
    expect(parseMarkdownBlocks(`- see ![fig](${PNG_URL}) here`)).toEqual([
      { kind: "listItem", marker: { type: "bullet" }, runs: [{ text: "see" }] },
      { kind: "image", dataUrl: PNG_URL, format: "PNG", alt: "fig", nest: ["list"] },
      { ...paragraph("here"), nest: ["list"] },
    ])
  })

  it("normalizes CRLF and returns no blocks for blank input", () => {
    expect(parseMarkdownBlocks("a\r\n\r\nb")).toEqual([paragraph("a"), paragraph("b")])
    expect(parseMarkdownBlocks("")).toEqual([])
    expect(parseMarkdownBlocks("  \n\n ")).toEqual([])
  })
})

describe("documentLosses", () => {
  it("counts the runs that stand in for images and raw HTML, wherever they are", () => {
    const blocks = parseMarkdownBlocks(
      "![a](https://x/a.png) <b>x</b>\n\n- ![b](https://x/b.png)\n\n| <i>c</i> |\n|-|\n| ![d](./d.png) |"
    )
    expect(documentLosses(blocks)).toEqual([
      { kind: "image", count: 3 },
      { kind: "html", count: 4 },
    ])
  })

  it("reports nothing for a document it keeps whole", () => {
    expect(
      documentLosses(parseMarkdownBlocks(`# T\n\n**b** [l](https://x)\n\n![p](${PNG_URL})`))
    ).toEqual([])
  })
})

describe("images", () => {
  it("reads a PNG's and a JPEG's pixel size from their headers", () => {
    expect(imagePixelSize(dataUrlBytes(PNG_URL)!)).toEqual({ width: 1, height: 1 })
    expect(imagePixelSize(new Uint8Array(JPEG_HEAD))).toEqual({ width: 640, height: 480 })
  })

  it("reads nothing from bytes that are neither, or are cut short", () => {
    expect(imagePixelSize(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imagePixelSize(new Uint8Array(JPEG_HEAD.slice(0, 24)))).toBeNull()
    expect(imagePixelSize(dataUrlBytes(PNG_URL)!.subarray(0, 20))).toBeNull()
    expect(dataUrlBytes("https://x/p.png")).toBeNull()
    expect(dataUrlBytes("data:image/png;base64,not base64!")).toBeNull()
  })

  it("takes the format from the bytes, not the label", () => {
    expect(imageFormatOf(new Uint8Array(JPEG_HEAD))).toBe("JPEG")
    expect(embeddableImage(`data:image/jpeg;base64,${PNG_BASE64}`)).toEqual({
      dataUrl: PNG_URL,
      format: "PNG",
    })
    expect(embeddableImage(`data:image/png;base64,${base64Of(JPEG_HEAD)}`)).toEqual({
      dataUrl: `data:image/jpeg;base64,${base64Of(JPEG_HEAD)}`,
      format: "JPEG",
    })
    expect(embeddableImage("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBeNull()
  })
})

describe("helpers", () => {
  it("counts list depth and joins run text", () => {
    expect(listDepth(undefined)).toBe(0)
    expect(listDepth(["quote", "list", "list"])).toBe(2)
    expect(runsText([{ text: "a" }, { text: "b", bold: true }])).toBe("ab")
  })
})
