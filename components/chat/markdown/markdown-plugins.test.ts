import {
  addMarkdownHeadingIds,
  createHeadingIdRegistry,
  headingEntriesFromSource,
  headingIdSeed,
  limitUntrustedMarkdownDepth,
  markdownHeadingSlug,
  preprocessLatex,
  rehypeMarkdownHeadingIds,
  rehypeMarkdownMentions,
  type MarkdownPluggable,
} from "./markdown-plugins"

type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const heading = (text: string, tagName = "h2"): Node => ({
  type: "element",
  tagName,
  properties: {},
  children: [{ type: "text", value: text }],
})
const root = (...children: Node[]): Node => ({ type: "root", children })
const ids = (tree: Node) => (tree.children ?? []).map((node) => node.properties?.id)

describe("addMarkdownHeadingIds", () => {
  it("preserves ordinary nesting and flattens excessive external nesting to complete literal source", () => {
    const shallow = {
      type: "root",
      children: [
        { type: "element", tagName: "blockquote", children: [{ type: "text", value: "quote" }] },
      ],
    }
    const previous = JSON.stringify(shallow)
    limitUntrustedMarkdownDepth(shallow, "> quote")
    expect(JSON.stringify(shallow)).toBe(previous)
    type Node = { type: string; tagName?: string; value?: string; children?: Node[] }
    let child: Node = { type: "text", value: "deep marker" }
    for (let index = 0; index < 1500; index++) child = { type: "blockquote", children: [child] }
    const tree = { type: "root", children: [child] }
    const source = `${"> ".repeat(1500)}deep marker`
    limitUntrustedMarkdownDepth(tree, source)
    expect(tree.children).toEqual([{ type: "code", lang: "text", value: source }])
  })
  it("adds stable slugs and disambiguates duplicate headings", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "Quick Start" }],
        },
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "Quick Start" }],
        },
        {
          type: "element",
          tagName: "h3",
          properties: {},
          children: [{ type: "text", value: "中文渲染" }],
        },
      ],
    }

    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "quick-start" })
    expect(tree.children[1].properties).toMatchObject({ id: "quick-start-1" })
    expect(tree.children[2].properties).toMatchObject({ id: "中文渲染" })
  })

  it("preserves an explicit heading id and ignores empty headings", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: { id: "custom" },
          children: [{ type: "text", value: "Custom" }],
        },
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "!!!" }],
        },
      ],
    }

    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "custom" })
    expect(tree.children[1].properties).toEqual({})
  })

  it("collects nested heading text and safely ignores non-tree input", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [
            { type: "text", value: "Rich " },
            {
              type: "element",
              tagName: "code",
              children: [{ type: "text", value: "Text" }],
            },
          ],
        },
      ],
    }

    addMarkdownHeadingIds(null)
    addMarkdownHeadingIds(tree)

    expect(tree.children[0].properties).toMatchObject({ id: "rich-text" })
  })
})
describe("markdownHeadingSlug", () => {
  it("keeps letters and numbers in any script and joins words with dashes", () => {
    expect(markdownHeadingSlug("  Hello, World!  ")).toBe("hello-world")
    expect(markdownHeadingSlug("安装 步骤")).toBe("安装-步骤")
    expect(markdownHeadingSlug("a__b  c")).toBe("a-b-c")
  })
})

describe("preprocessLatex", () => {
  it("rewrites complete LaTeX delimiter pairs and leaves an open one as text", () => {
    expect(preprocessLatex("\\[x^2\\] and \\(y\\)")).toBe("$$x^2$$ and $y$")
    expect(preprocessLatex("still \\[open")).toBe("still \\[open")
    expect(preprocessLatex("plain $5")).toBe("plain $5")
  })
})

describe("addMarkdownHeadingIds with a seed", () => {
  it("numbers after the headings it was seeded with and reports what it consumed", () => {
    const seen = new Map([["setup", 1]])
    const tree = root(heading("Setup"), heading("Usage"))
    expect(addMarkdownHeadingIds(tree, seen)).toEqual([{ base: "setup" }, { base: "usage" }])
    expect(ids(tree)).toEqual(["setup-1", "usage"])
  })
})

describe("headingEntriesFromSource", () => {
  it("reads heading slugs from source the way the rendered text yields them", () => {
    const source = [
      "# Hi *there* `x` <b>y</b> &amp; \\* $m$",
      "",
      "> ## Quoted",
      "",
      "- item",
      "",
      "```",
      "# not a heading",
      "```",
    ].join("\n")
    expect(headingEntriesFromSource(source)).toEqual([
      { base: markdownHeadingSlug("Hi there x y & * m") },
      { base: "quoted" },
    ])
  })
})

describe("headingIdSeed", () => {
  it("carries what the earlier sources consumed, ids and numbered bases", () => {
    const sources = ["## Setup\n", '<h2 id="intro">Intro</h2>\n', "## Setup\n", "## Later\n"]
    expect(headingIdSeed(sources, 0)).toEqual([])
    expect(headingIdSeed(sources, 3)).toEqual([
      ["setup", 2],
      ["user-content-intro", 1],
    ])
  })
})

describe("rehypeMarkdownHeadingIds", () => {
  it("numbers from scratch alone and continues from a seed", () => {
    const alone = root(heading("Setup"), heading("Setup"))
    rehypeMarkdownHeadingIds()(alone)
    expect(ids(alone)).toEqual(["setup", "setup-1"])

    const seeded = root(heading("Setup"))
    rehypeMarkdownHeadingIds({ seed: [["setup", 2]] })(seeded)
    expect(ids(seeded)).toEqual(["setup-2"])
  })
})

describe("createHeadingIdRegistry", () => {
  type Step = MarkdownPluggable
  const run = (step: Step, tree: Node) => {
    const [plugin, options] = Array.isArray(step) ? step : [step, undefined]
    ;(plugin as (options?: unknown) => (tree: unknown) => void)(options)(tree)
  }

  it("seeds each tree with the trees before it, in any mount order", () => {
    const registry = createHeadingIdRegistry()
    registry.setSources(["## Setup\n", "## Setup\n\n## Notes\n", "## Setup\n"])
    const third = root(heading("Setup"))
    run(registry.withPlugins([], 2).at(-1)!, third)
    const first = root(heading("Setup"))
    run(registry.withPlugins([], 0).at(-1)!, first)
    expect(ids(third)).toEqual(["setup-2"])
    expect(ids(first)).toEqual(["setup"])
  })

  it("learns a block's source from the block itself", () => {
    const registry = createHeadingIdRegistry()
    registry.setSource(0, "## Setup\n")
    registry.setSource(1, "## Setup\n")
    const second = root(heading("Setup"))
    run(registry.withPlugins([], 1).at(-1)!, second)
    expect(ids(second)).toEqual(["setup-1"])
  })

  it("keeps plugin lists stable per list and seed, with JSON-only options", () => {
    const registry = createHeadingIdRegistry()
    registry.setSources(["intro\n", "text\n", "## Setup\n", "more\n"])
    const list = [() => undefined]
    const combined = registry.withPlugins(list, 1)
    expect(registry.withPlugins(list, 1)).toBe(combined)
    // No heading before either: the same seed, so the same list.
    expect(registry.withPlugins(list, 2)).toBe(combined)
    expect(combined).toEqual([list[0], rehypeMarkdownHeadingIds])
    const after = registry.withPlugins(list, 3)
    expect(after).toEqual([list[0], [rehypeMarkdownHeadingIds, { seed: [["setup", 1]] }]])
    expect(JSON.parse(JSON.stringify((after[1] as [unknown, unknown])[1]))).toEqual({
      seed: [["setup", 1]],
    })
  })
})

describe("rehypeMarkdownMentions", () => {
  type El = Node & { tagName?: string }
  const text = (value: string): Node => ({ type: "text", value })
  const el = (tagName: string, ...children: Node[]): El => ({
    type: "element",
    tagName,
    properties: {},
    children,
  })
  const mentions = [{ name: "Alice", color: "red" }, { name: "Alice Smith" }, { name: "张三" }]
  const run = (tree: Node) => rehypeMarkdownMentions({ mentions })(tree)
  const chips = (node: Node): Node[] =>
    node.properties?.dataMention ? [node] : (node.children ?? []).flatMap(chips)

  it("wraps each known name in the text, longest first, keeping the text around it", () => {
    const paragraph = el("p", text("hi @alice smith and @Alice."))
    const tree = root(paragraph)
    run(tree)
    const found = chips(tree)
    expect(found.map((chip) => chip.children?.[0].value)).toEqual(["@alice smith", "@Alice"])
    expect(found.map((chip) => chip.properties?.dataMention)).toEqual(["Alice Smith", "Alice"])
    expect(found[1].properties?.style).toBe("color: red")
    expect(found[0].properties).not.toHaveProperty("style")
    expect(paragraph.children?.map((child) => child.value ?? "chip")).toEqual([
      "hi ",
      "chip",
      " and ",
      "chip",
      ".",
    ])
  })

  it("leaves links, code and keys literal, and matches inside emphasis", () => {
    const tree = root(
      el("p", el("a", text("@Alice")), el("code", text("@Alice")), el("strong", text("@Alice")))
    )
    run(tree)
    expect(chips(tree)).toHaveLength(1)
  })

  it("ends a name at a non-letter, so CJK names match and longer words do not", () => {
    const tree = root(el("p", text("@张三 好 @Alicex @张三")))
    run(tree)
    expect(chips(tree).map((chip) => chip.properties?.dataMention)).toEqual(["张三", "张三"])
  })

  it("does nothing without names", () => {
    const tree = root(el("p", text("@Alice")))
    rehypeMarkdownMentions({ mentions: [] })(tree)
    rehypeMarkdownMentions()(tree)
    expect(chips(tree)).toHaveLength(0)
  })
})
