import { registerInlineLinkKind } from "@/lib/chat/inline-links"
import { rehypeInlineLinks } from "./rehype-inline-links"

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const text = (value: string): Node => ({ type: "text", value })
const el = (tagName: string, children: Node[], properties: Record<string, unknown> = {}): Node => ({
  type: "element",
  tagName,
  properties,
  children,
})

let dispose: () => void
beforeEach(() => {
  dispose = registerInlineLinkKind({
    id: "issue",
    pattern: /\b[A-Z][A-Z0-9]{1,4}-\d+\b/g,
    matches: (value) => !value.endsWith("-0"),
    href: (value) => `/issues?identifier=${value}`,
    parseHref: () => undefined,
    accepts: () => true,
  })
})
afterEach(() => dispose())

function run(tree: Node): Node {
  rehypeInlineLinks()(tree)
  return tree
}

describe("rehypeInlineLinks", () => {
  it("splits text around each reference into a marked in-app link", () => {
    const tree = run({ type: "root", children: [el("p", [text("Fixes MERC-12 and AB-3.")])] })
    expect(tree.children![0].children).toEqual([
      text("Fixes "),
      el("a", [text("MERC-12")], {
        href: "/issues?identifier=MERC-12",
        dataInlineLink: "issue",
        dataInlineRef: "MERC-12",
      }),
      text(" and "),
      el("a", [text("AB-3")], {
        href: "/issues?identifier=AB-3",
        dataInlineLink: "issue",
        dataInlineRef: "AB-3",
      }),
      text("."),
    ])
  })

  it("leaves links, inline code and code blocks alone", () => {
    const tree = run({
      type: "root",
      children: [
        el("p", [el("a", [text("MERC-1")], { href: "https://x.test" })]),
        el("p", [el("code", [text("MERC-2")])]),
        el("pre", [el("code", [text("MERC-3")])]),
      ],
    })
    expect(JSON.stringify(tree)).not.toContain("dataInlineLink")
  })

  it("reaches nested inline elements and skips what the kind rejects", () => {
    const tree = run({
      type: "root",
      children: [el("p", [el("strong", [text("MERC-0 vs MERC-9")])])],
    })
    const strong = tree.children![0].children![0]
    expect(strong.children!.map((child) => child.tagName ?? child.value)).toEqual([
      "MERC-0 vs ",
      "a",
    ])
  })

  it("leaves text with no reference untouched", () => {
    const paragraph = el("p", [text("nothing here")])
    const before = paragraph.children
    run({ type: "root", children: [paragraph] })
    expect(paragraph.children).toBe(before)
  })
})
